/**
 * 工具层静默回退测试：
 * - HTTP 请求重试（4xx 不重试、5xx/429 重试、外部中止不重试）
 * - 搜索引擎熔断（连续失败进入冷却、冷却跳过、成功清零、手动重置）
 * - web_search 的 MCP 搜索兜底（auto / off / 指定服务器）
 * - chatWithTools 轮次默认不限 + 配置上限后转收尾汇总
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { requestText } from '../src/search/http.js';
import { runSearch, resetProviderHealth, getProviderHealthSnapshot } from '../src/search/index.js';
import { buildAIToolContext } from '../src/tools.js';
import { AIClient } from '../src/ai.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** 启动一次性 HTTP 服务，返回 { baseUrl, requests, close } */
async function startServer(handler) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push(req.url);
        handler(req, res, requests.length);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

function searxngPayload(titles = ['结果一']) {
    return JSON.stringify({
        results: titles.map((title, index) => ({
            title,
            url: `https://example.test/${index}`,
            content: `${title} 摘要`
        }))
    });
}

test.beforeEach(() => {
    resetProviderHealth();
});

test('requestText 对 5xx 自动重试，429 也可重试', async () => {
    const server = await startServer((req, res, count) => {
        if (count === 1) {
            res.writeHead(503, { 'content-type': 'text/plain' });
            res.end('unavailable');
            return;
        }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
    });
    try {
        const result = await requestText(`${server.baseUrl}/x`, { timeoutMs: 3000, retry: { attempts: 2, backoffMs: 10 } });
        assert.equal(result.status, 200);
        assert.equal(result.text, 'ok');
        assert.equal(result.attempts, 2);
        assert.equal(server.requests.length, 2);
    } finally {
        await server.close();
    }
});

test('requestText 对普通 4xx 不重试，retry:false 完全关闭重试', async () => {
    const server = await startServer((req, res) => {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
    });
    try {
        const withRetry = await requestText(`${server.baseUrl}/x`, { timeoutMs: 3000, retry: { attempts: 3, backoffMs: 10 } });
        assert.equal(withRetry.status, 403);
        assert.equal(withRetry.attempts, 1);

        const disabled = await requestText(`${server.baseUrl}/x`, { timeoutMs: 3000, retry: false });
        assert.equal(disabled.status, 403);
        assert.equal(disabled.attempts, 1);
        assert.equal(server.requests.length, 2);
    } finally {
        await server.close();
    }
});

test('requestText 外部中止不消耗重试次数', async () => {
    const server = await startServer((req, res) => {
        setTimeout(() => {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end('late');
        }, 200);
    });
    try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(
            () => requestText(`${server.baseUrl}/x`, { timeoutMs: 3000, signal: controller.signal, retry: { attempts: 3, backoffMs: 10 } }),
            (error) => {
                assert.equal(error.name, 'AbortError');
                return true;
            }
        );
        assert.equal(server.requests.length, 1, '外部中止后不应再发起重试请求');
    } finally {
        await server.close();
    }
});

test('搜索引擎连续失败进入冷却，冷却期内直接跳过，成功后清零', async () => {
    let mode = 'fail';
    const server = await startServer((req, res) => {
        if (mode === 'fail') {
            res.writeHead(500, { 'content-type': 'text/plain' });
            res.end('boom');
            return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(searxngPayload());
    });
    const config = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'searxng',
                    searxngBaseUrl: server.baseUrl,
                    fallbackProviders: [],
                    maxResults: 3,
                    timeoutMs: 2000
                }
            }
        }
    };
    try {
        await assert.rejects(
            () => runSearch({ config, query: '熔断测试一', logger: silentLogger }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                return true;
            }
        );
        const snapshot = getProviderHealthSnapshot();
        assert.equal(snapshot.length, 1);
        assert.equal(snapshot[0].provider, 'searxng');
        assert.ok(snapshot[0].cooldownRemainingMs > 0);

        const requestCountAfterFirst = server.requests.length;
        await assert.rejects(
            () => runSearch({ config, query: '熔断测试二', logger: silentLogger }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                assert.match(error.attempts[0].error, /冷却中/);
                assert.equal(error.attempts[0].cooldown, true);
                return true;
            }
        );
        assert.equal(server.requests.length, requestCountAfterFirst, '冷却期内不应再打真实请求');

        resetProviderHealth();
        mode = 'ok';
        const result = await runSearch({ config, query: '熔断恢复', logger: silentLogger });
        assert.equal(result.ok, true);
        assert.equal(result.resultCount, 1);
        assert.equal(getProviderHealthSnapshot().length, 0);
    } finally {
        await server.close();
    }
});

test('web_search 本地链路失败后按配置走 MCP 搜索兜底', async () => {
    const calls = [];
    const fakeMcpClient = {
        getToolDefinitions: () => ([
            { serverId: 'fathom', serverName: 'fathom-search', toolName: 'image_search' },
            { serverId: 'fathom', serverName: 'fathom-search', toolName: 'search' }
        ]),
        callTool: async ({ serverId, tool, arguments: args }) => {
            calls.push({ serverId, tool, args });
            return { ok: true, text: 'MCP 返回的搜索结果文本' };
        }
    };

    const context = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    webSearch: {
                        enabled: true,
                        provider: 'tavily',
                        fallbackProviders: [],
                        mcpFallback: 'auto',
                        apiKeys: {}
                    }
                }
            }
        },
        mcpClient: fakeMcpClient,
        logger: silentLogger
    });

    const result = await context.handlers.web_search({ query: '徐缺 动图 徽章' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'mcp');
    assert.equal(result.source, 'mcp:fathom-search:search');
    assert.equal(result.text, 'MCP 返回的搜索结果文本');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, 'search');
    assert.deepEqual(calls[0].args, { text: '徐缺 动图 徽章' });
});

test('web_search 兜底可关闭，也可指定只走某个服务器', async () => {
    const calls = [];
    const baseConfig = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'tavily',
                    fallbackProviders: [],
                    apiKeys: {}
                }
            }
        }
    };
    const fakeMcpClient = (serverName) => ({
        getToolDefinitions: () => ([{ serverId: serverName, serverName, toolName: 'search' }]),
        callTool: async ({ serverName: name, tool, arguments: args }) => {
            calls.push({ serverName: name, tool, args });
            return { ok: true, text: 'ok-text' };
        }
    });

    const offContext = buildAIToolContext({
        config: { ai: { tools: { webSearch: { ...baseConfig.ai.tools.webSearch, mcpFallback: 'off' } } } },
        mcpClient: fakeMcpClient('other-server'),
        logger: silentLogger
    });
    const offResult = await offContext.handlers.web_search({ query: '关闭兜底' });
    assert.equal(offResult.ok, false);
    assert.equal(calls.length, 0, '关闭兜底时不应调用 MCP');

    const scopedContext = buildAIToolContext({
        config: { ai: { tools: { webSearch: { ...baseConfig.ai.tools.webSearch, mcpFallback: 'target-server' } } } },
        mcpClient: fakeMcpClient('other-server'),
        logger: silentLogger
    });
    const scopedResult = await scopedContext.handlers.web_search({ query: '指定服务器' });
    assert.equal(scopedResult.ok, false, '未命中指定服务器时不应兜底');

    const hitContext = buildAIToolContext({
        config: { ai: { tools: { webSearch: { ...baseConfig.ai.tools.webSearch, mcpFallback: 'target-server' } } } },
        mcpClient: fakeMcpClient('target-server'),
        logger: silentLogger
    });
    const hitResult = await hitContext.handlers.web_search({ query: '命中指定服务器' });
    assert.equal(hitResult.ok, true);
    assert.equal(hitResult.source, 'mcp:target-server:search');
});

function buildToolCallResponse(index) {
    return {
        choices: [{
            message: {
                content: null,
                tool_calls: [{
                    id: `tool-${index}`,
                    type: 'function',
                    function: { name: 'web_search', arguments: JSON.stringify({ query: `q${index}` }) }
                }]
            }
        }]
    };
}

function jsonResponse(body) {
    return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        async json() { return body; },
        async text() { return JSON.stringify(body); }
    };
}

test('chatWithTools 默认不限轮次，可连续多轮调用工具', async () => {
    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        bodies.push(body);
        const toolRounds = bodies.filter((item) => Array.isArray(item.tools)).length;
        if (toolRounds <= 5) {
            return jsonResponse(buildToolCallResponse(toolRounds));
        }
        return jsonResponse({ choices: [{ message: { content: '第六轮总结' } }] });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://primary.example/v1',
            apiKey: 'key',
            model: 'model',
            chat: {}
        });
        let executed = 0;
        const result = await client.chatWithTools(
            [{ role: 'user', content: '多轮搜索' }],
            {
                tools: [{ type: 'function', function: { name: 'web_search', description: 's', parameters: { type: 'object' } } }],
                handlers: {
                    async web_search() {
                        executed += 1;
                        return { ok: true, resultCount: 1, results: [{ title: 't', url: 'https://example.test' }] };
                    }
                }
            }
        );
        assert.equal(result.content, '第六轮总结');
        assert.equal(executed, 5, '默认不应在上限 4 轮处停下');
        assert.equal(bodies.length, 6);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('chatWithTools 配置轮次上限后在最后一轮转为无工具收尾汇总', async () => {
    const originalFetch = globalThis.fetch;
    const bodies = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (Array.isArray(body.tools)) {
            return jsonResponse(buildToolCallResponse(bodies.length));
        }
        return jsonResponse({ choices: [{ message: { content: '收尾总结' } }] });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://primary.example/v1',
            apiKey: 'key',
            model: 'model',
            chat: { maxToolRounds: 2 }
        });
        let executed = 0;
        const result = await client.chatWithTools(
            [{ role: 'user', content: '限定两轮' }],
            {
                tools: [{ type: 'function', function: { name: 'web_search', description: 's', parameters: { type: 'object' } } }],
                handlers: {
                    async web_search() {
                        executed += 1;
                        return { ok: true, resultCount: 1, results: [] };
                    }
                }
            }
        );
        assert.equal(result.content, '收尾总结');
        assert.equal(executed, 2);
        assert.equal(bodies.filter((item) => Array.isArray(item.tools)).length, 2);
        const finalBody = bodies.at(-1);
        assert.equal(finalBody.tools, undefined, '收尾请求不应再带工具');
        assert.match(finalBody.messages.at(-1).content, /工具调用上限/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
