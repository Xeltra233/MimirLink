package chat

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	regexpDigits   = regexp.MustCompile(`^\d+$`)
	regexpQQPrefix = regexp.MustCompile(`(?i)^qq[:：]`)
	regexpIDPrefix = regexp.MustCompile(`(?i)^id[:：]`)
)

// QQ 互动（对齐 Node src/qq-interactions.js）：表情回应、管理员戳一戳命令、@ 提取。

// DefaultQQEmojiReactionID 对齐 Node DEFAULT_QQ_EMOJI_REACTION_ID。
const DefaultQQEmojiReactionID = "289"

// QQEmojiReactionAliases 表情别名表。
var QQEmojiReactionAliases = map[string]string{
	"default": DefaultQQEmojiReactionID, "默认": DefaultQQEmojiReactionID,
	"收到": DefaultQQEmojiReactionID, "ok": DefaultQQEmojiReactionID,
	"okay": DefaultQQEmojiReactionID, "好的": DefaultQQEmojiReactionID,
	"like": "76", "thumb": "76", "thumbs_up": "76", "赞": "76", "点赞": "76",
	"heart": "66", "love": "66", "爱心": "66",
	"doge": "277", "狗头": "277",
}

// NormalizeEmojiReactionId 归一化表情 ID（数字或别名）。
func NormalizeEmojiReactionId(value string, fallback string) string {
	normalizedFallback := DefaultQQEmojiReactionID
	if regexpDigits.MatchString(strings.TrimSpace(fallback)) {
		normalizedFallback = strings.TrimSpace(fallback)
	}
	rawText := strings.TrimSpace(value)
	if rawText == "" {
		return normalizedFallback
	}
	withoutPrefix := regexpQQPrefix.ReplaceAllString(rawText, "")
	withoutPrefix = regexpIDPrefix.ReplaceAllString(withoutPrefix, "")
	withoutPrefix = strings.TrimSpace(withoutPrefix)
	if regexpDigits.MatchString(withoutPrefix) {
		return withoutPrefix
	}
	if mapped, ok := QQEmojiReactionAliases[withoutPrefix]; ok {
		return mapped
	}
	if mapped, ok := QQEmojiReactionAliases[strings.ToLower(withoutPrefix)]; ok {
		return mapped
	}
	return normalizedFallback
}

// ResolveEmojiReactionId 从配置解析表情 ID。
func (r *Runtime) ResolveEmojiReactionId() string {
	if value := r.document.String("chat.emojiReactionId"); value != "" {
		return NormalizeEmojiReactionId(value, DefaultQQEmojiReactionID)
	}
	if value := r.document.String("chat.emojiReactionEmojiId"); value != "" {
		return NormalizeEmojiReactionId(value, DefaultQQEmojiReactionID)
	}
	return NormalizeEmojiReactionId(r.document.String("chat.emojiReaction.id"), DefaultQQEmojiReactionID)
}

// isCommandInvocation 命令识别（精确或前缀后跟空白/@/括号）。
func isCommandInvocation(plainText string, command string) bool {
	normalizedText := strings.TrimSpace(plainText)
	normalizedCommand := strings.TrimSpace(command)
	if normalizedText == "" || normalizedCommand == "" {
		return false
	}
	if normalizedText == normalizedCommand {
		return true
	}
	if !strings.HasPrefix(normalizedText, normalizedCommand) {
		return false
	}
	nextChar := ""
	if len(normalizedText) > len(normalizedCommand) {
		nextChar = normalizedText[len(normalizedCommand):][:1]
	}
	return nextChar == "" || strings.ContainsAny(nextChar, " \t@［[")
}

// extractMentionedUserIds 提取 @ 的用户 QQ（排除 all，保持顺序去重）。
func extractMentionedUserIds(segments []map[string]any) []string {
	seen := map[string]bool{}
	targets := []string{}
	for _, segment := range segments {
		if stringValue(segment["type"]) != "at" {
			continue
		}
		data, _ := segment["data"].(map[string]any)
		if data == nil {
			continue
		}
		qq := stringValue(data["qq"])
		if qq == "" || qq == "all" {
			continue
		}
		if !seen[qq] {
			seen[qq] = true
			targets = append(targets, qq)
		}
	}
	return targets
}

// hasAtAllMention 是否 @全体成员。
func hasAtAllMention(segments []map[string]any) bool {
	for _, segment := range segments {
		if stringValue(segment["type"]) != "at" {
			continue
		}
		if data, ok := segment["data"].(map[string]any); ok && stringValue(data["qq"]) == "all" {
			return true
		}
	}
	return false
}

// callOneBotAPI 通过底层 OneBot 客户端调用 API（表情回应/戳一戳等非核心接口）。
func (r *Runtime) callOneBotAPI(action string, params map[string]any) (string, error) {
	if client, ok := r.bot.(interface {
		Call(action string, params map[string]any) ([]byte, error)
	}); ok {
		if _, err := client.Call(action, params); err != nil {
			return "", err
		}
		return "", nil
	}
	return "", fmt.Errorf("当前 OneBot 适配器不支持 %s", action)
}

// sendEmojiReactionForEvent 给消息添加表情回应（API 不支持时静默忽略，对齐 Node）。
func (r *Runtime) sendEmojiReactionForEvent(event map[string]any) {
	messageID := idField(event, "message_id")
	if messageID == "" {
		return
	}
	emojiID := r.ResolveEmojiReactionId()
	if _, err := r.callOneBotAPI("set_msg_emoji_like", map[string]any{
		"message_id": messageID, "emoji_id": emojiID, "emoji_type": "1",
	}); err != nil {
		r.logger.Printf("[表情] QQ 表情回应失败: %v", err)
	}
}

// isAdminUser 是否管理员（chat.adminUsers）。
func (r *Runtime) isAdminUser(userID string) bool {
	for _, admin := range stringListField(r.document, "chat.adminUsers") {
		if strings.TrimSpace(admin) == userID {
			return true
		}
	}
	return false
}

// sendPoke 戳一戳群成员。
func (r *Runtime) sendPoke(groupID string, userID string) error {
	_, err := r.callOneBotAPI("group_poke", map[string]any{
		"group_id": groupID, "user_id": userID,
	})
	return err
}

// maybeHandleAdminPokeCommand 处理管理员戳一戳命令；返回是否已处理（对齐 executeAdminPokeCommand）。
func (r *Runtime) maybeHandleAdminPokeCommand(event map[string]any, messageType string, groupID string, userID string, plainText string) bool {
	command := strings.TrimSpace(r.document.String("chat.commands.adminPoke.command"))
	if command == "" {
		command = "/戳一戳"
	}
	enabled := true
	if r.document.Exists("chat.commands.adminPoke.enabled") {
		enabled = r.document.Bool("chat.commands.adminPoke.enabled")
	}
	repeatCount := int(r.document.Int("chat.commands.adminPoke.repeatCount", 5))
	if repeatCount < 1 {
		repeatCount = 1
	}
	if repeatCount > 10 {
		repeatCount = 10
	}
	if !isCommandInvocation(plainText, command) {
		return false
	}
	if !enabled {
		return false
	}
	segments := messageSegments(event["message"])
	fail := func(message string) bool {
		_ = r.dispatch(messageType, groupID, userID, event, message)
		return true
	}
	if !r.isAdminUser(userID) {
		return fail("只有管理员可以使用戳一戳命令")
	}
	if messageType != "group" || groupID == "" {
		return fail("戳一戳命令仅支持群聊使用")
	}
	if hasAtAllMention(segments) {
		return fail("戳一戳不支持 @全体成员")
	}
	targets := extractMentionedUserIds(segments)
	if len(targets) == 0 {
		return fail(fmt.Sprintf("请使用 %s @某人", command))
	}
	r.sendEmojiReactionForEvent(event)
	for _, target := range targets {
		for index := 0; index < repeatCount; index++ {
			if err := r.sendPoke(groupID, target); err != nil {
				return fail(fmt.Sprintf("戳一戳失败: %v（QQ %s）", err, target))
			}
		}
	}
	r.logger.Printf("[戳一戳] 已执行：%d 个目标 × %d 下", len(targets), repeatCount)
	return true
}
