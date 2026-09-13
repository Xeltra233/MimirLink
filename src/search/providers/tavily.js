/**
 * Tavily 搜索 Provider（需 API Key）
 * 文档：https://docs.tavily.com/documentation/api-reference/endpoint/search
 */

import { requestText, clampInteger, isAbortError } from '../http.js';

const NEWS_DAYS_MAP = {
    day: 1,
    week: 7,
    month: 30,
    year: 365
};

export const tavilyProvider = {
    id: 'tavily',
    label: 'Tavily（需 API Key）',
    requiresApiKey: true,
    supportsNews: true,
    supportsTimeRange: true,
    supportsSite: true,
    async search(ctx) {
        if (!ctx.apiKey) {
            throw new Error('未配置 Tavily API Key');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase() === 'news' ? 'news' : 'general';
        const body = {
            api_key: ctx.apiKey,
            query: String(ctx.query || ''),
            max_results: limit,
            topic,
            search_depth: 'basic',
            include_answer: false,
            include_raw_content: false
        };
        if (ctx.site) {
            body.include_domains = [String(ctx.site)];
        }
        const timeRange = String(ctx.timeRange || 'all').toLowerCase();
        if (topic === 'news' && NEWS_DAYS_MAP[timeRange]) {
            body.days = NEWS_DAYS_MAP[timeRange];
        }

        let response;
        try {
            response = await requestText('https://api.tavily.com/search', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body),
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`Tavily 请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                throw new Error('Tavily API Key 无效或已过期');
            }
            if (response.status === 429) {
                throw new Error('Tavily 触发限流（HTTP 429），请稍后再试');
            }
            throw new Error(`Tavily 返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('Tavily 返回内容不是合法 JSON');
        }

        const items = Array.isArray(payload?.results) ? payload.results : [];
        const results = items.slice(0, limit).map((item) => ({
            title: String(item.title || ''),
            url: String(item.url || ''),
            snippet: String(item.content || ''),
            publishedAt: item.published_date || ''
        })).filter((item) => item.url);

        return { source: 'tavily', results };
    }
};
