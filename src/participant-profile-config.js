const DEFAULT_TRIGGER_MESSAGES = 8;
const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_SOURCE_MESSAGES = 50;
const DEFAULT_TRIGGER_MODE = 'idle';
const DEFAULT_ANALYSIS_MODE = 'bot_only_profile';
const VALID_ANALYSIS_MODES = ['messages_only', 'profile_plus_messages', 'bot_only_messages', 'bot_only_profile'];
const DEFAULT_MANUAL_COMMAND = '/人物档案';

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.floor(normalized);
}

function toOptionalString(value) {
    if (typeof value !== 'string') {
        return '';
    }

    return value.trim();
}

function toBoolean(value, fallback = false) {
    if (typeof value === 'boolean') {
        return value;
    }

    return fallback;
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(new Set(value
        .map((item) => (item == null ? '' : String(item).trim()))
        .filter(Boolean)));
}

function normalizeTriggerMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'idle' || normalized === 'interval' || normalized === 'both') {
        return normalized;
    }

    return DEFAULT_TRIGGER_MODE;
}

function normalizeAnalysisMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (VALID_ANALYSIS_MODES.includes(normalized)) {
        return normalized;
    }
    return DEFAULT_ANALYSIS_MODE;
}

export function getParticipantProfileConfig(config = {}) {
    const participantProfile = config.memory?.participantProfile || {};
    const providerId = toOptionalString(participantProfile.providerId)
        || toOptionalString(config.chat?.modelProviderId)
        || toOptionalString(config.ai?.activeProviderId);
    const selectedProvider = providerId && Array.isArray(config.ai?.providers)
        ? config.ai.providers.find((provider) => provider?.id === providerId)
        : null;
    const selectedProviderBaseUrl = toOptionalString(selectedProvider?.baseUrl);
    const selectedProviderApiKey = toOptionalString(selectedProvider?.apiKey);

    const result = {
        enabled: toBoolean(participantProfile.enabled, false),
        injectEnabled: toBoolean(participantProfile.injectEnabled, true),
        blacklistParticipantIds: normalizeStringList(participantProfile.blacklistParticipantIds),
        manualCommand: toOptionalString(participantProfile.manualCommand) || DEFAULT_MANUAL_COMMAND,
        threshold: toPositiveInteger(participantProfile.triggerMessages, DEFAULT_TRIGGER_MESSAGES),
        idleMs: toPositiveInteger(participantProfile.idleMs, DEFAULT_IDLE_MS),
        intervalMs: toPositiveInteger(participantProfile.intervalMs, DEFAULT_INTERVAL_MS),
        sourceMessageLimit: toPositiveInteger(participantProfile.maxSourceMessages, DEFAULT_MAX_SOURCE_MESSAGES),
        triggerMode: normalizeTriggerMode(participantProfile.triggerMode),
        analysisMode: normalizeAnalysisMode(participantProfile.analysisMode),
        model: toOptionalString(participantProfile.model) || toOptionalString(selectedProvider?.model),
        baseUrl: selectedProviderBaseUrl,
        apiKey: selectedProviderApiKey,
        retryOnError: participantProfile.retryOnError !== false
    };
    if (providerId) {
        result.providerId = providerId;
    }
    return result;
}

export function normalizeParticipantProfileConfig(config = {}) {
    config.memory = config.memory || {};
    config.memory.participantProfile = config.memory.participantProfile || {};

    const normalized = getParticipantProfileConfig(config);
    config.memory.participantProfile.enabled = normalized.enabled;
    config.memory.participantProfile.injectEnabled = normalized.injectEnabled;
    config.memory.participantProfile.blacklistParticipantIds = normalized.blacklistParticipantIds;
    config.memory.participantProfile.manualCommand = normalized.manualCommand;
    config.memory.participantProfile.triggerMessages = normalized.threshold;
    config.memory.participantProfile.idleMs = normalized.idleMs;
    config.memory.participantProfile.intervalMs = normalized.intervalMs;
    config.memory.participantProfile.maxSourceMessages = normalized.sourceMessageLimit;
    config.memory.participantProfile.triggerMode = normalized.triggerMode;
    config.memory.participantProfile.analysisMode = normalized.analysisMode;
    if (normalized.providerId) {
        config.memory.participantProfile.providerId = normalized.providerId;
    } else {
        delete config.memory.participantProfile.providerId;
    }
    config.memory.participantProfile.model = toOptionalString(config.memory.participantProfile.model);
    delete config.memory.participantProfile.baseUrl;
    delete config.memory.participantProfile.apiKey;
    config.memory.participantProfile.retryOnError = normalized.retryOnError;

    return normalized;
}

