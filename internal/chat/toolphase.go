package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/tools"
)

// 本文件对齐 Node goal-38 的两阶段提示词链路（goal-39 补齐 Go）：
//   工具阶段：仅工具说明 + 轻上下文 + 工具定义，先把工具调用做完；
//   正式回复：全量人设等提示词 + 【本轮工具执行结果】，不下发工具与工具说明。
// 关闭开关、无工具或工具阶段失败时回退单阶段（工具说明置顶 + 带工具）。

// toolTranscriptEntry 是一次工具调用的转写（供正式回复阶段引用）。
type toolTranscriptEntry struct {
	Name       string
	Arguments  string
	OK         bool
	Result     string
	DurationMs int64
}

// toolPhaseOutcome 是工具阶段产出。
type toolPhaseOutcome struct {
	Content       string
	Transcript    []toolTranscriptEntry
	Rounds        int
	ToolCallCount int
	ReachedLimit  bool
}

// toolPhaseEnabled 读取两阶段开关，键缺失时默认开启（对齐 Node chat.toolPhase.enabled !== false）。
func (r *Runtime) toolPhaseEnabled() bool {
	if r.document == nil {
		return true
	}
	if !r.document.Exists("chat.toolPhase.enabled") {
		return true
	}
	return r.document.Bool("chat.toolPhase.enabled")
}

// toolPhaseMaxResultChars 读取单条工具结果注入上限（默认 4000 字，范围 200~50000）。
func (r *Runtime) toolPhaseMaxResultChars() int {
	if r.document == nil {
		return 4000
	}
	value := int(r.document.Int("chat.toolPhase.maxResultChars", 4000))
	if value < 200 {
		value = 200
	}
	if value > 50000 {
		value = 50000
	}
	return value
}

// BuildToolPhaseMessages 构造工具阶段消息（对齐 Node buildToolPhaseMessages）：
// 全部 system 段（人设/世界书/记忆）去掉，只保留工具说明；末尾 assistant 预填只服务正式回复，一并去掉。
func BuildToolPhaseMessages(messages []ai.Message, hints []string, characterName string, chatScope string) []ai.Message {
	result := []ai.Message{}
	if scene := BuildToolPhaseScene(messages, characterName, chatScope); scene != "" {
		result = append(result, ai.Message{Role: "system", Content: scene})
	}
	if len(hints) > 0 {
		result = append(result, ai.Message{Role: "system", Content: "【工具使用说明】\n" + strings.Join(hints, "\n\n")})
	}
	for index, message := range messages {
		if message.Role == "system" {
			continue
		}
		if message.Role == "assistant" && index == len(messages)-1 {
			continue
		}
		result = append(result, message)
	}
	return result
}

// insertToolPhaseResult 把工具结果 system 段插到 assistant 预填之前；没有预填则追加到末尾（对齐 Node）。
func insertToolPhaseResult(messages []ai.Message, content string) []ai.Message {
	message := ai.Message{Role: "system", Content: content}
	if len(messages) > 0 && messages[len(messages)-1].Role == "assistant" {
		result := make([]ai.Message, 0, len(messages)+1)
		result = append(result, messages[:len(messages)-1]...)
		result = append(result, message, messages[len(messages)-1])
		return result
	}
	return append(messages, message)
}

// chatToolPhase 执行工具阶段：独立工具循环，不改动 chatWithTools 主链路。
// 轮次上限复用 chat.maxToolRounds，并加 50 轮安全上限（对齐 Node chatToolPhase）。
func (r *Runtime) chatToolPhase(ctx context.Context, messages []ai.Message, scope tools.CallScope) (*toolPhaseOutcome, error) {
	if r.tools == nil {
		return &toolPhaseOutcome{}, nil
	}
	definitions := r.tools.Definitions()
	if len(definitions) == 0 {
		return &toolPhaseOutcome{}, nil
	}

	configuredRounds := r.maxToolRounds()
	const hardCeiling = 50
	conversation := append([]ai.Message{}, messages...)
	transcript := []toolTranscriptEntry{}

	for round := 0; ; round++ {
		if (configuredRounds > 0 && round >= configuredRounds) || round >= hardCeiling {
			r.logger.Printf("[工具] 工具阶段达到轮次上限 %d，按已完成调用进入正式回复", round)
			return &toolPhaseOutcome{Transcript: transcript, Rounds: round, ToolCallCount: len(transcript), ReachedLimit: true}, nil
		}
		result, err := r.ai.Chat(ctx, conversation, map[string]any{"tools": definitions})
		if err != nil {
			return nil, err
		}
		if len(result.ToolCalls) == 0 {
			return &toolPhaseOutcome{Content: result.Content, Transcript: transcript, Rounds: round + 1, ToolCallCount: len(transcript)}, nil
		}
		conversation = append(conversation, ai.Message{Role: "assistant", Content: result.Content, ToolCalls: result.ToolCalls})
		for _, call := range result.ToolCalls {
			callID := call.ID
			if callID == "" {
				callID = tools.RandomIdentifier()
			}
			startedAt := time.Now()
			output := r.tools.Execute(ctx, call, scope)
			transcript = append(transcript, toolTranscriptEntry{
				Name:       call.Function.Name,
				Arguments:  call.Function.Arguments,
				OK:         !strings.HasPrefix(output, "工具执行失败："),
				Result:     output,
				DurationMs: time.Since(startedAt).Milliseconds(),
			})
			conversation = append(conversation, ai.Message{
				Role:       "tool",
				ToolCallID: callID,
				Name:       call.Function.Name,
				Content:    output,
			})
		}
	}
}

// buildToolPhaseResultMessage 生成注入正式回复的工具结果段（对齐 Node buildToolPhaseResultMessage）。
func buildToolPhaseResultMessage(transcript []toolTranscriptEntry, maxChars int) string {
	if len(transcript) == 0 {
		return ""
	}
	if maxChars <= 0 {
		maxChars = 4000
	}
	lines := []string{
		"【本轮工具执行结果】",
		"这些是刚刚真实执行工具得到的最新结果，回复时以它们为准；不要编造工具没有返回的信息。",
	}
	for index, entry := range transcript {
		status := "完成"
		if !entry.OK {
			status = "失败"
		}
		lines = append(lines, fmt.Sprintf("%d. %s｜参数: %s｜状态: %s", index+1, entry.Name, summarizeToolArguments(entry.Arguments), status))
		if text := strings.TrimSpace(truncateRunes(entry.Result, maxChars)); text != "" {
			lines = append(lines, text)
		}
	}
	return strings.Join(lines, "\n")
}

// summarizeToolArguments 把工具参数 JSON 压缩成一行摘要（键排序保证可复现）。
func summarizeToolArguments(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "无"
	}
	arguments := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &arguments); err != nil {
		return truncateRunes(raw, 160)
	}
	parts := []string{}
	for key, value := range arguments {
		parts = append(parts, key+"="+truncateRunes(fmt.Sprintf("%v", value), 80))
	}
	if len(parts) == 0 {
		return "无"
	}
	sort.Strings(parts)
	return truncateRunes(strings.Join(parts, ", "), 200)
}

// generateMentionForTool 生成主动 @ 正文并真实发送（对齐 Node generateContextualMentionReply + processMentionOutputText）：
// 复用完整人设 prompt（buildMessages）+ 提及任务追加到当前用户消息 → 模型生成 → 输出正则 → [at,text] 发送。
func (r *Runtime) generateMentionForTool(ctx context.Context, sessionKey string, messageType string, content string, injectionRisk InjectionRisk, groupID string, speakerUserID string, targetUserID string, targetName string, promptText string) (string, error) {
	if r.ai == nil {
		return "", fmt.Errorf("AI 未就绪")
	}
	if r.bot == nil {
		return "", fmt.Errorf("Bot 未就绪")
	}
	if groupID == "" || targetUserID == "" {
		return "", fmt.Errorf("群号与目标成员不能为空")
	}
	if strings.TrimSpace(promptText) == "" {
		return "", fmt.Errorf("主动 @ 的要求不能为空")
	}

	messages, _, err := r.buildMessages(sessionKey, content, messageType, injectionRisk, groupID, speakerUserID)
	if err != nil {
		return "", err
	}
	messages = appendMentionTaskToMessages(messages, buildMentionTaskPrompt(groupID, targetUserID, targetName, promptText))

	result, err := r.ai.Chat(ctx, messages, nil)
	if err != nil {
		return "", err
	}
	generated := strings.TrimSpace(r.regexProc.process(result.Content, "output", 0))
	if generated == "" {
		return "", fmt.Errorf("AI 未生成可发送内容")
	}

	segments := []map[string]any{
		{"type": "at", "data": map[string]any{"qq": targetUserID}},
		{"type": "text", "data": map[string]any{"text": " " + generated}},
	}
	if err := r.bot.SendGroupMessage(groupID, segments); err != nil {
		return "", fmt.Errorf("发送失败: %w", err)
	}
	r.logger.Printf("[工具] 已向群 %s 主动 @ %s", groupID, targetUserID)
	return generated, nil
}

// buildMentionTaskPrompt 对齐 Node buildMentionTaskPrompt 的提及任务文本。
func buildMentionTaskPrompt(groupID string, targetUserID string, targetName string, promptText string) string {
	name := strings.TrimSpace(targetName)
	if name == "" {
		name = targetUserID
	}
	return strings.Join([]string{
		"当前任务不是继续普通对话，而是由管理员要求你主动对一位群成员说一句话。",
		"目标群号: " + groupID,
		"目标成员: " + fmt.Sprintf("%s (%s)", name, targetUserID),
		"管理员要求: " + strings.TrimSpace(promptText),
		"请严格遵守以下要求：",
		"1. 必须保持当前角色卡、世界书、设定与语气，不要退化成通用助手口吻。",
		"2. 管理员提供的是意图，不要机械复述，也不要自称代管理员转述。",
		"3. 最终输出必须是准备直接发送给该成员的一条中文群聊消息正文。",
		"4. 不要包含 @ 前缀、引号、解释、规则说明或思维过程。",
		"5. 内容自然、简短、贴合群聊场景，避免写成长篇角色扮演。",
	}, "\n")
}

// appendMentionTaskToMessages 对齐 Node appendMentionTaskToMessages：
// 末尾是 user 时追加到该条，否则补一条新 user 消息。
func appendMentionTaskToMessages(messages []ai.Message, task string) []ai.Message {
	if len(messages) == 0 {
		return []ai.Message{{Role: "user", Content: task}}
	}
	last := messages[len(messages)-1]
	if last.Role == "user" {
		messages[len(messages)-1] = ai.Message{Role: "user", Content: fmt.Sprintf("%v\n\n%s", last.Content, task)}
		return messages
	}
	return append(messages, ai.Message{Role: "user", Content: task})
}

// generateReply 执行正式回复（两阶段优先，失败/关闭时回退单阶段）；
// 返回最终使用的消息序列（含工具结果段），供后续重试链路复用。
func (r *Runtime) generateReply(ctx context.Context, messages []ai.Message, scope tools.CallScope, chatScope string) (string, []ai.Message, error) {
	hints := []string{}
	hasTools := false
	if r.tools != nil {
		hints = r.tools.ToolHints()
		hasTools = len(r.tools.Definitions()) > 0
	}

	if r.toolPhaseEnabled() && hasTools {
		phaseMessages := BuildToolPhaseMessages(messages, hints, r.characterName(), chatScope)
		startedAt := time.Now()
		outcome, err := r.chatToolPhase(ctx, phaseMessages, scope)
		if err == nil {
			r.logger.Printf("[执行] 工具阶段完成（%d 轮，%d 次调用，%dms，达到上限=%v）",
				outcome.Rounds, outcome.ToolCallCount, time.Since(startedAt).Milliseconds(), outcome.ReachedLimit)
			if resultMessage := buildToolPhaseResultMessage(outcome.Transcript, r.toolPhaseMaxResultChars()); resultMessage != "" {
				messages = insertToolPhaseResult(messages, resultMessage)
			}
			result, err := r.ai.Chat(ctx, messages, nil)
			if err != nil {
				return "", messages, err
			}
			return result.Content, messages, nil
		}
		r.logger.Printf("[执行] 工具阶段失败，回退单阶段执行: %v", err)
	}

	// 单阶段（开关关闭 / 无工具 / 阶段一失败降级）：工具说明置顶 + 带工具执行
	if len(hints) > 0 {
		text := "【工具使用说明】\n" + strings.Join(hints, "\n\n")
		messages = append([]ai.Message{{Role: "system", Content: text}}, messages...)
	}
	reply, err := r.chatWithTools(ctx, messages, scope)
	return reply, messages, err
}

// toolCallScope 构造本次消息的工具执行上下文（对齐 Node buildAIToolContext 的默认值 + mentionGenerator）。
func (r *Runtime) toolCallScope(sessionKey string, messageType string, content string, injectionRisk InjectionRisk, groupID string, userID string, speakerName string) tools.CallScope {
	scope := tools.CallScope{
		GroupID:      groupID,
		TargetUserID: userID,
		TargetName:   speakerName,
	}
	scope.MentionGenerator = func(ctx context.Context, targetGroupID string, targetUserID string, targetName string, promptText string) (string, error) {
		return r.generateMentionForTool(ctx, sessionKey, messageType, content, injectionRisk, targetGroupID, userID, targetUserID, targetName, promptText)
	}
	return scope
}

// speakerNameFromEvent 取发言人显示名（群名片优先，对齐 Node currentSpeaker.participantName）。
func speakerNameFromEvent(event map[string]any) string {
	sender, ok := event["sender"].(map[string]any)
	if !ok {
		return ""
	}
	name := stringValue(sender["nickname"])
	if card := stringValue(sender["card"]); card != "" {
		name = card
	}
	return name
}

// toolPhaseHeaderPattern 解析 buildInputHeader/buildStructuredMessage 生成的结构化消息头。
var toolPhaseHeaderPattern = regexp.MustCompile(`\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|群号:([^|\]]*)\|群名:([^|\]]*)`)

// toolPhaseMessageText 取单条消息的纯文本（兼容多模态分段）。
func toolPhaseMessageText(message ai.Message) string {
	switch content := message.Content.(type) {
	case string:
		return content
	case []any:
		parts := []string{}
		for _, item := range content {
			switch part := item.(type) {
			case string:
				parts = append(parts, part)
			case map[string]any:
				if text, ok := part["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

// BuildToolPhaseScene 构造工具阶段的轻量场景卡（对齐 Node buildToolPhaseScene）：
// 只从消息头提取角色名/会话/发言人/近期发言人名单，解决“只给聊天记录不给背景”导致的指代与 @ 找人发懵；
// 不加载人设、世界书、记忆正文，保持工具阶段轻量。
func BuildToolPhaseScene(messages []ai.Message, characterName string, chatScope string) string {
	const maxParticipants = 10
	order := []string{}
	names := map[string]string{}
	groupNames := map[string]string{}
	sessionLabel := ""
	currentSpeaker := ""
	lastGroupID := ""
	for _, message := range messages {
		text := toolPhaseMessageText(message)
		match := toolPhaseHeaderPattern.FindStringSubmatch(text)
		if match == nil {
			continue
		}
		chatLabel, qq, nickname, groupID, groupName := match[1], match[2], match[3], match[4], match[5]
		if qq == "" {
			continue
		}
		// 只统计当前聊天范围的消息（共享会话下历史可能含其他群/其他人私聊）
		if chatScope != "" {
			if scope := HeaderChatScope(text); scope != "" && scope != chatScope {
				continue
			}
		}
		for index, item := range order {
			if item == qq {
				order = append(order[:index], order[index+1:]...)
				break
			}
		}
		order = append(order, qq)
		if nickname == "" {
			nickname = "QQ " + qq
		}
		names[qq] = nickname
		if chatLabel == "群聊" && groupID != "" && groupID != "N/A" {
			lastGroupID = groupID
			// 当前事件头可能没有群名（群名:N/A），优先保留历史里出现过的真名
			if groupName != "" && groupName != "N/A" {
				groupNames[groupID] = groupName
			}
		} else if chatLabel == "私聊" {
			sessionLabel = "私聊 QQ:" + qq
		}
		if message.Role == "user" {
			currentSpeaker = fmt.Sprintf("%s(%s)", nickname, qq)
		}
	}
	if lastGroupID != "" {
		label := groupNames[lastGroupID]
		if label == "" {
			label = "群 " + lastGroupID
		}
		sessionLabel = fmt.Sprintf("群聊「%s」(%s)", label, lastGroupID)
	}

	lines := []string{"【当前场景】"}
	if characterName != "" {
		lines = append(lines, fmt.Sprintf("- 你正在以角色「%s」参与这次对话；本次只做工具决策，不需要扮演或输出人设内容。", characterName))
	}
	if sessionLabel != "" {
		lines = append(lines, "- 当前会话: "+sessionLabel)
	}
	if currentSpeaker != "" {
		lines = append(lines, "- 当前发言人: "+currentSpeaker)
	}
	if len(order) > maxParticipants {
		order = order[len(order)-maxParticipants:]
	}
	// 私聊没有“近期发言人”概念，只保留当前发言人
	if !ChatScopeIsPrivate(chatScope) && len(order) >= 2 {
		recent := make([]string, 0, len(order))
		for _, qq := range order {
			recent = append(recent, fmt.Sprintf("%s(%s)", names[qq], qq))
		}
		lines = append(lines, "- 近期发言人: "+strings.Join(recent, "、"))
	}
	if len(lines) == 1 {
		return ""
	}
	return strings.Join(lines, "\n")
}
