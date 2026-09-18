package store

import (
	"os"
	"path/filepath"
	"testing"
)

// 记忆召回打分与 Node recallMemory 对齐：固定知识 120+、画像 80+、关键词命中 +8/个。
func TestRecallMemoryScoringAndOrder(t *testing.T) {
	directory := t.TempDir()
	db, err := Open(filepath.Join(directory, "memory.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	defer db.Close()
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	namespace := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: "测试角色"}

	// 固定知识：基础分 120 + 命中加分
	if _, err := db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "k1", EntryType: "knowledge_fixed", Title: "门派规则", Content: "徐缺是炸天帮的掌门",
	}); err != nil {
		t.Fatalf("写入固定知识失败: %v", err)
	}
	// 动态知识
	if _, err := db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "k2", EntryType: "knowledge_dynamic", Title: "临时设定", Content: "徐缺今天带了把刀",
	}); err != nil {
		t.Fatalf("写入动态知识失败: %v", err)
	}
	// 参与者画像：基础分 80
	if _, err := db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "p1", EntryType: "participant_profile", Title: "画像", Content: "该用户是活跃的表演型人格",
	}); err != nil {
		t.Fatalf("写入画像失败: %v", err)
	}
	// 普通记忆（关键词命中）
	if _, err := db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "m1", EntryType: "conversation", Title: "聊天", Content: "用户: 徐缺在吗",
	}); err != nil {
		t.Fatalf("写入记忆失败: %v", err)
	}
	// 无关记忆（仅靠 recent 入选）
	if _, err := db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "m2", EntryType: "conversation", Title: "闲聊", Content: "今天天气不错",
	}); err != nil {
		t.Fatalf("写入记忆失败: %v", err)
	}

	results, err := db.RecallMemory(namespace, "徐缺", DefaultRecallOptions)
	if err != nil {
		t.Fatalf("召回失败: %v", err)
	}
	if len(results) == 0 {
		t.Fatalf("召回结果为空")
	}
	ranked := map[string]int{}
	for _, entry := range results {
		ranked[entry.ID] = entry.RecallScore
	}
	// 固定知识：知识 120 + 未命中基准 20 + 命中"徐缺" * 8 = 148
	if ranked["k1"] != 148 {
		t.Fatalf("固定知识得分不符: %d（期望 148）", ranked["k1"])
	}
	// 动态知识命中（在 recent 里匹配到 → 命中基准 50）：70 + 50 + 8 = 128
	if ranked["k2"] != 128 {
		t.Fatalf("动态知识得分不符: %d（期望 128）", ranked["k2"])
	}
	// 画像：画像 80 + 基准 20 = 100（内容无"徐缺"）
	if ranked["p1"] != 100 {
		t.Fatalf("画像得分不符: %d（期望 100）", ranked["p1"])
	}
	// 普通命中记忆：50 + 8 = 58
	if ranked["m1"] != 58 {
		t.Fatalf("命中记忆得分不符: %d（期望 58）", ranked["m1"])
	}
	// 排序：k1 > p1 > k2 > m1
	if results[0].ID != "k1" {
		t.Fatalf("首条应为固定知识，实际 %s", results[0].ID)
	}
	if results[0].RecallReason != "fixed_knowledge" || results[0].SourceKind != "knowledge_fixed" {
		t.Fatalf("固定知识标记不符: %s/%s", results[0].SourceKind, results[0].RecallReason)
	}

	found := map[string]string{}
	for _, entry := range results {
		found[entry.ID] = entry.RecallReason
	}
	if found["m1"] != "keyword_match" {
		t.Fatalf("命中记忆的召回原因应为 keyword_match，实际 %s", found["m1"])
	}
	if found["p1"] != "participant_profile" {
		t.Fatalf("画像召回原因不符: %s", found["p1"])
	}
}

// 未创建的命名空间在只读库上应安全返回空（不报错、不写库）。
func TestRecallOnMissingNamespaceReturnsEmpty(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "memory.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	_ = db.Close()

	readonly, err := OpenReadOnly(path)
	if err != nil {
		t.Fatalf("只读打开失败: %v", err)
	}
	defer readonly.Close()

	results, err := readonly.RecallMemory(NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:9999"}, "任意", DefaultRecallOptions)
	if err != nil {
		t.Fatalf("只读召回不应报错: %v", err)
	}
	if len(results) != 0 {
		t.Fatalf("不存在的命名空间应返回空，实际 %d 条", len(results))
	}
}

// 相对路径必须能打开（DSN 需先转绝对路径，否则 Windows 会当成盘符根目录）。
func TestOpenWithRelativePath(t *testing.T) {
	directory := t.TempDir()
	t.Chdir(directory)
	if err := os.MkdirAll("nested", 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	db, err := Open(filepath.Join("nested", "memory.sqlite"))
	if err != nil {
		t.Fatalf("相对路径打开失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := db.Counts(); err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	_ = db.Close()
}

// 关键词切分与 Node buildKeywordsFromText 对齐（中文连续串不切分、长度>=2）。
func TestBuildKeywordsFromText(t *testing.T) {
	keywords := BuildKeywordsFromText("徐缺 is a BIG boss, 1234!", 8)
	found := map[string]bool{}
	for _, keyword := range keywords {
		found[keyword] = true
	}
	if !found["徐缺"] {
		t.Fatalf("应保留中文关键词，实际: %v", keywords)
	}
	if !found["is"] || !found["big"] || !found["boss"] || !found["1234"] {
		t.Fatalf("英文/数字关键词缺失: %v", keywords)
	}
	if found["a"] {
		t.Fatalf("单字符关键词应被过滤: %v", keywords)
	}
}

// NamespaceID 需与 Node 的 ns_<scopeType>_<base64url(scopeKey|character|preset)> 一致。
func TestNamespaceIDMatchesNode(t *testing.T) {
	id := NamespaceID(NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: "炸天帮徐缺（QQbot）"})
	expected := "ns_global_shared_Z2xvYmFsX3NoYXJlZF9tZW1vcnl854K45aSp5biu5b6Q57y677yIUVFib3TvvIl8"
	if id != expected {
		t.Fatalf("命名空间 ID 与 Node 不一致:\n实际: %s\n期望: %s", id, expected)
	}
}

// TestRecallParticipantProfileIsolation 验证画像召回隔离：只召回当前用户画像，且尊重 injectEnabled 与黑名单。
func TestRecallParticipantProfileIsolation(t *testing.T) {
	directory := t.TempDir()
	db, err := Open(filepath.Join(directory, "memory.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	defer db.Close()
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	namespace := NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: "测试角色"}

	// 用户 A 的画像
	_, _ = db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "p_user_a", EntryType: "participant_profile", Title: "用户A画像", Content: "用户A是活跃成员",
		Metadata: map[string]any{"participantId": "user_a"},
	})
	// 用户 B 的画像
	_, _ = db.AddMemoryEntry(namespace, MemoryEntry{
		ID: "p_user_b", EntryType: "participant_profile", Title: "用户B画像", Content: "用户B是潜水成员",
		Metadata: map[string]any{"participantId": "user_b"},
	})

	// 1. 指定当前发言人为 user_a，只应召回 user_a 画像，排除 user_b
	optsA := DefaultRecallOptions
	optsA.CurrentParticipantID = "user_a"
	resultsA, err := db.RecallMemory(namespace, "用户", optsA)
	if err != nil {
		t.Fatalf("召回失败: %v", err)
	}
	hasA, hasB := false, false
	for _, entry := range resultsA {
		if entry.ID == "p_user_a" {
			hasA = true
		}
		if entry.ID == "p_user_b" {
			hasB = true
		}
	}
	if !hasA || hasB {
		t.Fatalf("画像隔离异常: 期望只包含 user_a，实际 hasA=%v hasB=%v", hasA, hasB)
	}

	// 2. injectEnabled 为 false 时，不召回任何画像
	disabled := false
	optsDisabled := DefaultRecallOptions
	optsDisabled.CurrentParticipantID = "user_a"
	optsDisabled.InjectEnabled = &disabled
	resultsDisabled, _ := db.RecallMemory(namespace, "用户", optsDisabled)
	for _, entry := range resultsDisabled {
		if entry.EntryType == "participant_profile" {
			t.Fatalf("injectEnabled=false 时不应召回画像: %+v", entry)
		}
	}

	// 3. 黑名单中的用户画像不被召回
	optsBlacklist := DefaultRecallOptions
	optsBlacklist.CurrentParticipantID = "user_a"
	optsBlacklist.Blacklist = map[string]bool{"user_a": true}
	resultsBlacklist, _ := db.RecallMemory(namespace, "用户", optsBlacklist)
	for _, entry := range resultsBlacklist {
		if entry.ID == "p_user_a" {
			t.Fatalf("黑名单中的用户画像不应被召回")
		}
	}
}
