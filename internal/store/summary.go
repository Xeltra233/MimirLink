package store

import (
	"fmt"
	"strings"
	"time"
)

// intOrAny / boolOrAny：宽松的 any→数值/布尔转换。
func intOrAny(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	}
	return fallback
}

func boolOrAny(value any, fallback bool) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	return fallback
}

// Summary 是一条会话摘要记录。
type Summary struct {
	ID          string `json:"id"`
	SessionID   string `json:"sessionId"`
	Content     string `json:"content"`
	SourceCount int64  `json:"sourceCount"`
	CreatedAt   int64  `json:"createdAt"`
	DateISO     string `json:"dateIso"`
}

// SummaryConfig 对齐 Node session.js 的 summaryConfig。
type SummaryConfig struct {
	Enabled           bool
	TriggerMessages   int
	KeepRecent        int
	MaxSummaries      int
	MaxSourceMessages int
	DisableAI         bool
}

// UseAI 返回是否启用 AI 摘要（对齐 Node summaryConfig.useAI !== false 语义，默认 true）。
func (c SummaryConfig) UseAI() bool {
	return !c.DisableAI
}

// NormalizeSummaryConfig 应用 Node 默认值（trigger 80 / keepRecent 30 / maxSummaries 8 / maxSource 50 / useAI true）。
func NormalizeSummaryConfig(raw map[string]any) SummaryConfig {
	useAI := boolOrAny(raw["useAI"], true)
	config := SummaryConfig{
		Enabled:           boolOrAny(raw["enabled"], false),
		TriggerMessages:   intOrAny(raw["triggerMessages"], 80),
		KeepRecent:        intOrAny(raw["keepRecent"], 30),
		MaxSummaries:      intOrAny(raw["maxSummaries"], 8),
		MaxSourceMessages: intOrAny(raw["maxSourceMessages"], 50),
		DisableAI:         !useAI,
	}
	if config.TriggerMessages <= 0 {
		config.TriggerMessages = 80
	}
	if config.KeepRecent <= 0 {
		config.KeepRecent = 30
	}
	if config.MaxSummaries <= 0 {
		config.MaxSummaries = 8
	}
	if config.MaxSourceMessages <= 0 {
		config.MaxSourceMessages = 50
	}
	return config
}

// ListSummaries 按时间正序返回会话摘要（对齐 Node getSummaries）。
func (d *DB) ListSummaries(sessionID string) ([]Summary, error) {
	rows, err := d.handle.Query(
		`SELECT id, session_id, content, source_count, created_at, date_iso
		 FROM summaries WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	summaries := []Summary{}
	for rows.Next() {
		var item Summary
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Content, &item.SourceCount, &item.CreatedAt, &item.DateISO); err != nil {
			return nil, err
		}
		summaries = append(summaries, item)
	}
	return summaries, rows.Err()
}

// GetMessagesForSummary 读取最旧的 N 条消息作为摘要来源（对齐 Node getMessagesForSummary）。
func (d *DB) GetMessagesForSummary(sessionID string, limit int) ([]Message, error) {
	rows, err := d.handle.Query(
		`SELECT id, session_id, role, content, metadata_json, timestamp, date_iso
		 FROM messages WHERE session_id = ? ORDER BY timestamp ASC, rowid ASC LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := []Message{}
	for rows.Next() {
		var item Message
		if err := rows.Scan(&item.ID, &item.SessionID, &item.Role, &item.Content, &item.MetadataJSON, &item.Timestamp, &item.DateISO); err != nil {
			return nil, err
		}
		messages = append(messages, item)
	}
	return messages, rows.Err()
}

// SummarizerFunc 是 AI 摘要回调：返回摘要文本；出错时回退到规则摘要。
type SummarizerFunc func(source []Message, sessionID string, previous []Summary) (string, error)

// MaybeSummarizeSession 对齐 Node maybeSummarizeSession：触发条件、AI 摘要、回退摘要、
// 事务内写入摘要并删除来源消息、超限裁剪旧摘要、更新会话 summary_count。
// 返回 (nil, nil) 表示未触发。
func (d *DB) MaybeSummarizeSession(sessionID string, config SummaryConfig, summarizer SummarizerFunc) (*Summary, error) {
	if !config.Enabled {
		return nil, nil
	}
	if err := d.EnsureSession(sessionID); err != nil {
		return nil, err
	}
	total, err := d.SessionMessageCount(sessionID)
	if err != nil {
		return nil, err
	}
	if total <= int64(config.TriggerMessages) {
		return nil, nil
	}
	keepRecent := config.KeepRecent
	if keepRecent < 1 {
		keepRecent = 1
	}
	sourceLimit := int(total) - keepRecent
	if sourceLimit <= 0 {
		return nil, nil
	}
	maxSource := config.MaxSourceMessages
	if sourceLimit < maxSource {
		maxSource = sourceLimit
	}
	sourceMessages, err := d.GetMessagesForSummary(sessionID, maxSource)
	if err != nil {
		return nil, err
	}
	if len(sourceMessages) == 0 {
		return nil, nil
	}

	summaryText := buildFallbackSummary(sessionID, sourceMessages)
	if config.UseAI() && summarizer != nil {
		previous, err := d.ListSummaries(sessionID)
		if err != nil {
			return nil, err
		}
		generated, err := summarizer(sourceMessages, sessionID, previous)
		if err != nil {
			// 对齐 Node：AI 摘要失败回退规则摘要，不中断
			summaryText = buildFallbackSummary(sessionID, sourceMessages)
		} else if trimmed := strings.TrimSpace(generated); trimmed != "" {
			summaryText = trimmed
		}
	}

	summaryID := fmt.Sprintf("summary_%d_%s", time.Now().UnixMilli(), randomSuffix(6))
	now := time.Now().UnixMilli()
	dateISO := time.UnixMilli(now).UTC().Format("2006-01-02T15:04:05.000Z07:00")

	transaction, err := d.handle.Begin()
	if err != nil {
		return nil, err
	}
	defer transaction.Rollback()
	if _, err := transaction.Exec(
		`INSERT INTO summaries (id, session_id, content, source_count, created_at, date_iso) VALUES (?, ?, ?, ?, ?, ?)`,
		summaryID, sessionID, summaryText, len(sourceMessages), now, dateISO); err != nil {
		return nil, err
	}
	for _, message := range sourceMessages {
		if _, err := transaction.Exec(`DELETE FROM messages WHERE session_id = ? AND id = ?`, sessionID, message.ID); err != nil {
			return nil, err
		}
	}
	var summaryCount int64
	if err := transaction.QueryRow(`SELECT COUNT(*) FROM summaries WHERE session_id = ?`, sessionID).Scan(&summaryCount); err != nil {
		return nil, err
	}
	if summaryCount > int64(config.MaxSummaries) {
		if _, err := transaction.Exec(
			`DELETE FROM summaries WHERE session_id = ? AND id IN (
				SELECT id FROM summaries WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?
			)`, sessionID, sessionID, summaryCount-int64(config.MaxSummaries)); err != nil {
			return nil, err
		}
		summaryCount = int64(config.MaxSummaries)
	}
	if _, err := transaction.Exec(
		`UPDATE sessions SET summary_count = ?, last_active = ? WHERE id = ?`,
		summaryCount, now, sessionID); err != nil {
		return nil, err
	}
	if err := transaction.Commit(); err != nil {
		return nil, err
	}
	return &Summary{
		ID:          summaryID,
		SessionID:   sessionID,
		Content:     summaryText,
		SourceCount: int64(len(sourceMessages)),
		CreatedAt:   now,
		DateISO:     dateISO,
	}, nil
}

// isTrivialSummaryLine 判断是否为无信息量的简短寒暄。
func isTrivialSummaryLine(content string) bool {
	trimmed := strings.TrimSpace(content)
	if len([]rune(trimmed)) <= 1 {
		return true
	}
	lower := strings.ToLower(trimmed)
	switch lower {
	case "好的", "好", "ok", "yes", "收到", "在吗", "在", "嗯", "啊", "哦", "行", "1", "666":
		return true
	}
	return false
}

// buildFallbackSummary 对齐 Node buildFallbackSummary：用户/助手各取最后 4 条 160 字截断高亮，优先保留实质内容。
func buildFallbackSummary(sessionID string, messages []Message) string {
	userHighlights := []string{}
	assistantHighlights := []string{}
	userMeaningful := []string{}
	assistantMeaningful := []string{}
	for _, message := range messages {
		line := truncateRunes(message.Content, 160)
		if strings.TrimSpace(line) == "" {
			continue
		}
		if message.Role == "assistant" {
			assistantHighlights = append(assistantHighlights, line)
			if !isTrivialSummaryLine(line) {
				assistantMeaningful = append(assistantMeaningful, line)
			}
		} else {
			userHighlights = append(userHighlights, line)
			if !isTrivialSummaryLine(line) {
				userMeaningful = append(userMeaningful, line)
			}
		}
	}
	if len(userMeaningful) > 0 {
		userHighlights = userMeaningful
	}
	if len(assistantMeaningful) > 0 {
		assistantHighlights = assistantMeaningful
	}
	parts := []string{fmt.Sprintf("会话 %s 的历史摘要：", sessionID)}
	if len(userHighlights) > 0 {
		parts = append(parts, fmt.Sprintf("用户侧重点：%s", joinLast(userHighlights, 4, " | ")))
	}
	if len(assistantHighlights) > 0 {
		parts = append(parts, fmt.Sprintf("助手侧回应：%s", joinLast(assistantHighlights, 4, " | ")))
	}
	result := ""
	for index, part := range parts {
		if index > 0 {
			result += "\n"
		}
		result += part
	}
	return result
}

// truncateRunes 按 rune 截断（对齐 Node truncate 的 JS String 语义）。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// joinLast 取最后 N 项拼接。
func joinLast(items []string, count int, sep string) string {
	if len(items) > count {
		items = items[len(items)-count:]
	}
	result := ""
	for index, item := range items {
		if index > 0 {
			result += sep
		}
		result += item
	}
	return result
}

// AddSummaryIndexEntry 写入摘要索引（对齐 Node addSummaryIndexEntry）。
func (d *DB) AddSummaryIndexEntry(options NamespaceOptions, entry SummaryEntry) (string, error) {
	namespaceID, err := d.EnsureMemoryNamespace(options)
	if err != nil {
		return "", err
	}
	now := time.Now().UnixMilli()
	id := entry.ID
	if id == "" {
		id = fmt.Sprintf("sidx_%d_%s", now, randomSuffix(6))
	}
	keywordsJSON := marshalJSON(entry.Keywords)
	metadataJSON := marshalJSON(entry.Metadata)
	if _, err := d.handle.Exec(
		`INSERT INTO summary_index_entries (id, namespace_id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, namespaceID, nullIfEmpty(entry.SourceSummaryID), nullIfEmpty(entry.SourceSessionID),
		entry.Outline, keywordsJSON, metadataJSON, now, now); err != nil {
		return "", err
	}
	return id, nil
}
