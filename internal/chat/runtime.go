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
	"mimirlink/internal/music"
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
	GetMsg(messageID string) (map[string]any, error)
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
	// AIProvider 由 bot 注入：配置热加载后按新配置重新解析供应商/模型，
	// 使面板修改模型、Base URL、Key 后无需重启 bot（对齐 Node 的 applyRuntimeConfig）。
	AIProvider func() (ai.Provider, error)
}

// Runtime 处理单条 OneBot 事件。
type Runtime struct {
	document       *config.Document
	memory         *store.DB
	ai             ChatModel
	aiProvider     func() (ai.Provider, error)
	aiSignature    string
	configGen      uint64
	bot            Bot
	tools          *tools.Registry
	logger         *log.Logger
	historySize    int
	rootDir        string
	regexProc      *regexProcessor
	focusSegment   string
	repeatDetector *GroupRepeatDetector
	seenMessageIDs map[string]time.Time
	// 消息聚合状态（对齐 Node 连发合并）
	aggregateCount  int
	aggregateReason string
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
		document:       options.Document,
		memory:         options.Memory,
		ai:             options.AI,
		aiProvider:     options.AIProvider,
		bot:            options.Bot,
		tools:          options.Tools,
		logger:         logger,
		historySize:    historySize,
		rootDir:        options.RootDir,
		regexProc:      newRegexProcessor(options.Document.Raw()),
		repeatDetector: NewGroupRepeatDetector(),
		seenMessageIDs: map[string]time.Time{},
	}
}

// HandleEvent 处理一条事件；返回是否产生了回复。
// llmEnabled 读取 LLM 总开关（对齐 Node：config.runtime.llmEnabled !== false，默认开启）。
func (r *Runtime) llmEnabled() bool {
	if r.document == nil {
		return true
	}
	if !r.document.Exists("runtime.llmEnabled") {
		return true
	}
	return r.document.Bool("runtime.llmEnabled")
}

// refreshDerivedState 在配置热加载后重建依赖配置的派生状态
// （正则处理器与 AI 客户端），使面板改配置无需重启 bot。
func (r *Runtime) refreshDerivedState() {
	if r.document == nil {
		return
	}
	generation := r.document.Generation()
	if generation == r.configGen {
		return
	}
	r.configGen = generation
	r.regexProc = newRegexProcessor(r.document.Raw())
	r.logger.Printf("[配置] 检测到配置更新，已重建正则规则与运行时派生状态")
	r.refreshAIClient()
}

// refreshAIClient 按当前配置重新解析 AI 供应商；签名变化时替换客户端。
func (r *Runtime) refreshAIClient() {
	if r.aiProvider == nil {
		return
	}
	provider, err := r.aiProvider()
	if err != nil {
		r.logger.Printf("[配置] 重新解析 AI 供应商失败，沿用旧客户端: %v", err)
		return
	}
	signature := strings.Join([]string{provider.ID, provider.BaseURL, provider.APIKey, provider.Model, provider.Timeout.String()}, "|")
	if r.aiSignature == signature && r.ai != nil {
		return
	}
	r.aiSignature = signature
	r.ai = ai.New(provider)
	r.logger.Printf("[配置] AI 供应商已更新: %s / %s", orDefaultString(provider.ID, "默认"), provider.Model)
}

func (r *Runtime) HandleEvent(event map[string]any) bool {
	r.refreshDerivedState()
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

	// 消息幂等去重（对齐 Node runtime.js 的去重职责：同一 message_id 只处理一次）
	if messageID := idField(event, "message_id"); messageID != "" {
		now := time.Now()
		if lastAt, seen := r.seenMessageIDs[messageID]; seen && now.Sub(lastAt) < 10*time.Minute {
			return false
		}
		// 顺带清理过期表项
		if len(r.seenMessageIDs) > 1024 {
			for key, lastAt := range r.seenMessageIDs {
				if now.Sub(lastAt) >= 10*time.Minute {
					delete(r.seenMessageIDs, key)
				}
			}
		}
		r.seenMessageIDs[messageID] = now
	}

	segments := messageSegments(event["message"])
	text := r.renderSegments(segments)
	text = strings.TrimSpace(text)
	if text == "" {
		return false
	}

	// 管理员戳一戳命令（对齐 Node executeAdminPokeCommand：命中即返回，早于 LLM）
	if r.maybeHandleAdminPokeCommand(event, messageType, groupID, userID, text) {
		return true
	}

	// 点歌指令：独立于 LLM 的能力，命中即返回（对齐 Node handleMusicCommand）
	if r.tryHandleMusicCommand(event, messageType, groupID, userID, text) {
		return true
	}

	// LLM 开关（对齐 Node：`if (!llmEnabled) return;` —— 关闭时不处理任何消息，
	// 也不写入历史；音乐等独立能力在此之前已处理）
	if !r.llmEnabled() {
		r.logger.Printf("[聊天] LLM 已关闭（runtime.llmEnabled=false），忽略消息 [%s]", messageType)
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
	// 引用消息解析（对齐 Node buildReplyInfo：snippet 前置 + 事件头扩展字段）
	replyInfo := r.buildReplyInfo(event, messageSegments(event["message"]))
	if replyInfo.Snippet != "" {
		text = applyReplySnippet(text, replyInfo)
	}
	header := r.standardEventHeader(event, messageType, groupID, userID, replyInfo)
	content := strings.TrimSpace(header + " " + text)
	// 输入阶段正则（对齐 Node regexProcessor.processInput）
	content = r.regexProc.process(content, "input", 0)
	isAtBotSelf := containsAtSelf(event["message"], selfID)

	if err := r.appendMessage(sessionKey, "user", content, map[string]any{
		"messageType": messageType,
		"userId":      userID,
		"groupId":     groupID,
		"messageId":   idField(event, "message_id"),
	}); err != nil {
		r.logger.Printf("[聊天] 写入用户消息失败: %v", err)
	}

	// 图片输入链路（对齐 Node prepareImageInput：direct/caption/placeholder + 三级降级）
	var pendingImageParts []map[string]any
	imageDataList := extractImageSegments(event["message"])
	if len(imageDataList) > 0 {
		imageInput, imageErr := r.prepareImageInput(imageDataList)
		if imageErr != nil {
			if _, isImageError := imageErr.(*ImageInputError); isImageError {
				r.logger.Printf("[图片] 本轮图片处理失败 [%s]: %v", sessionKey, imageErr)
				if err := r.dispatch(messageType, groupID, userID, event, "⚠️ "+imageErr.Error()); err != nil {
					r.logger.Printf("[图片] 错误提示发送失败: %v", err)
				}
				return true
			}
			return false
		}
		if (imageInput.Mode == "caption" || imageInput.Mode == "placeholder") && imageInput.CaptionText != "" {
			// 转述文本并入本轮输入（Node 再经 sanitizeForInjection；Go 的输入正则已覆盖等价清理）
			content = content + "\\n\\n" + imageInput.CaptionText
			r.appendMessage(sessionKey, "user", imageInput.CaptionText, map[string]any{"imageCaption": true})
		}
		for _, warning := range imageInput.Warnings {
			r.logger.Printf("[图片] %s", warning)
		}
		if imageInput.Mode == "direct" {
			pendingImageParts = imageInput.ImageParts
		}
	}

	// 回复前摘要检查（对齐 Node summaryBeforeReply）
	r.maybeSummarize(sessionKey)

	// 群复读检测（对齐 Node group-repeat：命中直发复读文本并跳过 LLM）
	repeatConfig := NormalizeGroupRepeatConfig(rawMapField(r.document, "chat.groupRepeat"))
	if repeatResult := r.repeatDetector.ObserveMessage(repeatConfig, event, text, selfID, time.Now()); repeatResult.ShouldRepeat {
		r.logger.Printf("[复读] 命中群聊复读直发（%d/%d）：%s", repeatResult.Count, repeatResult.TriggerCount, repeatResult.RepeatText)
		if err := r.appendMessage(sessionKey, "assistant", repeatResult.RepeatText, map[string]any{
			"messageType": messageType, "generatedBy": "group_repeat",
		}); err != nil {
			r.logger.Printf("[复读] 写入复读消息失败: %v", err)
		}
		if err := r.bot.SendGroupMessage(groupID, []map[string]any{{"type": "text", "data": map[string]any{"text": repeatResult.RepeatText}}}); err != nil {
			r.logger.Printf("[复读] 发送复读失败: %v", err)
		}
		return true
	}
	// 当前消息决策段（对齐 Node current-message-focus，order 129：preSystem 之后）
	r.focusSegment = r.currentMessageFocusSegment(event, text, messageType, isAtBotSelf, replyInfo)
	messages, worldBookEntries, err := r.buildMessages(sessionKey, content, messageType, injectionRisk)
	if err != nil {
		r.logger.Printf("[聊天] 构建上下文失败: %v", err)
		return false
	}
	// 变量桥接（对齐 Node index.js 3393 段）：静态 setvar → 新用户初始化 → 宏解析 → 状态块注入
	r.applyVariableBridgeToMessages(&messages, sessionKey, userID)
	// direct 模式：图片段并入最后一条用户消息（对齐 Node attachImageParts）
	if len(pendingImageParts) > 0 {
		if attachErr := attachImageParts(messages, pendingImageParts); attachErr != nil {
			r.logger.Printf("[图片] 图片段附加失败: %v", attachErr)
		}
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
	if err != nil {
		r.logger.Printf("[聊天] AI 调用失败: %v", err)
		return false
	}
	if reply == "" {
		r.logger.Printf("[聊天] 模型返回空回复")
		return false
	}
	r.logger.Printf("[聊天] AI 回复 %d 字，用时 %dms", len([]rune(reply)), time.Since(startedAt).Milliseconds())

	// 变量桥接后处理（对齐 Node index.js 3562 段）：
	// UpdateVariable 提取应用 → <content> 可见内容 → 输出正则 → 内部标签剥离
	varScope := r.variableScope(sessionKey, userID)
	extraction := r.extractAndApplyVariables(reply, varScope)
	if len(extraction.Applied) > 0 {
		r.logger.Printf("[变量] 已应用 %d 个补丁", len(extraction.Applied))
	} else if extraction.ProtocolPresent {
		r.logger.Printf("[变量] 主回复含有效 UpdateVariable（空更新），跳过额外模型解析")
	}
	visibleReply := extractVisibleContent(extraction.CleanedOutput)
	reply = r.regexProc.process(visibleReply, "output", 0)
	stripped := stripInternalTags(reply)
	if len([]rune(stripped)) != len([]rune(reply)) {
		r.logger.Printf("[清洗] 标签剥离: %d→%d 字", len([]rune(reply)), len([]rune(stripped)))
	}
	reply = stripped

	// 额外模型变量解析（未配置 varparseModel 时跳过）
	if extraction.ProtocolPresent == false {
		r.maybeParseVariablesAsync(sessionKey, varScope, content, reply)
	}

	// 链式泄露检测与重试（对齐 Node detectChainLeak + chat.chainLeakRetry）
	if retried, didRetry := r.retryOnChainLeak(context.Background(), messages, reply, content); didRetry {
		reply = retried
	}

	if err := r.appendMessage(sessionKey, "assistant", reply, map[string]any{"messageType": messageType}); err != nil {
		r.logger.Printf("[聊天] 写入回复失败: %v", err)
	}

	// 回复分发（对齐 Node dispatchReply：引用/at 前缀、splitMessage 分段、[voice] TTS、段间延迟）
	if err := r.dispatchReply(event, messageType, groupID, userID, reply, r.loadDispatcherConfig(false), r.ttsManagerIfAvailable()); err != nil {
		r.logger.Printf("[聊天] 发送回复失败: %v", err)
		return false
	}
	// 回复后异步人物档案构建（对齐 Node maybeBuildParticipantProfile 的 auto 触发）
	speakerName := ""
	if sender, ok := event["sender"].(map[string]any); ok {
		speakerName = stringValue(sender["nickname"])
		if card := stringValue(sender["card"]); card != "" {
			speakerName = card
		}
	}
	r.maybeBuildParticipantProfile(sessionKey, userID, speakerName, messageType, groupID)
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
	partition := partitionPromptItems(resolvePresetResolution(r.document, r.characterName()).Preset)
	for _, item := range partition.PreSystem {
		messages = append(messages, ai.Message{Role: "system", Content: item.Content})
	}
	// 当前消息决策段（对齐 Node current-message-focus，order 129：preSystem 之后）
	if r.focusSegment != "" {
		messages = append(messages, ai.Message{Role: "system", Content: r.focusSegment})
		r.focusSegment = ""
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
func (r *Runtime) recallOptions() store.RecallOptions { return recallOptionsFor(r.document) }

// recallOptionsFor 读取召回参数（运行时与靶场/预览共用）。
func recallOptionsFor(document *config.Document) store.RecallOptions {
	options := store.DefaultRecallOptions
	if value := document.Int("memory.recall.limit", 0); value > 0 {
		options.Limit = int(value)
	}
	if value := document.Int("memory.recall.searchLimit", 0); value > 0 {
		options.SearchLimit = int(value)
	}
	if value := document.Int("memory.recall.recentLimit", 0); value > 0 {
		options.RecentLimit = int(value)
	}
	if value := document.Int("memory.recall.summaryLimit", 0); value > 0 {
		options.SummaryLimit = int(value)
	}
	return options
}

// recallSection 渲染数据库召回文本段（与 Node prompt.js 的 database_recall 段一致）。
func (r *Runtime) recallSection(sessionKey string, query string) string {
	return recallSectionFor(r.memory, r.document, r.characterName(), sessionKey, query, r.logger)
}

// recallSectionFor 数据库召回段落（运行时与靶场/预览共用）。
func recallSectionFor(memory *store.DB, document *config.Document, character string, sessionKey string, query string, logger *log.Logger) string {
	if memory == nil {
		return ""
	}
	namespace := namespaceOptionsFor(document, character, sessionKey)
	entries, err := memory.RecallMemory(namespace, query, recallOptionsFor(document))
	if err != nil {
		if logger != nil {
			logger.Printf("[记忆] 召回失败: %v", err)
		}
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
	if logger != nil {
		logger.Printf("[记忆] 召回 %d 条（固定 %d / 动态 %d / 其他 %d）", len(entries), len(fixed), len(dynamic), len(others))
	}
	return strings.Join(append([]string{"【数据库召回】"}, sections...), "\n\n")
}

// namespaceOptions 按 sessionMode 计算记忆命名空间（对齐 Node ensureMemoryNamespace 的用法）。
func (r *Runtime) namespaceOptions(sessionKey string) store.NamespaceOptions {
	return namespaceOptionsFor(r.document, r.characterName(), sessionKey)
}

// namespaceOptionsFor 计算会话命名空间（运行时与靶场/预览共用）。
func namespaceOptionsFor(document *config.Document, character string, sessionKey string) store.NamespaceOptions {
	mode := document.String("chat.sessionMode")
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
	return r.renderSegmentsAt(segments, 0, map[string]bool{})
}

// forwardMaxNodes/forwardMaxChars 对齐 Node forward-message.js 的默认预算（每层）。
const (
	forwardMaxNodes = 30
	forwardMaxChars = 2500
)

func (r *Runtime) forwardMaxDepth() int {
	depth := int(r.document.Int("chat.forwardMaxDepth", 3))
	if depth < 1 {
		depth = 1
	}
	return depth
}

func (r *Runtime) renderSegmentsAt(segments []map[string]any, depth int, visited map[string]bool) string {
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
			builder.WriteString(r.renderForwardAt(stringValue(data["id"]), depth, visited))
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

// renderForward 拉取并渲染合并转发内容（与 Node 版 transcript 形状一致；支持多层嵌套展开）。
func (r *Runtime) renderForward(forwardID string) string {
	return r.renderForwardAt(forwardID, 0, map[string]bool{})
}

// renderForwardAt 展开合并转发：depth 超过上限或循环引用时退化为占位符，
// 嵌套子转发继续递归拉取（chat.forwardMaxDepth 控制层数，默认 3）。
func (r *Runtime) renderForwardAt(forwardID string, depth int, visited map[string]bool) string {
	if forwardID == "" {
		return "[合并转发聊天记录|缺少 id]"
	}
	if visited[forwardID] {
		return "[嵌套合并转发聊天记录|循环引用]"
	}
	maxDepth := r.forwardMaxDepth()
	if depth >= maxDepth {
		return "[嵌套合并转发聊天记录]"
	}
	visited[forwardID] = true
	defer delete(visited, forwardID)
	payload, err := r.bot.GetForwardMsg(forwardID)
	if err != nil {
		return "[合并转发聊天记录|读取失败:" + err.Error() + "]"
	}
	nodes := normalizeForwardNodes(payload)
	if len(nodes) == 0 {
		return "[合并转发聊天记录|内容为空]"
	}
	shown := nodes
	truncated := false
	if len(shown) > forwardMaxNodes {
		shown = shown[:forwardMaxNodes]
		truncated = true
	}
	lines := make([]string, 0, len(shown))
	imageCount := 0
	totalChars := 0
	for index, node := range shown {
		text := strings.TrimSpace(r.renderSegmentsAt(node.segments, depth+1, visited))
		for _, segment := range node.segments {
			if stringValue(segment["type"]) == "image" {
				imageCount += 1
			}
		}
		line := fmt.Sprintf("%d. %s: %s", index+1, node.name, text)
		if totalChars+len(line) > forwardMaxChars {
			truncated = true
			break
		}
		lines = append(lines, line)
		totalChars += len(line)
	}
	if truncated {
		lines = append(lines, fmt.Sprintf("…（共 %d 条，已截断）", len(nodes)))
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
func (r *Runtime) contextFlag(key string) bool { return contextFlagFor(r.document, nil, key) }

// contextFlagFor 读取上下文注入开关（缺省开启，对齐 Node）。
// overrides 非空时优先（靶场单次测试的 contextConfig 覆盖）。
func contextFlagFor(document *config.Document, overrides map[string]bool, key string) bool {
	if overrides != nil {
		if value, ok := overrides[key]; ok {
			return value
		}
	}
	if document == nil {
		return true
	}
	if !document.Exists("context." + key) {
		return true
	}
	return document.Bool("context." + key)
}

// buildSituationalContext 组装会话上下文段（对齐 Node buildSituationalContext 可用子集：
// 会话感知 + 参与者 + 最近用户意图；画像/引用上下文依赖运行时状态，Go 版暂缺数据源）。
func (r *Runtime) buildSituationalContext(sessionKey string, history []store.Message, messageType string) string {
	return situationalContextFor(r.document, SituationalInput{
		SessionKey:    sessionKey,
		MessageType:   messageType,
		History:       history,
		MessageCount:  r.pendingMessageCount(),
		TriggerReason: r.pendingTriggerReason(),
	})
}

// SituationalInput 是情境感知段落的输入（字段与 Node runtimeContext 对齐）。
type SituationalInput struct {
	SessionKey     string
	MessageType    string
	MessageCount   int
	TriggerReason  string
	Participants   []string
	SpeakerProfile string
	ReplyReference string
	History        []store.Message
	Overrides      map[string]bool
}

// situationalContextFor 生成情境感知段落（运行时与靶场/预览共用，
// 段序与文案对齐 Node buildSituationalContext）。
func situationalContextFor(document *config.Document, input SituationalInput) string {
	if !contextFlagFor(document, input.Overrides, "enabled") {
		return ""
	}
	sections := []string{}
	if contextFlagFor(document, input.Overrides, "includeSessionFacts") {
		facts := []string{}
		if input.SessionKey != "" {
			facts = append(facts, "会话ID: "+input.SessionKey)
		}
		if input.MessageType != "" {
			facts = append(facts, "会话类型: "+input.MessageType)
		}
		if input.MessageCount > 0 {
			facts = append(facts, "本次聚合消息数: "+itoa(input.MessageCount))
		}
		if input.TriggerReason != "" {
			facts = append(facts, "触发原因: "+input.TriggerReason)
		}
		if len(facts) > 0 {
			sections = append(sections, "【会话感知】\n"+strings.Join(facts, " | "))
		}
	}
	if contextFlagFor(document, input.Overrides, "includeParticipants") && len(input.Participants) > 0 {
		sections = append(sections, "【参与者】\n"+strings.Join(input.Participants, " | "))
	}
	if profile := strings.TrimSpace(input.SpeakerProfile); profile != "" {
		sections = append(sections, "【当前发言人画像】\n"+profile)
	}
	if contextFlagFor(document, input.Overrides, "includeReplyReference") {
		if reference := strings.TrimSpace(input.ReplyReference); reference != "" {
			sections = append(sections, "【引用上下文】\n"+reference)
		}
	}
	if contextFlagFor(document, input.Overrides, "includeRecentUserIntent") {
		recent := []string{}
		for index := len(input.History) - 1; index >= 0 && len(recent) < 3; index -= 1 {
			if input.History[index].Role == "user" {
				recent = append([]string{input.History[index].Content}, recent...)
			}
		}
		if len(recent) > 0 {
			sections = append(sections, "【最近用户意图】\n"+strings.Join(recent, "\n"))
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

// participantProfileConfig 解析 memory.participantProfile 配置（对齐 Node getParticipantProfileConfig 核心字段）。
func (r *Runtime) participantProfileConfig() (enabled bool, threshold int, sourceLimit int, analysisMode string, blacklist map[string]bool) {
	blacklist = map[string]bool{}
	enabled = r.document.Bool("memory.participantProfile.enabled")
	threshold = int(r.document.Int("memory.participantProfile.triggerMessages", 8))
	if threshold < 1 {
		threshold = 8
	}
	sourceLimit = int(r.document.Int("memory.participantProfile.maxSourceMessages", 50))
	if sourceLimit < 1 {
		sourceLimit = 50
	}
	analysisMode = strings.TrimSpace(r.document.String("memory.participantProfile.analysisMode"))
	if analysisMode == "" {
		analysisMode = "all_context"
	}
	for _, item := range r.document.Get("memory.participantProfile.blacklistParticipantIds").Array() {
		if id := strings.TrimSpace(item.String()); id != "" {
			blacklist[id] = true
		}
	}
	return enabled, threshold, sourceLimit, analysisMode, blacklist
}

// maybeBuildParticipantProfile 异步构建人物档案：阈值检查 → AI 生成 → 写入档案条目。
// 失败只记日志，不影响聊天主链路（对齐 Node 异步任务语义）。
func (r *Runtime) maybeBuildParticipantProfile(sessionKey string, participantID string, participantName string, messageType string, groupID string) {
	if r.memory == nil || participantID == "" {
		return
	}
	enabled, threshold, sourceLimit, analysisMode, blacklist := r.participantProfileConfig()
	if !enabled || blacklist[participantID] {
		return
	}
	namespace := r.namespaceOptions(sessionKey)
	sourceFilter := "all"
	if analysisMode == "bot_only_messages" || analysisMode == "bot_only_profile" {
		sourceFilter = "bot_only"
	}
	go func() {
		source, err := r.memory.CollectParticipantProfileSource(participantID, namespace, store.ProfileSourceConfig{
			Threshold: threshold, Limit: sourceLimit, SourceFilter: sourceFilter,
		})
		if err != nil {
			r.logger.Printf("[档案] 采集源消息失败: %v", err)
			return
		}
		if len(source.Messages) == 0 || (!source.HasEnoughNewInfo && source.Existing != nil) {
			return
		}
		if source.HasEnoughNewInfo == false && source.Existing == nil {
			r.logger.Printf("[档案] 新信息不足，跳过建档（%s 阈值 %d）", participantID, threshold)
			return
		}
		profileText, err := r.generateParticipantProfile(source, participantID, participantName, analysisMode)
		if err != nil {
			r.logger.Printf("[档案] 生成失败 (%s): %v", participantID, err)
			return
		}
		title := participantName
		if title == "" {
			title = participantID
		}
		metadata := map[string]any{
			"messageType":            messageType,
			"groupId":                groupID,
			"lastProcessedMessageAt": source.LastProcessedAt,
		}
		entryID := ""
		if source.Existing != nil {
			entryID = source.Existing.ID
		}
		savedID, err := r.memory.SaveParticipantProfile(namespace, entryID, participantID, title, profileText, []string{}, metadata, source.Messages[len(source.Messages)-1].SessionID)
		if err != nil {
			r.logger.Printf("[档案] 保存失败 (%s): %v", participantID, err)
			return
		}
		r.logger.Printf("[档案] 已保存 %s → %s（来源 %d 条）", participantID, savedID, len(source.Messages))
	}()
}

// generateParticipantProfile 调用 AI 生成档案文本（对齐 Node buildParticipantProfilePrompt 归因硬约束）。
func (r *Runtime) generateParticipantProfile(source *store.ProfileSource, participantID string, participantName string, analysisMode string) (string, error) {
	targetName := participantName
	if targetName == "" {
		targetName = participantID
	}
	lines := make([]string, 0, len(source.Messages))
	for _, message := range source.Messages {
		speaker := "第三者"
		switch {
		case message.Role == "assistant":
			speaker = "Bot"
		case messageMetadataUserID(message) == participantID:
			speaker = targetName
		}
		lines = append(lines, fmt.Sprintf("[%s] %s", speaker, message.Content))
	}
	existingSection := ""
	if source.Existing != nil && strings.TrimSpace(source.Existing.Content) != "" {
		existingSection = "\n\n【现有档案（增量更新基础）】\n" + source.Existing.Content
	}
	prompt := fmt.Sprintf(`请基于以下真实聊天内容增量更新人物档案。
目标人物：%s（QQ:%s）

归因硬约束：
1. 档案只描述目标人物：%s（QQ:%s）。
2. 必须把说话人掰开：目标人物 / Bot / 第三者；不得把 Bot 或第三者的话写成目标人物说的。
3. 目标人物的稳定画像与当前状态，只能依据"说话人=%s"的本人发言归纳。
4. Bot 与第三者内容可以用于理解语境，但禁止写入成目标人物自己的表达。
5. 不要臆测未出现的信息；冲突时宁可写不确定或省略。

新增消息如下：
%s%s`, targetName, participantID, targetName, participantID, targetName, strings.Join(lines, "\n"), existingSection)

	client := r.ai
	if provider := r.resolveSummaryProvider(); provider != nil {
		client = ai.New(*provider)
	}
	result, err := client.Chat(context.Background(), []ai.Message{
		{Role: "system", Content: "你是人物档案分析器。只输出档案正文，不要输出多余解释。"},
		{Role: "user", Content: prompt},
	}, nil)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(result.Content), nil
}

// messageMetadataUserID 提取消息 metadata.userId（转发到 store 包实现）。
func messageMetadataUserID(message store.Message) string {
	return store.MessageUserID(message)
}

// tryHandleMusicCommand 处理 /music 点歌指令；未启用或非命令时返回 false 交给 LLM。
func (r *Runtime) tryHandleMusicCommand(event map[string]any, messageType string, groupID string, userID string, plainText string) bool {
	config := music.NormalizeConfig(r.musicConfigRaw())
	handler := &music.Handler{
		Config:     r.musicConfigRaw,
		AudioDir:   filepath.Join(r.dataDir(), "audio"),
		FFmpegPath: r.document.String("ffmpegPath"),
		Warn:       func(message string) { r.logger.Printf("[点歌] %s", message) },
	}
	// 未启用且非命令 → 快速返回（Handler 也会拦截，这里避免无谓构造）
	if !config.Enabled && !strings.HasPrefix(music.StripLeadingMentions(plainText), orDefaultString(config.Command, music.DefaultMusicCommand)) {
		return false
	}
	_ = userID
	senders := music.Senders{
		SendText: func(message string) error {
			return r.dispatch(messageType, groupID, userID, event, message)
		},
		SendVoice: func(audioPath string) error {
			if messageType == "group" {
				return r.sendRecord(groupID, "", audioPath, true)
			}
			return r.sendRecord("", userID, audioPath, false)
		},
		SendFile: func(filePath string, fileName string) error {
			if messageType == "group" {
				return r.sendFile(groupID, "", filePath, fileName, true)
			}
			return r.sendFile("", userID, filePath, fileName, false)
		},
	}
	result := handler.Handle(context.Background(), event, plainText, senders)
	return result.Handled
}

func (r *Runtime) musicConfigRaw() map[string]any {
	raw := map[string]any{}
	if err := json.Unmarshal(r.document.Raw(), &raw); err != nil {
		return raw
	}
	chat, _ := raw["chat"].(map[string]any)
	if chat == nil {
		return raw
	}
	musicRaw, _ := chat["music"].(map[string]any)
	if musicRaw == nil {
		return raw
	}
	return musicRaw
}

func orDefaultString(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// sendRecord 通过 OneBot send_group_record / send_private_record 发送语音。
func (r *Runtime) sendRecord(groupID string, userID string, audioPath string, isGroup bool) error {
	if onebotClient, ok := r.bot.(interface {
		Call(action string, params map[string]any) (json.RawMessage, error)
	}); ok {
		params := map[string]any{"file": audioPath}
		if isGroup {
			params["group_id"] = groupID
			_, err := onebotClient.Call("send_group_record", params)
			return err
		}
		params["user_id"] = userID
		_, err := onebotClient.Call("send_private_record", params)
		return err
	}
	return fmt.Errorf("当前 OneBot 适配器不支持发送语音")
}

// sendFile 通过 OneBot upload_group_file / upload_private_file 发送文件。
func (r *Runtime) sendFile(groupID string, userID string, filePath string, fileName string, isGroup bool) error {
	if onebotClient, ok := r.bot.(interface {
		Call(action string, params map[string]any) (json.RawMessage, error)
	}); ok {
		if isGroup {
			_, err := onebotClient.Call("upload_group_file", map[string]any{"group_id": groupID, "file": filePath, "name": fileName})
			return err
		}
		_, err := onebotClient.Call("upload_private_file", map[string]any{"user_id": userID, "file": filePath, "name": fileName})
		return err
	}
	return fmt.Errorf("当前 OneBot 适配器不支持发送文件")
}

// pendingMessageCount / pendingTriggerReason 供消息聚合（goal-37 第 8 项）使用；
// 未启用聚合时返回零值，情境段落不会输出这两个字段。
func (r *Runtime) pendingMessageCount() int { return r.aggregateCount }

func (r *Runtime) pendingTriggerReason() string { return r.aggregateReason }
