/**
 * SerpAPI Provider（Google 结果 API，需 API Key）
 * 文档：https://serpapi.com/search-api
 */

import { requestText, clampInteger, isAbortError } from '../http.js';

export const serpapiProvider = {
    id: 'serpapi',
    label: 'SerpAPI（Google/Google News，需 API Key）',
    requiresApiKey: true,
    supportsNews: true,
    supportsTimeRange: false,
    supportsSite: true,
    async search(ctx) {
        if (!ctx.apiKey) {
            throw new Error('未配置 SerpAPI API Key');
        }

        const limit = clampInteger(ctx.limit, 1, 10, 5);
        const topic = String(ctx.topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
        const query = ctx.site ? `site:${ctx.site} ${ctx.query}` : String(ctx.query || '');
        const params = new URLSearchParams({
            engine: topic === 'news' ? 'google_news' : 'google',
            q: query,
            api_key: ctx.apiKey,
            hl: 'zh-cn',
            gl: 'cn',
            num: String(limit)
        });

        let response;
        try {
            response = await requestText(`https://serpapi.com/search.json?${params.toString()}`, {
                headers: { Accept: 'application/json' },
                timeoutMs: ctx.timeoutMs,
                signal: ctx.signal
            });
        } catch (error) {
            if (isAbortError(error)) {
                throw error;
            }
            throw new Error(`SerpAPI 请求失败: ${error.message}`);
        }

        if (!response.ok) {
            if (response.status === 401) {
                throw new Error('SerpAPI API Key 无效');
            }
            if (response.status === 429) {
                throw new Error('SerpAPI 触发限流或额度耗尽（HTTP 429）');
            }
            throw new Error(`SerpAPI 返回 HTTP ${response.status}`);
        }

        let payload;
        try {
            payload = JSON.parse(response.text);
        } catch {
            throw new Error('SerpAPI 返回内容不是合法 JSON');
        }

        if (payload?.error) {
            throw new Error(`SerpAPI 错误: ${payload.error}`);
        }

        const items = topic === 'news'
            ? (Array.isArray(payload?.news_results) ? payload.news_results : [])
            : (Array.isArray(payload?.organic_results) ? payload.organic_results : []);

        const results = items.slice(0, limit).map((item) => {
            const nested = Array.isArray(item.stories) ? item.stories[0] : null;
            const source = nested || item;
            return {
                title: String(source.title || ''),
                url: String(source.link || source.url || ''),
                snippet: String(source.snippet || source.description || ''),
                publishedAt: source.date || ''
            };
        }).filter((item) => item.url);

        return { source: 'serpapi', results };
    }
};
