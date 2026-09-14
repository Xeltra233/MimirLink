package store

import (
	"path/filepath"
	"testing"
)

func newPanelOpsDB(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "memory.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	return db
}

func TestVariableUpsertAndList(t *testing.T) {
	db := newPanelOpsDB(t)
	scope := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "default", CharacterName: "测试角色"}

	id, created, err := db.UpsertVariable(scope, Variable{Key: "好感度", Value: "42", ValueType: "number", Tags: []string{"系统"}})
	if err != nil || created != false && id == "" {
		t.Fatalf("首次 upsert 失败: %v created=%v", err, created)
	}
	if created {
		t.Fatal("首次应为创建")
	}
	// 再次 upsert 同名 → 更新
	id2, updated, err := db.UpsertVariable(scope, Variable{Key: "好感度", Value: "55", ValueType: "number", Tags: []string{"手动"}})
	if err != nil {
		t.Fatalf("二次 upsert 失败: %v", err)
	}
	if !updated || id2 != id {
		t.Fatalf("应为更新: updated=%v id=%s vs %s", updated, id2, id)
	}
	items, err := db.ListVariables(VariableFilters{ScopeType: "global_shared", ScopeKey: "default", CharacterName: "测试角色"})
	if err != nil || len(items) != 1 {
		t.Fatalf("列表异常: %v len=%d", err, len(items))
	}
	if items[0].Value != float64(55) && items[0].Value != int64(55) && items[0].Value != 55 {
		t.Fatalf("value 应解析为数字: %#v", items[0].Value)
	}
	if len(items[0].Tags) != 2 {
		t.Fatalf("标签应合并并集: %v", items[0].Tags)
	}
	// 空变量名报错
	if _, _, err := db.UpsertVariable(scope, Variable{}); err == nil {
		t.Fatal("空变量名应报错")
	}
	// 删除
	deleted, err := db.DeleteVariable(id)
	if err != nil || !deleted {
		t.Fatalf("删除失败: %v %v", deleted, err)
	}
}

func TestKnowledgeListAndCreate(t *testing.T) {
	db := newPanelOpsDB(t)
	scope := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "default"}
	id, err := db.UpsertKnowledgeEntry(scope, KnowledgeEntry{Title: "门派规则", Content: "炸天帮弟子不得欺压凡人", KnowledgeType: "fixed"})
	if err != nil {
		t.Fatalf("创建知识失败: %v", err)
	}
	if id == "" {
		t.Fatal("id 为空")
	}
	items, err := db.ListKnowledgeEntriesFiltered(VariableFilters{ScopeType: "global_shared", ScopeKey: "default", KnowledgeType: "fixed"})
	if err != nil || len(items) != 1 {
		t.Fatalf("fixed 过滤异常: %v len=%d", err, len(items))
	}
	if items[0].KnowledgeType != "fixed" || items[0].EntryType != "knowledge_fixed" {
		t.Fatalf("类型映射异常: %+v", items[0])
	}
	if items[0].ContentPreview == "" {
		t.Fatal("contentPreview 为空")
	}
	// 标题/内容为空报错
	if _, err := db.UpsertKnowledgeEntry(scope, KnowledgeEntry{Title: "x"}); err == nil {
		t.Fatal("空内容应报错")
	}
}

func TestParticipantProfileDedup(t *testing.T) {
	db := newPanelOpsDB(t)
	scope := NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user_123", CharacterName: "角色A"}
	// 同一 participantId 写入两条（不同 ID），应去重取最新
	if _, err := db.AddMemoryEntry(scope, MemoryEntry{
		ID: "p1", EntryType: "participant_profile", Title: "用户123", Content: "旧档案",
		Metadata: map[string]any{"participantId": "123", "participantName": "用户123"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.AddMemoryEntry(scope, MemoryEntry{
		ID: "p2", EntryType: "participant_profile", Title: "用户123", Content: "新档案内容",
		Metadata: map[string]any{"participantId": "123", "participantName": "用户123"},
	}); err != nil {
		t.Fatal(err)
	}
	// 另一个 participantId
	if _, err := db.AddMemoryEntry(scope, MemoryEntry{
		ID: "p3", EntryType: "participant_profile", Title: "用户456", Content: "另一个档案",
		Metadata: map[string]any{"participantId": "456", "participantName": "用户456"},
	}); err != nil {
		t.Fatal(err)
	}
	items, err := db.ListParticipantProfiles(50, "")
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("应去重为 2 条, got %d", len(items))
	}
	byID := map[string]ParticipantProfile{}
	for _, item := range items {
		byID[item.ParticipantID] = item
	}
	if byID["123"].Content != "新档案内容" {
		t.Fatalf("应取最新档案: %+v", byID["123"])
	}
	total, err := db.CountParticipantProfiles("")
	if err != nil || total != 2 {
		t.Fatalf("count 异常: %v %d", err, total)
	}
	filtered, err := db.ListParticipantProfiles(50, "456")
	if err != nil || len(filtered) != 1 {
		t.Fatalf("搜索过滤异常: %v %d", err, len(filtered))
	}
}

func TestSessionDeleteAndClearHistory(t *testing.T) {
	db := newPanelOpsDB(t)
	if err := db.EnsureSession("sess-1"); err != nil {
		t.Fatal(err)
	}
	message := Message{SessionID: "sess-1", Role: "user", Content: "你好", Timestamp: 1000, DateISO: "2026-01-01T00:00:00Z"}
	if err := db.AppendMessage(message); err != nil {
		t.Fatal(err)
	}
	// 清历史：会话保留，消息清空
	if err := db.ClearHistory("sess-1"); err != nil {
		t.Fatalf("清历史失败: %v", err)
	}
	sessions, err := db.ListSessions(10)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("会话应保留: %v %d", err, len(sessions))
	}
	messages, err := db.RecentMessages("sess-1", 10)
	if err != nil || len(messages) != 0 {
		t.Fatalf("消息应清空: %v %d", err, len(messages))
	}
	// 删除会话
	if err := db.DeleteSession("sess-1"); err != nil {
		t.Fatalf("删除会话失败: %v", err)
	}
	sessions, err = db.ListSessions(10)
	if err != nil || len(sessions) != 0 {
		t.Fatalf("会话应删除: %v %d", err, len(sessions))
	}
}
