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

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Document 是一份已加载的配置文档（保持原始 JSON 文本）。
type Document struct {
	path string
	data []byte
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
	return &Document{path: path, data: raw}, nil
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

// Raw 返回当前 JSON 文本（未格式化）。
func (d *Document) Raw() []byte { return d.data }

// Clone 返回深拷贝，便于对比修改前后。
func (d *Document) Clone() *Document {
	copied := make([]byte, len(d.data))
	copy(copied, d.data)
	return &Document{path: d.path, data: copied}
}

// Get 按点分路径取节点（gjson 语法，如 chat.model、ai.providers.0.apiKey）。
func (d *Document) Get(path string) gjson.Result { return gjson.GetBytes(d.data, path) }

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
	updated, err := sjson.SetBytes(d.data, path, value)
	if err != nil {
		return fmt.Errorf("写入配置项 %s 失败: %w", path, err)
	}
	d.data = updated
	return nil
}

// Delete 删除一个路径。
func (d *Document) Delete(path string) error {
	updated, err := sjson.DeleteBytes(d.data, path)
	if err != nil {
		return fmt.Errorf("删除配置项 %s 失败: %w", path, err)
	}
	d.data = updated
	return nil
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
	var buffer bytes.Buffer
	if err := json.Indent(&buffer, d.data, "", "  "); err != nil {
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
	return nil
}
