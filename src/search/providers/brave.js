/**
 * Brave Search API Provider（需 API Key）
 * 文档：https://api-dashboard.search.brave.com/app/documentation
 */

import { requestText, clampInteger, isAbortError } from '../http.js';
import { stripHtml } from '../html.js';

const FRESHNESS_MAP = {
    day: 'pd',
    week: 'pw',
    month: 'pm',
    year: 'py'
};

const SAFE_SEARCH_MAP = {
    off: 'off',
    moderate: 'moderate',
    strict: 'strict'
};

export const braveProvider = {
    id: 'brave',
    label: 'Brave Search（需 API Key）',
    requiresApiKey: true,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        if (!ctx.apiKey) {
            throw new Error('未配置 Brave API Key');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
        const query = ctx.site ? `site:${ctx.site} ${ctx.query}` : String(ctx.query || '');
        const params = new URLSearchParams({
            q: query,
            count: String(limit),
            country: 'cn',
            search_lang: 'zh-hans',
            safesearch: SAFE_SEARCH_MAP[String(ctx.safeSearch || 'moderate').toLowerCase()] || 'moderate'
        });
        const freshness = FRESHNESS_MAP[String(ctx.timeRange || 'all').toLowerCase()];
        if (freshness) {
            params.set('freshness', freshness);
        }

        const endpoint = topic === 'news'
            ? `https://api.search.brave.com/res/v1/news/search?${params.toString()}`
            : `https://api.search.brave.com/res/v1/web/search?${params.toString()}`;

        let response;
        try {
            response = await requestText(endpoint, {
                headers: {
                    Accept: 'application/json',
                    'X-Subscription-Token': ctx.apiKey
                },
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`Brave 请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('Brave API Key 无效或套餐不支持该接口');
            }
            if (response.status === 429) {
                throw new Error('Brave 触发限流（HTTP 429），请稍后再试');
            }
            throw new Error(`Brave 返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('Brave 返回内容不是合法 JSON');
        }

        const items = topic === 'news'
            ? (Array.isArray(payload?.results) ? payload.results : [])
            : (Array.isArray(payload?.web?.results) ? payload.web.results : []);

        const results = items.slice(0, limit).map((item) => ({
            title: stripHtml(item.title || ''),
            url: String(item.url || ''),
            snippet: stripHtml(item.description || ''),
            publishedAt: item.page_age || item.age || ''
        })).filter((item) => item.url);

        return { source: 'brave', results };
    }
};
