import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { createPanelAuthGate, isMcpTokenAuthorized, extractMcpToken, safeEqualStrings, normalizeMcpPath } from '../src/auth-gate.js';
import { setupRoutes } from '../src/routes.js';
import { createMCPHandler } from '../src/mcp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildManagers(overrides = {}) {
    return {
        characterManager: { listCharacters() { return []; }, getCurrentCharacter() { return null; } },
        worldBookManager: { scanWorldBooks: async () => {}, readWorldBook() { return null; }, getCurrentWorldBook() { return null; } },
        sessionManager: { getDbPath: () => './data/chats/memory-store.sqlite', listParticipantProfiles: () => [], getParticipantProfile: () => null, setConfig() {} },
        regexProcessor: { updateConfig() {} },
        aiClient: { updateConfig() {}, getVisibleResponseContent: (result) => result?.content || result?.text || '' },
        promptBuilder: { updateConfig() {} },
        logger: silentLogger,
        mcpClient: null,
        clearParticipantProfileTimers() {},
        recordDashboardMetric() {},
        getDashboardMetricsSnapshot() { return {}; },
        getLlmEnabled() { return true; },
        setLlmEnabled() {},
        ...overrides
    };
}

function buildHarness({ auth = { enabled: true, username: 'admin', password: 'secret-pass' }, mcp = { enabled: true, path: '/mcp', token: '' }, gate = true } = {}) {
    const config = {
        auth,
        server: { port: 0 },
        onebot: { url: 'ws://127.0.0.1:1' },
        mcp,
        chat: { dataDir: './data' },
        ai: { providers: [], tools: {} },
        memory: { participantProfile: {} }
    };
    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use((req, res, next) => {
        const authed = req.headers['x-test-session'] === 'yes';
        req.session = { authenticated: authed, username: authed ? 'admin' : null, cookie: { maxAge: 0 } };
        next();
    });
    if (gate) {
        app.use(createPanelAuthGate(config));
    }
    app.use(express.static(publicDir));
    let saved = 0;
    setupRoutes(app, config, () => { saved += 1; }, buildManagers());
    return { app, config, getSaved: () => saved };
}

function mountMcp(app, config) {
    app.all(config.mcp.path, createMCPHandler(buildManagers(), config, () => {}));
}

async function withServer(app, fn) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        return await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

test('未登录时 API 返回 401，页面重定向登录页', async () => {
    const { app } = buildHarness();
    await withServer(app, async (base) => {
        const api = await fetch(`${base}/api/config`, { redirect: 'manual' });
        assert.equal(api.status, 401);
        const page = await fetch(`${base}/index.html`, { redirect: 'manual' });
        assert.equal(page.status, 302);
        assert.equal(page.headers.get('location'), '/login.html');
        const root = await fetch(`${base}/`, { redirect: 'manual' });
        assert.equal(root.status, 302);
        assert.equal(root.headers.get('location'), '/login.html');
    });
});

test('登录页与三个认证接口保持公开，其它 /api/auth 子路径不放行', async () => {
    const { app } = buildHarness();
    await withServer(app, async (base) => {
        const loginPage = await fetch(`${base}/login.html`, { redirect: 'manual' });
        assert.equal(loginPage.status, 200);
        const status = await fetch(`${base}/api/auth/status`, { redirect: 'manual' });
        assert.equal(status.status, 200);
        assert.equal((await status.json()).enabled, true);
        const missing = await fetch(`${base}/api/auth/not-a-real-route`, { redirect: 'manual' });
        assert.equal(missing.status, 401);
    });
});

test('携带会话时放行受保护接口，登录后可访问面板页面', async () => {
    const { app } = buildHarness();
    await withServer(app, async (base) => {
        const res = await fetch(`${base}/api/config`, { headers: { 'x-test-session': 'yes' } });
        assert.equal(res.status, 200);
        const page = await fetch(`${base}/index.html`, { headers: { 'x-test-session': 'yes' }, redirect: 'manual' });
        assert.equal(page.status, 200);
    });
});

test('MCP 端点：未配置令牌仍需登录会话；配置令牌后携带令牌放行', async () => {
    const noToken = buildHarness({ mcp: { enabled: true, path: '/mcp', token: '' } });
    mountMcp(noToken.app, noToken.config);
    await withServer(noToken.app, async (base) => {
        const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' });
        assert.equal(res.status, 302);
    });

    const withToken = buildHarness({ mcp: { enabled: true, path: '/mcp', token: 'tok-123456' } });
    mountMcp(withToken.app, withToken.config);
    await withServer(withToken.app, async (base) => {
        const denied = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', redirect: 'manual' });
        assert.equal(denied.status, 302);

        const bearer = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-123456' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
            redirect: 'manual'
        });
        assert.equal(bearer.status, 200);
        assert.equal((await bearer.json()).result.protocolVersion, '2024-11-05');

        const headerToken = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'tok-123456' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} }),
            redirect: 'manual'
        });
        assert.equal(headerToken.status, 200);
    });
});

test('MCP 处理器二次校验令牌（即使网关被绕过也无法匿名调用）', async () => {
    const { app, config } = buildHarness({ mcp: { enabled: true, path: '/mcp', token: 'tok-123456' }, gate: false });
    mountMcp(app, config);
    await withServer(app, async (base) => {
        const anonymous = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
        });
        assert.equal(anonymous.status, 401);
        assert.equal((await anonymous.json()).error.code, -32001);

        const withToken = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-MCP-Token': 'tok-123456' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
        });
        assert.equal(withToken.status, 200);
    });
});

test('登录接口：错误口令 401，正确口令成功后写入会话', async () => {
    const { app, config } = buildHarness();
    await withServer(app, async (base) => {
        const wrong = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'wrong-pass' })
        });
        assert.equal(wrong.status, 401);

        // 存根会话没有 regenerate，登录应走降级路径并写入会话
        const ok = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: config.auth.username, password: config.auth.password })
        });
        assert.equal(ok.status, 200);
        assert.equal((await ok.json()).success, true);
    });
});

test('登录接口：会话存在 regenerate 时调用它轮换会话 ID', async () => {
    const app = express();
    app.use(express.json());
    let regenerated = 0;
    app.use((req, res, next) => {
        req.session = {
            authenticated: false,
            cookie: { maxAge: 0 },
            regenerate(cb) { regenerated += 1; req.session.authenticated = false; cb(null); }
        };
        next();
    });
    const config = { auth: { enabled: true, username: 'admin', password: 'secret-pass' }, ai: { providers: [], tools: {} }, chat: { dataDir: './data' }, memory: { participantProfile: {} } };
    setupRoutes(app, config, () => {}, buildManagers());
    await withServer(app, async (base) => {
        const ok = await fetch(`${base}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'secret-pass' })
        });
        assert.equal(ok.status, 200);
        assert.equal(regenerated, 1);
    });
});

test('auth-gate 纯函数：路径归一化、令牌提取与恒时比较', () => {
    assert.equal(normalizeMcpPath('mcp'), '/mcp');
    assert.equal(normalizeMcpPath('/mcp/'), '/mcp');
    assert.equal(normalizeMcpPath(''), '/mcp');
    assert.equal(extractMcpToken({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
    assert.equal(extractMcpToken({ headers: { 'x-mcp-token': ' xyz ' } }), 'xyz');
    assert.equal(extractMcpToken({ headers: {} }), '');
    assert.equal(isMcpTokenAuthorized({ headers: { authorization: 'Bearer right' } }, { mcp: { token: 'right' } }), true);
    assert.equal(isMcpTokenAuthorized({ headers: { authorization: 'Bearer wrong' } }, { mcp: { token: 'right' } }), false);
    assert.equal(isMcpTokenAuthorized({ headers: { authorization: 'Bearer right' } }, { mcp: {} }), false);
    assert.equal(safeEqualStrings('abc', 'abc'), true);
    assert.equal(safeEqualStrings('abc', 'abcd'), false);
    assert.equal(safeEqualStrings(undefined, ''), true);
});

test('配置接口：MCP 令牌掩码下发，保存时掩码保留原值、空串清除', async () => {
    const { app, config } = buildHarness({ mcp: { enabled: true, path: '/mcp', token: 'super-secret-token' } });
    await withServer(app, async (base) => {
        const headers = { 'x-test-session': 'yes', 'Content-Type': 'application/json' };
        const getRes = await fetch(`${base}/api/config`, { headers });
        assert.equal(getRes.status, 200);
        const body = await getRes.json();
        assert.equal(body.mcp.token, '******');
        assert.equal(body.mcp.hasToken, true);

        const keep = await fetch(`${base}/api/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, mcp: { ...body.mcp, token: '******' } })
        });
        assert.equal(keep.status, 200);
        assert.equal(config.mcp.token, 'super-secret-token');

        const clear = await fetch(`${base}/api/config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...body, mcp: { ...body.mcp, token: '' } })
        });
        assert.equal(clear.status, 200);
        assert.equal(config.mcp.token, '');
    });
});
