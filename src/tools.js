import { buildMentionMessage } from './onebot.js';

function sanitizeText(value) {
    return String(value || '').replace(/\r/g, '').trim();
}

function toComparableId(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.floor(normalized);
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = toPositiveInteger(value, fallback);
    return Math.min(maximum, Math.max(minimum, normalized));
}

function truncateText(value, maxLength) {
    const text = sanitizeText(value);
    if (!text) {
        return '';
    }

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeText(value, maxLength = 120) {
    const text = sanitizeText(value);
    return {
        length: text.length,
        preview: truncateText(text, maxLength)
    };
}

export function buildVoicePrefaceText(value) {
    const text = sanitizeText(value);
    if (!text) {
        return '我给你发了一条语音，请听一下。';
    }

    const preview = truncateText(text, 40);
    return `我给你发了一条语音：${preview}`;
}

function stripHtml(value) {
    return sanitizeText(String(value || '').replace(/<[^>]*>/g, ' '));
}

function matchesDomainFilter(hostname, domain) {
    const normalizedHost = sanitizeText(hostname).toLowerCase();
    const normalizedDomain = sanitizeText(domain).toLowerCase();
    if (!normalizedHost || !normalizedDomain) {
        return false;
    }

    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function isUrlAllowed(url, allowedDomains = [], blockedDomains = []) {
    let hostname = '';
    try {
        hostname = new URL(url).hostname || '';
    } catch {
        return false;
    }

    if (blockedDomains.some((domain) => matchesDomainFilter(hostname, domain))) {
        return false;
    }

    if (allowedDomains.length > 0 && !allowedDomains.some((domain) => matchesDomainFilter(hostname, domain))) {
        return false;
    }

    return true;
}

function collectDuckDuckGoTopics(items, bucket = []) {
    for (const item of Array.isArray(items) ? items : []) {
        if (Array.isArray(item?.Topics)) {
            collectDuckDuckGoTopics(item.Topics, bucket);
            continue;
        }

        bucket.push(item);
    }

    return bucket;
}

function normalizeSearchResults(payload = {}, options = {}) {
    const maxResults = clampInteger(options.maxResults, 1, 8, 5);
    const maxSnippetLength = clampInteger(options.maxSnippetLength, 100, 4000, 800);
    const allowedDomains = Array.isArray(options.allowedDomains) ? options.allowedDomains : [];
    const blockedDomains = Array.isArray(options.blockedDomains) ? options.blockedDomains : [];
    const results = [];
    const seenUrls = new Set();

    const pushResult = ({ title, url, snippet }) => {
        const normalizedUrl = sanitizeText(url);
        if (!normalizedUrl || seenUrls.has(normalizedUrl)) {
            return;
        }
        if (!isUrlAllowed(normalizedUrl, allowedDomains, blockedDomains)) {
            return;
        }

        const normalizedTitle = truncateText(title || normalizedUrl, 200);
        const normalizedSnippet = truncateText(snippet, maxSnippetLength);
        results.push({
            title: normalizedTitle || normalizedUrl,
            url: normalizedUrl,
            snippet: normalizedSnippet
        });
        seenUrls.add(normalizedUrl);
    };

    if (payload?.AbstractURL || payload?.AbstractText) {
        pushResult({
            title: payload?.Heading || payload?.AbstractSource || payload?.AbstractURL,
            url: payload?.AbstractURL,
            snippet: payload?.AbstractText
        });
    }

    const answerText = sanitizeText(payload?.Answer || payload?.Definition || payload?.Abstract || '');
    if (answerText) {
        pushResult({
            title: payload?.Heading || '即时答案',
            url: payload?.AbstractURL || payload?.DefinitionURL || `https://duckduckgo.com/?q=${encodeURIComponent(payload?.Heading || payload?.Answer || '')}`,
            snippet: answerText
        });
    }

    for (const item of collectDuckDuckGoTopics(payload?.RelatedTopics || [])) {
        if (results.length >= maxResults) {
            break;
        }

        const url = item?.FirstURL;
        const text = stripHtml(item?.Text || item?.Result || '');
        if (!url || !text) {
            continue;
        }

        const [titlePart, ...rest] = text.split(' - ');
        pushResult({
            title: titlePart,
            url,
            snippet: rest.join(' - ') || text
        });
    }

    if (results.length === 0) {
        const instantAnswer = sanitizeText(payload?.Answer || payload?.AbstractText || payload?.Definition || '');
        if (instantAnswer) {
            pushResult({
                title: payload?.Heading || '搜索结果',
                url: payload?.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(payload?.Heading || instantAnswer)}`,
                snippet: instantAnswer
            });
        }
    }

    return results.slice(0, maxResults);
}

function unwrapSearchResultUrl(rawUrl = '', baseUrl = '') {
    const value = stripHtml(sanitizeText(rawUrl));
    if (!value) {
        return '';
    }

    try {
        const normalizedValue = value.replace(/&amp;/g, '&');
        const parsed = new URL(normalizedValue.startsWith('//') ? `https:${normalizedValue}` : normalizedValue, baseUrl || undefined);
        const nestedUrl = parsed.searchParams.get('url') || parsed.searchParams.get('u') || parsed.searchParams.get('uddg') || parsed.searchParams.get('q');
        if (nestedUrl) {
            if (/^https?:\/\//i.test(nestedUrl)) {
                return nestedUrl;
            }
            if (/^a1[a-z0-9_-]+$/i.test(nestedUrl)) {
                try {
                    const decoded = Buffer.from(nestedUrl.slice(2).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
                    if (/^https?:\/\//i.test(decoded)) {
                        return decoded;
                    }
                } catch {
                    // 继续尝试下一个系统浏览器通道?
                }
            }
        }
        if (/^https?:\/\//i.test(parsed.href)) {
            return parsed.href;
        }
    } catch {
        if (/^https?:\/\//i.test(value)) {
            return value;
        }
    }

    return '';
}

function isSearchEngineInternalUrl(url = '') {
    try {
        const hostname = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
        return ['google.com', 'bing.com', 'duckduckgo.com', 'brave.com', 'search.brave.com'].some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    } catch {
        return true;
    }
}

function extractSerpLinksFromHtml(html = '', options = {}) {
    const allowedDomains = Array.isArray(options.allowedDomains) ? options.allowedDomains : [];
    const blockedDomains = Array.isArray(options.blockedDomains) ? options.blockedDomains : [];
    const maxResults = clampInteger(options.maxResults, 1, 8, 5);
    const maxSnippetLength = clampInteger(options.maxSnippetLength, 100, 4000, 800);
    const baseUrl = sanitizeText(options.baseUrl || '');
    const results = [];
    const seenUrls = new Set();
    const anchorRegex = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match;

    while ((match = anchorRegex.exec(html)) !== null) {
        if (results.length >= maxResults) {
            break;
        }
        const url = unwrapSearchResultUrl(match[1], baseUrl);
        const title = stripHtml(match[2] || '');
        if (!url || !title || seenUrls.has(url) || isSearchEngineInternalUrl(url) || /[?&](ad_|ad_domain|ad_provider|ad_type|click_metadata|u3=)/i.test(url)) {
            continue;
        }
        if (!isUrlAllowed(url, allowedDomains, blockedDomains)) {
            continue;
        }
        const snippet = title;
        results.push({
            title: truncateText(title, 200),
            url,
            snippet: truncateText(snippet, maxSnippetLength)
        });
        seenUrls.add(url);
    }

    return results;
}

function buildSearchRequestHeaders(apiKey = '') {
    const headers = {
        'Accept': 'application/json, text/html, application/xhtml+xml'
    };
    if (apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
        headers['X-API-Key'] = apiKey;
    }
    return headers;
}

const REALTIME_INTENT_RULES = [
    { intent: 'weather', pattern: /天气|气温|温度|下雨|降雨|湿度|风力|weather|forecast|temperature|rain|snow/i },
    { intent: 'time', pattern: /几点|现在时间|当前时间|北京时间|日期|几号|星期几|today|date|time now|current time/i },
    { intent: 'exchange', pattern: /汇率|兑换|美元兑|人民币兑|usd|cny|hkd|jpy|eur|exchange rate|forex/i },
    { intent: 'news', pattern: /新闻|最新消息|最新动态|热搜|头条|breaking news|headline|news/i },
    { intent: 'transport', pattern: /航班|列车|高铁|火车票|路况|堵车|flight|train|traffic/i },
    { intent: 'sports', pattern: /比赛|比分|赛程|战绩|score|match|fixture|standings/i },
    { intent: 'market', pattern: /油价|金价|股价|币价|指数|price today|stock price|market price/i }
];

const REALTIME_INTENT_PROTOTYPES = [
    { intent: 'weather', text: '杭州今天天气怎么样' },
    { intent: 'weather', text: '明天会不会下雨' },
    { intent: 'weather', text: '上海现在气温多少' },
    { intent: 'time', text: '现在北京时间几点' },
    { intent: 'time', text: '今天几号星期几' },
    { intent: 'exchange', text: '今天美元兑人民币汇率' },
    { intent: 'exchange', text: '港币兑人民币现在多少' },
    { intent: 'news', text: '最新国际新闻' },
    { intent: 'news', text: '今天有什么热搜' },
    { intent: 'transport', text: '今天北京到上海航班延误吗' },
    { intent: 'transport', text: '现在高速路况怎么样' },
    { intent: 'sports', text: '今天比赛比分' },
    { intent: 'sports', text: '这场球赛结果怎么样' },
    { intent: 'market', text: '今天油价多少' },
    { intent: 'market', text: '现在黄金价格多少' }
];

function normalizeIntentText(value = '') {
    return sanitizeText(value)
        .toLowerCase()
        .replace(/[0-9０-９:：/\-]/g, ' ')
        .replace(/[？?！!，,。；;、“”"'（）()\[\]{}]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildCharacterBigrams(value = '') {
    const normalized = normalizeIntentText(value).replace(/\s+/g, '');
    if (!normalized) {
        return new Map();
    }

    const grams = new Map();
    if (normalized.length === 1) {
        grams.set(normalized, 1);
        return grams;
    }

    for (let index = 0; index < normalized.length - 1; index += 1) {
        const gram = normalized.slice(index, index + 2);
        grams.set(gram, (grams.get(gram) || 0) + 1);
    }
    return grams;
}

function computeCosineSimilarity(leftText = '', rightText = '') {
    const left = buildCharacterBigrams(leftText);
    const right = buildCharacterBigrams(rightText);
    if (left.size === 0 || right.size === 0) {
        return 0;
    }

    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;

    for (const value of left.values()) {
        leftNorm += value * value;
    }
    for (const value of right.values()) {
        rightNorm += value * value;
    }
    for (const [gram, value] of left.entries()) {
        dot += value * (right.get(gram) || 0);
    }

    if (leftNorm === 0 || rightNorm === 0) {
        return 0;
    }
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function matchRealtimeIntent(query = '') {
    const normalized = normalizeIntentText(query);
    if (!normalized) {
        return {
            matched: false,
            reason: 'empty',
            intent: '',
            score: 0,
            threshold: 0.46,
            matchedPrototype: ''
        };
    }

    for (const rule of REALTIME_INTENT_RULES) {
        if (rule.pattern.test(normalized)) {
            return {
                matched: true,
                reason: 'rule',
                intent: rule.intent,
                score: 1,
                threshold: 0.46,
                matchedPrototype: ''
            };
        }
    }

    let bestMatch = {
        matched: false,
        reason: 'prototype',
        intent: '',
        score: 0,
        threshold: 0.46,
        matchedPrototype: ''
    };

    for (const prototype of REALTIME_INTENT_PROTOTYPES) {
        const score = computeCosineSimilarity(normalized, prototype.text);
        if (score > bestMatch.score) {
            bestMatch = {
                matched: score >= 0.46,
                reason: 'prototype',
                intent: prototype.intent,
                score,
                threshold: 0.46,
                matchedPrototype: prototype.text
            };
        }
    }

    return bestMatch;
}

function isRealtimeQuery(query = '') {
    return matchRealtimeIntent(query).matched;
}

function buildRealtimeSearchPrompt(query = '', provider = 'duckduckgo') {
    const normalizedQuery = sanitizeText(query);
    return [
        `你当前可用联网工具: web_search（provider=${provider || 'duckduckgo'}）。`,
        '下面这些问题默认必须优先联网，不要靠常识硬答：天气、新闻、最新动态、时间日期、汇率、价格、比分、航班、列车、路况等实时信息。',
        '如果用户的问题明显依赖实时或外部事实，先调用 web_search，再根据搜索结果回答。',
        '如果搜索结果不足，也要先明确说“我刚查到/没查到什么”，不要直接说自己不能联网。',
        normalizedQuery ? `当前这条用户问题也要按“优先联网”处理：${normalizedQuery}` : ''
    ].filter(Boolean).join('\n');
}

function isWeatherQuery(query = '') {
    const normalized = sanitizeText(query).toLowerCase();
    if (!normalized) {
        return false;
    }

    return /天气|气温|温度|下雨|降雨|湿度|风力|weather|forecast|temperature|rain|snow/.test(normalized);
}

function normalizeWeatherLocation(query = '') {
    const normalized = sanitizeText(query)
        .replace(/今天|今日|明天|后天|这周|本周|现在|当前/g, ' ')
        .replace(/天气预报|天气情况|天气怎么样|天气如何|气温多少|温度多少/g, ' ')
        .replace(/weather forecast|weather|forecast|temperature/gi, ' ')
        .replace(/[？?！!,，。]/g, ' ')
        .trim();

    return normalized || sanitizeText(query);
}

function buildWeatherSnippet(current = {}) {
    const parts = [];
    const temp = sanitizeText(current.temp_C || current.temp_F || '');
    const feelsLike = sanitizeText(current.FeelsLikeC || current.FeelsLikeF || '');
    const humidity = sanitizeText(current.humidity || '');
    const wind = sanitizeText(current.windspeedKmph || current.windspeedMiles || '');
    const description = Array.isArray(current.weatherDesc) ? sanitizeText(current.weatherDesc[0]?.value || '') : '';

    if (description) {
        parts.push(description);
    }
    if (temp) {
        parts.push(`气温 ${temp}°C`);
    }
    if (feelsLike) {
        parts.push(`体感 ${feelsLike}°C`);
    }
    if (humidity) {
        parts.push(`湿度 ${humidity}%`);
    }
    if (wind) {
        parts.push(`风速 ${wind} km/h`);
    }

    return parts.join('，');
}

async function runWeatherDirectSearch({ query, maxSnippetLength, signal }) {
    const location = normalizeWeatherLocation(query);
    const weatherUrl = `https://wttr.in/${encodeURIComponent(location)}?format=j1`;
    const response = await fetch(weatherUrl, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json'
        }
    });

    if (!response.ok) {
        throw new Error(`天气服务返回错误: ${response.status}`);
    }

    const payload = await response.json();
    const current = Array.isArray(payload?.current_condition) ? payload.current_condition[0] || {} : {};
    const nearestArea = Array.isArray(payload?.nearest_area) ? payload.nearest_area[0] || {} : {};
    const areaName = Array.isArray(nearestArea?.areaName) ? sanitizeText(nearestArea.areaName[0]?.value || '') : '';
    const regionName = Array.isArray(nearestArea?.region) ? sanitizeText(nearestArea.region[0]?.value || '') : '';
    const countryName = Array.isArray(nearestArea?.country) ? sanitizeText(nearestArea.country[0]?.value || '') : '';
    const resolvedName = [areaName, regionName, countryName].filter(Boolean).join(' / ') || location;
    const snippet = truncateText(buildWeatherSnippet(current), maxSnippetLength);

    if (!snippet) {
        return { source: 'wttr_in', results: [] };
    }

    return {
        source: 'wttr_in',
        results: [{
            title: `${resolvedName} 天气`,
            url: `https://wttr.in/${encodeURIComponent(location)}`,
            snippet
        }]
    };
}

async function runDuckDuckGoSearch({ query, limit, timeoutMs, maxSnippetLength, allowedDomains, blockedDomains, signal, logger, startedAt }) {
    let results = [];
    let source = 'duckduckgo_json';
    const jsonUrl = new URL('https://api.duckduckgo.com/');
    jsonUrl.searchParams.set('q', query);
    jsonUrl.searchParams.set('format', 'json');
    jsonUrl.searchParams.set('no_html', '1');
    jsonUrl.searchParams.set('skip_disambig', '1');
    jsonUrl.searchParams.set('no_redirect', '1');

    try {
        const response = await fetch(jsonUrl, {
            method: 'GET',
            signal,
            headers: {
                Accept: 'application/json'
            }
        });

        if (response.ok) {
            const payload = await response.json();
            results = normalizeSearchResults(payload, {
                maxResults: limit,
                maxSnippetLength,
                allowedDomains,
                blockedDomains
            });
        } else {
            logger?.warn?.('[工具] web_search JSON 请求返回异常状态', {
                query: summarizeText(query),
                limit,
                timeoutMs,
                status: response.status,
                durationMs: Date.now() - startedAt
            });
        }
    } catch (error) {
        logger?.warn?.('[工具] web_search JSON 请求失败，回退到 HTML 搜索', {
            query: summarizeText(query),
            limit,
            timeoutMs,
            error: error.message,
            durationMs: Date.now() - startedAt
        });
    }

    if (results.length === 0) {
        source = 'duckduckgo_html';
        const htmlUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const htmlResponse = await fetch(htmlUrl, {
            method: 'GET',
            signal,
            headers: {
                Accept: 'text/html,application/xhtml+xml'
            }
        });

        if (!htmlResponse.ok) {
            throw new Error(`搜索服务返回错误: ${htmlResponse.status}`);
        }

        const html = await htmlResponse.text();
        results = extractSerpLinksFromHtml(html, {
            maxResults: limit,
            maxSnippetLength,
            allowedDomains,
            blockedDomains
        });
    }

    return { source, results };
}

async function launchSearchBrowser() {
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch (error) {
        throw new Error(`浏览器搜索不可用：未安装 playwright（${error.message}）`);
    }

    const launchOptions = {
        headless: false,
        args: ['--window-position=-32000,-32000', '--window-size=1280,768']
    };
    for (const channel of ['chrome', 'msedge']) {
        try {
            return await chromium.launch({ ...launchOptions, channel });
        } catch {
            // 继续尝试下一个系统浏览器通道
        }
    }

    try {
        return await chromium.launch({ headless: true });
    } catch (error) {
        throw new Error(`浏览器搜索不可用：未找到可用 Chrome/Edge，且 Playwright 浏览器未安装（${error.message}）`);
    }
}

async function runBrowserSearchEngine({ source, searchUrl, query, limit, maxSnippetLength, allowedDomains, blockedDomains, signal }) {
    const url = new URL(searchUrl);
    url.searchParams.set('q', query);
    let browser;
    try {
        browser = await launchSearchBrowser();
        const page = await browser.newPage({
            viewport: { width: 1280, height: 768 },
            locale: 'en-US'
        });
        if (signal?.aborted) {
            throw new DOMException('Aborted', 'AbortError');
        }
        const abortHandler = () => page.close().catch(() => {});
        signal?.addEventListener?.('abort', abortHandler, { once: true });
        try {
            try {
                await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: 15000 });
            } catch (error) {
                if (!String(error?.message || '').includes('net::ERR_ABORTED')) {
                    throw error;
                }
            }
            await page.waitForTimeout(1500);
            const pageState = await page.evaluate(() => ({
                url: location.href,
                title: document.title,
                text: document.body?.innerText || '',
                html: document.documentElement?.outerHTML || ''
            }));
            if (/\/sorry\//i.test(pageState.url) || /unusual traffic|captcha|verify you are human|about this page/i.test(pageState.text)) {
                throw new Error('Google 返回人机验证页，当前网络环境无法免 Key 搜索');
            }
            return {
                source,
                results: extractSerpLinksFromHtml(pageState.html, {
                    maxResults: limit,
                    maxSnippetLength,
                    allowedDomains,
                    blockedDomains,
                    baseUrl: url.origin
                })
            };
        } finally {
            signal?.removeEventListener?.('abort', abortHandler);
        }
    } finally {
        await browser?.close?.().catch(() => {});
    }
}

async function runHtmlSearchEngine({ source, searchUrl, query, limit, maxSnippetLength, allowedDomains, blockedDomains, signal }) {
    const url = new URL(searchUrl);
    url.searchParams.set('q', query);
    const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'text/html,application/xhtml+xml',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
        }
    });

    if (!response.ok) {
        throw new Error(`${source} 搜索失败: ${response.status}`);
    }

    const html = await response.text();
    return {
        source,
        results: extractSerpLinksFromHtml(html, {
            maxResults: limit,
            maxSnippetLength,
            allowedDomains,
            blockedDomains,
            baseUrl: url.origin
        })
    };
}

async function runNoKeySearchEngine({ source, searchUrl, query, limit, maxSnippetLength, allowedDomains, blockedDomains, fallbackEnabled, signal }) {
    try {
        const primary = await runHtmlSearchEngine({ source, searchUrl, query, limit, maxSnippetLength, allowedDomains, blockedDomains, signal });
        if (!fallbackEnabled || (Array.isArray(primary.results) && primary.results.length > 0)) {
            return primary;
        }
    } catch (error) {
        if (!fallbackEnabled) {
            throw error;
        }
    }

    return runHtmlSearchEngine({
        source: `${source}_bing_fallback`,
        searchUrl: 'https://www.bing.com/search',
        query,
        limit,
        maxSnippetLength,
        allowedDomains,
        blockedDomains,
        signal
    });
}

async function runGoogleSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, engineId, fallbackEnabled, signal }) {
    if (!apiKey || !engineId) {
        try {
            const result = await runBrowserSearchEngine({
                source: 'google_browser',
                searchUrl: 'https://www.google.com/search',
                query,
                limit,
                maxSnippetLength,
                allowedDomains,
                blockedDomains,
                signal
            });
            if (!fallbackEnabled || (Array.isArray(result.results) && result.results.length > 0)) {
                return result;
            }
        } catch (error) {
            if (!fallbackEnabled) {
                throw error;
            }
        }
        return runHtmlSearchEngine({
            source: 'google_browser_bing_fallback',
            searchUrl: 'https://www.bing.com/search',
            query,
            limit,
            maxSnippetLength,
            allowedDomains,
            blockedDomains,
            signal
        });
    }

    const url = new URL('https://www.googleapis.com/customsearch/v1');
    url.searchParams.set('q', query);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('cx', engineId);
    url.searchParams.set('num', String(Math.min(limit, 10)));

    const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
        throw new Error(`Google 搜索失败: ${response.status}`);
    }

    const payload = await response.json();
    const results = [];
    const seenUrls = new Set();
    for (const item of Array.isArray(payload?.items) ? payload.items : []) {
        const urlValue = sanitizeText(item?.link);
        if (!urlValue || seenUrls.has(urlValue) || !isUrlAllowed(urlValue, allowedDomains, blockedDomains)) {
            continue;
        }
        results.push({
            title: truncateText(item?.title || urlValue, 200),
            url: urlValue,
            snippet: truncateText(item?.snippet || '', maxSnippetLength)
        });
        seenUrls.add(urlValue);
        if (results.length >= limit) {
            break;
        }
    }
    return { source: 'google_custom_search', results };
}

async function runBingSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, endpoint, fallbackEnabled, signal }) {
    if (!apiKey) {
        return runNoKeySearchEngine({
            source: 'bing_html',
            fallbackEnabled,
            searchUrl: 'https://www.bing.com/search',
            query,
            limit,
            maxSnippetLength,
            allowedDomains,
            blockedDomains,
            signal
        });
    }

    const url = new URL(endpoint || 'https://api.bing.microsoft.com/v7.0/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));

    const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json',
            'Ocp-Apim-Subscription-Key': apiKey
        }
    });
    if (!response.ok) {
        throw new Error(`Bing 搜索失败: ${response.status}`);
    }

    const payload = await response.json();
    const results = [];
    const seenUrls = new Set();
    for (const item of Array.isArray(payload?.webPages?.value) ? payload.webPages.value : []) {
        const urlValue = sanitizeText(item?.url);
        if (!urlValue || seenUrls.has(urlValue) || !isUrlAllowed(urlValue, allowedDomains, blockedDomains)) {
            continue;
        }
        results.push({
            title: truncateText(item?.name || urlValue, 200),
            url: urlValue,
            snippet: truncateText(item?.snippet || '', maxSnippetLength)
        });
        seenUrls.add(urlValue);
        if (results.length >= limit) {
            break;
        }
    }
    return { source: 'bing_web_search', results };
}
async function runTavilySearch({ query, limit, timeoutMs, maxSnippetLength, allowedDomains, blockedDomains, apiKey, signal }) {
    if (!apiKey) {
        throw new Error('Tavily 未配置 API Key');
    }
    const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        signal,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: JSON.stringify({
            api_key: apiKey,
            query,
            max_results: limit,
            include_answer: true,
            include_raw_content: false,
            search_depth: 'advanced'
        })
    });

    if (!response.ok) {
        throw new Error(`Tavily 搜索失败: ${response.status}`);
    }

    const payload = await response.json();
    const results = [];
    const seenUrls = new Set();
    for (const item of Array.isArray(payload?.results) ? payload.results : []) {
        const url = sanitizeText(item?.url);
        if (!url || seenUrls.has(url) || !isUrlAllowed(url, allowedDomains, blockedDomains)) {
            continue;
        }
        results.push({
            title: truncateText(item?.title || url, 200),
            url,
            snippet: truncateText(item?.content || item?.raw_content || payload?.answer || '', maxSnippetLength)
        });
        seenUrls.add(url);
        if (results.length >= limit) {
            break;
        }
    }
    if (results.length === 0 && payload?.answer) {
        results.push({
            title: 'Tavily 即时答案',
            url: `https://tavily.com/search?q=${encodeURIComponent(query)}`,
            snippet: truncateText(payload.answer, maxSnippetLength)
        });
    }
    return { source: 'tavily', results };
}

async function runBraveSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, fallbackEnabled, signal }) {
    if (!apiKey) {
        return runNoKeySearchEngine({
            source: 'brave_html',
            fallbackEnabled,
            searchUrl: 'https://search.brave.com/search',
            query,
            limit,
            maxSnippetLength,
            allowedDomains,
            blockedDomains,
            signal
        });
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(limit));
    const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json',
            'X-Subscription-Token': apiKey
        }
    });
    if (!response.ok) {
        throw new Error(`Brave 搜索失败: ${response.status}`);
    }
    const payload = await response.json();
    const results = [];
    const seenUrls = new Set();
    for (const item of Array.isArray(payload?.web?.results) ? payload.web.results : []) {
        const urlValue = sanitizeText(item?.url);
        if (!urlValue || seenUrls.has(urlValue) || !isUrlAllowed(urlValue, allowedDomains, blockedDomains)) {
            continue;
        }
        results.push({
            title: truncateText(item?.title || urlValue, 200),
            url: urlValue,
            snippet: truncateText(item?.description || '', maxSnippetLength)
        });
        seenUrls.add(urlValue);
        if (results.length >= limit) {
            break;
        }
    }
    return { source: 'brave', results };
}
async function runSerpApiSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, signal }) {
    if (!apiKey) {
        throw new Error('SerpAPI 未配置 API Key');
    }
    const url = new URL('https://serpapi.com/search.json');
    url.searchParams.set('q', query);
    url.searchParams.set('engine', 'google');
    url.searchParams.set('num', String(limit));
    url.searchParams.set('api_key', apiKey);
    const response = await fetch(url, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json'
        }
    });
    if (!response.ok) {
        throw new Error(`SerpAPI 搜索失败: ${response.status}`);
    }
    const payload = await response.json();
    const results = [];
    const seenUrls = new Set();
    for (const item of Array.isArray(payload?.organic_results) ? payload.organic_results : []) {
        const urlValue = sanitizeText(item?.link);
        if (!urlValue || seenUrls.has(urlValue) || !isUrlAllowed(urlValue, allowedDomains, blockedDomains)) {
            continue;
        }
        results.push({
            title: truncateText(item?.title || urlValue, 200),
            url: urlValue,
            snippet: truncateText(item?.snippet || '', maxSnippetLength)
        });
        seenUrls.add(urlValue);
        if (results.length >= limit) {
            break;
        }
    }
    return { source: 'serpapi', results };
}

function isTimeQuery(query = '') {
    return matchRealtimeIntent(query).intent === 'time';
}

function isExchangeQuery(query = '') {
    return matchRealtimeIntent(query).intent === 'exchange';
}

function isNewsQuery(query = '') {
    return matchRealtimeIntent(query).intent === 'news';
}

async function runTimeDirectSearch() {
    const formatted = new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        weekday: 'long'
    }).format(new Date());

    return {
        source: 'local_beijing_time',
        results: [{
            title: '北京时间',
            url: 'about:beijing-time',
            snippet: `当前北京时间：${formatted}`
        }]
    };
}

async function runExchangeDirectSearch({ query, signal, maxSnippetLength }) {
    const upperQuery = sanitizeText(query).toUpperCase();
    const matchedCodes = upperQuery.match(/\b[A-Z]{3}\b/g) || [];
    const codes = matchedCodes.filter((code) => ['USD', 'CNY', 'HKD', 'JPY', 'EUR', 'GBP', 'KRW', 'TWD'].includes(code));
    const base = codes[0] || 'USD';
    const target = codes[1] || (base === 'CNY' ? 'USD' : 'CNY');
    const response = await fetch(`https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`, {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json'
        }
    });
    if (!response.ok) {
        throw new Error(`汇率服务返回错误: ${response.status}`);
    }
    const payload = await response.json();
    const rate = Number(payload?.rates?.[target]);
    if (!Number.isFinite(rate)) {
        return { source: 'exchange_api', results: [] };
    }

    return {
        source: 'exchange_api',
        results: [{
            title: `${base}/${target} 汇率`,
            url: `https://open.er-api.com/v6/latest/${encodeURIComponent(base)}`,
            snippet: truncateText(`当前参考汇率：1 ${base} ≈ ${rate} ${target}`, maxSnippetLength)
        }]
    };
}

async function runNewsDirectSearch({ query, limit, maxSnippetLength, signal }) {
    const response = await fetch('https://api.rss2json.com/v1/api.json?rss_url=https://feeds.bbci.co.uk/news/world/rss.xml', {
        method: 'GET',
        signal,
        headers: {
            Accept: 'application/json'
        }
    });
    if (!response.ok) {
        throw new Error(`新闻服务返回错误: ${response.status}`);
    }

    const payload = await response.json();
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const results = [];
    const seenUrls = new Set();

    for (const item of items) {
        const url = sanitizeText(item?.link);
        const title = sanitizeText(item?.title || '');
        const snippet = truncateText(stripHtml(item?.description || item?.content || ''), maxSnippetLength);
        if (!url || !title || seenUrls.has(url)) {
            continue;
        }
        results.push({
            title: truncateText(title, 200),
            url,
            snippet: snippet || title
        });
        seenUrls.add(url);
        if (results.length >= limit) {
            break;
        }
    }

    return { source: 'bbc_world_rss', results };
}

async function runSearchProvider({ provider, query, limit, timeoutMs, maxSnippetLength, allowedDomains, blockedDomains, apiKey, googleEngineId, bingEndpoint, fallbackEnabled, logger, startedAt, signal }) {
    const normalizedProvider = sanitizeText(provider).toLowerCase() || 'duckduckgo';

    if (isWeatherQuery(query)) {
        try {
            const weatherResult = await runWeatherDirectSearch({ query, maxSnippetLength, signal });
            if (Array.isArray(weatherResult.results) && weatherResult.results.length > 0) {
                logger?.info?.('[工具] web_search 命中天气直连结果', {
                    provider: normalizedProvider,
                    query: summarizeText(query),
                    durationMs: Date.now() - startedAt,
                    resultCount: weatherResult.results.length
                });
                return weatherResult;
            }
        } catch (error) {
            logger?.warn?.('[工具] 天气直连失败，回退到普通搜索', {
                provider: normalizedProvider,
                query: summarizeText(query),
                error: error.message,
                durationMs: Date.now() - startedAt
            });
        }
    }

    if (isTimeQuery(query)) {
        try {
            const timeResult = await runTimeDirectSearch({ signal });
            if (Array.isArray(timeResult.results) && timeResult.results.length > 0) {
                logger?.info?.('[工具] web_search 命中时间直连结果', {
                    provider: normalizedProvider,
                    query: summarizeText(query),
                    durationMs: Date.now() - startedAt,
                    resultCount: timeResult.results.length
                });
                return timeResult;
            }
        } catch (error) {
            logger?.warn?.('[工具] 时间直连失败，回退到普通搜索', {
                provider: normalizedProvider,
                query: summarizeText(query),
                error: error.message,
                durationMs: Date.now() - startedAt
            });
        }
    }

    if (isExchangeQuery(query)) {
        try {
            const exchangeResult = await runExchangeDirectSearch({ query, signal, maxSnippetLength });
            if (Array.isArray(exchangeResult.results) && exchangeResult.results.length > 0) {
                logger?.info?.('[工具] web_search 命中汇率直连结果', {
                    provider: normalizedProvider,
                    query: summarizeText(query),
                    durationMs: Date.now() - startedAt,
                    resultCount: exchangeResult.results.length
                });
                return exchangeResult;
            }
        } catch (error) {
            logger?.warn?.('[工具] 汇率直连失败，回退到普通搜索', {
                provider: normalizedProvider,
                query: summarizeText(query),
                error: error.message,
                durationMs: Date.now() - startedAt
            });
        }
    }

    if (isNewsQuery(query)) {
        try {
            const newsResult = await runNewsDirectSearch({ query, limit, maxSnippetLength, signal });
            if (Array.isArray(newsResult.results) && newsResult.results.length > 0) {
                logger?.info?.('[工具] web_search 命中新闻直连结果', {
                    provider: normalizedProvider,
                    query: summarizeText(query),
                    durationMs: Date.now() - startedAt,
                    resultCount: newsResult.results.length
                });
                return newsResult;
            }
        } catch (error) {
            logger?.warn?.('[工具] 新闻直连失败，回退到普通搜索', {
                provider: normalizedProvider,
                query: summarizeText(query),
                error: error.message,
                durationMs: Date.now() - startedAt
            });
        }
    }

    if (normalizedProvider === 'google') {
        return runGoogleSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, engineId: googleEngineId, fallbackEnabled, signal });
    }
    if (normalizedProvider === 'bing') {
        return runBingSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, endpoint: bingEndpoint, fallbackEnabled, signal });
    }
    if (normalizedProvider === 'tavily') {
        return runTavilySearch({ query, limit, timeoutMs, maxSnippetLength, allowedDomains, blockedDomains, apiKey, signal });
    }
    if (normalizedProvider === 'brave') {
        return runBraveSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, fallbackEnabled, signal });
    }
    if (normalizedProvider === 'serpapi') {
        return runSerpApiSearch({ query, limit, maxSnippetLength, allowedDomains, blockedDomains, apiKey, signal });
    }
    return runDuckDuckGoSearch({ query, limit, timeoutMs, maxSnippetLength, allowedDomains, blockedDomains, signal, logger, startedAt });
}

export async function runConfiguredWebSearch({ config = {}, query = '', limit = null, logger = console } = {}) {
    const normalizedQuery = sanitizeText(query);
    if (!normalizedQuery) {
        throw new Error('搜索关键词不能为空');
    }

    const webSearchConfig = config.ai?.tools?.webSearch || config.webSearch || config || {};
    const provider = sanitizeText(webSearchConfig.provider || 'duckduckgo').toLowerCase() || 'duckduckgo';
    const timeoutMs = clampInteger(webSearchConfig.timeoutMs, 1000, 15000, 10000);
    const maxSnippetLength = clampInteger(webSearchConfig.maxSnippetLength, 100, 4000, 800);
    const resolvedLimit = Math.min(clampInteger(limit || webSearchConfig.maxResults, 1, 8, 5), 8);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
        const { source, results } = await runSearchProvider({
            provider,
            query: normalizedQuery,
            limit: resolvedLimit,
            timeoutMs,
            maxSnippetLength,
            allowedDomains: webSearchConfig.allowedDomains,
            blockedDomains: webSearchConfig.blockedDomains,
            apiKey: sanitizeText(webSearchConfig.apiKey || ''),
            googleEngineId: sanitizeText(webSearchConfig.googleEngineId || webSearchConfig.engineId || webSearchConfig.cx || ''),
            bingEndpoint: sanitizeText(webSearchConfig.bingEndpoint || ''),
            fallbackEnabled: webSearchConfig.fallbackEnabled === true,
            logger,
            startedAt,
            signal: controller.signal
        });
        return {
            provider,
            source,
            query: normalizedQuery,
            durationMs: Date.now() - startedAt,
            resultCount: Array.isArray(results) ? results.length : 0,
            results: Array.isArray(results) ? results : []
        };
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('搜索超时，请稍后重试');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function buildMentionTaskPrompt({ groupId, targetUserId, targetName, promptText }) {
    const normalizedTargetName = sanitizeText(targetName) || `QQ ${targetUserId}`;
    return [
        '当前任务不是继续普通对话，而是由管理员要求你主动对一位群成员说一句话。',
        `目标群号: ${groupId}`,
        `目标成员: ${normalizedTargetName} (${targetUserId})`,
        `管理员要求: ${promptText}`,
        '请严格遵守以下要求：',
        '1. 必须保持当前角色卡、世界书、设定与语气，不要退化成通用助手口吻。',
        '2. 管理员提供的是意图，不要机械复述，也不要自称代管理员转述。',
        '3. 最终输出必须是准备直接发送给该成员的一条中文群聊消息正文。',
        '4. 不要包含 @ 前缀、引号、解释、规则说明或思维过程。',
        '5. 内容自然、简短、贴合群聊场景，避免写成长篇角色扮演。'
    ].join('\n');
}

function appendMentionTaskToMessages(messages, mentionTaskPrompt) {
    const normalizedMessages = Array.isArray(messages)
        ? messages.map((message) => ({ ...message }))
        : [];

    if (normalizedMessages.length === 0) {
        return [{ role: 'user', content: mentionTaskPrompt }];
    }

    const lastMessage = normalizedMessages.at(-1);
    if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string') {
        normalizedMessages[normalizedMessages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage.content}\n\n${mentionTaskPrompt}`
        };
        return normalizedMessages;
    }

    normalizedMessages.push({ role: 'user', content: mentionTaskPrompt });
    return normalizedMessages;
}

export function appendMentionTaskToPromptMessages({ messages, groupId, targetUserId, targetName, promptText }) {
    return appendMentionTaskToMessages(messages, buildMentionTaskPrompt({
        groupId,
        targetUserId,
        targetName,
        promptText
    }));
}

function buildMentionGenerationMessages({ groupId, targetUserId, targetName, promptText }) {
    return [
        {
            role: 'system',
            content: '你是 QQ 群里的聊天助手。现在需要主动 @ 一位群成员并发送一段消息。请直接输出准备发送给该成员的最终中文内容，不要解释你的思路，不要加引号，不要包含 @ 前缀，不要自称是管理员转述。内容应自然、简短、适合群聊场景。'
        },
        {
            role: 'user',
            content: `群号: ${groupId}\n目标成员: ${targetName || `QQ ${targetUserId}`} (${targetUserId})\n要求: ${promptText}\n\n请生成一段适合直接发送给该成员的群聊消息正文。`
        }
    ];
}

function buildTextToolFallbackHint({ tools = [], maxRounds = 3 } = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return '';
    }

    const toolSpecs = tools.map((tool) => {
        const fn = tool?.function || {};
        return {
            name: sanitizeText(fn.name),
            description: sanitizeText(fn.description),
            parameters: fn.parameters || { type: 'object', properties: {}, required: [] }
        };
    }).filter((tool) => tool.name);

    if (toolSpecs.length === 0) {
        return '';
    }

    return [
        '当当前模型不支持原生 tool_calls 时，你必须改用“文本工具兜底协议”。',
        '工具决策先分三类: chat=普通群聊闲聊，不调用工具；browse=最新/外部事实/资料核验，调用 web_search；agent=明确要求你代办或 @ 某人，才调用对应工具。',
        '普通角色扮演、水群、调侃、情绪接话、低信息输入、表情/戳一戳，不要为了显得聪明而调用搜索。',
        `最多允许 ${Math.max(1, Number(maxRounds) || 3)} 轮工具调用；若拿到足够信息就直接结束。`,
        '需要调用工具时，整条回复必须只输出一个 JSON 对象，禁止输出解释、Markdown、代码块、前后缀。',
        '调用工具格式：',
        '{"action":"tool_calls","tool_calls":[{"name":"工具名","arguments":{}}]}',
        '拿到工具结果后，如果还需要继续调用工具，继续按同样格式只输出 JSON。',
        '拿到足够工具结果后必须输出 final；final 只写给用户看的正文，不暴露 JSON 协议、工具名、参数或“我准备搜索”。',
        '最终回答格式：',
        '{"action":"final","content":"这里放最终回复正文"}',
        '禁止输出不存在的工具名；arguments 必须是 JSON 对象。',
        '可用工具清单：',
        JSON.stringify(toolSpecs, null, 2)
    ].join('\n');
}

export function buildAIToolDefinitions(config = {}, options = {}) {
    const webSearchConfig = config.ai?.tools?.webSearch || {};
    const sendMentionConfig = config.ai?.tools?.sendMention || {};
    const allowSendMention = options.allowSendMention !== false;
    const tools = [];

    if (webSearchConfig.enabled) {
        tools.push({
            type: 'function',
            function: {
                name: 'web_search',
                description: '搜索公开网页结果摘要，适合查询最新信息、外部资料或事实。支持 duckduckgo、google、bing、tavily、brave、serpapi 等 provider，返回标题、链接和摘要。',
                parameters: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '要搜索的关键词或问题。'
                        },
                        limit: {
                            type: 'integer',
                            description: '期望返回的结果条数，服务端会限制在 1 到 5 之间。'
                        }
                    },
                    required: ['query']
                }
            }
        });
    }

    if (sendMentionConfig.enabled && allowSendMention) {
        tools.push({
            type: 'function',
            function: {
                name: 'send_group_mention',
                description: '在群聊中主动 @ 某位成员并发送消息。入参里的 prompt 是要求，最终发送正文会由 AI 再生成后发出。禁止 @all。',
                parameters: {
                    type: 'object',
                    properties: {
                        groupId: {
                            type: 'string',
                            description: '目标群号；若当前已在群上下文中可省略。'
                        },
                        targetUserId: {
                            type: 'string',
                            description: '要 @ 的 QQ 号；若希望 @ 当前发言人且上下文明确可省略。'
                        },
                        prompt: {
                            type: 'string',
                            description: '希望发给对方的要求或意图，最终正文会由 AI 生成。'
                        }
                    },
                    required: ['prompt']
                }
            }
        });
    }

    return tools;
}

export async function generateMentionTextFromPrompt({ aiClient, groupId, targetUserId, targetName, promptText, buildPromptMessages = null, aiOptions = undefined }) {
    const normalizedGroupId = toComparableId(groupId);
    const normalizedTargetUserId = toComparableId(targetUserId);
    const normalizedPromptText = sanitizeText(promptText);
    const startedAt = Date.now();

    if (!normalizedGroupId) {
        throw new Error('群号不能为空');
    }
    if (!normalizedTargetUserId || normalizedTargetUserId === 'all') {
        throw new Error('目标成员不能为空，且不能是 @all');
    }
    if (!normalizedPromptText) {
        throw new Error('消息要求不能为空');
    }

    let messages = null;
    if (typeof buildPromptMessages === 'function') {
        const builtMessages = await buildPromptMessages({
            groupId: normalizedGroupId,
            targetUserId: normalizedTargetUserId,
            targetName,
            promptText: normalizedPromptText
        });
        if (Array.isArray(builtMessages) && builtMessages.length > 0) {
            messages = builtMessages;
        }
    }

    const finalMessages = messages || buildMentionGenerationMessages({
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        targetName,
        promptText: normalizedPromptText
    });

    const responseResult = await aiClient.chat(finalMessages, aiOptions);
    const response = aiClient.getVisibleResponseContent(responseResult);

    const messageText = sanitizeText(response);
    if (!messageText) {
        throw new Error('AI 未生成可发送内容');
    }

    return {
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        usedPromptBuilder: !!messages,
        prompt: summarizeText(normalizedPromptText),
        finalMessageCount: finalMessages.length,
        generatedMessage: messageText,
        durationMs: Date.now() - startedAt
    };
}

export async function sendGroupMentionFromPrompt({ aiClient, bot, groupId, targetUserId, targetName, promptText, buildPromptMessages = null, aiOptions = undefined }) {
    const normalizedGroupId = toComparableId(groupId);
    const normalizedTargetUserId = toComparableId(targetUserId);
    if (!normalizedGroupId) {
        throw new Error('群号不能为空');
    }
    if (!normalizedTargetUserId || normalizedTargetUserId === 'all') {
        throw new Error('目标成员不能为空，且不能是 @all');
    }

    const generated = await generateMentionTextFromPrompt({
        aiClient,
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        targetName,
        promptText,
        buildPromptMessages,
        aiOptions
    });

    await bot.sendGroupMessage(normalizedGroupId, buildMentionMessage(normalizedTargetUserId, generated.generatedMessage));

    return {
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        generatedMessage: generated.generatedMessage,
        prompt: generated.prompt,
        usedPromptBuilder: generated.usedPromptBuilder,
        finalMessageCount: generated.finalMessageCount,
        durationMs: generated.durationMs
    };
}

export async function buildRealtimeGroundingMessage({ config = {}, query = '', logger = console } = {}) {
    const normalizedQuery = sanitizeText(query);
    const webSearchConfig = config.ai?.tools?.webSearch || {};
    const intentMatch = matchRealtimeIntent(normalizedQuery);
    if (!normalizedQuery || !webSearchConfig.enabled || !intentMatch.matched) {
        return null;
    }

    const provider = sanitizeText(webSearchConfig.provider || 'duckduckgo').toLowerCase() || 'duckduckgo';
    const timeoutMs = clampInteger(webSearchConfig.timeoutMs, 1000, 15000, 10000);
    const maxSnippetLength = clampInteger(webSearchConfig.maxSnippetLength, 100, 4000, 800);
    const limit = Math.min(clampInteger(webSearchConfig.maxResults, 1, 8, 5), 4);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
        const { source, results } = await runSearchProvider({
            provider,
            query: normalizedQuery,
            limit,
            timeoutMs,
            maxSnippetLength,
            allowedDomains: webSearchConfig.allowedDomains,
            blockedDomains: webSearchConfig.blockedDomains,
            apiKey: sanitizeText(webSearchConfig.apiKey || ''),
            googleEngineId: sanitizeText(webSearchConfig.googleEngineId || webSearchConfig.engineId || webSearchConfig.cx || ''),
            bingEndpoint: sanitizeText(webSearchConfig.bingEndpoint || ''),
            fallbackEnabled: webSearchConfig.fallbackEnabled === true,
            logger,
            startedAt,
            signal: controller.signal
        });

        if (!Array.isArray(results) || results.length === 0) {
            return {
                provider,
                source,
                intent: intentMatch.intent,
                resultCount: 0,
                results: [],
                message: [
                    '这是一个实时信息问题。',
                    `后端刚尝试联网检索，但没有拿到可用结果。用户问题：${normalizedQuery}`,
                    '回答时必须明确说明这次没有查到可靠实时结果，不要假装自己已经查到。'
                ].join('\n')
            };
        }

        const lines = results.slice(0, limit).map((item, index) => {
            return [
                `${index + 1}. 标题：${item.title || '-'}`,
                `   链接：${item.url || '-'}`,
                `   摘要：${item.snippet || '-'}`
            ].join('\n');
        });

        return {
            provider,
            source,
            intent: intentMatch.intent,
            resultCount: results.length,
            results,
            message: [
                '这是一个实时信息问题，下面是后端刚完成的联网检索结果。',
                `用户问题：${normalizedQuery}`,
                `搜索来源：provider=${provider}，source=${source || 'unknown'}`,
                '你必须优先依据这些结果作答；如果结果仍不充分，要明确说出不确定点，不要编造。',
                '检索结果：',
                lines.join('\n')
            ].join('\n')
        };
    } catch (error) {
        const isAbortError = error?.name === 'AbortError';
        return {
            provider,
            source: 'search_error',
            resultCount: 0,
            message: [
                '这是一个实时信息问题。',
                `后端联网检索失败：${isAbortError ? '搜索超时，请谨慎回答' : error.message}`,
                `用户问题：${normalizedQuery}`,
                '回答时必须明确说明检索失败，不要把常识当成实时结果。'
            ].join('\n')
        };
    } finally {
        clearTimeout(timer);
    }
}

function buildRealtimeAnswerPrompt({ query = '', groundingMessage = '' } = {}) {
    const normalizedQuery = sanitizeText(query);
    const normalizedGrounding = sanitizeText(groundingMessage);
    return [
        '你正在处理实时信息问答，当前模式不是角色扮演，也不是世界设定扩写。',
        '回答目标只有一个：基于刚刚检索到的结果，直接给出简洁、可靠、面向普通用户的中文回答。',
        '不要输出思维过程，不要说“我准备搜索”，不要继续扮演角色口吻，不要使用工具描述。',
        '如果检索结果不足或失败，必须明确说明“这次没查到可靠实时结果”或“不确定”，不要编造。',
        normalizedGrounding || '当前没有可用检索结果。',
        `用户问题：${normalizedQuery}`,
        '请直接输出最终回答正文。'
    ].filter(Boolean).join('\n\n');
}

function buildDirectRealtimeResponse({ query = '', grounding = null }) {
    const normalizedQuery = sanitizeText(query);
    const normalizedGrounding = grounding && typeof grounding === 'object' ? grounding : null;
    const intent = normalizedGrounding?.intent || matchRealtimeIntent(normalizedQuery).intent;
    const results = Array.isArray(normalizedGrounding?.results) ? normalizedGrounding.results : [];

    if (intent === 'news' && results.length > 0) {
        const lines = results.slice(0, 3).map((item, index) => {
            const snippet = sanitizeText(item?.snippet || '');
            return `${index + 1}. ${sanitizeText(item?.title || '未命名新闻')}${snippet ? `：${snippet}` : ''}`;
        });
        return [
            '最新国际新闻摘要：',
            ...lines
        ].join('\n');
    }

    if (intent === 'time' && results[0]?.snippet) {
        return results[0].snippet;
    }

    if (intent === 'exchange' && results[0]?.snippet) {
        return results[0].snippet;
    }

    if (intent === 'weather' && results[0]?.snippet) {
        const title = sanitizeText(results[0]?.title || '当前天气');
        return `${title}：${results[0].snippet}`;
    }

    return '';
}

export async function generateRealtimeAnswer({ aiClient, config = {}, query = '', logger = console } = {}) {
    const grounding = await buildRealtimeGroundingMessage({ config, query, logger });
    if (!grounding?.message) {
        return null;
    }

    const directReply = buildDirectRealtimeResponse({ query, grounding });
    if (directReply) {
        return {
            grounding,
            reply: sanitizeText(directReply)
        };
    }

    const replyResult = await aiClient.chat([
        {
            role: 'system',
            content: buildRealtimeAnswerPrompt({
                query,
                groundingMessage: grounding.message
            })
        },
        {
            role: 'user',
            content: sanitizeText(query)
        }
    ]);

    return {
        grounding,
        reply: sanitizeText(aiClient.getVisibleResponseContent(replyResult))
    };
}

export function buildAIToolContext({ config = {}, aiClient, bot, logger, defaultGroupId = null, defaultTargetUserId = null, defaultTargetName = null, allowSendMention = true, mentionGenerator = null } = {}) {
    const webSearchConfig = config.ai?.tools?.webSearch || {};
    const textToolFallbackConfig = config.ai?.tools?.textToolFallback || {};
    const tools = buildAIToolDefinitions(config, { allowSendMention });
    const toolHints = [];

    if (webSearchConfig.enabled) {
        const maxResults = clampInteger(webSearchConfig.maxResults, 1, 8, 5);
        const timeoutMs = clampInteger(webSearchConfig.timeoutMs, 1000, 15000, 10000);
        const maxSnippetLength = clampInteger(webSearchConfig.maxSnippetLength, 100, 4000, 800);
        const allowedDomains = Array.isArray(webSearchConfig.allowedDomains) && webSearchConfig.allowedDomains.length > 0
            ? webSearchConfig.allowedDomains.join(', ')
            : '不限';
        const blockedDomains = Array.isArray(webSearchConfig.blockedDomains) && webSearchConfig.blockedDomains.length > 0
            ? webSearchConfig.blockedDomains.join(', ')
            : '无';
        toolHints.push([
            `你当前可用联网工具: web_search（provider=${webSearchConfig.provider || 'duckduckgo'}）。`,
            '先做模式判断: chat=普通群聊/角色扮演/情绪接话，不搜；browse=最新信息/外部事实/资料核验/用户明确让你查，必须搜；agent=代办动作，按可用工具执行。',
            '适用场景: 天气、最新消息、实时信息、外部资料、链接/项目/库/新闻/价格/政策/版本等需要网页事实核验的问题。',
            '不适用场景: 水群、玩梗、低信息、QQ表情、戳一戳、只喊名字、普通角色对话；这些场景直接按群聊回复，不要调用搜索。',
            `工具限制: 默认最多 ${maxResults} 条结果，超时 ${timeoutMs}ms，单条摘要最长 ${maxSnippetLength} 字。`,
            `域名限制: 允许域名=${allowedDomains}；屏蔽域名=${blockedDomains}。`,
            '如果用户的问题明显依赖实时或外部信息，优先调用 web_search，不要先说自己不能联网。',
            '搜索结果只作为依据，最终回复用自然语言总结；不要泄露工具 JSON、参数、工具名，也不要说“我准备搜索”。',
            '如果搜索失败或无结果，再明确告诉用户这次搜索失败，而不是笼统说你没有上网能力。'
        ].join('\n'));
    }

    const textToolFallback = {
        enabled: textToolFallbackConfig.enabled === true,
        maxRounds: clampInteger(textToolFallbackConfig.maxRounds, 1, 8, 3),
        instruction: textToolFallbackConfig.enabled === true
            ? buildTextToolFallbackHint({
                tools,
                maxRounds: clampInteger(textToolFallbackConfig.maxRounds, 1, 8, 3)
            })
            : ''
    };

    return {
        tools,
        toolHints,
        textToolFallback,
        buildRealtimeSearchPrompt: (query = '') => buildRealtimeSearchPrompt(query, webSearchConfig.provider || 'duckduckgo'),
        isRealtimeQuery,
        matchRealtimeIntent,
        handlers: {
            async web_search(argumentsPayload = {}) {
                const query = sanitizeText(argumentsPayload.query);
                if (!query) {
                    return {
                        ok: false,
                        error: '搜索词不能为空',
                        query: '',
                        results: []
                    };
                }

                const maxResults = clampInteger(webSearchConfig.maxResults, 1, 8, 5);
                const limit = clampInteger(argumentsPayload.limit, 1, 8, maxResults);
                const timeoutMs = clampInteger(webSearchConfig.timeoutMs, 1000, 15000, 10000);
                const maxSnippetLength = clampInteger(webSearchConfig.maxSnippetLength, 100, 4000, 800);
                const provider = sanitizeText(webSearchConfig.provider || 'duckduckgo').toLowerCase() || 'duckduckgo';
                const apiKey = sanitizeText(webSearchConfig.apiKey || '');
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                const startedAt = Date.now();

                try {
                    logger?.info?.('[工具] 执行 web_search', {
                        provider,
                        query: query.slice(0, 120),
                        limit,
                        timeoutMs
                    });

                    const { source, results } = await runSearchProvider({
                        provider,
                        query,
                        limit,
                        timeoutMs,
                        maxSnippetLength,
                        allowedDomains: webSearchConfig.allowedDomains,
                        blockedDomains: webSearchConfig.blockedDomains,
                        apiKey,
                        googleEngineId: sanitizeText(webSearchConfig.googleEngineId || webSearchConfig.engineId || webSearchConfig.cx || ''),
                        bingEndpoint: sanitizeText(webSearchConfig.bingEndpoint || ''),
                        fallbackEnabled: webSearchConfig.fallbackEnabled === true,
                        logger,
                        startedAt,
                        signal: controller.signal
                    });

                    if (results.length === 0) {
                        logger?.warn?.('[工具] web_search 未命中结果', {
                            query: summarizeText(query),
                            provider,
                            limit,
                            timeoutMs,
                            source,
                            durationMs: Date.now() - startedAt
                        });
                        return {
                            ok: false,
                            error: '未找到合适的搜索结果',
                            query,
                            results: []
                        };
                    }

                    logger?.info?.('[工具] web_search 完成', {
                        query: summarizeText(query),
                        provider,
                        source,
                        resultCount: results.length,
                        durationMs: Date.now() - startedAt,
                        results: results.map((item) => ({
                            title: item.title,
                            url: item.url
                        }))
                    });

                    return {
                        ok: true,
                        query,
                        provider,
                        source,
                        results,
                        resultCount: results.length
                    };
                } catch (error) {
                    const isAbortError = error?.name === 'AbortError';
                    logger?.error?.('[工具] web_search 失败', {
                        query: summarizeText(query),
                        provider,
                        limit,
                        timeoutMs,
                        durationMs: Date.now() - startedAt,
                        error: isAbortError ? '搜索超时，请稍后重试' : error.message
                    });
                    return {
                        ok: false,
                        error: isAbortError ? '搜索超时，请稍后重试' : `搜索失败: ${error.message}`,
                        query,
                        results: []
                    };
                } finally {
                    clearTimeout(timer);
                }
            },
            async send_group_mention(argumentsPayload = {}) {
                const groupId = toComparableId(argumentsPayload.groupId) || toComparableId(defaultGroupId);
                const targetUserId = toComparableId(argumentsPayload.targetUserId) || toComparableId(defaultTargetUserId);
                const prompt = sanitizeText(argumentsPayload.prompt);
                const startedAt = Date.now();

                if (!groupId) {
                    return {
                        ok: false,
                        error: '缺少群号，无法主动 @',
                        groupId: '',
                        targetUserId: targetUserId || ''
                    };
                }

                if (!targetUserId || targetUserId === 'all') {
                    return {
                        ok: false,
                        error: '目标成员不能为空，且不能是 @all',
                        groupId,
                        targetUserId: targetUserId || ''
                    };
                }

                if (!prompt) {
                    return {
                        ok: false,
                        error: '主动 @ 的要求不能为空',
                        groupId,
                        targetUserId
                    };
                }

                logger?.info?.('[工具] 开始执行 send_group_mention', {
                    groupId,
                    targetUserId,
                    targetName: defaultTargetName || '',
                    prompt: summarizeText(prompt)
                });

                try {
                    const sent = mentionGenerator
                        ? await mentionGenerator({
                            groupId,
                            targetUserId,
                            targetName: defaultTargetName,
                            promptText: prompt
                        })
                        : await sendGroupMentionFromPrompt({
                            aiClient,
                            bot,
                            groupId,
                            targetUserId,
                            targetName: defaultTargetName,
                            promptText: prompt
                        });

                    logger?.info?.('[工具] send_group_mention 完成', {
                        groupId: sent.groupId,
                        targetUserId: sent.targetUserId,
                        targetName: defaultTargetName || '',
                        usedPromptBuilder: !!sent.usedPromptBuilder,
                        finalMessageCount: sent.finalMessageCount || 0,
                        durationMs: sent.durationMs || Date.now() - startedAt,
                        prompt: sent.prompt || summarizeText(prompt),
                        generatedMessage: summarizeText(sent.generatedMessage)
                    });

                    return {
                        ok: true,
                        groupId: sent.groupId,
                        targetUserId: sent.targetUserId,
                        generatedMessage: sent.generatedMessage
                    };
                } catch (error) {
                    logger?.error?.('[工具] send_group_mention 失败', {
                        groupId,
                        targetUserId,
                        targetName: defaultTargetName || '',
                        durationMs: Date.now() - startedAt,
                        prompt: summarizeText(prompt),
                        error: error.message
                    });
                    return {
                        ok: false,
                        error: error.message,
                        groupId,
                        targetUserId
                    };
                }
            }
        }
    };
}
