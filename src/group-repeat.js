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
