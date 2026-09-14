package store

import (
	"database/sql"
	"fmt"
	"strings"
)

// AppendMessage 写入一条消息（必要时先建会话），字段与 Node 版 session.addMessage 对齐。
func (d *DB) AppendMessage(message Message) error {
	if d.ReadOnly {
		return fmt.Errorf("记忆库以只读方式打开，无法写入")
	}
	if _, err := d.handle.Exec(
		`INSERT INTO sessions (id, created_at, last_active, message_count, summary_count)
		 VALUES (?, ?, ?, 0, 0)
		 ON CONFLICT(id) DO NOTHING`,
		message.SessionID, message.Timestamp, message.Timestamp); err != nil {
		return fmt.Errorf("写入会话失败: %w", err)
	}
	metadata := message.MetadataJSON
	if metadata == "" {
		metadata = "{}"
	}
	if _, err := d.handle.Exec(
		`INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		message.ID, message.SessionID, message.Role, message.Content, metadata, message.Timestamp, message.DateISO); err != nil {
		return fmt.Errorf("写入消息失败: %w", err)
	}
	if _, err := d.handle.Exec(
		`UPDATE sessions SET last_active = ?, message_count = message_count + 1 WHERE id = ?`,
		message.Timestamp, message.SessionID); err != nil {
		return fmt.Errorf("更新会话失败: %w", err)
	}
	return nil
}

// RecentMessagesThread 读取最近的会话消息并按时间正序返回（最后一条为最新）。
func (d *DB) RecentMessagesThread(sessionID string, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 20
	}
	rows, err := d.handle.Query(
		`SELECT id, role, content, metadata_json, timestamp, date_iso
		 FROM messages
		 WHERE session_id = ?
		 ORDER BY timestamp DESC, rowid DESC
		 LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, fmt.Errorf("读取历史消息失败: %w", err)
	}
	defer rows.Close()
	messages := []Message{}
	for rows.Next() {
		var item Message
		var metadata sql.NullString
		if err := rows.Scan(&item.ID, &item.Role, &item.Content, &metadata, &item.Timestamp, &item.DateISO); err != nil {
			return nil, err
		}
		item.SessionID = sessionID
		item.MetadataJSON = metadata.String
		messages = append(messages, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 翻转为时间正序（调用方按顺序拼上下文）
	for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
		messages[left], messages[right] = messages[right], messages[left]
	}
	return messages, nil
}

// SessionMessageCount 返回会话消息数（用于健康检查）。
func (d *DB) SessionMessageCount(sessionID string) (int64, error) {
	var total int64
	if err := d.handle.QueryRow(`SELECT COUNT(*) FROM messages WHERE session_id = ?`, sessionID).Scan(&total); err != nil {
		return 0, fmt.Errorf("统计会话消息失败: %w", err)
	}
	return total, nil
}

// SearchMessages 全局搜索聊天记录（content LIKE 子串匹配，按时间倒序，对齐 Node searchMessages）。
func (d *DB) SearchMessages(query string, limit int) ([]Message, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []Message{}, nil
	}
	if limit <= 0 {
		limit = 50
	}
	rows, err := d.handle.Query(
		`SELECT session_id, role, content, metadata_json, timestamp, date_iso
		 FROM messages
		 WHERE content LIKE ?
		 ORDER BY timestamp DESC, rowid DESC
		 LIMIT ?`,
		"%"+query+"%", limit)
	if err != nil {
		return nil, fmt.Errorf("搜索聊天记录失败: %w", err)
	}
	defer rows.Close()
	messages := []Message{}
	for rows.Next() {
		var message Message
		if err := rows.Scan(&message.SessionID, &message.Role, &message.Content, &message.MetadataJSON, &message.Timestamp, &message.DateISO); err != nil {
			return nil, fmt.Errorf("读取搜索结果失败: %w", err)
		}
		messages = append(messages, message)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历搜索结果失败: %w", err)
	}
	return messages, nil
}
