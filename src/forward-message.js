/**
 * 合并转发（OneBot forward 消息段）读取支持
 * - 识别消息中的 forward 段
 * - 通过 OneBot get_forward_msg 拉取被合并的聊天记录并渲染为可读文本
 * - 抽取记录中的图片段，交给图片转述链路（多条消息里的多张图都能读到）
 * - 兼容 go-cqhttp / NapCat / Lagrange 等不同返回结构
 */
import { getOneBotMessageSegments } from './image-input.js';

const DEFAULT_MAX_NODES = 30;
const DEFAULT_MAX_CHARS = 2500;
const DEFAULT_MAX_TRANSCRIPTS = 2;

function toText(value) {
    return String(value ?? '').replace(/\r/g, '').trim();
}

/** 找出消息段中的 forward 段（返回原始下标与 forward id） */
export function findForwardSegments(segments = []) {
    return (Array.isArray(segments) ? segments : [])
        .map((segment, index) => ({ segment, index }))
        .filter(({ segment }) => segment && typeof segment === 'object' && String(segment.type || '') === 'forward')
        .map(({ segment, index }) => {
            const data = segment.data || {};
            const id = toText(data.id || data.message_id || data.messageId || data.res_id || data.resId);
            return { index, id };
        })
        .filter((item) => item.id);
}

/** 归一化 get_forward_msg 返回的各种结构 */
export function normalizeForwardNodes(payload) {
    const candidates = [];
    const pushArray = (value) => {
        if (Array.isArray(value)) {
            candidates.push(...value);
            return true;
        }
        return false;
    };

    if (pushArray(payload)) {
        // 直接是数组
    } else if (payload && typeof payload === 'object') {
        let found = false;
        for (const key of ['messages', 'message', 'nodes', 'data']) {
            const value = payload[key];
            if (pushArray(value)) {
                found = true;
                break;
            }
            if (value && typeof value === 'object') {
                for (const innerKey of ['messages', 'message', 'nodes']) {
                    if (pushArray(value[innerKey])) {
                        found = true;
                        break;
                    }
                }
                if (found) break;
            }
        }
    }

    return candidates.map((node) => {
        const sender = node?.sender && typeof node.sender === 'object' ? node.sender : {};
        const content = node?.message ?? node?.content ?? node?.data ?? node?.message_content ?? [];
        return {
            name: toText(node?.nickname || sender?.card || sender?.nickname || node?.name || node?.user_id || sender?.user_id || '未知'),
            userId: toText(node?.user_id || sender?.user_id || ''),
            content
        };
    }).filter((node) => Array.isArray(node.content) || typeof node.content === 'string');
}

/** 将 CQ 码字符串转为可读文本（仅处理常见类型） */
export function renderCqString(raw) {
    return toText(raw)
        .replace(/\[CQ:image[^\]]*\]/g, '[图片]')
        .replace(/\[CQ:record[^\]]*\]/g, '[语音]')
        .replace(/\[CQ:video[^\]]*\]/g, '[视频]')
        .replace(/\[CQ:face[^\]]*\]/g, '[QQ表情]')
        .replace(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g, '@$1')
        .replace(/\[CQ:forward[^\]]*\]/g, '[合并转发聊天记录]')
        .replace(/\[CQ:[^\]]*\]/g, '')
        .trim();
}

/** 渲染单个节点内容为文本 */
export function renderForwardNodeContent(content, renderSegment = null) {
    if (typeof content === 'string') {
        return renderCqString(content);
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content.map((segment) => {
        if (segment && typeof segment === 'object' && segment.type === 'forward') {
            return '[嵌套合并转发聊天记录]';
        }
        const summary = typeof renderSegment === 'function' ? renderSegment(segment) : null;
        const promptText = summary?.promptText ?? (segment?.type === 'text' ? String(segment?.data?.text || '') : `[消息段:${segment?.type || 'unknown'}]`);
        return promptText;
    }).join('');
}

/**
 * 从合并转发节点中抽取图片段（按出现顺序，跨多条消息累计）。
 * @returns {Array<{ segment:object, nodeIndex:number, nodeName:string, nodeUserId:string }>}
 */
export function collectForwardImageSegments(nodes = [], { max = Number.POSITIVE_INFINITY } = {}) {
    const limited = Math.max(0, Number(max) || 0) || Number.POSITIVE_INFINITY;
    const images = [];
    for (let nodeIndex = 0; nodeIndex < nodes.length && images.length < limited; nodeIndex += 1) {
        const node = nodes[nodeIndex] || {};
        const segments = Array.isArray(node.content)
            ? node.content
            : getOneBotMessageSegments(node.content);
        for (const segment of segments) {
            if (!segment || typeof segment !== 'object' || segment.type !== 'image') continue;
            images.push({
                segment,
                nodeIndex,
                nodeName: toText(node.name),
                nodeUserId: toText(node.userId)
            });
            if (images.length >= limited) break;
        }
    }
    return images;
}

/**
 * 拉取并渲染合并转发内容。
 * @returns {Promise<{ok:boolean, count?:number, transcript?:string, error?:string}>}
 */
export async function fetchForwardTranscript({
    bot,
    forwardId,
    renderSegment = null,
    maxNodes = DEFAULT_MAX_NODES,
    maxChars = DEFAULT_MAX_CHARS,
    logger = console
} = {}) {
    const id = toText(forwardId);
    if (!id) {
        return { ok: false, error: '缺少合并转发 id' };
    }
    if (!bot || typeof bot._call !== 'function') {
        return { ok: false, error: 'OneBot 客户端不可用' };
    }

    let payload = null;
    let lastError = null;
    for (const params of [{ id }, { message_id: id }]) {
        try {
            payload = await bot._call('get_forward_msg', params);
            if (payload) {
                break;
            }
        } catch (error) {
            lastError = error;
        }
    }
    if (!payload) {
        const message = lastError?.message || '接口无返回';
        logger?.debug?.(`[合并转发] 读取失败: ${id} ${message}`);
        return { ok: false, error: message };
    }

    const nodes = normalizeForwardNodes(payload);
    if (nodes.length === 0) {
        return { ok: false, error: '合并转发内容为空' };
    }

    const shown = nodes.slice(0, Math.max(1, Number(maxNodes) || DEFAULT_MAX_NODES));
    const limit = Math.max(200, Number(maxChars) || DEFAULT_MAX_CHARS);
    const lines = [];
    let total = 0;
    for (let index = 0; index < shown.length; index += 1) {
        const node = shown[index];
        const text = renderForwardNodeContent(node.content, renderSegment).trim();
        if (!text) {
            continue;
        }
        const line = `${index + 1}. ${node.name}: ${text}`;
        if (total + line.length > limit) {
            lines.push(`…（共 ${nodes.length} 条，已截断）`);
            break;
        }
        lines.push(line);
        total += line.length;
    }

    if (lines.length === 0) {
        return { ok: false, error: '合并转发内容为空' };
    }

    const imageSegments = collectForwardImageSegments(nodes);
    const imageNote = imageSegments.length > 0 ? `|含图片${imageSegments.length}张` : '';

    return {
        ok: true,
        count: nodes.length,
        nodes,
        imageSegments,
        transcript: `[合并转发聊天记录|共${nodes.length}条${imageNote}]\n${lines.join('\n')}\n[/合并转发]`
    };
}

/** 批量读取（用于一条消息里有多个 forward 段的场景） */
export async function fetchForwardTranscripts({
    bot,
    forwardIds = [],
    renderSegment = null,
    maxTranscripts = DEFAULT_MAX_TRANSCRIPTS,
    logger = console
} = {}) {
    const results = [];
    for (const forwardId of forwardIds.slice(0, Math.max(1, Number(maxTranscripts) || DEFAULT_MAX_TRANSCRIPTS))) {
        results.push(await fetchForwardTranscript({ bot, forwardId, renderSegment, logger }));
    }
    return results;
}
