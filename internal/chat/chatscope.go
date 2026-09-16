package chat

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"mimirlink/internal/store"
)

// 聊天范围过滤（对齐 Node src/chat-scope.js）：
// global_shared 等共享会话下，模型只应看到“当前群聊 / 当前私聊”的最近消息，
// 其他群或其他人的私聊内容不再进入上下文。用户消息元数据带 groupId；
// assistant 消息元数据自本版起也带 groupId，缺失时按“继承上一条用户消息的聊天范围”处理（兼容历史数据）。

// ChatScopeKey 生成当前聊天的范围键：群聊 group:<群号>，私聊 private:<QQ>。
func ChatScopeKey(messageType string, groupID string, userID string) string {
	if messageType == "group" {
		if trimmed := strings.TrimSpace(groupID); trimmed != "" {
			return "group:" + trimmed
		}
	}
	if trimmed := strings.TrimSpace(userID); trimmed != "" {
		return "private:" + trimmed
	}
	return ""
}

// ChatScopeIsPrivate 判断范围键是否私聊。
func ChatScopeIsPrivate(scopeKey string) bool {
	return strings.HasPrefix(scopeKey, "private:")
}

var chatScopeHeaderPattern = regexp.MustCompile(`\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|群号:([^|\]]*)\|群名:([^|\]]*)`)

// MessageChatScope 解析单条消息的聊天范围键（优先元数据 groupId，回退结构化消息头）。
func MessageChatScope(message store.Message) string {
	if strings.TrimSpace(message.MetadataJSON) != "" {
		metadata := map[string]any{}
		if err := json.Unmarshal([]byte(message.MetadataJSON), &metadata); err == nil {
			if raw, ok := metadata["groupId"]; ok {
				groupID := strings.TrimSpace(fmt.Sprintf("%v", raw))
				if groupID != "" && groupID != "<nil>" {
					return "group:" + groupID
				}
			}
		}
	}
	return HeaderChatScope(message.Content)
}

// HeaderChatScope 从结构化消息头解析聊天范围键（供消息过滤与工具阶段场景卡共用）。
func HeaderChatScope(text string) string {
	if match := chatScopeHeaderPattern.FindStringSubmatch(text); match != nil {
		if match[1] == "群聊" && match[4] != "" && match[4] != "N/A" {
			return "group:" + match[4]
		}
		if match[1] == "私聊" && match[2] != "" {
			return "private:" + match[2]
		}
	}
	return ""
}

// FilterMessagesForChat 只保留属于当前聊天范围的消息；scopeKey 为空时原样返回。
func FilterMessagesForChat(messages []store.Message, scopeKey string) []store.Message {
	if scopeKey == "" {
		return messages
	}
	result := make([]store.Message, 0, len(messages))
	lastUserScope := ""
	for _, message := range messages {
		scope := MessageChatScope(message)
		if scope == "" && message.Role == "assistant" {
			scope = lastUserScope
		}
		if message.Role == "user" && scope != "" {
			lastUserScope = scope
		}
		if scope == "" || scope == scopeKey {
			result = append(result, message)
		}
	}
	return result
}

// ChatScopePullLimit 共享会话下先按更大窗口取原始消息，过滤后再裁剪到 historySize。
func ChatScopePullLimit(historySize int) int {
	if historySize <= 0 {
		historySize = 30
	}
	limit := historySize * 4
	if limit < 50 {
		limit = 50
	}
	if limit > 400 {
		limit = 400
	}
	return limit
}
