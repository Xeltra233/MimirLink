package datacheck

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"mimirlink/internal/store"
)

func TestBuildReportsConfigDatabasesAndFiles(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	for _, dir := range []string{
		filepath.Join(dataDir, "chats", "characters"),
		filepath.Join(dataDir, "presets"),
		filepath.Join(dataDir, "worlds"),
		filepath.Join(dataDir, "characters"),
		filepath.Join(dataDir, "character_overrides"),
		filepath.Join(dataDir, "sessions"),
	} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
	}

	configJSON := `{
  "chat": { "model": "test-model", "dataDir": ` + quote(dataDir) + ` },
  "auth": { "enabled": false },
  "unknownKey": { "keep": true }
}`
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(configJSON), 0o644); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}

	// 一个真实的记忆库（用与 Node 版一致的建表语句）
	dbPath := filepath.Join(dataDir, "chats", "memory-store.sqlite")
	db, err := store.Open(dbPath)
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if err := seed(db); err != nil {
		t.Fatalf("写入测试数据失败: %v", err)
	}
	_ = db.Close()

	// 文件计数夹具
	writeCountedFiles(t, filepath.Join(dataDir, "presets"), ".json", 3)
	writeCountedFiles(t, filepath.Join(dataDir, "worlds"), ".json", 2)
	writeCountedFiles(t, filepath.Join(dataDir, "characters"), ".png", 1)
	writeCountedFiles(t, filepath.Join(dataDir, "character_overrides"), ".json", 1)
	writeCountedFiles(t, filepath.Join(dataDir, "sessions"), ".json", 4)

	report, err := Build(root)
	if err != nil {
		t.Fatalf("盘点失败: %v", err)
	}
	if report.Config.Model != "test-model" {
		t.Fatalf("模型读取错误: %q", report.Config.Model)
	}
	if len(report.Config.TopLevelKeys) != 3 {
		t.Fatalf("顶层键数量错误: %v", report.Config.TopLevelKeys)
	}
	if len(report.Databases) != 1 {
		t.Fatalf("记忆库数量错误: %d", len(report.Databases))
	}
	counts := report.Databases[0].Counts
	if counts.Sessions != 1 || counts.Messages != 2 || counts.MemoryEntries != 1 {
		t.Fatalf("记忆库统计错误: %+v", counts)
	}
	if report.Files.Presets != 3 || report.Files.Worlds != 2 || report.Files.Characters != 1 ||
		report.Files.CharacterOverrides != 1 || report.Files.Sessions != 4 {
		t.Fatalf("文件计数错误: %+v", report.Files)
	}

	// JSON 输出应可被 Node 侧解析（字段名一致）
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	if len(encoded) == 0 {
		t.Fatalf("序列化结果为空")
	}
	if report.Summary() == "" {
		t.Fatalf("摘要输出为空")
	}
}

func TestBuildMissingConfig(t *testing.T) {
	if _, err := Build(t.TempDir()); err == nil {
		t.Fatalf("缺少 config.json 时应报错")
	}
}

func quote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func writeCountedFiles(t *testing.T, dir string, suffix string, total int) {
	t.Helper()
	for index := 0; index < total; index += 1 {
		name := filepath.Join(dir, "item-"+string(rune('a'+index))+suffix)
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatalf("写入文件失败: %v", err)
		}
	}
}

func seed(db *store.DB) error {
	statements := []string{
		`INSERT INTO sessions (id, created_at, last_active, message_count, summary_count) VALUES ('s1', 1, 2, 2, 0)`,
		`INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso) VALUES ('m1', 's1', 'user', 'hi', NULL, 1, '2026-01-01T00:00:00.000Z')`,
		`INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso) VALUES ('m2', 's1', 'assistant', 'hello', NULL, 2, '2026-01-01T00:00:01.000Z')`,
		`INSERT INTO memory_namespaces (id, scope_type, scope_key, character_name, preset_name, created_at, updated_at) VALUES ('ns1', 'global', 'g', NULL, NULL, 1, 2)`,
		`INSERT INTO memory_entries (id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at) VALUES ('e1', 'ns1', 's1', 'm1', 'note', 't', 'c', NULL, NULL, 1, 2)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}
