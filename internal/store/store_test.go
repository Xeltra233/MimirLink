package store

import (
	"path/filepath"
	"testing"
)

func TestEnsureSchemaMatchesNodeTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory-store.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer db.Close()

	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	names, err := db.TableNames()
	if err != nil {
		t.Fatalf("读取表清单失败: %v", err)
	}
	expected := []string{
		"memory_entries",
		"memory_namespaces",
		"messages",
		"sessions",
		"sticky_entries",
		"summaries",
		"summary_index_entries",
	}
	if len(names) != len(expected) {
		t.Fatalf("表数量不符: %v", names)
	}
	for index, name := range expected {
		if names[index] != name {
			t.Fatalf("表名不符，期望 %v，实际 %v", expected, names)
		}
	}
	// 幂等：重复建表不应报错
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("重复建表失败: %v", err)
	}
}

func TestCountsAndRecentMessages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "memory-store.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer db.Close()
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}

	if _, err := db.handle.Exec(`
		INSERT INTO sessions (id, created_at, last_active, message_count, summary_count)
		VALUES ('s1', 1000, 2000, 2, 0)`); err != nil {
		t.Fatalf("插入会话失败: %v", err)
	}
	if _, err := db.handle.Exec(`
		INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso)
		VALUES ('m1', 's1', 'user', '第一条', NULL, 1000, '2026-01-01T00:00:00.000Z'),
		       ('m2', 's1', 'assistant', '第二条', '{"x":1}', 2000, '2026-01-01T00:01:00.000Z')`); err != nil {
		t.Fatalf("插入消息失败: %v", err)
	}

	counts, err := db.Counts()
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if counts.Sessions != 1 || counts.Messages != 2 {
		t.Fatalf("统计结果不符: %+v", counts)
	}

	messages, err := db.RecentMessages("s1", 10)
	if err != nil {
		t.Fatalf("读取消息失败: %v", err)
	}
	if len(messages) != 2 {
		t.Fatalf("消息数量不符: %d", len(messages))
	}
	// 按 timestamp DESC 排序，最新一条在前（与 Node 版一致）
	if messages[0].ID != "m2" || messages[1].ID != "m1" {
		t.Fatalf("排序与 Node 版不一致: %+v", messages)
	}
	if messages[0].MetadataJSON != `{"x":1}` {
		t.Fatalf("metadata 读取错误: %q", messages[0].MetadataJSON)
	}

	sessions, err := db.ListSessions(10)
	if err != nil {
		t.Fatalf("读取会话失败: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != "s1" || sessions[0].MessageCount != 2 {
		t.Fatalf("会话读取错误: %+v", sessions)
	}
}

func TestCountsTolerateMissingTables(t *testing.T) {
	path := filepath.Join(t.TempDir(), "legacy.sqlite")
	db, err := Open(path)
	if err != nil {
		t.Fatalf("打开失败: %v", err)
	}
	defer db.Close()
	if _, err := db.handle.Exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER, last_active INTEGER, message_count INTEGER, summary_count INTEGER)`); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	counts, err := db.Counts()
	if err != nil {
		t.Fatalf("缺表时应按 0 处理，实际报错: %v", err)
	}
	if counts.Sessions != 0 || counts.Messages != 0 {
		t.Fatalf("统计结果不符: %+v", counts)
	}
}

func TestDiscoverMemoryDatabases(t *testing.T) {
	dataDir := t.TempDir()
	chatsDir := filepath.Join(dataDir, "chats")
	nested := filepath.Join(chatsDir, "characters")
	if err := mkdirAll(nested); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	for _, name := range []string{
		filepath.Join(chatsDir, "memory-store.sqlite"),
		filepath.Join(nested, "角色A.sqlite"),
		filepath.Join(chatsDir, "notes.txt"),
	} {
		if err := writeFile(name, "x"); err != nil {
			t.Fatalf("写入文件失败: %v", err)
		}
	}
	found, err := DiscoverMemoryDatabases(dataDir)
	if err != nil {
		t.Fatalf("扫描失败: %v", err)
	}
	if len(found) != 2 {
		t.Fatalf("扫描结果不符: %v", found)
	}
}
