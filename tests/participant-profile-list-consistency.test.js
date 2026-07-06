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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-profile-list-'));
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
        chat: {
            dataDir: './data',
            defaultCharacter: '角色A',
            sessionMode: 'user_persistent',
            accessControlMode: 'allowlist',
            allowedGroups: ['123456']
        },
        memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
        ai: {},
        regex: { rules: [] },
        preset: {},
        bindings: { global: { regexRules: [] }, characters: {} }
    };

    const characterManager = options.characterManager || {
            listCharacters() { return []; },
            scanCharacters() { return []; },
            loadCharacter(name) { return { name }; },
            readFromPng(name) { return { name }; },
            extractSillyTavernMetadata() { return { metadata: null }; },
            getCurrentCharacter() { return null; },
        };

    setupRoutes(app, config, options.saveConfig || (() => {}), {
        characterManager,
        worldBookManager: {
            scanWorldBooks: async () => {},
            readWorldBook() { return null; },
            getCurrentWorldBook() { return null; }
        },
        sessionManager,
        regexProcessor: { updateConfig() {} },
        aiClient: { updateConfig() {} },
        promptBuilder: { updateConfig() {} },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        bot: { isConnected() { return false; } },
        ttsManager: {},
        VOICE_TYPES: {},
        runtime: { updateConfig() {} },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: (value) => value,
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {},
        getParticipantProfileProgress: () => ({ running: false, stage: 'idle', savedCount: sessionManager.countParticipantProfiles(), tasks: [] }),
        getKnowledgeImportProgress: () => null,
        getDashboardMetricsSnapshot: () => ({ composition: sessionManager.getDashboardCompositionStats() }),
        getLlmEnabled: () => true,
        setLlmEnabled: () => true
    });

    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 19080 + (testPortOffset++ % 2000);
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

    throw new Error('无法启动测试服务');
}

function seedProfiles(manager) {
    const namespace = { scopeType: 'global_shared', scopeKey: 'global_shared_memory', characterName: '角色A', presetName: '预设A' };
    manager.upsertParticipantProfile(namespace, {
        participantId: '10001',
        title: '霜晨月',
        content: '稳定画像: 冷静，偏观察。',
        tags: ['profile'],
        metadata: { participantId: '10001', participantName: '霜晨月', source: 'participant_profile' }
    });
    manager.upsertParticipantProfile(namespace, {
        participantId: '10002',
        title: '炸天帮-轰地舵-Even',
        content: '稳定画像: 话题推进积极。',
        tags: ['profile'],
        metadata: { participantId: '10002', participantName: '炸天帮-轰地舵-Even', source: 'participant_profile' }
    });
    manager.addMemoryEntry(namespace, {
        entryType: 'conversation',
        title: '普通记忆',
        content: '这不是人物档案',
        tags: [],
        metadata: { source: 'conversation' }
    });
}

test('participant profile count and search use actual saved profile entries', () => {
    const { manager } = createTempManager();
    try {
        seedProfiles(manager);

        assert.equal(manager.countParticipantProfiles(), 2);
        assert.equal(manager.countParticipantProfiles({ search: 'Even' }), 1);
        assert.equal(manager.countParticipantProfiles({ search: '10001' }), 1);

        const searched = manager.listParticipantProfiles({ search: 'Even', limit: 10 });
        assert.equal(searched.length, 1);
        assert.equal(searched[0].participantName, '炸天帮-轰地舵-Even');
    } finally {
        manager.close();
    }
});

test('participant profile API returns total, filtered list, and detail payload', async () => {
    const { manager } = createTempManager();
    try {
        seedProfiles(manager);
        const { server, baseUrl } = await startTestServer(manager);
        try {
            const listRes = await fetch(`${baseUrl}/api/participant-profiles?search=${encodeURIComponent('Even')}`);
            const listData = await listRes.json();

            assert.equal(listRes.status, 200);
            assert.equal(listData.success, true);
            assert.equal(listData.total, 2);
            assert.equal(listData.filteredTotal, 1);
            assert.equal(listData.items.length, 1);
            assert.equal(listData.items[0].participantName, '炸天帮-轰地舵-Even');

            const detailRes = await fetch(`${baseUrl}/api/participant-profiles/${encodeURIComponent(listData.items[0].id)}`);
            const detailData = await detailRes.json();
            assert.equal(detailRes.status, 200);
            assert.equal(detailData.item.participantId, '10002');
            assert.ok(detailData.item.content.includes('话题推进'));
        } finally {
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    } finally {
        manager.close();
    }
});

test('task center saved count is wired to persisted participant profile count', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

    assert.ok(source.includes('function getParticipantProfileSavedCount() {'));
    assert.ok(source.includes('return sessionManager.countParticipantProfiles();'));
    assert.ok(source.includes('participantProfileProgress.savedCount = getParticipantProfileSavedCount();'));
    assert.ok(source.includes('savedCount: getParticipantProfileSavedCount(),'));
    assert.ok(source.includes("const skippedMessage = source.existing"));
    assert.ok(source.includes("尚未生成档案"));
});

test('character card delete keeps database binding and same-name import reuses it', async () => {
    const { manager, tempDir } = createTempManager();
    const dataDir = path.join(tempDir, 'data');
    const characterDir = path.join(dataDir, 'characters');
    fs.mkdirSync(characterDir, { recursive: true });
    fs.writeFileSync(path.join(characterDir, '角色A.png'), 'mock-card');

    const dedicatedDbPath = './data/chats/characters/角色A.sqlite';
    const config = {
        auth: { enabled: false },
        chat: {
            dataDir,
            defaultCharacter: '角色A',
            sessionMode: 'user_persistent',
            accessControlMode: 'allowlist',
            allowedGroups: ['123456']
        },
        memory: { storage: { path: path.join(dataDir, 'chats', 'memory-store.sqlite') }, summary: { enabled: false } },
        ai: {},
        regex: { rules: [] },
        preset: {},
        bindings: {
            global: { regexRules: [], memoryDbPath: null },
            characters: {
                '角色A': {
                    memoryDbPath: dedicatedDbPath,
                    worldbook: null,
                    preset: null,
                    regexRules: null,
                    importedFromCard: { worldbook: null, preset: null, regexRules: [] }
                }
            }
        }
    };
    const characterManager = {
        listCharacters() { return ['角色A']; },
        scanCharacters() { return ['角色A']; },
        loadCharacter(name) { return { name }; },
        readFromPng(name) { return { name }; },
        extractSillyTavernMetadata() { return { metadata: { name: '角色A' } }; },
        getCurrentCharacter() { return null; }
    };

    const { server, baseUrl } = await startTestServer(manager, { config, characterManager });
    try {
        const deleteRes = await fetch(`${baseUrl}/api/characters/${encodeURIComponent('角色A.png')}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deleteMemoryDb: false, migrateMemoryToDefault: false })
        });
        const deleteData = await deleteRes.json();
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteData.success, true);
        assert.equal(config.bindings.characters['角色A'].memoryDbPath, dedicatedDbPath);

        fs.writeFileSync(path.join(characterDir, '角色A.png'), 'mock-card-upgraded');
        const selectRes = await fetch(`${baseUrl}/api/characters/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: '角色A.png',
                importOptions: {},
                memoryBinding: { mode: 'character', reuseExisting: true }
            })
        });
        const selectData = await selectRes.json();
        assert.equal(selectRes.status, 200);
        assert.equal(selectData.success, true);
        assert.equal(config.bindings.characters['角色A'].memoryDbPath, dedicatedDbPath);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        manager.close();
    }
});

test('admin UI can search and select participant profile details', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    assert.ok(html.includes('id="participant-profile-search"'));
    assert.ok(html.includes('onParticipantProfileSearchInput()'));
    assert.ok(html.includes("params.set('search', participantProfileSearchKeyword);"));
    assert.ok(html.includes('participantProfileFilteredTotal'));
    assert.ok(html.includes('没有匹配的人物档案'));
    assert.ok(html.includes('getParticipantProfileEmptyStateText()'));
    assert.ok(html.includes('最近建档失败'));
    assert.ok(html.includes('请检查是否切到了其他角色专属数据库'));
    assert.ok(html.includes('复用同名角色专属数据库'));
    assert.ok(html.includes("reuseExisting: selectedMode === 'character'"));
    assert.ok(html.includes("data.appliedActions.join('、')"));
    assert.ok(html.includes('角色已选择'));
    assert.equal(html.includes("{data.appliedActions.join('')}"), false);
    assert.equal(html.includes('角色已择'), false);
    assert.ok(html.includes('正在加载详情...'));
    assert.ok(html.includes('renderParticipantProfileDetail(data.item || null);'));
});
