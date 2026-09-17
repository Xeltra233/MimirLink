package chat

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/metrics"
	"mimirlink/internal/tools"
	"mimirlink/internal/tts"
)

// 回复分发与链式泄露检测（对齐 Node src/reply-dispatcher.js +
// src/chain-leak-detection.js + index.js 的 sendReasoningToQQ/思维链提取）。

// voicePart 是 [voice] 标签切分结果。
type voicePart struct {
	Type    string // text | voice
	Content string
}

var voiceTagRegex = regexp.MustCompile(`[\[［]voice[：:]\s*([^\]］]+)[\]］]`)

// ParseVoiceTags 切分 [voice] 标签（兼容全角方括号，对齐 Node parseVoiceTags）。
func ParseVoiceTags(text string) ([]voicePart, bool) {
	parts := []voicePart{}
	hasVoice := false
	lastIndex := 0
	matches := voiceTagRegex.FindAllStringSubmatchIndex(text, -1)
	for _, match := range matches {
		start, end := match[0], match[1]
		if start > lastIndex {
			if before := strings.TrimSpace(text[lastIndex:start]); before != "" {
				parts = append(parts, voicePart{Type: "text", Content: before})
			}
		}
		parts = append(parts, voicePart{Type: "voice", Content: strings.TrimSpace(text[match[2]:match[3]])})
		hasVoice = true
		lastIndex = end
	}
	if lastIndex < len(text) {
		if remaining := strings.TrimSpace(text[lastIndex:]); remaining != "" {
			parts = append(parts, voicePart{Type: "text", Content: remaining})
		}
	}
	return parts, hasVoice
}

// ---------------- 链式泄露检测（对齐 chain-leak-detection.js） ----------------

var (
	englishOrCodeRequestRegex = regexp.MustCompile(`(?i)(英文|英语|英語|English|translate|翻译|翻譯|英译|英譯|中译英|中譯英|输出英文|用英文|英文版|prompt|提示词|提示詞|正则|正規|regex|代码|代碼|code|JSON|SQL|JavaScript|TypeScript|Python|HTML|CSS|bash|shell|PowerShell|脚本|腳本|函数|函式|日志|log|stack trace|traceback)`)
	leakPhraseRegex           = regexp.MustCompile(`(?i)\b(?:I(?:'m| am) (?:currently )?(?:analyzing|analysing|evaluating|reviewing|refining|considering|determining|assessing|focusing|tracking|formulating|crafting|checking|identifying|thinking|trying)|My current focus is|My focus is|I need to (?:analyze|analyse|determine|figure out|decide|craft|formulate|respond|answer|ensure|avoid)|I will (?:analyze|analyse|determine|figure out|decide|craft|formulate|respond|answer)|The user (?:is|wants|asked|seems|appears)|the user's (?:intent|request|message)|I should (?:respond|answer|avoid|ensure|mention|keep|make)|I'll (?:respond|answer|craft|keep|make|avoid|ensure))\b`)
	reasoningKeywordsRegex    = regexp.MustCompile(`(?i)\b(?:analyzing|analysing|evaluating|reviewing|refining|considering|determining|assessing|focusing|tracking|formulating|crafting|context|intent|speaker|response|reply|strategy|prompt|persona|roleplay|conversation|user's request|current message)\b`)
	markdownEnglishHeading    = regexp.MustCompile(`(?m)^\s*\*\*[A-Z][A-Za-z0-9 ,:'’\-()]{5,90}\*\*`)
	fencedCodeRegex           = regexp.MustCompile("```[\\s\\S]*?```")
	codeLineRegex             = regexp.MustCompile(`(?i)^(?:import|export|const|let|var|function|class|def|async function|return|if|else|for|while|try|catch|finally|SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|FROM|WHERE)\b`)
	assignmentLineRegex       = regexp.MustCompile(`^[A-Za-z_$][\w$]*\s*=\s*.+;?$`)
	callLineRegex             = regexp.MustCompile(`^[A-Za-z_$][\w$]*\([^)]*\);?$`)
	jsonKeyLineRegex          = regexp.MustCompile(`^\s*["'][A-Za-z0-9_.-]+["']\s*:`)
	asciiLetterRegex          = regexp.MustCompile(`[A-Za-z]`)
	cjkCharRegex              = regexp.MustCompile(`[\x{3400}-\x{9fff}]`)
	englishWordRegex          = regexp.MustCompile(`[A-Za-z]{3,}`)
)

func looksLikeCode(text string) bool {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return false
	}
	if fencedCodeRegex.MatchString(normalized) {
		return true
	}
	lines := []string{}
	for _, line := range strings.Split(normalized, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	codeLines := 0
	for _, line := range lines {
		isCode := codeLineRegex.MatchString(line) ||
			assignmentLineRegex.MatchString(line) ||
			callLineRegex.MatchString(line) ||
			jsonKeyLineRegex.MatchString(line) ||
			regexp.MustCompile(`^[}\]);]+$`).MatchString(line)
		if isCode {
			codeLines++
		}
	}
	if len(lines) == 0 {
		return false
	}
	return codeLines >= 2 && float64(codeLines)/float64(len(lines)) >= 0.35
}

func englishRatio(text string) float64 {
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return 0
	}
	ascii := len(asciiLetterRegex.FindAllString(normalized, -1))
	cjk := len(cjkCharRegex.FindAllString(normalized, -1))
	total := ascii + cjk
	if total == 0 {
		return 0
	}
	return float64(ascii) / float64(total)
}

// ChainLeakResult 是泄露检测结果。
type ChainLeakResult struct {
	Leaked bool
	Reason string
}

// DetectChainLeak 检测回复是否泄露模型内部分析/英文工作日志。
func DetectChainLeak(rawReply string, visibleReply string, processedReply string, userInput string) ChainLeakResult {
	candidate := strings.Join(nonEmpty([]string{rawReply, visibleReply, processedReply}), "\n\n")
	if strings.TrimSpace(candidate) == "" {
		return ChainLeakResult{Reason: "empty"}
	}
	if englishOrCodeRequestRegex.MatchString(strings.TrimSpace(userInput)) {
		return ChainLeakResult{Reason: "user-requested-english-or-code"}
	}
	if looksLikeCode(candidate) {
		return ChainLeakResult{Reason: "code-like-output"}
	}
	if leakPhraseRegex.MatchString(candidate) {
		return ChainLeakResult{Leaked: true, Reason: "english-reasoning-phrase"}
	}
	if markdownEnglishHeading.MatchString(candidate) && reasoningKeywordsRegex.MatchString(candidate) {
		return ChainLeakResult{Leaked: true, Reason: "english-markdown-reasoning-heading"}
	}
	ratio := englishRatio(candidate)
	words := englishWordRegex.FindAllString(candidate, -1)
	if ratio >= 0.62 && len(words) >= 18 && reasoningKeywordsRegex.MatchString(candidate) {
		return ChainLeakResult{Leaked: true, Reason: "high-english-reasoning-density"}
	}
	return ChainLeakResult{Reason: "no-strong-signal"}
}

// BuildChainLeakRetryMessage 构建重试指令（对齐 Node buildChainLeakRetryMessage）。
func BuildChainLeakRetryMessage(reason string) string {
	suffix := ""
	if reason != "" {
		suffix = fmt.Sprintf(" 检测原因：%s。", reason)
	}
	return strings.Join([]string{
		"上一轮输出疑似把模型内部分析/英文工作日志当成最终回复泄露。请重新生成。",
		suffix,
		"要求：完整输出 <thinking>中文方圆内心独白</thinking>，然后只输出徐缺发到 QQ 的一句正文；不要输出英文分析标题、模型工作日志、字段报告或作者口吻。",
		"如果用户明确要求英文、翻译、prompt 或代码，则按用户要求输出正文，但仍不要输出模型工作日志。",
	}, "")
}

func nonEmpty(values []string) []string {
	result := []string{}
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// ---------------- 回复分发（对齐 reply-dispatcher.js） ----------------

// ttsSynthesizer 是可选的 TTS 合成入口（面板与 bot 共用 Manager）。
type ttsSynthesizer interface {
	Synthesize(ctx context.Context, text string) (string, error)
}

// dispatcherConfig 汇集分发所需配置。
type dispatcherConfig struct {
	SplitMessage         bool
	SegmentDelayMs       int
	ProactiveIntervalMs  int
	QuoteReplyEnabled    bool
	MentionSenderOnReply bool
	SendReasoningToQQ    bool
	ForceSingleMessage   bool
}

func (r *Runtime) loadDispatcherConfig(forceSingleMessage bool) dispatcherConfig {
	splitMessage := true
	if r.document.Exists("chat.splitMessage") {
		splitMessage = r.document.Bool("chat.splitMessage")
	}
	segmentDelay := int(r.document.Int("chat.segmentDelayMs", 300))
	// 对齐 Node：仅缺省时取 max(segmentDelayMs, 1200)；显式配置（含 0）必须尊重。
	proactive := int(r.document.Int("chat.proactiveMessageIntervalMs", 0))
	if !r.document.Exists("chat.proactiveMessageIntervalMs") {
		if segmentDelay < 1200 {
			proactive = 1200
		} else {
			proactive = segmentDelay
		}
	}
	quoteReply := true
	if r.document.Exists("chat.quoteReplyEnabled") {
		quoteReply = r.document.Bool("chat.quoteReplyEnabled")
	}
	mentionSender := true
	if r.document.Exists("chat.mentionSenderOnReply") {
		mentionSender = r.document.Bool("chat.mentionSenderOnReply")
	}
	return dispatcherConfig{
		SplitMessage:         splitMessage && !forceSingleMessage,
		SegmentDelayMs:       segmentDelay,
		ProactiveIntervalMs:  proactive,
		QuoteReplyEnabled:    quoteReply,
		MentionSenderOnReply: mentionSender,
		SendReasoningToQQ:    r.document.Bool("chat.sendReasoningToQQ"),
		ForceSingleMessage:   forceSingleMessage,
	}
}

// ttsManagerIfAvailable 若 TTS 配置启用则返回合成器（bot 进程内按需构建）。
func (r *Runtime) ttsManagerIfAvailable() ttsSynthesizer {
	if !r.document.Bool("tts.enabled") {
		return nil
	}
	manager := tts.NewWithAudioDir(r.AudioDir(), r.logger)
	if manager == nil || !manager.Config().Enabled {
		return nil
	}
	return manager
}

// AudioDir 返回音频目录。
func (r *Runtime) AudioDir() string {
	return r.dataDir() + "/audio"
}

// buildMediaPrefixSegments 构造首条消息前缀段（reply / at，对齐 Node buildMediaPrefixSegments）。
func buildMediaPrefixSegments(messageType string, messageID string, userID string, config dispatcherConfig, hasSentPrimary bool) []map[string]any {
	if hasSentPrimary {
		return nil
	}
	segments := []map[string]any{}
	if config.QuoteReplyEnabled && messageID != "" {
		segments = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": messageID}})
	}
	if messageType == "group" && config.MentionSenderOnReply && userID != "" {
		segments = append(segments, map[string]any{"type": "at", "data": map[string]any{"qq": userID}})
	}
	return segments
}

// dispatchReply 分发最终回复：引用/前缀段、splitMessage 分段、[voice] 标签 TTS、
// 段间延迟（对齐 Node dispatchReply）。
func (r *Runtime) dispatchReply(event map[string]any, messageType string, groupID string, userID string, processedReply string, options dispatcherConfig, ttsManager ttsSynthesizer) error {
	parts, hasVoice := ParseVoiceTags(processedReply)
	hasSentPrimary := false
	messageID := idField(event, "message_id")

	sendText := func(content string) error {
		message := content
		if !hasSentPrimary && messageType == "group" && options.MentionSenderOnReply && userID != "" && !options.QuoteReplyEnabled {
			message = fmt.Sprintf("[CQ:at,qq=%s] ", userID) + content
		}
		segments := buildMediaPrefixSegments(messageType, messageID, userID, options, hasSentPrimary)
		var err error
		if len(segments) > 0 {
			segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": content}})
			if messageType == "group" {
				err = r.bot.SendGroupMessage(groupID, segments)
			} else {
				err = r.bot.SendPrivateMessage(userID, segments)
			}
		} else if messageType == "group" {
			err = r.bot.SendGroupMessage(groupID, []map[string]any{{"type": "text", "data": map[string]any{"text": message}}})
		} else {
			err = r.bot.SendPrivateMessage(userID, []map[string]any{{"type": "text", "data": map[string]any{"text": message}}})
		}
		hasSentPrimary = true
		return err
	}

	sendVoice := func(audioPath string) error {
		// TTS 语音不走「必须 @」策略（对齐 Node：mentionSender=false）
		prefix := buildMediaPrefixSegments(messageType, messageID, userID, dispatcherConfig{
			QuoteReplyEnabled: options.QuoteReplyEnabled, MentionSenderOnReply: false,
		}, hasSentPrimary)
		if len(prefix) > 0 {
			prefix = append(prefix, map[string]any{"type": "record", "data": map[string]any{"file": audioPath}})
			if messageType == "group" {
				hasSentPrimary = true
				return r.bot.SendGroupMessage(groupID, prefix)
			}
			hasSentPrimary = true
			return r.bot.SendPrivateMessage(userID, prefix)
		}
		hasSentPrimary = true
		if messageType == "group" {
			return r.sendRecord(groupID, "", audioPath, true)
		}
		return r.sendRecord("", userID, audioPath, false)
	}

	sendTTSContent := func(content string, explicitVoice bool) error {
		if ttsManager == nil {
			fallback := voiceFallbackText(content, explicitVoice)
			if explicitVoice {
				fallback = fmt.Sprintf("语音内容：%s（当前未启用 TTS，无法发送语音消息）", content)
			}
			return sendText(fallback)
		}
		audioPath, err := ttsManager.Synthesize(context.Background(), content)
		if err != nil {
			r.logger.Printf("[TTS] 合成失败: %v", err)
			return sendText(voiceFallbackText(content, explicitVoice))
		}
		// 仪表盘分桶：TTS 合成事件（对齐 Node reply-dispatcher recordDashboardMetric('tts')）
		r.metrics.Record(metrics.TTS, 1)
		return sendVoice(audioPath)
	}

	for partIndex, part := range parts {
		content := strings.TrimSpace(part.Content)
		switch part.Type {
		case "text":
			// 无 [voice] 标签且 TTS 启用：整段当语音（历史行为）
			if ttsManager != nil && !hasVoice {
				if content != "" {
					if err := sendTTSContent(content, false); err != nil {
						return err
					}
				}
				continue
			}
			segments := []string{content}
			if options.SplitMessage {
				segments = splitParagraphs(content)
			}
			for index, segment := range segments {
				if strings.TrimSpace(segment) == "" {
					continue
				}
				primarySend := !hasSentPrimary
				if err := sendText(segment); err != nil {
					return err
				}
				hasMore := index < len(segments)-1 || partIndex < len(parts)-1
				delay := options.ProactiveIntervalMs
				if primarySend {
					delay = options.SegmentDelayMs
				}
				if hasMore && delay > 0 {
					time.Sleep(time.Duration(delay) * time.Millisecond)
				}
			}
		case "voice":
			if ttsManager != nil {
				if err := sendTTSContent(content, true); err != nil {
					return err
				}
				continue
			}
			// TTS 未启用：可读回退
			if err := sendText(fmt.Sprintf("语音内容：%s（当前未启用 TTS，无法发送语音消息）", content)); err != nil {
				return err
			}
		}
	}
	if len(parts) == 0 {
		return r.dispatch(messageType, groupID, userID, event, processedReply)
	}
	return nil
}

func splitParagraphs(content string) []string {
	result := []string{}
	for _, segment := range regexp.MustCompile(`\n\n+`).Split(content, -1) {
		if trimmed := strings.TrimSpace(segment); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	if len(result) == 0 && strings.TrimSpace(content) != "" {
		result = []string{strings.TrimSpace(content)}
	}
	return result
}

func voiceFallbackText(content string, explicitVoice bool) string {
	text := strings.TrimSpace(content)
	if explicitVoice {
		if text != "" {
			return "语音合成失败，原语音内容：" + text
		}
		return "语音合成失败，且没有可回退的语音文本。"
	}
	if text != "" {
		return "语音合成失败，先发送文本回复：" + text
	}
	return "语音合成失败，且没有可回退的文本回复。"
}

// buildDebugReplyWithReasoning 组装思维链调试回复（对齐 Node 同名函数）。
func buildDebugReplyWithReasoning(reasoningContent string, visibleReply string) string {
	reasoning := strings.TrimSpace(reasoningContent)
	reply := strings.TrimSpace(visibleReply)
	if reasoning == "" {
		return reply
	}
	if reply == "" {
		return "【思维链】\n" + reasoning
	}
	return "【思维链】\n" + reasoning + "\n\n【正文】\n" + reply
}

// chainLeakRetryMaxRetries 读取重试上限（chat.chainLeakRetry.maxRetries，默认 1）。
func (r *Runtime) chainLeakRetryMaxRetries() int {
	if !r.document.Exists("chat.chainLeakRetry.maxRetries") {
		return 1
	}
	maxRetries := int(r.document.Int("chat.chainLeakRetry.maxRetries", 1))
	if maxRetries < 0 {
		return 0
	}
	return maxRetries
}

// retryOnChainLeak 泄露检测与重试：泄露时把重试指令并入上下文再调一次模型。
func (r *Runtime) retryOnChainLeak(ctx context.Context, messages []ai.Message, reply string, userInput string, scope tools.CallScope) (string, bool) {
	if r.chainLeakRetryMaxRetries() <= 0 {
		return reply, false
	}
	leak := DetectChainLeak(reply, "", reply, userInput)
	if !leak.Leaked {
		return reply, false
	}
	r.logger.Printf("[泄露检测] 疑似泄露（%s），触发重试", leak.Reason)
	retryMessages := append(append([]ai.Message{}, messages...),
		ai.Message{Role: "assistant", Content: reply},
		ai.Message{Role: "user", Content: BuildChainLeakRetryMessage(leak.Reason)})
	retried, _, err := r.chatWithTools(ctx, retryMessages, scope)
	if err != nil {
		r.logger.Printf("[泄露检测] 重试失败: %v", err)
		return reply, false
	}
	retried = strings.TrimSpace(retried)
	if retried == "" {
		return reply, false
	}
	if retryLeak := DetectChainLeak(retried, "", retried, userInput); retryLeak.Leaked {
		r.logger.Printf("[泄露检测] 重试后仍疑似泄露（%s），保留首次回复", retryLeak.Reason)
		return reply, false
	}
	return retried, true
}
