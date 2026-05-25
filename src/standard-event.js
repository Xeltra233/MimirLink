function cleanText(value) {
    return String(value ?? '').replace(/\r/g, '').trim();
}

function compactText(value, limit = 180) {
    const text = cleanText(value);
    if (!text) return '';
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function getSenderName(sender = {}, fallbackId = '') {
    return cleanText(sender.card || sender.nickname || sender.name || fallbackId || '未知用户');
}

function buildSegmentReadableText(segment = {}, botSelfId = '') {
    const type = cleanText(segment.type || 'unknown');
    if (type === 'text') {
        return compactText(segment.text, 80) ? `文本:${compactText(segment.text, 80)}` : '文本';
    }
    if (type === 'at') {
        const qq = cleanText(segment.qq);
        if (qq === 'all') return '@全体成员';
        if (segment.isBot || (botSelfId && qq === String(botSelfId))) return '@bot';
        return qq ? `@${qq}` : '@某人';
    }
    if (type === 'reply') {
        return segment.id ? `引用消息:${segment.id}` : '引用消息';
    }
    if (type === 'face') {
        const name = compactText(segment.name || segment.summary || segment.text, 40);
        const id = cleanText(segment.id);
        return `QQ表情${name ? `:${name}` : ''}${id ? `|id=${id}` : ''}`;
    }
    if (type === 'mface') {
        const summary = compactText(segment.summary || segment.name || segment.text, 40);
        const id = cleanText(segment.id);
        return `QQ动态表情${summary ? `:${summary}` : ''}${id ? `|id=${id}` : ''}`;
    }
    if (type === 'marketface') {
        const summary = compactText(segment.summary || segment.name || segment.text, 40);
        const id = cleanText(segment.id);
        return `QQ大表情${summary ? `:${summary}` : ''}${id ? `|id=${id}` : ''}`;
    }
    if (type === 'image') {
        return `图片${segment.summary ? `:${compactText(segment.summary, 40)}` : ''}`;
    }
    if (type === 'record') return '语音';
    if (type === 'video') return '视频';
    if (type === 'file') return `文件${segment.name ? `:${compactText(segment.name, 40)}` : ''}`;
    if (type === 'json') return 'JSON消息';
    if (type === 'xml') return 'XML消息';
    if (type === 'poke') {
        const userId = cleanText(segment.userId || segment.user_id);
        const targetId = cleanText(segment.targetId || segment.target_id);
        return `戳一戳${userId || targetId ? `:${userId || 'unknown'}->${targetId || 'unknown'}` : ''}`;
    }
    return `消息段:${type}`;
}

function sanitizeSegment(segment = {}, botSelfId = '') {
    const copy = {};
    for (const [key, value] of Object.entries(segment || {})) {
        if (value === undefined || typeof value === 'function') continue;
        copy[key] = typeof value === 'string' ? cleanText(value) : value;
    }
    copy.type = cleanText(copy.type || 'unknown');
    copy.readableText = buildSegmentReadableText(copy, botSelfId);
    return copy;
}

export function formatStandardEventHeader(standardEvent = {}) {
    const parts = [
        standardEvent.chatTypeLabel || (standardEvent.messageType === 'private' ? '私聊' : '群聊'),
        `QQ:${standardEvent.sender?.id || ''}`,
        `昵称:${standardEvent.sender?.name || ''}`,
        `群号:${standardEvent.group?.id || 'N/A'}`,
        `群名:${standardEvent.group?.name || 'N/A'}`,
        `eventType:${standardEvent.eventType || 'message'}`,
        `isAtBot:${standardEvent.bot?.isAtBot ? 'true' : 'false'}`
    ];

    if (standardEvent.reply?.toBot !== null && standardEvent.reply?.toBot !== undefined) {
        parts.push(`replyToBot:${standardEvent.reply.toBot ? 'true' : 'false'}`);
    }
    if (standardEvent.reply?.messageId) {
        parts.push(`replyMessageId:${standardEvent.reply.messageId}`);
    }
    if (standardEvent.reply?.quotedText) {
        parts.push(`replyQuotedText:${compactText(standardEvent.reply.quotedText, 180)}`);
    }
    if (standardEvent.reply?.fetchStatus) {
        parts.push(`replyFetch:${standardEvent.reply.fetchStatus}`);
    }
    if (standardEvent.reply?.fetchReason) {
        parts.push(`replyFetchReason:${compactText(standardEvent.reply.fetchReason, 120)}`);
    }
    if (standardEvent.routing?.triggerReason) {
        parts.push(`triggerReason:${standardEvent.routing.triggerReason}`);
    }
    if (standardEvent.routing?.skipReason) {
        parts.push(`skipReason:${standardEvent.routing.skipReason}`);
    }

    const segmentText = (standardEvent.segments || [])
        .map((segment) => segment.readableText)
        .filter(Boolean)
        .join('; ');
    if (segmentText) {
        parts.push(`segments:${compactText(segmentText, 500)}`);
    }

    return `[${parts.join('|')}]`;
}

export function buildStandardEvent({
    event = {},
    contentText = '',
    rawText = '',
    eventType = null,
    isAtBot = false,
    replyToMessageId = null,
    replyInfo = null,
    messageSegments = [],
    botSelfId = '',
    routingDecision = null
} = {}) {
    const messageType = event.message_type === 'private' ? 'private' : 'group';
    const senderId = cleanText(event.user_id);
    const senderName = getSenderName(event.sender, senderId);
    const groupId = messageType === 'group' ? cleanText(event.group_id) : null;
    const groupName = messageType === 'group'
        ? cleanText(event.group_name || event.sender?.group_name || (groupId ? `群${groupId}` : ''))
        : null;

    const standardEvent = {
        version: 1,
        eventType: cleanText(eventType || event.post_type || 'message'),
        messageType,
        chatTypeLabel: messageType === 'private' ? '私聊' : '群聊',
        messageId: event.message_id ? cleanText(event.message_id) : null,
        time: event.time || null,
        group: {
            id: groupId,
            name: groupName
        },
        sender: {
            id: senderId,
            name: senderName,
            card: cleanText(event.sender?.card),
            nickname: cleanText(event.sender?.nickname)
        },
        bot: {
            selfId: cleanText(botSelfId),
            isAtBot: Boolean(isAtBot)
        },
        reply: {
            messageId: replyToMessageId ? cleanText(replyToMessageId) : null,
            toBot: replyInfo?.toBot ?? null,
            senderId: cleanText(replyInfo?.senderId),
            senderName: cleanText(replyInfo?.senderName),
            quotedText: cleanText(replyInfo?.quotedText),
            fetchStatus: cleanText(replyInfo?.fetchStatus),
            fetchReason: cleanText(replyInfo?.fetchReason)
        },
        segments: Array.isArray(messageSegments)
            ? messageSegments.map((segment) => sanitizeSegment(segment, botSelfId))
            : [],
        rawText: cleanText(rawText),
        contentText: cleanText(contentText),
        routing: routingDecision && typeof routingDecision === 'object'
            ? {
                shouldRespond: Boolean(routingDecision.shouldRespond),
                triggerReason: cleanText(routingDecision.triggerReason),
                skipReason: cleanText(routingDecision.skipReason)
            }
            : null
    };

    standardEvent.inputHeader = formatStandardEventHeader(standardEvent);
    standardEvent.inputText = standardEvent.contentText
        ? `${standardEvent.inputHeader} ${standardEvent.contentText}`
        : standardEvent.inputHeader;
    return standardEvent;
}

export function updateStandardEventRouting(standardEvent, routingDecision = {}) {
    if (!standardEvent || typeof standardEvent !== 'object') {
        return standardEvent;
    }

    standardEvent.routing = {
        shouldRespond: Boolean(routingDecision?.shouldRespond),
        triggerReason: cleanText(routingDecision?.triggerReason),
        skipReason: cleanText(routingDecision?.skipReason)
    };
    standardEvent.inputHeader = formatStandardEventHeader(standardEvent);
    standardEvent.inputText = standardEvent.contentText
        ? `${standardEvent.inputHeader} ${standardEvent.contentText}`
        : standardEvent.inputHeader;
    return standardEvent;
}
