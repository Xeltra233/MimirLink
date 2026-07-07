export const DEFAULT_QQ_EMOJI_REACTION_ID = '289';

export const QQ_EMOJI_REACTION_ALIASES = Object.freeze({
    default: DEFAULT_QQ_EMOJI_REACTION_ID,
    '默认': DEFAULT_QQ_EMOJI_REACTION_ID,
    '收到': DEFAULT_QQ_EMOJI_REACTION_ID,
    ok: DEFAULT_QQ_EMOJI_REACTION_ID,
    okay: DEFAULT_QQ_EMOJI_REACTION_ID,
    '好的': DEFAULT_QQ_EMOJI_REACTION_ID,
    like: '76',
    thumb: '76',
    thumbs_up: '76',
    '赞': '76',
    '点赞': '76',
    heart: '66',
    love: '66',
    '爱心': '66',
    doge: '277',
    '狗头': '277'
});

function sanitizeText(value) {
    return String(value ?? '').trim();
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

export function normalizeEmojiReactionId(value, fallback = DEFAULT_QQ_EMOJI_REACTION_ID) {
    const rawValue = Array.isArray(value) ? value[0] : value;
    const normalizedFallback = /^\d+$/.test(sanitizeText(fallback)) ? sanitizeText(fallback) : DEFAULT_QQ_EMOJI_REACTION_ID;
    const rawText = sanitizeText(rawValue);
    if (!rawText) {
        return normalizedFallback;
    }

    const withoutPrefix = rawText.replace(/^qq[:：]/i, '').replace(/^id[:：]/i, '').trim();
    if (/^\d+$/.test(withoutPrefix)) {
        return withoutPrefix;
    }

    const lowerKey = withoutPrefix.toLowerCase();
    return QQ_EMOJI_REACTION_ALIASES[withoutPrefix]
        || QQ_EMOJI_REACTION_ALIASES[lowerKey]
        || normalizedFallback;
}

export function resolveEmojiReactionId(config = {}) {
    const chatConfig = config?.chat || {};
    return normalizeEmojiReactionId(
        chatConfig.emojiReactionId ?? chatConfig.emojiReactionEmojiId ?? chatConfig.emojiReaction?.id,
        DEFAULT_QQ_EMOJI_REACTION_ID
    );
}

export function isCommandInvocation(plainText = '', command = '') {
    const normalizedText = sanitizeText(plainText);
    const normalizedCommand = sanitizeText(command);
    if (!normalizedText || !normalizedCommand) {
        return false;
    }
    if (normalizedText === normalizedCommand) {
        return true;
    }
    if (!normalizedText.startsWith(normalizedCommand)) {
        return false;
    }

    const nextChar = normalizedText.slice(normalizedCommand.length, normalizedCommand.length + 1);
    return !nextChar || /\s/.test(nextChar) || nextChar === '@' || nextChar === '[' || nextChar === '［';
}

export function extractMentionedUserIds(event = {}) {
    const segments = Array.isArray(event.message) ? event.message : [];
    const seen = new Set();
    const targetUserIds = [];
    for (const segment of segments) {
        if (segment?.type !== 'at') {
            continue;
        }
        const qq = segment.data?.qq;
        if (qq === undefined || qq === null || String(qq) === 'all') {
            continue;
        }
        const targetUserId = sanitizeText(qq);
        if (targetUserId && !seen.has(targetUserId)) {
            seen.add(targetUserId);
            targetUserIds.push(targetUserId);
        }
    }
    return targetUserIds;
}

export function extractFirstMentionedUserId(event = {}) {
    return extractMentionedUserIds(event)[0] || '';
}

export function hasAtAllMention(event = {}) {
    const segments = Array.isArray(event.message) ? event.message : [];
    return segments.some((segment) => segment?.type === 'at' && String(segment.data?.qq) === 'all');
}

export function normalizePokeRepeatCount(value, fallback = 5) {
    return clampInteger(value, 1, 10, fallback);
}

export async function executeAdminPokeCommand({
    event = {},
    plainText = '',
    command = '/戳一戳',
    enabled = true,
    repeatCount = 5,
    isAdmin = false,
    bot = null,
    onCommandAccepted = null,
    sendFailureMessage = null,
    sendStatusMessage = null,
    logger = console
} = {}) {
    const normalizedCommand = sanitizeText(command) || '/戳一戳';
    if (!isCommandInvocation(plainText, normalizedCommand)) {
        return { handled: false, ok: false, reason: 'not_command' };
    }

    if (enabled === false) {
        return { handled: false, ok: false, reason: 'disabled' };
    }

    if (typeof onCommandAccepted === 'function') {
        onCommandAccepted();
    }

    const fail = async (message, reason) => {
        if (typeof sendFailureMessage === 'function') {
            await sendFailureMessage(message);
        }
        return { handled: true, ok: false, reason, error: message };
    };

    if (!isAdmin) {
        return fail('只有管理员可以使用戳一戳命令', 'not_admin');
    }

    if (event.message_type !== 'group' || !event.group_id) {
        return fail('戳一戳命令仅支持群聊使用', 'not_group');
    }

    if (hasAtAllMention(event)) {
        return fail('戳一戳不支持 @全体成员', 'at_all');
    }

    const targetUserIds = extractMentionedUserIds(event);
    if (targetUserIds.length === 0) {
        return fail(`请使用 ${normalizedCommand} @某人`, 'missing_target');
    }

    if (!bot || typeof bot.sendGroupPoke !== 'function') {
        return fail('当前 OneBot 不支持 group_poke，无法戳一戳', 'unsupported');
    }

    const normalizedRepeatCount = normalizePokeRepeatCount(repeatCount, 5);
    const completedByTarget = new Map(targetUserIds.map((targetUserId) => [targetUserId, 0]));
    let currentTargetUserId = targetUserIds[0];
    try {
        for (const targetUserId of targetUserIds) {
            currentTargetUserId = targetUserId;
            for (let index = 0; index < normalizedRepeatCount; index += 1) {
                await bot.sendGroupPoke(event.group_id, targetUserId);
                completedByTarget.set(targetUserId, (completedByTarget.get(targetUserId) || 0) + 1);
            }
        }
    } catch (error) {
        const completedCurrent = completedByTarget.get(currentTargetUserId) || 0;
        const completedTotal = Array.from(completedByTarget.values()).reduce((sum, count) => sum + count, 0);
        logger?.warn?.(`[戳一戳] 执行失败: ${currentTargetUserId} ${error.message}`);
        return fail(`戳一戳失败: ${error.message}（QQ ${currentTargetUserId} 已执行 ${completedCurrent}/${normalizedRepeatCount} 下，总计 ${completedTotal}/${targetUserIds.length * normalizedRepeatCount} 下）`, 'poke_failed');
    }

    return {
        handled: true,
        ok: true,
        groupId: String(event.group_id),
        targetUserId: targetUserIds[0],
        targetUserIds,
        targetCount: targetUserIds.length,
        repeatCount: normalizedRepeatCount
    };
}
