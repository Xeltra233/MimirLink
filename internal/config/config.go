// Package config 读写 MimirLink 的 config.json。
//
// 数据迁移约束（保证 Node 版与 Go 版共用同一份文件）：
//   - 不引入新格式、不重命名键；未知键（历史或未来新增）原样保留
//   - 修改时只覆盖目标路径，其余内容按原始字节保留，避免键顺序漂移
//   - 保存时统一 2 空格缩进，与 Node 版 JSON.stringify(cfg, null, 2) 一致
package config

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Document 是一份已加载的配置文档（保持原始 JSON 文本）。
//
// 面板进程（写）与 bot 进程（读+热加载）都需要并发访问同一份文档，
// 因此所有读写都经过 RWMutex；Generation 用于让运行时判断是否需要重建
// 由配置派生的状态（正则处理器、AI 客户端等）。
type Document struct {
	mu         sync.RWMutex
	path       string
	data       []byte
	generation uint64
	modTime    time.Time
	size       int64
}

// Load 从磁盘加载 config.json。
func Load(path string) (*Document, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}
	if !json.Valid(raw) {
		return nil, fmt.Errorf("配置文件不是合法 JSON: %s", path)
	}
	document := &Document{path: path, data: raw}
	if info, err := os.Stat(path); err == nil {
		document.modTime = info.ModTime()
		document.size = info.Size()
	}
	return document, nil
}

// New 用一段 JSON 文本构造文档（用于测试）。
func New(path string, raw []byte) (*Document, error) {
	if !json.Valid(raw) {
		return nil, fmt.Errorf("不是合法 JSON")
	}
	return &Document{path: path, data: raw}, nil
}

// Path 返回配置文件路径。
func (d *Document) Path() string { return d.path }

// Raw 返回当前 JSON 文本（未格式化）的副本。
func (d *Document) Raw() []byte {
	d.mu.RLock()
	defer d.mu.RUnlock()
	copied := make([]byte, len(d.data))
	copy(copied, d.data)
	return copied
}

// Generation 返回配置变更代数（每次内容变更自增）。
func (d *Document) Generation() uint64 {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return d.generation
}

// Clone 返回深拷贝，便于对比修改前后。
func (d *Document) Clone() *Document {
	d.mu.RLock()
	defer d.mu.RUnlock()
	copied := make([]byte, len(d.data))
	copy(copied, d.data)
	return &Document{path: d.path, data: copied, generation: d.generation, modTime: d.modTime, size: d.size}
}

// Get 按点分路径取节点（gjson 语法，如 chat.model、ai.providers.0.apiKey）。
func (d *Document) Get(path string) gjson.Result {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return gjson.GetBytes(d.data, path)
}

// String 取字符串值。
func (d *Document) String(path string) string { return d.Get(path).String() }

// Int 取整数值，缺失时返回 fallback。
func (d *Document) Int(path string, fallback int64) int64 {
	result := d.Get(path)
	if !result.Exists() {
		return fallback
	}
	return result.Int()
}

// Bool 取布尔值。
func (d *Document) Bool(path string) bool { return d.Get(path).Bool() }

// Exists 判断路径是否存在。
func (d *Document) Exists(path string) bool { return d.Get(path).Exists() }

// Set 写入一个值（只改动目标路径，其余内容保持原状）。
func (d *Document) Set(path string, value any) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	updated, err := sjson.SetBytes(d.data, path, value)
	if err != nil {
		return fmt.Errorf("写入配置项 %s 失败: %w", path, err)
	}
	d.data = updated
	d.generation++
	return nil
}

// Delete 删除一个路径。
func (d *Document) Delete(path string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	updated, err := sjson.DeleteBytes(d.data, path)
	if err != nil {
		return fmt.Errorf("删除配置项 %s 失败: %w", path, err)
	}
	d.data = updated
	d.generation++
	return nil
}

// Replace 用新的 JSON 文本替换文档内容（内容必须合法）。
func (d *Document) Replace(raw []byte) error {
	if !json.Valid(raw) {
		return fmt.Errorf("配置内容不是合法 JSON")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.data = raw
	d.generation++
	return nil
}

// ReloadIfChanged 检查磁盘 config.json 是否变更（mtime+size），变更则热加载。
// 返回是否发生了加载。
func (d *Document) ReloadIfChanged() (bool, error) {
	info, err := os.Stat(d.path)
	if err != nil {
		return false, fmt.Errorf("读取配置文件状态失败: %w", err)
	}
	d.mu.RLock()
	unchanged := info.ModTime().Equal(d.modTime) && info.Size() == d.size
	d.mu.RUnlock()
	if unchanged {
		return false, nil
	}
	raw, err := os.ReadFile(d.path)
	if err != nil {
		return false, fmt.Errorf("读取配置失败: %w", err)
	}
	if !json.Valid(raw) {
		return false, fmt.Errorf("配置文件不是合法 JSON: %s", d.path)
	}
	d.mu.Lock()
	d.data = raw
	d.generation++
	d.modTime = info.ModTime()
	d.size = info.Size()
	d.mu.Unlock()
	return true, nil
}

// WatchConfig 周期性检查并热加载配置，直到 stop 关闭。
// onChange 会在每次成功加载后调用（用于日志与派生状态重建提示）。
func WatchConfig(document *Document, interval time.Duration, onChange func(), onError func(error), stop <-chan struct{}) {
	if interval <= 0 {
		interval = 2 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			changed, err := document.ReloadIfChanged()
			if err != nil {
				if onError != nil {
					onError(err)
				}
				continue
			}
			if changed && onChange != nil {
				onChange()
			}
		}
	}
}

// Keys 返回顶层键（保持文件中的顺序）。
func (d *Document) Keys() []string {
	result := d.Get("@keys")
	if !result.IsArray() {
		return nil
	}
	values := result.Array()
	keys := make([]string, 0, len(values))
	for _, item := range values {
		keys = append(keys, item.String())
	}
	return keys
}

// Formatted 返回 2 空格缩进的 JSON 文本（仅调整空白，不改变键顺序）。
func (d *Document) Formatted() ([]byte, error) {
	d.mu.RLock()
	data := d.data
	d.mu.RUnlock()
	var buffer bytes.Buffer
	if err := json.Indent(&buffer, data, "", "  "); err != nil {
		return nil, fmt.Errorf("格式化配置失败: %w", err)
	}
	// 与 Node 版 JSON.stringify(cfg, null, 2) 保持逐字节一致：不带结尾换行
	return bytes.TrimRight(buffer.Bytes(), " \t\r\n"), nil
}

// Save 原子写回原路径（先写临时文件再重命名，避免半截文件）。
func (d *Document) Save() error { return d.SaveTo(d.path) }

// SaveTo 原子写入指定路径。
func (d *Document) SaveTo(path string) error {
	formatted, err := d.Formatted()
	if err != nil {
		return err
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}
	temp, err := os.CreateTemp(dir, ".config-*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tempPath := temp.Name()
	defer func() {
		_ = os.Remove(tempPath)
	}()
	if _, err := temp.Write(formatted); err != nil {
		_ = temp.Close()
		return fmt.Errorf("写入配置失败: %w", err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tempPath, path); err != nil {
		return fmt.Errorf("替换配置失败: %w", err)
	}
	// 自身保存后刷新基线，避免热加载把这次写入当成外部变更
	if path == d.path {
		if info, err := os.Stat(path); err == nil {
			d.mu.Lock()
			d.modTime = info.ModTime()
			d.size = info.Size()
			d.mu.Unlock()
		}
	}
	return nil
}
