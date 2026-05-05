import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { setupRoutes } from '../src/routes.js';

function createManagers(config, onSave) {
    return {
        characterManager: {
            getCurrentCharacter() {
                return null;
            },
            extractSillyTavernMetadata() {
                return { metadata: null };
            },
            readFromPng() {
                return { name: '角色A' };
            },
            loadCharacter() {
                return { name: '角色A' };
            }
        },
        worldBookManager: {
            getCurrentWorldBook() {
                return null;
            }
        },
        sessionManager: {
            getDbPath() {
                return './data/chats/memory-store.sqlite';
            },
            listSessions() {
                return [];
            },
            getStats() {
                return {};
            },
            setConfig() {}
        },
        regexProcessor: {
            updateConfig() {},
            getRules() {
                return [];
            }
        },
        aiClient: {
            updateConfig() {}
        },
        promptBuilder: {
            updateConfig() {}
        },
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        },
        bot: null,
        ttsManager: {
            updateConfig() {}
        },
        VOICE_TYPES: {},
        runtime: {
            updateConfig() {},
            getStats() {
                return {};
            }
        },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: () => '',
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {}
    };
}

test('preset import keeps prompts array instead of flattening it away', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        chat: {},
        server: {}
    };

    let savedConfig = null;
    setupRoutes(app, config, (next) => {
        savedConfig = structuredClone(next);
    }, createManagers(config));

    const server = app.listen(0);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/preset/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Imported ST preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main content', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                ]
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.preset.prompts.length, 1);
        assert.equal(savedConfig.preset.prompts.length, 1);
        assert.equal(savedConfig.preset.prompts[0].identifier, 'main');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
