// Package backup 实现与 Node 版完全互通的备份导出 / 检查 / 恢复。
//
// 归档结构与 Node 版一致（tar.gz）：
//
//	config.json                    可选，脱敏或原始
//	data/<分类子目录>                characters / worlds / chats / presets / knowledge
//	data/_regex_rules_snapshot.json 正则规则快照
//	data/_regex_imports/*           正则导入记录 + _manifest.json
//	data/_bindings_snapshot.json    角色/全局绑定快照
//	data/range-corpus.json 等       语料根文件
package backup

import (
	"archive/tar"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"mimirlink/internal/config"
	"mimirlink/internal/mask"
)

// Categories 是合法的备份分类（与 Node 版 BACKUP_CATEGORIES 一致）。
var Categories = []string{"config", "bindings", "characters", "worldbooks", "memory", "presets", "corpus", "regex", "knowledge"}

// dataSubdirs 是分类到 data 子目录的映射（空字符串表示 data 根级文件）。
var dataSubdirs = map[string]string{
	"characters": "characters",
	"worldbooks": "worlds",
	"memory":     "chats",
	"corpus":     "",
	"knowledge":  "knowledge",
	"regex":      "",
	"presets":    "presets",
}

// 恢复时需要跳过的目录（临时目录与快照目录自身）。
var restoreSkipDirs = map[string]bool{
	"_backup_tmp":      true,
	"_inspect_tmp":     true,
	"_restore_tmp":     true,
	"_pre_restore_tmp": true,
	"restore-backups":  true,
}

const (
	regexSnapshotFile    = "_regex_rules_snapshot.json"
	bindingsSnapshotFile = "_bindings_snapshot.json"
	regexImportsDir      = "_regex_imports"
)

// Options 描述一次导出或恢复。
type Options struct {
	RootDir     string
	DataDir     string
	IncludeKeys bool
	Categories  []string
	Now         time.Time
}

// Changes 记录恢复过程中的文件级变化。
type Changes struct {
	Replaced []string `json:"replaced"`
	Merged   []string `json:"merged"`
	Added    []string `json:"added"`
	Skipped  []string `json:"skipped"`
}

func (c *Changes) replaced(item string)   { c.Replaced = append(c.Replaced, item) }
func (c *Changes) mergedItem(item string) { c.Merged = append(c.Merged, item) }
func (c *Changes) added(item string)      { c.Added = append(c.Added, item) }
func (c *Changes) skipped(item string)    { c.Skipped = append(c.Skipped, item) }

func (o Options) now() time.Time {
	if o.Now.IsZero() {
		return time.Now()
	}
	return o.Now
}

func (o Options) validate() error {
	if o.RootDir == "" {
		return fmt.Errorf("缺少根目录")
	}
	dataDir := o.DataDir
	if dataDir == "" {
		dataDir = filepath.Join(o.RootDir, "data")
	}
	if _, err := os.Stat(dataDir); err != nil {
		return fmt.Errorf("数据目录不存在: %s: %w", dataDir, err)
	}
	return nil
}

func (o Options) dataDir() string {
	if o.DataDir != "" {
		return o.DataDir
	}
	return filepath.Join(o.RootDir, "data")
}

func (o Options) selected() map[string]bool {
	selected := map[string]bool{}
	if len(o.Categories) == 0 {
		for _, item := range Categories {
			selected[item] = true
		}
		return selected
	}
	for _, item := range o.Categories {
		trimmed := strings.TrimSpace(item)
		for _, known := range Categories {
			if trimmed == known {
				selected[known] = true
			}
		}
	}
	if len(selected) == 0 {
		for _, item := range Categories {
			selected[item] = true
		}
	}
	return selected
}

// ArchiveName 生成与 Node 版一致的归档文件名。
func (o Options) ArchiveName() string {
	date := o.now().Format("2006-01-02")
	parts := []string{"safe"}
	if o.IncludeKeys {
		parts = []string{"full"}
	}
	if !o.selected()["config"] {
		parts = append(parts, "noconfig")
	}
	return fmt.Sprintf("mimirlink-backup-%s-%s.tar.gz", date, strings.Join(parts, "-"))
}

// Export 按 Node 版结构导出备份到 writer。
func Export(options Options, writer io.Writer) error {
	if err := options.validate(); err != nil {
		return err
	}
	selected := options.selected()
	tempDir, err := os.MkdirTemp("", "mimir-backup-")
	if err != nil {
		return fmt.Errorf("创建临时目录失败: %w", err)
	}
	defer os.RemoveAll(tempDir)

	document, err := config.Load(filepath.Join(options.RootDir, "config.json"))
	if err != nil {
		return err
	}
	dataDir := options.dataDir()

	// config.json（脱敏或原始）
	if selected["config"] {
		payload := document.Raw()
		if !options.IncludeKeys {
			var parsed any
			if err := json.Unmarshal(document.Raw(), &parsed); err != nil {
				return fmt.Errorf("解析配置失败: %w", err)
			}
			masked, err := json.MarshalIndent(mask.Secrets(parsed), "", "  ")
			if err != nil {
				return fmt.Errorf("脱敏配置失败: %w", err)
			}
			payload = masked
		}
		if err := os.WriteFile(filepath.Join(tempDir, "config.json"), payload, 0o644); err != nil {
			return fmt.Errorf("写入配置副本失败: %w", err)
		}
	}

	// 记忆库存量 WAL 落盘，保证备份完整（尽力而为）
	if selected["memory"] {
		checkpointDatabases(filepath.Join(dataDir, "chats"))
	}

	// 分类子目录
	for category, subdir := range dataSubdirs {
		if !selected[category] || subdir == "" {
			continue
		}
		source := filepath.Join(dataDir, subdir)
		if _, err := os.Stat(source); err == nil {
			target := filepath.Join(tempDir, "data", subdir)
			if err := copyDir(source, target); err != nil {
				return err
			}
		}
		// 角色覆盖文件与角色卡同属「角色」分类
		if category == "characters" {
			overrideSource := filepath.Join(dataDir, "character_overrides")
			if _, err := os.Stat(overrideSource); err == nil {
				if err := copyDir(overrideSource, filepath.Join(tempDir, "data", "character_overrides")); err != nil {
					return err
				}
			}
		}
	}

	// corpus 根级文件
	if selected["corpus"] {
		for _, name := range []string{"range-corpus.json", "range-corpus-embeddings.json", "range-prefs.json", "range-snapshots"} {
			source := filepath.Join(dataDir, name)
			info, err := os.Stat(source)
			if err != nil {
				continue
			}
			target := filepath.Join(tempDir, "data", name)
			if info.IsDir() {
				if err := copyDir(source, target); err != nil {
					return err
				}
				continue
			}
			if err := copyFile(source, target); err != nil {
				return err
			}
		}
	}

	// 正则快照与导入记录
	if selected["regex"] {
		snapshot := buildRegexSnapshot(document)
		encoded, err := json.MarshalIndent(snapshot, "", "  ")
		if err != nil {
			return fmt.Errorf("生成正则快照失败: %w", err)
		}
		if err := os.MkdirAll(filepath.Join(tempDir, "data"), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(tempDir, "data", regexSnapshotFile), encoded, 0o644); err != nil {
			return err
		}
		importsDir := filepath.Join(tempDir, "data", regexImportsDir)
		if err := os.MkdirAll(importsDir, 0o755); err != nil {
			return err
		}
		manifest := []map[string]any{}
		for _, record := range document.Get("imports.regexFiles").Array() {
			id := record.Get("id").String()
			if id == "" || (!record.Get("rules").Exists() && !record.Get("importedRules").Exists()) {
				continue
			}
			filename := id + ".json"
			if err := os.WriteFile(filepath.Join(importsDir, filename), []byte(record.Raw), 0o644); err != nil {
				return err
			}
			item := map[string]any{"id": id, "filename": filename}
			if importedAt := record.Get("importedAt"); importedAt.Exists() {
				item["importedAt"] = importedAt.Value()
			}
			manifest = append(manifest, item)
		}
		encodedManifest, err := json.MarshalIndent(manifest, "", "  ")
		if err != nil {
			return fmt.Errorf("生成正则导入清单失败: %w", err)
		}
		if err := os.WriteFile(filepath.Join(importsDir, "_manifest.json"), encodedManifest, 0o644); err != nil {
			return err
		}
	}

	// 绑定关系快照
	if selected["bindings"] {
		snapshot := buildBindingsSnapshot(document)
		encoded, err := json.MarshalIndent(snapshot, "", "  ")
		if err != nil {
			return fmt.Errorf("生成绑定快照失败: %w", err)
		}
		if err := os.MkdirAll(filepath.Join(tempDir, "data"), 0o755); err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(tempDir, "data", bindingsSnapshotFile), encoded, 0o644); err != nil {
			return err
		}
	}

	return writeTarGz(tempDir, writer)
}

// Inspect 返回归档中包含的分类（与 Node 版 inspect 行为一致）。
func Inspect(archivePath string) ([]string, error) {
	tempDir, err := os.MkdirTemp("", "mimir-inspect-")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	defer os.RemoveAll(tempDir)
	if err := Extract(archivePath, tempDir); err != nil {
		return nil, err
	}
	found := map[string]bool{}
	if exists(filepath.Join(tempDir, "config.json")) {
		found["config"] = true
		found["presets"] = true
	}
	dataDir := filepath.Join(tempDir, "data")
	for category, subdir := range dataSubdirs {
		if subdir != "" && exists(filepath.Join(dataDir, subdir)) {
			found[category] = true
		}
	}
	if exists(filepath.Join(dataDir, "range-corpus.json")) {
		found["corpus"] = true
	}
	if exists(filepath.Join(dataDir, regexSnapshotFile)) || exists(filepath.Join(dataDir, regexImportsDir)) {
		found["regex"] = true
	}
	if exists(filepath.Join(dataDir, bindingsSnapshotFile)) {
		found["bindings"] = true
	}
	result := make([]string, 0, len(found))
	for _, category := range Categories {
		if found[category] {
			result = append(result, category)
		}
	}
	return result, nil
}

// Restore 从归档恢复数据，返回文件级变化。
func Restore(options Options, archivePath string) (*Changes, error) {
	if err := options.validate(); err != nil {
		return nil, err
	}
	selected := options.selected()
	dataDir := options.dataDir()
	changes := &Changes{}

	tempDir, err := os.MkdirTemp("", "mimir-restore-")
	if err != nil {
		return nil, fmt.Errorf("创建临时目录失败: %w", err)
	}
	defer os.RemoveAll(tempDir)

	if err := Extract(archivePath, tempDir); err != nil {
		return nil, err
	}

	document, err := config.Load(filepath.Join(options.RootDir, "config.json"))
	if err != nil {
		return nil, err
	}
	// 快照必须在修改任何数据之前完成
	if err := writePreRestoreSnapshot(options, document); err != nil {
		return nil, err
	}
	configDirty := false

	// 1) config.json 深合并
	if selected["config"] {
		backupConfigPath := filepath.Join(tempDir, "config.json")
		if raw, err := os.ReadFile(backupConfigPath); err == nil {
			// 运行中的实例配置：server 端口与数据目录不能被备份改走
			serverRaw := document.Get("server").Raw
			localDataDir := document.String("chat.dataDir")
			if err := mergeConfig(document, raw); err != nil {
				return nil, err
			}
			if serverRaw != "" {
				if err := setRaw(document, "server", []byte(serverRaw)); err != nil {
					return nil, err
				}
			}
			switch {
			case localDataDir != "":
				if err := setRaw(document, "chat.dataDir", []byte(strconv.Quote(localDataDir))); err != nil {
					return nil, err
				}
			case !exists(document.String("chat.dataDir")):
				// 备份里的数据目录在本机不存在（跨机器迁移）：回退到默认 <root>/data
				if err := deletePath(document, "chat.dataDir"); err != nil {
					return nil, err
				}
			}
			configDirty = true
			changes.replaced("config.json")
		} else {
			changes.skipped("config.json (备份中不存在)")
		}
	} else {
		changes.skipped("config.json")
	}

	// 2) 数据目录按分类合并
	backupDataDir := filepath.Join(tempDir, "data")
	if exists(backupDataDir) {
		subdirs := make([]string, 0, len(dataSubdirs))
		for category, subdir := range dataSubdirs {
			if subdir != "" && selected[category] {
				subdirs = append(subdirs, subdir)
			}
		}
		sort.Strings(subdirs)
		for _, subdir := range subdirs {
			source := filepath.Join(backupDataDir, subdir)
			if !exists(source) {
				continue
			}
			target := filepath.Join(dataDir, subdir)
			if subdir == "presets" {
				if err := archivePresetsNotInBackup(source, target, dataDir, options.now()); err != nil {
					return nil, err
				}
			}
			if subdir == "chats" {
				checkpointDatabases(target)
			}
			if err := mergeDir(source, target, changes); err != nil {
				return nil, err
			}
			if subdir == "characters" {
				overrideSource := filepath.Join(backupDataDir, "character_overrides")
				if exists(overrideSource) {
					if err := mergeDir(overrideSource, filepath.Join(dataDir, "character_overrides"), changes); err != nil {
						return nil, err
					}
				}
			}
			if subdir == "chats" {
				changes.replaced("data/chats (记忆库已恢复)")
			}
		}

		// corpus 根文件
		if selected["corpus"] {
			for _, name := range []string{"range-corpus.json", "range-corpus-embeddings.json", "range-prefs.json"} {
				source := filepath.Join(backupDataDir, name)
				if !exists(source) {
					continue
				}
				if err := copyFile(source, filepath.Join(dataDir, name)); err != nil {
					return nil, err
				}
				changes.replaced("data/" + name)
			}
		}
	}

	// 3) 正则快照 / 导入记录
	if selected["regex"] {
		snapshotPath := filepath.Join(backupDataDir, regexSnapshotFile)
		backupConfigPath := filepath.Join(tempDir, "config.json")
		if raw, err := os.ReadFile(snapshotPath); err == nil {
			var snapshot map[string]any
			if err := json.Unmarshal(raw, &snapshot); err != nil {
				return nil, fmt.Errorf("解析正则快照失败: %w", err)
			}
			if err := applyRegexSnapshot(document, snapshot); err != nil {
				return nil, err
			}
			configDirty = true
			changes.replaced("正则规则快照")
		} else if raw, err := os.ReadFile(backupConfigPath); err == nil {
			var parsed map[string]any
			if err := json.Unmarshal(raw, &parsed); err == nil {
				if snapshot := buildRegexSnapshotFromMap(parsed); snapshot != nil {
					if err := applyRegexSnapshot(document, snapshot); err != nil {
						return nil, err
					}
					configDirty = true
					changes.replaced("正则规则（来自备份配置）")
				}
			}
		}

		importsDir := filepath.Join(backupDataDir, regexImportsDir)
		if manifestRaw, err := os.ReadFile(filepath.Join(importsDir, "_manifest.json")); err == nil {
			var manifest []map[string]any
			if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
				return nil, fmt.Errorf("解析正则导入清单失败: %w", err)
			}
			records := make([]json.RawMessage, 0, len(manifest))
			for _, item := range manifest {
				filename, _ := item["filename"].(string)
				if filename == "" {
					continue
				}
				recordRaw, err := os.ReadFile(filepath.Join(importsDir, filepath.Base(filename)))
				if err != nil {
					continue
				}
				records = append(records, json.RawMessage(recordRaw))
			}
			if len(records) > 0 {
				encoded, err := json.Marshal(records)
				if err != nil {
					return nil, fmt.Errorf("序列化正则导入记录失败: %w", err)
				}
				if err := setRaw(document, "imports.regexFiles", encoded); err != nil {
					return nil, err
				}
				configDirty = true
				changes.replaced(fmt.Sprintf("正则导入记录 (%d 条)", len(records)))
			}
		}
	}

	// 4) 绑定关系快照
	if selected["bindings"] {
		snapshotPath := filepath.Join(backupDataDir, bindingsSnapshotFile)
		if raw, err := os.ReadFile(snapshotPath); err == nil {
			var snapshot map[string]any
			if err := json.Unmarshal(raw, &snapshot); err != nil {
				return nil, fmt.Errorf("解析绑定快照失败: %w", err)
			}
			if err := applyBindingsSnapshot(document, snapshot, changes); err != nil {
				return nil, err
			}
			configDirty = true
		}
	}

	if configDirty {
		if err := document.Save(); err != nil {
			return nil, err
		}
	}
	return changes, nil
}

// Extract 解包归档到目标目录，拒绝路径穿越。
func Extract(archivePath string, targetDir string) error {
	file, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("打开归档失败: %w", err)
	}
	defer file.Close()
	return extractReader(file, targetDir)
}

func extractReader(reader io.Reader, targetDir string) error {
	gzipReader, err := gzip.NewReader(reader)
	if err != nil {
		return fmt.Errorf("解压失败: %w", err)
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	absoluteTarget, err := filepath.Abs(targetDir)
	if err != nil {
		return err
	}
	for {
		header, err := tarReader.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("读取归档失败: %w", err)
		}
		name := path.Clean(strings.ReplaceAll(header.Name, "\\", "/"))
		if name == "." {
			continue
		}
		if strings.HasPrefix(name, "../") || strings.HasPrefix(name, "/") || strings.Contains(name, "/../") {
			return fmt.Errorf("归档包含非法路径: %s", header.Name)
		}
		target := filepath.Join(absoluteTarget, filepath.FromSlash(name))
		if !strings.HasPrefix(target, absoluteTarget) {
			return fmt.Errorf("归档包含越界路径: %s", header.Name)
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return fmt.Errorf("创建目录失败: %w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return fmt.Errorf("创建目录失败: %w", err)
			}
			out, err := os.Create(target)
			if err != nil {
				return fmt.Errorf("写入文件失败: %w", err)
			}
			if _, err := io.Copy(out, tarReader); err != nil {
				_ = out.Close()
				return fmt.Errorf("写入文件失败: %w", err)
			}
			if err := out.Close(); err != nil {
				return fmt.Errorf("关闭文件失败: %w", err)
			}
		default:
			// 符号链接等类型忽略
		}
	}
}

func writeTarGz(sourceDir string, writer io.Writer) error {
	gzipWriter := gzip.NewWriter(writer)
	tarWriter := tar.NewWriter(gzipWriter)
	root, err := filepath.Abs(sourceDir)
	if err != nil {
		return err
	}
	walkErr := filepath.Walk(root, func(current string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if current == root {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = name
		if info.IsDir() {
			header.Name += "/"
		}
		if err := tarWriter.WriteHeader(header); err != nil {
			return err
		}
		if info.IsDir() {
			return nil
		}
		file, err := os.Open(current)
		if err != nil {
			return err
		}
		defer file.Close()
		_, err = io.Copy(tarWriter, file)
		return err
	})
	if walkErr != nil {
		return fmt.Errorf("打包失败: %w", walkErr)
	}
	if err := tarWriter.Close(); err != nil {
		return fmt.Errorf("关闭归档失败: %w", err)
	}
	return gzipWriter.Close()
}

// writePreRestoreSnapshot 在恢复前把当前 config.json + data/ 打包到 restore-backups。
func writePreRestoreSnapshot(options Options, document *config.Document) error {
	dataDir := options.dataDir()
	tempDir, err := os.MkdirTemp("", "mimir-prerestore-")
	if err != nil {
		return fmt.Errorf("创建快照临时目录失败: %w", err)
	}
	defer os.RemoveAll(tempDir)

	formatted, err := document.Formatted()
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(tempDir, "config.json"), formatted, 0o644); err != nil {
		return fmt.Errorf("写入快照配置失败: %w", err)
	}
	checkpointDatabases(filepath.Join(dataDir, "chats"))
	if err := copyDirFiltered(dataDir, filepath.Join(tempDir, "data"), restoreSkipDirs); err != nil {
		return err
	}

	snapshotDir := filepath.Join(dataDir, "restore-backups")
	if err := os.MkdirAll(snapshotDir, 0o755); err != nil {
		return fmt.Errorf("创建快照目录失败: %w", err)
	}
	name := fmt.Sprintf("pre-restore-%s.tar.gz", options.now().Format("2006-01-02T15-04-05.000Z"))
	target := filepath.Join(snapshotDir, name)
	file, err := os.Create(target)
	if err != nil {
		return fmt.Errorf("创建快照失败: %w", err)
	}
	if err := writeTarGz(tempDir, file); err != nil {
		_ = file.Close()
		return err
	}
	return file.Close()
}
