import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

import { SessionManager } from '../src/session.js';
import { setupRoutes } from '../src/routes.js';

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

async function startTestServer(sessionManager) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { authenticated: true };
        next();
    });

    const config = {
        auth: { enabled: false },
        chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist' },
        memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
        ai: {},
        regex: { rules: [] },
        preset: {},
        bindings: { global: { regexRules: [] }, characters: {} }
    };

    setupRoutes(app, config, () => {}, {
        characterManager: {
            listCharacters() { return []; },
            getCurrentCharacter() { return null; },
            extractSillyTavernMetadata() { return { metadata: null }; }
        },
        worldBookManager: { scanWorldBooks: async () => {}, readWorldBook() { return null; } },
        sessionManager,
        regexProcessor: { updateConfig() {} },
        aiClient: { updateConfig() {} },
        promptBuilder: { updateConfig() {} },
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        bot: {},
        ttsManager: {},
        VOICE_TYPES: {},
        runtime: { updateConfig() {} },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: (value) => value,
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {}
    });

    return await new Promise((resolve) => {
        const server = app.listen(0, () => {
            const { port } = server.address();
            resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
        });
    });
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

test('admin UI includes participant profile tab and panel hooks', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('data-panel="participant-profiles"'));
    assert.ok(html.includes('id="participant-profile-list"'));
    assert.ok(html.includes('id="participant-profile-detail"'));
    assert.ok(html.includes('loadParticipantProfiles()'));
});
