package backup

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	_ "modernc.org/sqlite"

	"mimirlink/internal/config"
)

const maskValue = "******"

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func copyFile(source string, target string) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	in, err := os.Open(source)
	if err != nil {
		return fmt.Errorf("读取文件失败: %w", err)
	}
	defer in.Close()
	out, err := os.Create(target)
	if err != nil {
		return fmt.Errorf("写入文件失败: %w", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return fmt.Errorf("复制文件失败: %w", err)
	}
	return out.Close()
}

// copyDir 复制目录，跳过 SQLite 共享内存文件（与 Node 版一致）。
func copyDir(source string, target string) error {
	return copyDirFiltered(source, target, nil)
}

func copyDirFiltered(source string, target string, skipDirs map[string]bool) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return fmt.Errorf("读取目录失败: %w", err)
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() && skipDirs != nil && skipDirs[entry.Name()] {
			continue
		}
		sourcePath := filepath.Join(source, entry.Name())
		targetPath := filepath.Join(target, entry.Name())
		if entry.IsDir() {
			if err := copyDirFiltered(sourcePath, targetPath, skipDirs); err != nil {
				return err
			}
			continue
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".sqlite-shm") {
			continue
		}
		if err := copyFile(sourcePath, targetPath); err != nil {
			return err
		}
	}
	return nil
}

// mergeDir 用备份目录覆盖当前目录，保留当前独有的文件。
func mergeDir(source string, target string, changes *Changes) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return fmt.Errorf("读取目录失败: %w", err)
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return fmt.Errorf("创建目录失败: %w", err)
	}
	for _, entry := range entries {
		sourcePath := filepath.Join(source, entry.Name())
		targetPath := filepath.Join(target, entry.Name())
		if entry.IsDir() {
			if err := mergeDir(sourcePath, targetPath, changes); err != nil {
				return err
			}
			continue
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".sqlite-shm") {
			continue
		}
		existed := exists(targetPath)
		if err := copyFile(sourcePath, targetPath); err != nil {
			return err
		}
		relative, err := filepath.Rel(filepath.Dir(target), targetPath)
		if err != nil {
			relative = targetPath
		}
		relative = filepath.ToSlash(relative)
		if existed {
			changes.replaced(relative)
		} else {
			changes.added(relative)
		}
	}
	return nil
}

// archivePresetsNotInBackup 把当前存在但备份中没有的预设归档，避免被静默覆盖后丢失。
func archivePresetsNotInBackup(backupDir string, currentDir string, dataDir string, now time.Time) error {
	if !exists(currentDir) {
		return nil
	}
	backupNames := map[string]bool{}
	if entries, err := os.ReadDir(backupDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() {
				backupNames[entry.Name()] = true
			}
		}
	}
	orphans := []string{}
	entries, err := os.ReadDir(currentDir)
	if err != nil {
		return fmt.Errorf("读取预设目录失败: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || backupNames[entry.Name()] {
			continue
		}
		orphans = append(orphans, entry.Name())
	}
	if len(orphans) == 0 {
		return nil
	}
	stamp := now.Format("2006-01-02T15-04-05.000Z")
	archiveDir := filepath.Join(dataDir, "restore-backups", "preset-files-"+strings.NewReplacer(":", "-", ".", "-").Replace(stamp))
	for _, name := range orphans {
		if err := copyFile(filepath.Join(currentDir, name), filepath.Join(archiveDir, name)); err != nil {
			return err
		}
	}
	return nil
}

// checkpointDatabases 尽力把 WAL 落盘，保证备份/快照包含完整数据。
func checkpointDatabases(baseDir string) {
	if !exists(baseDir) {
		return
	}
	_ = filepath.Walk(baseDir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		if !strings.HasSuffix(strings.ToLower(info.Name()), ".sqlite") {
			return nil
		}
		slash := filepath.ToSlash(path)
		if !strings.HasPrefix(slash, "/") {
			slash = "/" + slash
		}
		handle, err := sql.Open("sqlite", "file://"+slash+"?_pragma=busy_timeout(3000)")
		if err != nil {
			return nil
		}
		defer handle.Close()
		_, _ = handle.Exec("PRAGMA wal_checkpoint(TRUNCATE)")
		return nil
	})
}

// ---------- 配置合并 ----------

func escapePath(key string) string {
	replacer := strings.NewReplacer("\\", "\\\\", ".", "\\.", "*", "\\*", "?", "\\?")
	return replacer.Replace(key)
}

func setRaw(document *config.Document, path string, raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	updated, err := sjson.SetRawBytes(document.Raw(), path, raw)
	if err != nil {
		return fmt.Errorf("写入配置项 %s 失败: %w", path, err)
	}
	return document.Replace(updated)
}

// mergeConfig 复刻 Node 版 deepMergeConfig：备份覆盖当前，保护本地密钥与运行中的 server 配置。
func mergeConfig(document *config.Document, backupJSON []byte) error {
	backup := gjson.ParseBytes(backupJSON)
	if !backup.IsObject() {
		return fmt.Errorf("备份配置不是对象")
	}
	var mergeErr error
	backup.ForEach(func(key, value gjson.Result) bool {
		path := key.String()
		switch path {
		case "ai":
			mergeErr = mergeAISection(document, value)
		case "imports":
			mergeErr = mergeObjectSection(document, "imports", value)
		default:
			mergeErr = mergeValue(document, escapePath(path), value)
		}
		return mergeErr == nil
	})
	return mergeErr
}

func mergeValue(document *config.Document, path string, value gjson.Result) error {
	if value.IsObject() {
		var mergeErr error
		value.ForEach(func(childKey, childValue gjson.Result) bool {
			mergeErr = setRaw(document, path+"."+escapePath(childKey.String()), []byte(childValue.Raw))
			return mergeErr == nil
		})
		return mergeErr
	}
	return setRaw(document, path, []byte(value.Raw))
}

func mergeObjectSection(document *config.Document, path string, value gjson.Result) error {
	if !value.IsObject() {
		return setRaw(document, path, []byte(value.Raw))
	}
	return mergeValue(document, path, value)
}

func mergeAISection(document *config.Document, backupAI gjson.Result) error {
	var mergeErr error
	backupAI.ForEach(func(key, value gjson.Result) bool {
		name := key.String()
		switch name {
		case "apiKey":
			// 脱敏包中的 ****** 不覆盖本地真实密钥
			if value.String() == maskValue && document.Exists("ai.apiKey") {
				return true
			}
			mergeErr = setRaw(document, "ai.apiKey", []byte(value.Raw))
		case "providers":
			mergeErr = mergeProviders(document, value)
		default:
			mergeErr = mergeValue(document, "ai."+escapePath(name), value)
		}
		return mergeErr == nil
	})
	return mergeErr
}

func mergeProviders(document *config.Document, backupProviders gjson.Result) error {
	currentProviders := document.Get("ai.providers").Array()
	currentByID := map[string]gjson.Result{}
	for _, item := range currentProviders {
		currentByID[item.Get("id").String()] = item
	}
	combined := make([]string, 0, len(backupProviders.Array())+len(currentProviders))
	seen := map[string]bool{}
	for _, item := range backupProviders.Array() {
		id := item.Get("id").String()
		raw := []byte(item.Raw)
		if item.Get("apiKey").String() == maskValue {
			if local, ok := currentByID[id]; ok {
				if localKey := local.Get("apiKey").String(); localKey != "" {
					updated, err := sjson.SetRawBytes(raw, "apiKey", []byte(strconv.Quote(localKey)))
					if err != nil {
						return fmt.Errorf("合并 provider 密钥失败: %w", err)
					}
					raw = updated
				}
			}
		}
		combined = append(combined, string(raw))
		seen[id] = true
	}
	for _, item := range currentProviders {
		if !seen[item.Get("id").String()] {
			combined = append(combined, item.Raw)
		}
	}
	return setRaw(document, "ai.providers", []byte("["+strings.Join(combined, ",")+"]"))
}

// ---------- 正则 / 绑定快照 ----------

func buildRegexSnapshot(document *config.Document) map[string]any {
	return buildRegexSnapshotFromRaw(document.Raw())
}

func buildRegexSnapshotFromMap(parsed map[string]any) map[string]any {
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil
	}
	return buildRegexSnapshotFromRaw(encoded)
}

func buildRegexSnapshotFromRaw(raw []byte) map[string]any {
	if raw == nil {
		return nil
	}
	document, err := config.New("memory.json", raw)
	if err != nil {
		return nil
	}
	// 对齐 Node buildRegexBackupSnapshot：先执行 normalizeConfig 的全局正则层同步，
	// 保证 regex.rules 与 bindings.global.regexRules 一致后再导出快照。
	config.SyncLegacyRegexRules(document)
	// 对齐 Node buildRegexBackupSnapshot：所有字段固定存在，缺失用 null/[]（键顺序与默认值与 Node 一致）
	snapshot := map[string]any{
		"version":                1,
		"exportedAt":             time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"regex":                  nil,
		"presetRegexRules":       nil,
		"globalRegexRules":       nil,
		"globalPresetRegexRules": nil,
		"importsRegexFiles":      []any{},
		"characters":             map[string]any{},
	}
	if document.Exists("regex") {
		snapshot["regex"] = json.RawMessage(document.Get("regex").Raw)
	}
	if document.Exists("preset.regexRules") {
		snapshot["presetRegexRules"] = json.RawMessage(document.Get("preset.regexRules").Raw)
	}
	if document.Exists("bindings.global.regexRules") {
		snapshot["globalRegexRules"] = json.RawMessage(document.Get("bindings.global.regexRules").Raw)
	}
	if document.Exists("bindings.global.preset.regexRules") {
		snapshot["globalPresetRegexRules"] = json.RawMessage(document.Get("bindings.global.preset.regexRules").Raw)
	}
	characters := map[string]any{}
	document.Get("bindings.characters").ForEach(func(name, binding gjson.Result) bool {
		entry := map[string]any{"regexRules": nil, "presetRegexRules": nil, "importedFromCardRegexRules": nil}
		if binding.Get("regexRules").Exists() {
			entry["regexRules"] = json.RawMessage(binding.Get("regexRules").Raw)
		}
		if binding.Get("preset.regexRules").Exists() {
			entry["presetRegexRules"] = json.RawMessage(binding.Get("preset.regexRules").Raw)
		}
		if binding.Get("importedFromCard.regexRules").Exists() {
			entry["importedFromCardRegexRules"] = json.RawMessage(binding.Get("importedFromCard.regexRules").Raw)
		}
		characters[name.String()] = entry
		return true
	})
	snapshot["characters"] = characters
	if document.Exists("imports.regexFiles") {
		snapshot["importsRegexFiles"] = json.RawMessage(document.Get("imports.regexFiles").Raw)
	}
	return snapshot
}

func applyMaybeArray(document *config.Document, path string, value any) error {
	if value == nil {
		return deletePath(document, path)
	}
	return setRaw(document, path, mustJSON(value))
}

func applyRegexSnapshot(document *config.Document, snapshot map[string]any) error {
	// regex
	if regexValue, ok := snapshot["regex"]; ok && regexValue != nil {
		if err := setRaw(document, "regex", mustJSON(regexValue)); err != nil {
			return err
		}
	} else if document.Exists("regex") {
		if err := deletePath(document, "regex"); err != nil {
			return err
		}
	}
	if err := applyMaybeArray(document, "preset.regexRules", snapshot["presetRegexRules"]); err != nil {
		return err
	}
	if err := applyMaybeArray(document, "bindings.global.regexRules", snapshot["globalRegexRules"]); err != nil {
		return err
	}
	if err := applyMaybeArray(document, "bindings.global.preset.regexRules", snapshot["globalPresetRegexRules"]); err != nil {
		return err
	}

	characters, _ := snapshot["characters"].(map[string]any)
	for name, raw := range characters {
		entry, _ := raw.(map[string]any)
		base := "bindings.characters." + escapePath(name)
		if err := applyMaybeArray(document, base+".regexRules", entry["regexRules"]); err != nil {
			return err
		}
		if err := applyMaybeArray(document, base+".preset.regexRules", entry["presetRegexRules"]); err != nil {
			return err
		}
		if err := applyMaybeArray(document, base+".importedFromCard.regexRules", entry["importedFromCardRegexRules"]); err != nil {
			return err
		}
	}
	if importsValue, ok := snapshot["importsRegexFiles"]; ok {
		if importsValue == nil {
			return setRaw(document, "imports.regexFiles", []byte("[]"))
		}
		return setRaw(document, "imports.regexFiles", mustJSON(importsValue))
	}
	return nil
}

func buildBindingsSnapshot(document *config.Document) map[string]any {
	snapshot := map[string]any{
		"version":    1,
		"exportedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}
	if document.Exists("chat.defaultCharacter") {
		snapshot["defaultCharacter"] = document.Get("chat.defaultCharacter").String()
	} else {
		snapshot["defaultCharacter"] = ""
	}
	if document.Exists("bindings") {
		snapshot["bindings"] = json.RawMessage(document.Get("bindings").Raw)
	} else {
		snapshot["bindings"] = nil
	}
	return snapshot
}

func applyBindingsSnapshot(document *config.Document, snapshot map[string]any, changes *Changes) error {
	if bindingsValue, ok := snapshot["bindings"]; ok && bindingsValue != nil {
		if err := setRaw(document, "bindings", mustJSON(bindingsValue)); err != nil {
			return err
		}
		changes.replaced("绑定关系")
	} else {
		changes.skipped("绑定关系 (快照为空)")
	}
	if defaultCharacter, ok := snapshot["defaultCharacter"].(string); ok {
		if err := setRaw(document, "chat.defaultCharacter", mustJSON(defaultCharacter)); err != nil {
			return err
		}
		changes.replaced("当前默认角色")
	}
	return nil
}

func deletePath(document *config.Document, path string) error {
	updated, err := sjson.DeleteBytes(document.Raw(), path)
	if err != nil {
		return fmt.Errorf("删除配置项 %s 失败: %w", path, err)
	}
	return document.Replace(updated)
}

func mustJSON(value any) []byte {
	if raw, ok := value.(json.RawMessage); ok {
		return raw
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte("null")
	}
	return encoded
}
