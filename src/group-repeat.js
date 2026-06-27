const DEFAULT_GROUP_REPEAT_CONFIG = Object.freeze({
    enabled: false,
    triggerCount: 2,
    cooldownMs: 180000
});

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }
    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

export function normalizeGroupRepeatConfig(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
        enabled: source.enabled === true,
        triggerCount: clampInteger(source.triggerCount, 2, 10, DEFAULT_GROUP_REPEAT_CONFIG.triggerCount),
        cooldownMs: clampInteger(source.cooldownMs, 1000, 3600000, DEFAULT_GROUP_REPEAT_CONFIG.cooldownMs)
    };
}

export function getDefaultGroupRepeatConfig() {
    return { ...DEFAULT_GROUP_REPEAT_CONFIG };
}

export function normalizeRepeatText(text = '') {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function getSegmentType(segment) {
    return String(segment?.type || '').trim();
}

function normalizeSignal(value = '') {
    return String(value || '').trim().toLowerCase();
}

function getRepeatSignalSegments(item = null, messageSegments = []) {
    if (Array.isArray(messageSegments) && messageSegments.length > 0) {
        return messageSegments;
    }
    if (Array.isArray(item?.messageSegments) && item.messageSegments.length > 0) {
        return item.messageSegments;
    }
    if (Array.isArray(item?.standardEvent?.segments) && item.standardEvent.segments.length > 0) {
        return item.standardEvent.segments;
    }
    return [];
}

function isPokeInteraction({ event = {}, item = null, routingDecision = {}, messageSegments = [] } = {}) {
    const eventType = normalizeSignal(item?.eventType || item?.standardEvent?.eventType || event.eventType || event.event_type);
    if (eventType === 'poke') {
        return true;
    }

    const triggerReason = normalizeSignal(
        item?.triggerReason ||
        item?.routingDecision?.triggerReason ||
        item?.standardEvent?.routing?.triggerReason ||
        routingDecision?.triggerReason
    );
    if (triggerReason === 'poke') {
        return true;
    }

    return getRepeatSignalSegments(item, messageSegments).some((segment) => normalizeSignal(segment?.type) === 'poke');
}

function getTextSegmentContent(segment) {
    if (!segment || typeof segment !== 'object') {
        return '';
    }
    const data = segment.data && typeof segment.data === 'object' ? segment.data : {};
    return String(data.text || '');
}

function containsNonTextCqCode(text = '') {
    return /\[CQ:(?!text\b)[^\]]+\]/i.test(String(text || ''));
}

export function getRepeatableMessageText(event = {}, fallbackText = '') {
    if (Array.isArray(event.message) && event.message.length > 0) {
        const textParts = [];
        for (const segment of event.message) {
            const type = getSegmentType(segment);
            if (type === 'reply') {
                continue;
            }
            if (type !== 'text') {
                return '';
            }
            textParts.push(getTextSegmentContent(segment));
        }
        return normalizeRepeatText(textParts.join(''));
    }

    const rawCandidate = typeof event.message === 'string'
        ? event.message
        : (event.raw_message || '');
    if (containsNonTextCqCode(rawCandidate)) {
        return '';
    }
    const candidate = rawCandidate || fallbackText || '';
    if (containsNonTextCqCode(candidate)) {
        return '';
    }
    return normalizeRepeatText(candidate);
}

export function shouldObserveGroupRepeatMessage({ config = {}, event = {}, text = '', routingDecision = {}, botSelfId = '', item = null, messageSegments = [] } = {}) {
    const repeatConfig = normalizeGroupRepeatConfig(config.chat?.groupRepeat || config.groupRepeat || {});
    if (!repeatConfig.enabled) {
        return false;
    }
    const postType = normalizeSignal(event.post_type);
    if (postType && postType !== 'message') {
        return false;
    }
    if (isPokeInteraction({ event, item, routingDecision, messageSegments })) {
        return false;
    }
    if (event.message_type !== 'group') {
        return false;
    }
    const senderId = String(event.user_id || '');
    const selfIds = [botSelfId, event.self_id].map((value) => String(value || '')).filter(Boolean);
    if (senderId && selfIds.includes(senderId)) {
        return false;
    }
    if (routingDecision?.checks && routingDecision.checks.allowed === false) {
        return false;
    }
    return Boolean(getRepeatableMessageText(event, text));
}

export class GroupRepeatDetector {
    constructor() {
        this.groupState = new Map();
        this.cooldowns = new Map();
    }

    reset() {
        this.groupState.clear();
        this.cooldowns.clear();
    }

    getGroupCooldowns(groupId) {
        if (!this.cooldowns.has(groupId)) {
            this.cooldowns.set(groupId, new Map());
        }
        return this.cooldowns.get(groupId);
    }

    cleanupCooldowns(now = Date.now()) {
        for (const [groupId, entries] of this.cooldowns.entries()) {
            for (const [normalizedText, expiresAt] of entries.entries()) {
                if (expiresAt <= now) {
                    entries.delete(normalizedText);
                }
            }
            if (entries.size === 0) {
                this.cooldowns.delete(groupId);
            }
        }
    }

    observeMessage({ config = {}, event = {}, text = '', botSelfId = '', now = Date.now(), item = null, routingDecision = item?.routingDecision || {} } = {}) {
        const repeatConfig = normalizeGroupRepeatConfig(config.chat?.groupRepeat || config.groupRepeat || {});
        if (!shouldObserveGroupRepeatMessage({ config, event, text, botSelfId, item, routingDecision })) {
            return { shouldRepeat: false, reason: repeatConfig.enabled ? 'not_observable' : 'disabled' };
        }

        const groupId = String(event.group_id || '');
        if (!groupId) {
            return { shouldRepeat: false, reason: 'missing_group_id' };
        }

        const normalizedText = getRepeatableMessageText(event, text);
        this.cleanupCooldowns(now);
        const groupCooldowns = this.getGroupCooldowns(groupId);
        const cooldownExpiresAt = groupCooldowns.get(normalizedText) || 0;
        if (cooldownExpiresAt > now) {
            return {
                shouldRepeat: false,
                reason: 'cooldown',
                groupId,
                normalizedText,
                repeatText: normalizedText,
                cooldownExpiresAt,
                event,
                item
            };
        }

        const previous = this.groupState.get(groupId);
        const count = previous?.normalizedText === normalizedText
            ? previous.count + 1
            : 1;
        const repeatText = normalizedText;
        const nextState = {
            normalizedText,
            repeatText,
            count,
            updatedAt: now
        };

        if (count >= repeatConfig.triggerCount) {
            const cooldownExpiresAt = now + repeatConfig.cooldownMs;
            groupCooldowns.set(normalizedText, cooldownExpiresAt);
            this.groupState.set(groupId, {
                ...nextState,
                count: 0
            });
            return {
                shouldRepeat: true,
                reason: 'matched',
                groupId,
                normalizedText,
                repeatText,
                count,
                triggerCount: repeatConfig.triggerCount,
                cooldownExpiresAt,
                event,
                item
            };
        }

        this.groupState.set(groupId, nextState);
        return {
            shouldRepeat: false,
            reason: 'tracking',
            groupId,
            normalizedText,
            repeatText,
            count,
            triggerCount: repeatConfig.triggerCount,
            event,
            item
        };
    }

    observeBatch({ config = {}, items = [], botSelfId = '', now = Date.now() } = {}) {
        let matched = null;
        let lastResult = null;
        for (const item of Array.isArray(items) ? items : []) {
            const result = this.observeMessage({
                config,
                event: item?.event || {},
                text: item?.plainText || '',
                botSelfId,
                now,
                item
            });
            lastResult = result;
            if (result.shouldRepeat) {
                matched = result;
            }
        }
        return matched || lastResult || { shouldRepeat: false, reason: 'no_match' };
    }
}
