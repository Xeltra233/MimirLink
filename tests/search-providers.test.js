import test from 'node:test';
import assert from 'node:assert/strict';

import { runSearch, normalizeWebSearchConfig, listSearchProviders } from '../src/search/index.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function jsonResponse(body, status = 200, contentType = 'application/json') {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Map([['content-type', contentType]]),
        async json() {
            return JSON.parse(text);
        },
        async text() {
            return text;
        },
        async arrayBuffer() {
            return Buffer.from(text);
        }
    };
}

function withMockFetch(handler, callback) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const parsed = new URL(String(url));
        calls.push({ url: parsed.toString(), options });
        return handler(parsed, options);
    };
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            globalThis.fetch = originalFetch;
        });
}

test('normalizeWebSearchConfig 迁移旧字段并归一化 provider', () => {
    const migrated = normalizeWebSearchConfig({
        enabled: true,
        provider: 'bing',
        apiKey: 'legacy-key',
        maxResults: 99,
        timeoutMs: 100,
        fetch: { maxChars: 99 },
        spice: { weatherDays: 99 },
        fallbackProviders: ['serpapi', 'serpapi']
    });
    assert.equal(migrated.provider, 'duckduckgo');
    assert.equal(migrated.enabled, true);
    assert.deepEqual(migrated.fallbackProviders, ['serpapi']);
    assert.equal(migrated.maxResults, 10);
    assert.equal(migrated.timeoutMs, 1000);
    assert.equal(migrated.fetch.maxChars, 500);
    assert.equal(migrated.spice.weatherDays, 7);
    assert.equal(migrated.apiKeys.tavily, '');

    const tavilyMigrated = normalizeWebSearchConfig({ provider: 'tavily', apiKey: 'tvly-123' });
    assert.equal(tavilyMigrated.apiKeys.tavily, 'tvly-123');

    const catalog = listSearchProviders();
    assert.deepEqual(catalog.map((item) => item.id), ['duckduckgo', 'searxng', 'tavily', 'brave', 'serpapi']);
    assert.equal(catalog.find((item) => item.id === 'tavily').requiresApiKey, true);
});

test('SearXNG provider 映射结果并在未开启 JSON 时给出明确错误', async () => {
    const config = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'searxng',
                    searxngBaseUrl: 'http://searx.local:8888',
                    maxResults: 3,
                    timeoutMs: 5000
                }
            }
        }
    };

    await withMockFetch((parsed) => {
        if (parsed.pathname === '/search') {
            return jsonResponse({
                results: [
                    { title: '结果一', url: 'https://example.test/one', content: '摘要一', publishedDate: '2026-09-01' },
                    { title: '结果二', url: 'https://example.test/two', content: '<b>摘要</b>二' }
                ]
            });
        }
        throw new Error(`unexpected url ${parsed}`);
    }, async () => {
        const result = await runSearch({ config, query: '测试', logger: silentLogger });
        assert.equal(result.ok, true);
        assert.equal(result.provider, 'searxng');
        assert.equal(result.source, 'searxng');
        assert.equal(result.resultCount, 2);
        assert.equal(result.results[0].snippet, '摘要一');
        assert.equal(result.results[1].snippet, '摘要 二');
    });

    await withMockFetch((parsed) => {
        if (parsed.pathname === '/search') {
            return jsonResponse('<html>forbidden</html>', 403, 'text/html');
        }
        throw new Error(`unexpected url ${parsed}`);
    }, async () => {
        await assert.rejects(
            () => runSearch({ config, query: '测试', logger: silentLogger }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                assert.match(error.attempts[0].error, /SearXNG 实例拒绝 JSON 输出/);
                return true;
            }
        );
    });

    await withMockFetch((parsed) => {
        if (parsed.pathname === '/search') {
            return jsonResponse('<html>no json</html>', 200, 'text/html');
        }
        throw new Error(`unexpected url ${parsed}`);
    }, async () => {
        await assert.rejects(
            () => runSearch({ config, query: '测试', logger: silentLogger }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                assert.match(error.attempts[0].error, /实例未返回 JSON/);
                return true;
            }
        );
    });
});

test('Tavily provider 使用 API Key 并映射结果', async () => {
    const config = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'tavily',
                    apiKeys: { tavily: 'tvly-test' },
                    maxResults: 2,
                    timeoutMs: 5000
                }
            }
        }
    };

    await withMockFetch((parsed, options) => {
        assert.equal(parsed.hostname, 'api.tavily.com');
        const body = JSON.parse(options.body);
        assert.equal(body.api_key, 'tvly-test');
        assert.equal(body.query, '最新消息');
        return jsonResponse({
            results: [
                { title: 'Tavily A', url: 'https://example.test/a', content: '内容 A', published_date: '2026-09-01' },
                { title: 'Tavily B', url: 'https://example.test/b', content: '内容 B' }
            ]
        });
    }, async () => {
        const result = await runSearch({ config, query: '最新消息', topic: 'news', logger: silentLogger });
        assert.equal(result.source, 'tavily');
        assert.equal(result.resultCount, 2);
        assert.equal(result.results[0].publishedAt, '2026-09-01');
    });

    // 未配置 Key 时跳过该 provider
    await withMockFetch(() => {
        throw new Error('should not call network without api key');
    }, async () => {
        await assert.rejects(
            () => runSearch({
                config: { ai: { tools: { webSearch: { enabled: true, provider: 'tavily' } } } },
                query: '测试',
                logger: silentLogger
            }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                assert.equal(error.attempts[0].error, '未配置 API Key');
                return true;
            }
        );
    });
});

test('Brave / SerpAPI provider 映射各自的响应结构', async () => {
    const braveConfig = {
        ai: {
            tools: {
                webSearch: { enabled: true, provider: 'brave', apiKeys: { brave: 'brave-key' }, maxResults: 2, timeoutMs: 5000 }
            }
        }
    };
    await withMockFetch((parsed, options) => {
        assert.equal(parsed.hostname, 'api.search.brave.com');
        assert.equal(options.headers['X-Subscription-Token'], 'brave-key');
        return jsonResponse({
            web: {
                results: [
                    { title: 'Brave A', url: 'https://example.test/brave-a', description: '<b>Brave</b> 摘要 A' },
                    { title: 'Brave B', url: 'https://example.test/brave-b', description: 'Brave 摘要 B', page_age: '2026-09-02' }
                ]
            }
        });
    }, async () => {
        const result = await runSearch({ config: braveConfig, query: '测试', logger: silentLogger });
        assert.equal(result.source, 'brave');
        assert.equal(result.results[0].snippet, 'Brave 摘要 A');
        assert.equal(result.results[1].publishedAt, '2026-09-02');
    });

    const serpConfig = {
        ai: {
            tools: {
                webSearch: { enabled: true, provider: 'serpapi', apiKeys: { serpapi: 'serp-key' }, maxResults: 2, timeoutMs: 5000 }
            }
        }
    };
    await withMockFetch((parsed) => {
        assert.equal(parsed.hostname, 'serpapi.com');
        assert.equal(parsed.searchParams.get('api_key'), 'serp-key');
        return jsonResponse({
            organic_results: [
                { title: 'Serp A', link: 'https://example.test/serp-a', snippet: 'Serp 摘要 A' },
                { title: 'Serp B', link: 'https://example.test/serp-b', snippet: 'Serp 摘要 B', date: '2026-09-03' }
            ]
        });
    }, async () => {
        const result = await runSearch({ config: serpConfig, query: '测试', logger: silentLogger });
        assert.equal(result.source, 'serpapi');
        assert.equal(result.results[0].url, 'https://example.test/serp-a');
        assert.equal(result.results[1].publishedAt, '2026-09-03');
    });
});

test('回退链在主 provider 失败后继续，并记录 attempts', async () => {
    const config = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'searxng',
                    searxngBaseUrl: 'http://searx.local:8888',
                    fallbackProviders: ['duckduckgo'],
                    maxResults: 2,
                    timeoutMs: 5000
                }
            }
        }
    };

    await withMockFetch((parsed) => {
        if (parsed.hostname === 'searx.local') {
            return jsonResponse('boom', 500, 'text/html');
        }
        if (parsed.hostname === 'html.duckduckgo.com') {
            return jsonResponse(`
                <div class="result__body">
                  <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent('https://example.test/fallback')}">回退结果</a></h2>
                  <a class="result__snippet" href="#">回退摘要</a>
                </div>`, 200, 'text/html');
        }
        throw new Error(`unexpected url ${parsed}`);
    }, async () => {
        const result = await runSearch({ config, query: '测试', logger: silentLogger });
        assert.equal(result.ok, true);
        assert.equal(result.provider, 'duckduckgo');
        assert.equal(result.results[0].url, 'https://example.test/fallback');
        assert.equal(result.attempts.length, 2);
        assert.equal(result.attempts[0].provider, 'searxng');
        assert.ok(result.attempts[0].error);
        assert.equal(result.attempts[1].provider, 'duckduckgo');
        assert.equal(result.attempts[1].resultCount, 1);
    });
});

test('域名黑白名单在统一出口过滤结果', async () => {
    const baseConfig = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'searxng',
                    searxngBaseUrl: 'http://searx.local:8888',
                    maxResults: 5,
                    timeoutMs: 5000
                }
            }
        }
    };

    const blockedConfig = JSON.parse(JSON.stringify(baseConfig));
    blockedConfig.ai.tools.webSearch.blockedDomains = ['blocked.test'];

    await withMockFetch((parsed) => jsonResponse({
        results: [
            { title: '可访问', url: 'https://ok.test/a', content: 'ok' },
            { title: '被屏蔽', url: 'https://blocked.test/b', content: 'blocked' }
        ]
    }), async () => {
        const result = await runSearch({ config: blockedConfig, query: '测试', logger: silentLogger });
        assert.equal(result.resultCount, 1);
        assert.equal(result.results[0].url, 'https://ok.test/a');
    });

    const allowedConfig = JSON.parse(JSON.stringify(baseConfig));
    allowedConfig.ai.tools.webSearch.allowedDomains = ['only.test'];

    await withMockFetch((parsed) => jsonResponse({
        results: [
            { title: '可访问', url: 'https://only.test/a', content: 'ok' },
            { title: '被过滤', url: 'https://other.test/b', content: 'no' }
        ]
    }), async () => {
        const result = await runSearch({ config: allowedConfig, query: '测试', logger: silentLogger });
        assert.equal(result.resultCount, 1);
        assert.equal(result.results[0].url, 'https://only.test/a');
    });
});

test('所有 provider 失败时抛出带 attempts 的 SEARCH_EMPTY 错误', async () => {
    const config = {
        ai: {
            tools: {
                webSearch: {
                    enabled: true,
                    provider: 'searxng',
                    searxngBaseUrl: 'http://searx.local:8888',
                    fallbackProviders: ['tavily'],
                    apiKeys: { tavily: 'tvly-test' },
                    timeoutMs: 5000
                }
            }
        }
    };

    await withMockFetch((parsed) => {
        if (parsed.hostname === 'searx.local') {
            return jsonResponse('error', 500, 'text/html');
        }
        return jsonResponse('bad key', 401);
    }, async () => {
        await assert.rejects(
            () => runSearch({ config, query: '测试', logger: silentLogger }),
            (error) => {
                assert.equal(error.code, 'SEARCH_EMPTY');
                assert.equal(error.attempts.length, 2);
                assert.match(error.attempts[1].error, /API Key 无效/);
                return true;
            }
        );
    });
});
