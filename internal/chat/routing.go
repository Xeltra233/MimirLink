package chat

// 触发路由与访问控制（对齐 Node src/index.js 的 isAllowed / buildRoutingDecision）。
//
// 历史缺口：Go 版此前只有「群白名单 + 群聊必须 @」两个硬判定，导致
// chat.triggerMode（auto/always/prefix/keyword）、chat.triggerKeywords、chat.triggerPrefix、
// chat.requireAtInGroup=false、回复触发（reply_to_bot）、
// accessControlMode（disabled/blocklist/allowlist）以及 allowedUsers/blockedUsers/blockedGroups
// 全部不生效——表现为「配置了关键词反而不触发」「模式设为 disabled 仍被白名单拦截」等。

import (
	"strings"
	"time"
)

// routingDecision 对齐 Node buildRoutingDecision 的返回值。
type routingDecision struct {
	ShouldRespond bool           `json:"shouldRespond"`
	TriggerReason string         `json:"triggerReason"`
	SkipReason    string         `json:"skipReason"`
	Checks        map[string]any `json:"checks"`
}

// accessControlMode 读取访问控制模式（Node 默认 allowlist）。
func (r *Runtime) accessControlMode() string {
	mode := strings.TrimSpace(r.document.String("chat.accessControlMode"))
	if mode == "" {
		return "allowlist"
	}
	return mode
}

// containsID 判断字符串列表是否包含目标 ID。
func containsID(values []string, target string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == target {
			return true
		}
	}
	return false
}

// isAllowed 对齐 Node isAllowed：
//   - disabled：全部放行
//   - blocklist：命中 blockedUsers / blockedGroups 拒绝
//   - allowlist（默认）：群聊受 allowedGroups 限制，任何场景下非空 allowedUsers 都要求命中
func (r *Runtime) isAllowed(event map[string]any) bool {
	switch r.accessControlMode() {
	case "disabled":
		return true
	case "blocklist":
		if containsID(stringListField(r.document, "chat.blockedUsers"), idField(event, "user_id")) {
			return false
		}
		if stringField(event, "message_type") == "group" &&
			containsID(stringListField(r.document, "chat.blockedGroups"), idField(event, "group_id")) {
			return false
		}
		return true
	default: // allowlist
		if stringField(event, "message_type") == "group" {
			allowedGroups := stringListField(r.document, "chat.allowedGroups")
			if len(allowedGroups) > 0 && !containsID(allowedGroups, idField(event, "group_id")) {
				return false
			}
		}
		allowedUsers := stringListField(r.document, "chat.allowedUsers")
		if len(allowedUsers) > 0 && !containsID(allowedUsers, idField(event, "user_id")) {
			return false
		}
		return true
	}
}

// matchesKeywords 对齐 Node matchesKeywords：任一关键词子串命中即触发。
func matchesKeywords(text string, keywords []string) bool {
	if text == "" {
		return false
	}
	for _, keyword := range keywords {
		if keyword != "" && strings.Contains(text, keyword) {
			return true
		}
	}
	return false
}

// requireAtInGroupEnabled 读取 chat.requireAtInGroup（默认 true）。
func (r *Runtime) requireAtInGroupEnabled() bool {
	if r.document.Exists("chat.requireAtInGroup") {
		return r.document.Bool("chat.requireAtInGroup")
	}
	return true
}

// buildRoutingDecision 对齐 Node buildRoutingDecision 的群聊/私聊触发判定。
// plainText 是消息正文（含合并转发展开内容，用于空文本判定）；
// triggerText 剔除了合并转发展开内容，关键词/前缀只对它匹配——
// 他人转发的记录不应让 bot 被关键词误触发。
func (r *Runtime) buildRoutingDecision(event map[string]any, plainText string, triggerText string, isAtMe bool, info replyInfo) routingDecision {
	triggerMode := strings.TrimSpace(r.document.String("chat.triggerMode"))
	if triggerMode == "" {
		triggerMode = "auto"
	}
	requireAtInGroup := r.requireAtInGroupEnabled()
	triggerPrefix := r.document.String("chat.triggerPrefix")
	triggerKeywords := stringListField(r.document, "chat.triggerKeywords")
	hasPrefix := triggerPrefix != "" && strings.HasPrefix(triggerText, triggerPrefix)
	hasKeyword := matchesKeywords(triggerText, triggerKeywords)
	allowed := r.isAllowed(event)
	replyToBot := info.ToBotSet && info.ToBot
	messageType := stringField(event, "message_type")

	checks := map[string]any{
		"hasText":          plainText != "",
		"allowed":          allowed,
		"triggerMode":      triggerMode,
		"requireAtInGroup": requireAtInGroup,
		"isAtBot":          isAtMe,
		"replyToBot":       replyToBot,
		"replyFetchStatus": info.FetchStatus,
		"replyFetchReason": info.FetchReason,
		"hasPrefix":        hasPrefix,
		"hasKeyword":       hasKeyword,
		"messageType":      messageType,
	}
	accept := func(reason string) routingDecision {
		return routingDecision{ShouldRespond: true, TriggerReason: reason, Checks: checks}
	}
	skip := func(reason string) routingDecision {
		return routingDecision{ShouldRespond: false, SkipReason: reason, Checks: checks}
	}

	if plainText == "" {
		return skip("empty_text")
	}
	if !allowed {
		return skip("access_denied")
	}

	if messageType == "group" {
		if replyToBot {
			return accept("reply_to_bot")
		}
		switch triggerMode {
		case "always":
			return accept("always")
		case "prefix":
			if hasPrefix {
				return accept("prefix")
			}
			if !requireAtInGroup && isAtMe {
				return accept("at")
			}
			if requireAtInGroup {
				return skip("prefix_required")
			}
			return skip("prefix_or_at_required")
		case "keyword":
			if hasKeyword {
				return accept("keyword")
			}
			if isAtMe {
				return accept("at")
			}
			return skip("keyword_or_at_required")
		}
		if requireAtInGroup {
			if isAtMe {
				return accept("at")
			}
			if hasPrefix {
				return accept("prefix")
			}
			if hasKeyword {
				return accept("keyword")
			}
			return skip("group_requires_at_prefix_keyword_or_reply_to_bot")
		}
		if hasPrefix {
			return accept("prefix")
		}
		if hasKeyword {
			return accept("keyword")
		}
		if isAtMe {
			return accept("at")
		}
		return skip("group_no_trigger_matched")
	}

	switch triggerMode {
	case "keyword":
		if hasKeyword {
			return accept("keyword")
		}
		return skip("private_keyword_required")
	case "prefix":
		if hasPrefix {
			return accept("prefix")
		}
		return skip("private_prefix_required")
	}
	return accept("private")
}

// recordRoutingSnapshot 记录最近一次路由判定（对齐 Node lastRoutingSnapshot，面板状态展示用）。
func (r *Runtime) recordRoutingSnapshot(event map[string]any, sessionKey string, decision routingDecision, info replyInfo, replyToBot bool) {
	messageType := stringField(event, "message_type")
	userID := idField(event, "user_id")
	groupID := idField(event, "group_id")
	sessionLabel := sessionKey
	if messageType == "group" && groupID != "" {
		sessionLabel = "群 " + groupID
	} else if userID != "" {
		sessionLabel = "私聊 " + userID
	}
	snapshot := map[string]any{
		"at":               time.Now().UnixMilli(),
		"sessionKey":       sessionKey,
		"sessionLabel":     sessionLabel,
		"messageType":      messageType,
		"userId":           userID,
		"groupId":          groupID,
		"triggerReason":    decision.TriggerReason,
		"skipReason":       decision.SkipReason,
		"shouldRespond":    decision.ShouldRespond,
		"routingDecision":  decision,
		"replyToBot":       replyToBot,
		"replyMessageId":   extractReplyTarget(messageSegments(event["message"])),
		"replyFetchStatus": info.FetchStatus,
		"replyFetchReason": info.FetchReason,
		"dbPath":           r.memoryPath(),
	}
	r.routingMu.Lock()
	r.lastRouting = snapshot
	r.routingMu.Unlock()
}

// LastRoutingSnapshot 返回最近一次路由判定（供控制接口/面板状态展示）。
func (r *Runtime) LastRoutingSnapshot() map[string]any {
	r.routingMu.RLock()
	defer r.routingMu.RUnlock()
	if r.lastRouting == nil {
		return nil
	}
	copied := map[string]any{}
	for key, value := range r.lastRouting {
		copied[key] = value
	}
	return copied
}

// memoryPath 返回当前记忆库路径（面板状态标签用）。
func (r *Runtime) memoryPath() string {
	if r.memory == nil {
		return ""
	}
	return r.memory.Path
}
