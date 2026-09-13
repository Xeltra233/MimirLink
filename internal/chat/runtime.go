// Package chat 实现聊天运行时：触发判定、提示词构建、记忆落库与回复派发。
//
// 对齐 Node 版的关键语义：
//   - 会话记忆范围按 chat.sessionMode 计算（user_persistent / group_shared / group_user / global_shared）
//   - 群聊默认需要 @bot（chat.requireAtInGroup），白名单按 chat.allowedGroups 过滤
//   - 消息以 `[群聊|QQ:..|昵称:..|群号:..|群名:..|时间:..|eventType:message|isAtBot:..] 正文` 形式进入上下文
//   - 入站/出站消息写入同一套 sessions / messages 表，保证与 Node 版数据完全兼容
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
	"mimirlink/internal/tools"
)

// ChatModel 是聊天模型能力（*ai.Client 实现）。
type ChatModel interface {
	Chat(ctx context.Context, messages []ai.Message, overrides map[string]any) (*ai.ChatResult, error)
}

// Bot 是聊天运行时需要的 OneBot 能力。
type Bot interface {
	SelfID() string
	SendGroupMessage(groupID string, message any) error
	SendPrivateMessage(userID string, message any) error
	GetForwardMsg(id string) (any, error)
}

// Options 是运行时依赖。
type Options struct {
	Document    *config.Document
	Memory      *store.DB
	AI          ChatModel
	Bot         Bot
	Tools       *tools.Registry
	Logger      *log.Logger
	HistorySize int
}

// Runtime 处理单条 OneBot 事件。
type Runtime struct {
	document    *config.Document
	memory      *store.DB
	ai          ChatModel
	bot         Bot
	tools       *tools.Registry
	logger      *log.Logger
	historySize int
}

// New 创建运行时。
func New(options Options) *Runtime {
	logger := options.Logger
	if logger == nil {
		logger = log.Default()
	}
	historySize := options.HistorySize
	if historySize <= 0 {
		historySize = 20
	}
	return &Runtime{
		document:    options.Document,
		memory:      options.Memory,
		ai:          options.AI,
		bot:         options.Bot,
		tools:       options.Tools,
		logger:      logger,
		historySize: historySize,
	}
}

// HandleEvent 处理一条事件；返回是否产生了回复。
func (r *Runtime) HandleEvent(event map[string]any) bool {
	eventType := stringField(event, "post_type")
	if eventType != "message" {
		return false
	}
	if stringField(event, "sub_type") == "self" {
		return false
	}
	userID := idField(event, "user_id")
	selfID := r.bot.SelfID()
	if userID != "" && userID == selfID {
		return false
	}
	messageType := stringField(event, "message_type")
	groupID := idField(event, "group_id")
	if messageType == "group" {
		if !r.groupAllowed(groupID) {
			r.logger.Printf("[聊天] 群 %s 不在白名单，跳过", groupID)
			return false
		}
		if r.requireAtInGroup() && !containsAtSelf(event["message"], selfID) {
			return false
		}
	}

	segments := messageSegments(event["message"])
	text := r.renderSegments(segments)
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}

	sessionKey := r.sessionKey(messageType, groupID, userID)
	header := r.buildInputHeader(event, messageType, groupID, userID)
	content := strings.TrimSpace(header + " " + text)

	if err := r.appendMessage(sessionKey, "user", content, map[string]any{
		"messageType": messageType,
		"userId":      userID,
		"groupId":     groupID,
		"messageId":   idField(event, "message_id"),
	}); err != nil {
		r.logger.Printf("[聊天] 写入用户消息失败: %v", err)
	}

	messages, err := r.buildMessages(sessionKey, content)
	if err != nil {
		r.logger.Printf("[聊天] 构建上下文失败: %v", err)
		return false
	}

	startedAt := time.Now()
	reply, err := r.chatWithTools(context.Background(), messages)
	reply = strings.TrimSpace(reply)
	if err != nil {
		r.logger.Printf("[聊天] AI 调用失败: %v", err)
		return false
	}
	if reply == "" {
		r.logger.Printf("[聊天] 模型返回空回复")
		return false
	}
	r.logger.Printf("[聊天] AI 回复 %d 字，用时 %dms", len([]rune(reply)), time.Since(startedAt).Milliseconds())

	if err := r.appendMessage(sessionKey, "assistant", reply, map[string]any{"messageType": messageType}); err != nil {
		r.logger.Printf("[聊天] 写入回复失败: %v", err)
	}

	if err := r.dispatch(messageType, groupID, userID, event, reply); err != nil {
		r.logger.Printf("[聊天] 发送回复失败: %v", err)
		return false
	}
	return true
}

// ---------------- 触发规则 ----------------

func (r *Runtime) groupAllowed(groupID string) bool {
	allowed := stringListField(r.document, "chat.allowedGroups")
	if len(allowed) == 0 {
		blocked := stringListField(r.document, "chat.blockedGroups")
		for _, item := range blocked {
			if item == groupID {
				return false
			}
		}
		return true
	}
	for _, item := range allowed {
		if item == groupID {
			return true
		}
	}
	return false
}

func (r *Runtime) requireAtInGroup() bool {
	if r.document.Exists("chat.requireAtInGroup") {
		return r.document.Bool("chat.requireAtInGroup")
	}
	return true
}

// ---------------- 提示词与历史 ----------------

func (r *Runtime) buildMessages(sessionKey string, currentContent string) ([]ai.Message, error) {
	messages := []ai.Message{}
	for _, prompt := range r.presetPrompts() {
		role := "system"
		if strings.EqualFold(prompt.role, "user") || strings.EqualFold(prompt.role, "assistant") {
			role = strings.ToLower(prompt.role)
		}
		messages = append(messages, ai.Message{Role: role, Content: prompt.content})
	}

	history, err := r.memory.RecentMessagesThread(sessionKey, r.historySize)
	if err != nil {
		return nil, err
	}
	// 历史里最后一条通常是刚落库的当前消息：剥离后作为最后一条用户消息单独追加
	if len(history) > 0 && strings.TrimSpace(history[len(history)-1].Content) == strings.TrimSpace(currentContent) {
		history = history[:len(history)-1]
	}
	for _, item := range history {
		role := item.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		messages = append(messages, ai.Message{Role: role, Content: item.Content})
	}
	messages = append(messages, ai.Message{Role: "user", Content: currentContent})
	return messages, nil
}

type presetPrompt struct {
	role    string
	content string
}

// presetPrompts 读取 config.preset.prompts 中启用的提示词（按 injection_depth 升序）。
func (r *Runtime) presetPrompts() []presetPrompt {
	var raw map[string]any
	if err := json.Unmarshal(r.document.Raw(), &raw); err != nil {
		return nil
	}
	preset, _ := raw["preset"].(map[string]any)
	if preset == nil {
		return nil
	}
	items, _ := preset["prompts"].([]any)
	prompts := make([]presetPrompt, 0, len(items))
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		if enabled, ok := entry["enabled"].(bool); ok && !enabled {
			continue
		}
		content := strings.TrimSpace(stringValue(entry["content"]))
		if content == "" {
			continue
		}
		role := "system"
		if systemPrompt, ok := entry["system_prompt"].(bool); ok && !systemPrompt {
			role = "system" // 非系统提示词也走 system，MVP 保持简单
		}
		prompts = append(prompts, presetPrompt{role: role, content: content})
	}
	return prompts
}

// ---------------- 记忆 ----------------

func (r *Runtime) sessionKey(messageType string, groupID string, userID string) string {
	mode := r.document.String("chat.sessionMode")
	switch mode {
	case "global_shared":
		return "global_shared_memory"
	case "group_shared":
		if messageType == "group" {
			return "group:" + groupID
		}
		return "private:" + userID
	case "group_user":
		if messageType == "group" {
			return "group_user:" + groupID + ":" + userID
		}
		return "private:" + userID
	default:
		if messageType == "group" {
			return "user:" + userID
		}
		return "user:" + userID
	}
}

func generateMessageID() string {
	return fmt.Sprintf("%d_%s", time.Now().UnixMilli(), randomSuffix(6))
}

const suffixAlphabet = "abcdefghijklmnopqrstuvwxyz0123456789"

func randomSuffix(length int) string {
	builder := strings.Builder{}
	for index := 0; index < length; index += 1 {
		builder.WriteByte(suffixAlphabet[rand.Intn(len(suffixAlphabet))])
	}
	return builder.String()
}

func (r *Runtime) appendMessage(sessionKey string, role string, content string, metadata map[string]any) error {
	if r.memory == nil {
		return nil
	}
	id := generateMessageID()
	metadata["id"] = id
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		metadataJSON = []byte("{}")
	}
	return r.memory.AppendMessage(store.Message{
		ID:           id,
		SessionID:    sessionKey,
		Role:         role,
		Content:      content,
		MetadataJSON: string(metadataJSON),
		Timestamp:    time.Now().UnixMilli(),
		DateISO:      time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	})
}

// ---------------- 工具调用循环 ----------------

// maxToolRounds 读取 chat.maxToolRounds：0 或未配置表示不限制（与 Node 版一致）。
func (r *Runtime) maxToolRounds() int {
	value := r.document.Int("chat.maxToolRounds", 0)
	if value > 0 {
		return int(value)
	}
	return 0
}

// hardToolRoundCeiling 是"不限制"模式下的安全上限，防止模型陷入死循环。
const hardToolRoundCeiling = 50

// chatWithTools 执行对话并按需进入工具调用循环。
func (r *Runtime) chatWithTools(ctx context.Context, messages []ai.Message) (string, error) {
	if r.tools == nil {
		result, err := r.ai.Chat(ctx, messages, nil)
		if err != nil {
			return "", err
		}
		return result.Content, nil
	}
	definitions := r.tools.Definitions()
	if len(definitions) == 0 {
		result, err := r.ai.Chat(ctx, messages, nil)
		if err != nil {
			return "", err
		}
		return result.Content, nil
	}

	configuredRounds := r.maxToolRounds()
	conversation := append([]ai.Message{}, messages...)
	r.logger.Printf("[工具] 本轮可用工具: %s", strings.Join(r.tools.Names(), ", "))

	for round := 0; ; round += 1 {
		reachedConfiguredLimit := configuredRounds > 0 && round >= configuredRounds
		overrides := map[string]any{"tools": definitions}
		if reachedConfiguredLimit || round >= hardToolRoundCeiling {
			overrides = nil
			if reachedConfiguredLimit {
				r.logger.Printf("[工具] 已达配置轮次上限 %d，转为收尾总结", configuredRounds)
			} else {
				r.logger.Printf("[工具] 达到安全上限 %d 轮，强制收尾", hardToolRoundCeiling)
			}
			conversation = append(conversation, ai.Message{
				Role:    "system",
				Content: "本轮已达到工具调用上限。不要再调用工具，请基于已经拿到的信息直接总结并回复用户。",
			})
		}

		result, err := r.ai.Chat(ctx, conversation, overrides)
		if err != nil {
			return "", err
		}
		if len(result.ToolCalls) == 0 {
			return result.Content, nil
		}

		assistantMessage := ai.Message{Role: "assistant", Content: result.Content, ToolCalls: result.ToolCalls}
		if assistantMessage.Content == nil {
			assistantMessage.Content = ""
		}
		conversation = append(conversation, assistantMessage)
		for _, call := range result.ToolCalls {
			callID := call.ID
			if callID == "" {
				callID = tools.RandomIdentifier()
			}
			output := r.tools.Execute(ctx, call)
			conversation = append(conversation, ai.Message{
				Role:       "tool",
				ToolCallID: callID,
				Name:       call.Function.Name,
				Content:    output,
			})
		}
	}
}

// ---------------- 渲染与回复 ----------------

func messageSegments(value any) []map[string]any {
	switch typed := value.(type) {
	case []any:
		segments := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			if entry, ok := item.(map[string]any); ok {
				segments = append(segments, entry)
			}
		}
		return segments
	case string:
		return parseCQString(typed)
	default:
		return nil
	}
}

func parseCQString(raw string) []map[string]any {
	segments := []map[string]any{}
	offset := 0
	for {
		start := strings.Index(raw[offset:], "[CQ:")
		if start < 0 {
			break
		}
		start += offset
		if start > offset {
			segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": raw[offset:start]}})
		}
		end := strings.Index(raw[start:], "]")
		if end < 0 {
			break
		}
		end += start
		body := raw[start+4 : end]
		parts := strings.SplitN(body, ",", 2)
		data := map[string]any{}
		if len(parts) > 1 {
			for _, field := range strings.Split(parts[1], ",") {
				pair := strings.SplitN(field, "=", 2)
				if len(pair) == 2 {
					data[pair[0]] = pair[1]
				}
			}
		}
		segments = append(segments, map[string]any{"type": parts[0], "data": data})
		offset = end + 1
	}
	if offset < len(raw) {
		segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": raw[offset:]}})
	}
	return segments
}

// renderSegments 把消息段渲染成可读文本（forward 会拉取合并转发内容）。
func (r *Runtime) renderSegments(segments []map[string]any) string {
	builder := strings.Builder{}
	for _, segment := range segments {
		segmentType := stringValue(segment["type"])
		data, _ := segment["data"].(map[string]any)
		switch segmentType {
		case "text":
			builder.WriteString(stringValue(data["text"]))
		case "at":
			qq := stringValue(data["qq"])
			if qq == r.bot.SelfID() {
				builder.WriteString("[@bot] ")
			} else {
				builder.WriteString("[@" + qq + "] ")
			}
		case "image":
			summary := stringValue(data["summary"])
			if summary == "" {
				summary = stringValue(data["file"])
			}
			builder.WriteString("[图片" + optionalSuffix(summary) + "]")
		case "record":
			builder.WriteString("[语音]")
		case "video":
			builder.WriteString("[视频]")
		case "face":
			builder.WriteString("[QQ表情]")
		case "reply":
			builder.WriteString("[引用消息]")
		case "forward":
			builder.WriteString(r.renderForward(stringValue(data["id"])))
		default:
			builder.WriteString("[" + segmentType + "]")
		}
	}
	return builder.String()
}

func optionalSuffix(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	if len(trimmed) > 24 {
		trimmed = trimmed[:24] + "…"
	}
	return ":" + trimmed
}

// renderForward 拉取并渲染合并转发内容（与 Node 版 transcript 形状一致）。
func (r *Runtime) renderForward(forwardID string) string {
	if forwardID == "" {
		return "[合并转发聊天记录|缺少 id]"
	}
	payload, err := r.bot.GetForwardMsg(forwardID)
	if err != nil {
		return "[合并转发聊天记录|读取失败:" + err.Error() + "]"
	}
	nodes := normalizeForwardNodes(payload)
	if len(nodes) == 0 {
		return "[合并转发聊天记录|内容为空]"
	}
	lines := make([]string, 0, len(nodes))
	imageCount := 0
	for index, node := range nodes {
		text := r.renderSegments(node.segments)
		for _, segment := range node.segments {
			if stringValue(segment["type"]) == "image" {
				imageCount += 1
			}
		}
		lines = append(lines, fmt.Sprintf("%d. %s: %s", index+1, node.name, strings.TrimSpace(text)))
	}
	imageNote := ""
	if imageCount > 0 {
		imageNote = fmt.Sprintf("|含图片%d张", imageCount)
	}
	return fmt.Sprintf("[合并转发聊天记录|共%d条%s]\n%s\n[/合并转发]", len(nodes), imageNote, strings.Join(lines, "\n"))
}

type forwardNode struct {
	name     string
	userID   string
	segments []map[string]any
}

// normalizeForwardNodes 兼容 NapCat / go-cqhttp / Lagrange 的多种返回结构。
func normalizeForwardNodes(payload any) []forwardNode {
	candidates := []any{}
	switch typed := payload.(type) {
	case []any:
		candidates = typed
	case map[string]any:
		for _, key := range []string{"messages", "message", "nodes", "data"} {
			value := typed[key]
			if list, ok := value.([]any); ok {
				candidates = list
				break
			}
			if inner, ok := value.(map[string]any); ok {
				for _, innerKey := range []string{"messages", "message", "nodes"} {
					if list, ok := inner[innerKey].([]any); ok {
						candidates = list
						break
					}
				}
			}
			if len(candidates) > 0 {
				break
			}
		}
	}
	nodes := []forwardNode{}
	for _, item := range candidates {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		name := stringValue(entry["nickname"])
		userID := idField(entry, "user_id")
		if sender, ok := entry["sender"].(map[string]any); ok {
			if card := stringValue(sender["card"]); card != "" {
				name = card
			} else if nickname := stringValue(sender["nickname"]); nickname != "" {
				name = nickname
			}
			if id := idField(sender, "user_id"); id != "" {
				userID = id
			}
		}
		if name == "" {
			name = userID
		}
		if name == "" {
			name = "未知"
		}
		content := entry["message"]
		if content == nil {
			content = entry["content"]
		}
		if content == nil {
			content = entry["data"]
		}
		segments := messageSegments(content)
		if len(segments) == 0 {
			continue
		}
		nodes = append(nodes, forwardNode{name: name, userID: userID, segments: segments})
	}
	return nodes
}

// buildInputHeader 生成与 Node 版一致的结构化消息头。
func (r *Runtime) buildInputHeader(event map[string]any, messageType string, groupID string, userID string) string {
	nickname := ""
	if sender, ok := event["sender"].(map[string]any); ok {
		nickname = stringValue(sender["nickname"])
	}
	timeText := time.Now().Format("2006/1/2 15:04:05")
	if timestamp, ok := numericField(event, "time"); ok && timestamp > 0 {
		timeText = time.Unix(timestamp, 0).Format("2006/1/2 15:04:05")
	}
	groupLabel := "N/A"
	groupName := "N/A"
	if messageType == "group" {
		groupLabel = groupID
	}
	isAtBot := "false"
	if containsAtSelf(event["message"], r.bot.SelfID()) {
		isAtBot = "true"
	}
	chatLabel := "私聊"
	if messageType == "group" {
		chatLabel = "群聊"
	}
	return fmt.Sprintf("[%s|QQ:%s|昵称:%s|群号:%s|群名:%s|时间:%s|eventType:message|isAtBot:%s]", chatLabel, userID, nickname, groupLabel, groupName, timeText, isAtBot)
}

func (r *Runtime) dispatch(messageType string, groupID string, userID string, event map[string]any, reply string) error {
	segments := []map[string]any{}
	if messageID := idField(event, "message_id"); messageID != "" {
		if r.document.Bool("chat.quoteReplyEnabled") || !r.document.Exists("chat.quoteReplyEnabled") {
			segments = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": messageID}})
		}
	}
	if messageType == "group" {
		segments = append(segments, map[string]any{"type": "at", "data": map[string]any{"qq": userID}})
		segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": reply}})
		return r.bot.SendGroupMessage(groupID, segments)
	}
	segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": reply}})
	return r.bot.SendPrivateMessage(userID, segments)
}

// ---------------- 字段工具 ----------------

func containsAtSelf(message any, selfID string) bool {
	for _, segment := range messageSegments(message) {
		if stringValue(segment["type"]) != "at" {
			continue
		}
		data, _ := segment["data"].(map[string]any)
		if stringValue(data["qq"]) == selfID {
			return true
		}
	}
	return false
}

func stringField(event map[string]any, key string) string {
	return stringValue(event[key])
}

func idField(event map[string]any, key string) string {
	if value, ok := numericField(event, key); ok {
		return fmt.Sprintf("%d", value)
	}
	return stringValue(event[key])
}

func numericField(event map[string]any, key string) (int64, bool) {
	switch typed := event[key].(type) {
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case json.Number:
		value, err := typed.Int64()
		return value, err == nil
	case string:
		var parsed int64
		if _, err := fmt.Sscanf(typed, "%d", &parsed); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%v", typed)
	case json.Number:
		return typed.String()
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func stringListField(document *config.Document, path string) []string {
	result := document.Get(path)
	if !result.IsArray() {
		return nil
	}
	values := []string{}
	for _, item := range result.Array() {
		values = append(values, item.String())
	}
	return values
}
