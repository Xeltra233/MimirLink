package backup

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

func buildFixtureRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	for _, dir := range []string{"chats/characters", "presets", "worlds", "characters", "character_overrides"} {
		if err := os.MkdirAll(filepath.Join(dataDir, dir), 0o755); err != nil {
			t.Fatalf("创建目录失败: %v", err)
		}
	}
	configJSON := `{
  "auth": { "enabled": false, "password": "local-password" },
  "server": { "port": 18081, "host": "127.0.0.1" },
  "ai": {
    "apiKey": "sk-local",
    "providers": [
      { "id": "keep", "apiKey": "sk-keep" },
      { "id": "local-only", "apiKey": "sk-local-only" }
    ]
  },
  "chat": { "model": "test-model", "dataDir": ` + quote(dataDir) + ` },
  "bindings": { "global": { "worldbook": "w.json" }, "characters": { "角色A": { "regexRules": [] } } },
  "regex": { "enabled": true },
  "imports": { "regexFiles": [{ "id": "r1", "rules": [{ "name": "规则1" }] }] },
  "mcp": { "client": { "servers": [] } }
}`
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(configJSON), 0o644); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}

	db, err := store.Open(filepath.Join(dataDir, "chats", "memory-store.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, created_at, last_active, message_count, summary_count) VALUES ('s1', 1, 2, 1, 0)`); err != nil {
		t.Fatalf("写入会话失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso) VALUES ('m1','s1','user','hi',NULL,1,'2026-01-01T00:00:00.000Z')`); err != nil {
		t.Fatalf("写入消息失败: %v", err)
	}
	_ = db.Close()

	for name, content := range map[string]string{
		"presets/preset-1.json":          `{"name":"预设1"}`,
		"presets/local-only-preset.json": `{"name":"本地独有"}`,
		"worlds/世界书.json":                `{"name":"世界"}`,
		"characters/角色A.png":             "png-bytes",
		"character_overrides/角色A.json":   `{"name":"角色A"}`,
	} {
		if err := os.WriteFile(filepath.Join(dataDir, filepath.FromSlash(name)), []byte(content), 0o644); err != nil {
			t.Fatalf("写入夹具失败: %v", err)
		}
	}
	return root
}

func quote(value string) string {
	return `"` + filepath.ToSlash(value) + `"`
}

func TestExportInspectRestoreRoundTrip(t *testing.T) {
	root := buildFixtureRoot(t)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	options := Options{RootDir: root, IncludeKeys: true, Now: time.Date(2026, 9, 13, 12, 0, 0, 0, time.UTC)}
	if err := Export(options, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	if err := file.Close(); err != nil {
		t.Fatalf("关闭归档失败: %v", err)
	}

	found, err := Inspect(archive)
	if err != nil {
		t.Fatalf("识别失败: %v", err)
	}
	expected := []string{"config", "bindings", "characters", "worldbooks", "memory", "presets", "regex"}
	if len(found) != len(expected) {
		t.Fatalf("识别分类数量不符: %v", found)
	}
	for index, item := range expected {
		if found[index] != item {
			t.Fatalf("识别分类不符，期望 %v 实际 %v", expected, found)
		}
	}
}

func TestRestoreOverwritesBackupDataAndKeepsLocalFiles(t *testing.T) {
	source := buildFixtureRoot(t)
	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	if err := Export(Options{RootDir: source, IncludeKeys: true}, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	_ = file.Close()

	// 目标环境：不同的配置（不同 apiKey / server），并带一个备份中不存在的预设
	target := buildFixtureRoot(t)
	targetConfigPath := filepath.Join(target, "config.json")
	document, err := config.Load(targetConfigPath)
	if err != nil {
		t.Fatalf("读取目标配置失败: %v", err)
	}
	_ = document.Set("ai.apiKey", "sk-target")
	_ = document.Set("server.port", 19191)
	_ = document.Set("chat.model", "target-model")
	if err := document.Save(); err != nil {
		t.Fatalf("保存目标配置失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(target, "data", "presets", "target-only.json"), []byte(`{"name":"目标独有"}`), 0o644); err != nil {
		t.Fatalf("写入目标预设失败: %v", err)
	}

	changes, err := Restore(Options{RootDir: target, IncludeKeys: true}, archive)
	if err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	if len(changes.Replaced) == 0 {
		t.Fatalf("未记录替换项: %+v", changes)
	}

	restored, err := config.Load(targetConfigPath)
	if err != nil {
		t.Fatalf("重新读取配置失败: %v", err)
	}
	if got := restored.String("chat.model"); got != "test-model" {
		t.Fatalf("配置未被备份覆盖: %q", got)
	}
	if got := restored.Get("server.port").Int(); got != 19191 {
		t.Fatalf("运行中的 server 配置应保留: %d", got)
	}
	// 含密钥备份：密钥来自备份
	if got := restored.String("ai.apiKey"); got != "sk-local" {
		t.Fatalf("含密钥备份应恢复密钥: %q", got)
	}
	if !restored.Exists("ai.providers.0.id") {
		t.Fatalf("providers 合并失败")
	}
	providerIDs := []string{}
	for _, item := range restored.Get("ai.providers").Array() {
		providerIDs = append(providerIDs, item.Get("id").String())
	}
	if len(providerIDs) != 2 {
		t.Fatalf("provider 合并结果不符: %v", providerIDs)
	}

	// 备份中的数据文件已恢复，目标独有文件保留
	if _, err := os.Stat(filepath.Join(target, "data", "presets", "preset-1.json")); err != nil {
		t.Fatalf("备份预设未恢复: %v", err)
	}
	if _, err := os.Stat(filepath.Join(target, "data", "presets", "target-only.json")); err != nil {
		t.Fatalf("目标独有预设应保留: %v", err)
	}
	// 快照应包含当前数据
	snapshotDir := filepath.Join(target, "data", "restore-backups")
	entries, err := os.ReadDir(snapshotDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("恢复前快照缺失: %v", err)
	}
}

func TestRestoreMaskedBackupKeepsLocalSecrets(t *testing.T) {
	source := buildFixtureRoot(t)
	maskedArchive := filepath.Join(t.TempDir(), "masked.tar.gz")
	file, err := os.Create(maskedArchive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	if err := Export(Options{RootDir: source}, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	_ = file.Close()

	target := buildFixtureRoot(t)
	document, err := config.Load(filepath.Join(target, "config.json"))
	if err != nil {
		t.Fatalf("读取目标配置失败: %v", err)
	}
	_ = document.Set("ai.apiKey", "sk-target")
	_ = document.Set("ai.providers.0.apiKey", "sk-target-keep")
	if err := document.Save(); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	if _, err := Restore(Options{RootDir: target}, maskedArchive); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	restored, err := config.Load(filepath.Join(target, "config.json"))
	if err != nil {
		t.Fatalf("重新读取失败: %v", err)
	}
	if got := restored.String("ai.apiKey"); got != "sk-target" {
		t.Fatalf("脱敏包不应清空本地根密钥: %q", got)
	}
	if got := restored.Get("ai.providers.0.apiKey").String(); got != "sk-target-keep" {
		t.Fatalf("脱敏包不应清空本地 provider 密钥: %q", got)
	}
	if got := restored.String("chat.model"); got != "test-model" {
		t.Fatalf("其他配置应被备份覆盖: %q", got)
	}
}

func TestExportMasksSecretsByDefault(t *testing.T) {
	root := buildFixtureRoot(t)
	archive := filepath.Join(t.TempDir(), "safe.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	if err := Export(Options{RootDir: root}, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	_ = file.Close()

	tempDir := t.TempDir()
	if err := Extract(archive, tempDir); err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(tempDir, "config.json"))
	if err != nil {
		t.Fatalf("读取配置副本失败: %v", err)
	}
	document, err := config.New("config.json", raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if got := document.String("ai.apiKey"); got != maskValue {
		t.Fatalf("密钥未脱敏: %q", got)
	}
	if got := document.Get("server.port").Int(); got != 18081 {
		t.Fatalf("非密钥字段被误改: %d", got)
	}
}

func TestExtractRejectsPathTraversal(t *testing.T) {
	root := buildFixtureRoot(t)
	archive := filepath.Join(t.TempDir(), "evil.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	writer := newWriterForTest(file)
	if err := writer.addFile("../evil.txt", "boom"); err != nil {
		t.Fatalf("写入恶意条目失败: %v", err)
	}
	if err := writer.close(); err != nil {
		t.Fatalf("关闭失败: %v", err)
	}
	_ = file.Close()
	_ = root

	if err := Extract(archive, t.TempDir()); err == nil {
		t.Fatalf("路径穿越归档应被拒绝")
	}
}

// 恢复到新目录后靶场快照目录必须一起还原（导出包含 range-snapshots，恢复不能丢）
func TestRestoreRestoresRangeSnapshots(t *testing.T) {
	source := buildFixtureRoot(t)
	dataDir := filepath.Join(source, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "range-snapshots"), 0o755); err != nil {
		t.Fatalf("创建快照目录失败: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "range-snapshots", "snap1.json"), []byte(`{"id":"snap1"}`), 0o644); err != nil {
		t.Fatalf("写入快照失败: %v", err)
	}

	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	if err := Export(Options{RootDir: source}, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	_ = file.Close()

	target := buildFixtureRoot(t)
	// 目标端预先存在旧快照，确认被备份内容覆盖
	oldSnapshot := filepath.Join(target, "data", "range-snapshots", "snap1.json")
	if err := os.MkdirAll(filepath.Dir(oldSnapshot), 0o755); err != nil {
		t.Fatalf("创建目标快照目录失败: %v", err)
	}
	if err := os.WriteFile(oldSnapshot, []byte(`{"id":"old"}`), 0o644); err != nil {
		t.Fatalf("写入旧快照失败: %v", err)
	}

	if _, err := Restore(Options{RootDir: target, Categories: []string{"all"}}, archive); err != nil {
		t.Fatalf("恢复失败: %v", err)
	}
	restored, err := os.ReadFile(oldSnapshot)
	if err != nil {
		t.Fatalf("恢复后读取快照失败: %v", err)
	}
	if string(restored) != `{"id":"snap1"}` {
		t.Fatalf("快照未被还原: %s", restored)
	}
}

// 全局正则规则必须进入 regex 快照（对齐 Node normalizeConfig 的 regex.rules  bindings.global 同步），
// 且 characters/regex 的字段形状固定存在（缺失为 null），避免跨版本恢复缺键。
func TestExportRegexSnapshotSyncsGlobalRulesAndKeepsShape(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "chats"), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	configJSON := `{
  "chat": { "dataDir": ` + quote(dataDir) + ` },
  "regex": { "enabled": true, "usePresetRules": true, "rules": [] },
  "bindings": {
    "global": { "regexRules": [{ "name": "全局规则", "pattern": "a", "replacement": "b", "enabled": true }] },
    "characters": { "角色A": { "regexRules": [] } }
  }
}`
	if err := os.WriteFile(filepath.Join(root, "config.json"), []byte(configJSON), 0o644); err != nil {
		t.Fatalf("写入配置失败: %v", err)
	}

	archive := filepath.Join(t.TempDir(), "backup.tar.gz")
	file, err := os.Create(archive)
	if err != nil {
		t.Fatalf("创建归档失败: %v", err)
	}
	if err := Export(Options{RootDir: root}, file); err != nil {
		t.Fatalf("导出失败: %v", err)
	}
	_ = file.Close()

	extracted := t.TempDir()
	if err := Extract(archive, extracted); err != nil {
		t.Fatalf("解包失败: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(extracted, "data", "_regex_rules_snapshot.json"))
	if err != nil {
		t.Fatalf("读取快照失败: %v", err)
	}
	var snapshot map[string]any
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		t.Fatalf("解析快照失败: %v", err)
	}
	regexSection, _ := snapshot["regex"].(map[string]any)
	rules, _ := regexSection["rules"].([]any)
	if len(rules) != 1 {
		t.Fatalf("regex.rules 未同步 bindings.global.regexRules: %v", regexSection["rules"])
	}
	for _, key := range []string{"regex", "presetRegexRules", "globalRegexRules", "globalPresetRegexRules", "importsRegexFiles", "characters"} {
		if _, ok := snapshot[key]; !ok {
			t.Fatalf("快照缺少固定字段 %s: %v", key, snapshot)
		}
	}
	characters, _ := snapshot["characters"].(map[string]any)
	entry, _ := characters["角色A"].(map[string]any)
	for _, key := range []string{"regexRules", "presetRegexRules", "importedFromCardRegexRules"} {
		if _, ok := entry[key]; !ok {
			t.Fatalf("角色快照缺少固定字段 %s: %v", key, entry)
		}
	}
}
