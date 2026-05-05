import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { setupRoutes } from '../src/routes.js';
import { PromptBuilder } from '../src/prompt.js';
import { RegexProcessor } from '../src/regex.js';

let testPortOffset = 0;

async function listenTestApp(app) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 22080 + (testPortOffset++ % 2000);
        const result = await new Promise((resolve, reject) => {
            const server = app.listen(port, '127.0.0.1', () => resolve(server));
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

    const server = await listenTestApp(app);
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

test('preset import returns placement-aware diagnostics that match backend support', async () => {
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

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/preset/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Imported ST preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'depth-1', name: 'Depth Prompt', role: 'system', content: 'history inject', enabled: true, injection_position: 0, injection_depth: 1, forbid_overrides: true, marker: true, system_prompt: true },
                    { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'post', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: 'prefill', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                ]
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.diagnostics.detectedFormat, 'sillytavern-prompts');
        assert.equal(body.diagnostics.totalPrompts, 4);
        assert.equal(body.diagnostics.enabledPrompts, 4);
        assert.equal(body.diagnostics.postHistoryPrompts, 2);
        assert.equal(body.diagnostics.historyInjectionPrompts, 1);
        assert.equal(body.diagnostics.markerPrompts, 1);
        assert.equal(body.diagnostics.assistantRolePrompts, 1);
        assert.equal(body.diagnostics.unsupportedPlacements, 0);
        assert.equal(body.diagnostics.unsupportedRoles, 0);
        assert.deepEqual(body.diagnostics.warnings, []);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('preset import coerces Tavern-style string prompt fields into active runtime prompts', async () => {
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

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/preset/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Imported Tavern Strings',
                prompts: [
                    { identifier: 'depth-2', name: 'Depth Prompt', role: 'system', content: 'history inject', enabled: '1', injection_position: '0', injection_depth: '2', forbid_overrides: 'true', marker: '1', system_prompt: 'true' },
                    { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'post', enabled: '1', injection_position: '1', injection_depth: '0', forbid_overrides: 'false', marker: '0', system_prompt: 'true' },
                    { identifier: 'disabled', name: 'Disabled Prompt', role: 'system', content: 'disabled', enabled: 'false', injection_position: '0', injection_depth: '0', forbid_overrides: 'false', marker: '0', system_prompt: 'true' }
                ]
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.preset.prompts[0].enabled, true);
        assert.equal(body.preset.prompts[0].injection_depth, 2);
        assert.equal(body.preset.prompts[0].forbid_overrides, true);
        assert.equal(body.preset.prompts[0].marker, true);
        assert.equal(body.preset.prompts[0].system_prompt, true);
        assert.equal(body.preset.prompts[1].injection_position, 1);
        assert.equal(body.preset.prompts[2].enabled, false);
        assert.equal(savedConfig.preset.prompts[0].injection_depth, 2);
        assert.equal(savedConfig.preset.prompts[0].forbid_overrides, true);
        assert.equal(savedConfig.preset.prompts[0].marker, true);
        assert.equal(savedConfig.preset.prompts[0].system_prompt, true);
        assert.equal(savedConfig.preset.prompts[2].enabled, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('tts config update keeps stored api key when client sends mask placeholder', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        chat: {},
        server: {},
        tts: {
            enabled: true,
            provider: 'minimax',
            apiKey: 'real-secret-key',
            modelId: 'speech-2.5-hd',
            voiceId: 'male-qn-badao'
        }
    };

    let savedConfig = null;
    const managers = createManagers(config);
    managers.ttsManager = {
        getConfig() {
            return { ...config.tts };
        },
        updateConfig(next) {
            config.tts = { ...config.tts, ...next };
        }
    };

    setupRoutes(app, config, (next) => {
        savedConfig = structuredClone(next);
    }, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tts/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                provider: 'minimax',
                apiKey: '******',
                modelId: 'speech-2.5-hd',
                voiceId: 'male-qn-badao'
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.success, true);
        assert.equal(savedConfig.tts.apiKey, 'real-secret-key');
        assert.equal(config.tts.apiKey, 'real-secret-key');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('tts config update keeps stored api key when client omits api key field', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        chat: {},
        server: {},
        tts: {
            enabled: true,
            provider: 'minimax',
            apiKey: 'real-secret-key',
            modelId: 'speech-2.5-hd',
            voiceId: 'male-qn-badao'
        }
    };

    let savedConfig = null;
    const managers = createManagers(config);
    managers.ttsManager = {
        getConfig() {
            return { ...config.tts };
        },
        updateConfig(next) {
            config.tts = { ...config.tts, ...next };
        }
    };

    setupRoutes(app, config, (next) => {
        savedConfig = structuredClone(next);
    }, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/tts/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                provider: 'minimax',
                modelId: 'speech-2.5-hd',
                voiceId: 'male-qn-badao'
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200);
        assert.equal(body.success, true);
        assert.equal(savedConfig.tts.apiKey, 'real-secret-key');
        assert.equal(config.tts.apiKey, 'real-secret-key');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('character metadata import plan detects preferred preset prompt fields', async () => {
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

    const managers = createManagers(config);
    managers.characterManager.extractSillyTavernMetadata = () => ({
        metadata: {
            name: '角色A',
            preferredPreset: {
                name: 'Card Preset',
                systemPrompt: '卡片系统提示',
                postHistoryInstructions: '卡片历史后提示'
            },
            regexScripts: []
        }
    });

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/characters/test.png/detail`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.importPlan.importPreset, true);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('character metadata summary reflects preferred preset prompt fields', async () => {
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

    const managers = createManagers(config);
    managers.characterManager.extractSillyTavernMetadata = () => ({
        metadata: {
            name: '角色A',
            preferredPreset: {
                systemPrompt: '卡片系统提示',
                postHistoryInstructions: '卡片历史后提示'
            },
            regexScripts: []
        }
    });

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/characters/test.png/detail`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.metadataSummary.hasSystemPrompt, true);
        assert.equal(body.metadataSummary.hasPostHistoryInstructions, true);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('character metadata select imports preferred preset prompt fields', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: { rules: [] },
        bindings: { global: { regexRules: [] }, characters: {} },
        chat: {},
        server: {}
    };

    let savedConfig = null;
    const managers = createManagers(config);
    managers.characterManager.extractSillyTavernMetadata = () => ({
        metadata: {
            name: '角色A',
            preferredPreset: {
                name: 'Card Preset',
                systemPrompt: '卡片系统提示',
                postHistoryInstructions: '卡片历史后提示',
                assistantPrefill: '卡片助手预填充'
            },
            regexScripts: []
        }
    });

    setupRoutes(app, config, (next) => {
        savedConfig = structuredClone(next);
    }, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/characters/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                filename: 'test.png',
                importOptions: { importPreset: true, importWorldBook: false, importRegex: false }
            })
        });
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.importPlan.importPreset, true);
        assert.equal(body.appliedActions.includes('已自动同步角色卡中的预设相关字段'), true);
        assert.equal(savedConfig.bindings.characters.test.importedFromCard.preset.prompts.find((item) => item.identifier === 'main')?.content, '卡片系统提示');
        assert.equal(savedConfig.bindings.characters.test.importedFromCard.preset.prompts.find((item) => item.identifier === 'post-history')?.content, '卡片历史后提示');
        assert.equal(savedConfig.bindings.characters.test.importedFromCard.preset.prompts.find((item) => item.identifier === 'assistant-prefill')?.content, '卡片助手预填充');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('character metadata import plan treats numeric Tavern regex placement as backend-compatible', async () => {
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

    const managers = createManagers(config);
    managers.characterManager.extractSillyTavernMetadata = () => ({
        metadata: {
            name: '角色A',
            regexScripts: [
                { scriptName: 'Prompt Placement Rule', findRegex: 'foo', replaceString: 'bar', placement: 1 },
                { scriptName: 'Output Placement Rule', findRegex: 'baz', replaceString: 'qux', placement: 2 },
                { scriptName: 'Markdown Rule', findRegex: 'zip', replaceString: 'zap', placement: 2, markdownOnly: true }
            ],
            preferredPreset: {}
        }
    });

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/characters/test.png/detail`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.metadataSummary.regexScriptCount, 3);
        assert.equal(body.metadataSummary.importableRegexScriptCount, 2);
        assert.equal(body.importPlan.importRegex, true);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('preset import keeps character preset regex active in merged runtime binding', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {
            enabled: true,
            name: 'Legacy Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'legacy main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [{ id: 'legacy-preset-rule' }]
        },
        regex: {
            rules: [{ id: 'legacy-global-rule' }]
        },
        bindings: {
            global: {
                preset: {
                    enabled: true,
                    name: 'Global Preset',
                    prompts: [
                        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'global main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                    ],
                    regexRules: [{ id: 'global-preset-rule' }]
                },
                regexRules: [{ id: 'global-rule' }],
                worldbook: null,
                memoryDbPath: null
            },
            characters: {
                '角色A': {
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'character main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                        ],
                        regexRules: [{ id: 'character-preset-rule' }]
                    },
                    regexRules: [{ id: 'character-rule' }],
                    importedFromCard: {
                        worldbook: null,
                        preset: null,
                        regexRules: [{ id: 'card-rule' }]
                    },
                    memoryDbPath: null
                }
            }
        },
        chat: { defaultCharacter: '角色A' },
        server: {}
    };

    const managers = createManagers(config);
    const regexUpdateCalls = [];
    managers.regexProcessor = {
        updateConfig(...args) {
            regexUpdateCalls.push(args);
        },
        getRules() {
            return [];
        }
    };

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/preset/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Imported ST preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'imported main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                ],
                regex: [
                    { id: 'imported-preset-rule', name: 'Imported Preset Rule', pattern: 'a', replacement: 'b', flags: 'g' }
                ]
            })
        });

        const body = await response.json();

        assert.equal(body.success, true);
        assert.deepEqual(config.preset.regexRules, [{
            name: 'Imported Preset Rule',
            pattern: 'a',
            flags: 'g',
            replacement: 'b',
            enabled: true,
            description: '',
            stage: 'output',
            source: 'imported',
            markdownOnly: false,
            promptOnly: false,
            minDepth: null,
            maxDepth: null
        }]);
        const lastCall = regexUpdateCalls.at(-1);
        assert.ok(lastCall);
        assert.deepEqual(lastCall[1], [{ id: 'character-rule' }]);
        assert.deepEqual(lastCall[2], [{ id: 'character-preset-rule' }]);
        assert.deepEqual(lastCall[3], [{ id: 'global-rule' }]);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});



test('regex import to global layer keeps character regex active in merged runtime binding', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {
            enabled: true,
            name: 'Legacy Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'legacy main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [{ id: 'legacy-preset-rule' }]
        },
        regex: {
            rules: [{ id: 'legacy-global-rule' }]
        },
        bindings: {
            global: {
                preset: {
                    enabled: true,
                    name: 'Global Preset',
                    prompts: [
                        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'global main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                    ],
                    regexRules: [{ id: 'global-preset-rule' }]
                },
                regexRules: [{ id: 'global-rule' }],
                worldbook: null,
                memoryDbPath: null
            },
            characters: {
                '角色A': {
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'character main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                        ],
                        regexRules: [{ id: 'character-preset-rule' }]
                    },
                    regexRules: [{ id: 'character-rule' }],
                    importedFromCard: {
                        worldbook: null,
                        preset: null,
                        regexRules: [{ id: 'card-rule' }]
                    },
                    memoryDbPath: null
                }
            }
        },
        chat: { defaultCharacter: '角色A' },
        server: {}
    };

    const managers = createManagers(config);
    const regexUpdateCalls = [];
    managers.regexProcessor = {
        updateConfig(...args) {
            regexUpdateCalls.push(args);
        },
        getRules() {
            return [];
        }
    };

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/regex/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetLayer: 'global',
                rules: [
                    { name: 'Imported Global Rule', pattern: 'x', replacement: 'y', flags: 'g' }
                ]
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.targetLayer, 'global');
        assert.deepEqual(config.bindings.global.regexRules, [
            { id: 'global-rule' },
            {
                name: 'Imported Global Rule',
                pattern: 'x',
                flags: 'g',
                replacement: 'y',
                enabled: true,
                description: '',
                stage: 'output',
                source: 'imported',
                markdownOnly: false,
                promptOnly: false,
                minDepth: null,
                maxDepth: null
            }
        ]);
        const lastCall = regexUpdateCalls.at(-1);
        assert.ok(lastCall);
        assert.deepEqual(lastCall[1], [{ id: 'character-rule' }]);
        assert.deepEqual(lastCall[2], [{ id: 'character-preset-rule' }]);
        assert.deepEqual(lastCall[3], config.bindings.global.regexRules);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('regex import diagnostics describe runtime execution boundaries', async () => {
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

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/regex/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetLayer: 'global',
                rules: [
                    { name: 'Prompt Rule', pattern: 'foo', replacement: 'bar', promptOnly: true },
                    { name: 'Markdown Rule', pattern: 'baz', replacement: 'qux', markdownOnly: true },
                    { name: 'Depth Rule', pattern: 'zip', replacement: 'zap', minDepth: 2 }
                ]
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.diagnostics.promptOnlyCount, 1);
        assert.equal(body.diagnostics.markdownOnlyCount, 1);
        assert.equal(body.diagnostics.depthLimitedCount, 1);
        assert.equal(body.diagnostics.warnings.length, 2);
        assert.match(body.diagnostics.warnings[0], /markdown 渲染阶段/);
        assert.match(body.diagnostics.warnings[1], /depth=0/);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('preset import records can be deleted as a whole file and restore previous preset state', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {
            enabled: true,
            name: 'Existing Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'existing content', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [
                { name: 'Existing Preset Rule', pattern: 'keep', flags: 'g', replacement: 'stay', enabled: true, description: '', stage: 'output', source: 'custom', markdownOnly: false, promptOnly: false, minDepth: null, maxDepth: null }
            ]
        },
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        ai: {},
        memory: {},
        chat: {},
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const importResponse = await fetch(`http://127.0.0.1:${port}/api/preset/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceFilename: 'imported-preset.json',
                name: 'Imported Preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'imported content', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                ],
                regex: [
                    { name: 'Imported Preset Rule', pattern: 'from', replacement: 'file', flags: 'g' }
                ]
            })
        });
        const importBody = await importResponse.json();

        assert.equal(importResponse.status, 200, JSON.stringify(importBody));
        assert.equal(importBody.success, true);
        assert.equal(config.imports.presetFiles.length, 1);
        assert.equal(config.imports.presetFiles[0].filename, 'imported-preset.json');
        assert.equal(config.imports.regexFiles.length, 1);
        assert.equal(config.imports.regexFiles[0].sourceType, 'preset');
        assert.equal(config.imports.regexFiles[0].targetLayer, 'preset');
        assert.equal(config.imports.regexFiles[0].importedRules.length, 1);
        assert.equal(config.preset.name, 'Imported Preset');
        assert.equal(config.preset.prompts[0].content, 'imported content');
        assert.equal(importBody.importRecord.importedPreset.prompts[0].content, 'imported content');
        const configResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
        const safeConfig = await configResponse.json();
        assert.equal(safeConfig.imports.presetFiles[0].importedPreset.prompts[0].content, 'imported content');
        assert.equal(config.preset.regexRules.length, 1);
        assert.equal(config.preset.regexRules[0].name, 'Imported Preset Rule');

        const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/preset/imports/${encodeURIComponent(importBody.importRecord.id)}`, {
            method: 'DELETE'
        });
        const deleteBody = await deleteResponse.json();

        assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
        assert.equal(deleteBody.success, true);
        assert.equal(config.imports.presetFiles.length, 0);
        assert.equal(config.imports.regexFiles.length, 0);
        assert.equal(config.preset.name, 'Existing Preset');
        assert.equal(config.preset.prompts[0].content, 'existing content');
        assert.equal(config.preset.regexRules.length, 1);
        assert.equal(config.preset.regexRules[0].name, 'Existing Preset Rule');
        assert.equal(deleteBody.removedCount, 1);
        assert.deepEqual(deleteBody.restoredFields.sort(), ['enabled', 'name', 'prompts']);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('regex import records can be deleted as a whole file from the target layer', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: {},
        bindings: {
            global: {
                regexRules: [
                    { name: 'Existing Global Rule', pattern: 'keep', flags: 'g', replacement: 'stay', enabled: true, description: '', stage: 'output', source: 'custom', markdownOnly: false, promptOnly: false, minDepth: null, maxDepth: null }
                ]
            },
            characters: {}
        },
        chat: {},
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const importResponse = await fetch(`http://127.0.0.1:${port}/api/regex/import`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                sourceFilename: 'imported-regex.json',
                targetLayer: 'global',
                rules: [
                    { name: 'Imported Rule A', pattern: 'a', replacement: 'b', flags: 'g' },
                    { name: 'Imported Rule B', pattern: 'c', replacement: 'd', flags: 'g' }
                ]
            })
        });
        const importBody = await importResponse.json();

        assert.equal(importResponse.status, 200, JSON.stringify(importBody));
        assert.equal(importBody.success, true);
        assert.equal(importBody.importRecord.importedRules.length, 2);
        assert.equal(importBody.importRecord.importedRules[0].name, 'Imported Rule A');
        assert.equal(config.imports.regexFiles.length, 1);
        assert.equal(config.imports.regexFiles[0].filename, 'imported-regex.json');
        assert.equal(config.bindings.global.regexRules.length, 3);
        assert.deepEqual(config.bindings.global.regexRules.map((rule) => rule.name), [
            'Existing Global Rule',
            'Imported Rule A',
            'Imported Rule B'
        ]);

        const summaryResponse = await fetch(`http://127.0.0.1:${port}/api/regex?summary=1`);
        const summaryBody = await summaryResponse.json();

        assert.equal(summaryResponse.status, 200, JSON.stringify(summaryBody));
        assert.equal(summaryBody[0].importedRules.length, 2);
        assert.equal(summaryBody[0].importedRules[1].name, 'Imported Rule B');

        const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/regex/imports/${encodeURIComponent(importBody.importRecord.id)}`, {
            method: 'DELETE'
        });
        const deleteBody = await deleteResponse.json();

        assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
        assert.equal(deleteBody.success, true);
        assert.equal(config.imports.regexFiles.length, 0);
        assert.equal(config.bindings.global.regexRules.length, 1);
        assert.equal(config.bindings.global.regexRules[0].name, 'Existing Global Rule');
        assert.equal(deleteBody.removedCount, 2);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('regex processor applies prompt-only rules on input and skips markdown-only or depth-limited output rules', () => {
    const processor = new RegexProcessor({
        enabled: true,
        usePresetRules: false,
        rules: [
            { name: 'Prompt Rule', pattern: 'foo', replacement: 'bar', stage: 'output', promptOnly: true, enabled: true },
            { name: 'Markdown Rule', pattern: 'bar', replacement: 'baz', stage: 'output', markdownOnly: true, enabled: true },
            { name: 'Depth Rule', pattern: 'bar', replacement: 'deep', stage: 'output', minDepth: 1, enabled: true },
            { name: 'Output Rule', pattern: 'bar', replacement: 'done', stage: 'output', enabled: true }
        ]
    }, {
        info() {},
        debug() {},
        error() {}
    });

    assert.equal(processor.processInput('foo'), 'bar');
    assert.equal(processor.processOutput('foo'), 'foo');
    assert.equal(processor.processOutput('bar'), 'baz');
});

test('regex processor normalizes imported stage aliases to backend runtime stages', () => {
    const inputRule = RegexProcessor.normalizeImportedRule({
        name: 'Input Alias',
        pattern: 'a',
        replacement: 'b',
        stage: 'before_generation'
    });
    const outputRule = RegexProcessor.normalizeImportedRule({
        name: 'Output Alias',
        pattern: 'a',
        replacement: 'b',
        stage: 'assistant_output'
    });

    assert.equal(inputRule.stage, 'input');
    assert.equal(outputRule.stage, 'output');
});

test('regex processor keeps imported runtime metadata when listing rules', () => {
    const processor = new RegexProcessor({
        enabled: true,
        usePresetRules: false,
        rules: [
            {
                name: 'Imported Rule',
                pattern: 'foo',
                replacement: 'bar',
                stage: 'before_generation',
                promptOnly: true,
                markdownOnly: true,
                runOnEdit: true,
                minDepth: 1,
                maxDepth: 3,
                source: 'imported',
                enabled: true
            }
        ]
    }, {
        info() {},
        debug() {},
        error() {}
    });

    assert.deepEqual(processor.getRules(), [{
        name: 'Imported Rule',
        pattern: 'foo',
        flags: 'g',
        replacement: 'bar',
        enabled: true,
        description: '',
        stage: 'input',
        source: 'imported',
        markdownOnly: true,
        promptOnly: true,
        minDepth: 1,
        maxDepth: 3
    }]);
});

test('regex export preserves Tavern runtime metadata', () => {
    const payload = RegexProcessor.exportRules([
        {
            name: 'Prompt Rule',
            pattern: 'foo',
            replacement: 'bar',
            stage: 'output',
            promptOnly: true,
            markdownOnly: true,
            runOnEdit: true,
            minDepth: 1,
            maxDepth: 2,
            enabled: true
        },
        {
            name: 'Output Rule',
            pattern: 'baz',
            replacement: 'qux',
            stage: 'output',
            promptOnly: false,
            markdownOnly: false,
            enabled: false
        }
    ], 'sillytavern');

    assert.equal(payload.version, 1);
    assert.equal(payload.type, 'regex');
    assert.deepEqual(payload.rules, [
        {
            scriptName: 'Prompt Rule',
            findRegex: 'foo',
            replaceString: 'bar',
            trimStrings: [],
            placement: 1,
            disabled: false,
            markdownOnly: true,
            promptOnly: true,
            runOnEdit: true,
            minDepth: 1,
            maxDepth: 2
        },
        {
            scriptName: 'Output Rule',
            findRegex: 'baz',
            replaceString: 'qux',
            trimStrings: [],
            placement: 2,
            disabled: true,
            markdownOnly: false,
            promptOnly: false,
            runOnEdit: false,
            minDepth: null,
            maxDepth: null
        }
    ]);
});

test('runtime prompt preview resolves worldbook from effective binding', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {
            enabled: true,
            name: 'Global Default',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '全局主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ]
        },
        regex: {},
        bindings: {
            global: { worldbook: 'global-world.json', preset: null, regexRules: [], memoryDbPath: null },
            characters: {}
        },
        chat: {},
        server: {}
    };

    const managers = createManagers(config);
    managers.characterManager.readFromPng = () => ({
        name: '角色A',
        description: '角色描述',
        personality: '冷静',
        scenario: '测试场景',
        system_prompt: '角色系统提示',
        first_mes: '开场白'
    });
    managers.worldBookManager.readWorldBook = (name) => ({
        name,
        entries: [{ content: '世界书条目A' }]
    });
    managers.worldBookManager.matchEntries = (worldBook) => worldBook?.entries || [];
    managers.promptBuilder = new PromptBuilder(managers.characterManager, managers.worldBookManager, config);

    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime/prompt-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                characterName: '角色A',
                userMessage: '你好',
                userId: '123456',
                messageType: 'private',
                context: {
                    recentMessages: [],
                    summaries: []
                }
            })
        });

        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(Array.isArray(body.sources), true);
        assert.equal(Array.isArray(body.messages), true);
        assert.equal(body.effectiveBinding.worldbook, 'global-world.json');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('runtime prompt preview rejects requests without user id', async () => {
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

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime/prompt-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                characterName: '角色A',
                userMessage: '你好',
                messageType: 'private',
                context: {
                    recentMessages: [],
                    summaries: []
                }
            })
        });

        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, '请提供用户 QQ，用于匹配访问控制名单');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('runtime prompt preview rejects group requests without group id', async () => {
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

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime/prompt-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                characterName: '角色A',
                userMessage: '你好',
                userId: '123456',
                messageType: 'group',
                context: {
                    recentMessages: [],
                    summaries: []
                }
            })
        });

        const body = await response.json();

        assert.equal(response.status, 400);
        assert.equal(body.error, '群聊预览必须提供群号');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('runtime prompt preview respects access control allowlist', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: {},
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        chat: {
            accessControlMode: 'allowlist',
            allowedUsers: ['10001'],
            allowedGroups: ['20002']
        },
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/runtime/prompt-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                characterName: '角色A',
                userMessage: '你好',
                userId: '99999',
                messageType: 'private',
                context: {
                    recentMessages: [],
                    summaries: []
                }
            })
        });

        const body = await response.json();

        assert.equal(response.status, 403);
        assert.equal(body.error, '该用户或群聊不在当前访问控制允许范围内，无法预览');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
