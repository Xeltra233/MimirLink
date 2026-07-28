import { parseVoiceTags } from './tts.js';
import { buildVoicePrefaceText } from './tools.js';

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function buildGroupMentionPrefix(userId) {
    if (userId === undefined || userId === null || userId === '') {
        return '';
    }

    return `[CQ:at,qq=${String(userId)}] `;
}

function buildVoiceFallbackText(content, { explicitVoice = false } = {}) {
    const text = String(content || '').trim();
    if (explicitVoice) {
        return text
            ? `语音合成失败，原语音内容：${text}`
            : '语音合成失败，且没有可回退的语音文本。';
    }

    return text
        ? `语音合成失败，先发送文本回复：${text}`
        : '语音合成失败，且没有可回退的文本回复。';
}

/**
 * 构造语音/文件消息前缀（reply / at）。
 * 与纯文本回复链路解耦：调用方显式传入 mentionSender，避免点歌与 TTS 共用一个隐式开关后互相误伤。
 * - 点歌：可传 mentionSender=true（用户要求点歌仍可 @）
 * - TTS：可传 mentionSender=false（语音不走文本必须 @ 的策略）
 */
export function buildMediaPrefixSegments(event, {
    quoteReplyEnabled = true,
    mentionSender = false,
    hasSentPrimary = false
} = {}) {
    if (hasSentPrimary) {
        return [];
    }

    const segments = [];
    if (quoteReplyEnabled && event?.message_id) {
        segments.push({ type: 'reply', data: { id: String(event.message_id) } });
    }

    if (event?.message_type === 'group' && mentionSender && event?.user_id) {
        segments.push({ type: 'at', data: { qq: String(event.user_id) } });
    }

    return segments;
}

// 兼容旧名；历史参数 mentionSenderOnReply 易与文本开关混淆，新代码请用 buildMediaPrefixSegments
function buildVoicePrefixSegments(event, {
    quoteReplyEnabled = true,
    mentionSenderOnReply = true,
    hasSentPrimary = false
} = {}) {
    return buildMediaPrefixSegments(event, {
        quoteReplyEnabled,
        mentionSender: mentionSenderOnReply === true,
        hasSentPrimary
    });
}

export async function dispatchReply(event, processedReply, options = {}, deps = {}) {
    const {
        config,
        bot,
        ttsManager,
        logger = console,
        recordDashboardMetric = () => {},
        sleep = defaultSleep
    } = deps;

    const ttsConfig = ttsManager?.getConfig?.() || {};
    const { textParts, hasVoice } = parseVoiceTags(String(processedReply || ''));
    const splitMessage = options.forceSingleMessage ? false : config.chat.splitMessage !== false;
    const segmentDelayMs = config.chat.segmentDelayMs ?? 300;
    const proactiveIntervalMs = config.chat.proactiveMessageIntervalMs ?? Math.max(segmentDelayMs, 1200);
    const quoteReplyEnabled = config.chat.quoteReplyEnabled !== false;
    const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;
    const mentionPrefix = event.message_type === 'group' && mentionSenderOnReply ? buildGroupMentionPrefix(event.user_id) : '';
    const ttsEnabled = ttsConfig.enabled === true;
    let hasSentPrimary = false;

    const sendText = async (content) => {
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;
        if (event.message_type === 'group') {
            if (quoteReplyEnabled && event.message_id) {
                if (!hasSentPrimary && mentionSenderOnReply && event.user_id) {
                    const segments = [
                        { type: 'reply', data: { id: String(event.message_id) } },
                        { type: 'at', data: { qq: String(event.user_id) } },
                        { type: 'text', data: { text: String(content) } }
                    ];
                    await bot.sendGroupMessage(event.group_id, segments);
                } else {
                    await bot.sendGroupReply(event.group_id, event.message_id, message);
                }
            } else {
                await bot.sendGroupMessage(event.group_id, message);
            }
        } else if (quoteReplyEnabled && event.message_id) {
            await bot.sendPrivateReply(event.user_id, event.message_id, message);
        } else {
            await bot.sendPrivateMessage(event.user_id, message);
        }

        hasSentPrimary = true;
    };

    const sendVoice = async (audioPath) => {
        // TTS 语音不走文本「必须 @」策略：只保留可选引用，绝不拼 at。
        // 点歌路径在 index.js 单独传 mentionSender，不会被这里影响。
        const prefixSegments = buildMediaPrefixSegments(event, {
            quoteReplyEnabled,
            mentionSender: false,
            hasSentPrimary
        });

        if (event.message_type === 'group') {
            if (typeof bot.sendGroupRecord !== 'function') {
                throw new Error('当前 OneBot 适配器不支持发送群语音');
            }
            await bot.sendGroupRecord(event.group_id, audioPath, prefixSegments);
        } else {
            if (typeof bot.sendPrivateRecord !== 'function') {
                throw new Error('当前 OneBot 适配器不支持发送私聊语音');
            }
            await bot.sendPrivateRecord(event.user_id, audioPath, prefixSegments);
        }

        hasSentPrimary = true;
    };

    const sendTtsContent = async (content, { explicitVoice = false } = {}) => {
        try {
            logger.info?.(`[TTS] 合成语音: ${String(content || '').substring(0, 30)}...`);
            recordDashboardMetric('tts');
            const audioPath = await ttsManager.synthesize(content);
            await sendVoice(audioPath);
            logger.info?.('[TTS] 语音发送成功');
        } catch (error) {
            logger.warn?.(`[TTS] 语音合成或发送失败: ${error.message}`);
            await sendText(buildVoiceFallbackText(content, { explicitVoice }));
        }
    };

    for (let partIndex = 0; partIndex < textParts.length; partIndex += 1) {
        const part = textParts[partIndex];
        const content = String(part.content || '').trim();

        if (part.type === 'text') {
            // 无 [voice] 标签且开启 TTS：整段当语音（历史行为）
            // 有 [voice] 标签：正文保持文字，只有 voice 段才合成，实现「文字里夹语音」
            if (ttsEnabled && !hasVoice) {
                if (content) {
                    await sendTtsContent(content, { explicitVoice: false });
                }
                continue;
            }

            const segments = splitMessage
                ? content.split(/\n\n+/).filter((segment) => segment.trim())
                : [content];

            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index];
                const segmentContent = segment.trim();
                if (!segmentContent) {
                    continue;
                }

                const isPrimarySend = !hasSentPrimary;
                await sendText(segmentContent);
                const hasMoreSegments = index < segments.length - 1 || partIndex < textParts.length - 1;
                const delayMs = isPrimarySend ? segmentDelayMs : proactiveIntervalMs;
                if (hasMoreSegments && delayMs > 0) {
                    await sleep(delayMs);
                }
            }
            continue;
        }

        if (part.type === 'voice' && ttsEnabled) {
            await sendTtsContent(content, { explicitVoice: true });
            continue;
        }

        if (part.type === 'voice') {
            // TTS 未启用时无法真正发 record，给出可读回退，避免静默丢语音意图
            const preface = buildVoicePrefaceText(content);
            await sendText(preface.includes('语音') ? `${preface}（当前未启用 TTS，无法发送语音消息）` : `语音内容：${content || '（空）'}（当前未启用 TTS，无法发送语音消息）`);
        }
    }
}
