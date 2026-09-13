// Package datacheck 生成数据盘点报告，用于核对 Node 版与 Go 版看到的是同一份数据。
package datacheck

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

// DatabaseReport 是单个记忆库的盘点结果。
type DatabaseReport struct {
	Path    string       `json:"path"`
	RelPath string       `json:"relPath"`
	Size    int64        `json:"sizeBytes"`
	Counts  store.Counts `json:"counts"`
	Error   string       `json:"error,omitempty"`
}

// FileReport 是各类数据文件的数量统计。
type FileReport struct {
	Presets            int `json:"presets"`
	Worlds             int `json:"worlds"`
	Characters         int `json:"characters"`
	CharacterOverrides int `json:"characterOverrides"`
	Sessions           int `json:"sessions"`
	Knowledge          int `json:"knowledge"`
}

// ConfigReport 是配置文件的摘要（不输出任何密钥值）。
type ConfigReport struct {
	Path         string   `json:"path"`
	Exists       bool     `json:"exists"`
	Bytes        int      `json:"bytes"`
	TopLevelKeys []string `json:"topLevelKeys"`
	Model        string   `json:"model"`
}

// Report 是完整的数据盘点结果。
type Report struct {
	Tool      string           `json:"tool"`
	RootDir   string           `json:"rootDir"`
	DataDir   string           `json:"dataDir"`
	Config    ConfigReport     `json:"config"`
	Databases []DatabaseReport `json:"databases"`
	Files     FileReport       `json:"files"`
}

// Build 扫描指定根目录，生成盘点报告。
func Build(rootDir string) (*Report, error) {
	document, err := config.Load(filepath.Join(rootDir, "config.json"))
	if err != nil {
		return nil, err
	}
	dataDir := document.String("chat.dataDir")
	if dataDir == "" {
		dataDir = filepath.Join(rootDir, "data")
	}
	if !filepath.IsAbs(dataDir) {
		dataDir = filepath.Join(rootDir, dataDir)
	}

	report := &Report{
		Tool:    "mimir-go",
		RootDir: rootDir,
		DataDir: dataDir,
		Config: ConfigReport{
			Path:         document.Path(),
			Exists:       true,
			Bytes:        len(document.Raw()),
			TopLevelKeys: document.Keys(),
			Model:        document.String("chat.model"),
		},
	}

	databases, err := store.DiscoverMemoryDatabases(dataDir)
	if err != nil {
		return nil, err
	}
	sort.Strings(databases)
	for _, dbPath := range databases {
		item := DatabaseReport{Path: dbPath}
		if relative, err := filepath.Rel(rootDir, dbPath); err == nil {
			item.RelPath = filepath.ToSlash(relative)
		}
		if info, err := os.Stat(dbPath); err == nil {
			item.Size = info.Size()
		}
		handle, err := store.OpenReadOnly(dbPath)
		if err != nil {
			item.Error = err.Error()
			report.Databases = append(report.Databases, item)
			continue
		}
		counts, err := handle.Counts()
		if err != nil {
			item.Error = err.Error()
		} else {
			item.Counts = counts
		}
		_ = handle.Close()
		report.Databases = append(report.Databases, item)
	}

	report.Files = FileReport{
		Presets:            countFiles(filepath.Join(dataDir, "presets"), ".json"),
		Worlds:             countFiles(filepath.Join(dataDir, "worlds"), ".json"),
		Characters:         countFiles(filepath.Join(dataDir, "characters"), ".png"),
		CharacterOverrides: countFiles(filepath.Join(dataDir, "character_overrides"), ".json"),
		Sessions:           countFiles(filepath.Join(dataDir, "sessions"), ".json"),
		Knowledge:          countFiles(filepath.Join(dataDir, "knowledge"), ".json"),
	}
	return report, nil
}

func countFiles(dir string, suffix string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	total := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if suffix == "" || strings.HasSuffix(strings.ToLower(entry.Name()), suffix) {
			total++
		}
	}
	return total
}

// Summary 生成一行人类可读的摘要。
func (r *Report) Summary() string {
	var builder strings.Builder
	fmt.Fprintf(&builder, "数据目录: %s\n", r.DataDir)
	fmt.Fprintf(&builder, "配置: %s（%d 字节，顶层键 %d 个，主模型 %s）\n", r.Config.Path, r.Config.Bytes, len(r.Config.TopLevelKeys), r.Config.Model)
	fmt.Fprintf(&builder, "记忆库: %d 个\n", len(r.Databases))
	for _, item := range r.Databases {
		if item.Error != "" {
			fmt.Fprintf(&builder, "  - %s: 读取失败 %s\n", item.RelPath, item.Error)
			continue
		}
		fmt.Fprintf(&builder, "  - %s: 会话 %d / 消息 %d / 摘要 %d / 记忆条目 %d / 命名空间 %d\n",
			item.RelPath, item.Counts.Sessions, item.Counts.Messages, item.Counts.Summaries, item.Counts.MemoryEntries, item.Counts.MemoryNamespaces)
	}
	fmt.Fprintf(&builder, "文件: 预设 %d / 世界书 %d / 角色卡 %d / 角色覆盖 %d / 会话文件 %d / 知识库 %d\n",
		r.Files.Presets, r.Files.Worlds, r.Files.Characters, r.Files.CharacterOverrides, r.Files.Sessions, r.Files.Knowledge)
	return builder.String()
}
