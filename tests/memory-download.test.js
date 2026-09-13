/**
 * 记忆库文件下载接口测试：
 * - 已知记忆库可下载，返回 SQLite 文件与下载响应头
 * - 目录穿越 / 未知路径被拒绝
 * - 支持面板下发的 ./data/... 相对路径与文件名匹配
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setupRoutes } from '../src/routes.js';
import { PromptBuilder } from '../src/prompt.js';
import { RegexProcessor } from '../src/regex.js';

let testPortOffset = 0;

async function listenTestApp(app) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 23080 + (testPortOffset++ % 1500);
        const result = await new Promise((resolve, reject) => {
            const server = app.listen(port, '127.0.0.1', () => resolve(server));
            server.once('error', reject);
        }).catch((error) => {
            if (error?.code === 'EADDRINUSE') return null;
            throw error;
        });
        if (result) return result;
    }
    throw new Error('无法分配测试端口');
}

function createManagers(config) {
    const promptBuilder = new PromptBuilder({ config, logger: silentLogger });
    const sessionManager = {
        checkpoint() {},
        close() {},
        setConfig() {},
        getStats: () => ({ totalSessions: 0, totalMessages: 0, totalSummaries: 0 }),
        exportMemory: () => ({})
    };
    const logger = silentLogger;
    return {
        characterManager: { listCharacters: () => [], readFromPng: () => ({}) },
        worldBookManager: { listWorldBooks: () => [] },
        sessionManager,
        regexProcessor: new RegexProcessor({ config, logger }),
        aiClient: { chat: async () => ({ content: '' }) },
        promptBuilder,
        logger,
        bot: null,
        ttsManager: null,
        VOICE_TYPES: [],
        runtime: null,
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: (value) => value,
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {},
        analyzeParticipantProfile: async () => null,
        updateKnowledgeImportProgress: () => {},
        getParticipantProfileProgress: () => null,
        getKnowledgeImportProgress: () => null,
        getDashboardMetricsSnapshot: () => ({}),
        recordDashboardMetric: () => {},
        getLlmEnabled: () => true,
        setLlmEnabled: () => {}
    };
}

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const SQLITE_MAGIC = 'SQLite format 3\0';

test('记忆库下载：已知库可下载，未知路径与穿越请求被拒绝', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'mimir-memory-download-'));
    const dataDir = join(tmpRoot, 'data');
    const chatsDir = join(dataDir, 'chats');
    const charactersDir = join(chatsDir, 'characters');
    await mkdir(charactersDir, { recursive: true });

    const globalDbPath = join(chatsDir, 'memory-store.sqlite');
    const characterDbPath = join(charactersDir, '角色A.sqlite');
    const payload = `${SQLITE_MAGIC}test-payload`;
    await writeFile(globalDbPath, payload, 'utf8');
    await writeFile(characterDbPath, `${SQLITE_MAGIC}character`, 'utf8');
    const outsidePath = join(tmpRoot, 'secret.sqlite');
    await writeFile(outsidePath, `${SQLITE_MAGIC}outside`, 'utf8');

    const config = {
        auth: { enabled: false },
        server: {},
        chat: { dataDir, defaultCharacter: '' },
        memory: { storage: { path: globalDbPath } },
        bindings: { global: { memoryDbPath: globalDbPath }, characters: {} }
    };

    const app = express();
    app.use(express.json({ limit: '5mb' }));
    setupRoutes(app, config, () => {}, createManagers(config));
    const server = await listenTestApp(app);
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    try {
        // 面板下发的相对路径
        const relativeResponse = await fetch(`${base}/api/memory/download?path=${encodeURIComponent('./data/chats/memory-store.sqlite')}`);
        assert.equal(relativeResponse.status, 200, '相对路径应可下载');
        assert.match(relativeResponse.headers.get('content-disposition') || '', /attachment/);
        assert.equal(await relativeResponse.text(), payload);

        // 文件名匹配（角色库）
        const byNameResponse = await fetch(`${base}/api/memory/download?path=${encodeURIComponent('角色A.sqlite')}`);
        assert.equal(byNameResponse.status, 200);
        assert.equal(await byNameResponse.text(), `${SQLITE_MAGIC}character`);

        // 绝对路径
        const absoluteResponse = await fetch(`${base}/api/memory/download?path=${encodeURIComponent(globalDbPath)}`);
        assert.equal(absoluteResponse.status, 200);

        // 未知 / 穿越路径
        const unknownResponse = await fetch(`${base}/api/memory/download?path=${encodeURIComponent('../../secret.sqlite')}`);
        assert.equal(unknownResponse.status, 404, '穿越路径必须被拒绝');
        const missingResponse = await fetch(`${base}/api/memory/download?path=${encodeURIComponent('./data/chats/nope.sqlite')}`);
        assert.equal(missingResponse.status, 404);
        const noPathResponse = await fetch(`${base}/api/memory/download`);
        assert.equal(noPathResponse.status, 400);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
        await rm(tmpRoot, { recursive: true, force: true });
    }
});
