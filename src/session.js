/**
 * 会话与记忆存储模块
 * 使用 SQLite 持久化会话、消息、摘要和粘性条目状态。
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

import { getParticipantProfileConfig } from './participant-profile-config.js';

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function truncate(text, maxLength = 240) {
    if (!text) {
        return '';
    }
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function summarizeText(value, maxLength = 120) {
    const normalized = String(value || '').trim();
    return {
        length: normalized.length,
        preview: truncate(normalized, maxLength)
    };
}

function summarizeNamespaceOptions(namespaceOptions = {}) {
    return {
        scopeType: namespaceOptions.scopeType || '',
        scopeKey: namespaceOptions.scopeKey || '',
        characterName: namespaceOptions.characterName || '',
        presetName: namespaceOptions.presetName || ''
    };
}

function parseJson(value, fallback) {
    if (!value) {
        return fallback;
    }

    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}


function extractParticipantNameFromMessage(row) {
    const metadata = parseJson(row?.metadata_json, {});
    const metadataName = metadata.participantName || metadata.userName || metadata.senderName || metadata.nickname || metadata.card;
    if (metadataName) {
        return String(metadataName).trim();
    }

    const content = String(row?.content || '');
    const match = content.match(new RegExp('\u6635\u79f0:([^|\\]]+)'));
    return match ? match[1].trim() : '';
}

function resolveDbPath(baseDir, configuredPath) {
    if (!configuredPath) {
        return path.join(baseDir, 'chats', 'memory-store.sqlite');
    }

    return path.isAbsolute(configuredPath)
        ? configuredPath
        : path.resolve(process.cwd(), configuredPath);
}

function normalizeSessionMode(mode) {
    switch (mode) {
        case 'scoped':
        case 'group_shared':
            return 'group_shared';
        case 'user':
        case 'group_user':
            return 'group_user';
        case 'global':
        case 'global_shared':
            return 'global_shared';
        case 'user_persistent':
        default:
            return 'user_persistent';
    }
}

function parseVariableValue(rawValue, declaredType = 'string') {
    if (rawValue === null || rawValue === undefined) {
        return null;
    }

    switch (declaredType) {
        case 'number': {
            const value = Number(rawValue);
            return Number.isFinite(value) ? value : null;
        }
        case 'boolean': {
            if (typeof rawValue === 'boolean') {
                return rawValue;
            }
            const normalized = String(rawValue).trim().toLowerCase();
            if (['true', '1', 'yes', 'on'].includes(normalized)) {
                return true;
            }
            if (['false', '0', 'no', 'off'].includes(normalized)) {
                return false;
            }
            return null;
        }
        case 'json': {
            if (typeof rawValue !== 'string') {
                return rawValue;
            }
            try {
                return JSON.parse(rawValue);
            } catch {
                return null;
            }
        }
        case 'string':
        default:
            return String(rawValue);
    }
}

function serializeVariableValue(value, declaredType = 'string') {
    if (value === null || value === undefined) {
        return '';
    }

    if (declaredType === 'json') {
        return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    }

    return String(value);
}

function normalizeVariableType(valueType) {
    return ['string', 'number', 'boolean', 'json'].includes(valueType) ? valueType : 'string';
}

function normalizeKnowledgeType(value) {
    return value === 'fixed' ? 'fixed' : 'dynamic';
}

function mapVariableRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    const valueType = normalizeVariableType(metadata.valueType || 'string');
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        key: row.title || '',
        title: row.title || '',
        value: parseVariableValue(row.content, valueType),
        rawValue: row.content,
        valueType,
        tags: parseJson(row.tags_json, []),
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapParticipantProfileRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        participantId: String(metadata.participantId || ''),
        participantName: metadata.participantName || row.title || '',
        title: row.title || metadata.participantName || '',
        contentPreview: truncate(row.content, 160),
        content: row.content,
        tags: parseJson(row.tags_json, []),
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

function mapKnowledgeRow(row) {
    const metadata = parseJson(row.metadata_json, {});
    return {
        id: row.id,
        namespaceId: row.namespace_id,
        entryType: row.entry_type,
        knowledgeType: metadata.knowledgeType || (row.entry_type === 'knowledge_fixed' ? 'fixed' : 'dynamic'),
        title: row.title || '',
        contentPreview: truncate(row.content, 160),
        content: row.content,
        tags: parseJson(row.tags_json, []),
        scopeType: row.scope_type,
        scopeKey: row.scope_key,
        characterName: row.character_name || '',
        presetName: row.preset_name || '',
        metadata,
        sourceSessionId: row.source_session_id,
        sourceMessageId: row.source_message_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    };
}

export class SessionManager {
    constructor(dataDir, config = {}, logger = console) {
        this.dataDir = dataDir;
        this.logger = logger;
        this.locks = new Map();
        this.chatsDir = path.join(this.dataDir, 'chats');
        this.dbPath = this.resolveDbPath(config);
        this.openDatabase(this.dbPath);
        this.setConfig(config);

        this.logger.info?.(`[记忆] SQLite 初始化完成: ${this.dbPath}`);
    }

    openDatabase(dbPath) {
        this.dbPath = dbPath;
        ensureDir(path.dirname(this.dbPath));

        this.db = new DatabaseSync(this.dbPath);
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.prepareSchema();
        this.prepareStatements();
    }

    resolveDbPath(config = {}, overridePath = null) {
        return resolveDbPath(this.dataDir, overridePath || config.memory?.storage?.path);
    }

    setConfig(config = {}, overrides = {}) {
        this.config = config;
        const chatConfig = config.chat || {};
        const memoryConfig = config.memory || {};
        const summaryConfig = memoryConfig.summary || {};
        const nextDbPath = this.resolveDbPath(config, overrides.storagePath || null);

        if (!this.db || this.dbPath !== nextDbPath) {
            if (this.db) {
                // 清理 prepared statements 避免 "database is locked"
                this.closeStatements();
                this.db.close();
            }
            this.openDatabase(nextDbPath);
            this.logger.info?.(`[记忆] 已切换数据库: ${this.dbPath}`);
        }

        this.maxHistoryLength = chatConfig.historyLimit || 30;
        this.maxGlobalMessages = chatConfig.maxGlobalMessages || 2000;
        this.sessionMode = normalizeSessionMode(chatConfig.sessionMode || 'user_persistent');
        this.summaryConfig = {
            enabled: summaryConfig.enabled === true,
            triggerMessages: summaryConfig.triggerMessages || 80,
            keepRecent: summaryConfig.keepRecent || 30,
            maxSummaries: summaryConfig.maxSummaries || 8,
            useAI: summaryConfig.useAI !== false,
            maxSourceMessages: summaryConfig.maxSourceMessages || 50
        };
        this.storageConfig = {
            type: memoryConfig.storage?.type || 'sqlite',
            path: memoryConfig.storage?.path || './data/chats/memory-store.sqlite'
        };
    }

    closeStatements() {
        // 关闭所有 prepared statements
        const statements = [
            'stmtGetSession', 'stmtCreateSession', 'stmtUpdateSession',
            'stmtInsertMessage', 'stmtGetMessages', 'stmtDeleteOldMessages',
            'stmtInsertSummary', 'stmtGetSummaries', 'stmtDeleteOldSummaries',
            'stmtGetStickyEntry', 'stmtUpsertStickyEntry', 'stmtDecrementSticky',
            'stmtDeleteSticky', 'stmtGetOrCreateNamespace', 'stmtInsertMemoryEntry',
            'stmtGetMemoryEntries', 'stmtUpdateMemoryEntry', 'stmtDeleteMemoryEntry'
        ];

        for (const name of statements) {
            if (this[name]) {
                try {
                    // SQLite prepared statements 没有显式 close，但清空引用即可
                    this[name] = null;
                } catch (e) {
                    this.logger.warn?.(`[记忆] 清理 statement ${name} 失败: ${e.message}`);
                }
            }
        }
    }

    close() {
        this.closeStatements();
        if (this.db) {
            try {
                this.db.close();
            } catch (e) {
                this.logger.warn?.(`[记忆] 关闭 SQLite 连接失败: ${e.message}`);
            }
            this.db = null;
        }
    }

    prepareSchema() {
        this.db.exec(`
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
        `);
    }

    prepareStatements() {
        this.statements = {
            insertSession: this.db.prepare(`
                INSERT INTO sessions (id, created_at, last_active, message_count, summary_count)
                VALUES (?, ?, ?, 0, 0)
                ON CONFLICT(id) DO NOTHING
            `),
            getSession: this.db.prepare('SELECT * FROM sessions WHERE id = ?'),
            updateSessionActivity: this.db.prepare(`
                UPDATE sessions
                SET last_active = ?, message_count = message_count + ?
                WHERE id = ?
            `),
            updateSessionSummaryCount: this.db.prepare(`
                UPDATE sessions
                SET summary_count = ?, last_active = ?
                WHERE id = ?
            `),
            insertMessage: this.db.prepare(`
                INSERT INTO messages (id, session_id, role, content, metadata_json, timestamp, date_iso)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `),
            getRecentMessages: this.db.prepare(`
                SELECT id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE session_id = ?
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            getSessionMessageCount: this.db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id = ?'),
            getMessagesForSummary: this.db.prepare(`
                SELECT id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE session_id = ?
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            deleteMessagesByIds: this.db.prepare(`
                DELETE FROM messages
                WHERE session_id = ? AND id = ?
            `),
            getSummaries: this.db.prepare(`
                SELECT id, content, source_count, created_at, date_iso
                FROM summaries
                WHERE session_id = ?
                ORDER BY created_at ASC, rowid ASC
            `),
            insertSummary: this.db.prepare(`
                INSERT INTO summaries (id, session_id, content, source_count, created_at, date_iso)
                VALUES (?, ?, ?, ?, ?, ?)
            `),
            deleteOldSummaries: this.db.prepare(`
                DELETE FROM summaries
                WHERE session_id = ? AND id IN (
                    SELECT id FROM summaries
                    WHERE session_id = ?
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?
                )
            `),
            getStickyEntries: this.db.prepare(`
                SELECT entry_key, remaining FROM sticky_entries WHERE session_id = ?
            `),
            upsertStickyEntry: this.db.prepare(`
                INSERT INTO sticky_entries (session_id, entry_key, remaining)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id, entry_key) DO UPDATE SET remaining = excluded.remaining
            `),
            deleteStickyEntry: this.db.prepare(`
                DELETE FROM sticky_entries WHERE session_id = ? AND entry_key = ?
            `),
            deleteStickyEntriesBySession: this.db.prepare('DELETE FROM sticky_entries WHERE session_id = ?'),
            clearSessionMessages: this.db.prepare('DELETE FROM messages WHERE session_id = ?'),
            clearSessionSummaries: this.db.prepare('DELETE FROM summaries WHERE session_id = ?'),
            deleteSession: this.db.prepare('DELETE FROM sessions WHERE id = ?'),
            listSessions: this.db.prepare(`
                SELECT id, created_at, last_active, message_count, summary_count
                FROM sessions
                ORDER BY last_active DESC
            `),
            searchMessages: this.db.prepare(`
                SELECT session_id, role, content, timestamp, date_iso
                FROM messages
                WHERE content LIKE ?
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            globalTimeline: this.db.prepare(`
                SELECT session_id, role, content, timestamp, date_iso
                FROM messages
                ORDER BY timestamp DESC, rowid DESC
                LIMIT ?
            `),
            stats: this.db.prepare(`
                SELECT
                    (SELECT COUNT(*) FROM messages) AS total_messages,
                    (SELECT COUNT(*) FROM sessions) AS total_sessions,
                    (SELECT COUNT(*) FROM summaries) AS total_summaries,
                    (SELECT date_iso FROM messages ORDER BY timestamp ASC, rowid ASC LIMIT 1) AS oldest_message,
                    (SELECT date_iso FROM messages ORDER BY timestamp DESC, rowid DESC LIMIT 1) AS newest_message
            `),
            countAllMessages: this.db.prepare('SELECT COUNT(*) AS count FROM messages'),
            getOldestGlobalMessages: this.db.prepare(`
                SELECT id, session_id
                FROM messages
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            deleteGlobalMessageById: this.db.prepare('DELETE FROM messages WHERE id = ?'),
            recalcSessionMessageCount: this.db.prepare(`
                UPDATE sessions
                SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?),
                    last_active = ?
                WHERE id = ?
            `),
            exportMessages: this.db.prepare(`
                SELECT id, session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                ORDER BY timestamp ASC, rowid ASC
            `),
            listSessionsByPrefix: this.db.prepare(`
                SELECT id, created_at, last_active, message_count, summary_count
                FROM sessions
                WHERE id LIKE ?
                ORDER BY last_active DESC
            `),
            upsertMemoryNamespace: this.db.prepare(`
                INSERT INTO memory_namespaces (id, scope_type, scope_key, character_name, preset_name, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    updated_at = excluded.updated_at,
                    character_name = excluded.character_name,
                    preset_name = excluded.preset_name
            `),
            findMemoryNamespace: this.db.prepare(`
                SELECT * FROM memory_namespaces
                WHERE scope_type = ? AND scope_key = ? AND IFNULL(character_name, '') = IFNULL(?, '') AND IFNULL(preset_name, '') = IFNULL(?, '')
                LIMIT 1
            `),
            insertMemoryEntry: this.db.prepare(`
                INSERT INTO memory_entries (id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            recentMemoryEntries: this.db.prepare(`
                SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `),
            searchMemoryEntries: this.db.prepare(`
                SELECT id, entry_type, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ? AND content LIKE ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `),
            listParticipantProfiles: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type = 'participant_profile'
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            listParticipantProfilesFiltered: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type = 'participant_profile'
                  AND (
                    ? IS NULL
                    OR IFNULL(me.title, '') LIKE ?
                    OR IFNULL(me.content, '') LIKE ?
                    OR IFNULL(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), '') LIKE ?
                    OR IFNULL(CAST(json_extract(me.metadata_json, '$.participantName') AS TEXT), '') LIKE ?
                    OR IFNULL(ns.scope_key, '') LIKE ?
                    OR IFNULL(ns.character_name, '') LIKE ?
                    OR IFNULL(ns.preset_name, '') LIKE ?
                  )
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            countParticipantProfiles: this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM memory_entries
                WHERE entry_type = 'participant_profile'
            `),
            countParticipantProfilesFiltered: this.db.prepare(`
                SELECT COUNT(*) AS count
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type = 'participant_profile'
                  AND (
                    ? IS NULL
                    OR IFNULL(me.title, '') LIKE ?
                    OR IFNULL(me.content, '') LIKE ?
                    OR IFNULL(CAST(json_extract(me.metadata_json, '$.participantId') AS TEXT), '') LIKE ?
                    OR IFNULL(CAST(json_extract(me.metadata_json, '$.participantName') AS TEXT), '') LIKE ?
                    OR IFNULL(ns.scope_key, '') LIKE ?
                    OR IFNULL(ns.character_name, '') LIKE ?
                    OR IFNULL(ns.preset_name, '') LIKE ?
                  )
            `),
            getParticipantProfileByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type = 'participant_profile'
                LIMIT 1
            `),
            listVariables: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type = 'variable'
                  AND (? IS NULL OR ns.scope_type = ?)
                  AND (? IS NULL OR ns.scope_key = ?)
                  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
                  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)
                  AND (? IS NULL OR me.title LIKE ? OR me.content LIKE ? OR IFNULL(me.tags_json, '') LIKE ? OR IFNULL(me.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            getVariableByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type = 'variable'
                LIMIT 1
            `),
            listKnowledgeEntries: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.entry_type,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')
                  AND (? IS NULL OR ns.scope_type = ?)
                  AND (? IS NULL OR ns.scope_key = ?)
                  AND (? IS NULL OR IFNULL(ns.character_name, '') = ?)
                  AND (? IS NULL OR IFNULL(ns.preset_name, '') = ?)
                  AND (? IS NULL OR me.entry_type = ?)
                  AND (? IS NULL OR me.title LIKE ? OR me.content LIKE ? OR IFNULL(me.tags_json, '') LIKE ? OR IFNULL(me.metadata_json, '') LIKE ? OR ns.scope_type LIKE ? OR ns.scope_key LIKE ? OR IFNULL(ns.character_name, '') LIKE ? OR IFNULL(ns.preset_name, '') LIKE ?)
                ORDER BY me.updated_at DESC, me.rowid DESC
                LIMIT ?
            `),
            getKnowledgeByEntryId: this.db.prepare(`
                SELECT
                    me.id,
                    me.namespace_id,
                    me.entry_type,
                    me.title,
                    me.content,
                    me.tags_json,
                    me.metadata_json,
                    me.source_session_id,
                    me.source_message_id,
                    me.created_at,
                    me.updated_at,
                    ns.scope_type,
                    ns.scope_key,
                    ns.character_name,
                    ns.preset_name
                FROM memory_entries me
                INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
                WHERE me.id = ? AND me.entry_type IN ('knowledge_fixed', 'knowledge_dynamic')
                LIMIT 1
            `),
            findVariableByName: this.db.prepare(`
                SELECT id, namespace_id, title, content, tags_json, metadata_json, source_session_id, source_message_id, created_at, updated_at
                FROM memory_entries
                WHERE namespace_id = ? AND entry_type = 'variable' AND title = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT 1
            `),
            updateMemoryEntry: this.db.prepare(`
                UPDATE memory_entries
                SET title = ?, content = ?, tags_json = ?, metadata_json = ?, source_session_id = ?, source_message_id = ?, updated_at = ?
                WHERE id = ?
            `),
            deleteMemoryEntry: this.db.prepare('DELETE FROM memory_entries WHERE id = ?'),
            listParticipantMessages: this.db.prepare(`
                SELECT session_id, role, content, metadata_json, timestamp, date_iso
                FROM messages
                WHERE CAST(json_extract(metadata_json, '$.userId') AS TEXT) = ?
                  AND timestamp > ?
                ORDER BY timestamp ASC, rowid ASC
                LIMIT ?
            `),
            exportMemoryNamespaces: this.db.prepare(`
                SELECT id, scope_type, scope_key, character_name, preset_name, created_at, updated_at
                FROM memory_namespaces
                ORDER BY updated_at ASC, rowid ASC
            `),
            exportMemoryEntries: this.db.prepare(`
                SELECT id, namespace_id, source_session_id, source_message_id, entry_type, title, content, tags_json, metadata_json, created_at, updated_at
                FROM memory_entries
                ORDER BY updated_at ASC, rowid ASC
            `),
            exportSummaryIndexEntries: this.db.prepare(`
                SELECT id, namespace_id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at
                FROM summary_index_entries
                ORDER BY updated_at ASC, rowid ASC
            `),
            insertSummaryIndexEntry: this.db.prepare(`
                INSERT INTO summary_index_entries (id, namespace_id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `),
            recentSummaryIndexEntries: this.db.prepare(`
                SELECT id, source_summary_id, source_session_id, outline, keywords_json, metadata_json, created_at, updated_at
                FROM summary_index_entries
                WHERE namespace_id = ?
                ORDER BY updated_at DESC, rowid DESC
                LIMIT ?
            `)
        };

    }

    async withSessionLock(sessionId, task) {
        const previous = this.locks.get(sessionId) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => {
            release = resolve;
        });

        this.locks.set(sessionId, previous.then(() => current));
        await previous;

        try {
            return await task();
        } finally {
            release();
            if (this.locks.get(sessionId) === current) {
                this.locks.delete(sessionId);
            }
        }
    }

    ensureSession(sessionId) {
        const now = Date.now();
        this.statements.insertSession.run(sessionId, now, now);
        return this.statements.getSession.get(sessionId);
    }

    addMessage(sessionId, role, content, metadata = {}) {
        this.ensureSession(sessionId);

        const id = metadata.id || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timestamp = Date.now();
        const dateIso = new Date(timestamp).toISOString();

        this.db.exec('BEGIN');
        try {
            this.statements.insertMessage.run(
                id,
                sessionId,
                role,
                content,
                JSON.stringify({ ...metadata, id }),
                timestamp,
                dateIso
            );
            this.statements.updateSessionActivity.run(timestamp, 1, sessionId);
            this.enforceGlobalMessageLimit(timestamp);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        this.logger.debug?.('[记忆] 已写入消息', {
            sessionId,
            messageId: id,
            role,
            content: summarizeText(content),
            metadataKeys: Object.keys(metadata || {}).slice(0, 10)
        });

        return {
            id,
            role,
            content,
            metadata,
            timestamp,
            date: dateIso
        };
    }

    enforceGlobalMessageLimit(timestamp = Date.now()) {
        const limit = Number(this.maxGlobalMessages) || 0;
        if (limit <= 0) {
            return;
        }

        const totalMessages = this.statements.countAllMessages.get()?.count || 0;
        const overflow = totalMessages - limit;
        if (overflow <= 0) {
            return;
        }

        const rows = this.statements.getOldestGlobalMessages.all(overflow);
        if (rows.length === 0) {
            return;
        }

        const affectedSessionIds = new Set();
        for (const row of rows) {
            this.statements.deleteGlobalMessageById.run(row.id);
            affectedSessionIds.add(row.session_id);
        }

        for (const affectedSessionId of affectedSessionIds) {
            this.statements.recalcSessionMessageCount.run(affectedSessionId, timestamp, affectedSessionId);
        }
    }

    getContext(sessionId, limit = null) {
        this.ensureSession(sessionId);
        return {
            sessionId,
            recentMessages: this.getHistory(sessionId, limit),
            summaries: this.getSummaries(sessionId),
            stickyKeys: this.getStickyEntryKeys(sessionId)
        };
    }

    getSession(sessionId) {
        const session = this.statements.getSession.get(sessionId);
        if (!session) {
            return null;
        }

        return {
            id: session.id,
            createdAt: session.created_at,
            lastActive: session.last_active,
            messageCount: session.message_count,
            summaryCount: session.summary_count,
            messages: this.getHistory(sessionId, this.maxHistoryLength),
            summaries: this.getSummaries(sessionId),
            stickyEntries: new Map(Object.entries(this.getStickyEntriesObject(sessionId)))
        };
    }

    getHistory(sessionId, limit = null) {
        const rows = this.statements.getRecentMessages.all(sessionId, limit ?? this.maxHistoryLength);
        return rows.reverse().map((row) => ({
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso,
            metadata: parseJson(row.metadata_json, {})
        }));
    }

    getGlobalHistory(limit = null, includeMetadata = false) {
        const rows = this.statements.globalTimeline.all(limit ?? this.maxHistoryLength).reverse();
        if (includeMetadata) {
            return rows.map((row) => ({
                sessionId: row.session_id,
                role: row.role,
                content: row.content,
                timestamp: row.timestamp,
                date: row.date_iso
            }));
        }

        return rows.map((row) => ({
            role: row.role,
            content: row.content
        }));
    }

    getSummaries(sessionId) {
        return this.statements.getSummaries.all(sessionId).map((row) => ({
            id: row.id,
            content: row.content,
            sourceCount: row.source_count,
            createdAt: row.created_at,
            date: row.date_iso
        }));
    }

    getStickyEntriesObject(sessionId) {
        const rows = this.statements.getStickyEntries.all(sessionId);
        const sticky = {};
        for (const row of rows) {
            sticky[row.entry_key] = row.remaining;
        }
        return sticky;
    }

    getStickyEntryKeys(sessionId) {
        return new Set(Object.keys(this.getStickyEntriesObject(sessionId)));
    }

    updateStickyEntries(sessionId, triggeredEntries) {
        this.ensureSession(sessionId);
        const currentSticky = this.getStickyEntriesObject(sessionId);

        this.db.exec('BEGIN');
        try {
            for (const [entryKey, remaining] of Object.entries(currentSticky)) {
                const nextRemaining = remaining - 1;
                if (nextRemaining <= 0) {
                    this.statements.deleteStickyEntry.run(sessionId, entryKey);
                } else {
                    this.statements.upsertStickyEntry.run(sessionId, entryKey, nextRemaining);
                }
            }

            for (const entry of triggeredEntries) {
                if (entry.sticky && entry.sticky > 0) {
                    this.statements.upsertStickyEntry.run(sessionId, entry.key, entry.sticky);
                }
            }

            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    async maybeSummarizeSession(sessionId, summarizer) {
        if (!this.summaryConfig.enabled) {
            return null;
        }

        this.ensureSession(sessionId);
        const totalMessages = this.statements.getSessionMessageCount.get(sessionId)?.count || 0;
        if (totalMessages <= this.summaryConfig.triggerMessages) {
            return null;
        }

        const keepRecent = Math.max(1, this.summaryConfig.keepRecent);
        const sourceLimit = Math.max(0, totalMessages - keepRecent);
        if (sourceLimit <= 0) {
            return null;
        }

        const sourceRows = this.statements.getMessagesForSummary.all(
            sessionId,
            Math.min(sourceLimit, this.summaryConfig.maxSourceMessages)
        );

        if (sourceRows.length === 0) {
            return null;
        }

        this.logger.info?.('[记忆] 开始生成摘要', {
            sessionId,
            totalMessages,
            sourceCount: sourceRows.length,
            keepRecent,
            useAI: this.summaryConfig.useAI && typeof summarizer === 'function'
        });

        const sourceMessages = sourceRows.map((row) => ({
            id: row.id,
            role: row.role,
            content: row.content,
            metadata: parseJson(row.metadata_json, {}),
            timestamp: row.timestamp,
            date: row.date_iso
        }));

        let summaryText = this.buildFallbackSummary(sessionId, sourceMessages);
        if (this.summaryConfig.useAI && typeof summarizer === 'function') {
            try {
                const generated = await summarizer(sourceMessages, sessionId, this.getSummaries(sessionId));
                if (generated && generated.trim()) {
                    summaryText = generated.trim();
                }
            } catch (error) {
                this.logger.warn?.(`[记忆] AI 摘要失败，回退到规则摘要: ${error.message}`);
            }
        }

        const summaryId = `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const summaryTime = Date.now();
        const summaryDate = new Date(summaryTime).toISOString();

        this.db.exec('BEGIN');
        try {
            this.statements.insertSummary.run(
                summaryId,
                sessionId,
                summaryText,
                sourceMessages.length,
                summaryTime,
                summaryDate
            );

            for (const message of sourceMessages) {
                this.statements.deleteMessagesByIds.run(sessionId, message.id);
            }

            const summaryCount = this.statements.getSummaries.all(sessionId).length;
            if (summaryCount > this.summaryConfig.maxSummaries) {
                this.statements.deleteOldSummaries.run(
                    sessionId,
                    sessionId,
                    summaryCount - this.summaryConfig.maxSummaries
                );
            }

            this.statements.updateSessionSummaryCount.run(
                Math.min(summaryCount, this.summaryConfig.maxSummaries),
                summaryTime,
                sessionId
            );

            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }

        this.logger.info?.('[记忆] 摘要生成完成', {
            sessionId,
            summaryId,
            sourceCount: sourceMessages.length,
            summaryCount: this.statements.getSummaries.all(sessionId).length,
            content: summarizeText(summaryText, 160)
        });
        return {
            id: summaryId,
            content: summaryText,
            sourceCount: sourceMessages.length,
            createdAt: summaryTime,
            date: summaryDate
        };
    }

    buildFallbackSummary(sessionId, messages) {
        const userHighlights = [];
        const assistantHighlights = [];

        for (const message of messages) {
            const line = truncate(message.content, 160);
            if (message.role === 'assistant') {
                assistantHighlights.push(line);
            } else {
                userHighlights.push(line);
            }
        }

        const parts = [
            `会话 ${sessionId} 的历史摘要：`,
            userHighlights.length > 0 ? `用户侧重点：${userHighlights.slice(-4).join(' | ')}` : '',
            assistantHighlights.length > 0 ? `助手侧回应：${assistantHighlights.slice(-4).join(' | ')}` : ''
        ].filter(Boolean);

        return parts.join('\n');
    }

    clearSession(sessionId) {
        this.db.exec('BEGIN');
        try {
            this.statements.clearSessionMessages.run(sessionId);
            this.statements.clearSessionSummaries.run(sessionId);
            this.statements.deleteStickyEntriesBySession.run(sessionId);
            this.statements.deleteSession.run(sessionId);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    clearHistory(sessionId) {
        this.ensureSession(sessionId);
        this.db.exec('BEGIN');
        try {
            this.statements.clearSessionMessages.run(sessionId);
            this.statements.clearSessionSummaries.run(sessionId);
            this.statements.deleteStickyEntriesBySession.run(sessionId);
            this.statements.updateSessionSummaryCount.run(0, Date.now(), sessionId);
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    deleteSession(sessionId) {
        this.clearSession(sessionId);
    }

    listSessions() {
        return this.statements.listSessions.all().map((row) => ({
            id: row.id,
            messageCount: row.message_count,
            summaryCount: row.summary_count,
            createdAt: row.created_at,
            lastActive: row.last_active
        }));
    }

    listSessionsByPrefix(prefix) {
        return this.statements.listSessionsByPrefix.all(`${prefix}%`).map((row) => ({
            id: row.id,
            messageCount: row.message_count,
            summaryCount: row.summary_count,
            createdAt: row.created_at,
            lastActive: row.last_active
        }));
    }

    ensureMemoryNamespace({ scopeType, scopeKey, characterName = null, presetName = null }) {
        const existing = this.statements.findMemoryNamespace.get(scopeType, scopeKey, characterName, presetName);
        if (existing) {
            return existing;
        }

        const now = Date.now();
        const id = `ns_${scopeType}_${Buffer.from(`${scopeKey}|${characterName || ''}|${presetName || ''}`).toString('base64url')}`;
        this.statements.upsertMemoryNamespace.run(id, scopeType, scopeKey, characterName, presetName, now, now);
        return this.statements.findMemoryNamespace.get(scopeType, scopeKey, characterName, presetName);
    }

    addMemoryEntry(namespaceOptions, entry = {}) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const now = Date.now();
        const id = entry.id || `mem_${now}_${Math.random().toString(36).slice(2, 8)}`;
        this.statements.insertMemoryEntry.run(
            id,
            namespace.id,
            entry.sourceSessionId || null,
            entry.sourceMessageId || null,
            entry.entryType || 'note',
            entry.title || null,
            entry.content || '',
            JSON.stringify(entry.tags || []),
            JSON.stringify(entry.metadata || {}),
            now,
            now
        );
        return { id, namespaceId: namespace.id };
    }

    listRecentMemoryEntries(namespaceOptions, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.recentMemoryEntries.all(namespace.id, limit).map((row) => ({
            id: row.id,
            entryType: row.entry_type,
            title: row.title,
            content: row.content,
            tags: parseJson(row.tags_json, []),
            metadata: parseJson(row.metadata_json, {}),
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    searchMemoryEntries(namespaceOptions, query, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.searchMemoryEntries.all(namespace.id, `%${query}%`, limit).map((row) => ({
            id: row.id,
            entryType: row.entry_type,
            title: row.title,
            content: row.content,
            tags: parseJson(row.tags_json, []),
            metadata: parseJson(row.metadata_json, {}),
            sourceSessionId: row.source_session_id,
            sourceMessageId: row.source_message_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    listParticipantMessages(userId, options = {}) {
        const since = options.since || 0;
        const limit = options.limit || 50;
        const rows = this.statements.listParticipantMessages.all(String(userId), since, limit);

        return rows.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            metadata: parseJson(row.metadata_json, {}),
            timestamp: row.timestamp,
            date: row.date_iso
        }));
    }

    getParticipantProfile(namespaceOptions, participantId) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const row = this.db.prepare(`
            SELECT me.id, me.namespace_id, me.entry_type, me.title, me.content, me.tags_json, me.metadata_json,
                   me.source_session_id, me.source_message_id, me.created_at, me.updated_at,
                   ns.scope_type, ns.scope_key, ns.character_name, ns.preset_name
            FROM memory_entries me
            INNER JOIN memory_namespaces ns ON ns.id = me.namespace_id
            WHERE me.namespace_id = ?
              AND me.entry_type = 'participant_profile'
              AND json_extract(me.metadata_json, '$.participantId') = ?
            ORDER BY me.updated_at DESC, me.rowid DESC
            LIMIT 1
        `).get(namespace.id, String(participantId));
        return row ? mapParticipantProfileRow(row) : null;
    }

    getLatestParticipantIdentity(participantId) {
        const row = this.db.prepare(`
            SELECT metadata_json, content, timestamp
            FROM messages
            WHERE CAST(json_extract(metadata_json, '$.userId') AS TEXT) = ?
            ORDER BY timestamp DESC, rowid DESC
            LIMIT 1
        `).get(String(participantId));
        if (!row) {
            return null;
        }

        const participantName = extractParticipantNameFromMessage(row);
        return {
            participantId: String(participantId),
            participantName,
            timestamp: row.timestamp
        };
    }

    refreshParticipantProfileName(entryId) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return null;
        }
        const identity = this.getLatestParticipantIdentity(existing.participantId);
        const latestName = identity?.participantName || '';
        if (!latestName) {
            return { item: existing, changed: false, reason: 'no_latest_name' };
        }

        const metadata = {
            ...existing.metadata,
            participantId: existing.participantId,
            participantName: latestName,
            lastParticipantNameRefreshAt: Date.now(),
            lastParticipantNameSourceAt: identity.timestamp || null
        };
        this.statements.updateMemoryEntry.run(
            latestName,
            existing.content,
            JSON.stringify(existing.tags || []),
            JSON.stringify(metadata),
            existing.sourceSessionId || null,
            existing.sourceMessageId || null,
            Date.now(),
            existing.id
        );
        return {
            item: this.getParticipantProfileByEntryId(existing.id),
            changed: latestName !== existing.participantName,
            participantName: latestName
        };
    }

    listVariables(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const scopeType = filters.scopeType || null;
        const scopeKey = filters.scopeKey || null;
        const characterName = filters.characterName || null;
        const presetName = filters.presetName || null;
        const search = filters.search ? `%${String(filters.search).trim()}%` : null;

        return this.statements.listVariables.all(
            scopeType,
            scopeType,
            scopeKey,
            scopeKey,
            characterName,
            characterName,
            presetName,
            presetName,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            limit
        ).map(mapVariableRow);
    }

    getVariable(namespaceOptions, key) {
        if (!key) {
            return null;
        }

        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const row = this.statements.findVariableByName.get(namespace.id, String(key));
        if (!row) {
            return null;
        }

        return mapVariableRow({
            ...row,
            scope_type: namespace.scope_type,
            scope_key: namespace.scope_key,
            character_name: namespace.character_name,
            preset_name: namespace.preset_name
        });
    }

    getVariableByEntryId(entryId) {
        const row = this.statements.getVariableByEntryId.get(entryId);
        return row ? mapVariableRow(row) : null;
    }

    listKnowledgeEntries(filters = {}) {
        const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
        const scopeType = filters.scopeType || null;
        const scopeKey = filters.scopeKey || null;
        const characterName = filters.characterName || null;
        const presetName = filters.presetName || null;
        const knowledgeType = filters.knowledgeType === 'fixed'
            ? 'knowledge_fixed'
            : (filters.knowledgeType === 'dynamic' ? 'knowledge_dynamic' : null);
        const search = filters.search ? `%${String(filters.search).trim()}%` : null;

        return this.statements.listKnowledgeEntries.all(
            scopeType,
            scopeType,
            scopeKey,
            scopeKey,
            characterName,
            characterName,
            presetName,
            presetName,
            knowledgeType,
            knowledgeType,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            search,
            limit
        ).map(mapKnowledgeRow);
    }

    getKnowledgeByEntryId(entryId) {
        const row = this.statements.getKnowledgeByEntryId.get(entryId);
        return row ? mapKnowledgeRow(row) : null;
    }

    upsertKnowledgeEntry(namespaceOptions, knowledge = {}) {
        const title = String(knowledge.title || '').trim();
        if (!title) {
            throw new Error('知识标题不能为空');
        }

        const content = String(knowledge.content || '').trim();
        if (!content) {
            throw new Error('知识内容不能为空');
        }

        const normalizedKnowledgeType = normalizeKnowledgeType(knowledge.knowledgeType || knowledge.metadata?.knowledgeType);
        return this.addMemoryEntry(namespaceOptions, {
            entryType: normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic',
            title,
            content,
            tags: Array.isArray(knowledge.tags) ? knowledge.tags : [],
            metadata: {
                ...(knowledge.metadata || {}),
                knowledgeType: normalizedKnowledgeType,
                source: knowledge.metadata?.source || knowledge.source || 'admin',
                updatedBy: knowledge.metadata?.updatedBy || 'admin-panel'
            },
            sourceSessionId: knowledge.sourceSessionId || null,
            sourceMessageId: knowledge.sourceMessageId || null
        });
    }

    saveKnowledgeEntry(entryId, knowledge = {}) {
        const existing = this.getKnowledgeByEntryId(entryId);
        if (!existing) {
            return null;
        }

        const title = String(knowledge.title ?? existing.title ?? '').trim();
        const content = String(knowledge.content ?? existing.content ?? '').trim();
        if (!title) {
            throw new Error('知识标题不能为空');
        }
        if (!content) {
            throw new Error('知识内容不能为空');
        }

        const normalizedKnowledgeType = normalizeKnowledgeType(knowledge.knowledgeType || knowledge.metadata?.knowledgeType || existing.knowledgeType);
        const metadata = {
            ...existing.metadata,
            ...(knowledge.metadata || {}),
            knowledgeType: normalizedKnowledgeType,
            source: String((knowledge.metadata || {}).source || existing.metadata?.source || 'admin').trim() || 'admin',
            updatedBy: String((knowledge.metadata || {}).updatedBy || existing.metadata?.updatedBy || 'admin-panel').trim() || 'admin-panel'
        };
        const tags = Array.isArray(knowledge.tags) ? knowledge.tags : existing.tags;
        const now = Date.now();

        this.statements.updateMemoryEntry.run(
            title,
            content,
            JSON.stringify(tags || []),
            JSON.stringify(metadata),
            knowledge.sourceSessionId || existing.sourceSessionId || null,
            knowledge.sourceMessageId || existing.sourceMessageId || null,
            now,
            existing.id
        );

        if (existing.entryType !== (normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic')) {
            this.db.prepare(`
                UPDATE memory_entries
                SET entry_type = ?
                WHERE id = ?
            `).run(normalizedKnowledgeType === 'fixed' ? 'knowledge_fixed' : 'knowledge_dynamic', existing.id);
        }

        const saved = this.getKnowledgeByEntryId(existing.id);
        this.logger.info?.('[记忆] 知识条目已保存', {
            entryId: existing.id,
            knowledgeType: saved?.knowledgeType || normalizedKnowledgeType,
            title: saved?.title || title,
            content: summarizeText(content, 160),
            tagCount: Array.isArray(tags) ? tags.length : 0
        });
        return saved;
    }

    deleteKnowledgeEntry(entryId) {
        const existing = this.getKnowledgeByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    upsertVariable(namespaceOptions, variable = {}) {
        const key = String(variable.key || variable.title || '').trim();
        if (!key) {
            throw new Error('变量名不能为空');
        }

        const valueType = normalizeVariableType(variable.valueType || variable.metadata?.valueType || 'string');
        const parsedValue = Object.prototype.hasOwnProperty.call(variable, 'value')
            ? variable.value
            : parseVariableValue(variable.rawValue ?? variable.content ?? '', valueType);
        const rawValue = serializeVariableValue(parsedValue, valueType);
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const existing = this.statements.findVariableByName.get(namespace.id, key);
        const now = Date.now();
        const metadata = {
            ...(existing ? parseJson(existing.metadata_json, {}) : {}),
            ...(variable.metadata || {}),
            valueType,
            source: variable.metadata?.source || variable.source || (existing ? parseJson(existing.metadata_json, {}).source : 'admin')
        };

        if (existing) {
            const mergedTags = [...new Set([...(variable.tags || []), ...parseJson(existing.tags_json, [])])];
            this.statements.updateMemoryEntry.run(
                key,
                rawValue,
                JSON.stringify(mergedTags),
                JSON.stringify(metadata),
                variable.sourceSessionId || existing.source_session_id || null,
                variable.sourceMessageId || existing.source_message_id || null,
                now,
                existing.id
            );
            return { id: existing.id, namespaceId: namespace.id, updated: true };
        }

        return this.addMemoryEntry(namespaceOptions, {
            entryType: 'variable',
            title: key,
            content: rawValue,
            tags: variable.tags || [],
            metadata,
            sourceSessionId: variable.sourceSessionId || null,
            sourceMessageId: variable.sourceMessageId || null
        });
    }

    deleteVariable(entryId) {
        const existing = this.getVariableByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    deleteVariableByName(namespaceOptions, key) {
        const existing = this.getVariable(namespaceOptions, key);
        if (!existing) return false;
        this.statements.deleteMemoryEntry.run(existing.id);
        return true;
    }

    normalizeParticipantProfileListOptions(limitOrOptions = 50) {
        const options = typeof limitOrOptions === 'object' && limitOrOptions !== null
            ? limitOrOptions
            : { limit: limitOrOptions };
        const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 500);
        const search = String(options.search || '').trim();
        const searchPattern = search ? `%${search}%` : null;
        return { limit, search, searchPattern };
    }

    listParticipantProfiles(limitOrOptions = 50) {
        const { limit, searchPattern } = this.normalizeParticipantProfileListOptions(limitOrOptions);
        if (!searchPattern) {
            return this.statements.listParticipantProfiles.all(limit).map(mapParticipantProfileRow);
        }

        return this.statements.listParticipantProfilesFiltered.all(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            limit
        ).map(mapParticipantProfileRow);
    }

    countParticipantProfiles(filters = {}) {
        const { searchPattern } = this.normalizeParticipantProfileListOptions(filters);
        if (!searchPattern) {
            const row = this.statements.countParticipantProfiles.get();
            return Number(row?.count) || 0;
        }

        const row = this.statements.countParticipantProfilesFiltered.get(
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern,
            searchPattern
        );
        return Number(row?.count) || 0;
    }

    getParticipantProfileByEntryId(entryId) {
        const row = this.statements.getParticipantProfileByEntryId.get(entryId);
        return row ? mapParticipantProfileRow(row) : null;
    }

    upsertParticipantProfile(namespaceOptions, participantProfile) {
        const existing = this.getParticipantProfile(namespaceOptions, participantProfile.participantId);
        const now = Date.now();

        if (existing) {
            this.db.prepare(`
                UPDATE memory_entries
                SET title = ?, content = ?, tags_json = ?, metadata_json = ?, updated_at = ?
                WHERE id = ?
            `).run(
                participantProfile.title,
                participantProfile.content,
                JSON.stringify(participantProfile.tags || []),
                JSON.stringify(participantProfile.metadata || {}),
                now,
                existing.id
            );
            return { id: existing.id, namespaceId: existing.namespaceId, updated: true };
        }

        return this.addMemoryEntry(namespaceOptions, {
            entryType: 'participant_profile',
            title: participantProfile.title,
            content: participantProfile.content,
            tags: participantProfile.tags || [],
            metadata: participantProfile.metadata || {}
        });
    }

    saveParticipantProfile(entryId, participantProfile = {}) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return null;
        }

        const title = String(participantProfile.title ?? existing.title ?? '').trim();
        const content = String(participantProfile.content ?? existing.content ?? '').trim();
        if (!title) {
            throw new Error('人物档案标题不能为空');
        }
        if (!content) {
            throw new Error('人物档案内容不能为空');
        }

        const metadata = {
            ...existing.metadata,
            ...(participantProfile.metadata || {}),
            participantId: String((participantProfile.metadata || {}).participantId || existing.metadata?.participantId || existing.participantId || ''),
            participantName: String((participantProfile.metadata || {}).participantName || existing.metadata?.participantName || title).trim() || title,
            editedBy: String((participantProfile.metadata || {}).editedBy || existing.metadata?.editedBy || 'admin-panel').trim() || 'admin-panel',
            updatedBy: String((participantProfile.metadata || {}).updatedBy || existing.metadata?.updatedBy || 'admin-panel').trim() || 'admin-panel',
            source: String((participantProfile.metadata || {}).source || existing.metadata?.source || 'participant_profile').trim() || 'participant_profile'
        };
        const tags = Array.isArray(participantProfile.tags) ? participantProfile.tags : existing.tags;
        const now = Date.now();

        this.statements.updateMemoryEntry.run(
            title,
            content,
            JSON.stringify(tags || []),
            JSON.stringify(metadata),
            existing.sourceSessionId || null,
            existing.sourceMessageId || null,
            now,
            existing.id
        );

        const saved = this.getParticipantProfileByEntryId(existing.id);
        this.logger.info?.('[记忆] 人物档案已保存', {
            entryId: existing.id,
            participantId: saved?.participantId || metadata.participantId || '',
            participantName: saved?.participantName || metadata.participantName || title,
            content: summarizeText(content, 160),
            tagCount: Array.isArray(tags) ? tags.length : 0
        });
        return saved;
    }

    deleteParticipantProfile(entryId) {
        const existing = this.getParticipantProfileByEntryId(entryId);
        if (!existing) {
            return false;
        }
        this.statements.deleteMemoryEntry.run(entryId);
        return true;
    }

    collectParticipantProfileSource(userId, namespaceOptions, options = {}) {
        const existing = this.getParticipantProfile(namespaceOptions, userId);
        const since = existing?.metadata?.lastProcessedMessageAt || 0;
        const messages = this.listParticipantMessages(userId, {
            since,
            limit: options.limit || 50
        });

        // bot_only 过滤：只保留 bot 参与了会话的消息
        const sourceFilter = options.sourceFilter || 'all';
        if (sourceFilter === 'bot_only' && messages.length > 0) {
            const botSessionIds = new Set();
            for (const msg of messages) {
                if (msg.role === 'assistant') {
                    botSessionIds.add(msg.sessionId);
                }
            }
            const filtered = messages.filter(msg => botSessionIds.has(msg.sessionId));
            return {
                existing,
                since,
                messages: filtered,
                hasEnoughNewInfo: filtered.length >= (options.threshold || 8),
                filteredCount: messages.length - filtered.length
            };
        }

        return {
            existing,
            since,
            messages,
            hasEnoughNewInfo: messages.length >= (options.threshold || 8)
        };
    }

    addSummaryIndexEntry(namespaceOptions, entry = {}) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        const now = Date.now();
        const id = entry.id || `sidx_${now}_${Math.random().toString(36).slice(2, 8)}`;
        this.statements.insertSummaryIndexEntry.run(
            id,
            namespace.id,
            entry.sourceSummaryId || null,
            entry.sourceSessionId || null,
            entry.outline || '',
            JSON.stringify(entry.keywords || []),
            JSON.stringify(entry.metadata || {}),
            now,
            now
        );
        return { id, namespaceId: namespace.id };
    }

    listRecentSummaryIndexEntries(namespaceOptions, limit = 10) {
        const namespace = this.ensureMemoryNamespace(namespaceOptions);
        return this.statements.recentSummaryIndexEntries.all(namespace.id, limit).map((row) => ({
            id: row.id,
            sourceSummaryId: row.source_summary_id,
            sourceSessionId: row.source_session_id,
            outline: row.outline,
            keywords: parseJson(row.keywords_json, []),
            metadata: parseJson(row.metadata_json, {}),
            createdAt: row.created_at,
            updatedAt: row.updated_at
        }));
    }

    buildKeywordsFromText(text = '', limit = 12) {
        const source = String(text || '').toLowerCase();
        const words = source
            .replace(/[^a-z0-9一-龥]+/g, ' ')
            .split(/\s+/)
            .map((word) => word.trim())
            .filter((word) => word.length >= 2);
        return Array.from(new Set(words)).slice(0, limit);
    }

    upsertConversationMemory(namespaceOptions, { userMessage, assistantMessage = '', sourceSessionId = null, sourceMessageId = null }) {
        const entryTitle = userMessage.slice(0, 30);
        this.addMemoryEntry(namespaceOptions, {
            entryType: 'conversation',
            title: entryTitle,
            content: assistantMessage ? `用户: ${userMessage}\n助手: ${assistantMessage}` : `用户: ${userMessage}`,
            tags: this.buildKeywordsFromText(`${userMessage} ${assistantMessage}`),
            metadata: { source: 'conversation' },
            sourceSessionId,
            sourceMessageId
        });
    }

    upsertSummaryIndexFromSummary(namespaceOptions, summary, sourceSessionId) {
        if (!summary?.content) {
            return null;
        }

        return this.addSummaryIndexEntry(namespaceOptions, {
            sourceSummaryId: summary.id,
            sourceSessionId,
            outline: summary.content,
            keywords: this.buildKeywordsFromText(summary.content),
            metadata: { source: 'summary' }
        });
    }

    recallMemory(namespaceOptions, query, options = {}) {
        const recentLimit = options.recentLimit || 4;
        const searchLimit = options.searchLimit || 4;
        const recentEntries = this.listRecentMemoryEntries(namespaceOptions, recentLimit);
        const matchedEntries = query ? this.searchMemoryEntries(namespaceOptions, query, searchLimit) : [];
        const summaryEntries = this.listRecentSummaryIndexEntries(namespaceOptions, options.summaryLimit || 3);
        const fixedKnowledgeEntries = this.listKnowledgeEntries({
            scopeType: namespaceOptions?.scopeType,
            scopeKey: namespaceOptions?.scopeKey,
            characterName: namespaceOptions?.characterName,
            presetName: namespaceOptions?.presetName,
            knowledgeType: 'fixed',
            limit: options.fixedLimit || 6
        });
        const queryKeywords = this.buildKeywordsFromText(query, 8);
        const participantProfileConfig = getParticipantProfileConfig(this.config);
        const blacklist = new Set(participantProfileConfig.blacklistParticipantIds);
        const currentParticipantId = options.currentParticipantId ? String(options.currentParticipantId) : '';

        const shouldIncludeEntry = (entry) => {
            if (entry.entryType === 'knowledge_fixed' || entry.entryType === 'knowledge_dynamic') {
                return true;
            }
            if (entry.entryType !== 'participant_profile') {
                return true;
            }
            if (!participantProfileConfig.injectEnabled) {
                return false;
            }

            const profileParticipantId = String(entry.metadata?.participantId || '');
            if (profileParticipantId && blacklist.has(profileParticipantId)) {
                return false;
            }
            if (currentParticipantId && profileParticipantId && currentParticipantId !== profileParticipantId) {
                return false;
            }
            return true;
        };

        const dedupe = new Map();
        for (const entry of [...fixedKnowledgeEntries, ...matchedEntries, ...recentEntries]) {
            if (!shouldIncludeEntry(entry) || dedupe.has(entry.id)) {
                continue;
            }

            const contentText = String(entry.content || '').toLowerCase();
            const keywordHits = queryKeywords.filter((keyword) => contentText.includes(keyword)).length;
            const isMatched = matchedEntries.some((item) => item.id === entry.id);
            const isFixedKnowledge = entry.entryType === 'knowledge_fixed';
            const isDynamicKnowledge = entry.entryType === 'knowledge_dynamic';
            const recencyBoost = isMatched ? 50 : 20;
            const profileBoost = entry.entryType === 'participant_profile' ? 80 : 0;
            const knowledgeBoost = isFixedKnowledge ? 120 : (isDynamicKnowledge ? 70 : 0);
            dedupe.set(entry.id, {
                ...entry,
                sourceKind: isFixedKnowledge
                    ? 'knowledge_fixed'
                    : (isDynamicKnowledge
                        ? 'knowledge_dynamic'
                        : (entry.entryType === 'participant_profile' ? 'participant_profile' : 'memory_entry')),
                recallReason: isFixedKnowledge
                    ? 'fixed_knowledge'
                    : (isDynamicKnowledge
                        ? (isMatched ? 'dynamic_knowledge_match' : 'dynamic_knowledge_recent')
                        : (entry.entryType === 'participant_profile'
                            ? 'participant_profile'
                            : (isMatched ? 'keyword_match' : 'recent_memory'))),
                recallScore: knowledgeBoost + profileBoost + recencyBoost + keywordHits * 8
            });
        }

        for (const summary of summaryEntries) {
            if (!dedupe.has(summary.id)) {
                const keywordHits = queryKeywords.filter((keyword) => summary.outline.toLowerCase().includes(keyword)).length;
                dedupe.set(summary.id, {
                    id: summary.id,
                    title: '摘要索引',
                    content: summary.outline,
                    keywords: summary.keywords,
                    metadata: summary.metadata,
                    sourceKind: 'summary_index',
                    recallReason: 'summary_index',
                    recallScore: 30 + keywordHits * 6
                });
            }
        }

        const results = Array.from(dedupe.values())
            .sort((a, b) => (b.recallScore || 0) - (a.recallScore || 0))
            .slice(0, options.limit || 6);

        this.logger.info?.('[记忆] 记忆召回完成', {
            namespace: summarizeNamespaceOptions(namespaceOptions),
            query: summarizeText(query),
            recentCount: recentEntries.length,
            matchedCount: matchedEntries.length,
            fixedKnowledgeCount: fixedKnowledgeEntries.length,
            summaryCount: summaryEntries.length,
            resultCount: results.length,
            currentParticipantId,
            results: results.slice(0, 6).map((entry) => ({
                id: entry.id,
                sourceKind: entry.sourceKind || entry.entryType || '',
                recallReason: entry.recallReason || '',
                recallScore: entry.recallScore || 0,
                title: entry.title || ''
            }))
        });

        return results;
    }

    cleanupSessions(maxIdleTime = 24 * 60 * 60 * 1000) {
        const now = Date.now();
        for (const session of this.listSessions()) {
            if (now - session.lastActive > maxIdleTime) {
                this.deleteSession(session.id);
            }
        }
    }

    getStats() {
        const row = this.statements.stats.get();
        return {
            totalMessages: row?.total_messages || 0,
            totalSessions: row?.total_sessions || 0,
            totalSummaries: row?.total_summaries || 0,
            sessionMode: this.sessionMode,
            storage: {
                type: 'sqlite',
                path: this.dbPath
            },
            oldestMessage: row?.oldest_message || null,
            newestMessage: row?.newest_message || null,
            memoryFileSizeMB: this.getMemoryFileSize()
        };
    }

    getDashboardCompositionStats() {
        const row = this.db.prepare(`
            SELECT
                SUM(CASE WHEN entry_type = 'participant_profile' THEN 1 ELSE 0 END) AS participant_profiles,
                SUM(CASE WHEN entry_type = 'knowledge_fixed' THEN 1 ELSE 0 END) AS fixed_knowledge,
                SUM(CASE WHEN entry_type = 'knowledge_dynamic' THEN 1 ELSE 0 END) AS dynamic_knowledge
            FROM memory_entries
        `).get();
        const stats = this.getStats();
        return {
            messages: Number(stats.totalMessages) || 0,
            summaries: Number(stats.totalSummaries) || 0,
            participantProfiles: Number(row?.participant_profiles) || 0,
            fixedKnowledge: Number(row?.fixed_knowledge) || 0,
            dynamicKnowledge: Number(row?.dynamic_knowledge) || 0
        };
    }

    getMemoryFileSize() {
        try {
            if (fs.existsSync(this.dbPath)) {
                const stats = fs.statSync(this.dbPath);
                return (stats.size / 1024 / 1024).toFixed(2);
            }
        } catch (error) {
            this.logger.error?.(`[记忆] 获取数据库文件大小失败: ${error.message}`);
        }
        return 0;
    }

    clearGlobalMemory() {
        this.db.exec('BEGIN');
        try {
            this.db.exec('DELETE FROM summary_index_entries;');
            this.db.exec('DELETE FROM memory_entries;');
            this.db.exec('DELETE FROM memory_namespaces;');
            this.db.exec('DELETE FROM sticky_entries;');
            this.db.exec('DELETE FROM summaries;');
            this.db.exec('DELETE FROM messages;');
            this.db.exec('DELETE FROM sessions;');
            this.db.exec('COMMIT');
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }

    searchMessages(keyword, limit = 50) {
        if (!keyword) {
            return [];
        }

        const rows = this.statements.searchMessages.all(`%${keyword}%`, limit);
        return rows.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso
        }));
    }

    exportKnowledgeSnapshot() {
        return {
            namespaces: this.statements.exportMemoryNamespaces.all().map((row) => ({
                id: row.id,
                scopeType: row.scope_type,
                scopeKey: row.scope_key,
                characterName: row.character_name || null,
                presetName: row.preset_name || null,
                createdAt: row.created_at,
                updatedAt: row.updated_at
            })),
            entries: this.statements.exportMemoryEntries.all().map((row) => ({
                id: row.id,
                namespaceId: row.namespace_id,
                sourceSessionId: row.source_session_id,
                sourceMessageId: row.source_message_id,
                entryType: row.entry_type,
                title: row.title,
                content: row.content,
                tags: parseJson(row.tags_json, []),
                metadata: parseJson(row.metadata_json, {}),
                createdAt: row.created_at,
                updatedAt: row.updated_at
            })),
            summaryIndexEntries: this.statements.exportSummaryIndexEntries.all().map((row) => ({
                id: row.id,
                namespaceId: row.namespace_id,
                sourceSummaryId: row.source_summary_id,
                sourceSessionId: row.source_session_id,
                outline: row.outline,
                keywords: parseJson(row.keywords_json, []),
                metadata: parseJson(row.metadata_json, {}),
                createdAt: row.created_at,
                updatedAt: row.updated_at
            }))
        };
    }

    importKnowledgeSnapshot(snapshot = {}) {
        const namespaces = Array.isArray(snapshot.namespaces) ? snapshot.namespaces : [];
        const entries = Array.isArray(snapshot.entries) ? snapshot.entries : [];
        const summaryIndexEntries = Array.isArray(snapshot.summaryIndexEntries) ? snapshot.summaryIndexEntries : [];
        const now = Date.now();

        for (const namespace of namespaces) {
            this.statements.upsertMemoryNamespace.run(
                namespace.id || `ns_${namespace.scopeType}_${Buffer.from(`${namespace.scopeKey}|${namespace.characterName || ''}|${namespace.presetName || ''}`).toString('base64url')}`,
                namespace.scopeType || 'user_persistent',
                namespace.scopeKey || 'default',
                namespace.characterName || null,
                namespace.presetName || null,
                namespace.createdAt || now,
                namespace.updatedAt || now
            );
        }

        for (const entry of entries) {
            this.statements.insertMemoryEntry.run(
                entry.id || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                entry.namespaceId,
                entry.sourceSessionId || null,
                entry.sourceMessageId || null,
                entry.entryType || 'note',
                entry.title || null,
                entry.content || '',
                JSON.stringify(entry.tags || []),
                JSON.stringify(entry.metadata || {}),
                entry.createdAt || now,
                entry.updatedAt || now
            );
        }

        for (const entry of summaryIndexEntries) {
            this.statements.insertSummaryIndexEntry.run(
                entry.id || `sumidx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                entry.namespaceId,
                entry.sourceSummaryId || null,
                entry.sourceSessionId || null,
                entry.outline || '',
                JSON.stringify(entry.keywords || []),
                JSON.stringify(entry.metadata || {}),
                entry.createdAt || now,
                entry.updatedAt || now
            );
        }

        return {
            importedNamespaces: namespaces.length,
            importedMemoryEntries: entries.length,
            importedSummaryIndexEntries: summaryIndexEntries.length
        };
    }

    exportMemory() {
        const sessions = {};
        for (const session of this.listSessions()) {
            sessions[session.id] = {
                ...session,
                messages: this.getHistory(session.id, 100000),
                summaries: this.getSummaries(session.id),
                stickyEntries: this.getStickyEntriesObject(session.id)
            };
        }

        return {
            sessions,
            knowledge: this.exportKnowledgeSnapshot(),
            globalTimeline: this.getGlobalHistory(100000, true),
            stats: this.getStats(),
            exportDate: new Date().toISOString(),
            storage: {
                type: 'sqlite',
                path: this.dbPath
            }
        };
    }

    exportMemoryByFilter(filter = {}) {
        let sessionsToExport = this.listSessions();

        if (filter.sessionIds?.length) {
            const allowed = new Set(filter.sessionIds);
            sessionsToExport = sessionsToExport.filter((session) => allowed.has(session.id));
        }

        if (filter.sessionPrefix) {
            sessionsToExport = sessionsToExport.filter((session) => session.id.startsWith(filter.sessionPrefix));
        }

        if (filter.userId) {
            const userToken = `:${filter.userId}`;
            sessionsToExport = sessionsToExport.filter((session) => session.id === `user:${filter.userId}` || session.id.endsWith(userToken));
        }

        const sessions = {};
        for (const session of sessionsToExport) {
            sessions[session.id] = {
                ...session,
                messages: this.getHistory(session.id, 100000),
                summaries: this.getSummaries(session.id),
                stickyEntries: this.getStickyEntriesObject(session.id)
            };
        }

        const knowledge = this.exportKnowledgeSnapshot();

        return {
            sessions,
            knowledge,
            stats: {
                exportedSessions: Object.keys(sessions).length,
                exportedKnowledgeEntries: Array.isArray(knowledge.entries) ? knowledge.entries.length : 0,
                storagePath: this.dbPath
            },
            exportDate: new Date().toISOString(),
            storage: {
                type: 'sqlite',
                path: this.dbPath
            }
        };
    }

    importMemorySnapshot(snapshot, options = {}) {
        if (!snapshot?.sessions && !snapshot?.knowledge) {
            return {
                importedSessions: 0,
                importedMessages: 0,
                importedSummaries: 0,
                importedNamespaces: 0,
                importedMemoryEntries: 0,
                importedSummaryIndexEntries: 0
            };
        }

        const replace = options.replace !== false;
        if (replace) {
            this.clearGlobalMemory();
        }

        let importedSessions = 0;
        let importedMessages = 0;
        let importedSummaries = 0;

        for (const [sessionId, session] of Object.entries(snapshot.sessions || {})) {
            this.ensureSession(sessionId);
            importedSessions += 1;

            for (const message of session.messages || []) {
                this.addMessage(sessionId, message.role, message.content, message.metadata || {});
                importedMessages += 1;
            }

            for (const summary of session.summaries || []) {
                const summaryId = summary.id || `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                this.statements.insertSummary.run(
                    summaryId,
                    sessionId,
                    summary.content,
                    summary.sourceCount || 0,
                    summary.createdAt || Date.now(),
                    summary.date || new Date().toISOString()
                );
                importedSummaries += 1;
            }
        }

        const importedKnowledge = this.importKnowledgeSnapshot(snapshot.knowledge || {});

        return {
            importedSessions,
            importedMessages,
            importedSummaries,
            ...importedKnowledge
        };
    }

    getDbPath() {
        return this.dbPath;
    }

    // 强制 WAL checkpoint，确保所有数据写入主库文件（备份前必须调用）
    checkpoint() {
        try {
            if (this.db && this.db.open) {
                if (typeof this.db.pragma === 'function') {
                    this.db.pragma('wal_checkpoint(TRUNCATE)');
                } else {
                    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
                }
            }
        } catch {}
    }

    clearAllData() {
        const cleared = { sessions: 0, messages: 0, summaries: 0, variables: 0, namespaces: 0, profiles: 0, knowledge: 0 };
        const dbs = [this.db];
        if (this.charDb && this.charDb !== this.db) dbs.push(this.charDb);

        for (const db of dbs) {
            if (!db || !db.open) continue;
            try {
                cleared.variables += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('variable').changes;
                cleared.profiles += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('participant_profile').changes;
                cleared.knowledge += db.prepare('DELETE FROM memory_entries WHERE entry_type = ?').run('knowledge').changes;
                cleared.knowledge += db.prepare('DELETE FROM memory_entries WHERE entry_type NOT IN (?,?,?)').run('variable','participant_profile','knowledge').changes;
                cleared.messages += db.prepare('DELETE FROM messages').run().changes;
                cleared.summaries += db.prepare('DELETE FROM summaries').run().changes;
                cleared.sessions += db.prepare('DELETE FROM sessions').run().changes;
                cleared.namespaces += db.prepare('DELETE FROM memory_namespaces').run().changes;
                db.prepare('DELETE FROM sticky_entries').run();
                db.prepare('DELETE FROM summary_index_entries').run();
            } catch (e) { /* some tables may not exist in all dbs */ }
        }
        this.checkpoint();
        return cleared;
    }
}

export function getGlobalMemory(dataDir) {
    const dbPath = resolveDbPath(dataDir, null);
    if (!fs.existsSync(dbPath)) {
        return {
            sessions: {},
            globalTimeline: [],
            storage: {
                type: 'sqlite',
                path: dbPath
            }
        };
    }

    const db = new DatabaseSync(dbPath);
    const sessions = db.prepare('SELECT id FROM sessions ORDER BY last_active DESC').all();
    const globalTimeline = db.prepare(`
        SELECT session_id, role, content, timestamp, date_iso
        FROM messages
        ORDER BY timestamp ASC, rowid ASC
    `).all();

    const snapshot = {
        sessions: Object.fromEntries(sessions.map((row) => [row.id, { id: row.id }])),
        globalTimeline: globalTimeline.map((row) => ({
            sessionId: row.session_id,
            role: row.role,
            content: row.content,
            timestamp: row.timestamp,
            date: row.date_iso
        })),
        storage: {
            type: 'sqlite',
            path: dbPath
        }
    };

    db.close();
    return snapshot;
}

export function inspectMemoryDatabase(dbPath) {
    const normalizedPath = path.isAbsolute(dbPath) ? dbPath : path.resolve(process.cwd(), dbPath);
    if (!fs.existsSync(normalizedPath)) {
        return {
            path: normalizedPath,
            exists: false,
            totalSessions: 0,
            totalMessages: 0,
            totalSummaries: 0,
            newestMessage: null,
            oldestMessage: null
        };
    }

    const db = new DatabaseSync(normalizedPath);
    const row = db.prepare(`
        SELECT
            (SELECT COUNT(*) FROM sessions) AS total_sessions,
            (SELECT COUNT(*) FROM messages) AS total_messages,
            (SELECT COUNT(*) FROM summaries) AS total_summaries,
            (SELECT date_iso FROM messages ORDER BY timestamp DESC, rowid DESC LIMIT 1) AS newest_message,
            (SELECT date_iso FROM messages ORDER BY timestamp ASC, rowid ASC LIMIT 1) AS oldest_message
    `).get();
    db.close();

    return {
        path: normalizedPath,
        exists: true,
        totalSessions: row?.total_sessions || 0,
        totalMessages: row?.total_messages || 0,
        totalSummaries: row?.total_summaries || 0,
        newestMessage: row?.newest_message || null,
        oldestMessage: row?.oldest_message || null
    };
}
