import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { setupRoutes } from '../src/routes.js';

function createBaseManagers() {
    const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
    return {
        characterManager: { listCharacters() { return []; }, getCurrentCharacter() { return null; }, extractSillyTavernMetadata() { return { metadata: null }; } },
        worldBookManager: { scanWorldBooks: async () => {}, readWorldBook() { return null; }, getCurrentWorldBook() { return null; } },
        sessionManager: { getDbPath: () => './data/chats/memory-store.sqlite', listSessions: () => [], listParticipantProfiles: () => [], getParticipantProfile: () => null, getStats: () => ({}) },
        regexProcessor: { updateConfig() {} },
        aiClient: { updateConfig() {} },
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
        clearParticipantProfileTimers: () => {}
    };
}

function sendRawRequest({ port, path = '/api/auth/login', method = 'POST', headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...headers
            }
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, body: data, json });
            });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

test('同源写与跨源写拦截：IPv6、反向代理、白名单与攻击拦截', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: true, username: 'admin', password: 'secret-pass' },
        server: {
            allowedOrigins: ['https://trusted.external.com']
        }
    };

    setupRoutes(app, config, () => {}, createBaseManagers());

    const server = await new Promise((resolve, reject) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
        s.once('error', reject);
    });
    const port = server.address().port;

    try {
        const loginPayload = JSON.stringify({ username: 'admin', password: 'wrong' });

        // 1. IPv6 localhost: [::1]:8001 访问应放行
        const ipv6Res = await sendRawRequest({
            port,
            headers: {
                'Host': `[::1]:${port}`,
                'Origin': `http://[::1]:${port}`
            },
            body: loginPayload
        });
        assert.equal(ipv6Res.status, 401, 'IPv6 来源应通过同源检查（401 说明进入了登录逻辑，不是 403 跨源拒绝）');

        // 2. 反向代理 HTTPS 标准端口 (X-Forwarded-Proto: https)
        const proxyHttpsRes = await sendRawRequest({
            port,
            headers: {
                'Host': 'panel.example.com',
                'X-Forwarded-Proto': 'https',
                'Origin': 'https://panel.example.com'
            },
            body: loginPayload
        });
        assert.equal(proxyHttpsRes.status, 401, '反代 HTTPS 域名应通过同源检查');

        // 3. 反向代理 X-Forwarded-Host 头
        const fwdHostRes = await sendRawRequest({
            port,
            headers: {
                'Host': '127.0.0.1:8001',
                'X-Forwarded-Host': 'panel.example.com',
                'X-Forwarded-Proto': 'https',
                'Origin': 'https://panel.example.com'
            },
            body: loginPayload
        });
        assert.equal(fwdHostRes.status, 401, 'X-Forwarded-Host 应通过同源检查');

        // 4. 自定义配置放行 allowedOrigins
        const allowedOriginRes = await sendRawRequest({
            port,
            headers: {
                'Host': '127.0.0.1:8001',
                'Origin': 'https://trusted.external.com'
            },
            body: loginPayload
        });
        assert.equal(allowedOriginRes.status, 401, '配置白名单 allowedOrigins 应放行');

        // 5. 大小写机器名 Host 匹配
        const upperHostRes = await sendRawRequest({
            port,
            headers: {
                'Host': `MY-PC:${port}`,
                'Origin': `http://my-pc:${port}`
            },
            body: loginPayload
        });
        assert.equal(upperHostRes.status, 401, '大小写机器名应通过检查');

        // 6. 恶意外部站点 evil.com 攻击必须 403 拒绝
        const evilRes = await sendRawRequest({
            port,
            headers: {
                'Host': '127.0.0.1:8001',
                'Origin': 'http://evil.com'
            },
            body: loginPayload
        });
        assert.equal(evilRes.status, 403, '跨源攻击必须 403 拒绝');
        assert.equal(evilRes.json?.error, '跨源写入请求已被拒绝');

        // 7. 端口不匹配攻击必须 403 拒绝
        const portMismatchRes = await sendRawRequest({
            port,
            headers: {
                'Host': 'panel:8080',
                'Origin': 'http://panel:9999'
            },
            body: loginPayload
        });
        assert.equal(portMismatchRes.status, 403, '端口不匹配必须 403 拒绝');

    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
