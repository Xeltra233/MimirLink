import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';

import { getDefaultGroupRepeatConfig, normalizeGroupRepeatConfig } from '../src/group-repeat.js';
import { setupRoutes } from '../src/routes.js';

let testPortOffset = 0;

async function listenTestApp(app) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 24080 + (testPortOffset++ % 2000);
        const server = await new Promise((resolve, reject) => {
            const candidate = app.listen(port, '127.0.0.1', () => resolve(candidate));
            candidate.once('error', reject);
        }).catch((error) => {
            if (error?.code === 'EADDRINUSE') return null;
            throw error;
        });
        if (server) return server;
    }
    throw new Error('No available test port');
}

function createManagers(config) {
    return {
        characterManager: { getCurrentCharacter: () => null },
        worldBookManager: { getCurrentWorldBook: () => null },
        sessionManager: {
            getDbPath: () => './data/chats/memory-store.sqlite',
            listSessions: () => [],
            getStats: () => ({}),
            setConfig() {}
        },
        regexProcessor: {
            updateConfig() {},
            getRules: () => []
        },
        aiClient: { updateConfig() {} },
        promptBuilder: { updateConfig() {} },
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        },
        bot: null,
        ttsManager: { updateConfig() {} },
        VOICE_TYPES: {},
        runtime: {
            updateConfig() {},
            getStats: () => ({})
        },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: () => '',
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {}
    };
}

test('group repeat config defaults to disabled with two-message trigger and three-minute cooldown', () => {
    assert.deepEqual(normalizeGroupRepeatConfig(), {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
    assert.deepEqual(getDefaultGroupRepeatConfig(), {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
});

test('group repeat config clamps invalid saved values without breaking old config', () => {
    assert.deepEqual(normalizeGroupRepeatConfig({
        enabled: true,
        triggerCount: 1,
        cooldownMs: 999999999
    }), {
        enabled: true,
        triggerCount: 2,
        cooldownMs: 3600000
    });

    assert.deepEqual(normalizeGroupRepeatConfig({
        enabled: 'true',
        triggerCount: '4',
        cooldownMs: '60000'
    }), {
        enabled: false,
        triggerCount: 4,
        cooldownMs: 60000
    });
});

test('example config exposes group repeat settings under chat config', async () => {
    const raw = await readFile(new URL('../config.example.json', import.meta.url), 'utf8');
    const config = JSON.parse(raw);

    assert.deepEqual(config.chat.groupRepeat, {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
});

test('/api/config reads and saves group repeat settings', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        onebot: {},
        ai: { providers: [], tools: { webSearch: {} } },
        chat: {
            accessControlMode: 'disabled',
            groupRepeat: {
                enabled: false,
                triggerCount: 2,
                cooldownMs: 180000
            }
        },
        memory: { participantProfile: {} },
        regex: { rules: [] },
        preset: { regexRules: [] },
        bindings: { global: { regexRules: [] }, characters: {} },
        imports: { presetFiles: [], regexFiles: [] },
        server: {},
        tts: {}
    };
    let savedConfig = null;

    setupRoutes(app, config, (nextConfig) => {
        savedConfig = structuredClone(nextConfig);
    }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const beforeResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
        const beforeBody = await beforeResponse.json();
        assert.equal(beforeResponse.status, 200, JSON.stringify(beforeBody));
        assert.deepEqual(beforeBody.chat.groupRepeat, {
            enabled: false,
            triggerCount: 2,
            cooldownMs: 180000
        });

        const saveResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat: {
                    groupRepeat: {
                        enabled: true,
                        triggerCount: 2,
                        cooldownMs: 60000
                    }
                }
            })
        });
        const saveBody = await saveResponse.json();
        assert.equal(saveResponse.status, 200, JSON.stringify(saveBody));
        assert.equal(saveBody.success, true);
        assert.deepEqual(savedConfig.chat.groupRepeat, {
            enabled: true,
            triggerCount: 2,
            cooldownMs: 60000
        });

        const afterResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
        const afterBody = await afterResponse.json();
        assert.equal(afterResponse.status, 200, JSON.stringify(afterBody));
        assert.deepEqual(afterBody.chat.groupRepeat, savedConfig.chat.groupRepeat);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
