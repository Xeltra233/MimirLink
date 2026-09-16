package chat

import (
	"strings"
	"testing"

	"mimirlink/internal/store"
)

// TestChatScopeKey：群聊/私聊范围键。
func TestChatScopeKey(t *testing.T) {
	if key := ChatScopeKey("group", "818554756", "2356350440"); key != "group:818554756" {
		t.Fatalf("群聊范围键不符: %s", key)
	}
	if key := ChatScopeKey("private", "", "2356350440"); key != "private:2356350440" {
		t.Fatalf("私聊范围键不符: %s", key)
	}
	if key := ChatScopeKey("group", "", ""); key != "" {
		t.Fatalf("缺信息应为空: %s", key)
	}
	if !ChatScopeIsPrivate("private:1") || ChatScopeIsPrivate("group:1") {
		t.Fatalf("私聊判断不符")
	}
}

// TestMessageChatScope：元数据优先，回退结构化消息头。
func TestMessageChatScope(t *testing.T) {
	cases := []struct {
		name     string
		message  store.Message
		expected string
	}{
		{"元数据群号", store.Message{Role: "user", MetadataJSON: `{"groupId":"818554756"}`}, "group:818554756"},
		{"消息头群聊", store.Message{Role: "user", Content: "[群聊|QQ:1|昵称:a|群号:99001|群名:x|时间:t] 你好"}, "group:99001"},
		{"消息头私聊", store.Message{Role: "user", Content: "[私聊|QQ:333|昵称:a|群号:N/A|群名:N/A|时间:t] 你好"}, "private:333"},
		{"无法识别", store.Message{Role: "assistant", Content: "普通回复"}, ""},
	}
	for _, item := range cases {
		if scope := MessageChatScope(item.message); scope != item.expected {
			t.Fatalf("%s: 期望 %q，实际 %q", item.name, item.expected, scope)
		}
	}
}

// TestFilterMessagesForChat：只留当前群聊，assistant 继承上一条用户消息，无范围消息保留。
func TestFilterMessagesForChat(t *testing.T) {
	messages := []store.Message{
		{Role: "user", Content: "[群聊|QQ:1|昵称:a|群号:GROUP_A|群名:x|时间:t] A1"},
		{Role: "assistant", Content: "A 的回复"},
		{Role: "user", Content: "[群聊|QQ:2|昵称:b|群号:GROUP_B|群名:y|时间:t] B1"},
		{Role: "assistant", Content: "B 的回复"},
		{Role: "user", Content: "[群聊|QQ:1|昵称:a|群号:GROUP_A|群名:x|时间:t] A2"},
		{Role: "assistant", Content: "无范围回复"},
	}
	filtered := FilterMessagesForChat(messages, "group:GROUP_A")
	texts := []string{}
	for _, message := range filtered {
		texts = append(texts, message.Content)
	}
	expected := []string{"[群聊|QQ:1|昵称:a|群号:GROUP_A|群名:x|时间:t] A1", "A 的回复", "[群聊|QQ:1|昵称:a|群号:GROUP_A|群名:x|时间:t] A2", "无范围回复"}
	if len(texts) != len(expected) {
		t.Fatalf("过滤结果条数不符: %v", texts)
	}
	for index, text := range expected {
		if texts[index] != text {
			t.Fatalf("第 %d 条不符: %s", index, texts[index])
		}
	}
	// scopeKey 为空时原样返回
	if len(FilterMessagesForChat(messages, "")) != len(messages) {
		t.Fatalf("空范围键应原样返回")
	}
}

// TestChatScopePullLimit：窗口放大但设上限。
func TestChatScopePullLimit(t *testing.T) {
	if limit := ChatScopePullLimit(30); limit != 120 {
		t.Fatalf("30 → 120，实际 %d", limit)
	}
	if limit := ChatScopePullLimit(5); limit != 50 {
		t.Fatalf("小窗口应抬到 50，实际 %d", limit)
	}
	if limit := ChatScopePullLimit(500); limit != 400 {
		t.Fatalf("上限应 400，实际 %d", limit)
	}
}

// TestBuildMessagesScopesToCurrentChat：global_shared 共享会话下，模型历史只含当前群聊消息。
func TestBuildMessagesScopesToCurrentChat(t *testing.T) {
	runtime, _, memory := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sessionMode":      "global_shared",
			"requireAtInGroup": true,
			"bufferWindowMs":   0,
			"replyDelayMs":     0,
		},
	}, nil)

	seed := []store.Message{
		{ID: "m1", SessionID: "global_shared_memory", Role: "user", Content: "[群聊|QQ:111|昵称:甲|群号:99001|群名:本群|时间:t] A 消息一", MetadataJSON: `{"groupId":"99001"}`, Timestamp: 1000, DateISO: "2026-01-01"},
		{ID: "m2", SessionID: "global_shared_memory", Role: "assistant", Content: "A 的回复", MetadataJSON: `{"groupId":"99001"}`, Timestamp: 1001, DateISO: "2026-01-01"},
		{ID: "m3", SessionID: "global_shared_memory", Role: "user", Content: "[群聊|QQ:222|昵称:乙|群号:88888|群名:别群|时间:t] B 消息一", MetadataJSON: `{"groupId":"88888"}`, Timestamp: 1002, DateISO: "2026-01-01"},
		{ID: "m4", SessionID: "global_shared_memory", Role: "assistant", Content: "B 的回复", MetadataJSON: `{"groupId":"88888"}`, Timestamp: 1003, DateISO: "2026-01-01"},
		{ID: "m5", SessionID: "global_shared_memory", Role: "user", Content: "[群聊|QQ:111|昵称:甲|群号:99001|群名:本群|时间:t] A 消息二", MetadataJSON: `{"groupId":"99001"}`, Timestamp: 1004, DateISO: "2026-01-01"},
	}
	for _, message := range seed {
		if err := memory.AppendMessage(message); err != nil {
			t.Fatalf("写入历史失败: %v", err)
		}
	}

	messages, _, err := runtime.buildMessages("global_shared_memory", "[群聊|QQ:111|昵称:甲|群号:99001|群名:本群|时间:t] 当前消息", "group", InjectionRisk{}, "99001", "111")
	if err != nil {
		t.Fatalf("构建上下文失败: %v", err)
	}
	joined := ""
	for _, message := range messages {
		if text, ok := message.Content.(string); ok {
			joined += text + "\n"
		}
	}
	if !strings.Contains(joined, "A 消息一") || !strings.Contains(joined, "A 消息二") || !strings.Contains(joined, "A 的回复") {
		t.Fatalf("应包含当前群聊历史: %s", joined)
	}
	if strings.Contains(joined, "B 消息一") || strings.Contains(joined, "B 的回复") {
		t.Fatalf("不应包含其他群聊历史: %s", joined)
	}
}
