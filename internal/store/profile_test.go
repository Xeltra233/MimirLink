package store

import (
	"encoding/json"
	"testing"
	"time"
)

func TestCollectParticipantProfileSource(t *testing.T) {
	db := openSummaryDB(t)
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	// 12 条目标人物发言 + 干扰消息
	for index := 0; index < 12; index += 1 {
		metadata, _ := json.Marshal(map[string]any{"userId": "2001"})
		if err := db.AppendMessage(Message{
			ID: "a" + string(rune('a'+index)), SessionID: "s1", Role: "user",
			Content: "目标人物发言" + string(rune('a'+index)), MetadataJSON: string(metadata),
			Timestamp: int64(1700000000000 + index), DateISO: "2023-11-15T00:00:00Z",
		}); err != nil {
			t.Fatalf("写入失败: %v", err)
		}
	}
	for index := 0; index < 3; index += 1 {
		metadata, _ := json.Marshal(map[string]any{"userId": "9999"})
		if err := db.AppendMessage(Message{
			ID: "b" + string(rune('a'+index)), SessionID: "s1", Role: "user",
			Content: "其他人发言", MetadataJSON: string(metadata),
			Timestamp: int64(1700000010000 + index), DateISO: "2023-11-15T00:00:00Z",
		}); err != nil {
			t.Fatalf("写入失败: %v", err)
		}
	}

	source, err := db.CollectParticipantProfileSource("2001", NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:2001"}, ProfileSourceConfig{Threshold: 8, Limit: 50})
	if err != nil {
		t.Fatalf("采集失败: %v", err)
	}
	if !source.HasEnoughNewInfo {
		t.Fatalf("12 条锚点应达到阈值 8")
	}
	if len(source.Messages) < 12 {
		t.Fatalf("采集消息数应 >= 12: %d", len(source.Messages))
	}
	// 归因正确：只采集锚点本人（锚点+上下文可能包含干扰消息，但最后处理时间应为最后一条锚点相关消息）
	if source.LastProcessedAt == 0 {
		t.Fatalf("应记录 lastProcessedAt")
	}

	// 第二次采集：写档后 since 增量 → 无新信息
	if _, err := db.SaveParticipantProfile(NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:2001"}, "", "2001", "张三", "档案内容", []string{}, map[string]any{"lastProcessedMessageAt": float64(source.LastProcessedAt)}, "s1"); err != nil {
		t.Fatalf("保存档案失败: %v", err)
	}
	source2, err := db.CollectParticipantProfileSource("2001", NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:2001"}, ProfileSourceConfig{Threshold: 8, Limit: 50})
	if err != nil {
		t.Fatalf("二次采集失败: %v", err)
	}
	if source2.HasEnoughNewInfo || len(source2.Messages) != 0 {
		t.Fatalf("增量采集应无新信息: enough=%v count=%d", source2.HasEnoughNewInfo, len(source2.Messages))
	}
	if source2.Existing == nil || source2.Existing.Content != "档案内容" {
		t.Fatalf("应读取到已有档案: %+v", source2.Existing)
	}
}

func TestSaveParticipantProfileUpdate(t *testing.T) {
	db := openSummaryDB(t)
	namespace := NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:3001"}
	id, err := db.SaveParticipantProfile(namespace, "", "3001", "李四", "初始档案", []string{}, map[string]any{}, "")
	if err != nil {
		t.Fatalf("创建档案失败: %v", err)
	}
	updatedID, err := db.SaveParticipantProfile(namespace, id, "3001", "李四", "更新后的档案", []string{}, map[string]any{"lastProcessedMessageAt": float64(123)}, "")
	if err != nil {
		t.Fatalf("更新档案失败: %v", err)
	}
	if updatedID != id {
		t.Fatalf("更新应保持同 ID: %s vs %s", updatedID, id)
	}
	entry, err := db.GetParticipantProfileEntry(namespace, "3001")
	if err != nil || entry == nil || entry.Content != "更新后的档案" {
		t.Fatalf("更新未生效: %+v %v", entry, err)
	}
	// 去重列表应只有一条
	profiles, err := db.ListParticipantProfiles(10, "")
	if err != nil {
		t.Fatalf("列表失败: %v", err)
	}
	count := 0
	for _, profile := range profiles {
		if profile.ParticipantID == "3001" {
			count += 1
		}
	}
	if count != 1 {
		t.Fatalf("同 participantId 应去重为 1 条: %d", count)
	}
	_ = time.Now()
}
