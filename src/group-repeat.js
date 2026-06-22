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

export function shouldObserveGroupRepeatMessage({ config = {}, event = {}, text = '', routingDecision = {}, botSelfId = '' } = {}) {
    const repeatConfig = normalizeGroupRepeatConfig(config.chat?.groupRepeat || config.groupRepeat || {});
    if (!repeatConfig.enabled) {
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
    return Boolean(normalizeRepeatText(text));
}

export class GroupRepeatDetector {
    constructor() {
        this.groupState = new Map();
    }

    reset() {
        this.groupState.clear();
    }

    observeMessage({ config = {}, event = {}, text = '', botSelfId = '', now = Date.now(), item = null } = {}) {
        const repeatConfig = normalizeGroupRepeatConfig(config.chat?.groupRepeat || config.groupRepeat || {});
        if (!shouldObserveGroupRepeatMessage({ config, event, text, botSelfId })) {
            return { shouldRepeat: false, reason: repeatConfig.enabled ? 'not_observable' : 'disabled' };
        }

        const groupId = String(event.group_id || '');
        if (!groupId) {
            return { shouldRepeat: false, reason: 'missing_group_id' };
        }

        const normalizedText = normalizeRepeatText(text);
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
        for (const item of Array.isArray(items) ? items : []) {
            const result = this.observeMessage({
                config,
                event: item?.event || {},
                text: item?.plainText || '',
                botSelfId,
                now,
                item
            });
            if (result.shouldRepeat) {
                matched = result;
            }
        }
        return matched || { shouldRepeat: false, reason: 'no_match' };
    }
}
