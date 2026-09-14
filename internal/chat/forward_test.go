package chat

import (
	"strings"
	"testing"
)

// TestRenderForwardMultiLevelNesting：多层嵌套转发按 chat.forwardMaxDepth 递归展开。
func TestRenderForwardMultiLevelNesting(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"forwardMaxDepth": 3}}, &fakeModel{replies: []string{"ok"}})
	// 第三层（最深）
	bot.forwards["fw-3"] = map[string]any{
		"messages": []any{
			map[string]any{"nickname": "老三", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "第三层内容"}}}},
		},
	}
	// 第二层引用第三层
	bot.forwards["fw-2"] = map[string]any{
		"messages": []any{
			map[string]any{"nickname": "老二", "message": []any{
				map[string]any{"type": "text", "data": map[string]any{"text": "第二层内容"}},
				map[string]any{"type": "forward", "data": map[string]any{"id": "fw-3"}},
			}},
		},
	}
	// 第一层引用第二层
	bot.forwards["fw-1"] = map[string]any{
		"messages": []any{
			map[string]any{"nickname": "老大", "message": []any{
				map[string]any{"type": "text", "data": map[string]any{"text": "第一层内容"}},
				map[string]any{"type": "forward", "data": map[string]any{"id": "fw-2"}},
			}},
		},
	}
	rendered := runtime.renderForward("fw-1")
	for _, expected := range []string{"第一层内容", "第二层内容", "第三层内容"} {
		if !strings.Contains(rendered, expected) {
			t.Fatalf("嵌套展开应包含 %q，实际：%s", expected, rendered)
		}
	}
	if strings.Count(rendered, "第三层内容") != 1 {
		t.Fatalf("最深层内容不应重复渲染：%s", rendered)
	}
	if strings.Contains(rendered, "[嵌套合并转发聊天记录]") {
		t.Fatalf("三层以内应全部展开，实际出现占位符：%s", rendered)
	}
}

// TestRenderForwardDepthLimit：超出深度上限退化为占位符（对齐 Node 单层行为）。
func TestRenderForwardDepthLimit(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"forwardMaxDepth": 1}}, &fakeModel{replies: []string{"ok"}})
	bot.forwards["fw-outer"] = map[string]any{
		"messages": []any{
			map[string]any{"nickname": "甲", "message": []any{
				map[string]any{"type": "text", "data": map[string]any{"text": "外层"}},
				map[string]any{"type": "forward", "data": map[string]any{"id": "fw-inner"}},
			}},
		},
	}
	bot.forwards["fw-inner"] = map[string]any{
		"messages": []any{map[string]any{"nickname": "乙", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "内层"}}}}},
	}
	rendered := runtime.renderForward("fw-outer")
	if !strings.Contains(rendered, "外层") {
		t.Fatalf("第一层应展开：%s", rendered)
	}
	if !strings.Contains(rendered, "[嵌套合并转发聊天记录]") || strings.Contains(rendered, "内层") {
		t.Fatalf("深度=1 时第二层应为占位符（Node 行为）：%s", rendered)
	}
}

// TestRenderForwardCycleGuard：转发循环引用不应死循环或重复拉取。
func TestRenderForwardCycleGuard(t *testing.T) {
	runtime, bot, _ := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	bot.forwards["fw-a"] = map[string]any{
		"messages": []any{map[string]any{"nickname": "甲", "message": []any{
			map[string]any{"type": "text", "data": map[string]any{"text": "A 层"}},
			map[string]any{"type": "forward", "data": map[string]any{"id": "fw-b"}},
		}}},
	}
	bot.forwards["fw-b"] = map[string]any{
		"messages": []any{map[string]any{"nickname": "乙", "message": []any{
			map[string]any{"type": "text", "data": map[string]any{"text": "B 层"}},
			map[string]any{"type": "forward", "data": map[string]any{"id": "fw-a"}},
		}}},
	}
	rendered := runtime.renderForward("fw-a")
	if !strings.Contains(rendered, "循环引用") {
		t.Fatalf("循环引用应被标记：%s", rendered)
	}
	if strings.Count(rendered, "A 层") != 1 {
		t.Fatalf("A 层只应展开一次（防重复拉取）：%s", rendered)
	}
}

// TestRenderForwardBudget：单层节点数与字符预算（对齐 Node 30 节点 / 2500 字符）。
func TestRenderForwardBudget(t *testing.T) {
	runtime, bot, _ := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	nodes := []any{}
	for i := 0; i < 40; i++ {
		nodes = append(nodes, map[string]any{"nickname": "刷屏", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "很长的消息内容占位文本"}}}})
	}
	bot.forwards["fw-big"] = map[string]any{"messages": nodes}
	rendered := runtime.renderForward("fw-big")
	if !strings.Contains(rendered, "已截断") {
		t.Fatalf("超预算应出现截断提示：%s", rendered)
	}
}
