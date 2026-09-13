/**
 * 网页正文读取（web_fetch）
 * 移植 Mozilla Readability（Apache-2.0）：https://github.com/mozilla/readability
 * 宿主使用 jsdom（MIT）。
 *
 * 安全：仅允许 http/https，拒绝本机/内网地址（含 DNS 解析后的私网 IP），作为基础 SSRF 防护。
 */

import dns from 'node:dns/promises';
import { requestBuffer, decodeBufferText, clampInteger, isAbortError } from './http.js';

const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_CHARS_LIMIT = 50000;

const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

function isPrivateIPv4(address) {
    const parts = String(address).split('.').map((value) => Number(value));
    if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        return false;
    }
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
}

function isPrivateIPv6(address) {
    const normalized = String(address).toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fe80') || normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return false;
}

export function isPrivateAddress(address) {
    return String(address).includes(':') ? isPrivateIPv6(address) : isPrivateIPv4(address);
}

export function isPrivateHostname(hostname) {
    const normalized = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    if (!normalized) return true;
    if (PRIVATE_HOSTNAMES.has(normalized)) return true;
    if (normalized.endsWith('.local') || normalized.endsWith('.internal') || normalized.endsWith('.localhost')) return true;
    if (isPrivateAddress(normalized)) return true;
    return false;
}

async function assertPublicUrl(parsedUrl) {
    if (isPrivateHostname(parsedUrl.hostname)) {
        throw new Error('拒绝访问本机或内网地址');
    }
    try {
        const records = await dns.lookup(parsedUrl.hostname, { all: true, verbatim: true });
        if (records.some((record) => isPrivateAddress(record.address))) {
            throw new Error('拒绝访问解析到内网 IP 的地址');
        }
    } catch (error) {
        if (/拒绝访问/.test(error.message)) {
            throw error;
        }
        // DNS 查询失败时交给 fetch 报错，不在这里拦截
    }
}

function normalizeText(value) {
    return String(value || '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\f\v]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function truncateText(value, maxLength) {
    const text = String(value || '');
    if (text.length <= maxLength) {
        return { text, truncated: false };
    }
    return { text: `${text.slice(0, maxLength)}…`, truncated: true };
}

/**
 * 读取网页正文。
 * @returns {Promise<{ok:boolean,url:string,title:string,byline:string,siteName:string,text:string,chars:number,truncated:boolean,quality:'readable'|'fallback'}>}
 */
export async function fetchPageContent({ url, maxChars = 8000, timeoutMs = 15000, signal, logger = console } = {}) {
    const rawUrl = String(url || '').trim();
    if (!rawUrl) {
        throw new Error('URL 不能为空');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(rawUrl);
    } catch {
        throw new Error(`无效的 URL: ${rawUrl}`);
    }
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        throw new Error('只支持 http/https 地址');
    }
    await assertPublicUrl(parsedUrl);

    const response = await requestBuffer(parsedUrl.toString(), {
        headers: { Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5' },
        timeoutMs,
        signal,
        maxBytes: MAX_PAGE_BYTES
    });

    if (!response.ok) {
        throw new Error(`页面返回 HTTP ${response.status}`);
    }

    // 跳转后的最终地址再做一次校验
    try {
        const finalUrl = new URL(response.url);
        if (finalUrl.hostname !== parsedUrl.hostname) {
            await assertPublicUrl(finalUrl);
        }
    } catch {
        // 最终地址无法解析时忽略（响应已经拿到）
    }

    const contentType = response.headers.get('content-type') || '';
    const html = decodeBufferText(response.buffer, contentType);
    const limit = clampInteger(maxChars, 500, MAX_CHARS_LIMIT, 8000);
    let title = '';
    let byline = '';
    let siteName = '';
    let excerpt = '';
    let text = '';
    let quality = 'fallback';

    try {
        const [{ JSDOM }, { Readability }] = await Promise.all([import('jsdom'), import('@mozilla/readability')]);
        const dom = new JSDOM(html, { url: response.url });
        try {
            const article = new Readability(dom.window.document).parse();
            if (article && typeof article.textContent === 'string' && article.textContent.trim()) {
                title = String(article.title || dom.window.document.title || '').trim();
                byline = String(article.byline || '').trim();
                siteName = String(article.siteName || '').trim();
                excerpt = normalizeText(article.excerpt || '');
                text = normalizeText(article.textContent);
                quality = 'readable';
            }
        } finally {
            dom.window.close();
        }
    } catch (error) {
        logger?.warn?.('[web_fetch] Readability 解析失败，降级为文本提取', { url: response.url, error: error.message });
    }

    if (!text) {
        text = normalizeText(
            html
                .replace(/<script[\s\S]*?<\/script>/gi, ' ')
                .replace(/<style[\s\S]*?<\/style>/gi, ' ')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
                .replace(/<[^>]*>/g, ' ')
        );
        if (!title) {
            title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '').trim();
        }
    }

    if (!text) {
        throw new Error('未能提取到页面正文（可能是纯图片或需要登录的页面）');
    }

    const truncated = truncateText(text, limit);
    return {
        ok: true,
        url: response.url || parsedUrl.toString(),
        title,
        byline,
        siteName,
        excerpt,
        text: truncated.text,
        chars: truncated.text.length,
        truncated: truncated.truncated,
        quality
    };
}
