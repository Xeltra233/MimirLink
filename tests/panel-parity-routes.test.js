import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { setupRoutes } from '../src/routes.js';

async function listenTestApp(app) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => resolve(server));
        server.once('error', reject);
    });
}

function createBaseManagers(overrides = {}) {
    const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
    return {
        characterManager: { listCharacters() { return []; }, getCurrentCharacter() { return null; }, extractSillyTavernMetadata() { return { metadata: null }; } },
        worldBookManager: { scanWorldBooks: async () => {}, readWorldBook() { return null; }, getCurrentWorldBook() { return null; } },
        sessionManager: { getDbPath: () => './data/chats/memory-store.sqlite', listSessions: () => [], listParticipantProfiles: () => [], getParticipantProfile: () => null, getStats: () => ({}) },
        regexProcessor: { updateConfig() {} },
        aiClient: { updateConfig() {}, getVisibleResponseContent: (result) => result?.content || result?.text || '' },
        promptBuilder: { updateConfig() {} },
        logger: silentLogger,
        bot: { isConnected() { return false; } },
        ttsManager: {},
        VOICE_TYPES: {},
        runtime: { updateConfig() {} },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: (value) => value,
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        getLlmEnabled: () => true,
        setLlmEnabled: (value) => value,
        clearParticipantProfileTimers: () => {},
        ...overrides
    };
}

test('POST /api/ai/probe 探测 AI 供应商连通性', async () => {
    const app = express();
    app.use(express.json());

    let receivedMessages = null;
    let receivedOverrides = null;
    const fakeAiClient = {
        updateConfig() {},
        async chat(messages, overrides) {
            receivedMessages = messages;
            receivedOverrides = overrides;
            return {
                choices: [{ message: { content: '连通正常' } }]
            };
        },
        getVisibleResponseContent(res) {
            return res?.choices?.[0]?.message?.content || '';
        }
    };

    const config = {
        auth: { enabled: false },
        ai: {
            baseUrl: 'https://api.default.example/v1',
            apiKey: 'saved-key',
            model: 'default-model'
        }
    };

    const managers = createBaseManagers({ aiClient: fakeAiClient });
    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/ai/probe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                providerId: 'custom-p1',
                baseUrl: 'https://api.custom.example/v1',
                apiKey: 'custom-key',
                model: 'custom-model'
            })
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.reply, '连通正常');
        assert.equal(data.provider, 'custom-p1');
        assert.equal(data.model, 'custom-model');
        assert.equal(receivedOverrides.baseUrl, 'https://api.custom.example/v1');
        assert.equal(receivedOverrides.apiKey, 'custom-key');
        assert.equal(receivedOverrides.model, 'custom-model');
        assert.deepEqual(receivedMessages, [{ role: 'user', content: 'hi' }]);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('DELETE /api/sessions 批量清理空会话', async () => {
    const app = express();
    app.use(express.json());

    const sessions = [
        { id: 'empty-1', messageCount: 0 },
        { id: 'active-1', messageCount: 5 },
        { id: 'empty-2', messageCount: 0 }
    ];
    const deleted = [];

    const fakeSessionManager = {
        listSessions: () => sessions,
        deleteSession: (id) => {
            deleted.push(id);
        },
        getDbPath: () => './data/chats/memory-store.sqlite',
        listParticipantProfiles: () => [],
        getParticipantProfile: () => null,
        getStats: () => ({})
    };

    const config = { auth: { enabled: false } };
    const managers = createBaseManagers({ sessionManager: fakeSessionManager });
    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
            method: 'DELETE'
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.deletedCount, 2);
        assert.deepEqual(deleted, ['empty-1', 'empty-2']);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
