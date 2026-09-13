/**
 * 搜索模块 HTTP 封装
 * 统一处理浏览器请求头、超时、AbortSignal 组合与错误映射。
 */

/** 搜索类请求使用的浏览器请求头（移植自 duck-duck-scrape COMMON_HEADERS 思路） */
export const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Not=A?Brand";v="8", "Chromium";v="129"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'upgrade-insecure-requests': '1'
};

export function clampInteger(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

/** 组合多个 AbortSignal（Node >= 20.3 自带 AbortSignal.any，保留降级实现） */
export function combineSignals(signals = []) {
    const active = signals.filter(Boolean);
    if (active.length === 0) {
        return undefined;
    }
    if (active.length === 1) {
        return active[0];
    }
    if (typeof AbortSignal.any === 'function') {
        return AbortSignal.any(active);
    }

    const controller = new AbortController();
    for (const signal of active) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

function buildAbortError(message, code) {
    const error = new Error(message);
    error.name = 'AbortError';
    error.code = code;
    return error;
}

/**
 * 发起请求并返回文本响应。
 * 超时/外部中止都会抛出 name=AbortError 的错误，code 区分 timeout / aborted。
 */
export async function requestText(url, options = {}) {
    const {
        method = 'GET',
        headers = {},
        body,
        timeoutMs = 10000,
        signal,
        maxBytes = 2 * 1024 * 1024,
        redirect = 'follow'
    } = options;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(buildAbortError('请求超时', 'timeout')), Math.max(500, Number(timeoutMs) || 10000));
    const combined = combineSignals([signal, timeoutController.signal]);

    try {
        const response = await fetch(url, {
            method,
            headers: { ...BROWSER_HEADERS, ...headers },
            body,
            signal: combined,
            redirect
        });
        const rawText = await response.text();
        const truncated = rawText.length > maxBytes;
        return {
            status: response.status,
            ok: response.ok,
            text: truncated ? rawText.slice(0, maxBytes) : rawText,
            truncated,
            url: response.url || String(url),
            headers: response.headers
        };
    } catch (error) {
        if (error?.name === 'AbortError' && !error.code) {
            throw buildAbortError('请求已中止', 'aborted');
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

/** 发起请求并解析 JSON，失败时抛出带状态码的错误 */
export async function requestJson(url, options = {}) {
    const response = await requestText(url, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers || {}) }
    });
    if (!response.ok) {
        const error = new Error(`请求失败: HTTP ${response.status}`);
        error.status = response.status;
        error.url = response.url;
        throw error;
    }
    try {
        return JSON.parse(response.text);
    } catch {
        const error = new Error('响应不是合法 JSON');
        error.status = response.status;
        error.url = response.url;
        throw error;
    }
}

/** 发起请求并返回 Buffer（用于按页面声明字符集解码） */
export async function requestBuffer(url, options = {}) {
    const {
        method = 'GET',
        headers = {},
        timeoutMs = 15000,
        signal,
        maxBytes = 3 * 1024 * 1024
    } = options;

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(buildAbortError('请求超时', 'timeout')), Math.max(500, Number(timeoutMs) || 15000));
    const combined = combineSignals([signal, timeoutController.signal]);

    try {
        const response = await fetch(url, {
            method,
            headers: { ...BROWSER_HEADERS, ...headers },
            signal: combined,
            redirect: 'follow'
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const truncated = buffer.length > maxBytes;
        return {
            status: response.status,
            ok: response.ok,
            buffer: truncated ? buffer.subarray(0, maxBytes) : buffer,
            truncated,
            url: response.url || String(url),
            headers: response.headers
        };
    } finally {
        clearTimeout(timer);
    }
}

/** 根据 Content-Type 与页面 meta 声明解码文本（兼容 GBK 等中文页面） */
export function decodeBufferText(buffer, contentType = '') {
    const headerCharset = /charset=["']?([\w-]+)/i.exec(String(contentType || ''))?.[1] || '';
    let charset = headerCharset.toLowerCase();
    if (!charset) {
        const head = buffer.subarray(0, 4096).toString('latin1');
        charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() || 'utf-8';
    }
    if (charset === 'gb2312' || charset === 'gb-2312') {
        charset = 'gbk';
    }
    try {
        return new TextDecoder(charset).decode(buffer);
    } catch {
        return new TextDecoder('utf-8').decode(buffer);
    }
}

export function isAbortError(error) {
    return error?.name === 'AbortError';
}

export function isTimeoutError(error) {
    return error?.name === 'AbortError' && error?.code === 'timeout';
}
