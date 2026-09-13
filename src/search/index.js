/**
 * 搜索服务统一入口
 * - Provider 注册表与回退链
 * - 域名过滤 / 去重 / 截断 / 结果规范化
 * - 配置归一化（含旧字段迁移）
 */

import { clampInteger, isAbortError } from './http.js';
import { duckduckgoProvider } from './providers/duckduckgo.js';
import { searxngProvider, normalizeSearxngBaseUrl } from './providers/searxng.js';
import { tavilyProvider } from './providers/tavily.js';
import { braveProvider } from './providers/brave.js';
import { serpapiProvider } from './providers/serpapi.js';

export const SEARCH_PROVIDERS = [duckduckgoProvider, searxngProvider, tavilyProvider, braveProvider, serpapiProvider];
const PROVIDER_MAP = new Map(SEARCH_PROVIDERS.map((provider) => [provider.id, provider]));

/** 旧版 provider 迁移映射（google/bing 手写抓取已移除） */
const LEGACY_PROVIDER_MAP = {
    google: 'duckduckgo',
    bing: 'duckduckgo'
};

export const WEB_SEARCH_DEFAULTS = Object.freeze({
    enabled: false,
    provider: 'duckduckgo',
    fallbackProviders: [],
    apiKeys: { tavily: '', brave: '', serpapi: '' },
    searxngBaseUrl: '',
    searxngEngines: '',
    region: 'cn-zh',
    locale: 'zh-cn',
    safeSearch: 'moderate',
    timeRange: 'all',
    maxResults: 5,
    timeoutMs: 10000,
    maxSnippetLength: 800,
    allowedDomains: [],
    blockedDomains: [],
    fetch: { enabled: true, timeoutMs: 15000, maxChars: 8000 },
    spice: { enabled: true, weatherDays: 3 },
    mcpFallback: 'auto',
    mcpFallbackMaxChars: 4000
});

const SAFE_SEARCH_VALUES = new Set(['off', 'moderate', 'strict']);
const TIME_RANGE_VALUES = new Set(['all', 'day', 'week', 'month', 'year']);

function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringList(value) {
    const source = Array.isArray(value)
        ? value
        : (typeof value === 'string' ? value.split(/[,，\s]+/) : []);
    const seen = new Set();
    const list = [];
    for (const item of source) {
        const text = normalizeString(item).toLowerCase();
        if (!text || seen.has(text)) {
            continue;
        }
        seen.add(text);
        list.push(text);
    }
    return list;
}

function normalizeProviderId(value) {
    const normalized = normalizeString(value).toLowerCase();
    if (PROVIDER_MAP.has(normalized)) {
        return normalized;
    }
    return LEGACY_PROVIDER_MAP[normalized] || WEB_SEARCH_DEFAULTS.provider;
}

/** 归一化 ai.tools.webSearch 配置，兼容旧字段（apiKey / engineId / bingEndpoint / fallbackEnabled） */
export function normalizeWebSearchConfig(raw = {}) {
    const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const provider = normalizeProviderId(source.provider);

    const apiKeys = { ...WEB_SEARCH_DEFAULTS.apiKeys };
    if (source.apiKeys && typeof source.apiKeys === 'object') {
        for (const id of Object.keys(apiKeys)) {
            if (typeof source.apiKeys[id] === 'string') {
                apiKeys[id] = source.apiKeys[id].trim();
            }
        }
    }
    // 旧版单 apiKey 字段迁移到对应 provider
    const legacyApiKey = normalizeString(source.apiKey);
    if (legacyApiKey) {
        const legacyProvider = normalizeString(source.provider).toLowerCase();
        if (legacyProvider in apiKeys && !apiKeys[legacyProvider]) {
            apiKeys[legacyProvider] = legacyApiKey;
        }
    }

    const fallbackProviders = normalizeStringList(source.fallbackProviders)
        .map((id) => normalizeProviderId(id))
        .filter((id, index, list) => id !== provider && list.indexOf(id) === index);

    const safeSearch = normalizeString(source.safeSearch).toLowerCase();
    const timeRange = normalizeString(source.timeRange).toLowerCase();

    const fetchSource = source.fetch && typeof source.fetch === 'object' ? source.fetch : {};
    const spiceSource = source.spice && typeof source.spice === 'object' ? source.spice : {};

    return {
        enabled: source.enabled === true,
        provider,
        fallbackProviders,
        apiKeys,
        searxngBaseUrl: normalizeSearxngBaseUrl(source.searxngBaseUrl),
        searxngEngines: normalizeString(source.searxngEngines),
        region: normalizeString(source.region) || WEB_SEARCH_DEFAULTS.region,
        locale: normalizeString(source.locale) || WEB_SEARCH_DEFAULTS.locale,
        safeSearch: SAFE_SEARCH_VALUES.has(safeSearch) ? safeSearch : WEB_SEARCH_DEFAULTS.safeSearch,
        timeRange: TIME_RANGE_VALUES.has(timeRange) ? timeRange : WEB_SEARCH_DEFAULTS.timeRange,
        maxResults: clampInteger(source.maxResults, 1, 10, WEB_SEARCH_DEFAULTS.maxResults),
        timeoutMs: clampInteger(source.timeoutMs, 1000, 30000, WEB_SEARCH_DEFAULTS.timeoutMs),
        maxSnippetLength: clampInteger(source.maxSnippetLength, 100, 4000, WEB_SEARCH_DEFAULTS.maxSnippetLength),
        allowedDomains: normalizeStringList(source.allowedDomains),
        blockedDomains: normalizeStringList(source.blockedDomains),
        fetch: {
            enabled: fetchSource.enabled !== false,
            timeoutMs: clampInteger(fetchSource.timeoutMs, 3000, 60000, WEB_SEARCH_DEFAULTS.fetch.timeoutMs),
            maxChars: clampInteger(fetchSource.maxChars, 500, 50000, WEB_SEARCH_DEFAULTS.fetch.maxChars)
        },
        spice: {
            enabled: spiceSource.enabled !== false,
            weatherDays: clampInteger(spiceSource.weatherDays, 1, 7, WEB_SEARCH_DEFAULTS.spice.weatherDays)
        },
        // 本地 provider 全挂时改用 MCP 搜索引擎工具：'off' | 'auto' | 服务器名/ID
        mcpFallback: normalizeString(source.mcpFallback) || WEB_SEARCH_DEFAULTS.mcpFallback,
        mcpFallbackMaxChars: clampInteger(source.mcpFallbackMaxChars, 500, 50000, WEB_SEARCH_DEFAULTS.mcpFallbackMaxChars)
    };
}

/** Provider 目录（供前端与校验使用） */
export function listSearchProviders() {
    return SEARCH_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        requiresApiKey: provider.requiresApiKey === true,
        supportsNews: provider.supportsNews === true
    }));
}

function matchesDomainFilter(hostname, domain) {
    const normalizedHost = normalizeString(hostname).toLowerCase();
    const normalizedDomain = normalizeString(domain).toLowerCase();
    if (!normalizedHost || !normalizedDomain) {
        return false;
    }
    return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

export function isUrlAllowed(url, allowedDomains = [], blockedDomains = []) {
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

function truncate(value, maxLength) {
    const text = String(value || '').trim();
    if (text.length <= maxLength) {
        return text;
    }
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function finalizeResults(results, config, limit) {
    const finalized = [];
    const seen = new Set();
    for (const item of Array.isArray(results) ? results : []) {
        const url = normalizeString(item?.url);
        if (!url || seen.has(url)) {
            continue;
        }
        if (!isUrlAllowed(url, config.allowedDomains, config.blockedDomains)) {
            continue;
        }
        seen.add(url);
        const entry = {
            title: truncate(item.title || url, 200),
            url,
            snippet: truncate(item.snippet || item.description || '', config.maxSnippetLength)
        };
        if (item.publishedAt) {
            entry.publishedAt = String(item.publishedAt);
        }
        finalized.push(entry);
        if (finalized.length >= limit) {
            break;
        }
    }
    return finalized;
}

// ==================== 引擎健康度：失败冷却（参考 SearXNG 的 ban_time / suspended_times） ====================
const providerHealth = new Map();
const CIRCUIT_BASE_COOLDOWN_MS = 60_000;      // 普通错误（超时/网络/解析）首次冷却
const CIRCUIT_MAX_COOLDOWN_MS = 600_000;      // 冷却上限
const CIRCUIT_HARD_COOLDOWN_MS = 300_000;     // 限流/封禁类错误首次冷却
const CIRCUIT_HARD_FAILURES = 5;              // 连续失败达到该次数直接进入上限冷却

function isRateLimitedFailure(error) {
    const status = Number(error?.status) || 0;
    const message = String(error?.message || '');
    return status === 429 || status === 403 || /captcha|access denied|forbidden|too many requests|rate limit/i.test(message);
}

function noteProviderFailure(providerId, error) {
    const entry = providerHealth.get(providerId) || { failures: 0, cooldownUntil: 0, lastError: '' };
    entry.failures += 1;
    entry.lastError = String(error?.message || error || '');
    const base = isRateLimitedFailure(error) ? CIRCUIT_HARD_COOLDOWN_MS : CIRCUIT_BASE_COOLDOWN_MS;
    const backoff = Math.min(CIRCUIT_MAX_COOLDOWN_MS, base * 2 ** Math.max(0, entry.failures - 1));
    entry.cooldownUntil = Date.now() + (entry.failures >= CIRCUIT_HARD_FAILURES ? CIRCUIT_MAX_COOLDOWN_MS : backoff);
    providerHealth.set(providerId, entry);
    return entry;
}

function noteProviderSuccess(providerId) {
    providerHealth.delete(providerId);
}

function getProviderCooldown(providerId) {
    const entry = providerHealth.get(providerId);
    if (!entry || entry.cooldownUntil <= Date.now()) {
        return null;
    }
    return entry;
}

/** 供测试与排查使用 */
export function getProviderHealthSnapshot() {
    return Array.from(providerHealth.entries()).map(([provider, entry]) => ({
        provider,
        failures: entry.failures,
        cooldownUntil: entry.cooldownUntil,
        cooldownRemainingMs: Math.max(0, entry.cooldownUntil - Date.now()),
        lastError: entry.lastError
    }));
}

/** 供测试使用：清空引擎健康度 */
export function resetProviderHealth() {
    providerHealth.clear();
}

function buildProviderChain(config) {
    const chain = [config.provider, ...config.fallbackProviders]
        .map((id) => normalizeProviderId(id))
        .filter((id) => PROVIDER_MAP.has(id));
    return chain.filter((id, index) => chain.indexOf(id) === index);
}

/**
 * 执行一次搜索（含回退链）。
 * @returns {Promise<{ok:boolean,provider:string,source:string,query:string,topic:string,durationMs:number,resultCount:number,results:Array,attempts:Array}>}
 */
export async function runSearch({ config = {}, query, limit = null, topic = 'web', timeRange = '', site = '', logger = console, signal } = {}) {
    const normalizedQuery = normalizeString(query);
    if (!normalizedQuery) {
        throw new Error('搜索关键词不能为空');
    }

    const webSearchConfig = config.ai?.tools?.webSearch || config.webSearch || config;
    const searchConfig = normalizeWebSearchConfig(webSearchConfig);
    const resolvedLimit = clampInteger(limit || searchConfig.maxResults, 1, 10, searchConfig.maxResults);
    const normalizedTopic = String(topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
    const normalizedTimeRange = TIME_RANGE_VALUES.has(String(timeRange || '').toLowerCase())
        ? String(timeRange).toLowerCase()
        : searchConfig.timeRange;

    const attempts = [];
    const chain = buildProviderChain(searchConfig);

    for (const providerId of chain) {
        const provider = PROVIDER_MAP.get(providerId);
        const apiKey = provider.requiresApiKey ? normalizeString(searchConfig.apiKeys?.[providerId]) : '';
        if (provider.requiresApiKey && !apiKey) {
            attempts.push({ provider: providerId, error: '未配置 API Key', durationMs: 0 });
            continue;
        }

        const cooldown = getProviderCooldown(providerId);
        if (cooldown) {
            attempts.push({
                provider: providerId,
                error: `冷却中（连续失败 ${cooldown.failures} 次，${Math.ceil((cooldown.cooldownUntil - Date.now()) / 1000)}s 后重试）`,
                durationMs: 0,
                cooldown: true
            });
            continue;
        }

        const startedAt = Date.now();
        try {
            const result = await provider.search({
                query: normalizedQuery,
                limit: resolvedLimit,
                topic: normalizedTopic,
                timeRange: normalizedTimeRange,
                site: normalizeString(site),
                region: searchConfig.region,
                locale: searchConfig.locale,
                safeSearch: searchConfig.safeSearch,
                searxngBaseUrl: searchConfig.searxngBaseUrl,
                searxngEngines: searchConfig.searxngEngines,
                apiKey,
                timeoutMs: searchConfig.timeoutMs,
                maxSnippetLength: searchConfig.maxSnippetLength,
                signal,
                logger
            });
            const finalized = finalizeResults(result?.results, searchConfig, resolvedLimit);
            attempts.push({
                provider: providerId,
                source: result?.source || providerId,
                resultCount: finalized.length,
                rawCount: Array.isArray(result?.results) ? result.results.length : 0,
                durationMs: Date.now() - startedAt
            });
            if (finalized.length > 0) {
                noteProviderSuccess(providerId);
                return {
                    ok: true,
                    provider: providerId,
                    source: result?.source || providerId,
                    query: normalizedQuery,
                    topic: normalizedTopic,
                    durationMs: Date.now() - startedAt,
                    resultCount: finalized.length,
                    results: finalized,
                    attempts
                };
            }
        } catch (error) {
            if (isAbortError(error) && error.code === 'aborted') {
                throw error;
            }
            noteProviderFailure(providerId, error);
            attempts.push({
                provider: providerId,
                error: error?.message || String(error),
                durationMs: Date.now() - startedAt
            });
        }
    }

    const error = new Error('未找到合适的搜索结果');
    error.code = 'SEARCH_EMPTY';
    error.query = normalizedQuery;
    error.attempts = attempts;
    throw error;
}

export { fetchPageContent } from './fetch-page.js';
export { fetchWeather, fetchCurrency } from './spice.js';
