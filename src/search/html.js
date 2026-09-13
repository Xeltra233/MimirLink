/**
 * 搜索模块 HTML 解析辅助
 * - HTML 实体解码（html-entities）
 * - DuckDuckGo 跳转链接解包（uddg）
 * - DuckDuckGo html / lite 端点结果提取
 * - 反爬/验证码页面识别
 */

import { decode } from 'html-entities';

export function decodeHtmlText(value) {
    const text = String(value ?? '');
    if (!text) {
        return '';
    }
    try {
        return decode(text);
    } catch {
        return text;
    }
}

/** 去掉标签、脚本、样式并解码实体，压缩空白 */
export function stripHtml(value) {
    const text = String(value ?? '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    return decodeHtmlText(text).replace(/\s+/g, ' ').trim();
}

/** 解包 DuckDuckGo 的 /l/?uddg= 跳转链接 */
export function unwrapDuckDuckGoRedirect(href) {
    const raw = String(href || '').trim();
    if (!raw) {
        return '';
    }
    if (/^(?:https?:)?\/\/(?:www\.)?duckduckgo\.com\/l\/\?/i.test(raw) || /^\/l\/\?/i.test(raw)) {
        try {
            const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
            const target = url.searchParams.get('uddg');
            if (target) {
                return target;
            }
        } catch {
            return '';
        }
        return '';
    }
    if (raw.startsWith('//')) {
        return `https:${raw}`;
    }
    return raw;
}

/** DDG 反爬/验证码/异常页识别 */
export function isDuckDuckGoChallenge(html) {
    const text = String(html || '');
    return /anomalyDetectionBlock|anomaly-modal|DDG\.deep\.is506|jsa_hash|challenge-form|Sorry, you have been blocked/i.test(text);
}

function extractAttribute(tagAttributes, name) {
    const regex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = regex.exec(tagAttributes || '');
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : '';
}

/**
 * 解析 html.duckduckgo.com/html/ 端点结果。
 * 结构：div.result__body > h2.result__title > a.result__a + a.result__snippet
 */
export function extractDuckDuckGoHtmlResults(html, limit = 5) {
    const source = String(html || '');
    const results = [];
    const anchorRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    const anchors = [];
    let match;
    while ((match = anchorRegex.exec(source)) !== null) {
        const attrs = match[1] || '';
        const className = extractAttribute(attrs, 'class');
        if (!/\bresult__a\b/.test(className)) {
            continue;
        }
        const href = extractAttribute(attrs, 'href');
        const title = stripHtml(match[2]);
        if (!href || !title) {
            continue;
        }
        anchors.push({ start: match.index, end: anchorRegex.lastIndex, href, title });
    }

    for (let index = 0; index < anchors.length; index += 1) {
        const anchor = anchors[index];
        const nextStart = index + 1 < anchors.length ? anchors[index + 1].start : source.length;
        const block = source.slice(anchor.end, nextStart);
        const snippetMatch = /<(?:a|div|span|td)[^>]*\bclass\s*=\s*"([^"]*\bresult__snippet\b[^"]*)"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i.exec(block);
        const snippet = snippetMatch ? stripHtml(snippetMatch[2]) : '';
        const url = unwrapDuckDuckGoRedirect(anchor.href);
        if (!url) {
            continue;
        }
        results.push({ title: anchor.title, url, snippet });
        if (results.length >= Math.max(1, Number(limit) || 5)) {
            break;
        }
    }

    return results;
}

/**
 * 解析 lite.duckduckgo.com/lite/ 端点结果（表格结构）。
 * 结构：<a class="result-link" href="...">标题</a> + <td class="result-snippet">摘要</td>
 */
export function extractDuckDuckGoLiteResults(html, limit = 5) {
    const source = String(html || '');
    const results = [];
    const titleRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    const titles = [];
    let match;
    while ((match = titleRegex.exec(source)) !== null) {
        const attrs = match[1] || '';
        const className = extractAttribute(attrs, 'class');
        if (!/\bresult-link\b/.test(className)) {
            continue;
        }
        const href = extractAttribute(attrs, 'href');
        const title = stripHtml(match[2]);
        if (!href || !title) {
            continue;
        }
        titles.push({ start: match.index, end: titleRegex.lastIndex, href, title });
    }

    const snippetRegex = /<td\b[^>]*\bclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/gi;
    const snippets = [];
    while ((match = snippetRegex.exec(source)) !== null) {
        snippets.push({ start: match.index, text: stripHtml(match[1]) });
    }

    for (let index = 0; index < titles.length; index += 1) {
        const item = titles[index];
        const url = unwrapDuckDuckGoRedirect(item.href);
        if (!url) {
            continue;
        }
        const snippet = snippets.find((entry) => entry.start > item.end)?.text || '';
        results.push({ title: item.title, url, snippet });
        if (results.length >= Math.max(1, Number(limit) || 5)) {
            break;
        }
    }

    return results;
}
