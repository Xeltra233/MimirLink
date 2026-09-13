import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { setupRoutes } from '../src/routes.js';
import { McpClientManager } from '../src/mcp-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureServer = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildConfig() {
    return {
        auth: { enabled: false },
        chat: { dataDir: './data', defaultCharacter: '角色A', sessionMode: 'user_persistent', accessControlMode: 'allowlist', allowedGroups: ['123456'] },
        memory: { storage: { path: './data/chats/memory-store.sqlite' }, summary: { enabled: false } },
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'tavily',
                    apiKeys: { tavily: 'tvly-secret', brave: '', serpapi: '' },
                    maxResults: 5,
                    timeoutMs: 10000,
                    maxSnippetLength: 800,
                    allowedDomains: [],
                    blockedDomains: [],
                    fetch: { enabled: true, timeoutMs: 15000, maxChars: 8000 },
                    spice: { enabled: true, weatherDays: 3 }
                }
            }
        },
        regex: { rules: [] },
        preset: {},
        bindings: { global: { regexRules: [] }, characters: {} },
        mcp: { enabled: true, path: '/mcp', client: { enabled: false, maxResultChars: 4000, servers: [] } }
    };
}

async function startTestServer() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { authenticated: true, username: 'admin' };
        next();
    });

    const config = buildConfig();
    const saved = [];
    const saveConfig = () => { saved.push(JSON.parse(JSON.stringify(config.mcp?.client || null))); };
    const mcpClient = new McpClientManager({ config, logger: silentLogger });

    setupRoutes(app, config, saveConfig, {
        characterManager: { listCharacters() { return []; }, getCurrentCharacter() { return null; }, extractSillyTavernMetadata() { return { metadata: null }; } },
        worldBookManager: { scanWorldBooks: async () => {}, readWorldBook() { return null; }, getCurrentWorldBook() { return null; } },
        sessionManager: { getDbPath: () => './data/chats/memory-store.sqlite', listParticipantProfiles: () => [], getParticipantProfile: () => null },
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
        mcpClient
    });

    const server = await new Promise((resolve, reject) => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
        instance.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    return {
        server,
        baseUrl,
        config,
        saved,
        mcpClient,
        close: async () => {
            await mcpClient.close();
            await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    };
}

async function postJson(baseUrl, url, body, method = 'POST') {
    return fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
}

test('MCP 端点：状态、开关、服务器增删改与掩码', async () => {
    const ctx = await startTestServer();
    try {
        const emptyStatus = await (await fetch(`${ctx.baseUrl}/api/mcp/status`)).json();
        assert.equal(emptyStatus.success, true);
        assert.equal(emptyStatus.server.enabled, true);
        assert.equal(emptyStatus.client.enabled, false);
        assert.deepEqual(emptyStatus.client.servers, []);

        const settingsRes = await postJson(ctx.baseUrl, '/api/mcp/settings', { enabled: true, maxResultChars: 4000 });
        const settings = await settingsRes.json();
        assert.equal(settingsRes.status, 200);
        assert.equal(settings.client.enabled, true);

        const serverPayload = {
            name: 'echo-server',
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureServer],
            env: { TOKEN: 'secret-value' },
            timeoutMs: 15000
        };
        const addRes = await postJson(ctx.baseUrl, '/api/mcp/servers', serverPayload);
        const addData = await addRes.json();
        assert.equal(addRes.status, 200);
        assert.equal(addData.success, true);
        assert.equal(addData.server.state, 'connected');
        assert.equal(addData.server.config.env.TOKEN, '******');
        assert.ok(!JSON.stringify(addData).includes('secret-value'));
        const serverId = addData.server.id;

        // 内部配置保留真实密钥
        assert.equal(ctx.config.mcp.client.servers[0].env.TOKEN, 'secret-value');
        assert.ok(ctx.saved.length >= 1);

        const statusRes = await fetch(`${ctx.baseUrl}/api/mcp/status`);
        const status = await statusRes.json();
        assert.equal(status.client.servers.length, 1);
        assert.equal(status.client.servers[0].state, 'connected');
        assert.equal(status.client.servers[0].toolCount, 5);
        assert.equal(status.client.servers[0].config.env.TOKEN, '******');

        // 更新：掩码值保留旧密钥，新键生效
        const updateRes = await postJson(ctx.baseUrl, '/api/mcp/servers', {
            id: serverId,
            name: 'echo-server',
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureServer],
            env: { TOKEN: '******', NEW_KEY: 'new-value' },
            timeoutMs: 15000
        });
        const updateData = await updateRes.json();
        assert.equal(updateData.success, true);
        const stored = ctx.config.mcp.client.servers[0];
        assert.equal(stored.env.TOKEN, 'secret-value');
        assert.equal(stored.env.NEW_KEY, 'new-value');
        assert.notEqual(stored.env.NEW_KEY, '******');

        // 重名（不同 id）被拒绝
        const duplicateRes = await postJson(ctx.baseUrl, '/api/mcp/servers', {
            name: 'echo-server',
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureServer]
        });
        assert.equal(duplicateRes.status, 400);

        // 校验错误
        const noName = await postJson(ctx.baseUrl, '/api/mcp/servers', { transport: 'stdio', command: 'npx' });
        assert.equal(noName.status, 400);
        const noCommand = await postJson(ctx.baseUrl, '/api/mcp/servers', { name: 'bad-stdio', transport: 'stdio' });
        assert.equal(noCommand.status, 400);
        const badUrl = await postJson(ctx.baseUrl, '/api/mcp/servers', { name: 'bad-http', transport: 'http', url: 'not-a-url' });
        assert.equal(badUrl.status, 400);

        // 工具调用
        const callRes = await postJson(ctx.baseUrl, '/api/mcp/call', { serverId, tool: 'echo', arguments: { text: 'hello' } });
        const callData = await callRes.json();
        assert.equal(callRes.status, 200);
        assert.equal(callData.success, true);
        assert.equal(callData.text, 'echo:hello');

        const missRes = await postJson(ctx.baseUrl, '/api/mcp/call', { serverId, tool: 'nope' });
        assert.equal(missRes.status, 400);

        // 重连
        const reconnectRes = await postJson(ctx.baseUrl, `/api/mcp/servers/${encodeURIComponent(serverId)}/reconnect`, {});
        const reconnectData = await reconnectRes.json();
        assert.equal(reconnectRes.status, 200);
        assert.equal(reconnectData.ok, true);

        // 删除
        const deleteRes = await fetch(`${ctx.baseUrl}/api/mcp/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
        const deleteData = await deleteRes.json();
        assert.equal(deleteRes.status, 200);
        assert.equal(deleteData.success, true);
        assert.equal(ctx.config.mcp.client.servers.length, 0);

        const deleteAgain = await fetch(`${ctx.baseUrl}/api/mcp/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
        assert.equal(deleteAgain.status, 404);
    } finally {
        await ctx.close();
    }
});

test('MCP JSON 导入兼容 Claude / 数组 / 单对象格式', async () => {
    const ctx = await startTestServer();
    try {
        const claudeFormat = JSON.stringify({
            mcpServers: {
                'echo-server': {
                    command: process.execPath,
                    args: [fixtureServer],
                    env: { TOKEN: 'imported' }
                }
            }
        });
        const importRes = await postJson(ctx.baseUrl, '/api/mcp/import', { json: claudeFormat });
        const importData = await importRes.json();
        assert.equal(importRes.status, 200);
        assert.equal(importData.success, true);
        assert.deepEqual(importData.added, ['echo-server']);
        assert.equal(ctx.config.mcp.client.servers[0].transport, 'stdio');
        assert.equal(ctx.config.mcp.client.servers[0].env.TOKEN, 'imported');

        // 同名再导入视为更新
        const updateRes = await postJson(ctx.baseUrl, '/api/mcp/import', {
            json: JSON.stringify({ mcpServers: { 'echo-server': { command: process.execPath, args: [fixtureServer] } } })
        });
        const updateData = await updateRes.json();
        assert.deepEqual(updateData.updated, ['echo-server']);
        assert.deepEqual(updateData.added, []);
        assert.equal(ctx.config.mcp.client.servers.length, 1);

        // 数组格式
        const arrayRes = await postJson(ctx.baseUrl, '/api/mcp/import', {
            json: JSON.stringify([{ name: 'second-server', command: process.execPath, args: [fixtureServer] }])
        });
        const arrayData = await arrayRes.json();
        assert.deepEqual(arrayData.added, ['second-server']);
        assert.equal(ctx.config.mcp.client.servers.length, 2);

        // 错误格式
        const badJson = await postJson(ctx.baseUrl, '/api/mcp/import', { json: '{not json' });
        assert.equal(badJson.status, 400);
        const emptyJson = await postJson(ctx.baseUrl, '/api/mcp/import', { json: '{}' });
        assert.equal(emptyJson.status, 400);
    } finally {
        await ctx.close();
    }
});

test('GET /api/config 掩码 MCP 客户端与搜索密钥', async () => {
    const ctx = await startTestServer();
    try {
        ctx.config.mcp.client.enabled = true;
        ctx.config.mcp.client.servers = [{
            id: 'srv-1',
            name: 'echo-server',
            enabled: true,
            transport: 'stdio',
            command: process.execPath,
            args: [fixtureServer],
            env: { TOKEN: 'super-secret' },
            headers: {},
            timeoutMs: 60000,
            toolFilter: { include: [], exclude: [] }
        }];

        const res = await fetch(`${ctx.baseUrl}/api/config`);
        const data = await res.json();
        assert.equal(res.status, 200);
        assert.equal(data.mcp.client.servers[0].env.TOKEN, '******');
        assert.equal(data.mcp.client.servers[0].hasEnv, true);
        assert.ok(!JSON.stringify(data).includes('super-secret'));
        assert.equal(data.ai.tools.webSearch.apiKeys.tavily, '******');
        assert.equal(data.ai.tools.webSearch.apiKey, undefined);
        assert.equal(data.ai.tools.webSearch.hasApiKey, true);
    } finally {
        await ctx.close();
    }
});
