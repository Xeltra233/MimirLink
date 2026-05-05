const DEFAULT_TRIGGER_MESSAGES = 8;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_SOURCE_MESSAGES = 50;

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.floor(normalized);
}

export function getParticipantProfileConfig(config = {}) {
    const participantProfile = config.memory?.participantProfile || {};

    return {
        threshold: toPositiveInteger(participantProfile.triggerMessages, DEFAULT_TRIGGER_MESSAGES),
        idleMs: toPositiveInteger(participantProfile.idleMs, DEFAULT_IDLE_MS),
        sourceMessageLimit: toPositiveInteger(participantProfile.maxSourceMessages, DEFAULT_MAX_SOURCE_MESSAGES)
    };
}

export function normalizeParticipantProfileConfig(config = {}) {
    config.memory = config.memory || {};
    config.memory.participantProfile = config.memory.participantProfile || {};

    const normalized = getParticipantProfileConfig(config);
    config.memory.participantProfile.triggerMessages = normalized.threshold;
    config.memory.participantProfile.idleMs = normalized.idleMs;
    config.memory.participantProfile.maxSourceMessages = normalized.sourceMessageLimit;

    return normalized;
}
