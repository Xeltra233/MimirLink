package store

import "testing"

// TestKnowledgeEntryLookupByID 守护 goal-36 UI 验证发现的 SQL 列数不匹配缺陷：
// GetKnowledgeEntry 曾复用不含 entry_type 的列集，导致扫描 15 个目标却只有 14 列。
func TestKnowledgeEntryLookupByID(t *testing.T) {
	database := newPanelOpsDB(t)
	options := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory"}
	id, err := database.UpsertKnowledgeEntry(options, KnowledgeEntry{
		Title: "测试知识", Content: "测试内容", KnowledgeType: "fixed", Tags: []string{"tag"},
	})
	if err != nil {
		t.Fatalf("创建知识条目失败: %v", err)
	}
	item, err := database.GetKnowledgeEntry(id)
	if err != nil {
		t.Fatalf("按 ID 读取知识条目失败: %v", err)
	}
	if item == nil {
		t.Fatal("知识条目为空")
	}
	if item.Title != "测试知识" || item.Content != "测试内容" || item.EntryType != "knowledge_fixed" {
		t.Fatalf("知识条目字段异常: %#v", item)
	}
	if item.KnowledgeType != "fixed" {
		t.Fatalf("knowledgeType 归一化异常: %q", item.KnowledgeType)
	}
	deleted, err := database.DeleteKnowledgeEntry(id)
	if err != nil || !deleted {
		t.Fatalf("删除知识条目失败: deleted=%v err=%v", deleted, err)
	}
	if after, err := database.GetKnowledgeEntry(id); err != nil || after != nil {
		t.Fatalf("删除后仍能读到: %#v err=%v", after, err)
	}
}

// TestParticipantProfileLookupAndDelete 守护人物档案按 ID 读取/删除链路。
func TestParticipantProfileLookupAndDelete(t *testing.T) {
	database := newPanelOpsDB(t)
	options := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory"}
	id, err := database.SaveParticipantProfile(options, "", "10001", "测试人物", "档案内容", []string{"t"}, map[string]any{"participantId": "10001"}, "")
	if err != nil {
		t.Fatalf("写入人物档案失败: %v", err)
	}
	item, err := database.GetParticipantProfileByEntryID(id)
	if err != nil || item == nil {
		t.Fatalf("读取人物档案失败: %#v err=%v", item, err)
	}
	if item.Title != "测试人物" || item.Content != "档案内容" {
		t.Fatalf("人物档案字段异常: %#v", item)
	}
	deleted, err := database.DeleteParticipantProfile(id)
	if err != nil || !deleted {
		t.Fatalf("删除人物档案失败: deleted=%v err=%v", deleted, err)
	}
}

// TestClearAllData 守护面板「清空所有数据」的语义（对齐 Node clearAllData）：
// 旧 Go 实现忽略 confirm 且只删文件，接口返回成功但数据仍在（假成功）。
func TestClearAllData(t *testing.T) {
	database := newPanelOpsDB(t)
	options := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_memory"}
	if _, err := database.AddMemoryEntry(options, MemoryEntry{EntryType: "variable", Title: "k", Content: "v"}); err != nil {
		t.Fatalf("写入变量失败: %v", err)
	}
	if _, err := database.UpsertKnowledgeEntry(options, KnowledgeEntry{Title: "知识", Content: "内容", KnowledgeType: "fixed"}); err != nil {
		t.Fatalf("写入知识失败: %v", err)
	}
	if _, err := database.SaveParticipantProfile(options, "", "10001", "人物", "档案内容", nil, nil, ""); err != nil {
		t.Fatalf("写入档案失败: %v", err)
	}
	cleared, err := database.ClearAllData()
	if err != nil {
		t.Fatalf("清空失败: %v", err)
	}
	if cleared["variables"] < 1 || cleared["knowledge"] < 1 || cleared["profiles"] < 1 || cleared["namespaces"] < 1 {
		t.Fatalf("清空计数异常: %#v", cleared)
	}
	items, err := database.ListVariables(VariableFilters{ScopeType: "global_shared", ScopeKey: "global_memory"})
	if err != nil || len(items) != 0 {
		t.Fatalf("变量未清空: %d err=%v", len(items), err)
	}
	knowledge, err := database.ListKnowledgeEntriesFiltered(VariableFilters{Limit: 10})
	if err != nil || len(knowledge) != 0 {
		t.Fatalf("知识未清空: %d err=%v", len(knowledge), err)
	}
	profiles, err := database.ListParticipantProfiles(10, "")
	if err != nil || len(profiles) != 0 {
		t.Fatalf("人物档案未清空: %d err=%v", len(profiles), err)
	}
}

// TestMessageTimeRange 校验消息表时间范围查询（基于 timestamp 列）。
func TestMessageTimeRange(t *testing.T) {
	database := newPanelOpsDB(t)
	if err := database.AppendMessage(Message{ID: "m1", SessionID: "s1", Role: "user", Content: "消息1", Timestamp: 1000, DateISO: "2026-01-01T00:00:00Z"}); err != nil {
		t.Fatalf("添加消息失败: %v", err)
	}
	if err := database.AppendMessage(Message{ID: "m2", SessionID: "s1", Role: "assistant", Content: "消息2", Timestamp: 2000, DateISO: "2026-01-01T00:00:01Z"}); err != nil {
		t.Fatalf("添加消息失败: %v", err)
	}
	oldest, newest := database.MessageTimeRange()
	if oldest != 1000 || newest != 2000 {
		t.Fatalf("时间范围异常: oldest=%d, newest=%d", oldest, newest)
	}
}
