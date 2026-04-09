/**
 * 会话与记忆存储模块
 * 使用 SQLite 持久化会话、消息、摘要和粘性条目状态。
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

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

        this.transactions = {
            addMessage: this.db.createTagStore().get`
                SELECT 1
            `
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

        this.logger.info?.(`[记忆] 会话 ${sessionId} 已生成摘要，压缩 ${sourceMessages.length} 条消息`);
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
        const queryKeywords = this.buildKeywordsFromText(query, 8);

        const dedupe = new Map();
        for (const entry of [...matchedEntries, ...recentEntries]) {
            if (!dedupe.has(entry.id)) {
                const keywordHits = queryKeywords.filter((keyword) => entry.content.toLowerCase().includes(keyword)).length;
                const recencyBoost = matchedEntries.some((item) => item.id === entry.id) ? 50 : 20;
                dedupe.set(entry.id, {
                    ...entry,
                    sourceKind: 'memory_entry',
                    recallReason: matchedEntries.some((item) => item.id === entry.id) ? 'keyword_match' : 'recent_memory',
                    recallScore: recencyBoost + keywordHits * 8
                });
            }
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

        return Array.from(dedupe.values())
            .sort((a, b) => (b.recallScore || 0) - (a.recallScore || 0))
            .slice(0, options.limit || 6);
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

        return {
            sessions,
            stats: {
                exportedSessions: Object.keys(sessions).length,
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
        if (!snapshot?.sessions) {
            return { importedSessions: 0, importedMessages: 0, importedSummaries: 0 };
        }

        const replace = options.replace !== false;
        if (replace) {
            this.clearGlobalMemory();
        }

        let importedSessions = 0;
        let importedMessages = 0;
        let importedSummaries = 0;

        for (const [sessionId, session] of Object.entries(snapshot.sessions)) {
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

        return { importedSessions, importedMessages, importedSummaries };
    }

    getDbPath() {
        return this.dbPath;
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
