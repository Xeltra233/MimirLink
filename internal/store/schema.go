// Code generated from src/session.js prepareSchema; DO NOT EDIT BY HAND.
//
// SchemaSQL 与 Node 版的建表语句逐字一致，保证两个实现读写的表结构完全相同。
package store

// SchemaSQL 是记忆库的完整建表语句（与 src/session.js prepareSchema 对齐）。
const SchemaSQL = `
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_active INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    summary_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    metadata_json TEXT,
    timestamp INTEGER NOT NULL,
    date_iso TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_time
ON messages(session_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_messages_content
ON messages(content);

CREATE TABLE IF NOT EXISTS summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    content TEXT NOT NULL,
    source_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    date_iso TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summaries_session_time
ON summaries(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS sticky_entries (
    session_id TEXT NOT NULL,
    entry_key TEXT NOT NULL,
    remaining INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_key),
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_namespaces (
    id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    character_name TEXT,
    preset_name TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_namespaces_scope
ON memory_namespaces(scope_type, scope_key, IFNULL(character_name, ''), IFNULL(preset_name, ''));

CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    source_session_id TEXT,
    source_message_id TEXT,
    entry_type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    tags_json TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (namespace_id) REFERENCES memory_namespaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_entries_namespace_time
ON memory_entries(namespace_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_entries_content
ON memory_entries(content);

CREATE TABLE IF NOT EXISTS summary_index_entries (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    source_summary_id TEXT,
    source_session_id TEXT,
    outline TEXT NOT NULL,
    keywords_json TEXT,
    metadata_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (namespace_id) REFERENCES memory_namespaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_summary_index_namespace_time
ON summary_index_entries(namespace_id, updated_at DESC);
`
