// Package store 提供与 Node 版完全一致的 SQLite 记忆库访问。
//
// 数据迁移约束：
//   - 直接打开 Node 版写出的 .sqlite 文件，不复制、不改结构、不改文件名
//   - 建表语句与 src/session.js prepareSchema 逐字一致（见 schema.go），供全新安装使用
//   - 只读打开时使用 mode=ro，避免对运行中的实例造成写锁
package store

import (
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

// Counts 是单个记忆库的行数统计。
type Counts struct {
	Sessions            int64 `json:"sessions"`
	Messages            int64 `json:"messages"`
	Summaries           int64 `json:"summaries"`
	StickyEntries       int64 `json:"stickyEntries"`
	MemoryNamespaces    int64 `json:"memoryNamespaces"`
	MemoryEntries       int64 `json:"memoryEntries"`
	SummaryIndexEntries int64 `json:"summaryIndexEntries"`
}

// DB 是一个已打开的记忆库。
type DB struct {
	Path     string
	ReadOnly bool
	handle   *sql.DB
}

func buildDSN(path string, readOnly bool) string {
	// Windows 盘符路径需要 file:///C:/... 形式，否则 SQLite 会把盘符当成 URI authority
	slashPath := filepath.ToSlash(path)
	if !strings.HasPrefix(slashPath, "/") {
		slashPath = "/" + slashPath
	}
	query := url.Values{}
	if readOnly {
		query.Set("mode", "ro")
	}
	query.Add("_pragma", "busy_timeout(5000)")
	if !readOnly {
		query.Add("_pragma", "journal_mode(WAL)")
		query.Add("_pragma", "foreign_keys(1)")
	}
	return "file://" + slashPath + "?" + query.Encode()
}

// OpenReadOnly 以只读方式打开已存在的记忆库（用于数据核对、备份导出等场景）。
func OpenReadOnly(path string) (*DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("记忆库不存在: %s: %w", path, err)
	}
	return open(path, true)
}

// Open 以读写方式打开记忆库；文件不存在时由 SQLite 创建（全新安装场景）。
func Open(path string) (*DB, error) {
	return open(path, false)
}

func open(path string, readOnly bool) (*DB, error) {
	handle, err := sql.Open("sqlite", buildDSN(path, readOnly))
	if err != nil {
		return nil, fmt.Errorf("打开记忆库失败: %s: %w", path, err)
	}
	handle.SetMaxOpenConns(1)
	if err := handle.Ping(); err != nil {
		_ = handle.Close()
		return nil, fmt.Errorf("连接记忆库失败: %s: %w", path, err)
	}
	return &DB{Path: path, ReadOnly: readOnly, handle: handle}, nil
}

// Close 关闭连接。
func (d *DB) Close() error {
	if d == nil || d.handle == nil {
		return nil
	}
	return d.handle.Close()
}

// EnsureSchema 建表（语句与 Node 版一致）。
func (d *DB) EnsureSchema() error {
	if _, err := d.handle.Exec(SchemaSQL); err != nil {
		return fmt.Errorf("初始化表结构失败: %w", err)
	}
	return nil
}

// Exec 执行一条写语句（供建表与数据写入使用）。
func (d *DB) Exec(query string, args ...any) (sql.Result, error) {
	return d.handle.Exec(query, args...)
}

// TableNames 返回库内所有用户表。
func (d *DB) TableNames() ([]string, error) {
	rows, err := d.handle.Query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		return nil, fmt.Errorf("读取表清单失败: %w", err)
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

func (d *DB) countTable(table string) (int64, error) {
	var total int64
	err := d.handle.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&total)
	if err != nil {
		if strings.Contains(err.Error(), "no such table") {
			return 0, nil
		}
		return 0, fmt.Errorf("统计 %s 失败: %w", table, err)
	}
	return total, nil
}

// Counts 统计各表行数（缺表按 0 处理，兼容旧版本库）。
func (d *DB) Counts() (Counts, error) {
	var result Counts
	targets := []struct {
		table string
		field *int64
	}{
		{"sessions", &result.Sessions},
		{"messages", &result.Messages},
		{"summaries", &result.Summaries},
		{"sticky_entries", &result.StickyEntries},
		{"memory_namespaces", &result.MemoryNamespaces},
		{"memory_entries", &result.MemoryEntries},
		{"summary_index_entries", &result.SummaryIndexEntries},
	}
	for _, target := range targets {
		total, err := d.countTable(target.table)
		if err != nil {
			return Counts{}, err
		}
		*target.field = total
	}
	return result, nil
}

// RecentMessages 读取指定会话的最近消息（按时间倒序，与 Node 版排序一致）。
func (d *DB) RecentMessages(sessionID string, limit int) ([]Message, error) {
	rows, err := d.handle.Query(`
		SELECT id, role, content, metadata_json, timestamp, date_iso
		FROM messages
		WHERE session_id = ?
		ORDER BY timestamp DESC, rowid DESC
		LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("读取消息失败: %w", err)
	}
	defer rows.Close()
	var messages []Message
	for rows.Next() {
		var item Message
		var metadata sql.NullString
		if err := rows.Scan(&item.ID, &item.Role, &item.Content, &metadata, &item.Timestamp, &item.DateISO); err != nil {
			return nil, err
		}
		item.MetadataJSON = metadata.String
		messages = append(messages, item)
	}
	return messages, rows.Err()
}

// Message 是一条聊天消息。
type Message struct {
	ID           string `json:"id"`
	Role         string `json:"role"`
	Content      string `json:"content"`
	MetadataJSON string `json:"metadataJson,omitempty"`
	Timestamp    int64  `json:"timestamp"`
	DateISO      string `json:"dateIso"`
}

// Session 是一个会话记录。
type Session struct {
	ID           string `json:"id"`
	CreatedAt    int64  `json:"createdAt"`
	LastActive   int64  `json:"lastActive"`
	MessageCount int64  `json:"messageCount"`
	SummaryCount int64  `json:"summaryCount"`
}

// ListSessions 列出会话（按最近活跃排序）。
func (d *DB) ListSessions(limit int) ([]Session, error) {
	rows, err := d.handle.Query(`
		SELECT id, created_at, last_active, message_count, summary_count
		FROM sessions
		ORDER BY last_active DESC
		LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("读取会话失败: %w", err)
	}
	defer rows.Close()
	var sessions []Session
	for rows.Next() {
		var item Session
		if err := rows.Scan(&item.ID, &item.CreatedAt, &item.LastActive, &item.MessageCount, &item.SummaryCount); err != nil {
			return nil, err
		}
		sessions = append(sessions, item)
	}
	return sessions, rows.Err()
}

// DiscoverMemoryDatabases 按 Node 版 listKnownMemoryDatabases 的规则扫描 data/chats 下的所有 .sqlite。
func DiscoverMemoryDatabases(dataDir string) ([]string, error) {
	baseDir := filepath.Join(dataDir, "chats")
	var found []string
	if _, err := os.Stat(baseDir); err != nil {
		return found, nil
	}
	err := filepath.WalkDir(baseDir, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(strings.ToLower(entry.Name()), ".sqlite") {
			absolute, err := filepath.Abs(path)
			if err != nil {
				absolute = path
			}
			found = append(found, absolute)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("扫描记忆库失败: %w", err)
	}
	return found, nil
}
