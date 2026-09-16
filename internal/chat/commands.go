package chat

// 管理员消息命令（对齐 Node src/index.js handleMessage 中的命令分支）：
//   - /llm：切换 LLM 总开关并回复状态（先于音乐命令处理）
//   - /人物档案：对 @ 的目标立即执行一次人物档案增量分析
//   - /at：管理员主动 @ 指定成员，由模型生成内容后真实发送
//
// 这些命令在 Go 迁移时缺失，导致面板「命令与工具」里配置的命令在 Go bot 下无响应。

import (
	"context"
	"fmt"
	"strings"
	"time"

	"mimirlink/internal/botctl"
)

// handleLLMCommand 处理管理员 /llm 指令：切换 runtime.llmEnabled 并持久化。
func (r *Runtime) handleLLMCommand(event map[string]any, messageType string, groupID string, userID string, text string) bool {
	if strings.TrimSpace(text) != "/llm" {
		return false
	}
	if !r.isAdminUser(userID) {
		return false
	}
	next := !r.llmEnabled()
	if err := r.document.Set("runtime.llmEnabled", next); err != nil {
		r.logger.Printf("[指令] LLM 开关写入失败: %v", err)
	} else if err := r.document.Save(); err != nil {
		r.logger.Printf("[指令] LLM 开关保存失败: %v", err)
	}
	r.logger.Printf("[指令] 管理员 %s 切换 LLM 状态: %v", userID, next)
	r.sendEmojiReactionForEvent(event)
	statusText := "✅ LLM 已开启"
	if !next {
		statusText = "⛔ LLM 已关闭"
	}
	if err := r.sendPlainText(messageType, groupID, userID, statusText); err != nil {
		r.logger.Printf("[指令] LLM 状态提示发送失败: %v", err)
	}
	return true
}

// sendPlainText 发送不含引用/@ 的纯文本（对齐 Node sendGroupMessage/sendPrivateMessage 直发）。
func (r *Runtime) sendPlainText(messageType string, groupID string, userID string, text string) error {
	segments := []map[string]any{{"type": "text", "data": map[string]any{"text": text}}}
	if messageType == "group" {
		return r.bot.SendGroupMessage(groupID, segments)
	}
	return r.bot.SendPrivateMessage(userID, segments)
}

// sendFailureMessage 失败提示（对齐 Node sendFailureMessage：引用 + 文本，不带 @）。
func (r *Runtime) sendFailureMessage(event map[string]any, messageType string, groupID string, userID string, message string) {
	text := strings.TrimSpace(message)
	if text == "" {
		return
	}
	segments := []map[string]any{}
	if messageID := idField(event, "message_id"); messageID != "" {
		if r.document.Bool("chat.quoteReplyEnabled") || !r.document.Exists("chat.quoteReplyEnabled") {
			segments = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": messageID}})
		}
	}
	segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": "⚠️ " + text}})
	var err error
	if messageType == "group" {
		err = r.bot.SendGroupMessage(groupID, segments)
	} else {
		err = r.bot.SendPrivateMessage(userID, segments)
	}
	if err != nil {
		r.logger.Printf("[指令] 失败提示发送失败: %v", err)
	}
}

// mentionedParticipant 是一条 @ 提及（ID + 可选昵称）。
type mentionedParticipant struct {
	ID   string
	Name string
}

// extractMentionedParticipants 提取全部 @ 目标（排除 all，保持顺序去重），并带上昵称。
func extractMentionedParticipants(segments []map[string]any) []mentionedParticipant {
	seen := map[string]bool{}
	participants := []mentionedParticipant{}
	for _, segment := range segments {
		if stringValue(segment["type"]) != "at" {
			continue
		}
		data, _ := segment["data"].(map[string]any)
		if data == nil {
			continue
		}
		qq := stringValue(data["qq"])
		if qq == "" || qq == "all" || seen[qq] {
			continue
		}
		seen[qq] = true
		name := firstNonEmptyText(stringValue(data["name"]), stringValue(data["card"]), stringValue(data["nickname"]))
		participants = append(participants, mentionedParticipant{ID: qq, Name: name})
	}
	return participants
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// extractTextAfterMentionCommand 提取命令后、且跳过目标 @ 的正文（对齐 Node extractTextAfterMentionCommand）。
func extractTextAfterMentionCommand(segments []map[string]any, command string, targetUserID string) string {
	sawCommand := false
	consumedMention := false
	builder := strings.Builder{}
	for _, segment := range segments {
		switch stringValue(segment["type"]) {
		case "text":
			data, _ := segment["data"].(map[string]any)
			text := stringValue(data["text"])
			if !sawCommand {
				trimmed := strings.TrimLeft(text, " \t")
				if !strings.HasPrefix(trimmed, command) {
					continue
				}
				text = strings.TrimPrefix(trimmed, command)
				sawCommand = true
			}
			builder.WriteString(text)
		case "at":
			if sawCommand && !consumedMention {
				data, _ := segment["data"].(map[string]any)
				if stringValue(data["qq"]) == targetUserID {
					consumedMention = true
				}
			}
		}
	}
	return strings.TrimSpace(builder.String())
}

// maybeHandleParticipantProfileManualCommand 处理 /人物档案 @某人（对齐 Node handleParticipantProfileManualCommand）。
func (r *Runtime) maybeHandleParticipantProfileManualCommand(event map[string]any, messageType string, groupID string, userID string, plainText string) bool {
	command := strings.TrimSpace(r.document.String("chat.commands.participantProfileManual.command"))
	if command == "" {
		command = strings.TrimSpace(r.document.String("memory.participantProfile.manualCommand"))
	}
	if command == "" {
		command = "/人物档案"
	}
	if !isCommandInvocation(plainText, command) {
		return false
	}
	if enabled, exists := r.commandEnabled("chat.commands.participantProfileManual.enabled"); exists && !enabled {
		return false
	}
	r.sendEmojiReactionForEvent(event)
	if !r.isAdminUser(userID) {
		r.sendFailureMessage(event, messageType, groupID, userID, "只有管理员可以手动分析人物档案")
		return true
	}
	participants := extractMentionedParticipants(messageSegments(event["message"]))
	if len(participants) == 0 || participants[0].ID == "" {
		r.sendFailureMessage(event, messageType, groupID, userID, fmt.Sprintf("请使用 %s @某人 来手动分析人物档案", command))
		return true
	}
	enabled, _, _, _, blacklist := r.participantProfileConfig()
	if !enabled {
		r.sendFailureMessage(event, messageType, groupID, userID, "人物档案功能未启用，无法手动分析")
		return true
	}
	target := participants[0]
	if blacklist[target.ID] {
		r.sendFailureMessage(event, messageType, groupID, userID, fmt.Sprintf("QQ %s 已在人物档案黑名单中，无法手动分析", target.ID))
		return true
	}
	r.sendQuotedStatus(event, messageType, groupID, userID, fmt.Sprintf("正在分析%s的人物档案，请稍等", orDefaultString(target.Name, "QQ "+target.ID)))
	targetID := target.ID
	targetName := target.Name
	eventMessageType := messageType
	eventGroupID := groupID
	go func() {
		request := botctl.ProfileRequest{
			ParticipantID: targetID,
			Participant:   targetName,
			MessageType:   eventMessageType,
			GroupID:       eventGroupID,
		}
		if _, err := r.AnalyzeParticipantProfile(request); err != nil {
			r.logger.Printf("[指令] 手动人物档案分析失败: %v", err)
			r.sendFailureMessage(event, eventMessageType, eventGroupID, userID, "人物档案分析失败: "+err.Error())
		}
	}()
	return true
}

// sendQuotedStatus 发送「引用 + 状态文本」（对齐 Node sendQuotedStatusMessage）。
func (r *Runtime) sendQuotedStatus(event map[string]any, messageType string, groupID string, userID string, message string) {
	text := strings.TrimSpace(message)
	if text == "" {
		return
	}
	segments := []map[string]any{}
	if messageID := idField(event, "message_id"); messageID != "" {
		if r.document.Bool("chat.quoteReplyEnabled") || !r.document.Exists("chat.quoteReplyEnabled") {
			segments = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": messageID}})
		}
	}
	segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": text}})
	var err error
	if messageType == "group" {
		err = r.bot.SendGroupMessage(groupID, segments)
	} else {
		err = r.bot.SendPrivateMessage(userID, segments)
	}
	if err != nil {
		r.logger.Printf("[指令] 状态提示发送失败: %v", err)
	}
}

// adminMentionCommandEnabled 读取 chat.commands.adminMention（默认启用，命令 /at）。
func (r *Runtime) adminMentionCommand() (command string, enabled bool) {
	command = strings.TrimSpace(r.document.String("chat.commands.adminMention.command"))
	if command == "" {
		command = "/at"
	}
	enabled = true
	if r.document.Exists("chat.commands.adminMention.enabled") {
		enabled = r.document.Bool("chat.commands.adminMention.enabled")
	}
	return command, enabled
}

// maybeHandleAdminMentionCommand 处理 /at @某人 <生成要求>（对齐 Node handleAdminMentionCommand）。
func (r *Runtime) maybeHandleAdminMentionCommand(event map[string]any, messageType string, groupID string, userID string, plainText string) bool {
	command, enabled := r.adminMentionCommand()
	if !enabled || !isCommandInvocation(plainText, command) {
		return false
	}
	r.sendEmojiReactionForEvent(event)
	if !r.isAdminUser(userID) {
		r.sendFailureMessage(event, messageType, groupID, userID, "只有管理员可以使用主动 @ 指令")
		return true
	}
	if messageType != "group" || groupID == "" {
		r.sendFailureMessage(event, messageType, groupID, userID, "主动 @ 仅支持群聊使用")
		return true
	}
	segments := messageSegments(event["message"])
	if hasAtAllMention(segments) {
		r.sendFailureMessage(event, messageType, groupID, userID, "不支持向 @全体成员 主动发送消息")
		return true
	}
	participants := extractMentionedParticipants(segments)
	if len(participants) == 0 {
		r.sendFailureMessage(event, messageType, groupID, userID, fmt.Sprintf("请使用 %s @某人 让 AI 生成的内容要求", command))
		return true
	}
	promptText := extractTextAfterMentionCommand(segments, command, participants[0].ID)
	if promptText == "" {
		r.sendFailureMessage(event, messageType, groupID, userID, fmt.Sprintf("请在 %s @某人 后填写让 AI 生成的内容要求", command))
		return true
	}
	sessionKey := r.sessionKey(messageType, groupID, userID)
	injectionRisk := DetectPromptInjectionRisk(promptText)
	for _, participant := range participants {
		go func(target mentionedParticipant) {
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			if _, err := r.generateMentionForTool(ctx, sessionKey, messageType, promptText, injectionRisk, groupID, userID, target.ID, target.Name, promptText); err != nil {
				r.logger.Printf("[指令] 主动 @ %s 失败: %v", target.ID, err)
				r.sendFailureMessage(event, messageType, groupID, userID, fmt.Sprintf("主动 @ 生成失败: %v", err))
			}
		}(participant)
	}
	return true
}

// commandEnabled 读取命令开关（返回 exists=false 表示未配置，调用方按默认启用处理）。
func (r *Runtime) commandEnabled(path string) (enabled bool, exists bool) {
	if !r.document.Exists(path) {
		return true, false
	}
	return r.document.Bool(path), true
}
