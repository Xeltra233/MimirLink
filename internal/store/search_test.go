package store

import (
	"strings"
	"testing"
)

// TestSearchMessages：全局聊天记录搜索（LIKE 子串、时间倒序、limit）。
func TestSearchMessages(t *testing.T) {
	db := openSummaryDB(t)
	base := int64(1789310000000)
	entries := []struct {
		session string
		role    string
		content string
		offset  int64
	}{
		{"s1", "user", "今天天气不错", 1},
		{"s1", "assistant", "是啊，适合出门", 2},
		{"s2", "user", "帮我搜一下天气 API", 3},
		{"s2", "assistant", "已找到天气接口文档", 4},
		{"s3", "user", "无关消息", 5},
	}
	for _, entry := range entries {
		if err := db.AppendMessage(Message{
			ID: "m-" + entry.session + "-" + strings.TrimSpace(strings.ReplaceAll(entry.content, " ", "")),
			SessionID: entry.session, Role: entry.role, Content: entry.content,
			Timestamp: base + entry.offset, DateISO: "2026-09-14",
		}); err != nil {
			t.Fatalf("写入失败: %v", err)
		}
	}

	// 子串命中 3 条（s1 两条 + s2 一条），时间倒序
	results, err := db.SearchMessages("天气", 10)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(results) != 3 {
		t.Fatalf("应命中 3 条，实际 %d：%v", len(results), results)
	}
	if results[0].Content != "已找到天气接口文档" {
		t.Fatalf("应按时间倒序，最新在前：%s", results[0].Content)
	}

	// limit 生效
	limited, err := db.SearchMessages("天气", 2)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(limited) != 2 {
		t.Fatalf("limit=2 应只返回 2 条，实际 %d", len(limited))
	}

	// 无命中
	none, err := db.SearchMessages("不存在的关键词", 10)
	if err != nil || len(none) != 0 {
		t.Fatalf("无命中应返回空，err=%v len=%d", err, len(none))
	}

	// 空查询返回空
	empty, err := db.SearchMessages("  ", 10)
	if err != nil || len(empty) != 0 {
		t.Fatalf("空查询应返回空，err=%v len=%d", err, len(empty))
	}
}
