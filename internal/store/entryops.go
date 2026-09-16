package store

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// 本文件补齐面板端按 entry id 读取/删除知识条目与人物档案的能力，
// 以及人物档案的保存（对齐 Node getKnowledgeEntry / deleteKnowledgeEntry /
// getParticipantProfileByEntryId / deleteParticipantProfile / saveParticipantProfile）。

// GetKnowledgeEntry 按 entry id 取知识条目。
func (d *DB) GetKnowledgeEntry(entryID string) (*KnowledgeEntry, error) {
	// scanKnowledge 需要 15 列（含 entry_type），不要复用不含 entry_type 的 scopedEntrySelect
	query := `SELECT me.id, me.namespace_id, me.entry_type, me.title, me.content, me.tags_json, me.metadata_json,
		me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
		ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
		FROM memory_entries me
		INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
		WHERE me.id = ? AND me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic') LIMIT 1`
	rows, err := d.handle.Query(query, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanKnowledge(rows)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// DeleteKnowledgeEntry 删除知识条目。
func (d *DB) DeleteKnowledgeEntry(entryID string) (bool, error) {
	result, err := d.handle.Exec(
		`DELETE FROM memory_entries WHERE id = ? AND entry_type IN ('knowledge_fixed', 'knowledge_dynamic')`, entryID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

// UpdateKnowledgeEntry 按 entry id 更新知识条目（对齐 Node saveKnowledgeEntry 的更新路径）。
func (d *DB) UpdateKnowledgeEntry(entryID string, entry KnowledgeEntry) (bool, error) {
	if d.ReadOnly {
		return false, fmt.Errorf("记忆库以只读方式打开，无法写入")
	}
	title := strings.TrimSpace(entry.Title)
	if title == "" {
		return false, fmt.Errorf("知识标题不能为空")
	}
	content := strings.TrimSpace(entry.Content)
	if content == "" {
		return false, fmt.Errorf("知识内容不能为空")
	}
	knowledgeType := "dynamic"
	if entry.KnowledgeType == "fixed" {
		knowledgeType = "fixed"
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
	tags := entry.Tags
	if tags == nil {
		tags = []string{}
	}
	tagsJSON, _ := json.Marshal(tags)
	metadataJSON, _ := json.Marshal(metadata)
	result, err := d.handle.Exec(
		`UPDATE memory_entries SET title = ?, content = ?, tags_json = ?, metadata_json = ?, updated_at = ?
		 WHERE id = ? AND entry_type IN ('knowledge_fixed', 'knowledge_dynamic')`,
		title, content, string(tagsJSON), string(metadataJSON), time.Now().UnixMilli(), entryID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

// GetParticipantProfileByEntryID 按 entry id 取人物档案。
func (d *DB) GetParticipantProfileByEntryID(entryID string) (*ParticipantProfile, error) {
	query := `SELECT me.id, me.namespace_id, me.title, me.content, me.tags_json, me.metadata_json,
		me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
		ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
		FROM memory_entries me
		INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
		WHERE me.id = ? AND me.entry_type = 'participant_profile' LIMIT 1`
	rows, err := d.handle.Query(query, entryID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	if !rows.Next() {
		return nil, rows.Err()
	}
	item, err := scanParticipantProfile(rows)
	if err != nil {
		return nil, err
	}
	return &item, nil
}

// DeleteParticipantProfile 删除人物档案。
func (d *DB) DeleteParticipantProfile(entryID string) (bool, error) {
	result, err := d.handle.Exec(
		`DELETE FROM memory_entries WHERE id = ? AND entry_type = 'participant_profile'`, entryID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

// MessageTimeRange 返回消息表的时间范围（用于面板记忆统计）。
func (d *DB) MessageTimeRange() (oldest int64, newest int64) {
	row := d.handle.QueryRow(`SELECT IFNULL(MIN(created_at), 0), IFNULL(MAX(created_at), 0) FROM messages`)
	_ = row.Scan(&oldest, &newest)
	return oldest, newest
}

// ListKnowledgeEntryIDs 便于测试断言（返回全部知识条目 ID）。
func (d *DB) ListKnowledgeEntryIDs() ([]string, error) {
	rows, err := d.handle.Query(`SELECT id FROM memory_entries WHERE entry_type IN ('knowledge_fixed','knowledge_dynamic') ORDER BY updated_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// ClearAllData 清空整个记忆库（对齐 Node SessionManager.clearAllData 的语义与返回计数）。
func (d *DB) ClearAllData() (map[string]int, error) {
	if d.ReadOnly {
		return nil, fmt.Errorf("记忆库以只读方式打开，无法清空")
	}
	cleared := map[string]int{"sessions": 0, "messages": 0, "summaries": 0, "variables": 0, "namespaces": 0, "profiles": 0, "knowledge": 0}
	type step struct {
		key  string
		sql  string
		args []any
	}
	steps := []step{
		{"variables", `DELETE FROM memory_entries WHERE entry_type = 'variable'`, nil},
		{"profiles", `DELETE FROM memory_entries WHERE entry_type = 'participant_profile'`, nil},
		{"knowledge", `DELETE FROM memory_entries WHERE entry_type = 'knowledge'`, nil},
		{"knowledge", `DELETE FROM memory_entries WHERE entry_type NOT IN ('variable', 'participant_profile', 'knowledge')`, nil},
		{"messages", `DELETE FROM messages`, nil},
		{"summaries", `DELETE FROM summaries`, nil},
		{"sessions", `DELETE FROM sessions`, nil},
		{"namespaces", `DELETE FROM memory_namespaces`, nil},
	}
	for _, item := range steps {
		result, err := d.handle.Exec(item.sql, item.args...)
		if err != nil {
			return cleared, fmt.Errorf("清空数据失败(%s): %w", item.key, err)
		}
		affected, _ := result.RowsAffected()
		cleared[item.key] += int(affected)
	}
	// 关联表（可能不存在于旧库，失败不阻断，与 Node 的 try/catch 一致）
	_, _ = d.handle.Exec(`DELETE FROM sticky_entries`)
	_, _ = d.handle.Exec(`DELETE FROM summary_index_entries`)
	return cleared, nil
}
