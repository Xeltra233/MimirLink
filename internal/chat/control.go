package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/botctl"
	"mimirlink/internal/store"
	"mimirlink/internal/tools"
)

// 本文件实现 bot 侧控制动作（面板通过 botctl 通道调用）。
// 对齐 Node 单进程内可直接调用运行时能力的语义：
//   主动 @ 测试（生成内容并真实发送）、立即增量分析、刷新用户名、OneBot 重连。

// ControlStatus 返回 bot 运行状态，供面板显示连接情况。
func (r *Runtime) ControlStatus() map[string]any {
	status := map[string]any{
		"llmEnabled":  r.llmEnabled(),
		"selfId":      "",
		"nickname":    "",
		"connected":   false,
		"url":         r.document.String("onebot.url"),
		"onebotUrl":   r.document.String("onebot.url"),
		"mode":        orDefaultText(r.document.String("onebot.mode"), "ws"),
		"tokenMode":   orDefaultText(r.document.String("onebot.tokenMode"), "header"),
		"hasToken":    strings.TrimSpace(r.document.String("onebot.accessToken")) != "",
		"uptimeMs":    time.Since(r.startedAt).Milliseconds(),
		"lastRouting": r.LastRoutingSnapshot(),
	}
	if r.bot != nil {
		status["selfId"] = r.bot.SelfID()
	}
	if provider, ok := r.bot.(interface {
		Connected() bool
		Nickname() string
	}); ok {
		status["connected"] = provider.Connected()
		status["nickname"] = provider.Nickname()
	}
	return status
}

// ReconnectOneBot 请求底层 OneBot 客户端主动重建连接。
func (r *Runtime) ReconnectOneBot() error {
	reconnector, ok := r.bot.(interface{ Reconnect() error })
	if !ok {
		return fmt.Errorf("当前 Bot 客户端不支持主动重连")
	}
	if err := reconnector.Reconnect(); err != nil {
		return err
	}
	r.logger.Printf("[控制] 已下发 OneBot 重连指令")
	return nil
}

// AdminMention 生成（或直接使用）一条文本并真实发送到群，返回生成内容。
// 对齐 Node adminMention：模型生成一段自然语言后，以 [at, text] 形式发出。
func (r *Runtime) AdminMention(request botctl.MentionRequest) (map[string]any, error) {
	groupID := strings.TrimSpace(request.GroupID)
	targetUserID := strings.TrimSpace(request.TargetUserID)
	prompt := strings.TrimSpace(request.Message)
	if groupID == "" || targetUserID == "" || prompt == "" {
		return nil, fmt.Errorf("群号、目标 QQ 与消息内容都不能为空")
	}
	if r.bot == nil {
		return nil, fmt.Errorf("Bot 客户端未就绪")
	}
	generated := prompt
	// 与 Node 一致：面板端口号填写内容作为「生成要求」，交给模型改写为自然语言
	if client := r.model(); client != nil {
		context, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		messages := []ai.Message{
			{Role: "system", Content: "你是群聊里的普通成员，正在主动提及某位群友。请输出一句话，直接说给对方听，不要解释、不要加引号、不要提及自己是 AI。"},
			{Role: "user", Content: prompt},
		}
		if result, err := client.Chat(context, messages, nil); err == nil && result != nil {
			if text := strings.TrimSpace(result.Content); text != "" {
				generated = text
			}
		} else if err != nil {
			r.logger.Printf("[控制] 主动 @ 生成失败，改用原文发送: %v", err)
		}
	}
	targetName := strings.TrimSpace(request.TargetName)
	segments := []map[string]any{{"type": "at", "data": map[string]any{"qq": targetUserID}}}
	if targetName != "" {
		segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": " "}})
	}
	segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": generated}})
	if err := r.bot.SendGroupMessage(groupID, segments); err != nil {
		return nil, fmt.Errorf("发送失败: %w", err)
	}
	r.logger.Printf("[控制] 已向群 %s 主动 @ %s", groupID, targetUserID)
	return map[string]any{
		"message":          "主动 @ 消息已发送",
		"generatedMessage": generated,
	}, nil
}

// AnalyzeParticipantProfile 立即执行一次人物档案增量分析（不分批、不等待阈值）。
func (r *Runtime) AnalyzeParticipantProfile(request botctl.ProfileRequest) (map[string]any, error) {
	if r.memory == nil {
		return nil, fmt.Errorf("记忆库未就绪")
	}
	participantID := strings.TrimSpace(request.ParticipantID)
	if participantID == "" {
		return nil, fmt.Errorf("缺少 participantId")
	}
	_, threshold, sourceLimit, analysisMode, blacklist := r.participantProfileConfig()
	if blacklist[participantID] {
		return nil, fmt.Errorf("该参与者已在黑名单中")
	}
	namespace := r.controlNamespace(request)
	sourceFilter := "all"
	if analysisMode == "bot_only_messages" || analysisMode == "bot_only_profile" {
		sourceFilter = "bot_only"
	}
	source, err := r.memory.CollectParticipantProfileSource(participantID, namespace, store.ProfileSourceConfig{
		Threshold: threshold, Limit: sourceLimit, SourceFilter: sourceFilter, Force: true,
	})
	if err != nil {
		return nil, fmt.Errorf("采集源消息失败: %w", err)
	}
	if len(source.Messages) == 0 {
		return nil, fmt.Errorf("没有可用于分析的历史消息")
	}
	profileText, err := r.generateParticipantProfile(source, participantID, strings.TrimSpace(request.Participant), analysisMode)
	if err != nil {
		return nil, fmt.Errorf("生成档案失败: %w", err)
	}
	title := strings.TrimSpace(request.Participant)
	if title == "" {
		title = participantID
	}
	metadata := map[string]any{
		"messageType":            orDefaultString(strings.TrimSpace(request.MessageType), "group"),
		"groupId":                strings.TrimSpace(request.GroupID),
		"lastProcessedMessageAt": source.LastProcessedAt,
		"manualAnalyze":          true,
		"analyzedAt":             time.Now().UnixMilli(),
	}
	entryID := ""
	if source.Existing != nil {
		entryID = source.Existing.ID
	}
	savedID, err := r.memory.SaveParticipantProfile(namespace, entryID, participantID, title, profileText, []string{}, metadata, "")
	if err != nil {
		return nil, fmt.Errorf("保存档案失败: %w", err)
	}
	r.logger.Printf("[控制] 手动增量分析完成: %s → %s（来源 %d 条）", participantID, savedID, len(source.Messages))
	return map[string]any{
		"message": fmt.Sprintf("人物档案已重新分析（来源 %d 条消息）", len(source.Messages)),
		"entryId": savedID,
		"content": profileText,
	}, nil
}

// RefreshParticipantName 通过 OneBot 拉取昵称并回写档案标题。
func (r *Runtime) RefreshParticipantName(request botctl.ProfileRequest) (map[string]any, error) {
	if r.memory == nil {
		return nil, fmt.Errorf("记忆库未就绪")
	}
	participantID := strings.TrimSpace(request.ParticipantID)
	if participantID == "" {
		return nil, fmt.Errorf("缺少 participantId")
	}
	groupID := strings.TrimSpace(request.GroupID)
	nickname := ""
	// 注意：Call 返回 json.RawMessage（具名类型），断言必须使用同一签名
	caller, ok := r.bot.(interface {
		Call(action string, params map[string]any) (json.RawMessage, error)
	})
	if ok {
		if groupID != "" {
			if raw, err := caller.Call("get_group_member_info", map[string]any{"group_id": groupID, "user_id": participantID, "no_cache": true}); err == nil {
				nickname = firstNonEmptyJSONString(raw, "nickname", "card")
			}
		}
		if nickname == "" {
			if raw, err := caller.Call("get_stranger_info", map[string]any{"user_id": participantID, "no_cache": true}); err == nil {
				nickname = firstNonEmptyJSONString(raw, "nickname")
			}
		}
	}
	if nickname == "" {
		return nil, fmt.Errorf("OneBot 未返回昵称（可能未连接或不支持该接口）")
	}
	namespace := r.controlNamespace(request)
	entry, err := r.memory.GetParticipantProfileEntry(namespace, participantID)
	if err != nil {
		return nil, fmt.Errorf("读取档案失败: %w", err)
	}
	if entry == nil {
		return nil, fmt.Errorf("该参与者还没有档案，请先执行增量分析")
	}
	title := nickname
	if strings.TrimSpace(request.Participant) != "" {
		title = strings.TrimSpace(request.Participant)
	}
	metadata := map[string]any{
		"messageType": orDefaultString(strings.TrimSpace(request.MessageType), "group"),
		"groupId":     groupID,
		"nickname":    nickname,
		"renamedAt":   time.Now().UnixMilli(),
	}
	savedID, err := r.memory.SaveParticipantProfile(namespace, entry.ID, participantID, title, entry.Content, []string{}, metadata, "")
	if err != nil {
		return nil, fmt.Errorf("回写档案失败: %w", err)
	}
	r.logger.Printf("[控制] 已刷新 %s 的昵称 → %s", participantID, nickname)
	return map[string]any{
		"message":  "用户名已刷新: " + nickname,
		"entryId":  savedID,
		"nickname": nickname,
	}, nil
}

// controlNamespace 决定控制动作使用的命名空间（优先请求指定，其次当前会话模式）。
func (r *Runtime) controlNamespace(request botctl.ProfileRequest) store.NamespaceOptions {
	scopeType := strings.TrimSpace(request.ScopeType)
	scopeKey := strings.TrimSpace(request.ScopeKey)
	character := strings.TrimSpace(request.CharacterName)
	if character == "" {
		character = r.characterName()
	}
	if scopeType == "" || scopeKey == "" {
		mode := r.document.String("chat.sessionMode")
		switch mode {
		case "global_shared":
			scopeType, scopeKey = "global_shared", "global_shared_memory"
		case "group_shared":
			scopeType, scopeKey = "group_shared", "group_"+orDefaultString(strings.TrimSpace(request.GroupID), "unknown")
		default:
			scopeType, scopeKey = "user_persistent", "user_persistent:user_"+orDefaultString(strings.TrimSpace(request.ParticipantID), "unknown")
		}
	}
	return store.NamespaceOptions{ScopeType: scopeType, ScopeKey: scopeKey, CharacterName: character}
}

// model 返回当前 AI 客户端（热加载后可能已替换）。
func (r *Runtime) model() ChatModel {
	return r.ai
}

func firstNonEmptyJSONString(raw []byte, keys ...string) string {
	payload := map[string]any{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return ""
	}
	data, _ := payload["data"].(map[string]any)
	if data == nil {
		data = payload
	}
	for _, key := range keys {
		if value := strings.TrimSpace(stringValue(data[key])); value != "" {
			return value
		}
	}
	return ""
}

// TestAI 执行一次带工具上下文的测试对话（对齐 Node POST /api/test/ai：
// 工具说明 system + 用户消息 → chatWithTools → 返回可见回复与可用工具名）。
func (r *Runtime) TestAI(request botctl.TestAIRequest) (map[string]any, error) {
	message := strings.TrimSpace(request.Message)
	if message == "" {
		return nil, fmt.Errorf("message 不能为空")
	}
	if r.ai == nil {
		return nil, fmt.Errorf("AI 未就绪")
	}
	messages := []ai.Message{}
	toolNames := []string{}
	if r.tools != nil {
		if hints := r.tools.ToolHints(); len(hints) > 0 {
			messages = append(messages, ai.Message{Role: "system", Content: "【工具使用说明】\n" + strings.Join(hints, "\n\n")})
		}
		toolNames = r.tools.Names()
	}
	messages = append(messages, ai.Message{Role: "user", Content: message})
	scope := tools.CallScope{
		GroupID:      strings.TrimSpace(request.GroupID),
		TargetUserID: strings.TrimSpace(request.TargetUserID),
		TargetName:   strings.TrimSpace(request.TargetName),
	}
	reply, err := r.chatWithTools(context.Background(), messages, scope)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"response":         reply,
		"reasoningContent": nil,
		"toolsEnabled":     toolNames,
	}, nil
}
