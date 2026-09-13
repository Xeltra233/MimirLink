/**
 * DuckDuckGo 搜索 Provider
 *
 * 移植来源（均为 MIT 许可证）：
 * - deedy5/ddgs（https://github.com/deedy5/ddgs）：html/lite 端点 payload 与解析流程、news.js 参数
 * - Snazzah/duck-duck-scrape v2.2.7（https://github.com/Snazzah/duck-duck-scrape）：
 *   vqd 提取正则、浏览器请求头、异常页检测思路
 *
 * 实测说明（2026-09）：上游 d.js JSON 接口已加 JS challenge（jsa_hash），
 * 因此本移植使用 html.duckduckgo.com/html/（POST）为主、lite.duckduckgo.com/lite/ 为兜底，
 * 新闻使用 duckduckgo.com/news.js + vqd。
 */

import { requestJson, requestText, clampInteger, isAbortError } from '../http.js';
import { extractDuckDuckGoHtmlResults, extractDuckDuckGoLiteResults, isDuckDuckGoChallenge, decodeHtmlText } from '../html.js';

const SEARCH_HTML_URL = 'https://html.duckduckgo.com/html/';
const SEARCH_LITE_URL = 'https://lite.duckduckgo.com/lite/';
const NEWS_URL = 'https://duckduckgo.com/news.js';
const VQD_URL = 'https://duckduckgo.com/';
const VQD_REGEX = /vqd=['"](\d+-\d+(?:-\d+)?)['"]/;
const VQD_CACHE_TTL_MS = 5 * 60 * 1000;
const vqdCache = new Map();

const TIME_RANGE_MAP = {
    day: 'd',
    week: 'w',
    month: 'm',
    year: 'y'
};

const SAFE_SEARCH_MAP = {
    on: '1',
    strict: '1',
    moderate: '-1',
    off: '-2'
};

function resolveTimeRange(timeRange) {
    const normalized = String(timeRange || 'all').toLowerCase();
    return TIME_RANGE_MAP[normalized] || '';
}

function buildQuery(ctx) {
    const query = String(ctx.query || '').trim();
    const site = String(ctx.site || '').trim();
    if (!site) {
        return query;
    }
    return `site:${site} ${query}`;
}

async function getVqd(query, ctx) {
    const cached = vqdCache.get(query);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.vqd;
    }

    const url = `${VQD_URL}?${new URLSearchParams({ q: query, ia: 'web' }).toString()}`;
    let response;
    try {
        response = await requestText(url, {
            headers: { Accept: 'text/html,application/xhtml+xml' },
            timeoutMs: ctx.timeoutMs,
            signal: ctx.signal
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        throw new Error(`获取 DuckDuckGo vqd 失败: ${error.message}`);
    }

    const match = VQD_REGEX.exec(response.text || '');
    if (!match) {
        throw new Error('获取 DuckDuckGo vqd 失败：页面未返回令牌（可能被反爬拦截）');
    }

    vqdCache.set(query, { vqd: match[1], expiresAt: Date.now() + VQD_CACHE_TTL_MS });
    return match[1];
}

async function searchWebHtml(ctx, query, limit) {
    const params = {
        q: query,
        l: ctx.region || 'cn-zh'
    };
    const timeRange = resolveTimeRange(ctx.timeRange);
    if (timeRange) {
        params.df = timeRange;
    }

    // 实测（2026-09）：对 html 端点 POST 会被判定为异常流量（202 挑战页），GET 正常返回结果
    const response = await requestText(`${SEARCH_HTML_URL}?${new URLSearchParams(params).toString()}`, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal
    });

    if (!response.ok) {
        throw new Error(`DuckDuckGo 网页搜索返回 HTTP ${response.status}`);
    }
    if (isDuckDuckGoChallenge(response.text)) {
        throw new Error('DuckDuckGo 触发反爬验证（html 端点被拦截）');
    }

    const results = extractDuckDuckGoHtmlResults(response.text, limit);
    return { source: 'duckduckgo_html', results };
}

async function searchWebLite(ctx, query, limit) {
    const params = {
        q: query,
        kl: ctx.region || 'cn-zh'
    };
    const timeRange = resolveTimeRange(ctx.timeRange);
    if (timeRange) {
        params.df = timeRange;
    }

    const response = await requestText(`${SEARCH_LITE_URL}?${new URLSearchParams(params).toString()}`, {
        headers: { Accept: 'text/html,application/xhtml+xml' },
        timeoutMs: ctx.timeoutMs,
        signal: ctx.signal
    });

    if (!response.ok) {
        throw new Error(`DuckDuckGo lite 搜索返回 HTTP ${response.status}`);
    }
    if (isDuckDuckGoChallenge(response.text)) {
        throw new Error('DuckDuckGo 触发反爬验证（lite 端点被拦截）');
    }

    const results = extractDuckDuckGoLiteResults(response.text, limit);
    return { source: 'duckduckgo_lite', results };
}

async function searchWeb(ctx) {
    const limit = clampInteger(ctx.limit, 1, 10, 5);
    const query = buildQuery(ctx);
    const failures = [];

    for (const attempt of [searchWebHtml, searchWebLite]) {
        try {
            const result = await attempt(ctx, query, limit);
            if (result.results.length > 0) {
                return result;
            }
            failures.push(`${result.source}: 无结果`);
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            failures.push(error.message);
        }
    }

    if (failures.every((message) => message.endsWith('无结果'))) {
        return { source: 'duckduckgo_html', results: [] };
    }

    throw new Error(`DuckDuckGo 搜索失败：${failures.join('；')}`);
}

async function searchNews(ctx) {
    const limit = clampInteger(ctx.limit, 1, 10, 5);
    const query = buildQuery(ctx);
    const vqd = await getVqd(query, ctx);
    const params = {
        l: ctx.region || 'cn-zh',
        o: 'json',
        noamp: '1',
        q: query,
        vqd,
        p: SAFE_SEARCH_MAP[String(ctx.safeSearch || 'moderate').toLowerCase()] || '-1'
    };
    const timeRange = resolveTimeRange(ctx.timeRange);
    if (timeRange) {
        params.df = timeRange;
    }

    let payload;
    try {
        payload = await requestJson(`${NEWS_URL}?${new URLSearchParams(params).toString()}`, {
            timeoutMs: ctx.timeoutMs,
            signal: ctx.signal
        });
    } catch (error) {
        if (isAbortError(error)) {
            throw error;
        }
        if (error.status === 403) {
            throw new Error('DuckDuckGo 新闻接口拒绝访问（HTTP 403）');
        }
        throw new Error(`DuckDuckGo 新闻搜索失败: ${error.message}`);
    }

    const items = Array.isArray(payload?.results) ? payload.results : [];
    const results = items.slice(0, limit).map((item) => ({
        title: decodeHtmlText(item.title || ''),
        url: String(item.url || ''),
        snippet: decodeHtmlText(item.excerpt || item.body || ''),
        publishedAt: item.date ? new Date(item.date * 1000).toISOString() : (item.relative_time || '')
    })).filter((item) => item.url);

    return { source: 'duckduckgo_news', results };
}

export const duckduckgoProvider = {
    id: 'duckduckgo',
    label: 'DuckDuckGo（免 Key）',
    requiresApiKey: false,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        if (String(ctx.topic || 'web').toLowerCase() === 'news') {
            return searchNews(ctx);
        }
        return searchWeb(ctx);
    }
};
