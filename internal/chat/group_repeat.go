package chat

import (
	"encoding/json"
	"mimirlink/internal/config"
	"regexp"
	"strings"
	"sync"
	"time"
)

// 群复读（对齐 Node src/group-repeat.js）。

// GroupRepeatConfig 是群复读配置。
type GroupRepeatConfig struct {
	Enabled      bool
	TriggerCount int
	CooldownMs   int
}

// DefaultGroupRepeatConfig 对齐 Node DEFAULT_GROUP_REPEAT_CONFIG。
func DefaultGroupRepeatConfig() GroupRepeatConfig {
	return GroupRepeatConfig{Enabled: false, TriggerCount: 3, CooldownMs: 300000}
}

func clampRepeatInt(value int, minimum int, maximum int, fallback int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// NormalizeGroupRepeatConfig 归一化配置（对齐 Node normalizeGroupRepeatConfig）。
func NormalizeGroupRepeatConfig(raw map[string]any) GroupRepeatConfig {
	config := DefaultGroupRepeatConfig()
	if raw == nil {
		return config
	}
	if value, ok := raw["enabled"].(bool); ok {
		config.Enabled = value
	}
	if value := intFromAny(raw["triggerCount"]); value > 0 {
		config.TriggerCount = clampRepeatInt(value, 2, 10, config.TriggerCount)
	}
	if value := intFromAny(raw["cooldownMs"]); value > 0 {
		config.CooldownMs = clampRepeatInt(value, 1000, 3600000, config.CooldownMs)
	}
	return config
}

func intFromAny(value any) int {
	if number, ok := value.(float64); ok {
		return int(number)
	}
	return 0
}

var repeatSpacesRegex = regexp.MustCompile(`\s+`)
var cqCodeRegex = regexp.MustCompile(`(?i)\[CQ:([^,\]]+)[^\]]*\]`)

func normalizeRepeatText(text string) string {
	return strings.TrimSpace(repeatSpacesRegex.ReplaceAllString(strings.ReplaceAll(text, "\r", ""), " "))
}

// containsNonTextCQCode 判断字符串是否含非 text 类 CQ 码（Go regexp 无负向前瞻，
// 用捕获组等价实现）。
func containsNonTextCQCode(text string) bool {
	for _, match := range cqCodeRegex.FindAllStringSubmatch(text, -1) {
		if len(match) > 1 && !strings.EqualFold(strings.TrimSpace(match[1]), "text") {
			return true
		}
	}
	return false
}

func cleanRepeatText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimRight(line, " \t")
	}
	return strings.TrimSpace(strings.Join(lines, "\n"))
}

// getRawRepeatableMessageText 提取未折叠换行的原始复读文本。
func getRawRepeatableMessageText(event map[string]any, fallbackText string) string {
	segments := messageSegments(event["message"])
	if len(segments) > 0 {
		textParts := []string{}
		for _, segment := range segments {
			segmentType := stringValue(segment["type"])
			if segmentType == "reply" {
				continue
			}
			if segmentType != "text" {
				return ""
			}
			data, _ := segment["data"].(map[string]any)
			if data != nil {
				textParts = append(textParts, stringValue(data["text"]))
			}
		}
		return strings.Join(textParts, "")
	}
	rawCandidate := stringValue(event["message"])
	if rawCandidate == "" {
		rawCandidate = stringValue(event["raw_message"])
	}
	if containsNonTextCQCode(rawCandidate) {
		return ""
	}
	candidate := rawCandidate
	if candidate == "" {
		candidate = fallbackText
	}
	if containsNonTextCQCode(candidate) {
		return ""
	}
	return candidate
}

// getRepeatableMessageText 提取可复读文本（用于比对规整化）。
func getRepeatableMessageText(event map[string]any, fallbackText string) string {
	return normalizeRepeatText(getRawRepeatableMessageText(event, fallbackText))
}

// shouldObserveGroupRepeatMessage 判断消息是否纳入复读观察。
func shouldObserveGroupRepeatMessage(config GroupRepeatConfig, event map[string]any, text string, botSelfID string) bool {
	if !config.Enabled {
		return false
	}
	if postType := strings.ToLower(strings.TrimSpace(stringField(event, "post_type"))); postType != "" && postType != "message" {
		return false
	}
	if stringValue(event["message_type"]) != "group" {
		return false
	}
	senderID := idField(event, "user_id")
	if senderID != "" && senderID == botSelfID {
		return false
	}
	return getRepeatableMessageText(event, text) != ""
}

// groupRepeatResult 是复读观察结果。
type groupRepeatResult struct {
	ShouldRepeat bool
	Reason       string
	RepeatText   string
	Count        int
	TriggerCount int
}

// groupRepeatState 是群内复读计数状态。
type groupRepeatState struct {
	NormalizedText string
	RepeatText     string
	Count          int
	UpdatedAt      int64
}

// GroupRepeatDetector 检测群复读并触发跟读（对齐 Node GroupRepeatDetector）。
type GroupRepeatDetector struct {
	mu        sync.Mutex
	group     map[string]*groupRepeatState
	cooldowns map[string]map[string]int64
}

// NewGroupRepeatDetector 创建检测器。
func NewGroupRepeatDetector() *GroupRepeatDetector {
	return &GroupRepeatDetector{
		group:     map[string]*groupRepeatState{},
		cooldowns: map[string]map[string]int64{},
	}
}

// Reset 清空状态。
func (d *GroupRepeatDetector) Reset() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.group = map[string]*groupRepeatState{}
	d.cooldowns = map[string]map[string]int64{}
}

// ObserveMessage 观察一条消息；命中触发条件时返回 shouldRepeat=true。
func (d *GroupRepeatDetector) ObserveMessage(config GroupRepeatConfig, event map[string]any, text string, botSelfID string, now time.Time) groupRepeatResult {
	if !shouldObserveGroupRepeatMessage(config, event, text, botSelfID) {
		return groupRepeatResult{Reason: map[bool]string{true: "not_observable", false: "disabled"}[config.Enabled]}
	}
	groupID := idField(event, "group_id")
	if groupID == "" {
		return groupRepeatResult{Reason: "missing_group_id"}
	}
	rawText := getRawRepeatableMessageText(event, text)
	normalizedText := normalizeRepeatText(rawText)
	repeatText := cleanRepeatText(rawText)
	if repeatText == "" {
		repeatText = normalizedText
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	// 清理过期冷却
	for group, entries := range d.cooldowns {
		for key, expiresAt := range entries {
			if expiresAt <= now.UnixMilli() {
				delete(entries, key)
			}
		}
		if len(entries) == 0 {
			delete(d.cooldowns, group)
		}
	}
	if groupCooldowns, ok := d.cooldowns[groupID]; ok {
		if expiresAt, ok := groupCooldowns[normalizedText]; ok && expiresAt > now.UnixMilli() {
			return groupRepeatResult{Reason: "cooldown", RepeatText: repeatText}
		}
	}
	count := 1
	if previous, ok := d.group[groupID]; ok && previous.NormalizedText == normalizedText {
		count = previous.Count + 1
	}
	if count >= config.TriggerCount {
		if d.cooldowns[groupID] == nil {
			d.cooldowns[groupID] = map[string]int64{}
		}
		d.cooldowns[groupID][normalizedText] = now.UnixMilli() + int64(config.CooldownMs)
		d.group[groupID] = &groupRepeatState{NormalizedText: normalizedText, RepeatText: repeatText, Count: 0, UpdatedAt: now.UnixMilli()}
		return groupRepeatResult{
			ShouldRepeat: true, Reason: "matched", RepeatText: repeatText,
			Count: count, TriggerCount: config.TriggerCount,
		}
	}
	d.group[groupID] = &groupRepeatState{NormalizedText: normalizedText, RepeatText: repeatText, Count: count, UpdatedAt: now.UnixMilli()}
	return groupRepeatResult{Reason: "tracking", RepeatText: repeatText, Count: count, TriggerCount: config.TriggerCount}
}

// rawMapField 从配置文档读取一个 map 段（document.Get 值转 map）。
func rawMapField(document *config.Document, path string) map[string]any {
	result := document.Get(path)
	if !result.Exists() {
		return nil
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(result.Raw), &decoded); err != nil {
		return nil
	}
	return decoded
}
