// Package preset 实现 Node 版启动时的预设状态整理：
//   - StripLegacyMetadata：清理旧版 SillyTavern 水印字段（对齐 stripLegacyPresetMetadata）
//   - SyncFiles：把 data/presets/*.json 同步进 config.imports.presetFiles，
//     并把非磁盘导入记录落盘（对齐 syncPresetFiles(config, { importLoosePresets: true, importPosition: 'append' })）
//
// 历史缺口：Go 版从未执行这两个启动步骤，导致 Node 时期落在 data/presets 的预设
// 在 Go 下不出现在面板导入列表里；旧版水印也不会被清理。
package preset

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mimirlink/internal/config"
)

// Options 是同步参数（对齐 Node syncPresetFiles 的 options）。
type Options struct {
	DataDir            string
	ImportLoosePresets bool
	ImportPosition     string // "append" | "prepend"
	DiskFileIDs        []string
}

// StripLegacyMetadata 清理 importedPreset 里 prompts/prompt_order 之外的旧版水印。
func StripLegacyMetadata(document *config.Document) int {
	raw := document.Get("imports.presetFiles")
	if !raw.IsArray() {
		return 0
	}
	records := arrayToMaps(raw.Raw)
	cleaned := 0
	for _, record := range records {
		imported, _ := record["importedPreset"].(map[string]any)
		if imported == nil {
			continue
		}
		hasWatermark := false
		for key := range imported {
			if key != "prompts" && key != "prompt_order" {
				hasWatermark = true
				break
			}
		}
		if !hasWatermark {
			continue
		}
		prompts, _ := imported["prompts"].([]any)
		record["importedPreset"] = map[string]any{"prompts": sanitizePrompts(prompts)}
		cleaned++
	}
	if cleaned > 0 {
		_ = document.Set("imports.presetFiles", mapsToAny(records))
		_ = document.Save()
	}
	return cleaned
}

// sanitizePrompts 对齐 Node 对旧版 prompts 的字段收敛。
func sanitizePrompts(prompts []any) []any {
	cleaned := []any{}
	for _, item := range prompts {
		prompt, _ := item.(map[string]any)
		if prompt == nil {
			continue
		}
		cleaned = append(cleaned, map[string]any{
			"name":               strings.TrimSpace(textOf(prompt["name"])),
			"content":            textOf(prompt["content"]),
			"enabled":            prompt["enabled"] != false,
			"role":               orDefault(textOf(prompt["role"]), "system"),
			"injection_position": intOr(prompt["injection_position"]),
			"injection_depth":    intOr(prompt["injection_depth"]),
			"system_prompt":      prompt["system_prompt"] == true,
			"marker":             prompt["marker"] == true,
			"forbid_overrides":   prompt["forbid_overrides"] == true,
		})
	}
	return cleaned
}

// SyncFiles 执行预设文件与配置的双向同步，返回导入与写入的记录 ID。
func SyncFiles(document *config.Document, options Options) (imported []string, written []string, skipped []string) {
	dataDir := options.DataDir
	if dataDir == "" {
		return nil, nil, nil
	}
	presetsDir := filepath.Join(dataDir, "presets")
	if err := os.MkdirAll(presetsDir, 0o755); err != nil {
		return nil, nil, []string{err.Error()}
	}
	position := "prepend"
	if options.ImportPosition == "append" {
		position = "append"
	}
	allowedDiskIDs := map[string]bool{}
	for _, id := range options.DiskFileIDs {
		allowedDiskIDs[id] = true
	}

	records := []map[string]any{}
	if raw := document.Get("imports.presetFiles"); raw.IsArray() {
		records = arrayToMaps(raw.Raw)
	}
	existing := map[string]bool{}
	for _, record := range records {
		if id := textOf(record["id"]); id != "" {
			existing[id] = true
		}
	}

	entries, err := os.ReadDir(presetsDir)
	if err != nil {
		return nil, nil, []string{err.Error()}
	}
	files := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
			continue
		}
		files = append(files, entry.Name())
	}
	sort.Strings(files)

	for _, file := range files {
		id := strings.TrimSuffix(file, filepath.Ext(file))
		if len(allowedDiskIDs) > 0 && !allowedDiskIDs[id] {
			skipped = append(skipped, id+":not-in-selected-restore-set")
			continue
		}
		if existing[id] {
			continue
		}
		path := filepath.Join(presetsDir, file)
		data, err := os.ReadFile(path)
		if err != nil {
			skipped = append(skipped, id+":"+err.Error())
			continue
		}
		var record map[string]any
		if err := json.Unmarshal(data, &record); err != nil {
			skipped = append(skipped, id+":"+err.Error())
			continue
		}
		if textOf(record["type"]) == "preset" {
			if textOf(record["id"]) == "" {
				record["id"] = id
			}
			records = pushRecord(records, record, position)
			existing[textOf(record["id"])] = true
			imported = append(imported, textOf(record["id"]))
			continue
		}
		if !options.ImportLoosePresets || !isLoosePreset(record) {
			continue
		}
		if strings.EqualFold(file, "runtime.raw-preset.json") {
			continue
		}
		createdAt := time.Now().UTC().Format(time.RFC3339)
		if info, err := os.Stat(path); err == nil {
			createdAt = info.ModTime().UTC().Format(time.RFC3339)
		}
		importRecord := map[string]any{
			"id":                  id,
			"type":                "preset",
			"filename":            file,
			"presetName":          firstNonEmpty(textOf(record["name"]), id),
			"createdAt":           createdAt,
			"importedFields":      nonEmptyFields(record),
			"importedPreset":      record,
			"importedRegexRules":  record["regexRules"],
			"linkedRegexImportId": nil,
			"previousRegexRules":  []any{},
			"previousPreset":      map[string]any{},
			"sourceType":          "disk-preset",
			"fileBackedOnly":      true,
		}
		records = pushRecord(records, importRecord, position)
		existing[id] = true
		imported = append(imported, id)
	}

	// 非磁盘记录回写文件（对齐 Node：sourceType=disk-preset 或 fileBackedOnly 跳过）
	changed := len(imported) > 0
	for _, record := range records {
		id := textOf(record["id"])
		if id == "" {
			continue
		}
		if textOf(record["sourceType"]) == "disk-preset" || record["fileBackedOnly"] == true {
			continue
		}
		encoded, err := json.MarshalIndent(record, "", "  ")
		if err != nil {
			skipped = append(skipped, id+":"+err.Error())
			continue
		}
		if err := os.WriteFile(filepath.Join(presetsDir, id+".json"), encoded, 0o644); err != nil {
			skipped = append(skipped, id+":"+err.Error())
			continue
		}
		written = append(written, id)
	}

	if changed {
		_ = document.Set("imports.presetFiles", mapsToAny(records))
		_ = document.Save()
	}
	return imported, written, skipped
}

func pushRecord(records []map[string]any, record map[string]any, position string) []map[string]any {
	if position == "append" {
		return append(records, record)
	}
	return append([]map[string]any{record}, records...)
}

func isLoosePreset(record map[string]any) bool {
	if record == nil || textOf(record["type"]) == "preset" {
		return false
	}
	prompts, ok := record["prompts"].([]any)
	return ok && len(prompts) >= 0
}

func nonEmptyFields(record map[string]any) []any {
	fields := []any{}
	for key, value := range record {
		switch typed := value.(type) {
		case string:
			if typed != "" {
				fields = append(fields, key)
			}
		case bool:
			if typed {
				fields = append(fields, key)
			}
		case float64:
			if typed != 0 {
				fields = append(fields, key)
			}
		case []any:
			if len(typed) > 0 {
				fields = append(fields, key)
			}
		case map[string]any:
			if len(typed) > 0 {
				fields = append(fields, key)
			}
		case nil:
			// 跳过
		}
	}
	sort.Slice(fields, func(left, right int) bool { return fmt.Sprint(fields[left]) < fmt.Sprint(fields[right]) })
	return fields
}

func arrayToMaps(raw string) []map[string]any {
	var items []map[string]any
	if err := json.Unmarshal([]byte(raw), &items); err != nil {
		return nil
	}
	return items
}

func mapsToAny(records []map[string]any) []any {
	result := make([]any, 0, len(records))
	for _, record := range records {
		result = append(result, record)
	}
	return result
}

func textOf(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	return ""
}

func orDefault(value string, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func intOr(value any) int {
	if typed, ok := value.(float64); ok {
		return int(typed)
	}
	return 0
}
