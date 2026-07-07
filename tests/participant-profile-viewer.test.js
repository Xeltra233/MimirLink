import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

import { SessionManager } from '../src/session.js';
import { setupRoutes } from '../src/routes.js';

let testPortOffset = 0;

function createTempManager() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-profile-viewer-'));
    const manager = new SessionManager(tempDir, {
        chat: { historyLimit: 30, maxGlobalMessages: 2000, sessionMode: 'user_persistent' },
        memory: {
            storage: { path: path.join(tempDir, 'memory.sqlite') },
            summary: { enabled: false }
        }
    }, { info() {}, warn() {}, error() {} });

    return { manager, tempDir };
}

async function startTestServer(sessionManager, options = {}) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { authenticated: true, username: 'admin' };
        next();
    });

    const config = options.config || {
        auth: { enabled: false },
        chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist', allowedGroups: ['123456'] },
        memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
        ai: {},
        regex: { rules: [] },
        preset: {},
        bindings: { global: { regexRules: [] }, characters: {} }
    };

    const saveConfig = options.saveConfig || (() => {});
    const clearParticipantProfileTimers = options.clearParticipantProfileTimers || (() => {});
    const defaultAiClient = {
        updateConfig() {},
        getVisibleResponseContent(result) {
            if (typeof result === 'string') return result;
            return result?.content || result?.text || '';
        }
    };

    setupRoutes(app, config, saveConfig, {
        characterManager: options.characterManager || {
            listCharacters() { return []; },
            getCurrentCharacter() { return null; },
            extractSillyTavernMetadata() { return { metadata: null }; }
        },
        worldBookManager: options.worldBookManager || { scanWorldBooks: async () => {}, readWorldBook() { return null; }, getCurrentWorldBook() { return null; } },
        sessionManager,
        regexProcessor: { updateConfig() {} },
        aiClient: { ...defaultAiClient, ...(options.aiClient || {}) },
        promptBuilder: { updateConfig() {} },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        bot: options.bot || { isConnected() { return false; } },
        ttsManager: options.ttsManager || {},
        VOICE_TYPES: {},
        runtime: { updateConfig() {} },
        getLastRoutingSnapshot: options.getLastRoutingSnapshot || (() => null),
        formatSessionLabel: (value) => value,
        getLastInjectionObservation: options.getLastInjectionObservation || (() => null),
        getRecentInjectionObservations: options.getRecentInjectionObservations || (() => []),
        getLastRecallSnapshot: options.getLastRecallSnapshot || (() => null),
        getLlmEnabled: options.getLlmEnabled || (() => true),
        setLlmEnabled: options.setLlmEnabled || ((value) => value),
        clearParticipantProfileTimers,
        analyzeParticipantProfile: options.analyzeParticipantProfile
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 18080 + (testPortOffset++ % 2000);
        const result = await new Promise((resolve, reject) => {
            const server = app.listen(port, '127.0.0.1', () => {
                resolve({ server, baseUrl: `http://127.0.0.1:${port}`, config });
            });
            server.once('error', reject);
        }).catch((error) => {
            if (error?.code === 'EADDRINUSE') {
                return null;
            }
            throw error;
        });
        if (result) {
            return result;
        }
    }

    throw new Error('???????????');
}

test('listParticipantProfiles returns only participant_profile entries ordered by updated time', () => {
    const { manager } = createTempManager();
    const namespaceA = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };
    const namespaceB = { scopeType: 'group', scopeKey: '20002', characterName: '角色B', presetName: '预设B' };

    manager.upsertParticipantProfile(namespaceA, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: 健谈',
        tags: [],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });

    manager.addMemoryEntry(namespaceA, {
        entryType: 'conversation',
        title: 'ignore me',
        content: 'not a profile',
        tags: [],
        metadata: { source: 'conversation' }
    });

    manager.upsertParticipantProfile(namespaceB, {
        participantId: 'user-b',
        title: 'Bob',
        content: '稳定画像: 冷静',
        tags: [],
        metadata: { participantId: 'user-b', participantName: 'Bob', source: 'participant_profile' }
    });

    const items = manager.listParticipantProfiles(10);

    assert.equal(items.length, 2);
    assert.equal(items[0].participantId, 'user-b');
    assert.equal(items[1].participantId, 'user-a');
    assert.equal(items[0].characterName, '角色B');
    assert.equal(items[1].presetName, '预设A');
    assert.ok(items[0].contentPreview.includes('稳定画像'));
});

test('getParticipantProfileByEntryId returns full detail and excludes non-profile entries', () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.upsertParticipantProfile(namespace, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: 健谈\n当前状态: 放松',
        tags: [],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });

    const list = manager.listParticipantProfiles(10);
    const detail = manager.getParticipantProfileByEntryId(list[0].id);

    assert.equal(detail.participantId, 'user-a');
    assert.equal(detail.participantName, 'Alice');
    assert.equal(detail.characterName, '角色A');
    assert.equal(detail.scopeType, 'user');
    assert.ok(detail.content.includes('当前状态'));

    const nonProfile = manager.addMemoryEntry(namespace, {
        entryType: 'conversation',
        title: 'ignore me',
        content: 'not a profile',
        tags: [],
        metadata: { source: 'conversation' }
    });

    assert.equal(manager.getParticipantProfileByEntryId(nonProfile.id), null);
});

test('participant profile routes return list and detail payloads', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };
    manager.upsertParticipantProfile(namespace, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: 健谈\n当前状态: 放松',
        tags: [],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });

    const { server, baseUrl } = await startTestServer(manager);
    try {
        const listRes = await fetch(`${baseUrl}/api/participant-profiles`);
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(Array.isArray(listData.items), true);
        assert.equal(listData.items.length, 1);

        const detailRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(listData.items[0].id)}`);
        const detailData = await detailRes.json();
        assert.equal(detailRes.status, 200);
        assert.equal(detailData.item.participantId, 'user-a');
        assert.ok(detailData.item.content.includes('当前状态'));
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('refresh participant profile name prefers QQ global info', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'global_shared', scopeKey: 'global_shared_memory', characterName: 'Bot', presetName: '' };
    manager.upsertParticipantProfile(namespace, {
        participantId: '10001',
        title: 'OldName',
        content: 'profile',
        tags: [],
        metadata: { participantId: '10001', participantName: 'OldName', source: 'participant_profile', groupId: '20001', messageType: 'group' }
    });

    const { server, baseUrl } = await startTestServer(manager, {
        bot: {
            isConnected() { return true; },
            async getStrangerInfo(userId) {
                assert.equal(String(userId), '10001');
                return { user_id: 10001, nickname: 'GlobalName' };
            }
        }
    });
    try {
        const item = manager.listParticipantProfiles(1)[0];
        const res = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(item.id)}/refresh-name`, { method: 'POST' });
        const data = await res.json();

        assert.equal(res.status, 200);
        assert.equal(data.success, true);
        assert.equal(data.item.participantName, 'GlobalName');
        assert.equal(data.item.metadata.lastParticipantNameSource, 'qq_global_info');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        manager.close();
    }
});

test('refresh participant profile name falls back to group member info', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'global_shared', scopeKey: 'global_shared_memory', characterName: 'Bot', presetName: '' };
    manager.upsertParticipantProfile(namespace, {
        participantId: '10002',
        title: 'OldName',
        content: 'profile',
        tags: [],
        metadata: { participantId: '10002', participantName: 'OldName', source: 'participant_profile', groupId: '20002', messageType: 'group' }
    });

    const calls = [];
    const { server, baseUrl } = await startTestServer(manager, {
        bot: {
            isConnected() { return true; },
            async getStrangerInfo() {
                calls.push('global');
                return {};
            },
            async getGroupMemberInfo(groupId, userId) {
                calls.push(`member:${groupId}:${userId}`);
                return { user_id: 10002, card: 'GroupCardName', nickname: 'GlobalFallback' };
            }
        }
    });
    try {
        const item = manager.listParticipantProfiles(1)[0];
        const res = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(item.id)}/refresh-name`, { method: 'POST' });
        const data = await res.json();

        assert.equal(res.status, 200);
        assert.equal(data.item.participantName, 'GroupCardName');
        assert.equal(data.item.metadata.lastParticipantNameSource, 'qq_group_member_info');
        assert.deepEqual(calls, ['global', 'member:20002:10002']);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        manager.close();
    }
});

test('refresh participant profile name falls back to friend list for private profile', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'user:10003', characterName: 'Bot', presetName: '' };
    manager.upsertParticipantProfile(namespace, {
        participantId: '10003',
        title: 'OldName',
        content: 'profile',
        tags: [],
        metadata: { participantId: '10003', participantName: 'OldName', source: 'participant_profile', messageType: 'private' }
    });

    const { server, baseUrl } = await startTestServer(manager, {
        bot: {
            isConnected() { return true; },
            async getStrangerInfo() {
                return {};
            },
            async getFriendList() {
                return [{ user_id: 10003, remark: 'FriendRemark', nickname: 'FriendNick' }];
            }
        }
    });
    try {
        const item = manager.listParticipantProfiles(1)[0];
        const res = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(item.id)}/refresh-name`, { method: 'POST' });
        const data = await res.json();

        assert.equal(res.status, 200);
        assert.equal(data.item.participantName, 'FriendRemark');
        assert.equal(data.item.metadata.lastParticipantNameSource, 'qq_friend_list');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        manager.close();
    }
});

test('participant profile routes support detail save delete and manual analyze payloads', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };
    manager.upsertParticipantProfile(namespace, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: 健谈\n当前状态: 放松',
        tags: ['profile'],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });

    let analyzeCalls = 0;
    const { server, baseUrl } = await startTestServer(manager, {
        analyzeParticipantProfile: async (item, options) => {
            analyzeCalls += 1;
            return manager.saveParticipantProfile(item.id, {
                title: item.title,
                content: `${item.content}\n补充分析: 更主动`,
                tags: item.tags,
                metadata: {
                    ...item.metadata,
                    triggeredBy: options.triggeredBy,
                    updatedBy: options.operator,
                    editedBy: options.operator
                }
            });
        }
    });

    try {
        const listRes = await fetch(`${baseUrl}/api/participant-profiles`);
        const listData = await listRes.json();
        const targetId = listData.items[0].id;

        const saveRes = await fetch(`${baseUrl}/api/participant-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: targetId,
                title: 'Alice 编辑版',
                content: '稳定画像: 健谈\n当前状态: 专注',
                tags: ['profile', 'edited'],
                metadata: {
                    note: '管理员修订'
                }
            })
        });
        const saveData = await saveRes.json();
        assert.equal(saveRes.status, 200);
        assert.equal(saveData.success, true);
        assert.equal(saveData.item.title, 'Alice 编辑版');
        assert.equal(saveData.item.metadata.note, '管理员修订');
        assert.equal(saveData.item.metadata.updatedBy, 'admin-panel');
        assert.deepEqual(saveData.item.tags, ['profile', 'edited']);

        const analyzeRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(targetId)}/analyze`, {
            method: 'POST'
        });
        const analyzeData = await analyzeRes.json();
        assert.equal(analyzeRes.status, 200);
        assert.equal(analyzeData.success, true);
        assert.equal(analyzeCalls, 1);
        assert.ok(analyzeData.item.content.includes('补充分析'));
        assert.equal(analyzeData.item.metadata.triggeredBy, 'admin_panel');
        assert.equal(analyzeData.item.metadata.updatedBy, 'admin');

        const deleteRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(targetId)}`, {
            method: 'DELETE'
        });
        const deleteData = await deleteRes.json();
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteData.success, true);

        const missingRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(targetId)}`);
        const missingData = await missingRes.json();
        assert.equal(missingRes.status, 404);
        assert.equal(missingData.success, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('participant profile routes reject invalid save payloads and missing analyze handler', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };
    manager.upsertParticipantProfile(namespace, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: 健谈',
        tags: [],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });

    const entryId = manager.listParticipantProfiles(10)[0].id;
    const { server, baseUrl } = await startTestServer(manager);
    try {
        const badSaveRes = await fetch(`${baseUrl}/api/participant-profiles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: entryId,
                title: '   ',
                content: '稳定画像: 健谈'
            })
        });
        const badSaveData = await badSaveRes.json();
        assert.equal(badSaveRes.status, 400);
        assert.equal(badSaveData.success, false);
        assert.equal(badSaveData.error, '人物档案标题不能为空');

        const analyzeRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(entryId)}/analyze`, {
            method: 'POST'
        });
        const analyzeData = await analyzeRes.json();
        assert.equal(analyzeRes.status, 501);
        assert.equal(analyzeData.success, false);
        assert.equal(analyzeData.error, '人物档案手动分析未启用');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('mention test route generates AI content, sends structured at message, and rejects invalid payloads', async () => {
    const { manager } = createTempManager();
    const sentMessages = [];
    const aiCalls = [];
    const { server, baseUrl } = await startTestServer(manager, {
        aiClient: {
            updateConfig() {},
            async chat(messages) {
                aiCalls.push(messages);
                return 'AI 生成的提醒内容';
            }
        },
        bot: {
            async sendGroupMessage(groupId, message) {
                sentMessages.push({ groupId, message });
                return { message_id: 1 };
            }
        }
    });

    try {
        const successRes = await fetch(`${baseUrl}/api/test/mention`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                groupId: '123456',
                targetUserId: '654321',
                targetName: '小明',
                message: '提醒他今天记得回消息'
            })
        });
        const successData = await successRes.json();
        assert.equal(successRes.status, 200);
        assert.equal(successData.success, true);
        assert.equal(successData.message, '主动 @ 消息已发送');
        assert.equal(successData.generatedMessage, 'AI 生成的提醒内容');
        assert.equal(aiCalls.length, 1);
        assert.equal(aiCalls[0][0].role, 'system');
        assert.ok(aiCalls[0][0].content.includes('现在需要主动 @ 一位群成员'));
        assert.equal(aiCalls[0][1].role, 'user');
        assert.ok(aiCalls[0][1].content.includes('群号: 123456'));
        assert.ok(aiCalls[0][1].content.includes('目标成员: 小明 (654321)'));
        assert.ok(aiCalls[0][1].content.includes('要求: 提醒他今天记得回消息'));
        assert.equal(sentMessages.length, 1);
        assert.equal(sentMessages[0].groupId, '123456');
        assert.deepEqual(sentMessages[0].message, [
            { type: 'at', data: { qq: '654321' } },
            { type: 'text', data: { text: ' AI 生成的提醒内容' } }
        ]);

        const missingRes = await fetch(`${baseUrl}/api/test/mention`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                groupId: '123456',
                targetUserId: '',
                message: '你好'
            })
        });
        const missingData = await missingRes.json();
        assert.equal(missingRes.status, 400);
        assert.equal(missingData.success, false);
        assert.equal(missingData.error, 'groupId、targetUserId 和 message 不能为空');

        const atAllRes = await fetch(`${baseUrl}/api/test/mention`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                groupId: '123456',
                targetUserId: 'all',
                message: '你好'
            })
        });
        const atAllData = await atAllRes.json();
        assert.equal(atAllRes.status, 400);
        assert.equal(atAllData.success, false);
        assert.equal(atAllData.error, '不支持向 @全体成员 主动发送消息');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('AI test route uses tool context and forwards default mention target info', async () => {
    const { manager } = createTempManager();
    const chatWithToolsCalls = [];
    const { server, baseUrl } = await startTestServer(manager, {
        config: {
            auth: { enabled: false },
            chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist', allowedGroups: ['123456'] },
            memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
            ai: {
                tools: {
                    webSearch: { enabled: true },
                    sendMention: { enabled: true }
                }
            },
            regex: { rules: [] },
            preset: {},
            bindings: { global: { regexRules: [] }, characters: {} }
        },
        aiClient: {
            updateConfig() {},
            async chatWithTools(messages, toolContext) {
                chatWithToolsCalls.push({ messages, toolContext });
                return '工具调用回复';
            },
            getVisibleResponseContent(result) {
                return typeof result === 'string' ? result : (result?.content || '');
            },
            async chat(messages) {
                return messages?.[1]?.content?.includes('提醒他看一下搜索结果')
                    ? '好的，记得看一下搜索结果。'
                    : '默认回复';
            }
        },
        bot: {
            async sendGroupMessage() {
                return { message_id: 1 };
            }
        }
    });

    try {
        const successRes = await fetch(`${baseUrl}/api/test/ai`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: '????????',
                groupId: '123456',
                targetUserId: '654321',
                targetName: '小明'
            })
        });
        const successData = await successRes.json();
        assert.equal(successRes.status, 200);
        assert.equal(successData.success, true);
        assert.equal(successData.response, '工具调用回复');
        assert.deepEqual(successData.toolsEnabled, ['web_search', 'send_group_mention']);
        assert.equal(chatWithToolsCalls.length, 1);
        assert.equal(chatWithToolsCalls[0].messages.at(-1).role, 'user');
        assert.equal(chatWithToolsCalls[0].messages.at(-1).content, '????????');
        assert.equal(chatWithToolsCalls[0].messages[0].role, 'system');
        assert.deepEqual(chatWithToolsCalls[0].toolContext.tools.map((tool) => tool.function.name), ['web_search', 'send_group_mention']);
        const mentionResult = await chatWithToolsCalls[0].toolContext.handlers.send_group_mention({ prompt: '提醒他看一下搜索结果' });
        assert.equal(mentionResult.ok, true);
        assert.equal(mentionResult.groupId, '123456');
        assert.equal(mentionResult.targetUserId, '654321');

        const missingRes = await fetch(`${baseUrl}/api/test/ai`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: '   ' })
        });
        const missingData = await missingRes.json();
        assert.equal(missingRes.status, 400);
        assert.equal(missingData.success, false);
        assert.equal(missingData.error, 'message 不能为空');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('variable routes support list detail create update and delete', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };
    manager.upsertVariable(namespace, {
        key: 'mood_score',
        valueType: 'number',
        rawValue: '42',
        tags: ['profile'],
        metadata: { note: '初始值', source: 'admin' }
    });

    const { server, baseUrl } = await startTestServer(manager);
    try {
        const listRes = await fetch(`${baseUrl}/api/memory/variables?scopeType=user_persistent&scopeKey=default&limit=10`);
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(listData.success, true);
        assert.equal(Array.isArray(listData.items), true);
        assert.equal(listData.items.length, 1);
        assert.equal(listData.items[0].key, 'mood_score');
        assert.equal(listData.items[0].valueType, 'number');

        const detailRes = await fetch(`${baseUrl}/api/memory/variables/${encodeURIComponent(listData.items[0].id)}`);
        const detailData = await detailRes.json();
        assert.equal(detailRes.status, 200);
        assert.equal(detailData.success, true);
        assert.equal(detailData.item.rawValue, '42');
        assert.equal(detailData.item.metadata.note, '初始值');

        const createRes = await fetch(`${baseUrl}/api/memory/variables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: 'relationship_flags',
                valueType: 'json',
                rawValue: '{"trust":true}',
                scopeType: 'user_persistent',
                scopeKey: 'default',
                characterName: '角色A',
                presetName: '预设A',
                note: '创建测试',
                tags: ['memory', 'json']
            })
        });
        const createData = await createRes.json();
        assert.equal(createRes.status, 200);
        assert.equal(createData.success, true);
        assert.equal(createData.created, true);
        assert.equal(createData.item.key, 'relationship_flags');
        assert.ok(createData.item.rawValue.includes('"trust": true'));

        const updateRes = await fetch(`${baseUrl}/api/memory/variables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: 'relationship_flags',
                valueType: 'json',
                rawValue: '{"trust":false}',
                scopeType: 'user_persistent',
                scopeKey: 'default',
                characterName: '角色A',
                presetName: '预设A',
                note: '更新测试',
                tags: ['memory']
            })
        });
        const updateData = await updateRes.json();
        assert.equal(updateRes.status, 200);
        assert.equal(updateData.success, true);
        assert.equal(updateData.created, false);
        assert.ok(updateData.item.rawValue.includes('"trust": false'));
        assert.equal(updateData.item.metadata.note, '更新测试');

        const deleteRes = await fetch(`${baseUrl}/api/memory/variables/${encodeURIComponent(updateData.item.id)}`, {
            method: 'DELETE'
        });
        const deleteData = await deleteRes.json();
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteData.success, true);

        const missingRes = await fetch(`${baseUrl}/api/memory/variables/${encodeURIComponent(updateData.item.id)}`);
        const missingData = await missingRes.json();
        assert.equal(missingRes.status, 404);
        assert.equal(missingData.success, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('variable routes reject empty variable names', async () => {
    const { manager } = createTempManager();
    const { server, baseUrl } = await startTestServer(manager);
    try {
        const res = await fetch(`${baseUrl}/api/memory/variables`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key: '   ',
                valueType: 'string',
                rawValue: 'value',
                scopeType: 'user_persistent',
                scopeKey: 'default'
            })
        });
        const data = await res.json();
        assert.equal(res.status, 400);
        assert.equal(data.success, false);
        assert.equal(data.error, '变量名不能为空');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('knowledge routes support list detail create update and delete', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };
    manager.upsertKnowledgeEntry(namespace, {
        title: '角色设定',
        content: '角色A 非常护短，讨厌被背叛。',
        knowledgeType: 'fixed',
        tags: ['persona'],
        metadata: { note: '初始固定知识', source: 'admin' }
    });

    const { server, baseUrl } = await startTestServer(manager);
    try {
        const listRes = await fetch(`${baseUrl}/api/memory/knowledge?scopeType=user_persistent&scopeKey=default&knowledgeType=fixed&limit=10`);
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(listData.success, true);
        assert.equal(Array.isArray(listData.items), true);
        assert.equal(listData.items.length, 1);
        assert.equal(listData.items[0].title, '角色设定');
        assert.equal(listData.items[0].knowledgeType, 'fixed');

        const detailRes = await fetch(`${baseUrl}/api/memory/knowledge/${encodeURIComponent(listData.items[0].id)}`);
        const detailData = await detailRes.json();
        assert.equal(detailRes.status, 200);
        assert.equal(detailData.success, true);
        assert.equal(detailData.item.metadata.note, '初始固定知识');
        assert.ok(detailData.item.content.includes('护短'));

        const createRes = await fetch(`${baseUrl}/api/memory/knowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: '近期观察',
                content: '最近从群聊里学会了少用反问句。',
                knowledgeType: 'dynamic',
                scopeType: 'user_persistent',
                scopeKey: 'default',
                characterName: '角色A',
                presetName: '预设A',
                note: '创建测试',
                tags: ['learning']
            })
        });
        const createData = await createRes.json();
        assert.equal(createRes.status, 200);
        assert.equal(createData.success, true);
        assert.equal(createData.created, true);
        assert.equal(createData.item.knowledgeType, 'dynamic');
        assert.equal(createData.item.metadata.note, '创建测试');

        const updateRes = await fetch(`${baseUrl}/api/memory/knowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                id: createData.item.id,
                title: '近期观察（已整理）',
                content: '最近从群聊里学会了少用反问句，并更自然地接话。',
                knowledgeType: 'dynamic',
                note: '更新测试',
                tags: ['learning', 'edited']
            })
        });
        const updateData = await updateRes.json();
        assert.equal(updateRes.status, 200);
        assert.equal(updateData.success, true);
        assert.equal(updateData.created, false);
        assert.equal(updateData.item.title, '近期观察（已整理）');
        assert.equal(updateData.item.metadata.note, '更新测试');
        assert.deepEqual(updateData.item.tags, ['learning', 'edited']);

        const deleteRes = await fetch(`${baseUrl}/api/memory/knowledge/${encodeURIComponent(updateData.item.id)}`, {
            method: 'DELETE'
        });
        const deleteData = await deleteRes.json();
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteData.success, true);

        const missingRes = await fetch(`${baseUrl}/api/memory/knowledge/${encodeURIComponent(updateData.item.id)}`);
        const missingData = await missingRes.json();
        assert.equal(missingRes.status, 404);
        assert.equal(missingData.success, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('knowledge import route splits long novel text into scoped knowledge entries', async () => {
    const { manager } = createTempManager();
    const { server, baseUrl } = await startTestServer(manager, {
        aiClient: {
            updateConfig() {},
            async chat() {
                return JSON.stringify([
                    { title: '????', content: '????????????', tags: ['novel', 'plot'] }
                ]);
            }
        }
    });
    try {
        const novelText = [
            '第一段。角色A在雨夜里捡回了一只受伤的猫，并决定悄悄照顾它。她先把外套垫在纸箱下面，又去便利店买了纱布、温水和罐头，还反复确认附近有没有能临时安置小动物的地方。回到住处后，她一边擦干猫爪上的泥水，一边小声念叨自己只是碰巧看到。可她还是认真记下了伤口的位置、猫的反应、喝水的速度，以及明天一早还要再去问诊的计划。',
            '第二段。第二天她在群里依旧嘴硬，但已经开始给猫准备食物和毛巾。别人问她是不是特地早起时，她只是说顺路而已，可转头又认真记下了喂药时间、换水时间和猫窝要放在什么位置。她还专门查了幼猫保暖和应激反应的资料，把注意事项抄进备忘录，甚至担心自己出门太久会让猫害怕，连离开前要不要开小夜灯都想了半天。',
            '第三段。后来同伴提起这件事时，她还是会强调自己只是顺手。可一旦有人担心那只猫撑不过去，她又会立刻补一句别乱说，还会悄悄把大家的建议整理成清单，照着一点点去做。几天后猫终于肯主动蹭她的手背，她嘴上说麻烦，实际上却把新的照片存了好几份，还提前准备了更大的纸箱、软垫和后续复诊要问的问题。'
        ].join('\n\n');

        const importRes = await fetch(`${baseUrl}/api/memory/knowledge/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: novelText,
                title: '雨夜捡猫',
                knowledgeType: 'fixed',
                chunkSize: 35,
                scopeType: 'user_persistent',
                scopeKey: 'default',
                characterName: '角色A',
                presetName: '预设A',
                note: '小说导入测试',
                tags: ['novel', 'plot']
            })
        });
        const importData = await importRes.json();
        assert.equal(importRes.status, 200);
        assert.equal(importData.success, true);
        assert.equal(importData.importedCount, 3);
        assert.equal(importData.chunkCount, 3);
        assert.equal(importData.knowledgeType, 'fixed');
        assert.equal(importData.scope.characterName, '角色A');
        assert.equal(Array.isArray(importData.items), true);
        assert.equal(importData.items.length, 3);
        assert.equal(typeof importData.items[0].title, 'string');
        assert.equal(importData.items[0].knowledgeType, 'fixed');
        assert.equal(importData.items[0].metadata.source, 'novel-import-llm');
        assert.equal(importData.items[0].metadata.importTitle, '雨夜捡猫');
        assert.equal(importData.items[0].metadata.chunkCount, 3);
        assert.equal(importData.items[0].metadata.chunkNumber, 1);
        assert.deepEqual(importData.items[0].tags, ['novel', 'plot']);

        const listRes = await fetch(`${baseUrl}/api/memory/knowledge?scopeType=user_persistent&scopeKey=default&knowledgeType=fixed&limit=10`);
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(listData.success, true);
        assert.equal(listData.items.length, 3);
        assert.equal(listData.items.every((item) => item.metadata.source === 'novel-import-llm'), true);
        assert.equal(listData.items.some((item) => typeof item.content === 'string' && item.content.length > 0), true);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('knowledge routes reject invalid payloads and export/import preserves knowledge entries', async () => {
    const { manager, tempDir } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };
    manager.upsertKnowledgeEntry(namespace, {
        title: '固定知识',
        content: '角色A 害怕失去重要的人。',
        knowledgeType: 'fixed',
        tags: ['persona'],
        metadata: { source: 'admin' }
    });
    manager.upsertKnowledgeEntry(namespace, {
        title: '动态知识',
        content: '最近学会了在回答里补一句安抚。',
        knowledgeType: 'dynamic',
        tags: ['learning'],
        metadata: { source: 'admin' }
    });

    const { server, baseUrl } = await startTestServer(manager);
    try {
        const badRes = await fetch(`${baseUrl}/api/memory/knowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: '   ',
                content: '有效内容',
                scopeType: 'user_persistent',
                scopeKey: 'default'
            })
        });
        const badData = await badRes.json();
        assert.equal(badRes.status, 400);
        assert.equal(badData.success, false);
        assert.equal(badData.error, '知识标题不能为空');

        const exportRes = await fetch(`${baseUrl}/api/memory/export`);
        assert.equal(exportRes.status, 200);
        const exportData = await exportRes.json();
        assert.equal(Array.isArray(exportData.knowledge.entries), true);
        assert.equal(exportData.knowledge.entries.length, 2);
        assert.equal(exportData.knowledge.entries.some((entry) => entry.entryType === 'knowledge_fixed'), true);
        assert.equal(exportData.knowledge.entries.some((entry) => entry.entryType === 'knowledge_dynamic'), true);

        const importedManager = new SessionManager(tempDir, {
            chat: { historyLimit: 30, maxGlobalMessages: 2000, sessionMode: 'user_persistent' },
            memory: {
                storage: { path: path.join(tempDir, 'memory-imported.sqlite') },
                summary: { enabled: false }
            }
        }, { info() {}, warn() {}, error() {} });
        const importResult = importedManager.importMemorySnapshot(exportData, { replace: true });
        assert.equal(importResult.importedMemoryEntries, 2);
        const importedItems = importedManager.listKnowledgeEntries({ limit: 10 });
        assert.equal(importedItems.length, 2);
        assert.equal(importedItems.some((item) => item.knowledgeType === 'fixed'), true);
        assert.equal(importedItems.some((item) => item.knowledgeType === 'dynamic'), true);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('knowledge import route rejects empty text', async () => {
    const { manager } = createTempManager();
    const { server, baseUrl } = await startTestServer(manager);
    try {
        const badRes = await fetch(`${baseUrl}/api/memory/knowledge/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: '   ',
                title: '空文本',
                scopeType: 'user_persistent',
                scopeKey: 'default'
            })
        });
        const badData = await badRes.json();
        assert.equal(badRes.status, 400);
        assert.equal(badData.success, false);
        assert.equal(badData.error, '导入文本不能为空');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('admin UI includes knowledge management tab and panel hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('data-panel="knowledge"'));
    assert.ok(html.includes('id="knowledge-list"'));
    assert.ok(html.includes('id="knowledge-detail"'));
    assert.ok(html.includes('id="knowledge-import-text"'));
    assert.ok(html.includes('loadKnowledgeEntries()'));
    assert.ok(html.includes('importKnowledgeText()'));
});

test('recallMemory prioritizes fixed knowledge and annotates recall metadata', () => {
    const logs = [];
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-recall-knowledge-'));
    const manager = new SessionManager(tempDir, {
        chat: { historyLimit: 30, maxGlobalMessages: 2000, sessionMode: 'user_persistent' },
        memory: {
            storage: { path: path.join(tempDir, 'memory.sqlite') },
            summary: { enabled: false }
        }
    }, {
        info(message, payload) {
            logs.push({ level: 'info', message, payload });
        },
        warn() {},
        error() {}
    });
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };

    const fixed = manager.upsertKnowledgeEntry(namespace, {
        title: '固定设定',
        content: '角色A 绝不会背叛同伴，也非常护短。',
        knowledgeType: 'fixed',
        tags: ['persona'],
        metadata: { source: 'admin' }
    });
    const dynamic = manager.upsertKnowledgeEntry(namespace, {
        title: '动态观察',
        content: '最近从群聊里学会了更自然地安抚同伴。',
        knowledgeType: 'dynamic',
        tags: ['learning'],
        metadata: { source: 'learning' }
    });
    const recentMemory = manager.addMemoryEntry(namespace, {
        entryType: 'conversation',
        title: '普通记忆',
        content: '前几天只是随口聊过护短这个词。',
        tags: ['护短'],
        metadata: { source: 'conversation' }
    });

    const results = manager.recallMemory(namespace, '护短 同伴 安抚', {
        recentLimit: 5,
        searchLimit: 5,
        summaryLimit: 0,
        fixedLimit: 5,
        limit: 5
    });

    assert.equal(results.length >= 3, true);
    assert.equal(results[0].id, fixed.id);
    assert.equal(results[0].sourceKind, 'knowledge_fixed');
    assert.equal(results[0].recallReason, 'fixed_knowledge');
    assert.equal(results[0].recallScore > 120, true);

    const dynamicResult = results.find((entry) => entry.id === dynamic.id);
    assert.ok(dynamicResult);
    assert.equal(dynamicResult.sourceKind, 'knowledge_dynamic');
    assert.equal(['dynamic_knowledge_match', 'dynamic_knowledge_recent'].includes(dynamicResult.recallReason), true);

    const recentMemoryResult = results.find((entry) => entry.id === recentMemory.id);
    assert.ok(recentMemoryResult);
    assert.equal(results.findIndex((entry) => entry.id === fixed.id) < results.findIndex((entry) => entry.id === recentMemory.id), true);

    const recallLog = logs.find((entry) => entry.message === '[记忆] 记忆召回完成');
    assert.ok(recallLog);
    assert.equal(recallLog.payload.fixedKnowledgeCount, 1);
    assert.equal(recallLog.payload.resultCount, results.length);
    assert.equal(recallLog.payload.results.some((entry) => entry.sourceKind === 'knowledge_fixed'), true);
});

test('recallMemory keeps fixed knowledge when query is empty', () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };

    const fixed = manager.upsertKnowledgeEntry(namespace, {
        title: '固定设定',
        content: '角色A 会始终维护自己认定的同伴。',
        knowledgeType: 'fixed',
        tags: ['persona'],
        metadata: { source: 'admin' }
    });
    manager.addMemoryEntry(namespace, {
        entryType: 'conversation',
        title: '普通聊天',
        content: '今天只是闲聊了天气。',
        tags: ['天气'],
        metadata: { source: 'conversation' }
    });

    const results = manager.recallMemory(namespace, '', {
        recentLimit: 5,
        searchLimit: 5,
        summaryLimit: 0,
        fixedLimit: 5,
        limit: 5
    });

    assert.equal(results.some((entry) => entry.id === fixed.id), true);
    const fixedResult = results.find((entry) => entry.id === fixed.id);
    assert.equal(fixedResult.sourceKind, 'knowledge_fixed');
    assert.equal(fixedResult.recallReason, 'fixed_knowledge');
});

test('knowledge routes support role-first scope aliases for list create and import', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' };
    manager.upsertKnowledgeEntry(namespace, {
        title: '角色挂载知识',
        content: '这条知识通过角色维度管理。',
        knowledgeType: 'fixed',
        tags: ['persona'],
        metadata: { source: 'admin' }
    });

    const { server, baseUrl } = await startTestServer(manager, {
        aiClient: {
            updateConfig() {},
            async chat() {
                return JSON.stringify([
                    { title: '????', content: '?????????????', tags: ['novel'] }
                ]);
            }
        }
    });
    try {
        const listRes = await fetch(`${baseUrl}/api/memory/knowledge?character=角色A&preset=预设A&knowledgeType=fixed&limit=10`);
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(listData.success, true);
        assert.equal(listData.items.length, 1);
        assert.equal(listData.filters.characterName, '角色A');
        assert.equal(listData.filters.presetName, '预设A');

        const createRes = await fetch(`${baseUrl}/api/memory/knowledge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: '别名创建',
                content: '通过 roleName / preset 写入。',
                knowledgeType: 'dynamic',
                roleName: '角色B',
                preset: '预设B',
                note: '别名测试',
                tags: ['learning']
            })
        });
        const createData = await createRes.json();
        assert.equal(createRes.status, 200);
        assert.equal(createData.success, true);
        assert.equal(createData.created, true);
        assert.equal(createData.item.characterName, '角色B');
        assert.equal(createData.item.presetName, '预设B');
        assert.equal(createData.item.scopeType, 'user_persistent');
        assert.equal(createData.item.scopeKey, 'default');

        const importRes = await fetch(`${baseUrl}/api/memory/knowledge/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text: '第一段\n\n第二段',
                title: '别名导入',
                role: '角色C',
                presetName: '预设C',
                chunkSize: 2,
                tags: ['novel']
            })
        });
        const importData = await importRes.json();
        assert.equal(importRes.status, 200);
        assert.equal(importData.success, true);
        assert.equal(importData.knowledgeType, 'fixed');
        assert.equal(importData.scope.characterName, '角色C');
        assert.equal(importData.scope.presetName, '预设C');
        assert.equal(importData.scope.scopeType, 'user_persistent');
        assert.equal(importData.scope.scopeKey, 'default');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('admin UI includes role-first knowledge hooks and AI-learning defaults', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="knowledge-filter-character-name"'));
    assert.ok(html.includes('id="knowledge-filter-preset-name"'));
    assert.ok(html.includes('id="knowledge-import-character-name"'));
    assert.ok(html.includes('id="knowledge-import-preset-name"'));
    assert.ok(html.includes('<option value="dynamic" selected>AI'));
    assert.ok(html.includes('function getKnowledgeScopeDefaults(overrides = {})'));
    assert.ok(html.includes("knowledgeType: knowledgeFilters.knowledgeType || 'fixed'"));
    assert.ok(html.includes("const knowledgeType = knowledgeTypeInput?.value === 'fixed' ? 'fixed' : 'dynamic';"));
    assert.ok(html.includes('knowledgeType: payload.knowledgeType'));
    assert.ok(html.includes("scopeType: scopeDefaults.scopeType"));
    assert.ok(html.includes("scopeKey: scopeDefaults.scopeKey"));
    assert.ok(!html.includes('id="knowledge-filter-scope-type"'));
    assert.ok(!html.includes('id="knowledge-filter-scope-key"'));
    assert.ok(!html.includes('id="knowledge-import-scope-type"'));
    assert.ok(!html.includes('id="knowledge-import-scope-key"'));
});

test('config routes drop participant profile dedicated api credentials and trigger timer reset', async () => {
    const { manager } = createTempManager();
    let saveCalls = 0;
    let timerResetCalls = 0;
    const initialConfig = {
        auth: { enabled: false, username: 'admin', password: 'admin-secret', sessionSecret: 'session-secret' },
        onebot: { url: 'ws://127.0.0.1:3001', accessToken: 'onebot-secret', tokenMode: 'header' },
        tts: { enabled: true, apiKey: 'tts-secret' },
        chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist' },
        memory: {
            storage: { path: './data/chats/memory-store.sqlite' },
            summary: { enabled: false },
            participantProfile: {
                enabled: true,
                injectEnabled: true,
                blacklistParticipantIds: ['10002'],
                manualCommand: '/人物档案',
                triggerMessages: 8,
                idleMs: 120000,
                intervalMs: 300000,
                maxSourceMessages: 50,
                triggerMode: 'idle',
                analysisMode: 'profile_plus_messages',
                providerId: 'default',
                model: 'profile-model',
                baseUrl: 'https://profile.example/v1',
                apiKey: 'secret-token'
            }
        },
        tts: {
            enabled: true,
            provider: 'minimax',
            apiKey: 'tts-secret'
        },
        ai: {
            provider: 'openai-compatible',
            baseUrl: 'https://api.example/v1',
            apiKey: 'global-secret',
            model: 'main-model',
            tools: {
                webSearch: {
                    enabled: true,
                    apiKey: 'web-search-secret'
                }
            },
            providers: [
                {
                    id: 'default',
                    provider: 'openai-compatible',
                    baseUrl: 'https://provider.example/v1',
                    apiKey: 'provider-secret',
                    model: 'main-model'
                }
            ]
        },
        regex: { rules: [] },
        preset: {},
        bindings: { global: { regexRules: [] }, characters: {} }
    };

    const { server, baseUrl, config } = await startTestServer(manager, {
        config: initialConfig,
        saveConfig: () => {
            saveCalls += 1;
        },
        clearParticipantProfileTimers: () => {
            timerResetCalls += 1;
        },
        ttsManager: {
            getConfig() {
                return {
                    enabled: true,
                    provider: 'minimax',
                    apiKey: 'tts-secret',
                    accessToken: 'tts-access-token',
                    token: 'tts-token'
                };
            }
        }
    });

    try {
        const getRes = await fetch(`${baseUrl}/api/config`);
        const getData = await getRes.json();
        assert.equal(getRes.status, 200);
        assert.equal(getData.ai.apiKey, undefined);
        assert.equal(getData.ai.hasApiKey, true);
        assert.equal(getData.ai.providers[0].apiKey, undefined);
        assert.equal(getData.ai.providers[0].hasApiKey, true);
        assert.equal(getData.ai.tools.webSearch.apiKey, undefined);
        assert.equal(getData.ai.tools.webSearch.hasApiKey, true);
        assert.equal(getData.ai.provider, 'openai-compatible');
        assert.equal(getData.auth.password, undefined);
        assert.equal(getData.auth.sessionSecret, undefined);
        assert.equal(getData.auth.passwordSet, true);
        assert.equal(getData.auth.sessionSecretSet, true);
        assert.equal(getData.onebot.accessToken, undefined);
        assert.equal(getData.onebot.hasAccessToken, true);
        assert.equal(getData.tts.apiKey, undefined);
        assert.equal(getData.tts.hasApiKey, true);
        assert.equal(getData.memory.participantProfile.apiKey, undefined);
        assert.equal(getData.memory.participantProfile.baseUrl, undefined);
        assert.equal(getData.memory.participantProfile.hasApiKey, false);
        assert.equal(getData.memory.participantProfile.enabled, true);
        assert.equal(getData.memory.participantProfile.injectEnabled, true);
        assert.deepEqual(getData.memory.participantProfile.blacklistParticipantIds, ['10002']);
        assert.equal(getData.memory.participantProfile.manualCommand, '/人物档案');
        assert.equal(getData.memory.participantProfile.triggerMode, 'idle');
        assert.equal(getData.memory.participantProfile.intervalMs, 300000);
        assert.equal(getData.memory.participantProfile.analysisMode, 'profile_plus_messages');

        const ttsConfigRes = await fetch(`${baseUrl}/api/tts/config`);
        const ttsConfigData = await ttsConfigRes.json();
        assert.equal(ttsConfigRes.status, 200);
        assert.equal(ttsConfigData.apiKey, undefined);
        assert.equal(ttsConfigData.accessToken, undefined);
        assert.equal(ttsConfigData.token, undefined);
        assert.equal(ttsConfigData.hasApiKey, true);

        const statusRes = await fetch(`${baseUrl}/api/status`);
        const statusText = await statusRes.text();
        assert.equal(statusRes.status, 200);
        assert.equal(statusText.includes(manager.getDbPath()), false);
        assert.equal(/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(statusText), false);

        const memoryDatabasesRes = await fetch(`${baseUrl}/api/memory/databases`);
        const memoryDatabasesText = await memoryDatabasesRes.text();
        const memoryDatabasesData = JSON.parse(memoryDatabasesText);
        assert.equal(memoryDatabasesRes.status, 200);
        assert.equal(memoryDatabasesText.includes(manager.getDbPath()), false);
        assert.equal(/(?:^|[^A-Za-z])[A-Za-z]:[\\/]/.test(memoryDatabasesText), false);
        assert.equal(memoryDatabasesData.active.dbPath.includes(path.basename(manager.getDbPath())), true);
        assert.equal(memoryDatabasesData.databases.every((db) => !path.isAbsolute(String(db.path || ''))), true);
        assert.equal(memoryDatabasesData.databases.every((db) => !path.isAbsolute(String(db.stats?.path || ''))), true);

        const blockedPostRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
            body: JSON.stringify({ ai: { model: 'blocked-model' } })
        });
        const blockedPostData = await blockedPostRes.json();
        assert.equal(blockedPostRes.status, 403);
        assert.equal(blockedPostData.success, false);
        assert.equal(config.ai.model, 'main-model');

        const postRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: baseUrl },
            body: JSON.stringify({
                ai: {
                    apiKey: '******'
                },
                memory: {
                    participantProfile: {
                        enabled: false,
                        injectEnabled: false,
                        blacklistParticipantIds: ['10003', '10004'],
                        manualCommand: '/人物档案 @目标',
                        triggerMessages: 12,
                        triggerMode: 'both',
                        idleMs: 45000,
                        intervalMs: 90000,
                        maxSourceMessages: 30,
                        analysisMode: 'messages_only',
                        providerId: 'default',
                        model: 'profile-model-2',
                        baseUrl: 'https://profile2.example/v1',
                        apiKey: '******'
                    }
                }
            })
        });
        const postData = await postRes.json();
        assert.equal(postRes.status, 200);
        assert.equal(postData.success, true);
        assert.equal(saveCalls, 1);
        assert.ok(timerResetCalls >= 1);
        assert.equal(config.ai.apiKey, 'global-secret');
        assert.equal(config.memory.participantProfile.apiKey, undefined);
        assert.equal(config.memory.participantProfile.baseUrl, undefined);
        assert.equal(config.memory.participantProfile.enabled, false);
        assert.equal(config.memory.participantProfile.injectEnabled, false);
        assert.deepEqual(config.memory.participantProfile.blacklistParticipantIds, ['10003', '10004']);
        assert.equal(config.memory.participantProfile.manualCommand, '/人物档案 @目标');
        assert.equal(config.memory.participantProfile.triggerMessages, 12);
        assert.equal(config.memory.participantProfile.triggerMode, 'both');
        assert.equal(config.memory.participantProfile.idleMs, 45000);
        assert.equal(config.memory.participantProfile.intervalMs, 90000);
        assert.equal(config.memory.participantProfile.maxSourceMessages, 30);
        assert.equal(config.memory.participantProfile.analysisMode, 'messages_only');
        assert.equal(config.memory.participantProfile.providerId, 'default');
        assert.equal(config.memory.participantProfile.model, 'profile-model-2');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('ai model routes use config fallback and explicit overrides', async () => {
    const { manager } = createTempManager();
    const aiCalls = [];
    const { server, baseUrl } = await startTestServer(manager, {
        config: {
            auth: { enabled: false },
            chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist' },
            memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
            ai: {
                provider: 'openai-compatible',
                baseUrl: 'https://api.example/v1',
                apiKey: 'global-secret',
                model: 'main-model'
            },
            regex: { rules: [] },
            preset: {},
            bindings: { global: { regexRules: [] }, characters: {} }
        },
        aiClient: {
            updateConfig() {},
            async listModels(options) {
                aiCalls.push({ type: 'listModels', options });
                return [{ id: 'gpt-4o-mini', recommendedMaxTokens: 16384 }];
            },
            async probeModel(model, options) {
                aiCalls.push({ type: 'probeModel', model, options });
                return {
                    model: { id: model, recommendedMaxTokens: 8192 },
                    availableModels: [{ id: model, recommendedMaxTokens: 8192 }]
                };
            }
        }
    });

    try {
        const listRes = await fetch(`${baseUrl}/api/ai/models`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        const listData = await listRes.json();
        assert.equal(listRes.status, 200);
        assert.equal(listData.success, true);
        assert.equal(Array.isArray(listData.models), true);
        assert.equal(aiCalls[0].type, 'listModels');
        assert.deepEqual(aiCalls[0].options, {
            baseUrl: 'https://api.example/v1',
            apiKey: 'global-secret'
        });

        const probeRes = await fetch(`${baseUrl}/api/ai/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                baseUrl: 'https://override.example/v1',
                apiKey: 'override-secret',
                model: 'claude-sonnet-4-5'
            })
        });
        const probeData = await probeRes.json();
        assert.equal(probeRes.status, 200);
        assert.equal(probeData.success, true);
        assert.equal(probeData.autoMaxTokens, 8192);
        assert.equal(probeData.model.id, 'claude-sonnet-4-5');
        assert.equal(aiCalls[1].type, 'probeModel');
        assert.equal(aiCalls[1].model, 'claude-sonnet-4-5');
        assert.deepEqual(aiCalls[1].options, {
            baseUrl: 'https://override.example/v1',
            apiKey: 'override-secret'
        });
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('admin UI includes provider-first AI config hooks and defaults', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-ai-provider"'));
    assert.ok(html.includes('id="config-ai-model"'));
    assert.ok(html.includes('id="config-ai-apikey"'));
    assert.ok(html.includes('id="config-ai-baseurl"'));
    assert.ok(html.includes('id="config-ai-model-quick-list"'));
    assert.ok(html.includes('id="config-ai-provider-hint"'));
    assert.ok(html.includes('updateAIProviderFields({ applyDefaultBaseUrl: true, applyDefaultModel: true })'));
    assert.ok(html.includes('fetchAIModels()'));
    assert.ok(html.includes('probeAIModel()'));
    assert.ok(html.includes('function buildResolvedAIConfig(draft = {}, options = {})'));
    assert.ok(html.includes('function updateAIProviderFields(options = {})'));
    assert.ok(html.includes('provider: normalizedProvider'));
    assert.ok(html.includes("entry.provider = normalizeAIProvider(document.getElementById('config-ai-provider')?.value || entry.provider);"));
    assert.ok(html.includes("body: JSON.stringify(draft)"));
    assert.ok(html.includes("currentConfig.onebot?.hasAccessToken ? '已配Token，留空表示不修改' : '留空表示无需认证'"));
    assert.ok(!html.includes('currentConfig.onebot?.accessToken ?'));
    assert.ok(html.includes('已根据上游元数据填入推荐 Tokens'));
    assert.ok(html.includes("function markConfigSaved(message = '配置已保存')"));
    assert.ok(html.includes("showToast('配置已保存')"));
    assert.ok(!html.includes('设置已保'));
    assert.ok(!html.includes("function markConfigSaved(message = '配置已保')"));
    assert.ok(!html.includes("showToast('配置已保')"));
    assert.ok(!html.includes('已保存存'));
    assert.ok(!html.includes('丢个'));
    assert.ok(!html.includes('世界书列表表'));
    assert.ok(!html.includes('配置校验未过，请先修正错'));
    assert.ok(!html.includes('主动 @ 发失'));
    assert.ok(!html.includes("markConfigDirty('模型启用状已修改')"));
    assert.ok(!html.includes("markConfigDirty('模型已删')"));
    assert.ok(!html.includes('已添加模 '));
    assert.ok(!html.includes('最大输Tokens'));
    assert.ok(!html.includes('占比最</span>'));
    assert.ok(!html.includes('<div class="empty-state">暂无可用的业务构成数</div>'));
    assert.ok(!html.includes('条消</div>'));
    assert.ok(!html.includes('去导入知</button>'));
    assert.ok(!html.includes('未命名预设文</option>'));
    assert.ok(!html.includes("markConfigDirty('已恢复默认预设结')"));
    assert.ok(!html.includes("markConfigDirty('预设启用状已修改')"));
    assert.ok(!html.includes("markConfigDirty('预设名称已修')"));
    assert.ok(!html.includes('撤锢它导入的内容'));
    assert.ok(!html.includes("showToast(data.message || '预设导入文件已删')"));
    assert.ok(!html.includes("record.filename || '未命名文'"));
    assert.ok(!html.includes("showToast(data.message || '正则导入文件已删')"));
    assert.ok(!html.includes("showToast('记忆迁移已完')"));
    assert.ok(!html.includes("rule.name || '未命名规'"));
    assert.ok(!html.includes('未命名规则则'));
    assert.ok(!html.includes('更新角色记忆库失 ${e.message}'));
    assert.ok(!html.includes('Tokens 元数\'', true));
    assert.ok(!html.includes('总规 ${data.diagnostics.totalRules'));
    assert.ok(!html.includes('预设层正 ${data.importedRegexCount'));
    assert.ok(!html.includes('已配置密钥，留空表示不修改改'));
    assert.ok(!html.includes("showToast(data.message || '人物档案已删')"));
    assert.ok(!html.includes("showToast(data.message || '人物档案已重新分')"));
    assert.ok(!html.includes("showToast(data.message || '变量已删')"));
    assert.ok(!html.includes("showToast(data.message || '知识已删')"));
    assert.ok(!html.includes('加载数据库列表失 ${escapeHtml(e.message)}'));
    assert.ok(!html.includes("showToast('加载世界书内容失'"));
    assert.ok(!html.includes("showToast('条目已删')"));
    assert.ok(!html.includes("showToast('规则已删')"));
    assert.ok(html.includes('已配置密钥，留空表示不修改'));
    assert.ok(html.includes('人物档案已删除'));
    assert.ok(html.includes('人物档案已重新分析'));
    assert.ok(html.includes('变量已删除'));
    assert.ok(html.includes('知识已删除'));
    assert.ok(html.includes('加载数据库列表失败'));
    assert.ok(html.includes('加载世界书内容失败'));
    assert.ok(html.includes('条目已删除'));
    assert.ok(html.includes('规则已删除'));
    assert.ok(html.includes('id="regex-import-rule-detail"'));
    assert.ok(html.includes('function getSelectedRegexImportRecord()'));
    assert.ok(html.includes('function renderSelectedRegexImportRules()'));
    assert.ok(html.includes("record.importedRules"));
    assert.ok(html.includes('未命名文件'));
    assert.ok(html.includes('未命名规则'));
    assert.ok(html.includes('正则导入文件已删除'));
    assert.ok(html.includes('记忆迁移已完成'));
    assert.ok(html.includes('预设层正则'));
    assert.ok(html.includes('function getSelectedPresetImportRecord()'));
    assert.ok(html.includes('function applySelectedPresetSource()'));
    assert.ok(html.includes('record?.importedPreset || activeSource.preset || currentConfig?.preset || {}'));
    assert.ok(html.includes("const label = (r) => r.presetName || r.filename || '未命名';"));
    assert.ok(html.includes('动态知识'));
    assert.ok(html.includes('配置校验未通过，请先修正错误'));
    assert.ok(html.includes('function sortAIModelsForQuickList(models = [])'));
    assert.ok(html.includes('const normalizedModels = sortAIModelsForQuickList(models);'));
    assert.ok(html.includes('model.enabled !== false'));
    assert.ok(html.includes('availableAIModels = normalizeAIModelEntries(models);'));
    assert.ok(!html.includes('entry.models = mergedModels;'));
    assert.ok(html.includes('onclick="addAIModelToActiveProvider({ id:'));
    assert.ok(html.includes('style="background: conic-gradient(${segments.join(\', \')});"'));
    assert.ok(!html.includes('color-mix(in srgb, var(--accent) 80%, var(--bg-primary) 20%)'));
});

test('status route returns structured recall snapshot with knowledge source kinds', async () => {
    const { manager } = createTempManager();
    const recallSnapshot = {
        at: Date.now(),
        namespace: { scopeType: 'user_persistent', scopeKey: 'default', characterName: '角色A', presetName: '预设A' },
        query: '护短 同伴',
        hits: [
            {
                id: 'fixed-1',
                title: '固定设定',
                sourceKind: 'knowledge_fixed',
                recallReason: 'fixed_knowledge',
                recallScore: 136,
                preview: '角色A 会保护自己认定的同伴。'
            },
            {
                id: 'dynamic-1',
                title: '动态观察',
                sourceKind: 'knowledge_dynamic',
                recallReason: 'dynamic_knowledge_match',
                recallScore: 92,
                preview: '最近学会了更自然地安抚同伴。'
            }
        ]
    };

    const { server, baseUrl } = await startTestServer(manager, {
        bot: {
            isConnected() {
                return false;
            }
        },
        worldBookManager: {
            scanWorldBooks: async () => {},
            readWorldBook() { return null; },
            getCurrentWorldBook() { return null; }
        },
        getLastRecallSnapshot: () => recallSnapshot
    });

    try {
        const res = await fetch(`${baseUrl}/api/status`);
        const data = await res.json();
        assert.equal(res.status, 200);
        assert.equal(data.lastRecall.query, '护短 同伴');
        assert.equal(Array.isArray(data.lastRecall.hits), true);
        assert.equal(data.lastRecall.hits.length, 2);
        assert.equal(data.lastRecall.hits[0].sourceKind, 'knowledge_fixed');
        assert.equal(data.lastRecall.hits[0].recallReason, 'fixed_knowledge');
        assert.equal(data.lastRecall.hits[1].sourceKind, 'knowledge_dynamic');
        assert.equal(data.lastRecall.hits[1].recallReason, 'dynamic_knowledge_match');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('admin UI includes participant profile config field hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-memory-participant-profile-enabled"'));
    assert.ok(html.includes('id="config-memory-participant-profile-inject-enabled"'));
    assert.ok(html.includes('id="config-memory-participant-profile-blacklist"'));
    assert.ok(html.includes('id="config-memory-participant-profile-manual-command"'));
    assert.ok(html.includes('id="config-memory-participant-profile-trigger-mode"'));
    assert.ok(html.includes('id="config-memory-participant-profile-interval"'));
    assert.ok(html.includes('id="config-memory-participant-profile-source"'));
    assert.ok(html.includes('id="config-memory-participant-profile-analysis-mode"'));
    assert.ok(html.includes('id="config-memory-participant-profile-model"'));
    assert.ok(html.includes('id="config-memory-participant-profile-provider-id"'));
    assert.ok(html.includes('applyParticipantProfileModelSelection()'));
    assert.ok(html.includes('Base URL &#x548C;&#x5BC6;&#x94A5;&#x81EA;&#x52A8;&#x7EE7;&#x627F;'));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-enabled').checked = currentConfig.memory?.participantProfile?.enabled === true;"));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-inject-enabled').checked = currentConfig.memory?.participantProfile?.injectEnabled !== false;"));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-blacklist').value = (currentConfig.memory?.participantProfile?.blacklistParticipantIds || []).join(',');"));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-manual-command').value = currentConfig.chat?.commands?.participantProfileManual?.command || currentConfig.memory?.participantProfile?.manualCommand ||"));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-analysis-mode').value = currentConfig.memory?.participantProfile?.analysisMode || 'bot_only_profile';"));
    assert.ok(html.includes("document.getElementById('config-memory-participant-profile-provider-id').value = participantProfileProviderId;"));
    assert.ok(html.includes("enabled: document.getElementById('config-memory-participant-profile-enabled').checked"));
    assert.ok(html.includes("injectEnabled: document.getElementById('config-memory-participant-profile-inject-enabled').checked"));
    assert.ok(html.includes("blacklistParticipantIds: document.getElementById('config-memory-participant-profile-blacklist').value.split(',').map((item) => item.trim()).filter(Boolean)"));
    assert.ok(html.includes("manualCommand: document.getElementById('config-chat-command-participant-profile-command').value.trim() || '/人物档案'"));
    assert.ok(html.includes("triggerMode: document.getElementById('config-memory-participant-profile-trigger-mode').value || 'idle'"));
    assert.ok(html.includes("intervalMs: parseInt(document.getElementById('config-memory-participant-profile-interval').value) || 300000"));
    assert.ok(html.includes("maxSourceMessages: parseInt(document.getElementById('config-memory-participant-profile-source').value) || 50"));
    assert.ok(html.includes("analysisMode: document.getElementById('config-memory-participant-profile-analysis-mode').value || 'bot_only_profile'"));
    assert.ok(html.includes('providerId: participantProfileModelSelection.providerId'));
    assert.ok(html.includes('model: participantProfileModelSelection.model'));
});

test('admin UI validates participant profile config fields', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes("if (draft.memory.participantProfile.manualCommand && draft.memory.participantProfile.manualCommand.length > 100) {"));
    assert.ok(html.includes("if (draft.memory.participantProfile.blacklistParticipantIds.some((id) => id.includes(','))) {"));
    assert.ok(html.includes("if (draft.memory.participantProfile.triggerMessages < 1) {"));
    assert.ok(html.includes("if (draft.memory.participantProfile.triggerMode !== 'idle' && draft.memory.participantProfile.triggerMode !== 'interval' && draft.memory.participantProfile.triggerMode !== 'both') {"));
    assert.ok(html.includes("if (draft.memory.participantProfile.intervalMs < 1000) {"));
    assert.ok(html.includes("if (draft.memory.participantProfile.maxSourceMessages < 1) {"));
    assert.ok(html.includes("const validModes = ['messages_only', 'profile_plus_messages', 'bot_only_messages', 'bot_only_profile'];"));
    assert.ok(html.includes("if (!validModes.includes(draft.memory.participantProfile.analysisMode)) {"));
});

test('admin UI includes participant profile management actions', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="participant-profile-title"'));
    assert.ok(html.includes('id="participant-profile-tags"'));
    assert.ok(html.includes('id="participant-profile-note"'));
    assert.ok(html.includes('id="participant-profile-content"'));
    assert.ok(html.includes('saveParticipantProfile()'));
    assert.ok(html.includes('refreshSelectedParticipantProfile()'));
    assert.ok(html.includes('deleteParticipantProfile()'));
    assert.ok(html.includes('analyzeParticipantProfile()'));
    assert.ok(html.includes("fetchJsonSafe('/api/participant-profiles', {"));
    assert.ok(html.includes("fetchJsonSafe(`/api/participant-profiles/${encodeURIComponent(entryId)}`, {"));
    assert.ok(html.includes("fetchJsonSafe(`/api/participant-profiles/${encodeURIComponent(entryId)}/analyze`, {"));
});

test('admin UI aligns config checkboxes with dedicated styles', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('.checkbox-label {'));
    assert.ok(html.includes('.checkbox-label input[type=\'checkbox\'] {'));
    assert.ok(html.includes('label class="checkbox-label"'));
    assert.ok(html.includes('id="config-context-enabled"'));
    assert.ok(html.includes('id="config-chat-attach-metadata"'));
    assert.ok(html.includes('id="config-chat-mention-sender"'));
    assert.ok(html.includes('id="config-memory-summary-enabled"'));
    assert.ok(html.includes('id="config-preset-enabled"'));
    assert.ok(html.includes('id="tts-enabled"'));
    assert.ok(html.includes('id="entry-constant"'));
    assert.ok(html.includes('id="entry-enabled"'));
});

test('message metadata attachment respects chat.attachMetadata toggle', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('config.chat?.attachMetadata === false ? promptText : buildStructuredMessage(event, promptText'));
    assert.ok(source.includes('messageSegments'));
    assert.ok(source.includes('structuredText'));
});

test('message runtime handles participant profile admin manual command before normal trigger checks', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('function extractMentionedParticipant(event) {'));
    assert.ok(source.includes('function isParticipantProfileManualCommand(plainText, manualCommand) {'));
    assert.ok(source.includes('const commandConfig = config.chat?.commands?.participantProfileManual || {};'));
    assert.ok(source.includes("const manualCommand = (commandConfig.command || participantProfileConfig.manualCommand || '').trim();"));
    assert.ok(source.includes('const mentionedParticipant = extractMentionedParticipant(event);'));
    assert.ok(source.includes("if (!mentionedParticipant?.participantId) {"));
    assert.ok(source.includes('await sendFailureMessage(event, `请使用 ${manualCommand} @某人 来手动分析人物档案`);'));
    assert.ok(source.includes('const speakerIdentity = buildSpeakerIdentity(event, mentionedParticipant);'));
    assert.ok(source.includes('user_id: speakerIdentity.participantId'));
    assert.ok(source.includes("triggeredBy: 'admin_command'"));
    assert.ok(source.includes('await dispatchReply(event, `已手动分析人物档案：'));
    assert.ok(source.includes('if (await handleParticipantProfileManualCommand(event, plainText)) {'));
});

test('message runtime handles admin proactive mention commands before normal trigger checks', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes("import { OneBotClient, buildMentionMessage } from './onebot.js';"));
    assert.ok(source.includes('function extractTextAfterMentionCommand(event, command, mentionedParticipantId) {'));
    assert.ok(source.includes('async function generateAdminMentionReply(event, mentionedParticipant, promptText) {'));
    assert.ok(source.includes('async function handleAdminMentionCommand(event, plainText) {'));
    assert.ok(source.includes("const mentionCommand = (commandConfig.command || '/at').trim();"));
    assert.ok(source.includes("await sendFailureMessage(event, '主动 @ 仅支持群聊使用');"));
    assert.ok(source.includes("await sendFailureMessage(event, '不支持向 @全体成员 主动发送消息');"));
    assert.ok(source.includes('await sendFailureMessage(event, `请使用 ${mentionCommand} @某人 让 AI 生成的内容要求`);'));
    assert.ok(source.includes('await sendFailureMessage(event, `请在 ${mentionCommand} @某人 后填写让 AI 生成的内容要求`);'));
    assert.ok(source.includes("import { buildAIToolContext,"));
    assert.ok(source.includes('appendMentionTaskToPromptMessages'));
    assert.ok(source.includes('generateMentionTextFromPrompt'));
    assert.ok(source.includes('const messageText = await generateAdminMentionReply(event, mentionedParticipant, promptText);'));
    assert.ok(source.includes("throw new Error('AI 未生成可发送内容');"));
    assert.ok(source.includes("await sendFailureMessage(event, `主动 @ 生成失败: ${error.message}`);"));
    assert.ok(source.includes('await bot.sendGroupMessage(event.group_id, buildMentionMessage(mentionedParticipant.participantId, messageText));'));
    assert.ok(source.includes('if (await handleAdminMentionCommand(event, plainText)) {'));
});

test('message dispatch adds configurable CQ mention and skips quote reply for split group replies', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const dispatcherSource = fs.readFileSync(new URL('../src/reply-dispatcher.js', import.meta.url), 'utf8');
    assert.ok(source.includes('dispatchReplyWithDeps(event, processedReply, options'));
    assert.ok(dispatcherSource.includes('function buildGroupMentionPrefix(userId) {'));
    assert.ok(dispatcherSource.includes('return `[CQ:at,qq=${String(userId)}] `;'));
    assert.ok(dispatcherSource.includes("const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;"));
    assert.ok(dispatcherSource.includes("const mentionPrefix = event.message_type === 'group' && mentionSenderOnReply ? buildGroupMentionPrefix(event.user_id) : '';"));
    assert.ok(dispatcherSource.includes("const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;"));
    assert.ok(dispatcherSource.includes("if (quoteReplyEnabled && event.message_id) {"));
    assert.ok(dispatcherSource.includes('const segments = ['));
    assert.ok(dispatcherSource.includes("{ type: 'reply', data: { id: String(event.message_id) } },"));
    assert.ok(dispatcherSource.includes("{ type: 'at', data: { qq: String(event.user_id) } },"));
    assert.ok(dispatcherSource.includes("await bot.sendGroupMessage(event.group_id, message);"));
});

test('admin UI exposes mention sender reply toggle in config hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-chat-mention-sender"'));
    assert.ok(html.includes("document.getElementById('config-chat-mention-sender').checked = currentConfig.chat?.mentionSenderOnReply !== false;"));
    assert.ok(html.includes("mentionSenderOnReply: document.getElementById('config-chat-mention-sender').checked"));
});

test('admin UI exposes log retention config hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-server-log-retention-days"'));
    assert.ok(html.includes('id="config-server-log-cleanup-interval-minutes"'));
    assert.ok(html.includes("document.getElementById('config-server-log-retention-days').value = currentConfig.server?.logRetentionDays ?? 14;"));
    assert.ok(html.includes("document.getElementById('config-server-log-cleanup-interval-minutes').value = Math.max(1, Math.round((currentConfig.server?.logCleanupIntervalMs ?? 3600000) / 60000));"));
    assert.ok(html.includes('logRetentionDays: (() => {'));
    assert.ok(html.includes('logCleanupIntervalMs: (() => {'));
    assert.ok(html.includes('日志保留天数必须是大于等于 0 的数字'));
    assert.ok(html.includes('日志清理检查间隔必须在 1 到 1440 分钟之间'));
});

test('admin UI includes variable management tab and panel hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('data-panel="variables"'));
    assert.ok(html.includes('id="variable-list"'));
    assert.ok(html.includes('id="variable-detail"'));
    assert.ok(html.includes('loadVariables()'));
});

test('admin UI exposes proactive mention test controls', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="dashboard-test-group"') || html.includes('id="mention-group-id"'));
    assert.ok(html.includes('sendDashboardTest()') || html.includes('testMention()'));
    assert.ok(html.includes("fetch('/api/test/ai', {") || html.includes("fetchJsonSafe('/api/test/mention', {"));
});

