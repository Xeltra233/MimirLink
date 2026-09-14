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
