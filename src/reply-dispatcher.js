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

function buildVoicePrefixSegments(event, {
    quoteReplyEnabled = true,
    mentionSenderOnReply = true,
    hasSentPrimary = false
} = {}) {
    if (hasSentPrimary) {
        return [];
    }

    const segments = [];
    if (quoteReplyEnabled && event?.message_id) {
        segments.push({ type: 'reply', data: { id: String(event.message_id) } });
    }

    if (event?.message_type === 'group' && mentionSenderOnReply && event?.user_id) {
        segments.push({ type: 'at', data: { qq: String(event.user_id) } });
    }

    return segments;
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
    const { textParts } = parseVoiceTags(String(processedReply || ''));
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
        const prefixSegments = buildVoicePrefixSegments(event, {
            quoteReplyEnabled,
            mentionSenderOnReply,
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
            if (ttsEnabled) {
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
            await sendText(buildVoicePrefaceText(content));
        }
    }
}
