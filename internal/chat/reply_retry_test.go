package chat

import (
	"fmt"
	"strings"
	"testing"
)

// 对齐 Node generateReplyWithRetry + buildAIServiceFailureMessage + isEmptyLikeReply。

func retryChatConfig(extra map[string]any) map[string]any {
	chat := map[string]any{
		"sessionMode":      "user_persistent",
		"requireAtInGroup": true,
		"allowedGroups":    []any{"99001"},
		"model":            "test-model",
		"bufferWindowMs":   0,
		"replyDelayMs":     0,
	}
	for key, value := range extra {
		chat[key] = value
	}
	return map[string]any{"chat": chat}
}

func lastGroupText(t *testing.T, bot *fakeBot) string {
	t.Helper()
	sent := bot.getGroupSent()
	if len(sent) == 0 {
		t.Fatal("应发送消息，实际 0 条")
	}
	return fmt.Sprintf("%v", sent[len(sent)-1]["message"])
}

// TestIsEmptyLikeReply 校验空判定口径（空/空白/纯标点/上游错误内容）。
func TestIsEmptyLikeReply(t *testing.T) {
	for _, text := range []string{"", "   ", "...", "。。。", "…· 。", "upstream error: overloaded"} {
		if !isEmptyLikeReply(text) {
			t.Fatalf("%q 应视为空回复", text)
		}
	}
	for _, text := range []string{"你好", "在的。明天见", "AI 返回空回复，已自动重试 3 次仍失败，请稍后再试"} {
		if isEmptyLikeReply(text) {
			t.Fatalf("%q 不应视为空回复", text)
		}
	}
}

// TestEmptyReplyRetryThenSuccess 首次空、二次正常：应重试一次并发出正常回复。
func TestEmptyReplyRetryThenSuccess(t *testing.T) {
	model := &fakeModel{replies: []string{"", "在的"}}
	runtime, bot, _ := newRuntime(t, retryChatConfig(map[string]any{
		"emptyReplyRetry": map[string]any{"maxRetries": 2, "delayMs": 0},
	}), model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("消息应被处理")
	}
	if len(model.requests) != 2 {
		t.Fatalf("空回复应重试一次，实际模型调用 %d 次", len(model.requests))
	}
	if text := lastGroupText(t, bot); !strings.Contains(text, "在的") {
		t.Fatalf("应发出重试后的正常回复: %s", text)
	}
}

// TestEmptyReplyExhausted SendsFailureNotice 空耗尽：按 maxRetries 调用并回失败提示。
func TestEmptyReplyExhaustedSendsFailureNotice(t *testing.T) {
	model := &fakeModel{replies: []string{"", "", "", ""}}
	runtime, bot, _ := newRuntime(t, retryChatConfig(map[string]any{
		"emptyReplyRetry": map[string]any{"maxRetries": 1, "delayMs": 0},
	}), model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("失败回执也应视为已处理")
	}
	if len(model.requests) != 2 {
		t.Fatalf("maxRetries=1 应共调用 2 次，实际 %d 次", len(model.requests))
	}
	if text := lastGroupText(t, bot); !strings.Contains(text, "重试") || !strings.Contains(text, "稍后再试") {
		t.Fatalf("耗尽后应回失败提示: %s", text)
	}
}

// TestModelErrorSendsFailureNotice 模型报错：回失败提示（对齐 Node 同一 catch 分支）。
func TestModelErrorSendsFailureNotice(t *testing.T) {
	model := &fakeModel{failAlways: true}
	runtime, bot, _ := newRuntime(t, retryChatConfig(nil), model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("失败回执也应视为已处理")
	}
	if text := lastGroupText(t, bot); !strings.Contains(text, "稍后") {
		t.Fatalf("模型报错应回失败提示: %s", text)
	}
}

// TestEmptyReplyRetryDisabled 关闭重试：只调用一次，空则直接回失败提示。
func TestEmptyReplyRetryDisabled(t *testing.T) {
	model := &fakeModel{replies: []string{"", "不该出现"}}
	runtime, bot, _ := newRuntime(t, retryChatConfig(map[string]any{
		"emptyReplyRetry": map[string]any{"enabled": false},
	}), model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("失败回执也应视为已处理")
	}
	if len(model.requests) != 1 {
		t.Fatalf("关闭重试时应只调用 1 次，实际 %d 次", len(model.requests))
	}
	if text := lastGroupText(t, bot); !strings.Contains(text, "稍后再试") {
		t.Fatalf("应回失败提示: %s", text)
	}
}
