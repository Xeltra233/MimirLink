/**
 * 配置密钥脱敏测试（备份导出 / 配置读取共用）
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { maskConfigSecrets, MASK_VALUE } from '../src/secret-mask.js';

test('固定字段名在任何层级都会被脱敏', () => {
    const masked = maskConfigSecrets({
        auth: { password: 'plain-password', sessionSecret: 'sess-secret' },
        ai: { apiKey: 'sk-root', providers: [{ id: 'p1', apiKey: 'sk-provider' }] },
        onebot: { accessToken: 'onebot-token' },
        tts: { apiKey: 'tts-key', secret: 'tts-secret' },
        nested: { deep: { token: 'deep-token' } }
    });

    assert.equal(masked.auth.password, MASK_VALUE);
    assert.equal(masked.auth.sessionSecret, MASK_VALUE);
    assert.equal(masked.ai.apiKey, MASK_VALUE);
    assert.equal(masked.ai.providers[0].apiKey, MASK_VALUE);
    assert.equal(masked.onebot.accessToken, MASK_VALUE);
    assert.equal(masked.tts.apiKey, MASK_VALUE);
    assert.equal(masked.tts.secret, MASK_VALUE);
    assert.equal(masked.nested.deep.token, MASK_VALUE);
});

test('MCP 自定义请求头与环境变量里的密钥会被脱敏，普通字段保留', () => {
    const masked = maskConfigSecrets({
        mcp: {
            client: {
                servers: [{
                    name: 'fathom-search',
                    transport: 'http',
                    url: 'https://fathomsearch.xyz/mcp',
                    headers: {
                        'X-API-KEY': 'ft-33f8cd6c54892f6c7',
                        'Accept': 'application/json',
                        'X-Trace-Id': 'trace-123'
                    },
                    env: {
                        TEST_KEY: 'e2e-env-secret',
                        OPENAI_API_KEY: 'sk-env',
                        PATH: '/usr/bin',
                        NODE_ENV: 'production'
                    }
                }]
            }
        }
    });

    const server = masked.mcp.client.servers[0];
    assert.equal(server.headers['X-API-KEY'], MASK_VALUE);
    assert.equal(server.headers.Accept, 'application/json');
    assert.equal(server.headers['X-Trace-Id'], 'trace-123');
    assert.equal(server.env.TEST_KEY, MASK_VALUE);
    assert.equal(server.env.OPENAI_API_KEY, MASK_VALUE);
    assert.equal(server.env.PATH, '/usr/bin');
    assert.equal(server.env.NODE_ENV, 'production');
    assert.equal(server.url, 'https://fathomsearch.xyz/mcp', 'URL 本身不加掩码');
});

test('apiKeys 是「服务名 → 密钥」映射，容器内全部脱敏', () => {
    const masked = maskConfigSecrets({
        ai: { tools: { webSearch: { apiKeys: { tavily: 'tvly-abc', brave: 'brave-abc', serpapi: '' } } } }
    });
    assert.equal(masked.ai.tools.webSearch.apiKeys.tavily, MASK_VALUE);
    assert.equal(masked.ai.tools.webSearch.apiKeys.brave, MASK_VALUE);
    assert.equal(masked.ai.tools.webSearch.apiKeys.serpapi, '', '空值保持空值');
});

test('非密钥字段不被误伤（模型 ID、模式名、开关等）', () => {
    const masked = maskConfigSecrets({
        onebot: { tokenMode: 'header', url: 'ws://127.0.0.1:3001' },
        ai: { providers: [{ models: [{ id: 'bailu-2.6', name: 'bailu-2.6' }] }] },
        chat: { model: '[Antigravity渠道] gemini-3.8-flash-high', maxToolRounds: 0 },
        security: { secretMode: 'warn' }
    });

    assert.equal(masked.onebot.tokenMode, 'header');
    assert.equal(masked.ai.providers[0].models[0].id, 'bailu-2.6');
    assert.equal(masked.chat.model, '[Antigravity渠道] gemini-3.8-flash-high');
    assert.equal(masked.chat.maxToolRounds, 0);
    assert.equal(masked.security.secretMode, 'warn');
});

test('脱敏返回副本，不修改传入对象', () => {
    const input = { ai: { apiKey: 'sk-original' }, mcp: { client: { servers: [{ headers: { 'X-API-KEY': 'ft-original' } }] } } };
    const snapshot = JSON.stringify(input);
    const masked = maskConfigSecrets(input);
    assert.equal(JSON.stringify(input), snapshot);
    assert.notEqual(masked, input);
    assert.equal(masked.ai.apiKey, MASK_VALUE);
    assert.equal(masked.mcp.client.servers[0].headers['X-API-KEY'], MASK_VALUE);
});

test('空值 / 非对象输入安全处理', () => {
    assert.deepEqual(maskConfigSecrets(null), {});
    assert.deepEqual(maskConfigSecrets(undefined), {});
    const masked = maskConfigSecrets({ tts: { apiKey: '' }, flags: { enabled: true, retries: 3 } });
    assert.equal(masked.tts.apiKey, '');
    assert.equal(masked.flags.enabled, true);
    assert.equal(masked.flags.retries, 3);
});
