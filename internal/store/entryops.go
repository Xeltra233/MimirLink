package store

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
