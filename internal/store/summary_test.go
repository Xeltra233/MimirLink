package store

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func openSummaryDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "memory.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func seedMessages(t *testing.T, db *DB, sessionID string, count int, role string) {
	seedMessagesAt(t, db, sessionID, count, role, 0)
}

func seedMessagesAt(t *testing.T, db *DB, sessionID string, count int, role string, round int) {
	t.Helper()
	for index := 0; index < count; index += 1 {
		err := db.AppendMessage(Message{
			ID:        sessionID + "-r" + string(rune('0'+round)) + "-m" + string(rune('a'+index%26)) + string(rune('0'+index/26)),
			SessionID: sessionID,
			Role:      role,
			Content:   strings.Repeat("对话内容", 3) + string(rune('0'+index%10)),
			Timestamp: int64(1700000000000 + round*100000 + index),
			DateISO:   "2023-11-15T00:00:00.000Z",
		})
		if err != nil {
			t.Fatalf("写入消息失败: %v", err)
		}
	}
}

func TestMaybeSummarizeDisabled(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 10, "user")
	summary, err := db.MaybeSummarizeSession("s1", SummaryConfig{}, nil)
	if err != nil || summary != nil {
		t.Fatalf("未启用时应返回 nil: %+v %v", summary, err)
	}
}

func TestMaybeSummarizeNotTriggered(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 10, "user")
	summary, err := db.MaybeSummarizeSession("s1", SummaryConfig{Enabled: true, TriggerMessages: 80, KeepRecent: 30, MaxSummaries: 8, MaxSourceMessages: 50}, nil)
	if err != nil || summary != nil {
		t.Fatalf("未达阈值不应触发: %+v %v", summary, err)
	}
}

func TestMaybeSummarizeWithAICallback(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 12, "user")
	// trigger=5 keepRecent=2 → source=10 条进入摘要
	summary, err := db.MaybeSummarizeSession("s1", SummaryConfig{Enabled: true, TriggerMessages: 5, KeepRecent: 2, MaxSummaries: 8, MaxSourceMessages: 50},
		func(source []Message, sessionID string, previous []Summary) (string, error) {
			return "AI 摘要：" + sessionID + " 共" + string(rune('0'+len(source))) + "条", nil
		})
	if err != nil {
		t.Fatalf("摘要失败: %v", err)
	}
	if summary == nil || !strings.HasPrefix(summary.Content, "AI 摘要：") || summary.ID[:8] != "summary_" {
		t.Fatalf("AI 摘要未生效: %+v", summary)
	}
	if summary.SourceCount != 10 {
		t.Fatalf("来源条数应 10: %d", summary.SourceCount)
	}
	// 来源消息已删除，只剩 keepRecent 条
	count, err := db.SessionMessageCount("s1")
	if err != nil || count != 2 {
		t.Fatalf("摘要后消息数应 2: %d %v", count, err)
	}
	// 摘要已落库
	summaries, err := db.ListSummaries("s1")
	if err != nil || len(summaries) != 1 || summaries[0].Content != summary.Content {
		t.Fatalf("摘要未落库: %+v %v", summaries, err)
	}
	// summary_count 已更新
	var summaryCount int64
	if err := db.handle.QueryRow(`SELECT summary_count FROM sessions WHERE id = ?`, "s1").Scan(&summaryCount); err != nil || summaryCount != 1 {
		t.Fatalf("summary_count 未更新: %d %v", summaryCount, err)
	}
}

func TestMaybeSummarizeFallbackOnError(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 8, "assistant")
	summary, err := db.MaybeSummarizeSession("s1", SummaryConfig{Enabled: true, TriggerMessages: 5, KeepRecent: 2, MaxSummaries: 8, MaxSourceMessages: 50},
		func(source []Message, sessionID string, previous []Summary) (string, error) {
			return "", errors.New("ai 摘要失败")
		})
	if err != nil {
		t.Fatalf("回退摘要不应报错: %v", err)
	}
	if summary == nil || !strings.Contains(summary.Content, "会话 s1 的历史摘要") || !strings.Contains(summary.Content, "助手侧回应") {
		t.Fatalf("应回退到规则摘要: %+v", summary)
	}
}

func TestMaybeSummarizePrunesOldSummaries(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 6, "user")
	config := SummaryConfig{Enabled: true, TriggerMessages: 5, KeepRecent: 2, MaxSummaries: 2, MaxSourceMessages: 50}
	for round := 0; round < 3; round += 1 {
		// 每轮触发前补足消息（前一轮删掉了来源）
		seedMessagesAt(t, db, "s1", 5, "user", round+10)
		summary, err := db.MaybeSummarizeSession("s1", config, nil)
		if err != nil || summary == nil {
			t.Fatalf("第 %d 轮应触发: %+v %v", round, summary, err)
		}
	}
	summaries, err := db.ListSummaries("s1")
	if err != nil {
		t.Fatalf("读取摘要失败: %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("超过 maxSummaries 应裁剪到 2: %d", len(summaries))
	}
}

func TestNormalizeSummaryConfigDefaults(t *testing.T) {
	config := NormalizeSummaryConfig(map[string]any{"enabled": true})
	if config.TriggerMessages != 80 || config.KeepRecent != 30 || config.MaxSummaries != 8 || config.MaxSourceMessages != 50 {
		t.Fatalf("默认值异常: %+v", config)
	}
	if !config.UseAI() {
		t.Fatalf("默认 useAI 应为 true")
	}

	disabledConfig := NormalizeSummaryConfig(map[string]any{"enabled": true, "useAI": false})
	if disabledConfig.UseAI() {
		t.Fatalf("useAI: false 应关闭 AI 摘要")
	}
}

func TestMaybeSummarizeDisableAI(t *testing.T) {
	db := openSummaryDB(t)
	seedMessages(t, db, "s1", 10, "user")
	called := false
	summary, err := db.MaybeSummarizeSession("s1", SummaryConfig{
		Enabled:           true,
		TriggerMessages:   5,
		KeepRecent:        2,
		MaxSummaries:      8,
		MaxSourceMessages: 50,
		DisableAI:         true,
	}, func(source []Message, sessionID string, previous []Summary) (string, error) {
		called = true
		return "不应被调用", nil
	})
	if err != nil || summary == nil {
		t.Fatalf("摘要触发异常: %v", err)
	}
	if called {
		t.Fatalf("DisableAI 为 true 时不应调用 AI summarizer 回调")
	}
	if !strings.Contains(summary.Content, "历史摘要") {
		t.Fatalf("应回退为规则摘要，实际内容: %s", summary.Content)
	}
}

func TestFallbackSummaryTrivialFilter(t *testing.T) {
	messages := []Message{
		{Role: "user", Content: "在吗"},
		{Role: "user", Content: "我想预定明天下午三点在王城中央广场的会议室"},
		{Role: "assistant", Content: "好的"},
		{Role: "assistant", Content: "已为您登记王城中央广场三号会议室，请准时参加。"},
	}
	summary := buildFallbackSummary("s_test", messages)
	if strings.Contains(summary, "在吗") {
		t.Fatalf("有实质内容时不应保留无意义寒暄: %s", summary)
	}
	if strings.Contains(summary, "好的") {
		t.Fatalf("有实质内容时不应保留纯肯定答复: %s", summary)
	}
	if !strings.Contains(summary, "我想预定明天下午三点") || !strings.Contains(summary, "已为您登记王城中央广场") {
		t.Fatalf("应保留关键事实内容: %s", summary)
	}
}
