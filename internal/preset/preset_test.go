package preset

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"mimirlink/internal/config"
)

func newDocument(t *testing.T, raw map[string]any) *config.Document {
	t.Helper()
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("序列化配置失败: %v", err)
	}
	document, err := config.New(filepath.Join(t.TempDir(), "config.json"), encoded)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	return document
}

func TestSyncFilesImportsLoosePreset(t *testing.T) {
	dataDir := t.TempDir()
	presetsDir := filepath.Join(dataDir, "presets")
	if err := os.MkdirAll(presetsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	loose := map[string]any{"name": "旧版预设", "prompts": []any{map[string]any{"content": "你是测试", "role": "system"}}}
	encoded, _ := json.Marshal(loose)
	if err := os.WriteFile(filepath.Join(presetsDir, "preset-old.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	document := newDocument(t, map[string]any{"imports": map[string]any{}})

	imported, _, _ := SyncFiles(document, Options{DataDir: dataDir, ImportLoosePresets: true, ImportPosition: "append"})
	if len(imported) != 1 || imported[0] != "preset-old" {
		t.Fatalf("应导入 1 条磁盘预设，实际 %v", imported)
	}
	raw := document.Get("imports.presetFiles")
	if !raw.IsArray() || len(raw.Array()) != 1 {
		t.Fatalf("导入记录未写入配置: %s", raw.Raw)
	}
	var record map[string]any
	_ = json.Unmarshal([]byte(raw.Array()[0].Raw), &record)
	if record["sourceType"] != "disk-preset" || record["fileBackedOnly"] != true {
		t.Fatalf("磁盘预设记录字段不符: %#v", record)
	}
	// 幂等：再次同步不重复导入
	importedAgain, _, _ := SyncFiles(document, Options{DataDir: dataDir, ImportLoosePresets: true, ImportPosition: "append"})
	if len(importedAgain) != 0 {
		t.Fatalf("重复同步不应再导入: %v", importedAgain)
	}
}

func TestSyncFilesWritesNonDiskRecord(t *testing.T) {
	dataDir := t.TempDir()
	document := newDocument(t, map[string]any{
		"imports": map[string]any{
			"presetFiles": []any{map[string]any{
				"id": "preset-123-abc", "type": "preset", "presetName": "面板导入",
				"importedPreset": map[string]any{"prompts": []any{}},
			}},
		},
	})
	_, written, _ := SyncFiles(document, Options{DataDir: dataDir})
	if len(written) != 1 || written[0] != "preset-123-abc" {
		t.Fatalf("应把非磁盘记录落盘，实际 %v", written)
	}
	if _, err := os.Stat(filepath.Join(dataDir, "presets", "preset-123-abc.json")); err != nil {
		t.Fatalf("落盘文件不存在: %v", err)
	}
}

func TestStripLegacyMetadata(t *testing.T) {
	document := newDocument(t, map[string]any{
		"imports": map[string]any{
			"presetFiles": []any{map[string]any{
				"id": "p1",
				"importedPreset": map[string]any{
					"temperature": 0.8, "top_p": 0.9, "name": "旧水印",
					"prompts": []any{map[string]any{"content": "内容", "role": "system", "name": "第一条"}},
				},
			}},
		},
	})
	if cleaned := StripLegacyMetadata(document); cleaned != 1 {
		t.Fatalf("应清理 1 条水印，实际 %d", cleaned)
	}
	var record map[string]any
	_ = json.Unmarshal([]byte(document.Get("imports.presetFiles").Array()[0].Raw), &record)
	imported, _ := record["importedPreset"].(map[string]any)
	if len(imported) != 1 || imported["prompts"] == nil {
		t.Fatalf("水印清理后字段不符: %#v", imported)
	}
}
