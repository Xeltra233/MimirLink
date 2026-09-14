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
	"path/filepath"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
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
	RootDir     string
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
	rootDir     string
	regexProc   *regexProcessor
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
		rootDir:     options.RootDir,
		regexProc:   newRegexProcessor(options.Document.Raw()),
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
	// 注入风险检测（对齐 Node detectPromptInjectionRisk：只扫描用户输入本身）
	injectionRisk := DetectPromptInjectionRisk(text)
	if injectionRisk.Level == "high" {
		r.logger.Printf("[安全] 高风险注入已拦截 [%s] 规则:%s 分数:%d", sessionKey, strings.Join(injectionRisk.MatchedRules, ","), injectionRisk.Score)
		if err := r.dispatch(messageType, groupID, userID, event, "⚠️ 检测到提示注入攻击，已拦截。"); err != nil {
			r.logger.Printf("[安全] 拦截提示发送失败: %v", err)
		}
		return true
	}
	if injectionRisk.Level != "none" {
		r.logger.Printf("[安全] 疑似注入 (%s) [%s] 规则:%s", injectionRisk.Level, sessionKey, strings.Join(injectionRisk.MatchedRules, ","))
	}
	header := r.buildInputHeader(event, messageType, groupID, userID)
	content := strings.TrimSpace(header + " " + text)
	// 输入阶段正则（对齐 Node regexProcessor.processInput）
	content = r.regexProc.process(content, "input", 0)

	if err := r.appendMessage(sessionKey, "user", content, map[string]any{
		"messageType": messageType,
		"userId":      userID,
		"groupId":     groupID,
		"messageId":   idField(event, "message_id"),
	}); err != nil {
		r.logger.Printf("[聊天] 写入用户消息失败: %v", err)
	}

	// 回复前摘要检查（对齐 Node summaryBeforeReply）
	r.maybeSummarize(sessionKey)

	messages, worldBookEntries, err := r.buildMessages(sessionKey, content, messageType, injectionRisk)
	if err != nil {
		r.logger.Printf("[聊天] 构建上下文失败: %v", err)
		return false
	}
	// 世界书粘性续期（对齐 Node updateStickyEntries）
	triggers := make([]store.StickyTrigger, 0, len(worldBookEntries))
	for _, entry := range worldBookEntries {
		triggers = append(triggers, store.StickyTrigger{Key: entry.Key, Sticky: int(entry.Sticky)})
	}
	if err := r.memory.UpdateStickyEntries(sessionKey, triggers); err != nil {
		r.logger.Printf("[聊天] 更新粘性条目失败: %v", err)
	}

	startedAt := time.Now()
	reply, err := r.chatWithTools(context.Background(), messages)
	reply = strings.TrimSpace(reply)
	reply = r.regexProc.process(reply, "output", 0)
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

func (r *Runtime) buildMessages(sessionKey string, currentContent string, messageType string, injectionRisk InjectionRisk) ([]ai.Message, []matchedWorldBookEntry, error) {
	history, err := r.memory.RecentMessagesThread(sessionKey, r.historySize)
	if err != nil {
		return nil, nil, err
	}
	// 历史里最后一条通常是刚落库的当前消息：剥离后作为最后一条用户消息单独追加
	if len(history) > 0 && strings.TrimSpace(history[len(history)-1].Content) == strings.TrimSpace(currentContent) {
		history = history[:len(history)-1]
	}

	messages := []ai.Message{}
	// 1) 当前时间（对齐 Node current-time 段）
	messages = append(messages, ai.Message{Role: "system", Content: "【当前时间】" + currentTimeString()})
	// 1.5) 会话上下文 / 输入护栏 / 人类群聊决策规则（对齐 Node situational-context /
	//      input-guardrail / human-chat-control-v2 段）
	if situational := r.buildSituationalContext(sessionKey, history, messageType); situational != "" {
		messages = append(messages, ai.Message{Role: "system", Content: situational})
	}
	if r.guardrailEnabled() {
		messages = append(messages, ai.Message{Role: "system", Content: BuildInputGuardrail(injectionRisk)})
	}
	if prompt := r.humanChatControlPrompt(); prompt != "" {
		messages = append(messages, ai.Message{Role: "system", Content: prompt})
	}
	// 2) 预设四段切分（对齐 Node partitionPromptItems）
	partition := partitionPromptItems(parsePreset(r.document.Raw()))
	for _, item := range partition.PreSystem {
		messages = append(messages, ai.Message{Role: "system", Content: item.Content})
	}
	// 3) 世界书匹配（常驻 + 关键词 + 粘性），position=0 进 system
	worldBookEntries := r.matchWorldbook(sessionKey, history, currentContent)
	for _, entry := range worldBookEntries {
		if resolveWorldBookPositionFromEntry(entry) == 1 {
			continue
		}
		messages = append(messages, ai.Message{Role: "system", Content: "【世界设定】\n" + entry.Content})
	}
	for _, segment := range r.characterSegments() {
		messages = append(messages, ai.Message{Role: "system", Content: segment})
	}
	// 5) 数据库召回（固定知识 / 动态知识 / 其他召回）
	if recalled := r.recallSection(sessionKey, currentContent); recalled != "" {
		messages = append(messages, ai.Message{Role: "system", Content: recalled})
	}

	// 6) 历史 + historyInjection（injection_depth = 从历史末尾插入的位置）
	injectionBuckets := map[int][]promptItem{}
	for _, item := range partition.HistoryInjection {
		insertionIndex := item.InjectionDepth
		if insertionIndex < 0 {
			insertionIndex = 0
		}
		if insertionIndex > len(history) {
			insertionIndex = len(history)
		}
		injectionBuckets[insertionIndex] = append(injectionBuckets[insertionIndex], item)
	}
	appendInjections := func(index int) {
		for _, item := range injectionBuckets[index] {
			messages = append(messages, ai.Message{Role: "system", Content: item.Content})
		}
	}
	appendInjections(0)
	for index, item := range history {
		role := item.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		messages = append(messages, ai.Message{Role: role, Content: item.Content})
		appendInjections(index + 1)
	}
	// 7) postHistory：世界书 after_char 条目 + injection_position==1 的预设项
	for _, entry := range worldBookEntries {
		if resolveWorldBookPositionFromEntry(entry) == 1 {
			messages = append(messages, ai.Message{Role: "system", Content: "【世界设定】\n" + entry.Content})
		}
	}
	for _, item := range partition.PostHistory {
		messages = append(messages, ai.Message{Role: "system", Content: item.Content})
	}
	// 8) 当前用户消息
	messages = append(messages, ai.Message{Role: "user", Content: currentContent})
	// 9) assistantPrefill（拼接为一条 assistant 预填）
	prefillParts := []string{}
	for _, item := range partition.AssistantPrefill {
		if trimmed := strings.TrimSpace(item.Content); trimmed != "" {
			prefillParts = append(prefillParts, trimmed)
		}
	}
	if len(prefillParts) > 0 {
		messages = append(messages, ai.Message{Role: "assistant", Content: strings.Join(prefillParts, "\n\n")})
	}
	return messages, worldBookEntries, nil
}

// matchWorldbook 读取当前生效的世界书并执行匹配（对齐 Node promptBuilder.build 的世界书分支）。
func (r *Runtime) matchWorldbook(sessionKey string, history []store.Message, currentContent string) []matchedWorldBookEntry {
	book := r.currentWorldbook()
	if book == nil {
		return nil
	}
	stickyKeys := map[string]bool{}
	if sticky, err := r.memory.ListStickyEntries(sessionKey); err == nil {
		for key := range sticky {
			stickyKeys[key] = true
		}
	}
	builder := strings.Builder{}
	for _, message := range history {
		builder.WriteString(message.Content)
		builder.WriteString(" ")
	}
	builder.WriteString(currentContent)
	return matchWorldBookEntries(book, builder.String(), 10, stickyKeys)
}

// currentWorldbook 解析生效世界书：bindings.global.worldbook 优先，其次按角色名模糊匹配。
func (r *Runtime) currentWorldbook() *worldBook {
	worldbookName := r.document.String("bindings.global.worldbook")
	if worldbookName != "" {
		if book, err := loadWorldBookFile(filepath.Join(r.dataDir(), "worlds", worldbookName+".json")); err == nil {
			return book
		}
		if book, err := loadWorldBookFile(filepath.Join(r.dataDir(), "worlds", worldbookName)); err == nil {
			return book
		}
	}
	book, _, _ := readWorldBook(r.dataDir(), r.characterName())
	return book
}

// resolveWorldBookPositionFromEntry 输出条目位置（1=post_history，0=system）。
func resolveWorldBookPositionFromEntry(entry matchedWorldBookEntry) int {
	return entry.Position
}

// currentTimeString 输出上海时区的当前时间串（对齐 Node toLocaleString('zh-CN', Asia/Shanghai)）。
func currentTimeString() string {
	location, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		location = time.FixedZone("CST", 8*3600)
	}
	return time.Now().In(location).Format("2006/1/2 15:04:05")
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

// ---------------- 记忆召回与角色段 ----------------

// recallOptions 读取配置里的召回规模（缺省与 Node 一致）。
func (r *Runtime) recallOptions() store.RecallOptions {
	options := store.DefaultRecallOptions
	if value := r.document.Int("memory.recall.limit", 0); value > 0 {
		options.Limit = int(value)
	}
	if value := r.document.Int("memory.recall.searchLimit", 0); value > 0 {
		options.SearchLimit = int(value)
	}
	if value := r.document.Int("memory.recall.recentLimit", 0); value > 0 {
		options.RecentLimit = int(value)
	}
	if value := r.document.Int("memory.recall.summaryLimit", 0); value > 0 {
		options.SummaryLimit = int(value)
	}
	return options
}

// recallSection 渲染数据库召回文本段（与 Node prompt.js 的 database_recall 段一致）。
func (r *Runtime) recallSection(sessionKey string, query string) string {
	if r.memory == nil {
		return ""
	}
	namespace := r.namespaceOptions(sessionKey)
	entries, err := r.memory.RecallMemory(namespace, query, r.recallOptions())
	if err != nil {
		r.logger.Printf("[记忆] 召回失败: %v", err)
		return ""
	}
	if len(entries) == 0 {
		return ""
	}
	fixed := []store.MemoryEntry{}
	dynamic := []store.MemoryEntry{}
	others := []store.MemoryEntry{}
	for _, entry := range entries {
		switch entry.SourceKind {
		case "knowledge_fixed":
			fixed = append(fixed, entry)
		case "knowledge_dynamic":
			dynamic = append(dynamic, entry)
		default:
			others = append(others, entry)
		}
	}
	render := func(items []store.MemoryEntry, title string) string {
		if len(items) == 0 {
			return ""
		}
		lines := []string{title}
		for _, entry := range items {
			prefix := ""
			if entry.Title != "" {
				prefix = entry.Title + ": "
			}
			reason := ""
			if entry.RecallReason != "" {
				reason = " [" + entry.RecallReason + "]"
			}
			lines = append(lines, prefix+entry.Content+reason)
		}
		return strings.Join(lines, "\n")
	}
	sections := []string{}
	for _, item := range []string{
		render(fixed, "【固定知识】"),
		render(dynamic, "【动态知识】"),
		render(others, "【其他召回】"),
	} {
		if item != "" {
			sections = append(sections, item)
		}
	}
	if len(sections) == 0 {
		return ""
	}
	r.logger.Printf("[记忆] 召回 %d 条（固定 %d / 动态 %d / 其他 %d）", len(entries), len(fixed), len(dynamic), len(others))
	return strings.Join(append([]string{"【数据库召回】"}, sections...), "\n\n")
}

// namespaceOptions 按 sessionMode 计算记忆命名空间（对齐 Node ensureMemoryNamespace 的用法）。
func (r *Runtime) namespaceOptions(sessionKey string) store.NamespaceOptions {
	character := r.characterName()
	mode := r.document.String("chat.sessionMode")
	switch mode {
	case "global_shared":
		return store.NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: character}
	case "group_shared":
		return store.NamespaceOptions{ScopeType: "group_shared", ScopeKey: sessionKey, CharacterName: character}
	case "group_user":
		return store.NamespaceOptions{ScopeType: "group_user", ScopeKey: sessionKey, CharacterName: character}
	default:
		return store.NamespaceOptions{ScopeType: "user_persistent", ScopeKey: sessionKey, CharacterName: character}
	}
}

// characterName 返回当前角色名（bindings.global.character 优先，回退 chat.defaultCharacter）。
func (r *Runtime) characterName() string {
	name := r.document.String("bindings.global.character")
	if name == "" {
		name = r.document.String("chat.defaultCharacter")
	}
	return name
}

// characterSegments 读取角色卡描述/性格/场景并渲染为系统段。
func (r *Runtime) characterSegments() []string {
	name := r.characterName()
	if name == "" {
		return nil
	}
	data, err := characters.Read(r.dataDir(), name)
	if err != nil || data == nil {
		return nil
	}
	segments := []string{}
	if description := strings.TrimSpace(stringValue(data["description"])); description != "" {
		segments = append(segments, "【角色描述】\n"+description)
	}
	displayName := strings.TrimSpace(stringValue(data["name"]))
	if displayName == "" {
		displayName = name
	}
	if personality := strings.TrimSpace(stringValue(data["personality"])); personality != "" {
		segments = append(segments, "【"+displayName+"的性格】\n"+personality)
	}
	if scenario := strings.TrimSpace(stringValue(data["scenario"])); scenario != "" {
		segments = append(segments, "【场景】\n"+scenario)
	}
	return segments
}

// dataDir 解析数据目录（chat.dataDir 优先，默认 <root>/data）。
func (r *Runtime) dataDir() string {
	configured := r.document.String("chat.dataDir")
	if configured == "" {
		return filepath.Join(r.rootDir, "data")
	}
	if filepath.IsAbs(configured) {
		return configured
	}
	return filepath.Join(r.rootDir, configured)
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

// maybeSummarize 触发会话摘要并把结果写入摘要索引（对齐 Node maybeSummarizeSession +
// upsertSummaryIndexFromSummary）。AI 摘要失败自动回退规则摘要。
func (r *Runtime) maybeSummarize(sessionKey string) {
	if r.memory == nil {
		return
	}
	config := r.summaryConfig()
	summary, err := r.memory.MaybeSummarizeSession(sessionKey, config, r.summarySummarizer())
	if err != nil {
		r.logger.Printf("[摘要] 生成失败: %v", err)
		return
	}
	if summary == nil {
		return
	}
	r.logger.Printf("[摘要] 已生成 %s（来源 %d 条）", summary.ID, summary.SourceCount)
	if _, err := r.memory.AddSummaryIndexEntry(r.namespaceOptions(sessionKey), store.SummaryEntry{
		SourceSummaryID: summary.ID,
		SourceSessionID: summary.SessionID,
		Outline:         summary.Content,
		Keywords:        store.BuildKeywordsFromText(summary.Content, 12),
		Metadata:        map[string]any{"source": "summary"},
	}); err != nil {
		r.logger.Printf("[摘要] 写入摘要索引失败: %v", err)
	}
}

// summaryConfig 解析 memory.summary 配置。
func (r *Runtime) summaryConfig() store.SummaryConfig {
	raw := map[string]any{}
	if err := json.Unmarshal(r.document.Raw(), &raw); err != nil {
		return store.SummaryConfig{}
	}
	memory, _ := raw["memory"].(map[string]any)
	if memory == nil {
		return store.SummaryConfig{}
	}
	summary, _ := memory["summary"].(map[string]any)
	if summary == nil {
		return store.SummaryConfig{}
	}
	return store.NormalizeSummaryConfig(summary)
}

// summarySummarizer 构造 AI 摘要回调（对齐 Node aiClient.summarize +
// buildAIOverridesFromProviderSelection 的 memory.summary 供应商选择）。
func (r *Runtime) summarySummarizer() store.SummarizerFunc {
	return func(source []store.Message, sessionID string, previous []store.Summary) (string, error) {
		provider := r.resolveSummaryProvider()
		client := r.ai
		if provider != nil {
			client = ai.New(*provider)
		}
		lines := make([]string, 0, len(source))
		for _, message := range source {
			lines = append(lines, "["+message.Role+"] "+message.Content)
		}
		messages := []ai.Message{
			{Role: "system", Content: "请将以下对话压缩成简洁的长期记忆摘要。保留人物关系、关键事实、未完成事项、情绪变化和设定，不要编造。输出简体中文纯文本。"},
			{Role: "user", Content: fmt.Sprintf("会话ID: %s\n\n对话内容:\n%s", sessionID, strings.Join(lines, "\n"))},
		}
		result, err := client.Chat(context.Background(), messages, nil)
		if err != nil {
			return "", err
		}
		return result.Content, nil
	}
}

// resolveSummaryProvider 解析摘要专用供应商（对齐 Node buildAIOverridesFromProviderSelection：
// memory.summary.modelProviderId → chat.modelProviderId → ai.activeProviderId）。
func (r *Runtime) resolveSummaryProvider() *ai.Provider {
	document := r.document
	providerID := strings.TrimSpace(document.String("memory.summary.modelProviderId"))
	if providerID == "" {
		providerID = strings.TrimSpace(document.String("chat.modelProviderId"))
	}
	if providerID == "" {
		providerID = strings.TrimSpace(document.String("ai.activeProviderId"))
	}
	summaryModel := strings.TrimSpace(document.String("memory.summary.model"))
	if providerID == "" && summaryModel == "" {
		return nil
	}
	raw := map[string]any{}
	if err := json.Unmarshal(document.Raw(), &raw); err != nil {
		return nil
	}
	aiSection, _ := raw["ai"].(map[string]any)
	if aiSection == nil {
		return nil
	}
	providers, _ := aiSection["providers"].([]any)
	var matched map[string]any
	for _, item := range providers {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		if strings.TrimSpace(stringValue(entry["id"])) == providerID {
			matched = entry
			break
		}
	}
	resolved := ai.Provider{}
	if matched != nil {
		resolved.BaseURL = strings.TrimSpace(stringValue(matched["baseUrl"]))
		resolved.APIKey = strings.TrimSpace(stringValue(matched["apiKey"]))
		resolved.Model = strings.TrimSpace(stringValue(matched["model"]))
	}
	if resolved.Model == "" {
		resolved.Model = summaryModel
	}
	if resolved.BaseURL == "" {
		// 无匹配供应商但显式指定了 providerId：对齐 Node 置空防串 Key
		return nil
	}
	timeoutMs := document.Int("ai.timeout", 60000)
	if timeoutMs < 1000 {
		timeoutMs = 60000
	}
	resolved.Timeout = time.Duration(timeoutMs) * time.Millisecond
	return &resolved
}

// contextFlag 读取 context.<key>（默认 true，对齐 Node contextConfig 的 !== false 语义）。
func (r *Runtime) contextFlag(key string) bool {
	if !r.document.Exists("context." + key) {
		return true
	}
	return r.document.Bool("context." + key)
}

// buildSituationalContext 组装会话上下文段（对齐 Node buildSituationalContext 可用子集：
// 会话感知 + 参与者 + 最近用户意图；画像/引用上下文依赖运行时状态，Go 版暂缺数据源）。
func (r *Runtime) buildSituationalContext(sessionKey string, history []store.Message, messageType string) string {
	if !r.contextFlag("enabled") {
		return ""
	}
	sections := []string{}
	if r.contextFlag("includeSessionFacts") {
		facts := []string{"会话ID: " + sessionKey}
		if messageType != "" {
			facts = append(facts, "会话类型: "+messageType)
		}
		sections = append(sections, "【会话感知】\n"+strings.Join(facts, " | "))
	}
	if r.contextFlag("includeRecentUserIntent") {
		recent := []string{}
		for index := len(history) - 1; index >= 0 && len(recent) < 3; index -= 1 {
			if history[index].Role == "user" {
				recent = append([]string{history[index].Content}, recent...)
			}
		}
	}
	return strings.Join(sections, "\n\n")
}

// guardrailEnabled 读取 security.inputGuardrailEnabled（对齐 Node === true 语义，默认关）。
func (r *Runtime) guardrailEnabled() bool {
	return r.document.Bool("security.inputGuardrailEnabled")
}

// humanChatControlPrompt 读取人类群聊决策规则（对齐 Node humanChatControlConfig）。
func (r *Runtime) humanChatControlPrompt() string {
	if r.document.Exists("chat.humanChatControlEnabled") && !r.document.Bool("chat.humanChatControlEnabled") {
		return ""
	}
	prompt := strings.TrimSpace(r.document.String("chat.humanChatControlPrompt"))
	return prompt
}
