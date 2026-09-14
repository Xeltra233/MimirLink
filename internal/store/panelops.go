package store

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// 本文件对齐 Node src/session.js 中面板使用的变量/知识/人物档案/会话操作，
// SQL 形状与 Node prepareStatements 保持一致（含 NULL 过滤语义）。

// VariableFilters 是变量/知识列表筛选（对应 Node normalizeVariableFilters）。
type VariableFilters struct {
	ScopeType     string
	ScopeKey      string
	CharacterName string
	PresetName    string
	Search        string
	KnowledgeType string
	Limit         int
}

// Variable 是一条面板变量（对应 Node mapVariableRow 输出形状）。
type Variable struct {
	ID              string         `json:"id"`
	NamespaceID     string         `json:"namespaceId"`
	Key             string         `json:"key"`
	Title           string         `json:"title"`
	Value           any            `json:"value"`
	RawValue        string         `json:"rawValue"`
	ValueType       string         `json:"valueType"`
	Tags            []string       `json:"tags"`
	Metadata        map[string]any `json:"metadata"`
	SourceSessionID string         `json:"sourceSessionId"`
	SourceMessageID string         `json:"sourceMessageId"`
	ScopeType       string         `json:"scopeType"`
	ScopeKey        string         `json:"scopeKey"`
	CharacterName   string         `json:"characterName"`
	PresetName      string         `json:"presetName"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
}

// KnowledgeEntry 是一条知识条目（对应 Node mapKnowledgeRow 输出形状）。
type KnowledgeEntry struct {
	ID              string         `json:"id"`
	NamespaceID     string         `json:"namespaceId"`
	EntryType       string         `json:"entryType"`
	KnowledgeType   string         `json:"knowledgeType"`
	Title           string         `json:"title"`
	ContentPreview  string         `json:"contentPreview"`
	Content         string         `json:"content"`
	Tags            []string       `json:"tags"`
	ScopeType       string         `json:"scopeType"`
	ScopeKey        string         `json:"scopeKey"`
	CharacterName   string         `json:"characterName"`
	PresetName      string         `json:"presetName"`
	Metadata        map[string]any `json:"metadata"`
	SourceSessionID string         `json:"sourceSessionId"`
	SourceMessageID string         `json:"sourceMessageId"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
}

// ParticipantProfile 是一条人物档案（对应 Node mapParticipantProfileRow 输出形状）。
type ParticipantProfile struct {
	ID              string         `json:"id"`
	NamespaceID     string         `json:"namespaceId"`
	ParticipantID   string         `json:"participantId"`
	ParticipantName string         `json:"participantName"`
	Title           string         `json:"title"`
	ContentPreview  string         `json:"contentPreview"`
	Content         string         `json:"content"`
	Tags            []string       `json:"tags"`
	ScopeType       string         `json:"scopeType"`
	ScopeKey        string         `json:"scopeKey"`
	CharacterName   string         `json:"characterName"`
	PresetName      string         `json:"presetName"`
	Metadata        map[string]any `json:"metadata"`
	SourceSessionID string         `json:"sourceSessionId"`
	SourceMessageID string         `json:"sourceMessageId"`
	CreatedAt       int64          `json:"createdAt"`
	UpdatedAt       int64          `json:"updatedAt"`
}

const scopedEntrySelect = `
    me.id, me.namespace_id, me.title, me.content, me.tags_json, me.metadata_json,
    me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
    ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
FROM memory_entries me
INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id`

// scopedFilters 生成与 Node listVariables 相同的 NULL 过滤参数序列。
func scopedFilters(filters VariableFilters) []any {
	nullOr := func(value string) any {
		if value == "" {
			return nil
		}
		return value
	}
	arguments := []any{
		nullOr(filters.ScopeType), nullOr(filters.ScopeType),
		nullOr(filters.ScopeKey), nullOr(filters.ScopeKey),
		nullOr(filters.CharacterName), nullOr(filters.CharacterName),
		nullOr(filters.PresetName), nullOr(filters.PresetName),
	}
	if filters.Search != "" {
		pattern := "%" + strings.TrimSpace(filters.Search) + "%"
		// 标题/内容/标签/元数据 + 命名空间四字段（与 Node 一致共 9 个占位）
		arguments = append(arguments, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
	} else {
		arguments = append(arguments, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	}
	return arguments
}

func scopedSearchClause(column string) string {
	return ` AND (? IS NULL OR ` + column + `.title LIKE ? OR ` + column + `.content LIKE ? OR IFNULL(` + column + `.tags_json, '') LIKE ? OR IFNULL(` + column + `.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)`
}

// ListVariables 列出变量（对齐 Node listVariables）。
func (d *DB) ListVariables(filters VariableFilters) ([]Variable, error) {
	if filters.Limit <= 0 {
		filters.Limit = 100
	}
	if filters.Limit > 500 {
		filters.Limit = 500
	}
	query := `SELECT ` + scopedEntrySelect + `
		WHERE me.entry_type = 'variable'
		  AND (? IS NULL OR ns.scope_type = ?)
		  AND (? IS NULL OR ns.scope_key = ?)
		  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
		  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)` +
		scopedSearchClause("me") + `
		ORDER BY me.updated_at DESC, me.rowid DESC
		LIMIT ?`
	rows, err := d.handle.Query(query, append(scopedFilters(filters), filters.Limit)...)
	if err != nil {
		return nil, fmt.Errorf("读取变量失败: %w", err)
	}
	defer rows.Close()
	items := []Variable{}
	for rows.Next() {
		item, err := scanVariable(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type rowScanner interface{ Scan(...any) error }

func scanVariable(rows rowScanner) (Variable, error) {
	var item Variable
	var title, tagsJSON, metadataJSON, sourceSessionID, sourceMessageID, scopeType, scopeKey, characterName, presetName *string
	if err := rows.Scan(&item.ID, &item.NamespaceID, &title, &item.RawValue, &tagsJSON, &metadataJSON,
		&sourceSessionID, &sourceMessageID, &item.CreatedAt, &item.UpdatedAt,
		&scopeType, &scopeKey, &characterName, &presetName); err != nil {
		return item, err
	}
	item.Title = deref(title)
	item.Key = item.Title
	item.ValueType = normalizeVariableType(valueTypeOf(deref(metadataJSON)))
	item.Value = parseVariableValue(item.RawValue, item.ValueType)
	item.Tags = parseStringList(deref(tagsJSON))
	item.Metadata = parseObject(deref(metadataJSON))
	item.SourceSessionID = deref(sourceSessionID)
	item.SourceMessageID = deref(sourceMessageID)
	item.ScopeType = deref(scopeType)
	item.ScopeKey = deref(scopeKey)
	item.CharacterName = deref(characterName)
	item.PresetName = deref(presetName)
	return item, nil
}

func valueTypeOf(metadataJSON string) string {
	metadata := parseObject(metadataJSON)
	if raw, ok := metadata["valueType"].(string); ok && raw != "" {
		return raw
	}
	return "string"
}

func normalizeVariableType(valueType string) string {
	switch valueType {
	case "number", "boolean", "json":
		return valueType
	default:
		return "string"
	}
}

func parseVariableValue(rawValue, declaredType string) any {
	switch declaredType {
	case "number":
		var value float64
		if err := json.Unmarshal([]byte(rawValue), &value); err == nil {
			return value
		}
		var valueInt int64
		if _, err := fmt.Sscanf(strings.TrimSpace(rawValue), "%d", &valueInt); err == nil {
			return valueInt
		}
		return nil
	case "boolean":
		normalized := strings.ToLower(strings.TrimSpace(rawValue))
		switch normalized {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
		return nil
	case "json":
		var value any
		if err := json.Unmarshal([]byte(rawValue), &value); err == nil {
			return value
		}
		return nil
	default:
		return rawValue
	}
}

// SerializeVariableValue 对齐 Node serializeVariableValue。
func SerializeVariableValue(value any, declaredType string) string {
	if value == nil {
		return ""
	}
	if declaredType == "json" {
		if raw, ok := value.(string); ok {
			return raw
		}
		encoded, err := json.MarshalIndent(value, "", "  ")
		if err != nil {
			return fmt.Sprintf("%v", value)
		}
		return string(encoded)
	}
	switch typed := value.(type) {
	case string:
		return typed
	case bool:
		if typed {
			return "true"
		}
		return "false"
	case float64, float32, int, int64:
		return strings.TrimSuffix(strings.TrimSuffix(fmt.Sprintf("%v", typed), "0"), ".")
	default:
		return fmt.Sprintf("%v", value)
	}
}

// GetVariableByEntryId 按 entry id 取变量（对齐 Node getVariableByEntryId）。
func (d *DB) GetVariableByEntryId(entryID string) (*Variable, error) {
	query := `SELECT ` + scopedEntrySelect + ` WHERE me.id = ? AND me.entry_type = 'variable' LIMIT 1`
	rows, err := d.handle.Query(query, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanVariable(rows)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// UpsertVariable 创建或更新变量（对齐 Node upsertVariable）。
func (d *DB) UpsertVariable(options NamespaceOptions, variable Variable) (id string, updated bool, err error) {
	key := strings.TrimSpace(variable.Key)
	if key == "" {
		key = strings.TrimSpace(variable.Title)
	}
	if key == "" {
		return "", false, fmt.Errorf("变量名不能为空")
	}
	valueType := normalizeVariableType(variable.ValueType)
	rawValue := variable.RawValue
	if variable.Value != nil && variable.RawValue == "" {
		rawValue = SerializeVariableValue(variable.Value, valueType)
	}
	namespaceID, err := d.EnsureMemoryNamespace(options)
	if err != nil {
		return "", false, err
	}
	now := time.Now().UnixMilli()

	// 与 Node 一致：valueType 与 source 始终写入元数据（创建与更新分支共用）
	if variable.Metadata == nil {
		variable.Metadata = map[string]any{}
	}
	variable.Metadata["valueType"] = valueType
	if _, ok := variable.Metadata["source"]; !ok {
		variable.Metadata["source"] = "admin"
	}

	var existingID, existingTagsJSON, existingMetadataJSON, existingSourceSession, existingSourceMessage sql.NullString
	err = d.handle.QueryRow(
		`SELECT id, tags_json, metadata_json, source_session_id, source_message_id
		 FROM memory_entries WHERE namespace_id = ? AND entry_type = 'variable' AND title = ?
		 ORDER BY updated_at DESC, rowid DESC LIMIT 1`, namespaceID, key).
		Scan(&existingID, &existingTagsJSON, &existingMetadataJSON, &existingSourceSession, &existingSourceMessage)
	if err == nil {
		// 更新：标签并集，元数据浅合并（与 Node 展开顺序一致）
		mergedTags := mergeUnique(variable.Tags, existingTagsJSON.String)
		metadata := parseObject(existingMetadataJSON.String)
		for k, v := range variable.Metadata {
			metadata[k] = v
		}
		metadata["valueType"] = valueType
		if variable.Metadata == nil || metadata["source"] == nil {
			if _, ok := metadata["source"]; !ok {
				metadata["source"] = "admin"
			}
		}
		sourceSession := variable.SourceSessionID
		if sourceSession == "" {
			sourceSession = existingSourceSession.String
		}
		sourceMessage := variable.SourceMessageID
		if sourceMessage == "" {
			sourceMessage = existingSourceMessage.String
		}
		if _, err := d.handle.Exec(
			`UPDATE memory_entries SET title = ?, content = ?, tags_json = ?, metadata_json = ?, source_session_id = ?, source_message_id = ?, updated_at = ? WHERE id = ?`,
			key, rawValue, marshalJSON(mergedTags), marshalJSON(metadata), nullIfEmpty(sourceSession), nullIfEmpty(sourceMessage), now, existingID.String); err != nil {
			return "", false, fmt.Errorf("更新变量失败: %w", err)
		}
		return existingID.String, true, nil
	}
	if err != sql.ErrNoRows {
		return "", false, err
	}

	newID, err := d.insertMemoryEntry(namespaceID, "variable", key, rawValue, variable.Tags, variable.Metadata, variable.SourceSessionID, variable.SourceMessageID)
	return newID, false, err
}

// DeleteVariable 删除变量条目。
func (d *DB) DeleteVariable(entryID string) (bool, error) {
	result, err := d.handle.Exec(`DELETE FROM memory_entries WHERE id = ? AND entry_type = 'variable'`, entryID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

// ListKnowledgeEntries 列出知识条目（对齐 Node listKnowledgeEntries，knowledgeType: ”|fixed|dynamic）。
func (d *DB) ListKnowledgeEntriesFiltered(filters VariableFilters) ([]KnowledgeEntry, error) {
	if filters.Limit <= 0 {
		filters.Limit = 100
	}
	if filters.Limit > 500 {
		filters.Limit = 500
	}
	knowledgeType := ""
	switch {
	case strings.EqualFold(filters.KnowledgeType, "fixed"):
		knowledgeType = "knowledge_fixed"
	case strings.EqualFold(filters.KnowledgeType, "dynamic"):
		knowledgeType = "knowledge_dynamic"
	}
	query := `SELECT me.id, me.namespace_id, me.entry_type, me.title, me.content, me.tags_json, me.metadata_json,
		me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
		ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
	FROM memory_entries me
	INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
	WHERE me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')
	  AND (? IS NULL OR ns.scope_type = ?)
	  AND (? IS NULL OR ns.scope_key = ?)
	  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
	  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)
	  AND (? IS NULL OR me.entry_type = ?)` +
		scopedSearchClause("me") + `
		ORDER BY me.updated_at DESC, me.rowid DESC
		LIMIT ?`
	// 重新组织参数：scope(8) + knowledgeType(2) + search(9) + limit
	arguments := []any{}
	nullOr := func(value string) any {
		if value == "" {
			return nil
		}
		return value
	}
	arguments = append(arguments,
		nullOr(filters.ScopeType), nullOr(filters.ScopeType),
		nullOr(filters.ScopeKey), nullOr(filters.ScopeKey),
		nullOr(filters.CharacterName), nullOr(filters.CharacterName),
		nullOr(filters.PresetName), nullOr(filters.PresetName),
		nullOr(knowledgeType), nullOr(knowledgeType))
	if filters.Search != "" {
		pattern := "%" + strings.TrimSpace(filters.Search) + "%"
		arguments = append(arguments, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
	} else {
		arguments = append(arguments, nil, nil, nil, nil, nil, nil, nil, nil, nil)
	}
	arguments = append(arguments, filters.Limit)
	rows, err := d.handle.Query(query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("读取知识条目失败: %w", err)
	}
	defer rows.Close()
	items := []KnowledgeEntry{}
	for rows.Next() {
		item, err := scanKnowledge(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func scanKnowledge(rows rowScanner) (KnowledgeEntry, error) {
	var item KnowledgeEntry
	var title, tagsJSON, metadataJSON, sourceSessionID, sourceMessageID, scopeType, scopeKey, characterName, presetName *string
	if err := rows.Scan(&item.ID, &item.NamespaceID, &item.EntryType, &title, &item.Content, &tagsJSON, &metadataJSON,
		&sourceSessionID, &sourceMessageID, &item.CreatedAt, &item.UpdatedAt,
		&scopeType, &scopeKey, &characterName, &presetName); err != nil {
		return item, err
	}
	item.Title = deref(title)
	metadata := parseObject(deref(metadataJSON))
	if raw, ok := metadata["knowledgeType"].(string); ok && raw != "" {
		item.KnowledgeType = raw
	} else if item.EntryType == "knowledge_fixed" {
		item.KnowledgeType = "fixed"
	} else {
		item.KnowledgeType = "dynamic"
	}
	item.ContentPreview = truncateText(item.Content, 160)
	item.Tags = parseStringList(deref(tagsJSON))
	item.ScopeType = deref(scopeType)
	item.ScopeKey = deref(scopeKey)
	item.CharacterName = deref(characterName)
	item.PresetName = deref(presetName)
	item.Metadata = metadata
	item.SourceSessionID = deref(sourceSessionID)
	item.SourceMessageID = deref(sourceMessageID)
	return item, nil
}

// UpsertKnowledgeEntry 创建知识条目（对齐 Node upsertKnowledgeEntry）。
func (d *DB) UpsertKnowledgeEntry(options NamespaceOptions, entry KnowledgeEntry) (string, error) {
	title := strings.TrimSpace(entry.Title)
	if title == "" {
		return "", fmt.Errorf("知识标题不能为空")
	}
	content := strings.TrimSpace(entry.Content)
	if content == "" {
		return "", fmt.Errorf("知识内容不能为空")
	}
	knowledgeType := "dynamic"
	if entry.KnowledgeType == "fixed" {
		knowledgeType = "fixed"
	}
	entryType := "knowledge_dynamic"
	if knowledgeType == "fixed" {
		entryType = "knowledge_fixed"
	}
	metadata := entry.Metadata
	if metadata == nil {
		metadata = map[string]any{}
	}
	metadata["knowledgeType"] = knowledgeType
	if _, ok := metadata["source"]; !ok {
		metadata["source"] = "admin"
	}
	if _, ok := metadata["updatedBy"]; !ok {
		metadata["updatedBy"] = "admin-panel"
	}
	namespaceID, err := d.EnsureMemoryNamespace(options)
	if err != nil {
		return "", err
	}
	return d.insertMemoryEntry(namespaceID, entryType, title, content, entry.Tags, metadata, entry.SourceSessionID, entry.SourceMessageID)
}

// insertMemoryEntry 在已确保存在的命名空间下写入条目（对齐 Node addMemoryEntry 的 ID/默认值规则）。
func (d *DB) insertMemoryEntry(namespaceID, entryType, title, content string, tags []string, metadata map[string]any, sourceSessionID, sourceMessageID string) (string, error) {
	if d.ReadOnly {
		return "", fmt.Errorf("记忆库以只读方式打开，无法写入")
	}
	now := time.Now().UnixMilli()
	id := fmt.Sprintf("mem_%d_%s", now, randomSuffix(6))
	if tags == nil {
		tags = []string{}
	}
	if metadata == nil {
		metadata = map[string]any{}
	}
	tagsJSON, _ := json.Marshal(tags)
	metadataJSON, _ := json.Marshal(metadata)
	if _, err := d.handle.Exec(
		`INSERT INTO memory_entries (id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, namespaceID, nullIfEmpty(sourceSessionID), nullIfEmpty(sourceMessageID), entryType, nullIfEmpty(title), content,
		string(tagsJSON), string(metadataJSON), now, now); err != nil {
		return "", fmt.Errorf("写入记忆条目失败: %w", err)
	}
	return id, nil
}

// ListParticipantProfiles 列出人物档案（对齐 Node listParticipantProfiles：按 participant_key+scope+character 去重取最新）。
func (d *DB) ListParticipantProfiles(limit int, search string) ([]ParticipantProfile, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 500 {
		limit = 500
	}
	query := `
		WITH profiles AS (
			SELECT me.id, me.namespace_id, me.title, me.content, me.tags_json, me.metadata_json,
				me.source_session_id, me.source_message_id, me.created_at, me.updated_at, me.rowid AS entry_rowid,
				ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name,
				COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id) AS participant_key,
				IFNULL(ns.character_name, '') AS character_key,
				IFNULL(ns.preset_name, '') AS preset_key
			FROM memory_entries me
			INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
			WHERE me.entry_type = 'participant_profile'
		),
		ranked AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY participant_key, scope_type, scope_key, character_key
				ORDER BY updated_at DESC, entry_rowid DESC
			) AS profile_rank
			FROM profiles
		)
		SELECT id, namespace_id, title, content, tags_json, metadata_json, source_session_id, source_message_id,
			created_at, updated_at, scope_type, scope_key, character_name, preset_name
		FROM ranked
		WHERE profile_rank = 1`
	arguments := []any{}
	if search != "" {
		pattern := "%" + search + "%"
		query += ` AND (title LIKE ? OR content LIKE ? OR IFNULL(metadata_json, '') LIKE ? OR scope_type LIKE ? OR scope_key LIKE ? OR IFNULL(character_name, '') LIKE ? OR IFNULL(preset_name, '') LIKE ?)`
		arguments = append(arguments, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
	}
	query += ` ORDER BY updated_at DESC, entry_rowid DESC LIMIT ?`
	arguments = append(arguments, limit)
	rows, err := d.handle.Query(query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("读取人物档案失败: %w", err)
	}
	defer rows.Close()
	items := []ParticipantProfile{}
	for rows.Next() {
		item, err := scanParticipantProfile(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// CountParticipantProfiles 统计去重后的人物档案数量。
func (d *DB) CountParticipantProfiles(search string) (int, error) {
	query := `
		SELECT COUNT(*) FROM (
			SELECT ROW_NUMBER() OVER (
				PARTITION BY COALESCE(NULLIF(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), ''), me.id),
					ns.scope_type, ns.scope_key, IFNULL(ns.character_name, '')
				ORDER BY me.updated_at DESC, me.rowid DESC
			) AS profile_rank
			FROM memory_entries me
			INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
			WHERE me.entry_type = 'participant_profile'`
	arguments := []any{}
	if search != "" {
		pattern := "%" + search + "%"
		query += ` AND (me.title LIKE ? OR me.content LIKE ? OR IFNULL(me.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)`
		arguments = append(arguments, pattern, pattern, pattern, pattern, pattern, pattern, pattern)
	}
	query += `) WHERE profile_rank = 1`
	var count int
	if err := d.handle.QueryRow(query, arguments...).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
}

func scanParticipantProfile(rows rowScanner) (ParticipantProfile, error) {
	var item ParticipantProfile
	var title, tagsJSON, metadataJSON, sourceSessionID, sourceMessageID, scopeType, scopeKey, characterName, presetName *string
	if err := rows.Scan(&item.ID, &item.NamespaceID, &title, &item.Content, &tagsJSON, &metadataJSON,
		&sourceSessionID, &sourceMessageID, &item.CreatedAt, &item.UpdatedAt,
		&scopeType, &scopeKey, &characterName, &presetName); err != nil {
		return item, err
	}
	item.Title = deref(title)
	metadata := parseObject(deref(metadataJSON))
	item.ParticipantID = strings.TrimSpace(anyStringOr(metadata["participantId"], item.ID))
	item.ParticipantName = strings.TrimSpace(anyStringOr(metadata["participantName"], item.Title))
	if item.ParticipantName == "" {
		item.ParticipantName = item.ParticipantID
	}
	if item.Title == "" {
		item.Title = item.ParticipantName
	}
	item.ContentPreview = truncateText(item.Content, 160)
	item.Tags = parseStringList(deref(tagsJSON))
	item.ScopeType = deref(scopeType)
	item.ScopeKey = deref(scopeKey)
	item.CharacterName = deref(characterName)
	item.PresetName = deref(presetName)
	item.Metadata = metadata
	item.SourceSessionID = deref(sourceSessionID)
	item.SourceMessageID = deref(sourceMessageID)
	return item, nil
}

// DeleteSession 删除会话及全部消息/摘要/粘性条目（对齐 Node clearSession）。
func (d *DB) DeleteSession(sessionID string) error {
	transaction, err := d.handle.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	for _, statement := range []string{
		`DELETE FROM messages WHERE session_id = ?`,
		`DELETE FROM summaries WHERE session_id = ?`,
		`DELETE FROM sticky_entries WHERE session_id = ?`,
		`DELETE FROM sessions WHERE id = ?`,
	} {
		if _, err := transaction.Exec(statement, sessionID); err != nil {
			return fmt.Errorf("删除会话失败: %w", err)
		}
	}
	return transaction.Commit()
}

// ClearHistory 清空会话历史但保留会话（对齐 Node clearHistory）。
func (d *DB) ClearHistory(sessionID string) error {
	if err := d.EnsureSession(sessionID); err != nil {
		return err
	}
	transaction, err := d.handle.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	for _, statement := range []string{
		`DELETE FROM messages WHERE session_id = ?`,
		`DELETE FROM summaries WHERE session_id = ?`,
		`DELETE FROM sticky_entries WHERE session_id = ?`,
		`UPDATE sessions SET summary_count = 0, last_active = ? WHERE id = ?`,
	} {
		arguments := []any{sessionID}
		if strings.HasPrefix(statement, "UPDATE") {
			arguments = []any{time.Now().UnixMilli(), sessionID}
		}
		if _, err := transaction.Exec(statement, arguments...); err != nil {
			return fmt.Errorf("清除会话历史失败: %w", err)
		}
	}
	return transaction.Commit()
}

// EnsureSession 保证会话行存在（对齐 Node ensureSession）。
func (d *DB) EnsureSession(sessionID string) error {
	now := time.Now().UnixMilli()
	if _, err := d.handle.Exec(
		`INSERT INTO sessions (id, message_count, summary_count, created_at, last_active) VALUES (?, 0, 0, ?, ?)
		 ON CONFLICT(id) DO NOTHING`, sessionID, now, now); err != nil {
		return fmt.Errorf("确保会话存在失败: %w", err)
	}
	return nil
}

// ---------- 辅助 ----------

func mergeUnique(primary []string, secondaryJSON string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, tag := range append(append([]string{}, primary...), parseStringList(secondaryJSON)...) {
		if tag == "" || seen[tag] {
			continue
		}
		seen[tag] = true
		result = append(result, tag)
	}
	return result
}

func marshalJSON(value any) string {
	if value == nil {
		return "{}"
	}
	if tags, ok := value.([]string); ok {
		if tags == nil {
			tags = []string{}
		}
		encoded, err := json.Marshal(tags)
		if err == nil {
			return string(encoded)
		}
		return "[]"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func truncateText(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit]) + "…"
}

func stringOr(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func anyStringOr(values ...any) string {
	for _, value := range values {
		if text, ok := value.(string); ok && text != "" {
			return text
		}
	}
	return ""
}

// ListStickyEntries 返回会话的粘性条目（entry_key → remaining），对齐 Node getStickyEntriesObject。
func (d *DB) ListStickyEntries(sessionID string) (map[string]int, error) {
	rows, err := d.handle.Query(`SELECT entry_key, remaining FROM sticky_entries WHERE session_id = ?`, sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]int{}
	for rows.Next() {
		var key string
		var remaining int
		if err := rows.Scan(&key, &remaining); err != nil {
			return nil, err
		}
		result[key] = remaining
	}
	return result, rows.Err()
}

// StickyTrigger 是本次触发需要续期的粘性条目。
type StickyTrigger struct {
	Key    string
	Sticky int
}

// UpdateStickyEntries 对齐 Node updateStickyEntries：现有条目递减、归零删除、触发的条目续期。
func (d *DB) UpdateStickyEntries(sessionID string, triggered []StickyTrigger) error {
	if err := d.EnsureSession(sessionID); err != nil {
		return err
	}
	current, err := d.ListStickyEntries(sessionID)
	if err != nil {
		return err
	}
	transaction, err := d.handle.Begin()
	if err != nil {
		return err
	}
	defer transaction.Rollback()
	for key, remaining := range current {
		next := remaining - 1
		if next <= 0 {
			if _, err := transaction.Exec(`DELETE FROM sticky_entries WHERE session_id = ? AND entry_key = ?`, sessionID, key); err != nil {
				return err
			}
			continue
		}
		if _, err := transaction.Exec(
			`INSERT INTO sticky_entries (session_id, entry_key, remaining) VALUES (?, ?, ?)
			 ON CONFLICT(session_id, entry_key) DO UPDATE SET remaining = excluded.remaining`,
			sessionID, key, next); err != nil {
			return err
		}
	}
	for _, entry := range triggered {
		if entry.Sticky > 0 && entry.Key != "" {
			if _, err := transaction.Exec(
				`INSERT INTO sticky_entries (session_id, entry_key, remaining) VALUES (?, ?, ?)
				 ON CONFLICT(session_id, entry_key) DO UPDATE SET remaining = excluded.remaining`,
				sessionID, entry.Key, entry.Sticky); err != nil {
				return err
			}
		}
	}
	return transaction.Commit()
}
