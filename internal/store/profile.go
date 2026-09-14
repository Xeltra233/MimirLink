package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// ProfileSourceConfig 是档案采集参数（对齐 Node collectParticipantProfileSource 选项）。
type ProfileSourceConfig struct {
	Threshold     int    // 触发建档的新消息数阈值（Node triggerMessages，默认 8）
	Limit         int    // 最多采集消息数（Node maxSourceMessages，默认 50）
	SourceFilter  string // all / bot_only
	ContextBefore int
	ContextAfter  int
	// Force 为手动「立即增量分析」：忽略上次处理时间窗口，基于全部可见消息重建
	Force bool
}

// NormalizeProfileSourceConfig 应用默认值。
func NormalizeProfileSourceConfig(config ProfileSourceConfig) ProfileSourceConfig {
	if config.Threshold < 1 {
		config.Threshold = 8
	}
	if config.Limit < 1 {
		config.Limit = 50
	}
	if config.Limit > 500 {
		config.Limit = 500
	}
	if config.SourceFilter == "" {
		config.SourceFilter = "all"
	}
	if config.ContextBefore < 0 {
		config.ContextBefore = 2
	}
	if config.ContextAfter < 0 {
		config.ContextAfter = 2
	}
	return config
}

// ProfileSource 是采集结果。
type ProfileSource struct {
	Messages         []Message
	HasEnoughNewInfo bool
	Existing         *MemoryEntry
	LastProcessedAt  int64
}

// GetParticipantProfileEntry 读取某命名空间下指定 participantId 的最新档案。
func (d *DB) GetParticipantProfileEntry(options NamespaceOptions, participantID string) (*MemoryEntry, error) {
	namespaceID, err := d.FindMemoryNamespace(options)
	if err != nil {
		return nil, err
	}
	if namespaceID == "" {
		return nil, nil
	}
	row := d.handle.QueryRow(
		`SELECT id, namespace_id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
		 FROM memory_entries
		 WHERE namespace_id = ? AND entry_type = 'participant_profile'
		   AND CAST(json_extract(metadata_json, '$.participantId') AS TEXT) = ?
		 ORDER BY updated_at DESC, rowid DESC LIMIT 1`,
		namespaceID, participantID)
	var entry MemoryEntry
	var tagsJSON, metadataJSON string
	var sourceSessionID, sourceMessageID *string
	var namespaceIDRead string
	err = row.Scan(&entry.ID, &namespaceIDRead, &entry.EntryType, &entry.Title, &entry.Content, &tagsJSON, &metadataJSON, &sourceSessionID, &sourceMessageID, &entry.CreatedAt, &entry.UpdatedAt)
	if err != nil {
		return nil, nil // 无档案
	}
	entry.Tags = []string{}
	_ = json.Unmarshal([]byte(tagsJSON), &entry.Tags)
	entry.Metadata = map[string]any{}
	_ = json.Unmarshal([]byte(metadataJSON), &entry.Metadata)
	entry.SourceSessionID = deref(sourceSessionID)
	entry.SourceMessageID = deref(sourceMessageID)
	return &entry, nil
}

// CollectParticipantProfileSource 对齐 Node collectParticipantProfileSource（核心语义）：
// 以目标人物本人发言为锚点，取锚点前后 context 条上下文，按 lastProcessedMessageAt 增量采集。
func (d *DB) CollectParticipantProfileSource(participantID string, options NamespaceOptions, config ProfileSourceConfig) (*ProfileSource, error) {
	config = NormalizeProfileSourceConfig(config)
	participantID = strings.TrimSpace(participantID)
	if participantID == "" {
		return nil, fmt.Errorf("participantId 不能为空")
	}
	existing, err := d.GetParticipantProfileEntry(options, participantID)
	if err != nil {
		return nil, err
	}
	var since int64
	if existing != nil && !config.Force {
		if value, ok := existing.Metadata["lastProcessedMessageAt"].(float64); ok {
			since = int64(value)
		}
	}

	// 取全库时间线（对齐 Node listSessionMessagesSince 的跨会话语义，Go 侧按全局时间序）
	rows, err := d.handle.Query(
		`SELECT id, session_id, role, content, metadata_json, timestamp, date_iso
		 FROM messages WHERE timestamp > ? ORDER BY timestamp ASC, rowid ASC LIMIT 2000`, since)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	timeline := []Message{}
	for rows.Next() {
		var item Message
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Role, &item.Content, &item.MetadataJSON, &item.Timestamp, &item.DateISO); err != nil {
			return nil, err
		}
		timeline = append(timeline, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 锚点：目标人物本人发言（user 角色 + metadata.userId 匹配）
	anchorIndexes := []int{}
	hasBot := false
	for index, message := range timeline {
		if message.Role == "assistant" {
			hasBot = true
		}
		if !isUserRoleMessage(message) {
			continue
		}
		if MessageUserID(message) == participantID {
			anchorIndexes = append(anchorIndexes, index)
		}
	}
	if config.SourceFilter == "bot_only" && !hasBot {
		return &ProfileSource{Messages: []Message{}, HasEnoughNewInfo: false, Existing: existing, LastProcessedAt: since}, nil
	}

	include := make([]bool, len(timeline))
	for _, anchorIndex := range anchorIndexes {
		start := anchorIndex - config.ContextBefore
		if start < 0 {
			start = 0
		}
		end := anchorIndex + config.ContextAfter
		if end > len(timeline)-1 {
			end = len(timeline) - 1
		}
		for index := start; index <= end; index += 1 {
			include[index] = true
		}
	}

	selected := []Message{}
	var lastTimestamp int64
	for index, message := range timeline {
		if !include[index] {
			continue
		}
		if len(selected) >= config.Limit {
			break
		}
		selected = append(selected, message)
		if message.Timestamp > lastTimestamp {
			lastTimestamp = message.Timestamp
		}
	}
	return &ProfileSource{
		Messages:         selected,
		HasEnoughNewInfo: len(anchorIndexes) >= config.Threshold,
		Existing:         existing,
		LastProcessedAt:  lastTimestamp,
	}, nil
}

// MessageUserID 提取消息 metadata.userId（供 chat 层复用）。
func MessageUserID(message Message) string {
	var metadata map[string]any
	if err := json.Unmarshal([]byte(message.MetadataJSON), &metadata); err != nil {
		return ""
	}
	if value, ok := metadata["userId"].(string); ok {
		return value
	}
	return ""
}

// isUserRoleMessage 判断是否 user 角色消息。
func isUserRoleMessage(message Message) bool {
	return message.Role == "user"
}

// SaveParticipantProfileEntry 创建或更新人物档案（对齐 Node saveParticipantProfile 的
// 元数据合并语义；创建时走 AddMemoryEntry，更新时原位 UPDATE）。
func (d *DB) SaveParticipantProfile(options NamespaceOptions, entryID string, participantID string, title string, content string, tags []string, extraMetadata map[string]any, sourceSessionID string) (string, error) {
	title = strings.TrimSpace(title)
	content = strings.TrimSpace(content)
	if title == "" || content == "" {
		return "", fmt.Errorf("人物档案标题与内容不能为空")
	}
	metadata := map[string]any{
		"participantId":   participantID,
		"participantName": title,
		"editedBy":        "runtime",
		"updatedBy":       "runtime",
		"source":          "participant_profile",
	}
	for key, value := range extraMetadata {
		metadata[key] = value
	}
	now := time.Now().UnixMilli()
	if entryID != "" {
		_, err := d.handle.Exec(
			`UPDATE memory_entries SET title = ?, content = ?, tags_json = ?, metadata_json = ?, source_session_id = COALESCE(?, source_session_id), updated_at = ? WHERE id = ?`,
			title, content, marshalJSON(tags), marshalJSON(metadata), nullIfEmpty(sourceSessionID), now, entryID)
		if err != nil {
			return "", err
		}
		return entryID, nil
	}
	return d.AddMemoryEntry(options, MemoryEntry{
		EntryType:       "participant_profile",
		Title:           title,
		Content:         content,
		Tags:            tags,
		Metadata:        metadata,
		SourceSessionID: sourceSessionID,
		CreatedAt:       now,
		UpdatedAt:       now,
	})
}
