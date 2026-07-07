import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buffer } from 'node:stream/consumers';

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

async function buildLegacyConfigBackup(configJson) {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-legacy-backup-'));
    try {
        await mkdir(join(tmpRoot, 'data'), { recursive: true });
        await writeFile(join(tmpRoot, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');

        const { pack } = await import('tar-fs');
        const { createGzip } = await import('node:zlib');
        return Buffer.from(await buffer(pack(tmpRoot).pipe(createGzip())));
    } finally {
        await rm(tmpRoot, { recursive: true, force: true });
    }
}

async function buildBackupWithFiles({ configJson = null, files = {} } = {}) {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-backup-files-'));
    try {
        if (configJson) {
            await writeFile(join(tmpRoot, 'config.json'), JSON.stringify(configJson, null, 2), 'utf8');
        }
        for (const [relativePath, content] of Object.entries(files)) {
            const target = join(tmpRoot, ...relativePath.split('/'));
            await mkdir(join(target, '..'), { recursive: true });
            await writeFile(target, content);
        }

        const { pack } = await import('tar-fs');
        const { createGzip } = await import('node:zlib');
        return Buffer.from(await buffer(pack(tmpRoot).pipe(createGzip())));
    } finally {
        await rm(tmpRoot, { recursive: true, force: true });
    }
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

test('regex CRUD endpoints operate on selected character layer', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: { regexRules: [{ name: 'Preset Rule', pattern: 'preset', flags: 'g', replacement: '', stage: 'output' }] },
        regex: {},
        bindings: {
            global: { regexRules: [{ name: 'Global Rule', pattern: 'global', flags: 'g', replacement: '', stage: 'output' }] },
            characters: {
                '角色A': {
                    regexRules: [{ name: 'Character Rule', pattern: 'old', flags: 'g', replacement: '', stage: 'output' }]
                }
            }
        },
        chat: { defaultCharacter: '角色A' },
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const listResponse = await fetch(`http://127.0.0.1:${port}/api/regex?targetLayer=character`);
        const listBody = await listResponse.json();

        assert.equal(listResponse.status, 200, JSON.stringify(listBody));
        assert.deepEqual(listBody.map((rule) => rule.name), ['Character Rule']);

        const addResponse = await fetch(`http://127.0.0.1:${port}/api/regex`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetLayer: 'character', name: 'Character Added', pattern: 'add', flags: 'g', replacement: '', stage: 'output' })
        });
        const addBody = await addResponse.json();

        assert.equal(addResponse.status, 200, JSON.stringify(addBody));
        assert.equal(config.bindings.characters['角色A'].regexRules.length, 2);
        assert.equal(config.bindings.global.regexRules.length, 1);

        const updateResponse = await fetch(`http://127.0.0.1:${port}/api/regex/1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetLayer: 'character', name: 'Character Updated', pattern: 'updated', flags: 'gi', replacement: 'x', stage: 'input' })
        });
        const updateBody = await updateResponse.json();

        assert.equal(updateResponse.status, 200, JSON.stringify(updateBody));
        assert.equal(config.bindings.characters['角色A'].regexRules[1].name, 'Character Updated');
        assert.equal(config.bindings.characters['角色A'].regexRules[1].pattern, 'updated');

        const deleteResponse = await fetch(`http://127.0.0.1:${port}/api/regex/0?targetLayer=character`, { method: 'DELETE' });
        const deleteBody = await deleteResponse.json();

        assert.equal(deleteResponse.status, 200, JSON.stringify(deleteBody));
        assert.deepEqual(config.bindings.characters['角色A'].regexRules.map((rule) => rule.name), ['Character Updated']);
        assert.deepEqual(config.bindings.global.regexRules.map((rule) => rule.name), ['Global Rule']);
        assert.deepEqual(config.preset.regexRules.map((rule) => rule.name), ['Preset Rule']);
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

test('regex processor can return output trace without changing processOutput contract', () => {
    const processor = new RegexProcessor({
        enabled: true,
        rules: [
            { name: 'Replace Foo', pattern: 'foo', flags: 'g', replacement: 'bar', enabled: true, stage: 'output' },
            { name: 'Input Only', pattern: 'bar', flags: 'g', replacement: 'baz', enabled: true, stage: 'input' }
        ]
    }, { info() {}, warn() {}, error() {}, debug() {} });

    assert.equal(processor.processOutput('foo'), 'bar');
    const result = processor.processOutputWithTrace('foo');

    assert.equal(result.text, 'bar');
    assert.equal(result.trace.appliedRules[0].name, 'Replace Foo');
    assert.equal(result.trace.skippedRules.some((rule) => rule.name === 'Input Only' && rule.reason === 'stage_mismatch'), true);
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

test('config save preserves provider key but drops client-only key flags', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false, password: 'pw', sessionSecret: 'secret' },
        onebot: { url: 'ws://127.0.0.1:3001', accessToken: 'onebot-token', tokenMode: 'header' },
        ai: {
            provider: 'openai-compatible',
            baseUrl: 'https://provider.example/v1',
            apiKey: '',
            model: 'deepseek-v4-pro',
            activeProviderId: 'provider-chat',
            providers: [{
                id: 'provider-chat',
                name: '配置页供应商',
                provider: 'openai-compatible',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'deepseek-v4-pro',
                models: [{ id: 'deepseek-v4-pro', enabled: true }]
            }],
            tools: { webSearch: { apiKey: 'web-key' } }
        },
        chat: { modelProviderId: 'provider-chat', model: 'deepseek-v4-pro' },
        memory: {
            participantProfile: { apiKey: 'profile-key' },
            summary: {
                modelProviderId: 'provider-chat',
                model: 'deepseek-v4-pro',
                baseUrl: 'https://old-summary.example/v1',
                apiKey: 'old-summary-key'
            }
        },
        tts: { apiKey: 'tts-key' },
        regex: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        imports: { presetFiles: [], regexFiles: [] },
        server: {}
    };

    let savedConfig = null;
    setupRoutes(app, config, (next) => {
        savedConfig = structuredClone(next);
    }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                auth: { passwordSet: true, sessionSecretSet: true },
                onebot: { accessToken: '******', hasAccessToken: true },
                ai: {
                    activeProviderId: 'provider-chat',
                    hasApiKey: true,
                    variableParsing: {
                        providerId: 'provider-chat',
                        model: 'deepseek-v4-pro',
                        baseUrl: 'https://old-varparse.example/v1',
                        apiKey: 'old-varparse-key'
                    },
                    providers: [{
                        id: 'provider-chat',
                        name: '配置页供应商',
                        provider: 'openai-compatible',
                        baseUrl: 'https://provider.example/v1',
                        apiKey: '******',
                        hasApiKey: true,
                        model: 'deepseek-v4-pro',
                        models: [{ id: 'deepseek-v4-pro', enabled: true }]
                    }],
                    tools: { webSearch: { apiKey: '******', hasApiKey: true } }
                },
                memory: {
                    participantProfile: { apiKey: '******', hasApiKey: true },
                    summary: {
                        modelProviderId: 'provider-chat',
                        model: 'deepseek-v4-pro',
                        baseUrl: 'https://old-summary.example/v1',
                        apiKey: 'old-summary-key'
                    }
                },
                tts: { hasApiKey: true }
            })
        });
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(savedConfig.ai.providers[0].apiKey, 'provider-key');
        assert.equal(savedConfig.ai.tools.webSearch.apiKey, 'web-key');
        assert.equal(savedConfig.memory.participantProfile.apiKey, undefined);
        assert.equal(savedConfig.memory.participantProfile.baseUrl, undefined);
        assert.equal(savedConfig.ai.variableParsing.apiKey, undefined);
        assert.equal(savedConfig.ai.variableParsing.baseUrl, undefined);
        assert.equal(savedConfig.memory.summary.apiKey, undefined);
        assert.equal(savedConfig.memory.summary.baseUrl, undefined);
        assert.equal(savedConfig.memory.summary.modelProviderId, 'provider-chat');
        assert.equal(savedConfig.onebot.accessToken, 'onebot-token');
        assert.equal('hasApiKey' in savedConfig.ai, false);
        assert.equal('hasApiKey' in savedConfig.ai.providers[0], false);
        assert.equal('hasApiKey' in savedConfig.ai.tools.webSearch, false);
        assert.equal('hasAccessToken' in savedConfig.onebot, false);
        assert.equal('passwordSet' in savedConfig.auth, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('regex-only backup restores all runtime regex layers without overwriting unrelated binding data', async () => {
    const app = express();
    app.use(express.json());

    const originalRules = {
        legacy: [{ name: 'Legacy Rule', pattern: 'legacy', flags: 'g', replacement: 'L', enabled: true, stage: 'output' }],
        preset: [{ name: 'Preset Rule', pattern: 'preset', flags: 'i', replacement: 'P', enabled: false, stage: 'input' }],
        global: [{ name: 'Global Rule', pattern: 'global', flags: 'g', replacement: 'G', enabled: true, stage: 'output', promptOnly: true }],
        globalPreset: [{ name: 'Global Preset Rule', pattern: 'gp', flags: 'g', replacement: 'GP', enabled: true, stage: 'output' }],
        character: [{ name: 'Character Rule', pattern: 'char', flags: 'g', replacement: 'C', enabled: true, stage: 'output' }],
        characterPreset: [{ name: 'Character Preset Rule', pattern: 'cp', flags: 'g', replacement: 'CP', enabled: true, stage: 'output' }],
        card: [{ name: 'Card Rule', pattern: 'card', flags: 'g', replacement: 'CARD', enabled: true, stage: 'output' }]
    };

    const config = {
        auth: { enabled: false },
        preset: { name: 'Preset A', prompts: [], regexRules: structuredClone(originalRules.preset) },
        regex: { enabled: true, rules: structuredClone(originalRules.legacy) },
        imports: {
            regexFiles: [{
                id: 'regex-import-1',
                filename: 'rules.json',
                targetLayer: 'global',
                importedRules: structuredClone(originalRules.global),
                importedAt: '2026-05-23T00:00:00.000Z'
            }]
        },
        bindings: {
            global: {
                worldbook: 'world-before.json',
                preset: { name: 'Global Preset', prompts: [], regexRules: structuredClone(originalRules.globalPreset) },
                regexRules: structuredClone(originalRules.global),
                memoryDbPath: null
            },
            characters: {
                '角色A': {
                    worldbook: 'character-world-before.json',
                    preset: { name: 'Character Preset', prompts: [], regexRules: structuredClone(originalRules.characterPreset) },
                    regexRules: structuredClone(originalRules.character),
                    importedFromCard: { worldbook: null, preset: null, regexRules: structuredClone(originalRules.card) },
                    memoryDbPath: null
                }
            }
        },
        chat: { defaultCharacter: '角色A' },
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const backupResponse = await fetch(`http://127.0.0.1:${port}/api/config/backup?categories=regex`);
        const backupBody = Buffer.from(await backupResponse.arrayBuffer());
        assert.equal(backupResponse.status, 200);
        assert.ok(backupBody.length > 0);

        const inspectResponse = await fetch(`http://127.0.0.1:${port}/api/config/backup/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const inspectBody = await inspectResponse.json();
        assert.equal(inspectResponse.status, 200, JSON.stringify(inspectBody));
        assert.ok(inspectBody.categories.includes('regex'));

        config.regex = { enabled: true, rules: [{ name: 'Bad Legacy', pattern: 'bad' }] };
        config.preset.regexRules = [{ name: 'Bad Preset', pattern: 'bad' }];
        config.bindings.global.worldbook = 'world-after.json';
        config.bindings.global.regexRules = [];
        config.bindings.global.preset.regexRules = [];
        config.bindings.characters['角色A'].worldbook = 'character-world-after.json';
        config.bindings.characters['角色A'].regexRules = [];
        config.bindings.characters['角色A'].preset.regexRules = [];
        config.bindings.characters['角色A'].importedFromCard.regexRules = [];
        config.imports.regexFiles = [];

        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=regex`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.ok(restoreBody.changes.replaced.includes('正则规则快照'));
        assert.deepEqual(config.regex.rules, originalRules.legacy);
        assert.deepEqual(config.preset.regexRules, originalRules.preset);
        assert.deepEqual(config.bindings.global.regexRules, originalRules.global);
        assert.deepEqual(config.bindings.global.preset.regexRules, originalRules.globalPreset);
        assert.deepEqual(config.bindings.characters['角色A'].regexRules, originalRules.character);
        assert.deepEqual(config.bindings.characters['角色A'].preset.regexRules, originalRules.characterPreset);
        assert.deepEqual(config.bindings.characters['角色A'].importedFromCard.regexRules, originalRules.card);
        assert.equal(config.imports.regexFiles[0].filename, 'rules.json');
        assert.equal(config.bindings.global.worldbook, 'world-after.json');
        assert.equal(config.bindings.characters['角色A'].worldbook, 'character-world-after.json');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('legacy config-only regex restore honors empty arrays without overwriting unrelated binding data', async () => {
    const app = express();
    app.use(express.json());

    const legacyBackupConfig = {
        auth: { enabled: false },
        preset: { name: 'Legacy Preset', prompts: [], regexRules: [] },
        regex: { enabled: true, rules: [] },
        imports: { regexFiles: [] },
        bindings: {
            global: {
                worldbook: 'world-before.json',
                preset: { name: 'Global Preset', prompts: [], regexRules: [] },
                regexRules: [],
                memoryDbPath: './data/chats/global-before.sqlite'
            },
            characters: {
                '角色A': {
                    worldbook: 'character-world-before.json',
                    preset: { name: 'Character Preset', prompts: [], regexRules: [] },
                    regexRules: [],
                    importedFromCard: { worldbook: null, preset: null, regexRules: [] },
                    memoryDbPath: './data/chats/characters/before.sqlite'
                }
            }
        },
        chat: { defaultCharacter: '角色A', dataDir: './data/chats-from-backup' },
        server: { port: 9999 }
    };
    const backupBody = await buildLegacyConfigBackup(legacyBackupConfig);

    const config = {
        auth: { enabled: false },
        preset: { name: 'Current Preset', prompts: [], regexRules: [{ name: 'Current Preset Rule', pattern: 'preset' }] },
        regex: { enabled: true, rules: [{ name: 'Current Legacy Rule', pattern: 'legacy' }] },
        imports: { regexFiles: [{ id: 'current-import', filename: 'current.json', importedRules: [{ name: 'Import Rule' }] }] },
        bindings: {
            global: {
                worldbook: 'world-after.json',
                preset: { name: 'Current Global Preset', prompts: [], regexRules: [{ name: 'Current Global Preset Rule' }] },
                regexRules: [{ name: 'Current Global Rule' }],
                memoryDbPath: './data/chats/global-after.sqlite'
            },
            characters: {
                '角色A': {
                    worldbook: 'character-world-after.json',
                    preset: { name: 'Current Character Preset', prompts: [], regexRules: [{ name: 'Current Character Preset Rule' }] },
                    regexRules: [{ name: 'Current Character Rule' }],
                    importedFromCard: { worldbook: null, preset: null, regexRules: [{ name: 'Current Card Rule' }] },
                    memoryDbPath: './data/chats/characters/after.sqlite'
                }
            }
        },
        chat: { defaultCharacter: '角色A', dataDir: './data/chats-current' },
        server: { port: 1234 }
    };
    let saveCount = 0;
    setupRoutes(app, config, () => { saveCount += 1; }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const inspectResponse = await fetch(`http://127.0.0.1:${port}/api/config/backup/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const inspectBody = await inspectResponse.json();
        assert.equal(inspectResponse.status, 200, JSON.stringify(inspectBody));
        assert.ok(inspectBody.categories.includes('config'));
        assert.ok(inspectBody.categories.includes('regex'));

        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=regex`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.ok(restoreBody.changes.replaced.includes('正则规则快照'));
        assert.equal(saveCount, 1);

        assert.deepEqual(config.regex.rules, []);
        assert.deepEqual(config.preset.regexRules, []);
        assert.deepEqual(config.bindings.global.regexRules, []);
        assert.deepEqual(config.bindings.global.preset.regexRules, []);
        assert.deepEqual(config.bindings.characters['角色A'].regexRules, []);
        assert.deepEqual(config.bindings.characters['角色A'].preset.regexRules, []);
        assert.deepEqual(config.bindings.characters['角色A'].importedFromCard.regexRules, []);
        assert.deepEqual(config.imports.regexFiles, []);

        assert.equal(config.bindings.global.worldbook, 'world-after.json');
        assert.equal(config.bindings.global.memoryDbPath, './data/chats/global-after.sqlite');
        assert.equal(config.bindings.characters['角色A'].worldbook, 'character-world-after.json');
        assert.equal(config.bindings.characters['角色A'].memoryDbPath, './data/chats/characters/after.sqlite');
        assert.equal(config.chat.dataDir, './data/chats-current');
        assert.equal(config.server.port, 1234);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('bindings-only backup restores character bindings without overwriting model config', async () => {
    const app = express();
    app.use(express.json());

    const backupConfig = {
        auth: { enabled: false },
        ai: {
            provider: 'backup-provider',
            baseUrl: 'https://backup.example/v1',
            apiKey: 'backup-key',
            model: 'backup-model'
        },
        onebot: { url: 'ws://backup-onebot' },
        chat: { defaultCharacter: '备份角色', modelProviderId: 'backup-chat-provider', model: 'backup-chat-model' },
        bindings: {
            global: { worldbook: 'backup-global-world.json', preset: null, regexRules: [], memoryDbPath: './data/chats/backup-global.sqlite' },
            characters: {
                '备份角色': {
                    worldbook: 'backup-character-world.json',
                    preset: { name: 'Backup Character Preset' },
                    regexRules: [{ name: 'Backup Character Rule', pattern: 'backup' }],
                    memoryDbPath: './data/chats/characters/backup.sqlite'
                }
            }
        }
    };

    const backupBody = await buildBackupWithFiles({ configJson: backupConfig });

    const config = {
        auth: { enabled: false },
        ai: {
            provider: 'current-provider',
            baseUrl: 'https://current.example/v1',
            apiKey: 'current-key',
            model: 'current-model'
        },
        onebot: { url: 'ws://current-onebot' },
        chat: { defaultCharacter: '当前角色', modelProviderId: 'current-chat-provider', model: 'current-chat-model' },
        bindings: {
            global: { worldbook: 'current-global-world.json', preset: null, regexRules: [], memoryDbPath: './data/chats/current-global.sqlite' },
            characters: {
                '当前角色': {
                    worldbook: 'current-character-world.json',
                    preset: { name: 'Current Character Preset' },
                    regexRules: [{ name: 'Current Character Rule', pattern: 'current' }],
                    memoryDbPath: './data/chats/characters/current.sqlite'
                }
            }
        },
        server: { port: 23456 }
    };
    let saveCount = 0;
    setupRoutes(app, config, () => { saveCount += 1; }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const inspectResponse = await fetch(`http://127.0.0.1:${port}/api/config/backup/inspect`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const inspectBody = await inspectResponse.json();
        assert.equal(inspectResponse.status, 200, JSON.stringify(inspectBody));
        assert.ok(inspectBody.categories.includes('bindings'));

        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=bindings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.ok(restoreBody.changes.replaced.includes('绑定关系'));
        assert.ok(restoreBody.changes.replaced.includes('当前默认角色'));
        assert.equal(saveCount, 1);

        assert.equal(config.chat.defaultCharacter, '备份角色');
        assert.equal(config.bindings.global.worldbook, 'backup-global-world.json');
        assert.equal(config.bindings.characters['备份角色'].worldbook, 'backup-character-world.json');
        assert.deepEqual(config.bindings.characters['备份角色'].regexRules, [{ name: 'Backup Character Rule', pattern: 'backup' }]);

        assert.equal(config.ai.provider, 'current-provider');
        assert.equal(config.ai.baseUrl, 'https://current.example/v1');
        assert.equal(config.ai.apiKey, 'current-key');
        assert.equal(config.ai.model, 'current-model');
        assert.equal(config.chat.modelProviderId, 'current-chat-provider');
        assert.equal(config.chat.model, 'current-chat-model');
        assert.equal(config.onebot.url, 'ws://current-onebot');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('config restore preserves current runtime server binding', async () => {
    const app = express();

    const backupBody = await buildBackupWithFiles({
        configJson: {
            auth: { enabled: false },
            chat: { defaultCharacter: '备份角色' },
            server: { port: 8001, host: '0.0.0.0' },
            onebot: { url: 'ws://backup.example' }
        }
    });

    const config = {
        auth: { enabled: false },
        chat: { defaultCharacter: '当前角色' },
        server: { port: 23456, host: '127.0.0.1' },
        onebot: { url: 'ws://current.example' }
    };
    let savedConfig = null;
    setupRoutes(app, config, (next) => { savedConfig = structuredClone(next); }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.ok(restoreBody.changes.replaced.includes('config.json'));
        assert.equal(config.chat.defaultCharacter, '备份角色');
        assert.equal(config.onebot.url, 'ws://backup.example');
        assert.equal(config.server.port, 23456);
        assert.equal(config.server.host, '127.0.0.1');
        assert.equal(savedConfig.server.port, 23456);
        assert.equal(savedConfig.server.host, '127.0.0.1');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('config plus presets restore uses backup preset imports without stale target records', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-preset-restore-test-'));
    const dataDir = join(tmpRoot, 'data');
    const presetsDir = join(dataDir, 'presets');
    await mkdir(presetsDir, { recursive: true });

    const staleRecord = {
        id: 'preset-stale-target',
        type: 'preset',
        filename: 'stale.json',
        presetName: 'Stale Target Preset',
        importedPreset: { prompts: [{ identifier: 'stale', name: 'Stale', content: 'stale' }] }
    };
    const backupRecord = {
        id: 'preset-backup-main',
        type: 'preset',
        filename: 'backup.json',
        presetName: 'Backup Imported Preset',
        importedPreset: { prompts: [{ identifier: 'backup', name: 'Backup', content: 'backup' }] }
    };
    const rawRuntimePreset = {
        enabled: true,
        name: 'Backup Runtime Preset',
        prompts: [{ identifier: 'runtime', name: 'Runtime', content: 'runtime' }]
    };

    await writeFile(join(presetsDir, `${staleRecord.id}.json`), JSON.stringify(staleRecord, null, 2), 'utf8');

    const backupBody = await buildBackupWithFiles({
        configJson: {
            auth: { enabled: false },
            chat: { dataDir },
            preset: rawRuntimePreset,
            imports: { presetFiles: [backupRecord], regexFiles: [] },
            server: { port: 9999 }
        },
        files: {
            [`data/presets/${backupRecord.id}.json`]: JSON.stringify(backupRecord, null, 2),
            'data/presets/runtime.raw-preset.json': JSON.stringify(rawRuntimePreset, null, 2)
        }
    });

    const app = express();
    const config = {
        auth: { enabled: false },
        chat: { dataDir },
        preset: { name: 'Current Preset', prompts: [] },
        imports: { presetFiles: [staleRecord], regexFiles: [] },
        bindings: { global: {}, characters: {} },
        server: { port: 23456, host: '127.0.0.1' }
    };
    let savedConfig = null;
    setupRoutes(app, config, (next) => { savedConfig = structuredClone(next); }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=config,presets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.deepEqual(config.imports.presetFiles.map((item) => item.id), [backupRecord.id]);
        assert.deepEqual(savedConfig.imports.presetFiles.map((item) => item.id), [backupRecord.id]);
        assert.equal(config.preset.name, 'Backup Runtime Preset');
        assert.equal(config.server.port, 23456);
        assert.equal(existsSync(join(presetsDir, `${backupRecord.id}.json`)), true);
        assert.equal(existsSync(join(presetsDir, 'runtime.raw-preset.json')), true);
        assert.equal(existsSync(join(presetsDir, `${staleRecord.id}.json`)), false);
        assert.ok(restoreBody.changes.replaced.some((item) => item.includes('预设导入记录 (1 条)')));
        assert.ok(restoreBody.changes.replaced.some((item) => item.includes('data/presets (旧文件已归档 1 个)')));
        const archivedPresetFiles = readdirSync(join(dataDir, 'restore-backups'), { recursive: true })
            .filter((item) => String(item).endsWith(`${staleRecord.id}.json`));
        assert.equal(archivedPresetFiles.length, 1);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(tmpRoot, { recursive: true, force: true });
    }
});

test('presets-only restore rebuilds preset imports from backup files and ignores stale target files', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-preset-only-restore-test-'));
    const dataDir = join(tmpRoot, 'data');
    const presetsDir = join(dataDir, 'presets');
    await mkdir(presetsDir, { recursive: true });

    const staleRecord = {
        id: 'preset-stale-only',
        type: 'preset',
        filename: 'stale-only.json',
        presetName: 'Stale Only Preset',
        importedPreset: { prompts: [{ identifier: 'stale', name: 'Stale', content: 'stale' }] }
    };
    const backupRecord = {
        id: 'preset-backup-only',
        type: 'preset',
        filename: 'backup-only.json',
        presetName: 'Backup Only Preset',
        importedPreset: { prompts: [{ identifier: 'backup', name: 'Backup', content: 'backup' }] }
    };

    await writeFile(join(presetsDir, `${staleRecord.id}.json`), JSON.stringify(staleRecord, null, 2), 'utf8');

    const backupBody = await buildBackupWithFiles({
        files: {
            [`data/presets/${backupRecord.id}.json`]: JSON.stringify(backupRecord, null, 2)
        }
    });

    const app = express();
    const config = {
        auth: { enabled: false },
        chat: { dataDir },
        preset: { name: 'Current Preset', prompts: [] },
        imports: { presetFiles: [staleRecord], regexFiles: [] },
        bindings: { global: {}, characters: {} },
        server: {}
    };
    let savedConfig = null;
    setupRoutes(app, config, (next) => { savedConfig = structuredClone(next); }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=presets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.equal(config.preset.name, 'Current Preset');
        assert.deepEqual(config.imports.presetFiles.map((item) => item.id), [backupRecord.id]);
        assert.deepEqual(savedConfig.imports.presetFiles.map((item) => item.id), [backupRecord.id]);
        assert.equal(existsSync(join(presetsDir, `${backupRecord.id}.json`)), true);
        assert.equal(existsSync(join(presetsDir, `${staleRecord.id}.json`)), false);
        assert.ok(restoreBody.changes.replaced.some((item) => item.includes('预设导入记录 (1 条)')));
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(tmpRoot, { recursive: true, force: true });
    }
});

test('memory-only restore writes chat database files and reports restored memory', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-memory-restore-test-'));
    const app = express();

    const backupBody = await buildBackupWithFiles({
        files: {
            'data/chats/memory-store.sqlite': 'backup-memory',
            'data/chats/characters/test.sqlite': 'character-memory',
            'data/chats/characters/test.sqlite-shm': 'runtime-shared-memory',
            'data/chats/characters/test.sqlite-wal': 'wal-memory'
        }
    });

    const config = {
        auth: { enabled: false },
        chat: { dataDir: join(tmpRoot, 'data') },
        memory: { storage: { path: join(tmpRoot, 'data', 'chats', 'memory-store.sqlite') } },
        server: {}
    };
    const managers = createManagers(config);
    let checkpointCount = 0;
    let closeCount = 0;
    let setConfigCount = 0;
    managers.sessionManager.checkpoint = () => { checkpointCount += 1; };
    managers.sessionManager.close = () => { closeCount += 1; };
    managers.sessionManager.setConfig = () => { setConfigCount += 1; };
    setupRoutes(app, config, () => {}, managers);

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const restoreResponse = await fetch(`http://127.0.0.1:${port}/api/config/restore?categories=memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/gzip' },
            body: backupBody
        });
        const restoreBody = await restoreResponse.json();

        assert.equal(restoreResponse.status, 200, JSON.stringify(restoreBody));
        assert.equal(restoreBody.success, true);
        assert.ok(restoreBody.changes.replaced.includes('data/chats (记忆库已恢复)'));
        assert.ok(restoreBody.changes.added.some((item) => item.includes('memory-store.sqlite')));
        assert.equal(
            await readFile(join(tmpRoot, 'data', 'chats', 'memory-store.sqlite'), 'utf8'),
            'backup-memory'
        );
        assert.equal(
            await readFile(join(tmpRoot, 'data', 'chats', 'characters', 'test.sqlite'), 'utf8'),
            'character-memory'
        );
        assert.equal(
            await readFile(join(tmpRoot, 'data', 'chats', 'characters', 'test.sqlite-wal'), 'utf8'),
            'wal-memory'
        );
        assert.equal(existsSync(join(tmpRoot, 'data', 'chats', 'characters', 'test.sqlite-shm')), false);
        assert.equal(checkpointCount, 1);
        assert.equal(closeCount, 1);
        assert.equal(setConfigCount, 1);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(tmpRoot, { recursive: true, force: true });
    }
});

test('prompt range test uses chat provider base url and api key by default', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        preset: { enabled: true, prompts: [] },
        regex: {
            enabled: true,
            rules: [{ name: 'Provider Rename', pattern: 'provider', flags: 'g', replacement: 'Provider', enabled: true, stage: 'output' }]
        },
        bindings: { global: { regexRules: [] }, characters: {} },
        context: { enabled: false },
        chat: {
            defaultCharacter: '角色A',
            modelProviderId: 'provider-chat',
            model: 'deepseek-v4-pro'
        },
        ai: {
            baseUrl: 'https://wrong.example/v1',
            apiKey: '',
            model: 'wrong-model',
            maxTokens: 256,
            temperature: 0.3,
            providers: [{
                id: 'provider-chat',
                name: '配置页供应商',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'provider-model'
            }]
        },
        server: {}
    };

    const managers = createManagers(config);
    managers.characterManager.readFromPng = () => ({
        name: '角色A',
        description: '角色描述',
        personality: '',
        scenario: '',
        system_prompt: '',
        first_mes: ''
    });
    managers.worldBookManager.readWorldBook = () => null;
    managers.worldBookManager.matchEntries = () => [];
    managers.sessionManager.recallMemory = () => [];
    managers.sessionManager.listParticipantProfiles = () => [];
    managers.promptBuilder = new PromptBuilder(managers.characterManager, managers.worldBookManager, config);
    managers.regexProcessor = new RegexProcessor(config.regex, { info() {}, warn() {}, error() {}, debug() {} });
    managers.aiClient = {
        extractTextContent(value) {
            return typeof value === 'string' ? value : '';
        },
        getTokenStats() {
            return { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
        }
    };

    setupRoutes(app, config, () => {}, managers);

    const originalFetch = globalThis.fetch;
    const externalRequests = [];
    globalThis.fetch = async (url, options = {}) => {
        const textUrl = String(url);
        if (textUrl === 'https://provider.example/v1/chat/completions') {
            externalRequests.push({ url: textUrl, options });
            return new Response(JSON.stringify({
                choices: [{ message: { content: '<thinking>内部草稿</thinking>配置页 provider 调用成功', reasoning_content: '模型推理摘要' } }]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(url, options);
    };

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userMessage: '你好',
                characterName: '角色A',
                messageType: 'group',
                groupId: '818554756',
                userId: '10001',
                injectVariables: false,
                injectProfiles: false,
                includeAIResponse: true
            })
        });
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.aiResponse.rawReply, '<thinking>内部草稿</thinking>配置页 provider 调用成功');
        assert.equal(body.aiResponse.regexProcessedReply, '配置页 Provider 调用成功');
        assert.equal(body.aiResponse.text, '配置页 Provider 调用成功');
        assert.equal(body.rawReply, body.aiResponse.rawReply);
        assert.equal(body.cleanedReply, '配置页 Provider 调用成功');
        assert.equal(body.finalReply, '配置页 Provider 调用成功');
        assert.equal(body.reasoningContent, '内部草稿');
        assert.equal(body.aiResponse.rawReasoningContent, '模型推理摘要');
        assert.equal(body.inputHeader.includes('群号:818554756'), true);
        assert.equal(body.fakeHistoryCount, 0);
        assert.equal(Array.isArray(body.messages), true);
        assert.equal(Array.isArray(body.messageTrace), true);
        assert.equal(body.prompt.currentMessageFocus?.meta?.source, 'current_message_focus');
        assert.equal(body.regexTrace.output.appliedRules.some((rule) => rule.name === 'Provider Rename'), true);
        assert.equal(typeof body.regexTrace.cleanup.changed, 'boolean');
        assert.equal(body.observation.finalReply, body.finalReply);
        assert.equal(externalRequests.length, 1);
        assert.equal(externalRequests[0].options.headers.Authorization, 'Bearer provider-key');
        assert.equal(JSON.parse(externalRequests[0].options.body).model, 'deepseek-v4-pro');
        const aiStep = body.trace.steps.find((step) => step.id === 'ai-request');
        assert.equal(aiStep.details.providerId, 'provider-chat');
        assert.equal(aiStep.details.endpoint, 'https://provider.example/v1');
        assert.equal(aiStep.details.hasApiKey, true);
    } finally {
        globalThis.fetch = originalFetch;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('prompt range test returns trace when provider request fails', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const config = {
        chat: {
            defaultCharacter: '角色A',
            modelProviderId: 'provider-chat',
            model: 'provider-chat||deepseek-v4-pro'
        },
        ai: {
            baseUrl: 'https://wrong.example/v1',
            apiKey: '',
            model: 'wrong-model',
            maxTokens: 256,
            temperature: 0.3,
            providers: [{
                id: 'provider-chat',
                name: '配置页供应商',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'provider-model'
            }]
        },
        server: {}
    };

    const managers = createManagers(config);
    managers.characterManager.readFromPng = () => ({
        name: '角色A',
        description: '角色描述',
        personality: '',
        scenario: '',
        system_prompt: '',
        first_mes: ''
    });
    managers.worldBookManager.readWorldBook = () => null;
    managers.worldBookManager.matchEntries = () => [];
    managers.sessionManager.recallMemory = () => [];
    managers.sessionManager.listParticipantProfiles = () => [];
    managers.promptBuilder = new PromptBuilder(managers.characterManager, managers.worldBookManager, config);
    managers.aiClient = {
        extractTextContent(value) {
            return typeof value === 'string' ? value : '';
        },
        getTokenStats() {
            return { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
        }
    };

    setupRoutes(app, config, () => {}, managers);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url) === 'https://provider.example/v1/chat/completions') {
            throw new TypeError('fetch failed');
        }
        return originalFetch(url, options);
    };

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userMessage: '你好',
                characterName: '角色A',
                messageType: 'group',
                groupId: '818554756',
                userId: '10001',
                injectVariables: false,
                injectProfiles: false,
                includeAIResponse: true
            })
        });
        const body = await response.json();

        assert.equal(response.status, 500, JSON.stringify(body));
        assert.equal(body.success, false);
        assert.equal(body.error, 'fetch failed');
        const aiStep = body.trace.steps.find((step) => step.id === 'ai-request');
        assert.equal(aiStep.status, 'failed');
        assert.equal(aiStep.details.providerId, 'provider-chat');
        assert.equal(aiStep.details.endpoint, 'https://provider.example/v1');
        assert.equal(aiStep.details.hasApiKey, true);
    } finally {
        globalThis.fetch = originalFetch;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('prompt range test stops before upstream request when provider key is missing', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const config = {
        chat: {
            defaultCharacter: '角色A',
            modelProviderId: 'provider-chat',
            model: 'provider-chat||deepseek-v4-pro'
        },
        ai: {
            baseUrl: 'https://wrong.example/v1',
            apiKey: '',
            model: 'wrong-model',
            maxTokens: 256,
            temperature: 0.3,
            providers: [{
                id: 'provider-chat',
                name: '配置页供应商',
                baseUrl: 'https://provider.example/v1',
                apiKey: '',
                model: 'provider-model'
            }]
        },
        server: {}
    };

    const managers = createManagers(config);
    managers.characterManager.readFromPng = () => ({
        name: '角色A',
        description: '角色描述',
        personality: '',
        scenario: '',
        system_prompt: '',
        first_mes: ''
    });
    managers.worldBookManager.readWorldBook = () => null;
    managers.worldBookManager.matchEntries = () => [];
    managers.sessionManager.recallMemory = () => [];
    managers.sessionManager.listParticipantProfiles = () => [];
    managers.promptBuilder = new PromptBuilder(managers.characterManager, managers.worldBookManager, config);
    managers.aiClient = {
        extractTextContent(value) {
            return typeof value === 'string' ? value : '';
        },
        getTokenStats() {
            return { totalTokens: 0, inputTokens: 0, outputTokens: 0 };
        }
    };

    setupRoutes(app, config, () => {}, managers);

    const originalFetch = globalThis.fetch;
    let externalCalled = false;
    globalThis.fetch = async (url, options = {}) => {
        if (String(url) === 'https://provider.example/v1/chat/completions') {
            externalCalled = true;
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(url, options);
    };

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userMessage: '你好',
                characterName: '角色A',
                messageType: 'group',
                groupId: '818554756',
                userId: '10001',
                injectVariables: false,
                injectProfiles: false,
                includeAIResponse: true
            })
        });
        const body = await response.json();

        assert.equal(response.status, 500, JSON.stringify(body));
        assert.equal(body.success, false);
        assert.match(body.error, /未配置 API Key/);
        assert.equal(externalCalled, false);
        const aiStep = body.trace.steps.find((step) => step.id === 'ai-request');
        assert.equal(aiStep.status, 'failed');
        assert.equal(aiStep.details.providerId, 'provider-chat');
        assert.equal(aiStep.details.endpoint, 'https://provider.example/v1');
        assert.equal(aiStep.details.hasApiKey, false);
    } finally {
        globalThis.fetch = originalFetch;
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('prompt range agent chat resolves provider credentials by provider id', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const config = {
        chat: {
            defaultCharacter: '角色A',
            modelProviderId: 'provider-chat',
            model: 'provider-chat||deepseek-v4-pro'
        },
        ai: {
            baseUrl: 'https://wrong.example/v1',
            apiKey: '',
            model: 'wrong-model',
            maxTokens: 256,
            temperature: 0.3,
            providers: [{
                id: 'provider-chat',
                name: '配置页供应商',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'provider-model'
            }]
        },
        server: {}
    };

    const managers = createManagers(config);
    let chatCall = null;
    managers.aiClient = {
        async chat(messages, overrides) {
            chatCall = { messages, overrides };
            return {
                content: 'agent provider ok',
                overrides,
                messages
            };
        },
        getVisibleResponseContent(result) {
            return result.content;
        }
    };

    setupRoutes(app, config, () => {}, managers);
    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/agent-chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                modelProviderId: 'provider-chat',
                model: 'deepseek-v4-pro',
                baseUrl: 'https://wrong-body.example/v1',
                apiKey: 'wrong-body-key',
                messages: [{ role: 'user', content: '优化一下' }]
            })
        });
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.reply, 'agent provider ok');
        assert.equal(body.provider.id, 'provider-chat');
        assert.equal(body.provider.endpoint, 'https://provider.example/v1');
        assert.equal(body.provider.model, 'deepseek-v4-pro');
        assert.equal(body.provider.hasApiKey, true);
        assert.equal(chatCall.overrides.baseUrl, 'https://provider.example/v1');
        assert.equal(chatCall.overrides.apiKey, 'provider-key');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('prompt range models expose provider key readiness without leaking keys', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const config = {
        chat: { modelProviderId: 'provider-ready', model: 'deepseek-v4-pro' },
        ai: {
            providers: [{
                id: 'provider-ready',
                name: '已配置供应商',
                provider: 'openai-compatible',
                baseUrl: 'https://provider.example/v1',
                apiKey: 'provider-key',
                model: 'deepseek-v4-pro',
                models: [{ id: 'deepseek-v4-pro', enabled: true }]
            }, {
                id: 'provider-missing',
                name: '缺Key供应商',
                provider: 'openai-compatible',
                baseUrl: 'https://missing.example/v1',
                apiKey: '',
                model: 'deepseek-v4-flash',
                models: [{ id: 'deepseek-v4-flash', enabled: true }]
            }]
        },
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));
    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/models`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        const ready = body.providers.find((provider) => provider.id === 'provider-ready');
        const missing = body.providers.find((provider) => provider.id === 'provider-missing');
        assert.equal(ready.hasApiKey, true);
        assert.equal(ready.requiresApiKey, true);
        assert.equal('apiKey' in ready, false);
        assert.equal(missing.hasApiKey, false);
        assert.equal(missing.requiresApiKey, true);
        assert.equal('apiKey' in missing, false);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('prompt range sync-latest returns persisted observer history for late-opened range panel', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const dataDir = await mkdtemp(join(tmpdir(), 'mimir-range-sync-memory-'));
    const history = [
        {
            type: 'range_sync',
            source: 'mcp_range_test',
            receivedAt: '2026-05-23T00:00:00.000Z',
            payload: {
                source: 'mcp_range_test',
                syncedAt: '2026-05-23T00:00:00.000Z',
                userMessage: '[群聊][群号:1][昵称:甲] 第一条',
                reply: '第一条回复',
                trace: { runId: 'mcp-range-1', steps: [] }
            }
        },
        {
            type: 'range_sync',
            source: 'mcp_range_test',
            receivedAt: '2026-05-23T00:01:00.000Z',
            payload: {
                source: 'mcp_range_test',
                syncedAt: '2026-05-23T00:01:00.000Z',
                userMessage: '[群聊][群号:1][昵称:乙] 第二条',
                reply: '第二条回复',
                trace: { runId: 'mcp-range-2', steps: [] }
            }
        }
    ];
    const config = {
        auth: { enabled: false },
        chat: { dataDir },
        ai: {},
        server: {},
        __rangeSyncHistory: history,
        __rangeSyncLatest: history[1]
    };

    setupRoutes(app, config, () => {}, createManagers(config));
    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/sync-latest?limit=10`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.latest.payload.trace.runId, 'mcp-range-2');
        assert.equal(body.history.length, 2);
        assert.deepEqual(body.history.map((item) => item.payload.trace.runId), ['mcp-range-1', 'mcp-range-2']);
        assert.equal(body.history[0].payload.userMessage, '[群聊][群号:1][昵称:甲] 第一条');
        assert.equal(body.history[1].payload.reply, '第二条回复');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(dataDir, { recursive: true, force: true });
    }
});

test('prompt range sync-latest reloads observer history from disk after restart', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    const dataDir = await mkdtemp(join(tmpdir(), 'mimir-range-sync-'));
    const history = [{
        type: 'range_sync',
        source: 'mcp_range_test',
        receivedAt: '2026-05-23T00:02:00.000Z',
        payload: {
            source: 'mcp_range_test',
            syncedAt: '2026-05-23T00:02:00.000Z',
            userMessage: '[群聊][群号:1][昵称:丙] 重启后补拉',
            reply: '重启后仍可观察',
            trace: { runId: 'mcp-range-disk', steps: [] }
        }
    }];
    await writeFile(join(dataDir, 'range-sync-history.json'), JSON.stringify(history, null, 2), 'utf8');

    const config = {
        auth: { enabled: false },
        chat: { dataDir },
        ai: {},
        server: {}
    };

    setupRoutes(app, config, () => {}, createManagers(config));
    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/api/prompt-range/sync-latest?limit=10`);
        const body = await response.json();

        assert.equal(response.status, 200, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.latest.payload.trace.runId, 'mcp-range-disk');
        assert.equal(body.history.length, 1);
        assert.equal(body.history[0].payload.userMessage, '[群聊][群号:1][昵称:丙] 重启后补拉');
        assert.equal(config.__rangeSyncLatest.payload.reply, '重启后仍可观察');
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await rm(dataDir, { recursive: true, force: true });
    }
});
