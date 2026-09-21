package chat

import (
	"fmt"
	"regexp"
	"strings"

	"mimirlink/internal/ai"
)

// 事件标准化与引用消息（对齐 Node src/standard-event.js + index.js buildReplyInfo +
// src/current-message-focus.js）：引用消息拉取、事件头扩展、当前消息决策段。

// replyInfo 是引用消息解析结果（对齐 Node replyInfo 形状）。
type replyInfo struct {
	Snippet     string
	ToBot       bool
	ToBotSet    bool
	SenderID    string
	SenderName  string
	QuotedText  string
	FetchStatus string
	FetchReason string
	// QuotedPayload 保存拉取到的被引用消息原始 payload，
	// 供识图链路收集引用消息（含合并转发）内的图片，避免二次 GetMsg。
	QuotedPayload map[string]any
}

// extractReplyTarget 从消息段中取 reply 段的 message_id。
func extractReplyTarget(segments []map[string]any) string {
	for _, segment := range segments {
		if stringValue(segment["type"]) != "reply" {
			continue
		}
		data, _ := segment["data"].(map[string]any)
		if data == nil {
			continue
		}
		for _, key := range []string{"id", "message_id", "messageId"} {
			if id := stringValue(data[key]); id != "" {
				return id
			}
		}
	}
	return ""
}

// renderQuotedMessage 渲染被引用消息为文本（含 raw_message 回退与合并转发展开）。
func (r *Runtime) renderQuotedMessage(payload map[string]any) string {
	if payload == nil {
		return ""
	}
	segments := messageSegments(payload["message"])
	text := ""
	if len(segments) > 0 {
		builder := strings.Builder{}
		// 同一条引用消息内的多个转发共享 visited，跨转发循环引用也能拦截
		visited := map[string]bool{}
		for _, segment := range segments {
			segmentType := stringValue(segment["type"])
			if segmentType == "reply" {
				continue
			}
			if isForwardSegmentType(segmentType) {
				data, _ := segment["data"].(map[string]any)
				builder.WriteString(r.renderForwardSegment(data, 0, visited))
				continue
			}
			builder.WriteString(renderSingleSegment(r, segment))
		}
		text = strings.TrimSpace(builder.String())
	}
	if text == "" {
		if raw := stringValue(payload["raw_message"]); raw != "" {
			text = strings.TrimSpace(raw)
		}
	}
	return text
}

// renderSingleSegment 渲染单个非 reply 段（复用 renderSegments 的单段逻辑）。
func renderSingleSegment(r *Runtime, segment map[string]any) string {
	return r.renderSegments([]map[string]any{segment})
}

// buildReplyInfo 拉取并解析引用消息（对齐 Node buildReplyInfo）。
func (r *Runtime) buildReplyInfo(event map[string]any, segments []map[string]any) replyInfo {
	replyID := extractReplyTarget(segments)
	if replyID == "" {
		return replyInfo{FetchStatus: "none", FetchReason: "no_reply_segment"}
	}
	info := replyInfo{FetchStatus: "pending"}
	payload, err := r.bot.GetMsg(replyID)
	if err != nil {
		return replyInfo{FetchStatus: "failed", FetchReason: err.Error()}
	}
	sender, _ := payload["sender"].(map[string]any)
	info.QuotedPayload = payload
	if sender != nil {
		info.SenderID = idField(sender, "user_id")
		info.SenderName = stringValue(sender["card"])
		if info.SenderName == "" {
			info.SenderName = stringValue(sender["nickname"])
		}
	}
	if info.SenderID == "" {
		info.SenderID = idField(payload, "user_id")
	}
	info.QuotedText = r.renderQuotedMessage(payload)
	if info.SenderName == "" && info.QuotedText == "" {
		info.FetchStatus = "resolved_empty"
		info.FetchReason = "reply_message_empty"
		return info
	}
	info.FetchStatus = "resolved"
	info.FetchReason = ""
	if info.SenderID != "" {
		info.ToBot = info.SenderID == r.bot.SelfID()
		info.ToBotSet = true
	}
	parts := []string{"回复上文"}
	if info.SenderName != "" {
		parts = append(parts, "发送者:"+info.SenderName)
	}
	if info.SenderID != "" {
		parts = append(parts, "QQ:"+info.SenderID)
	}
	if info.QuotedText != "" {
		parts = append(parts, "内容:"+info.QuotedText)
	}
	info.Snippet = "[" + strings.Join(parts, "|") + "]"
	return info
}

// applyReplySnippet 把引用摘要并入用户消息文本（对齐 Node promptText = snippet + plainText）。
func applyReplySnippet(plainText string, info replyInfo) string {
	if info.Snippet == "" {
		return plainText
	}
	if plainText == "" {
		return info.Snippet
	}
	return info.Snippet + "\n" + plainText
}

// standardEventHeader 在原事件头基础上追加引用字段（对齐 formatStandardEventHeader）。
func (r *Runtime) standardEventHeader(event map[string]any, messageType string, groupID string, userID string, info replyInfo) string {
	header := r.buildInputHeader(event, messageType, groupID, userID)
	extensions := []string{}
	if info.ToBotSet {
		if info.ToBot {
			extensions = append(extensions, "replyToBot:true")
		} else {
			extensions = append(extensions, "replyToBot:false")
		}
	}
	if replyID := extractReplyTarget(messageSegments(event["message"])); replyID != "" {
		extensions = append(extensions, "replyMessageId:"+replyID)
	}
	if info.QuotedText != "" {
		quoted := info.QuotedText
		runes := []rune(quoted)
		if len(runes) > 180 {
			quoted = string(runes[:180]) + "…"
		}
		extensions = append(extensions, "replyQuotedText:"+quoted)
	}
	if info.FetchStatus != "" && info.FetchStatus != "none" {
		extensions = append(extensions, "replyFetch:"+info.FetchStatus)
	}
	if info.FetchReason != "" {
		reason := info.FetchReason
		runes := []rune(reason)
		if len(runes) > 120 {
			reason = string(runes[:120]) + "…"
		}
		extensions = append(extensions, "replyFetchReason:"+reason)
	}
	if len(extensions) == 0 {
		return header
	}
	return strings.TrimSuffix(header, "]") + "|" + strings.Join(extensions, "|") + "]"
}

// ---------------- 当前消息决策段（对齐 current-message-focus.js） ----------------

var (
	lowInfoPunctRegex  = regexp.MustCompile(`^[?？!！。.,，~～…]+$`)
	lowInfoWordRegex   = regexp.MustCompile(`^(在吗|出来|出来一下|徐缺|滴滴|dd|戳|啊|嗯|哦|草|操|笑死)$`)
	callOutRegex       = regexp.MustCompile(`^(徐缺[，, ]*)?(在吗|出来|出来一下|说话|滴滴|dd)$`)
	callOutPrefixRegex = regexp.MustCompile(`^徐缺[，, ]*(出来一下|出来|在吗|说话)?$`)
	topicShiftRegex    = regexp.MustCompile(`(不聊|别聊|换话题|换个话题|先不说|别提|停一下|腻了|突然想|说回|算了)`)
	releaseTopicRegex  = regexp.MustCompile(`(别提|不聊|别聊|停一下|腻了|少用|别再|换话题|哪里谈到|哪谈到|谁提|谁说|怎么又|咋又|怎么扯到|咋扯到|刚才有说|前文有说)`)
	questionTailRegex  = regexp.MustCompile(`[?？]$`)
	compactText3       = regexp.MustCompile(`\s+`)
)

func normalizeFocusText(text string) string {
	return strings.TrimSpace(compactText3.ReplaceAllString(strings.ReplaceAll(text, "\r", ""), " "))
}

func looksLowInformation(text string) bool {
	normalized := normalizeFocusText(text)
	if normalized == "" {
		return true
	}
	if lowInfoPunctRegex.MatchString(normalized) {
		return true
	}
	if lowInfoWordRegex.MatchString(normalized) {
		return true
	}
	if len([]rune(normalized)) <= 3 {
		return true
	}
	return false
}

func detectIntent(event map[string]any, text string, info replyInfo) string {
	if stringField(event, "post_type") == "poke" {
		return "poke"
	}
	if info.ToBotSet && info.ToBot {
		return "reply_to_bot"
	}
	normalized := normalizeFocusText(text)
	if callOutRegex.MatchString(normalized) || callOutPrefixRegex.MatchString(normalized) {
		return "call_out"
	}
	if looksLowInformation(text) {
		return "low_information"
	}
	if topicShiftRegex.MatchString(normalized) {
		return "topic_shift"
	}
	if questionTailRegex.MatchString(normalized) {
		return "question"
	}
	return "chat"
}

func buildFocusReplyTarget(event map[string]any, intent string, info replyInfo, isAtBot bool) string {
	if intent == "poke" {
		return "respond_to_poke_user"
	}
	if (info.ToBotSet && info.ToBot) || intent == "reply_to_bot" {
		return "reply_to_current_user_about_bot_quote"
	}
	if isAtBot {
		return "reply_to_mentioned_bot_request"
	}
	if stringField(event, "message_type") == "private" {
		return "reply_to_private_user"
	}
	return "reply_to_current_user_only_if_triggered"
}

// buildFocusStrategies 构建策略列表（对齐 buildStrategies）。
func buildFocusStrategies(event map[string]any, text string, intent string, info replyInfo, isAtBot bool) []string {
	seen := map[string]bool{}
	strategies := []string{}
	add := func(value string) {
		if !seen[value] {
			seen[value] = true
			strategies = append(strategies, value)
		}
	}
	add("read_header_first")
	add("answer_latest_user_text")
	if extractReplyTarget(messageSegments(event["message"])) != "" {
		add("use_quote_as_context_only")
	}
	if info.ToBotSet && info.ToBot {
		add("treat_as_addressed_to_bot_even_without_at")
	}
	switch intent {
	case "poke":
		add("acknowledge_poke_briefly")
	case "emoji_reaction":
		add("describe_visible_emoji_or_mood")
	case "low_information", "call_out":
		add("give_short_acknowledgement")
		add("avoid_question_as_crutch")
	}
	normalized := normalizeFocusText(text)
	if intent == "topic_shift" || releaseTopicRegex.MatchString(normalized) {
		add("release_old_topic")
		add("do_not_repeat_stopped_keyword")
	}
	add("keep_one_to_three_short_sentences")
	return strategies
}

// buildFocusWarnings 构建注意事项（对齐 buildWarnings）。
func buildFocusWarnings(event map[string]any, intent string, info replyInfo) []string {
	warnings := []string{}
	if info.FetchStatus == "failed" {
		warnings = append(warnings, "引用消息获取失败: "+orEmpty(info.FetchReason))
	}
	if extractReplyTarget(messageSegments(event["message"])) != "" && !(info.ToBotSet && info.ToBot) {
		warnings = append(warnings, "这是普通引用，不要误判为用户在叫 bot")
	}
	if intent == "low_information" {
		warnings = append(warnings, "低信息输入不要用反问把问题甩回用户")
	}
	if releaseTopicRegex.MatchString(normalizeFocusText(stringField(event, "raw_message"))) {
		warnings = append(warnings, "用户正在要求释放旧话题或旧口癖")
	}
	return warnings
}

// buildCurrentMessageFocus 构建当前消息决策信息。
func (r *Runtime) buildCurrentMessageFocus(event map[string]any, text string, messageType string, isAtBot bool, info replyInfo) map[string]any {
	intent := detectIntent(event, text, info)
	return map[string]any{
		"eventType":           "message",
		"messageType":         messageType,
		"senderName":          senderNameOf(event),
		"senderID":            idField(event, "user_id"),
		"intent":              intent,
		"replyTarget":         buildFocusReplyTarget(event, intent, info, isAtBot),
		"isLowInformation":    looksLowInformation(text),
		"isTopicShift":        topicShiftRegex.MatchString(normalizeFocusText(text)),
		"shouldReleaseOldTop": releaseTopicRegex.MatchString(normalizeFocusText(text)),
		"quoteMessageID":      extractReplyTarget(messageSegments(event["message"])),
		"quoteToBot":          info.ToBotSet && info.ToBot,
		"quotedText":          truncateRunes(info.QuotedText, 160),
		"latestText":          truncateRunes(normalizeFocusText(text), 220),
		"strategies":          buildFocusStrategies(event, text, intent, info, isAtBot),
		"warnings":            buildFocusWarnings(event, intent, info),
	}
}

// formatCurrentMessageFocus 渲染决策段（对齐 Node formatCurrentMessageFocus 输出形状）。
func formatCurrentMessageFocus(focus map[string]any) string {
	boolText := func(key string) string {
		if value, ok := focus[key].(bool); ok && value {
			return "yes"
		}
		return "no"
	}
	lines := []string{
		"<current-message-focus>",
		fmt.Sprintf("事件: %s / %s", stringValue(focus["eventType"]), stringValue(focus["messageType"])),
		fmt.Sprintf("发言人: %s(%s)", orDefaultText(stringValue(focus["senderName"]), "未知"), orDefaultText(stringValue(focus["senderID"]), "N/A")),
		fmt.Sprintf("意图: %s", orDefaultText(stringValue(focus["intent"]), "chat")),
		fmt.Sprintf("回复目标: %s", stringValue(focus["replyTarget"])),
	}
	lowInfo := fmt.Sprintf("低信息: %s | 换话题: %s | 释放旧话题: %s",
		boolText("isLowInformation"), boolText("isTopicShift"), boolText("shouldReleaseOldTop"))
	lines = append(lines, lowInfo)
	if quoteID := stringValue(focus["quoteMessageID"]); quoteID != "" {
		quoteLabel := "other"
		if focus["quoteToBot"] == true {
			quoteLabel = "bot"
		}
		line := fmt.Sprintf("引用: %s / %s", quoteLabel, quoteID)
		if quoted := stringValue(focus["quotedText"]); quoted != "" {
			line += " / " + quoted
		}
		lines = append(lines, line)
	}
	if latest := stringValue(focus["latestText"]); latest != "" {
		lines = append(lines, "最新输入: "+latest)
	}
	if strategies, ok := focus["strategies"].([]string); ok && len(strategies) > 0 {
		lines = append(lines, "策略: "+strings.Join(strategies, ", "))
	}
	if warnings, ok := focus["warnings"].([]string); ok && len(warnings) > 0 {
		lines = append(lines, "注意: "+strings.Join(warnings, "；"))
	}
	lines = append(lines, "</current-message-focus>")
	return strings.Join(lines, "\n")
}

// currentMessageFocusSegment 生成决策段消息（对齐 Node order 129：preSystem 之后）。
func (r *Runtime) currentMessageFocusSegment(event map[string]any, text string, messageType string, isAtBot bool, info replyInfo) string {
	focus := r.buildCurrentMessageFocus(event, text, messageType, isAtBot, info)
	return formatCurrentMessageFocus(focus)
}

func senderNameOf(event map[string]any) string {
	if sender, ok := event["sender"].(map[string]any); ok {
		if name := stringValue(sender["card"]); name != "" {
			return name
		}
		return stringValue(sender["nickname"])
	}
	return ""
}

func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func orDefaultText(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

// 供 buildMessages 使用：注入决策段（在 preSystem 之后插入）。
func insertAfterPreSystem(messages []ai.Message, segment string) []ai.Message {
	if strings.TrimSpace(segment) == "" {
		return messages
	}
	result := []ai.Message{}
	inserted := false
	for _, message := range messages {
		result = append(result, message)
		if !inserted && message.Role == "system" {
			result = append(result, ai.Message{Role: "system", Content: segment})
			inserted = true
		}
	}
	if !inserted {
		result = append(result, ai.Message{Role: "system", Content: segment})
	}
	return result
}
