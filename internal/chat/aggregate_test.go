package chat

import (
	"io"
	"log"
	"strings"
	"testing"
	"time"
)

// TestAggregateMergesBurstIntoOneReply 守护连发聚合（对齐 Node runtime.js）：
// 缓冲窗口内的多条消息合并为一次模型调用，且情境段展示聚合消息数。
func TestAggregateMergesBurstIntoOneReply(t *testing.T) {
	model := &fakeModel{replies: []string{"合并回复", "不该出现"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sessionMode": "user_persistent", "requireAtInGroup": true,
			"allowedGroups": []any{"99001"}, "model": "test-model",
			"bufferWindowMs": 300, "replyDelayMs": 0,
		},
	}, model)

	// 连发三条（窗口内）
	for _, text := range []string{"第一句", "第二句", "第三句"} {
		if handled := runtime.HandleEvent(buildGroupEvent(text, true, "99001", "2001")); !handled {
			t.Fatal("聚合缓冲应接受消息")
		}
	}
	if len(bot.groupSent) != 0 {
		t.Fatalf("窗口内不应立即回复，实际 %d 条", len(bot.groupSent))
	}
	if !runtime.WaitForAggregates(8 * time.Second) {
		t.Fatal("等待聚合处理超时")
	}
	if len(model.requests) != 1 {
		t.Fatalf("连发三条应只调用一次模型，实际 %d 次", len(model.requests))
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("应发送一条回复，实际 %d 条", len(bot.groupSent))
	}
	// 合并后的输入应包含三句
	sent := model.requests[0]
	last := sent[len(sent)-1]
	content, _ := last.Content.(string)
	for _, text := range []string{"第一句", "第二句", "第三句"} {
		if !strings.Contains(content, text) {
			t.Fatalf("合并输入缺少 %q：%s", text, content)
		}
	}
	// 情境段应展示聚合消息数（触发用户意图/会话事实开关默认开启）
	joined := ""
	for _, message := range sent {
		if text, ok := message.Content.(string); ok {
			joined += text + "\n"
		}
	}
	if !strings.Contains(joined, "本次聚合消息数: 3") {
		t.Fatalf("情境段应展示聚合消息数，实际：%s", joined)
	}
}

// TestAggregateFlushSeparatesBatches 守护窗口语义：窗口静默后再来的消息属于下一批。
func TestAggregateFlushSeparatesBatches(t *testing.T) {
	model := &fakeModel{replies: []string{"第一批", "第二批"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sessionMode": "user_persistent", "requireAtInGroup": true,
			"allowedGroups": []any{"99001"}, "model": "test-model",
			"bufferWindowMs": 200, "replyDelayMs": 0,
		},
	}, model)

	runtime.HandleEvent(buildGroupEvent("第一批问题", true, "99001", "2001"))
	if !runtime.WaitForAggregates(6 * time.Second) {
		t.Fatal("等待第一批超时")
	}
	runtime.HandleEvent(buildGroupEvent("第二批问题", true, "99001", "2001"))
	if !runtime.WaitForAggregates(6 * time.Second) {
		t.Fatal("等待第二批超时")
	}
	if len(model.requests) != 2 {
		t.Fatalf("两批应各自调用一次模型，实际 %d 次", len(model.requests))
	}
	if len(bot.groupSent) != 2 {
		t.Fatalf("两批应各发一条回复，实际 %d 条", len(bot.groupSent))
	}
}

// TestAggregateDisabledProcessesImmediately 守护 windowMs=0 的直通语义。
func TestAggregateDisabledProcessesImmediately(t *testing.T) {
	model := &fakeModel{replies: []string{"立即回复"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sessionMode": "user_persistent", "requireAtInGroup": true,
			"allowedGroups": []any{"99001"}, "model": "test-model",
			"bufferWindowMs": 0, "replyDelayMs": 0,
		},
	}, model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("应处理消息")
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("关闭聚合时应立即回复，实际 %d 条", len(bot.groupSent))
	}
}

// TestAggregateRespectsLLMGate 守护聚合与 LLM 开关的组合：关闭时既不缓冲也不回复。
func TestAggregateRespectsLLMGate(t *testing.T) {
	model := &fakeModel{replies: []string{"不该出现"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"runtime": map[string]any{"llmEnabled": false},
		"chat": map[string]any{
			"sessionMode": "user_persistent", "requireAtInGroup": true,
			"allowedGroups": []any{"99001"}, "model": "test-model",
			"bufferWindowMs": 200, "replyDelayMs": 0,
		},
	}, model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); handled {
		t.Fatal("LLM 关闭时不应处理消息")
	}
	if !runtime.WaitForAggregates(2 * time.Second) {
		t.Fatal("等待超时")
	}
	if len(model.requests) != 0 || len(bot.groupSent) != 0 {
		t.Fatalf("LLM 关闭时不应产生请求或回复: %d/%d", len(model.requests), len(bot.groupSent))
	}
}

// TestAggregateFlushOnDemand 守护退出前的冲刷能力。
func TestAggregateFlushOnDemand(t *testing.T) {
	model := &fakeModel{replies: []string{"冲刷回复"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sessionMode": "user_persistent", "requireAtInGroup": true,
			"allowedGroups": []any{"99001"}, "model": "test-model",
			"bufferWindowMs": 60000, "replyDelayMs": 0,
		},
		"ai": map[string]any{"providers": []any{}},
	}, model)
	runtime.logger = log.New(io.Discard, "", 0)
	runtime.HandleEvent(buildGroupEvent("待冲刷消息", true, "99001", "2001"))
	runtime.FlushAggregates()
	if len(bot.groupSent) != 1 {
		t.Fatalf("冲刷后应已回复，实际 %d 条", len(bot.groupSent))
	}
}
