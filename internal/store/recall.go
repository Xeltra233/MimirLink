package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// NamespaceOptions 是记忆命名空间定位参数（与 Node ensureMemoryNamespace 入参一致）。
type NamespaceOptions struct {
	ScopeType     string
	ScopeKey      string
	CharacterName string
	PresetName    string
}

// MemoryEntry 是一条记忆条目。
type MemoryEntry struct {
	ID              string         `json:"id"`
	EntryType       string         `json:"entryType"`
	Title           string         `json:"title,omitempty"`
	Content         string         `json:"content"`
	Tags            []string       `json:"tags"`
	Metadata        map[string]any `json:"metadata"`
	SourceSessionID string         `json:"sourceSessionId,omitempty"`
	SourceMessageID string         `json:"sourceMessageId,omitempty"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
	SourceKind      string         `json:"sourceKind,omitempty"`
	RecallReason    string         `json:"recallReason,omitempty"`
	RecallScore     int            `json:"recallScore,omitempty"`
}

// SummaryEntry 是摘要索引条目。
type SummaryEntry struct {
	ID              string         `json:"id"`
	SourceSummaryID string         `json:"sourceSummaryId,omitempty"`
	SourceSessionID string         `json:"sourceSessionId,omitempty"`
	Outline         string         `json:"outline"`
	Keywords        []string       `json:"keywords"`
	Metadata        map[string]any `json:"metadata"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
}

// RecallOptions 控制召回规模（对齐 Node recallMemory 默认值）。
type RecallOptions struct {
	RecentLimit  int
	SearchLimit  int
	SummaryLimit int
	FixedLimit   int
	Limit        int
}

// DefaultRecallOptions 与 Node 默认值一致。
var DefaultRecallOptions = RecallOptions{RecentLimit: 4, SearchLimit: 4, SummaryLimit: 3, FixedLimit: 6, Limit: 6}

// NamespaceID 复刻 Node 的命名空间 ID 规则：ns_<scopeType>_<base64url(scopeKey|character|preset)>。
func NamespaceID(options NamespaceOptions) string {
	raw := fmt.Sprintf("%s|%s|%s", options.ScopeKey, options.CharacterName, options.PresetName)
	encoded := base64.RawURLEncoding.EncodeToString([]byte(raw))
	return fmt.Sprintf("ns_%s_%s", options.ScopeType, encoded)
}

// FindMemoryNamespace 只查询命名空间 ID，不存在时返回空字符串（不写库，适用于只读记忆库与召回路径）。
func (d *DB) FindMemoryNamespace(options NamespaceOptions) (string, error) {
	if options.ScopeType == "" {
		options.ScopeType = "session"
	}
	var existing string
	row := d.handle.QueryRow(
		`SELECT id FROM memory_namespaces
		 WHERE scope_type = ? AND scope_key = ? AND IFNULL(character_name,'') = ? AND IFNULL(preset_name,'') = ?
		 LIMIT 1`,
		options.ScopeType, options.ScopeKey, options.CharacterName, options.PresetName)
	err := row.Scan(&existing)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("查询记忆命名空间失败: %w", err)
	}
	return existing, nil
}

// EnsureMemoryNamespace 返回命名空间 ID，不存在时创建。
func (d *DB) EnsureMemoryNamespace(options NamespaceOptions) (string, error) {
	if options.ScopeType == "" {
		options.ScopeType = "session"
	}
	id := NamespaceID(options)
	var existing string
	row := d.handle.QueryRow(
		`SELECT id FROM memory_namespaces
		 WHERE scope_type = ? AND scope_key = ? AND IFNULL(character_name,'') = ? AND IFNULL(preset_name,'') = ?
		 LIMIT 1`,
		options.ScopeType, options.ScopeKey, options.CharacterName, options.PresetName)
	if err := row.Scan(&existing); err == nil && existing != "" {
		return existing, nil
	}
	now := time.Now().UnixMilli()
	if _, err := d.handle.Exec(
		`INSERT INTO memory_namespaces (id, scope_type, scope_key, character_name, preset_name, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO NOTHING`,
		id, options.ScopeType, options.ScopeKey, nullIfEmpty(options.CharacterName), nullIfEmpty(options.PresetName), now, now); err != nil {
		return "", fmt.Errorf("创建记忆命名空间失败: %w", err)
	}
	return id, nil
}

func nullIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

// ListRecentMemoryEntries 读取命名空间内最近的记忆条目。
func (d *DB) ListRecentMemoryEntries(options NamespaceOptions, limit int) ([]MemoryEntry, error) {
	namespaceID, err := d.FindMemoryNamespace(options)
	if err != nil {
		return nil, err
	}
	if namespaceID == "" {
		return []MemoryEntry{}, nil
	}
	if limit <= 0 {
		limit = 10
	}
	rows, err := d.handle.Query(
		`SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
		 FROM memory_entries
		 WHERE namespace_id = ?
		 ORDER BY updated_at DESC, rowid DESC
		 LIMIT ?`, namespaceID, limit)
	if err != nil {
		return nil, fmt.Errorf("读取记忆条目失败: %w", err)
	}
	defer rows.Close()
	return scanMemoryEntries(rows)
}

// SearchMemoryEntries 按关键词模糊匹配记忆条目。
func (d *DB) SearchMemoryEntries(options NamespaceOptions, query string, limit int) ([]MemoryEntry, error) {
	namespaceID, err := d.FindMemoryNamespace(options)
	if err != nil {
		return nil, err
	}
	if namespaceID == "" {
		return []MemoryEntry{}, nil
	}
	if limit <= 0 {
		limit = 10
	}
	keywords := BuildKeywordsFromText(query, 1)
	if len(keywords) == 0 {
		return []MemoryEntry{}, nil
	}
	clauses := []string{}
	arguments := []any{namespaceID}
	for _, keyword := range keywords {
		clauses = append(clauses, "content LIKE ?")
		arguments = append(arguments, "%"+keyword+"%")
	}
	arguments = append(arguments, limit)
	rows, err := d.handle.Query(
		`SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
		 FROM memory_entries
		 WHERE namespace_id = ? AND (`+strings.Join(clauses, " OR ")+`)
		 ORDER BY updated_at DESC, rowid DESC
		 LIMIT ?`, arguments...)
	if err != nil {
		return nil, fmt.Errorf("搜索记忆条目失败: %w", err)
	}
	defer rows.Close()
	return scanMemoryEntries(rows)
}

// ListRecentSummaryIndexEntries 读取最近的摘要索引。
func (d *DB) ListRecentSummaryIndexEntries(options NamespaceOptions, limit int) ([]SummaryEntry, error) {
	namespaceID, err := d.FindMemoryNamespace(options)
	if err != nil {
		return nil, err
	}
	if namespaceID == "" {
		return []SummaryEntry{}, nil
	}
	if limit <= 0 {
		limit = 10
	}
	rows, err := d.handle.Query(
		`SELECT id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at
		 FROM summary_index_entries
		 WHERE namespace_id = ?
		 ORDER BY updated_at DESC, rowid DESC
		 LIMIT ?`, namespaceID, limit)
	if err != nil {
		return nil, fmt.Errorf("读取摘要索引失败: %w", err)
	}
	defer rows.Close()
	entries := []SummaryEntry{}
	for rows.Next() {
		var item SummaryEntry
		var sourceSummaryID, sourceSessionID, outline, keywordsJSON, metadataJSON *string
		if err := rows.Scan(&item.ID, &sourceSummaryID, &sourceSessionID, &outline, &keywordsJSON, &metadataJSON, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.SourceSummaryID = deref(sourceSummaryID)
		item.SourceSessionID = deref(sourceSessionID)
		item.Outline = deref(outline)
		item.Keywords = parseStringList(deref(keywordsJSON))
		item.Metadata = parseObject(deref(metadataJSON))
		entries = append(entries, item)
	}
	return entries, rows.Err()
}

// ListKnowledgeEntries 读取固定/动态知识条目。
func (d *DB) ListKnowledgeEntries(options NamespaceOptions, knowledgeType string, limit int) ([]MemoryEntry, error) {
	namespaceID, err := d.FindMemoryNamespace(options)
	if err != nil {
		return nil, err
	}
	if namespaceID == "" {
		return []MemoryEntry{}, nil
	}
	if limit <= 0 {
		limit = 6
	}
	query := `SELECT me.id, me.entry_type, me.title, me.content, me.tags_json, me.metadata_json,
	                 me.source_session_id, me.source_message_id, me.created_at, me.updated_at
	          FROM memory_entries me
	          WHERE me.namespace_id = ? AND me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')`
	arguments := []any{namespaceID}
	if knowledgeType == "fixed" || knowledgeType == "dynamic" {
		query += " AND me.entry_type = ?"
		arguments = append(arguments, "knowledge_"+knowledgeType)
	}
	query += " ORDER BY me.updated_at DESC, me.rowid DESC LIMIT ?"
	arguments = append(arguments, limit)
	rows, err := d.handle.Query(query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("读取知识条目失败: %w", err)
	}
	defer rows.Close()
	return scanMemoryEntries(rows)
}

// RecallMemory 复刻 Node recallMemory 的打分与去重逻辑。
func (d *DB) RecallMemory(options NamespaceOptions, query string, recall RecallOptions) ([]MemoryEntry, error) {
	if recall.RecentLimit <= 0 {
		recall.RecentLimit = DefaultRecallOptions.RecentLimit
	}
	if recall.SearchLimit <= 0 {
		recall.SearchLimit = DefaultRecallOptions.SearchLimit
	}
	if recall.SummaryLimit <= 0 {
		recall.SummaryLimit = DefaultRecallOptions.SummaryLimit
	}
	if recall.FixedLimit <= 0 {
		recall.FixedLimit = DefaultRecallOptions.FixedLimit
	}
	if recall.Limit <= 0 {
		recall.Limit = DefaultRecallOptions.Limit
	}

	recent, err := d.ListRecentMemoryEntries(options, recall.RecentLimit)
	if err != nil {
		return nil, err
	}
	matched := []MemoryEntry{}
	if strings.TrimSpace(query) != "" {
		matched, err = d.SearchMemoryEntries(options, query, recall.SearchLimit)
		if err != nil {
			return nil, err
		}
	}
	summaries, err := d.ListRecentSummaryIndexEntries(options, recall.SummaryLimit)
	if err != nil {
		return nil, err
	}
	fixed, err := d.ListKnowledgeEntries(options, "fixed", recall.FixedLimit)
	if err != nil {
		return nil, err
	}

	keywords := BuildKeywordsFromText(query, 8)
	type scored struct {
		entry MemoryEntry
		score int
	}
	collected := map[string]scored{}

	add := func(entry MemoryEntry, isMatched bool) {
		if _, exists := collected[entry.ID]; exists {
			return
		}
		content := strings.ToLower(entry.Content)
		hits := 0
		for _, keyword := range keywords {
			if strings.Contains(content, keyword) {
				hits += 1
			}
		}
		recencyBoost := 20
		if isMatched {
			recencyBoost = 50
		}
		profileBoost := 0
		if entry.EntryType == "participant_profile" {
			profileBoost = 80
		}
		knowledgeBoost := 0
		switch entry.EntryType {
		case "knowledge_fixed":
			knowledgeBoost = 120
		case "knowledge_dynamic":
			knowledgeBoost = 70
		}
		switch entry.EntryType {
		case "knowledge_fixed":
			entry.SourceKind = "knowledge_fixed"
			entry.RecallReason = "fixed_knowledge"
		case "knowledge_dynamic":
			entry.SourceKind = "knowledge_dynamic"
			if isMatched {
				entry.RecallReason = "dynamic_knowledge_match"
			} else {
				entry.RecallReason = "dynamic_knowledge_recent"
			}
		case "participant_profile":
			entry.SourceKind = "participant_profile"
			entry.RecallReason = "participant_profile"
		default:
			entry.SourceKind = "memory_entry"
			if isMatched {
				entry.RecallReason = "keyword_match"
			} else {
				entry.RecallReason = "recent_memory"
			}
		}
		entry.RecallScore = knowledgeBoost + profileBoost + recencyBoost + hits*8
		collected[entry.ID] = scored{entry: entry, score: entry.RecallScore}
	}

	for _, entry := range fixed {
		add(entry, false)
	}
	matchedIDs := map[string]bool{}
	for _, entry := range matched {
		matchedIDs[entry.ID] = true
	}
	for _, entry := range matched {
		add(entry, true)
	}
	for _, entry := range recent {
		add(entry, matchedIDs[entry.ID])
	}

	results := make([]MemoryEntry, 0, len(collected))
	for _, item := range collected {
		results = append(results, item.entry)
	}
	// 稳定排序：分数降序，分数相同按更新时间降序
	for left := 0; left < len(results); left += 1 {
		for right := left + 1; right < len(results); right += 1 {
			if results[right].RecallScore > results[left].RecallScore ||
				(results[right].RecallScore == results[left].RecallScore && results[right].UpdatedAt > results[left].UpdatedAt) {
				results[left], results[right] = results[right], results[left]
			}
		}
	}
	if len(results) > recall.Limit {
		results = results[:recall.Limit]
	}

	for _, summary := range summaries {
		if len(results) >= recall.Limit+recall.SummaryLimit {
			break
		}
		lowered := strings.ToLower(summary.Outline)
		hits := 0
		for _, keyword := range keywords {
			if strings.Contains(lowered, keyword) {
				hits += 1
			}
		}
		results = append(results, MemoryEntry{
			ID:           summary.ID,
			Title:        "摘要索引",
			Content:      summary.Outline,
			Tags:         summary.Keywords,
			Metadata:     summary.Metadata,
			SourceKind:   "summary_index",
			RecallReason: "summary_index",
			RecallScore:  30 + hits*6,
			CreatedAt:    summary.CreatedAt,
			UpdatedAt:    summary.UpdatedAt,
		})
	}
	return results, nil
}

// AddMemoryEntry 写入一条记忆条目。
func (d *DB) AddMemoryEntry(options NamespaceOptions, entry MemoryEntry) (string, error) {
	namespaceID, err := d.EnsureMemoryNamespace(options)
	if err != nil {
		return "", err
	}
	if d.ReadOnly {
		return "", fmt.Errorf("记忆库以只读方式打开，无法写入")
	}
	now := time.Now().UnixMilli()
	id := entry.ID
	if id == "" {
		id = fmt.Sprintf("mem_%d_%s", now, randomSuffix(6))
	}
	if entry.EntryType == "" {
		entry.EntryType = "note"
	}
	tags := entry.Tags
	if tags == nil {
		tags = []string{}
	}
	metadata := entry.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	tagsJSON, _ := json.Marshal(tags)
	metadataJSON, _ := json.Marshal(metadata)
	if _, err := d.handle.Exec(
		`INSERT INTO memory_entries (id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, namespaceID, nullIfEmpty(entry.SourceSessionID), nullIfEmpty(entry.SourceMessageID), entry.EntryType,
		nullIfEmpty(entry.Title), entry.Content, string(tagsJSON), string(metadataJSON), now, now); err != nil {
		return "", fmt.Errorf("写入记忆条目失败: %w", err)
	}
	return id, nil
}

// BuildKeywordsFromText 复刻 Node buildKeywordsFromText（保留中文/英文/数字，长度 >= 2）。
func BuildKeywordsFromText(text string, limit int) []string {
	if limit <= 0 {
		limit = 12
	}
	lowered := strings.ToLower(text)
	builder := strings.Builder{}
	for _, runeValue := range lowered {
		switch {
		case runeValue >= 'a' && runeValue <= 'z', runeValue >= '0' && runeValue <= '9', runeValue >= 0x4e00 && runeValue <= 0x9fa5:
			builder.WriteRune(runeValue)
		default:
			builder.WriteRune(' ')
		}
	}
	seen := map[string]bool{}
	keywords := []string{}
	for _, word := range strings.Fields(builder.String()) {
		if len([]rune(word)) < 2 || seen[word] {
			continue
		}
		seen[word] = true
		keywords = append(keywords, word)
		if len(keywords) >= limit {
			break
		}
	}
	return keywords
}

// CountMemoryNamespaces 返回命名空间数量（健康检查用）。
func (d *DB) CountMemoryNamespaces() (int64, error) {
	var total int64
	if err := d.handle.QueryRow(`SELECT COUNT(*) FROM memory_namespaces`).Scan(&total); err != nil {
		return 0, err
	}
	return total, nil
}

func scanMemoryEntries(rows interface {
	Next() bool
	Scan(...any) error
	Err() error
}) ([]MemoryEntry, error) {
	entries := []MemoryEntry{}
	for rows.Next() {
		var item MemoryEntry
		var title, sourceSessionID, sourceMessageID, tagsJSON, metadataJSON *string
		if err := rows.Scan(&item.ID, &item.EntryType, &title, &item.Content, &tagsJSON, &metadataJSON,
			&sourceSessionID, &sourceMessageID, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.Title = deref(title)
		item.SourceSessionID = deref(sourceSessionID)
		item.SourceMessageID = deref(sourceMessageID)
		item.Tags = parseStringList(deref(tagsJSON))
		item.Metadata = parseObject(deref(metadataJSON))
		entries = append(entries, item)
	}
	return entries, rows.Err()
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func parseStringList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	values := []string{}
	if err := json.Unmarshal([]byte(raw), &values); err != nil {
		return []string{}
	}
	return values
}

func parseObject(raw string) map[string]any {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}
	}
	value := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return map[string]any{}
	}
	return value
}

func randomSuffix(length int) string {
	alphabet := "abcdefghijklmnopqrstuvwxyz0123456789"
	seed := sha256.Sum256([]byte(fmt.Sprintf("%d", time.Now().UnixNano())))
	builder := strings.Builder{}
	for index := 0; index < length; index += 1 {
		builder.WriteByte(alphabet[int(seed[index%len(seed)])%len(alphabet)])
	}
	return builder.String()
}
