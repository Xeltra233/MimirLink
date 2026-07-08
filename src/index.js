/**
 * MimirLink 入口文件
 * 负责启动服务、装配依赖和处理消息调度。
 */

const colors = {
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    gray: '\x1b[90m',
    reset: '\x1b[0m'
};

console.log(`
${colors.cyan}========================================
   MimirLink Memory Runtime v2
========================================${colors.reset}

${colors.green}*${colors.reset} 会话调度与并发控制已启用
${colors.gray}├─ 缓冲聚合 / 延迟回复 / 去重
├─ 结构化记忆 / 摘要层 / 轻量预设
└─ 开关化配置支持热更新${colors.reset}
`);

import express from 'express';
import session from 'express-session';
import createFileStore from 'session-file-store';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

import { OneBotClient, buildMentionMessage } from './onebot.js';
import { buildAIToolContext, buildRealtimeGroundingMessage, appendMentionTaskToPromptMessages, generateMentionTextFromPrompt } from './tools.js';
import { CharacterManager } from './character.js';
import { WorldBookManager } from './worldbook.js';
import { PromptBuilder } from './prompt.js';
import { AIClient } from './ai.js';
import { SessionManager } from './session.js';
import { RegexProcessor } from './regex.js';
import { setupRoutes } from './routes.js';
import { syncPresetFiles } from './preset-sync.js';
import { Logger } from './logger.js';
import { TTSManager, VOICE_TYPES } from './tts.js';
import { MessageRuntime } from './runtime.js';
import { dispatchReply as dispatchReplyWithDeps } from './reply-dispatcher.js';
import { detectPromptInjectionRisk, buildObservationEnvelope } from './security.js';
import { buildStandardEvent, updateStandardEventRouting } from './standard-event.js';
import { detectChainLeak, buildChainLeakRetryMessage } from './chain-leak-detection.js';
import { getParticipantProfileConfig, normalizeParticipantProfileConfig } from './participant-profile-config.js';
import { GroupRepeatDetector, normalizeGroupRepeatConfig, shouldObserveGroupRepeatMessage } from './group-repeat.js';
import { DEFAULT_QQ_EMOJI_REACTION_ID, executeAdminPokeCommand, isCommandInvocation, normalizeEmojiReactionId, resolveEmojiReactionId } from './qq-interactions.js';
import { collectParticipantGroupIds, mergeParticipantIdentity, resolveParticipantIdentityFromOneBot } from './participant-identity.js';
import {
    getParticipantProfileTimerKey,
    trackParticipantProfileTarget,
    shouldUseIdleParticipantProfileTrigger,
    shouldUseIntervalParticipantProfileTrigger,
    buildParticipantProfilePrompt,
    buildParticipantProfileMergePrompt,
    buildParticipantProfileAIOverrides,
    buildParticipantProfileTaskMeta
} from './participant-profile-runtime.js';

export { syncPresetFiles } from './preset-sync.js';

if (process.stdout?.setDefaultEncoding) {
    process.stdout.setDefaultEncoding('utf8');
}

if (process.stderr?.setDefaultEncoding) {
    process.stderr.setDefaultEncoding('utf8');
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = join(__dirname, '..');

function loadConfig() {
    // 优先读 config/ 目录（平台只能挂载目录），兼容 config.json 文件挂载
    const dirConfigPath = join(ROOT_DIR, 'config', 'config.json');
    const fileConfigPath = join(ROOT_DIR, 'config.json');
    const exampleConfigPath = join(ROOT_DIR, 'config.example.json');

    const primary = fs.existsSync(dirConfigPath) ? dirConfigPath
        : fs.existsSync(fileConfigPath) ? fileConfigPath
            : null;

    if (primary) {
        configSourcePath = primary;
        const config = JSON.parse(fs.readFileSync(primary, 'utf8'));
        normalizeConfig(config);
        return config;
    }

    if (fs.existsSync(exampleConfigPath)) {
        const exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf8'));
        normalizeConfig(exampleConfig);
        const target = join(ROOT_DIR, 'config');
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(join(target, 'config.json'), JSON.stringify(exampleConfig, null, 2), 'utf8');
        return exampleConfig;
    }

    throw new Error('配置文件不存在: config.json');
}

let configSourcePath = null; // 记录 config 从哪读的，写回同一位置

function saveConfig(config) {
    const target = configSourcePath || join(ROOT_DIR, 'config.json');
    const dir = dirname(target);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    normalizeConfig(config);
    fs.writeFileSync(target, JSON.stringify(config, null, 2), 'utf8');
}

function ensureBindingConfig(config) {
    if (!config.bindings) {
        config.bindings = {
            global: {
                memoryDbPath: null,
                worldbook: null,
                preset: null,
                regexRules: null
            },
            characters: {}
        };
    }

    if (!config.bindings.global) {
        config.bindings.global = {
            memoryDbPath: null,
            worldbook: null,
            preset: null,
            regexRules: null
        };
    }

    if (!config.bindings.characters) {
        config.bindings.characters = {};
    }
}

function stripLegacyPresetMetadata(config) {
    const presetFiles = config.imports?.presetFiles;
    if (!Array.isArray(presetFiles)) return;
    let cleaned = 0;
    for (const record of presetFiles) {
        const preset = record?.importedPreset;
        if (!preset) continue;
        // 如果 importedPreset 有 prompts 以外的顶层字段，说明是旧版 ST 水印
        const keys = Object.keys(preset);
        const hasWatermark = keys.some(k => !['prompts','prompt_order'].includes(k));
        if (!hasWatermark) continue;
        record.importedPreset = {
            prompts: (preset.prompts || []).map(p => ({
                name: String(p.name || '').trim(),
                content: String(p.content || ''),
                enabled: p.enabled !== false,
                role: p.role || 'system',
                injection_position: p.injection_position ?? 0,
                injection_depth: p.injection_depth ?? 0,
                system_prompt: p.system_prompt === true,
                marker: p.marker === true,
                forbid_overrides: p.forbid_overrides === true
            }))
        };
        cleaned++;
    }
    if (cleaned > 0) saveConfig(config);
}

function getCharacterBinding(config, characterName) {
    ensureBindingConfig(config);
    return config.bindings.characters[characterName] || {
        memoryDbPath: null,
        worldbook: null,
        preset: null,
        regexRules: null,
        importedFromCard: {
            worldbook: null,
            preset: null,
            regexRules: []
        }
    };
}

function getEffectiveBinding(config, characterName) {
    return PromptBuilder.getEffectiveBinding(config, characterName);
}

function normalizeSessionMode(mode) {
    switch (mode) {
        case 'scoped':
        case 'group_shared':
            return 'group_shared';
        case 'user':
        case 'group_user':
            return 'group_user';
        case 'global':
        case 'global_shared':
            return 'global_shared';
        case 'user_persistent':
        default:
            return 'user_persistent';
    }
}

function normalizeAccessControlMode(mode) {
    if (mode === 'blocklist' || mode === 'disabled') {
        return mode;
    }

    return 'allowlist';
}

function normalizeCommandText(value, fallback) {
    if (typeof value !== 'string') {
        return fallback;
    }

    const trimmed = value.trim();
    return trimmed || fallback;
}

function normalizeStringList(value) {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(new Set(value
        .map((item) => (item == null ? '' : String(item).trim()))
        .filter(Boolean)));
}

function toOptionalString(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function buildChatAIOverrides(config = {}) {
    const chatConfig = config.chat || {};
    const providerId = toOptionalString(chatConfig.modelProviderId) || toOptionalString(config.ai?.activeProviderId);
    const providers = Array.isArray(config.ai?.providers) ? config.ai.providers : [];
    const selectedProvider = providerId
        ? providers.find((provider) => provider?.id === providerId)
        : null;
    const model = toOptionalString(chatConfig.model) || toOptionalString(selectedProvider?.model) || toOptionalString(config.ai?.model);
    const overrides = {};

    if (model) {
        overrides.model = model;
    }
    if (selectedProvider) {
        const baseUrl = toOptionalString(selectedProvider.baseUrl);
        const apiKey = toOptionalString(selectedProvider.apiKey);
        overrides.baseUrl = baseUrl;
        overrides.apiKey = apiKey;
    } else if (providerId && providers.length > 0) {
        overrides.baseUrl = '';
        overrides.apiKey = '';
    }

    return overrides;
}

function normalizeAIModelId(model = '') {
    const text = toOptionalString(model);
    if (!text) return '';
    if (text.includes('::')) return text.split('::').pop();
    if (text.includes('||')) return text.split('||').pop();
    return text;
}

function buildAIOverridesFromProviderSelection(config = {}, { providerId = '', model = '' } = {}) {
    const normalizedProviderId = toOptionalString(providerId)
        || toOptionalString(config.chat?.modelProviderId)
        || toOptionalString(config.ai?.activeProviderId);
    const providers = Array.isArray(config.ai?.providers) ? config.ai.providers : [];
    const selectedProvider = normalizedProviderId
        ? providers.find((provider) => provider?.id === normalizedProviderId)
        : null;
    const normalizedModel = normalizeAIModelId(model) || toOptionalString(selectedProvider?.model);
    const overrides = {};

    if (normalizedModel) {
        overrides.model = normalizedModel;
    }
    if (selectedProvider) {
        overrides.baseUrl = toOptionalString(selectedProvider.baseUrl);
        overrides.apiKey = toOptionalString(selectedProvider.apiKey);
    } else if (normalizedProviderId && providers.length > 0) {
        overrides.baseUrl = '';
        overrides.apiKey = '';
    }

    return overrides;
}

function getChatAISelectionSnapshot(config = {}) {
    const overrides = buildChatAIOverrides(config);
    return {
        providerId: toOptionalString(config.chat?.modelProviderId) || toOptionalString(config.ai?.activeProviderId) || null,
        model: overrides.model || config.ai?.model || null,
        hasProviderOverride: Boolean(overrides.baseUrl || overrides.apiKey)
    };
}

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.floor(normalized);
}

const AI_PROVIDER_DEFAULTS = {
    'openai-compatible': {
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4o-mini'
    },
    openai: {
        baseUrl: 'https://api.openai.com',
        model: 'gpt-4o-mini'
    },
    deepseek: {
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat'
    },
    anthropic: {
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-5'
    },
    gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.5-flash'
    },
    ollama: {
        baseUrl: 'http://127.0.0.1:11434',
        model: 'qwen3:8b'
    },
    custom: {
        baseUrl: '',
        model: ''
    }
};

function normalizeAIProvider(provider) {
    const normalized = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    if (normalized === 'openai') {
        return 'openai';
    }
    if (normalized === 'deepseek' || normalized === 'anthropic' || normalized === 'gemini' || normalized === 'ollama' || normalized === 'custom') {
        return normalized;
    }
    // 向后兼容：claude 映射到 anthropic
    if (normalized === 'claude') {
        return 'anthropic';
    }
    return 'openai-compatible';
}

function normalizeAIConfig(config) {
    config.ai = config.ai || {};
    config.ai.provider = normalizeAIProvider(config.ai.provider);

    const providerDefaults = AI_PROVIDER_DEFAULTS[config.ai.provider] || AI_PROVIDER_DEFAULTS['openai-compatible'];
    const currentBaseUrl = typeof config.ai.baseUrl === 'string' ? config.ai.baseUrl.trim() : '';
    const currentModel = typeof config.ai.model === 'string' ? config.ai.model.trim() : '';

    config.ai.baseUrl = currentBaseUrl || providerDefaults.baseUrl;
    config.ai.model = currentModel || providerDefaults.model;
    config.ai.timeout = clampInteger(config.ai.timeout, 1000, 3600000, 60000);
    config.ai.activeProviderId = toOptionalString(config.ai.activeProviderId);
    config.ai.providers = Array.isArray(config.ai.providers)
        ? config.ai.providers.map((provider, index) => ({
            id: toOptionalString(provider?.id) || `provider-${index + 1}`,
            name: toOptionalString(provider?.name) || `模型供应商 ${index + 1}`,
            provider: normalizeAIProvider(provider?.provider),
            baseUrl: toOptionalString(provider?.baseUrl),
            apiKey: toOptionalString(provider?.apiKey),
            model: toOptionalString(provider?.model),
            models: Array.isArray(provider?.models) ? provider.models : []
        }))
        : [];

    config.chat = config.chat || {};
    config.chat.modelProviderId = toOptionalString(config.chat.modelProviderId);
    config.chat.model = toOptionalString(config.chat.model);

    if (config.ai.variableParsing && typeof config.ai.variableParsing === 'object' && !Array.isArray(config.ai.variableParsing)) {
        config.ai.variableParsing.providerId = toOptionalString(config.ai.variableParsing.providerId);
        config.ai.variableParsing.model = normalizeAIModelId(config.ai.variableParsing.model);
        delete config.ai.variableParsing.baseUrl;
        delete config.ai.variableParsing.apiKey;
    }

    config.memory = config.memory || {};
    config.memory.summary = config.memory.summary || {};
    config.memory.summary.modelProviderId = toOptionalString(config.memory.summary.modelProviderId);
    config.memory.summary.model = normalizeAIModelId(config.memory.summary.model);
    delete config.memory.summary.baseUrl;
    delete config.memory.summary.apiKey;
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = toPositiveInteger(value, fallback);
    return Math.min(maximum, Math.max(minimum, normalized));
}

function clampIntegerAllowZero(value, minimum, maximum, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, Math.floor(normalized)));
}

function normalizeServerConfig(config) {
    config.server = config.server || {};
    config.server.logRetentionDays = clampIntegerAllowZero(config.server.logRetentionDays, 0, 3650, 14);
    config.server.logCleanupIntervalMs = clampInteger(config.server.logCleanupIntervalMs, 60000, 86400000, 3600000);
}

function ensureCommandAndToolConfig(config) {
    config.chat = config.chat || {};
    config.chat.commands = config.chat.commands || {};
    config.ai = config.ai || {};
    config.ai.tools = config.ai.tools || {};

    const participantProfileConfig = getParticipantProfileConfig(config);
    const adminMention = config.chat.commands.adminMention || {};
    const adminPoke = config.chat.commands.adminPoke || {};
    const participantProfileManual = config.chat.commands.participantProfileManual || {};
    const webSearch = config.ai.tools.webSearch || {};
    const sendMention = config.ai.tools.sendMention || {};

    config.chat.commands.adminMention = {
        enabled: typeof adminMention.enabled === 'boolean' ? adminMention.enabled : true,
        command: normalizeCommandText(adminMention.command, '/at')
    };

    config.chat.commands.adminPoke = {
        enabled: typeof adminPoke.enabled === 'boolean' ? adminPoke.enabled : true,
        command: normalizeCommandText(adminPoke.command, '/戳一戳'),
        repeatCount: clampInteger(adminPoke.repeatCount, 1, 10, 5)
    };

    config.chat.commands.participantProfileManual = {
        enabled: typeof participantProfileManual.enabled === 'boolean' ? participantProfileManual.enabled : true,
        command: normalizeCommandText(participantProfileManual.command, participantProfileConfig.manualCommand)
    };

    config.memory.participantProfile.manualCommand = config.chat.commands.participantProfileManual.command;

    const webSearchProvider = String(webSearch.provider || '').toLowerCase();
    const textToolFallback = config.ai.tools.textToolFallback || {};

    config.ai.tools.webSearch = {
        enabled: typeof webSearch.enabled === 'boolean' ? webSearch.enabled : false,
        provider: ['duckduckgo', 'google', 'bing', 'tavily', 'brave', 'serpapi'].includes(webSearchProvider) ? webSearchProvider : 'duckduckgo',
        apiKey: typeof webSearch.apiKey === 'string' ? webSearch.apiKey : '',
        googleEngineId: typeof webSearch.googleEngineId === 'string' ? webSearch.googleEngineId : (typeof webSearch.engineId === 'string' ? webSearch.engineId : ''),
        bingEndpoint: typeof webSearch.bingEndpoint === 'string' ? webSearch.bingEndpoint : '',
        maxResults: clampInteger(webSearch.maxResults, 1, 8, 5),
        timeoutMs: clampInteger(webSearch.timeoutMs, 1000, 15000, 10000),
        maxSnippetLength: clampInteger(webSearch.maxSnippetLength, 100, 4000, 800),
        allowedDomains: normalizeStringList(webSearch.allowedDomains),
        blockedDomains: normalizeStringList(webSearch.blockedDomains)
    };

    config.ai.tools.textToolFallback = {
        enabled: typeof textToolFallback.enabled === 'boolean' ? textToolFallback.enabled : false,
        maxRounds: clampInteger(textToolFallback.maxRounds, 1, 8, 3)
    };

    config.ai.tools.sendMention = {
        enabled: typeof sendMention.enabled === 'boolean' ? sendMention.enabled : false
    };
}

function normalizeConfig(config) {
    normalizeServerConfig(config);
    config.chat = config.chat || {};
    config.bindings = config.bindings || {};
    config.bindings.global = config.bindings.global || {};
    config.regex = config.regex || {};

    config.chat.sessionMode = normalizeSessionMode(config.chat.sessionMode || 'user_persistent');
    config.chat.accessControlMode = normalizeAccessControlMode(config.chat.accessControlMode || 'allowlist');

    if (config.chat.accessControlMode === 'blocklist') {
        config.chat.allowedGroups = [];
        config.chat.allowedUsers = [];
    } else if (config.chat.accessControlMode === 'allowlist') {
        config.chat.blockedGroups = [];
        config.chat.blockedUsers = [];
    } else {
        config.chat.allowedGroups = [];
        config.chat.allowedUsers = [];
        config.chat.blockedGroups = [];
        config.chat.blockedUsers = [];
    }

    if (!('memoryDbPath' in config.bindings.global)) {
        config.bindings.global.memoryDbPath = null;
    }

    if (!Array.isArray(config.bindings.global.regexRules)) {
        config.bindings.global.regexRules = Array.isArray(config.regex.rules) ? config.regex.rules : [];
    }

    if (!Array.isArray(config.preset?.regexRules)) {
        config.preset = {
            ...(config.preset || {}),
            regexRules: []
        };
    }

    config.regex.rules = config.bindings.global.regexRules;

    if (!Array.isArray(config.chat.adminUsers)) {
        config.chat.adminUsers = [];
    }

    if (!('mentionSenderOnReply' in config.chat)) {
        config.chat.mentionSenderOnReply = true;
    }
    config.chat.emojiReaction = config.chat.emojiReaction === true;
    config.chat.emojiReactionId = normalizeEmojiReactionId(config.chat.emojiReactionId, DEFAULT_QQ_EMOJI_REACTION_ID);

    config.chat.groupRepeat = normalizeGroupRepeatConfig(config.chat.groupRepeat);

    const emptyReplyRetry = config.chat.emptyReplyRetry || {};
    config.chat.emptyReplyRetry = {
        enabled: emptyReplyRetry.enabled !== false,
        maxRetries: clampInteger(emptyReplyRetry.maxRetries, 0, 20, 2),
        delayMs: clampInteger(emptyReplyRetry.delayMs, 0, 10000, 800)
    };

    const chainLeakRetry = config.chat.chainLeakRetry || {};
    config.chat.chainLeakRetry = {
        enabled: chainLeakRetry.enabled !== false,
        maxRetries: clampInteger(chainLeakRetry.maxRetries, 0, 5, 1),
        delayMs: clampInteger(chainLeakRetry.delayMs, 0, 10000, 500)
    };

    const thinkingNotify = config.chat.thinkingNotify || {};
    config.chat.thinkingNotify = {
        enabled: thinkingNotify.enabled !== false,
        delaySec: clampInteger(thinkingNotify.delaySec, 1, 3600, 60),
        message: typeof thinkingNotify.message === 'string' ? thinkingNotify.message : ''
    };

    config.runtime = config.runtime || {};
    if (typeof config.runtime.llmEnabled !== 'boolean') {
        config.runtime.llmEnabled = true;
    }

    normalizeAIConfig(config);
    normalizeParticipantProfileConfig(config);
    ensureCommandAndToolConfig(config);
}

function isAdminUser(config, userId) {
    const admins = Array.isArray(config.chat?.adminUsers) ? config.chat.adminUsers.map(String) : [];
    return admins.includes(String(userId));
}

function buildMemoryScope(config, event) {
    const mode = normalizeSessionMode(config.chat.sessionMode);
    const userId = event.user_id;
    const groupId = event.group_id;

    if (mode === 'global_shared') {
        return {
            sessionKey: 'global_shared_memory',
            scopeType: 'global_shared',
            scopeLabel: '全局共享记忆'
        };
    }

    if (mode === 'group_shared') {
        if (event.message_type === 'group') {
            return {
                sessionKey: `group:${groupId}`,
                scopeType: 'group_shared',
                scopeLabel: `群共享记忆(${groupId})`
            };
        }

        return {
            sessionKey: `private:${userId}`,
            scopeType: 'private_user',
            scopeLabel: `私聊用户记忆(${userId})`
        };
    }

    if (mode === 'group_user') {
        if (event.message_type === 'group') {
            return {
                sessionKey: `group_user:${groupId}:${userId}`,
                scopeType: 'group_user',
                scopeLabel: `群内用户隔离记忆(${groupId}/${userId})`
            };
        }

        return {
            sessionKey: `private:${userId}`,
            scopeType: 'private_user',
            scopeLabel: `私聊用户记忆(${userId})`
        };
    }

    return {
        sessionKey: `user:${userId}`,
        scopeType: 'user_persistent',
        scopeLabel: `跨会话用户长期记忆(${userId})`
    };
}

function buildRecallNamespace(config, memoryScope, currentCharacterName) {
    return {
        scopeType: memoryScope.scopeType || 'user_persistent',
        scopeKey: memoryScope.sessionKey,
        characterName: currentCharacterName || null,
        presetName: config.preset?.name || null
    };
}

function describeSessionId(sessionId) {
    if (!sessionId) {
        return '未知会话';
    }

    if (sessionId.startsWith('user:')) {
        return `用户长期记忆 / QQ ${sessionId.slice(5)}`;
    }
    if (sessionId.startsWith('group_user:')) {
        const [, groupId, userId] = sessionId.split(':');
        return `群内用户隔离 / 群 ${groupId} / QQ ${userId}`;
    }
    if (sessionId.startsWith('group:')) {
        return `群共享记忆 / 群 ${sessionId.slice(6)}`;
    }
    if (sessionId === 'global_shared_memory') {
        return '全局共享记忆';
    }
    if (sessionId.startsWith('private:')) {
        return `私聊记忆 / QQ ${sessionId.slice(8)}`;
    }

    return sessionId;
}

function applyMemoryBinding() {
    const currentCharacterName = config.chat.defaultCharacter;
    const effectiveBinding = getEffectiveBinding(config, currentCharacterName);
    sessionManager.setConfig(config, { storagePath: effectiveBinding.memoryDbPath || config.memory?.storage?.path });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// LLM 开关状态
let llmEnabled = true;

function setLlmEnabled(nextEnabled) {
    llmEnabled = nextEnabled !== false;
    config.runtime = config.runtime || {};
    config.runtime.llmEnabled = llmEnabled;
    saveConfig(config);
    return llmEnabled;
}

function sanitizeContent(text) {
    return (text || '').replace(/\r/g, '').trim();
}

/**
 * 非管理员消息防注入过滤
 *
 * 背景：世界书中使用特定前缀（如 &）作为管理员指令触发符。
 * 恶意用户可能通过在消息内容中伪造指令前缀、消息头格式或管理员QQ号来
 * 欺骗 AI 执行非授权操作。此过滤在消息到达 AI 之前清洗这些注入向量。
 *
 * 过滤规则（仅对非管理员生效）：
 * 1. 指令前缀：将配置的管理员指令前缀替换为全角字符，防止伪造指令
 * 2. 消息头格式：将 [群聊| [私聊| QQ: 等系统格式转义，防止伪造身份结构
 * 3. 管理员QQ号：将内容中出现的管理员QQ号替换为 [已屏蔽]，防止身份伪造
 *
 * 配置项（config.chat.injectionFilter）：
 * - enabled: 是否启用过滤（默认 true）
 * - adminCommandPrefix: 管理员指令前缀（默认 "&"，对应世界书中的 & 指令系统）
 * - replacementChar: 替换为的全角字符（默认 "＆"）
 */
function sanitizeForInjection(text, config, userId) {
    if (!text) return text;
    if (isAdminUser(config, userId)) return text;

    const filterConfig = config.chat?.injectionFilter || {};
    if (filterConfig.enabled === false) return text;

    let result = text;

    // 1. 管理员指令前缀过滤：直接删除整行
    const prefix = filterConfig.adminCommandPrefix ?? '&';
    if (prefix) {
        const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        result = result.replace(new RegExp(`^${escapedPrefix}.*$`, 'gm'), '[无效内容]');
    }

    // 2. 消息头格式伪造过滤
    result = result.replace(/\[群聊\|/g, '【群聊|');
    result = result.replace(/\[私聊\|/g, '【私聊|');
    result = result.replace(/QQ:/gi, '扣扣:');

    // 3. 管理员QQ号屏蔽
    const admins = Array.isArray(config.chat?.adminUsers) ? config.chat.adminUsers.map(String) : [];
    for (const adminQQ of admins) {
        if (adminQQ && result.includes(adminQQ)) {
            result = result.replaceAll(adminQQ, '[已屏蔽]');
        }
    }

    return result;
}

function buildThinkingPreview(text, maxLength = 24) {
    const normalized = sanitizeContent(String(text || '').replace(/\s+/g, ' '));
    if (!normalized) {
        return '你刚才那条消息';
    }

    return normalized.length > maxLength
        ? `${normalized.slice(0, maxLength)}...`
        : normalized;
}

function isEmptyLikeReply(text) {
    const normalized = sanitizeContent(text);
    if (!normalized) {
        return true;
    }

    return /^[.。…·\s]+$/.test(normalized);
}

async function generateReplyWithRetry({ aiClient, messages, toolContext, chatAIOverrides, timeoutMs, logger, sessionId, retryConfig, chainLeakRetryConfig, userInput }) {
    const emptyMaxRetries = retryConfig?.enabled === false ? 0 : Number(retryConfig?.maxRetries) || 0;
    const emptyDelayMs = Number(retryConfig?.delayMs) || 0;
    const chainLeakEnabled = chainLeakRetryConfig?.enabled !== false;
    const chainLeakMaxRetries = chainLeakEnabled ? Number(chainLeakRetryConfig?.maxRetries) || 0 : 0;
    const chainLeakDelayMs = Number(chainLeakRetryConfig?.delayMs) || 0;
    let lastReplyResult = null;
    let lastReply = '';
    let attempts = 0;
    let emptyRetriesUsed = 0;
    let chainLeakRetriesUsed = 0;

    while (true) {
        attempts += 1;
        const attemptMessages = chainLeakRetriesUsed > 0
            ? [
                ...messages,
                {
                    role: 'system',
                    content: buildChainLeakRetryMessage('previous-attempt')
                }
            ]
            : messages;
        const replyResult = await callWithTimeout(() => aiClient.chatWithTools(attemptMessages, toolContext, chatAIOverrides), timeoutMs);
        const reply = aiClient.getVisibleResponseContent(replyResult);
        lastReplyResult = replyResult;
        lastReply = reply;

        if (!isEmptyLikeReply(reply)) {
            const chainLeak = detectChainLeak({
                rawReply: reply,
                visibleReply: reply,
                userInput
            });

            if (chainLeakEnabled && chainLeak.leaked) {
                logger.warn(`[执行] AI 回复疑似泄露思维链，准备重试 ${chainLeakRetriesUsed + 1}/${chainLeakMaxRetries}`, {
                    sessionId,
                    reason: chainLeak.reason,
                    replyPreview: String(reply || '').slice(0, 160)
                });

                if (chainLeakRetriesUsed < chainLeakMaxRetries) {
                    chainLeakRetriesUsed += 1;
                    if (chainLeakDelayMs > 0) {
                        await sleep(chainLeakDelayMs);
                    }
                    continue;
                }

                const error = new Error('CHAIN_LEAK_AFTER_RETRY');
                error.replyResult = lastReplyResult;
                error.lastReply = lastReply;
                error.retryAttempts = attempts;
                error.chainLeakReason = chainLeak.reason;
                throw error;
            }

            return { replyResult, reply, attempts, emptyRetriesUsed, chainLeakRetriesUsed };
        }

        logger.warn(`[执行] AI 返回空回复，准备重试 ${emptyRetriesUsed + 1}/${emptyMaxRetries}`, {
            sessionId,
            replyPreview: String(reply || '').slice(0, 80)
        });

        if (emptyRetriesUsed < emptyMaxRetries) {
            emptyRetriesUsed += 1;
            if (emptyDelayMs > 0) {
                await sleep(emptyDelayMs);
            }
            continue;
        }

        const error = new Error('EMPTY_REPLY_AFTER_RETRY');
        error.replyResult = lastReplyResult;
        error.lastReply = lastReply;
        error.retryAttempts = attempts;
        throw error;
    }
}

function buildDebugReplyWithReasoning(reasoningContent, visibleReply) {
    const reasoning = typeof reasoningContent === 'string' ? reasoningContent.trim() : '';
    const reply = typeof visibleReply === 'string' ? visibleReply.trim() : '';
    if (!reasoning) {
        return reply;
    }
    if (!reply) {
        return `【思维链】\n${reasoning}`;
    }
    return `【思维链】\n${reasoning}\n\n【正文】\n${reply}`;
}

function buildAIServiceFailureMessage(error, config = {}) {
    const message = String(error?.message || '');
    if (message === 'AI_TIMEOUT') {
        const timeoutSeconds = Math.floor((config.ai?.timeout || 60000) / 1000);
        return `AI 响应超时（等待超过${timeoutSeconds}秒），请稍后再试或增大超时设置`;
    }
    if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('EACCES')) {
        return '连接 AI 服务失败，请检查网络、代理或 API Base URL';
    }
    if (message.includes('401') || message.includes('403')) {
        const selection = getChatAISelectionSnapshot(config);
        const providerText = selection.providerId ? `供应商 ${selection.providerId}` : '当前供应商';
        const modelText = selection.model ? `，模型 ${selection.model}` : '';
        return `AI 服务拒绝请求（${providerText}${modelText}），请检查 Base URL、模型名和 Key 是否属于同一供应商`;
    }
    if (message === 'EMPTY_REPLY_AFTER_RETRY') {
        const retryAttempts = Number(error.retryAttempts) || ((config.chat?.emptyReplyRetry?.maxRetries || 0) + 1);
        return `空回复，已自动重试 ${retryAttempts} 次仍失败，请稍后再试`;
    }
    if (message === 'CHAIN_LEAK_AFTER_RETRY') {
        const retryAttempts = Number(error.retryAttempts) || ((config.chat?.chainLeakRetry?.maxRetries || 0) + 1);
        return `AI 回复疑似泄露思维链，已自动重试 ${retryAttempts} 次仍失败，本轮已拦截`;
    }
    if (message.includes('500') || message.includes('502')) {
        return 'AI 服务暂时不可用，请稍后重试';
    }
    return '处理消息时出现错误，请稍后重试';
}


function buildStructuredMessage(event, plainText, meta = {}) {
    const { message_type, user_id, group_id, sender } = event;
    const chatType = message_type === 'private' ? '私聊' : '群聊';
    const userName = sender?.card || sender?.nickname || '未知用户';
    const actualGroupId = message_type === 'group' ? group_id : 'N/A';
    const groupName = message_type === 'group'
        ? (event.group_name || sender?.group_name || `群${group_id}`)
        : 'N/A';
    const timestamp = new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false
    });

    const metaParts = [
        chatType,
        `QQ:${user_id}`,
        `昵称:${userName}`,
        `群号:${actualGroupId}`,
        `群名:${groupName}`,
        `时间:${timestamp}`
    ];

    if (meta.eventType) metaParts.push(`eventType:${meta.eventType}`);
    if (meta.isAtBot !== undefined) metaParts.push(`isAtBot:${meta.isAtBot ? 'true' : 'false'}`);
    if (meta.replyToBot !== undefined && meta.replyToBot !== null) metaParts.push(`replyToBot:${meta.replyToBot ? 'true' : 'false'}`);
    if (meta.replyQuotedText) metaParts.push(`replyQuotedText:${String(meta.replyQuotedText).slice(0, 180)}`);
    if (Array.isArray(meta.messageSegments) && meta.messageSegments.length > 0) {
        metaParts.push(`messageSegments:${JSON.stringify(meta.messageSegments).slice(0, 500)}`);
    }

    return `[${metaParts.join('|')}] ${plainText}`;
}

function summarizeOneBotSegment(segment, botSelfId = '') {
    if (!segment || typeof segment !== 'object') {
        return { type: 'unknown', text: '[消息段:unknown]' };
    }

    const type = String(segment.type || 'unknown');
    const data = segment.data || {};
    const getAny = (...keys) => keys.map((key) => data[key]).find((value) => value !== undefined && value !== null && String(value).trim() !== '');

    if (type === 'text') {
        const text = String(data.text || '');
        return { type, text, promptText: text };
    }

    if (type === 'at') {
        const qq = String(data.qq || '').trim();
        if (!qq || qq === 'all') {
            return { type, qq, promptText: '[@全体成员] ' };
        }
        const name = getAny('name', 'card', 'nickname', 'display_name');
        const isBot = botSelfId ? qq === String(botSelfId) : false;
        const mentionText = isBot
            ? '[@bot] '
            : `[@${name ? `${name}|` : ''}QQ:${qq}] `;
        return { type, qq, name: name ? String(name) : '', isBot, promptText: mentionText };
    }

    if (type === 'reply') {
        return { type, id: data.id ? String(data.id) : '', promptText: '' };
    }

    if (type === 'face') {
        const id = getAny('id', 'face_id');
        const name = getAny('name', 'text', 'summary');
        const promptText = `[QQ表情${name ? `:${name}` : ''}${id ? `|id=${id}` : ''}]`;
        return { type, id: id ? String(id) : '', name: name ? String(name) : '', promptText };
    }

    if (type === 'mface' || type === 'marketface') {
        const id = getAny('id', 'emoji_id', 'face_id', 'key');
        const summary = getAny('summary', 'name', 'text', 'display_name');
        const label = type === 'mface' ? 'QQ动态表情' : 'QQ大表情';
        const promptText = `[${label}${summary ? `:${summary}` : ''}${id ? `|id=${id}` : ''}]`;
        return { type, id: id ? String(id) : '', summary: summary ? String(summary) : '', promptText };
    }

    if (type === 'image') {
        const summary = getAny('summary', 'sub_type', 'file');
        return { type, summary: summary ? String(summary) : '', promptText: `[图片${summary ? `:${summary}` : ''}]` };
    }

    if (type === 'record') {
        return { type, promptText: '[语音]' };
    }

    if (type === 'video') {
        return { type, promptText: '[视频]' };
    }

    if (type === 'file') {
        const name = getAny('name', 'file');
        return { type, name: name ? String(name) : '', promptText: `[文件${name ? `:${name}` : ''}]` };
    }

    if (type === 'json' || type === 'xml') {
        return { type, promptText: `[${type.toUpperCase()}消息]` };
    }

    return { type, promptText: `[消息段:${type}]` };
}

function sanitizeSegmentSummaryForPrompt(summary, config, userId) {
    return Object.fromEntries(
        Object.entries(summary || {})
            .filter(([key]) => key !== 'promptText')
            .map(([key, value]) => {
                if (typeof value !== 'string') {
                    return [key, value];
                }
                return [key, sanitizeForInjection(sanitizeContent(value), config, userId)];
            })
    );
}

function extractDisplayTextFromSegments(segments = []) {
    if (!Array.isArray(segments)) {
        return '';
    }

    let text = '';
    for (const segment of segments) {
        if (!segment || typeof segment !== 'object') {
            continue;
        }

        const summary = summarizeOneBotSegment(segment);
        if (summary.type !== 'reply') text += summary.promptText || '';
    }

    return sanitizeContent(text);
}

async function buildReplyInfo(event, bot, replyToMessageId) {
    const empty = {
        snippet: '',
        toBot: null,
        senderId: '',
        senderName: '',
        quotedText: '',
        fetchStatus: replyToMessageId ? 'pending' : 'none',
        fetchReason: replyToMessageId ? '' : 'no_reply_segment'
    };
    if (!replyToMessageId || !bot?.getMessage) {
        return {
            ...empty,
            fetchStatus: replyToMessageId ? 'unavailable' : 'none',
            fetchReason: replyToMessageId ? 'get_message_unavailable' : 'no_reply_segment'
        };
    }

    try {
        const replyMessage = await bot.getMessage(replyToMessageId);
        const senderId = sanitizeContent(String(
            replyMessage?.sender?.user_id
            || replyMessage?.user_id
            || replyMessage?.sender_id
            || ''
        ));
        const senderName = sanitizeContent(
            replyMessage?.sender?.card
            || replyMessage?.sender?.nickname
            || replyMessage?.nickname
            || ''
        );
        const replyText = sanitizeContent(
            extractDisplayTextFromSegments(replyMessage?.message)
            || replyMessage?.raw_message
            || replyMessage?.message
            || ''
        );

        if (!senderName && !replyText) {
            return {
                ...empty,
                senderId,
                senderName,
                quotedText: replyText,
                toBot: senderId ? senderId === String(bot.selfId || '') : null,
                fetchStatus: 'resolved_empty',
                fetchReason: 'reply_message_empty'
            };
        }

        return {
            snippet: sanitizeContent(`[回复上文${senderName ? `|发送者:${senderName}` : ''}${senderId ? `|QQ:${senderId}` : ''}${replyText ? `|内容:${replyText}` : ''}]`),
            toBot: senderId ? senderId === String(bot.selfId || '') : null,
            senderId,
            senderName,
            quotedText: replyText,
            fetchStatus: 'resolved',
            fetchReason: ''
        };
    } catch (error) {
        bot.logger?.debug?.(`[回复] 获取被回复消息失败: ${replyToMessageId} ${error.message}`);
        return {
            ...empty,
            fetchStatus: 'failed',
            fetchReason: error?.message || 'get_message_failed'
        };
    }
}

async function extractMessageInfo(config, event, bot) {
    const segments = Array.isArray(event.message) ? event.message : [];
    let plainText = '';
    let isAtMe = false;
    let replyToMessageId = null;
    const messageSegments = [];

    for (const segment of segments) {
        const segmentSummary = summarizeOneBotSegment(segment, bot.selfId);
        messageSegments.push(sanitizeSegmentSummaryForPrompt(segmentSummary, config, event.user_id));
        if (segmentSummary.promptText && segmentSummary.type !== 'reply') {
            plainText += segmentSummary.promptText;
        }
        if (segment.type === 'at' && String(segment.data?.qq) === String(bot.selfId)) {
            isAtMe = true;
        } else if (segment.type === 'reply') {
            replyToMessageId = segment.data?.id || null;
        }
    }

    plainText = sanitizeContent(plainText || event.raw_message || '');
    const onlyAtBot = isAtMe
        && messageSegments.some((segment) => segment?.type === 'at' && segment?.isBot === true)
        && !messageSegments.some((segment) => segment?.type !== 'at' && segment?.type !== 'reply');
    if (!plainText && onlyAtBot) {
        plainText = '[@bot]（只@了bot，没有附加文字；请结合附近群聊上下文判断对方是在叫你接话、催你回应还是让你看上文）';
    }
    plainText = sanitizeForInjection(plainText, config, event.user_id);
    const replyInfo = await buildReplyInfo(event, bot, replyToMessageId);
    const replySnippet = sanitizeForInjection(replyInfo.snippet, config, event.user_id);
    const promptText = sanitizeContent(replySnippet ? `${replySnippet}
${plainText}` : plainText);
    const standardEvent = buildStandardEvent({
        event,
        contentText: promptText,
        rawText: event.raw_message || plainText,
        eventType: event.post_type || 'message',
        isAtBot: isAtMe,
        replyToMessageId,
        replyInfo,
        messageSegments,
        botSelfId: bot.selfId
    });
    const structuredText = promptText
        ? (config.chat?.attachMetadata === false ? promptText : buildStructuredMessage(event, promptText, {
            eventType: event.post_type || 'message',
            isAtBot: isAtMe,
            replyToBot: replyInfo.toBot,
            replyQuotedText: replyInfo.quotedText,
            messageSegments
        }))
        : '';
    return {
        plainText,
        isAtMe,
        replyToMessageId,
        replyToBot: replyInfo.toBot === true,
        replyInfo,
        messageSegments,
        standardEvent,
        structuredText
    };
}


function getTriggerReason(config, event, plainText, isAtMe, messageInfo = {}) {
    const decision = buildRoutingDecision(config, event, plainText, isAtMe, messageInfo);
    if (decision.triggerReason) return decision.triggerReason;
    return event.message_type === 'private' ? 'private' : 'default';
}

function buildParticipants(items) {
    const seen = new Set();
    const participants = [];
    for (const item of items) {
        const sender = item.event.sender;
        const userId = item.event.user_id;
        const userName = sender?.card || sender?.nickname || `QQ:${userId}`;
        const key = `${userId}:${userName}`;
        if (!seen.has(key)) {
            seen.add(key);
            participants.push(`${userName}(${userId})`);
        }
    }
    return participants;
}

function buildSpeakerIdentity(event, participantOverride = null) {
    const targetParticipantId = participantOverride?.participantId ?? event?.user_id;
    if (!targetParticipantId) {
        return null;
    }

    return {
        participantId: String(targetParticipantId),
        participantName: participantOverride?.participantName || event.sender?.card || event.sender?.nickname || String(targetParticipantId),
        messageType: event.message_type,
        groupId: event.group_id ? String(event.group_id) : null
    };
}

function extractMentionedParticipants(event) {
    const segments = Array.isArray(event?.message) ? event.message : [];
    const seen = new Set();
    const participants = [];
    for (const segment of segments) {
        if (segment.type !== 'at') {
            continue;
        }

        const qq = segment.data?.qq;
        if (qq === undefined || qq === null || qq === 'all') {
            continue;
        }

        const participantId = String(qq);
        if (seen.has(participantId)) {
            continue;
        }
        seen.add(participantId);
        participants.push({
            participantId,
            participantName: segment.data?.name || segment.data?.card || segment.data?.nickname || ''
        });
    }

    return participants;
}

function extractMentionedParticipant(event) {
    return extractMentionedParticipants(event)[0] || null;
}

function isParticipantProfileManualCommand(plainText, manualCommand) {
    if (!manualCommand) {
        return false;
    }

    return isCommandInvocation(plainText, manualCommand);
}

function extractTextAfterMentionCommand(event, command, mentionedParticipantId) {
    const segments = Array.isArray(event?.message) ? event.message : [];
    let sawCommand = false;
    let consumedMention = false;
    let messageText = '';

    for (const segment of segments) {
        if (segment?.type === 'text') {
            let text = segment.data?.text || '';
            if (!sawCommand) {
                if (!text.trimStart().startsWith(command)) {
                    continue;
                }
                text = text.replace(new RegExp(`^\\s*${command}`), '');
                sawCommand = true;
            }
            messageText += text;
            continue;
        }

        if (sawCommand && !consumedMention && segment?.type === 'at' && String(segment.data?.qq) === String(mentionedParticipantId)) {
            consumedMention = true;
        }
    }

    return sanitizeContent(messageText);
}

function processMentionOutputText(text) {
    const visibleText = sanitizeContent(text);
    if (!visibleText) {
        return '';
    }
    return sanitizeContent(regexProcessor.processOutput(visibleText));
}

async function generateContextualMentionReply({
    event,
    targetUserId,
    targetName,
    promptText,
    currentSpeakerOverride = null,
    sendMessage = false
}) {
    const currentCharacterName = config.chat.defaultCharacter;
    const effectiveBinding = getEffectiveBinding(config, currentCharacterName);
    sessionManager.setConfig(config, { storagePath: effectiveBinding.memoryDbPath || config.memory?.storage?.path });
    promptBuilder.updateConfig(config, effectiveBinding.preset);

    if (effectiveBinding.worldbook) {
        try {
            await worldBookManager.loadWorldBook(effectiveBinding.worldbook);
        } catch (error) {
            logger.warn(`[主动@] 加载绑定世界书失败: ${error.message}`);
        }
    }

    const memoryScope = buildMemoryScope(config, event);
    const sessionId = memoryScope.sessionKey;
    const structuredText = buildStructuredMessage(event, promptText);
    const processedInput = regexProcessor.processInput(structuredText);
    const context = sessionManager.getContext(sessionId, config.chat.historyLimit || 30);
    const stickyKeys = sessionManager.getStickyEntryKeys(sessionId);
    const runtimeContext = {
        sessionId,
        memoryScope,
        recallNamespace: buildRecallNamespace(config, memoryScope, currentCharacterName),
        messageType: event.message_type,
        messageCount: 1,
        participants: buildParticipants([{ event }]),
        triggerReason: 'admin_mention',
        replyReference: event.message_id
            ? `管理员当前正在操作消息 ID ${event.message_id} 的上下文，请保持承接群聊现场。`
            : '',
        injectionRisk: detectPromptInjectionRisk(processedInput, {
            sourceType: 'admin_user_message',
            trusted: true
        })
    };
    runtimeContext.currentSpeaker = currentSpeakerOverride || buildSpeakerIdentity(event);
    runtimeContext.currentSpeakerProfile = runtimeContext.currentSpeaker
        ? sessionManager.getParticipantProfile(runtimeContext.recallNamespace, runtimeContext.currentSpeaker.participantId)
        : null;
    runtimeContext.recalledEntries = sessionManager.recallMemory(runtimeContext.recallNamespace, processedInput, {
        currentParticipantId: runtimeContext.currentSpeaker?.participantId || null,
        recentLimit: 3,
        searchLimit: 3,
        summaryLimit: 2,
        limit: 5
    });

    const { messages, worldBookCount, worldBookEntries } = await promptBuilder.build(
        currentCharacterName,
        processedInput,
        context,
        stickyKeys,
        runtimeContext
    );

    logger.info('[主动@] Prompt 构建完成', {
        sessionId,
        targetUserId: String(targetUserId),
        messageCount: messages.length,
        worldBookCount,
        messageTrace: messages.map((message, index) => ({
            index,
            role: message.role,
            contentLength: typeof message.content === 'string' ? message.content.length : 0,
            contentPreview: typeof message.content === 'string' ? message.content.slice(0, 120) : null,
            source: message.meta?.source || null,
            sourceId: message.meta?.sourceId || null
        }))
    });

    const mentionResult = await generateMentionTextFromPrompt({
        aiClient,
        groupId: event.group_id,
        targetUserId,
        targetName,
        promptText,
        aiOptions: buildChatAIOverrides(config),
        buildPromptMessages({ groupId, targetUserId: mentionTargetUserId, targetName: mentionTargetName, promptText: mentionPromptText }) {
            return appendMentionTaskToPromptMessages({
                messages,
                groupId,
                targetUserId: mentionTargetUserId,
                targetName: mentionTargetName,
                promptText: mentionPromptText
            });
        }
    });

    const generatedMessage = sanitizeContent(mentionResult.generatedMessage);
    const messageToSend = sendMessage ? processMentionOutputText(generatedMessage) : generatedMessage;

    if (sendMessage) {
        await bot.sendGroupMessage(event.group_id, buildMentionMessage(targetUserId, messageToSend));
    }

    return {
        groupId: String(event.group_id),
        targetUserId: String(targetUserId),
        generatedMessage: messageToSend,
        usedPromptBuilder: !!mentionResult.usedPromptBuilder,
        finalMessageCount: mentionResult.finalMessageCount || 0,
        durationMs: mentionResult.durationMs || 0,
        prompt: mentionResult.prompt || null,
        worldBookCount,
        worldBookEntries
    };
}

async function generateAdminMentionReply(event, mentionedParticipant, promptText) {
    const timeoutMs = config.ai.timeout || 60000;
    const reply = await callWithTimeout(async () => {
        const result = await generateContextualMentionReply({
            event,
            targetUserId: mentionedParticipant.participantId,
            targetName: mentionedParticipant?.participantName || null,
            promptText,
            currentSpeakerOverride: buildSpeakerIdentity(event)
        });
        return result.generatedMessage;
    }, timeoutMs);
    return processMentionOutputText(reply);
}

function buildReplyReference(items) {
    const replyToBotItems = (items || []).filter((item) => item.replyToBot);
    if (replyToBotItems.length > 0) {
        const latest = replyToBotItems[replyToBotItems.length - 1];
        const quoted = latest.replyInfo?.quotedText
            ? `；被引用内容摘要：${latest.replyInfo.quotedText.slice(0, 160)}`
            : '';
        return `用户当前是在回复 bot 先前消息${latest.replyToMessageId ? `（消息 ID ${latest.replyToMessageId}）` : ''}，即使没有 @ 也应视为对 bot 发言；优先回应用户新输入，不要复读被引用长文${quoted}。`;
    }

    const replyIds = Array.from(new Set(
        (items || [])
            .map((item) => item.replyToMessageId)
            .filter(Boolean)
    ));

    if (replyIds.length === 0) {
        return '';
    }

    if (replyIds.length === 1) {
        return `用户当前是在回复消息 ID ${replyIds[0]} 的上下文下发言，注意承接前文而不是把它当成新话题。`;
    }

    return `本次聚合消息涉及多个回复上下文（消息 ID: ${replyIds.join(', ')}），注意优先承接这些被引用的前文，不要把整批输入误判成单一新话题。`;
}

function matchesKeywords(text, keywords = []) {
    if (!text) {
        return false;
    }

    return keywords.some((keyword) => keyword && text.includes(keyword));
}

function toComparableId(value) {
    return value === undefined || value === null ? '' : String(value);
}

function isAllowed(config, event) {
    const accessMode = config.chat.accessControlMode || 'allowlist';
    const allowedGroups = (config.chat.allowedGroups || []).map(toComparableId);
    const allowedUsers = (config.chat.allowedUsers || []).map(toComparableId);
    const blockedGroups = (config.chat.blockedGroups || []).map(toComparableId);
    const blockedUsers = (config.chat.blockedUsers || []).map(toComparableId);
    const groupId = toComparableId(event.group_id);
    const userId = toComparableId(event.user_id);

    if (accessMode === 'disabled') {
        return true;
    }

    if (accessMode === 'blocklist') {
        if (blockedUsers.includes(userId)) {
            return false;
        }

        if (event.message_type === 'group' && blockedGroups.includes(groupId)) {
            return false;
        }

        return true;
    }

    if (event.message_type === 'group' && allowedGroups.length > 0 && !allowedGroups.includes(groupId)) {
        return false;
    }

    if (allowedUsers.length > 0 && !allowedUsers.includes(userId)) {
        return false;
    }

    return true;
}

function buildRoutingDecision(config, event, plainText, isAtMe, messageInfo = {}) {
    const triggerMode = config.chat.triggerMode || 'auto';
    const requireAtInGroup = config.chat.requireAtInGroup !== false;
    const triggerPrefix = config.chat.triggerPrefix || '';
    const triggerKeywords = config.chat.triggerKeywords || [];
    const hasPrefix = triggerPrefix ? plainText.startsWith(triggerPrefix) : false;
    const hasKeyword = matchesKeywords(plainText, triggerKeywords);
    const allowed = isAllowed(config, event);
    const checks = {
        hasText: Boolean(plainText),
        allowed,
        triggerMode,
        requireAtInGroup,
        isAtBot: Boolean(isAtMe),
        replyToBot: Boolean(messageInfo.replyToBot),
        replyFetchStatus: messageInfo.replyInfo?.fetchStatus || '',
        replyFetchReason: messageInfo.replyInfo?.fetchReason || '',
        hasPrefix,
        hasKeyword,
        messageType: event.message_type || ''
    };

    const accept = (triggerReason) => ({
        shouldRespond: true,
        triggerReason,
        skipReason: '',
        checks
    });
    const skip = (skipReason) => ({
        shouldRespond: false,
        triggerReason: '',
        skipReason,
        checks
    });

    if (!plainText) {
        return skip('empty_text');
    }
    if (!allowed) {
        return skip('access_denied');
    }

    if (event.message_type === 'group') {
        if (messageInfo.replyToBot) {
            return accept('reply_to_bot');
        }
        if (triggerMode === 'always') {
            return accept('always');
        }
        if (triggerMode === 'prefix') {
            if (hasPrefix) return accept('prefix');
            if (!requireAtInGroup && isAtMe) return accept('at');
            return skip(requireAtInGroup ? 'prefix_required' : 'prefix_or_at_required');
        }
        if (triggerMode === 'keyword') {
            if (hasKeyword) return accept('keyword');
            if (isAtMe) return accept('at');
            return skip('keyword_or_at_required');
        }
        if (requireAtInGroup) {
            if (isAtMe) return accept('at');
            if (hasPrefix) return accept('prefix');
            if (hasKeyword) return accept('keyword');
            return skip('group_requires_at_prefix_keyword_or_reply_to_bot');
        }
        if (hasPrefix) return accept('prefix');
        if (hasKeyword) return accept('keyword');
        if (isAtMe) return accept('at');
        return skip('group_no_trigger_matched');
    }

    if (triggerMode === 'keyword') {
        return hasKeyword ? accept('keyword') : skip('private_keyword_required');
    }
    if (triggerMode === 'prefix') {
        return hasPrefix ? accept('prefix') : skip('private_prefix_required');
    }
    return accept('private');
}

function shouldRespond(config, event, plainText, isAtMe, messageInfo = {}) {
    return buildRoutingDecision(config, event, plainText, isAtMe, messageInfo).shouldRespond;
}

async function callWithTimeout(promiseFactory, timeoutMs) {
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs);
    });
    return Promise.race([promiseFactory(), timeoutPromise]);
}

const config = loadConfig();
llmEnabled = config.runtime?.llmEnabled !== false;
ensureBindingConfig(config);
// 清理旧版 ST 预设水印（temperature/top_p/UUID identifiers 等无用水印）
stripLegacyPresetMetadata(config);
// 从 data/presets/ 同步预设文件到 config（支持备份独立恢复）
syncPresetFiles(config, { importLoosePresets: true, importPosition: 'append' });
const logger = new Logger({
    logRetentionDays: config.server?.logRetentionDays,
    logCleanupIntervalMs: config.server?.logCleanupIntervalMs
});
const DATA_DIR = config.chat?.dataDir || join(ROOT_DIR, 'data');

const characterManager = new CharacterManager(DATA_DIR);
const worldBookManager = new WorldBookManager(DATA_DIR);
const sessionManager = new SessionManager(DATA_DIR, config, logger);
const regexProcessor = new RegexProcessor(config.regex, logger);
const aiClient = new AIClient({ ...config.ai, chat: config.chat }, logger);
const promptBuilder = new PromptBuilder(characterManager, worldBookManager, config, logger);
const ttsManager = new TTSManager(logger);
const groupRepeatDetector = new GroupRepeatDetector();

if (config.tts) {
    ttsManager.updateConfig(config.tts);
}

const app = express();
app.disable('x-powered-by');
const server = createServer(app);
app.use(express.json({ limit: '25mb' }));
	// 安全响应头
	app.use((req, res, next) => {
	    res.setHeader('X-Content-Type-Options', 'nosniff');
	    res.setHeader('X-Frame-Options', 'DENY');
	    res.setHeader('X-XSS-Protection', '1; mode=block');
	    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
	    res.setHeader('X-DNS-Prefetch-Control', 'off');
	    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
	    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	    next();
	});

	// 速率限制
	const { default: createRateLimiter } = await import('express-rate-limit');
	const globalLimiter = createRateLimiter({
	    windowMs: 60 * 1000,
	    max: 300,
	    standardHeaders: true,
	    legacyHeaders: false,
	    message: { success: false, error: '请求过于频繁，请稍后再试' }
	});
	app.use(globalLimiter);

	const authLimiter = createRateLimiter({
	    windowMs: 60 * 1000,
	    max: 10,
	    standardHeaders: true,
	    legacyHeaders: false,
	    message: { success: false, error: '登录尝试过于频繁，请 1 分钟后再试' }
	});
	app.use('/api/auth/login', authLimiter);

	// 信任反向代理
	if (config.server?.trustProxy) {
	    app.set('trust proxy', config.server.trustProxy === true ? 1 : config.server.trustProxy);
	}



if (config.auth?.enabled) {
    const authSessionDays = config.auth.sessionDays ?? 30;
    const FileStore = createFileStore(session);
    const sessionStorePath = config.auth.sessionStorePath || join(DATA_DIR, 'sessions');
    app.use(session({
        secret: config.auth.sessionSecret || require('crypto').randomBytes(32).toString('hex'),
        resave: false,
        saveUninitialized: false,
        rolling: true,
        store: new FileStore({
            path: sessionStorePath,
            retries: 1,
            ttl: authSessionDays * 24 * 60 * 60,
            reapInterval: 60 * 60
        }),
        cookie: {
            secure: config.auth?.cookieSecure === true,
            httpOnly: true,
            sameSite: config.auth?.cookieSecure === true ? 'strict' : 'lax',
            maxAge: authSessionDays * 24 * 60 * 60 * 1000
        }
    }));
}

// 静态文件鉴权：未登录只能访问 login.html，其余 302 到登录页
app.use((req, res, next) => {
    const isAuthEnabled = config.auth?.enabled === true;
    const isAuthenticated = req.session?.authenticated === true;
    const isLoginPage = req.path === '/login.html' || req.path === '/';
    const isAuthApi = req.path.startsWith('/api/auth/');

    if (!isAuthEnabled || isAuthenticated || isLoginPage || isAuthApi) {
        return next();
    }
    // API 请求返回 401，页面请求重定向到登录页
    if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: '未登录' });
    }
    res.redirect('/login.html');
});

app.use(express.static(join(ROOT_DIR, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));
app.use('/audio', express.static(join(ROOT_DIR, 'audio'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

const bot = new OneBotClient(config.onebot, logger);
let lastInboundMessageAt = null;
let lastProcessedBatchAt = null;
let healthTicker = null;
let lastRoutingSnapshot = null;
let lastInjectionObservation = null;
let recentInjectionObservations = [];
let lastRecallSnapshot = null;
const participantProfileTimers = new Map();
const participantProfileTargets = new Map();
const participantProfileBuilds = new Set();
const participantProfileRetryQueue = new Map();
let participantProfileIntervalTimer = null;
let participantProfileProgress = {
    running: false,
    stage: 'idle',
    triggeredBy: null,
    participantId: null,
    participantName: null,
    scopeType: null,
    scopeKey: null,
    analysisMode: null,
    sourceMessageCount: 0,
    hasEnoughNewInfo: false,
    currentMessage: '暂无人物档案任务',
    progressPercent: 0,
    tasks: [],
    savedCount: 0,
    lastQueuedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastResult: null,
    updatedAt: Date.now()
};

let knowledgeImportProgress = {
    running: false,
    stage: 'idle',
    triggeredBy: null,
    title: null,
    knowledgeType: null,
    scopeType: null,
    scopeKey: null,
    characterName: null,
    presetName: null,
    totalChunks: 0,
    processedChunks: 0,
    savedCount: 0,
    currentChunk: 0,
    currentMessage: '暂无知识导入任务',
    progressPercent: 0,
    tasks: [],
    lastQueuedAt: null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    lastResult: null,
    updatedAt: Date.now()
};

const DASHBOARD_METRIC_WINDOW_SIZE = 6;
const DASHBOARD_METRIC_BUCKET_MS = 5 * 60 * 1000;
const DASHBOARD_METRIC_TYPES = ['chat', 'participantProfile', 'knowledgeImport', 'tts'];
let dashboardMetrics = [];

function floorDashboardMetricTimestamp(timestamp = Date.now()) {
    return Math.floor(timestamp / DASHBOARD_METRIC_BUCKET_MS) * DASHBOARD_METRIC_BUCKET_MS;
}

function createDashboardMetricBucket(bucketStart) {
    return {
        bucketStart,
        values: {
            chat: 0,
            participantProfile: 0,
            knowledgeImport: 0,
            tts: 0
        }
    };
}

function ensureDashboardMetricBuckets(timestamp = Date.now()) {
    const latestBucketStart = floorDashboardMetricTimestamp(timestamp);
    if (dashboardMetrics.length === 0) {
        dashboardMetrics = Array.from({ length: DASHBOARD_METRIC_WINDOW_SIZE }, (_, index) => {
            const bucketStart = latestBucketStart - (DASHBOARD_METRIC_WINDOW_SIZE - 1 - index) * DASHBOARD_METRIC_BUCKET_MS;
            return createDashboardMetricBucket(bucketStart);
        });
        return dashboardMetrics;
    }

    const currentLatestBucketStart = dashboardMetrics[dashboardMetrics.length - 1]?.bucketStart || latestBucketStart;
    if (latestBucketStart > currentLatestBucketStart) {
        const steps = Math.floor((latestBucketStart - currentLatestBucketStart) / DASHBOARD_METRIC_BUCKET_MS);
        for (let index = 0; index < steps; index += 1) {
            dashboardMetrics.push(createDashboardMetricBucket(currentLatestBucketStart + (index + 1) * DASHBOARD_METRIC_BUCKET_MS));
        }
    }

    dashboardMetrics = dashboardMetrics
        .filter((bucket) => bucket.bucketStart <= latestBucketStart)
        .slice(-DASHBOARD_METRIC_WINDOW_SIZE);

    while (dashboardMetrics.length < DASHBOARD_METRIC_WINDOW_SIZE) {
        const firstBucketStart = dashboardMetrics[0]?.bucketStart || latestBucketStart;
        dashboardMetrics.unshift(createDashboardMetricBucket(firstBucketStart - DASHBOARD_METRIC_BUCKET_MS));
    }

    return dashboardMetrics;
}

function recordDashboardMetric(type, count = 1, timestamp = Date.now()) {
    if (!DASHBOARD_METRIC_TYPES.includes(type)) {
        return;
    }
    const buckets = ensureDashboardMetricBuckets(timestamp);
    const bucketStart = floorDashboardMetricTimestamp(timestamp);
    const bucket = buckets.find((item) => item.bucketStart === bucketStart);
    if (!bucket) {
        return;
    }
    bucket.values[type] = (Number(bucket.values[type]) || 0) + (Number(count) || 0);
}

function getDashboardMetricsSnapshot() {
    const buckets = ensureDashboardMetricBuckets(Date.now());
    const timeline = buckets.map((bucket) => bucket.bucketStart);
    const series = Object.fromEntries(DASHBOARD_METRIC_TYPES.map((type) => [
        type,
        buckets.map((bucket) => Number(bucket.values[type]) || 0)
    ]));
    return {
        bucketMs: DASHBOARD_METRIC_BUCKET_MS,
        timeline,
        series,
        composition: sessionManager?.getDashboardCompositionStats?.() || {
            messages: 0,
            summaries: 0,
            participantProfiles: 0,
            fixedKnowledge: 0,
            dynamicKnowledge: 0
        },
        updatedAt: Date.now()
    };
}

const MAX_RECENT_INJECTION_OBSERVATIONS = 20;

function buildObservationEvent({ observation, adminUser }) {
    const source = adminUser
        ? observation?.trusted_admin_inputs?.[0]
        : observation?.untrusted_user_inputs?.[0];

    return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        actorType: adminUser ? 'admin' : 'user',
        summary: {
            sessionId: observation?.runtime_stats?.sessionId || '',
            messageType: observation?.runtime_stats?.messageType || '',
            triggerReason: observation?.runtime_stats?.triggerReason || '',
            riskLevel: source?.risk?.level || 'none',
            matchedRules: Array.isArray(source?.risk?.matchedRules) ? source.risk.matchedRules : [],
            contentPreview: String(source?.content || '').slice(0, 160)
        },
        observation
    };
}

function rememberObservationEvent(event) {
    recentInjectionObservations = [event, ...recentInjectionObservations]
        .slice(0, MAX_RECENT_INJECTION_OBSERVATIONS);
}

function formatAgo(timestamp) {
    if (!timestamp) {
        return 'never';
    }

    const diffMs = Math.max(0, Date.now() - timestamp);
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 60) {
        return `${seconds}s ago`;
    }

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ago`;
    }

    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
}

function updateParticipantProfileProgress(patch = {}) {
    participantProfileProgress = {
        ...participantProfileProgress,
        ...patch,
        updatedAt: Date.now()
    };
    return participantProfileProgress;
}

function getParticipantProfileSavedCount() {
    if (typeof sessionManager?.countParticipantProfiles === 'function') {
        return sessionManager.countParticipantProfiles();
    }
    if (typeof sessionManager?.listParticipantProfiles === 'function') {
        return sessionManager.listParticipantProfiles(500).length;
    }
    return 0;
}

function setParticipantProfileTask(taskPatch = {}) {
    const taskKey = String(taskPatch.taskKey || 'participant-profile-default');
    const taskList = Array.isArray(participantProfileProgress.tasks) ? [...participantProfileProgress.tasks] : [];
    const nextTask = {
        progressPercent: 0,
        running: false,
        stage: 'idle',
        currentMessage: '暂无任务状态',
        ...taskPatch,
        taskKey
    };
    const index = taskList.findIndex((item) => item.taskKey === taskKey);
    if (index >= 0) {
        taskList[index] = {
            ...taskList[index],
            ...nextTask,
            taskKey
        };
    } else {
        taskList.push(nextTask);
    }
    participantProfileProgress.tasks = taskList;
    participantProfileProgress.savedCount = getParticipantProfileSavedCount();
    participantProfileProgress.progressPercent = taskList.length > 0
        ? Math.round(taskList.reduce((sum, item) => sum + (Number(item.progressPercent) || 0), 0) / taskList.length)
        : (participantProfileProgress.progressPercent || 0);
    participantProfileProgress.updatedAt = Date.now();
    return participantProfileProgress;
}

function getParticipantProfileProgressSnapshot() {
    return {
        ...participantProfileProgress,
        savedCount: getParticipantProfileSavedCount(),
        tasks: Array.isArray(participantProfileProgress.tasks) ? participantProfileProgress.tasks.map((item) => ({ ...item })) : []
    };
}

function updateKnowledgeImportProgress(patch = {}) {
    knowledgeImportProgress = {
        ...knowledgeImportProgress,
        ...patch,
        updatedAt: Date.now()
    };
    return knowledgeImportProgress;
}

function setKnowledgeImportTask(taskPatch = {}) {
    const taskKey = String(taskPatch.taskKey || 'knowledge-import-default');
    const taskList = Array.isArray(knowledgeImportProgress.tasks) ? [...knowledgeImportProgress.tasks] : [];
    const nextTask = {
        progressPercent: 0,
        running: false,
        stage: 'idle',
        currentMessage: '暂无任务状态',
        ...taskPatch,
        taskKey
    };
    const index = taskList.findIndex((item) => item.taskKey === taskKey);
    if (index >= 0) {
        taskList[index] = {
            ...taskList[index],
            ...nextTask,
            taskKey
        };
    } else {
        taskList.push(nextTask);
    }
    knowledgeImportProgress.tasks = taskList;
    knowledgeImportProgress.progressPercent = taskList.length > 0
        ? Math.round(taskList.reduce((sum, item) => sum + (Number(item.progressPercent) || 0), 0) / taskList.length)
        : (knowledgeImportProgress.progressPercent || 0);
    knowledgeImportProgress.updatedAt = Date.now();
    return knowledgeImportProgress;
}

function getKnowledgeImportProgressSnapshot() {
    return {
        ...knowledgeImportProgress,
        tasks: Array.isArray(knowledgeImportProgress.tasks) ? knowledgeImportProgress.tasks.map((item) => ({ ...item })) : []
    };
}

function startHealthTicker() {
    if (healthTicker) {
        clearInterval(healthTicker);
    }

    const intervalMs = config.server?.healthLogIntervalMs ?? 60000;
    if (intervalMs <= 0) {
        return;
    }

    healthTicker = setInterval(() => {
        const runtimeStats = runtime.getStats();
        const memoryStats = sessionManager.getStats();
        logger.info(
            `[健康] onebot=${bot.isConnected() ? 'connected' : 'disconnected'} | sessions=${memoryStats.totalSessions} | messages=${memoryStats.totalMessages} | summaries=${memoryStats.totalSummaries} | buffered=${runtimeStats.bufferedMessages} | active=${runtimeStats.activeSessions} | batches=${runtimeStats.totalBatches} | last_inbound=${formatAgo(lastInboundMessageAt)} | last_batch=${formatAgo(lastProcessedBatchAt)}`
        );
    }, intervalMs);
}


async function sendQuotedStatusMessage(event, message) {
    const normalizedMessage = sanitizeContent(message);
    if (!normalizedMessage) {
        return;
    }

    if (event.message_type === 'group') {
        if (event.message_id) {
            await bot.sendGroupReply(event.group_id, event.message_id, normalizedMessage);
            return;
        }
        await bot.sendGroupMessage(event.group_id, normalizedMessage);
        return;
    }

    if (event.message_id) {
        await bot.sendPrivateReply(event.user_id, event.message_id, normalizedMessage);
        return;
    }

    await bot.sendPrivateMessage(event.user_id, normalizedMessage);
}

async function sendFailureMessage(event, message) {
    const normalizedMessage = sanitizeContent(message);
    if (!normalizedMessage) {
        return;
    }

    await sendQuotedStatusMessage(event, `⚠️ ${normalizedMessage}`);
}

function shouldSendEmojiReaction(config) {
    return config.chat?.emojiReaction === true;
}

function sendEmojiReactionForEvent(event) {
    if (!shouldSendEmojiReaction(config) || !event?.message_id || !bot?.setMsgEmojiLike) {
        return;
    }

    const emojiId = resolveEmojiReactionId(config);
    bot.setMsgEmojiLike(event.message_id, emojiId).catch((error) => {
        logger?.debug?.(`[表情] QQ 表情回应失败: ${error.message}`);
    });
}

async function dispatchReply(event, processedReply, options = {}) {
    return dispatchReplyWithDeps(event, processedReply, options, {
        config,
        bot,
        ttsManager,
        logger,
        recordDashboardMetric,
        sleep
    });
}

function isParticipantProfileBlacklisted(participantProfileConfig, participantId) {
    if (!participantId) {
        return false;
    }

    return participantProfileConfig.blacklistParticipantIds.includes(String(participantId));
}

async function resolveCurrentParticipantIdentity(manager, speakerIdentity, logger) {
    if (!speakerIdentity?.participantId) {
        return speakerIdentity;
    }

    const localSources = typeof manager?.listParticipantIdentitySources === 'function'
        ? manager.listParticipantIdentitySources(speakerIdentity.participantId, 20)
        : [];
    const groupIds = collectParticipantGroupIds(
        speakerIdentity.groupId,
        localSources.map((item) => item.groupId)
    );
    const qqIdentity = await resolveParticipantIdentityFromOneBot(bot, speakerIdentity.participantId, {
        groupIds,
        messageType: speakerIdentity.messageType || localSources[0]?.messageType || null,
        logger
    });
    if (qqIdentity?.participantName) {
        return mergeParticipantIdentity(speakerIdentity, qqIdentity);
    }

    const localIdentity = localSources.find((item) => item.participantName);
    return mergeParticipantIdentity(speakerIdentity, localIdentity);
}

function refreshExistingParticipantProfileIdentity(manager, existing, speakerIdentity) {
    if (!existing?.id || !speakerIdentity?.participantName || typeof manager?.refreshParticipantProfileName !== 'function') {
        return existing;
    }

    const result = manager.refreshParticipantProfileName(existing.id, {
        participantId: speakerIdentity.participantId,
        participantName: speakerIdentity.participantName,
        groupId: speakerIdentity.groupId || existing.metadata?.groupId || null,
        messageType: speakerIdentity.messageType || existing.metadata?.messageType || null,
        source: speakerIdentity.identitySource || 'runtime_identity'
    });
    return result?.item || existing;
}

async function analyzeParticipantProfileEntry(entry, options = {}) {
    if (!entry?.participantId || !entry.scopeType || !entry.scopeKey) {
        throw new Error('人物档案上下文不完整，无法重分析');
    }

    const namespaceOptions = {
        scopeType: entry.scopeType,
        scopeKey: entry.scopeKey,
        characterName: entry.characterName || null,
        presetName: entry.presetName || null
    };
    const latestIdentity = sessionManager.getLatestParticipantIdentity?.(entry.participantId) || null;
    const speakerIdentity = {
        participantId: String(entry.participantId),
        participantName: latestIdentity?.participantName || entry.participantName || entry.title || String(entry.participantId),
        messageType: entry.metadata?.messageType || null,
        groupId: entry.metadata?.groupId ? String(entry.metadata.groupId) : null
    };

    const profile = await maybeBuildParticipantProfile(
        sessionManager,
        aiClient,
        namespaceOptions,
        speakerIdentity,
        logger,
        {
            force: true,
            triggeredBy: options.triggeredBy || 'manual'
        }
    );

    if (!profile) {
        throw new Error('未能生成人物档案');
    }

    if (options.operator) {
        sessionManager.saveParticipantProfile(profile.id, {
            title: profile.title,
            content: profile.content,
            tags: profile.tags,
            metadata: {
                ...profile.metadata,
                updatedBy: options.operator,
                editedBy: options.operator
            }
        });
        return sessionManager.getParticipantProfileByEntryId(profile.id);
    }

    return profile;
}

async function maybeBuildParticipantProfile(sessionManager, aiClient, namespaceOptions, speakerIdentity, logger, options = {}) {
    if (!speakerIdentity?.participantId) {
        return null;
    }

    const participantProfileConfig = getParticipantProfileConfig(config);
    if (!participantProfileConfig.enabled) {
        return null;
    }
    if (isParticipantProfileBlacklisted(participantProfileConfig, speakerIdentity.participantId)) {
        return null;
    }

    speakerIdentity = await resolveCurrentParticipantIdentity(sessionManager, speakerIdentity, logger);

    const buildKey = getParticipantProfileTimerKey(namespaceOptions, speakerIdentity);
    if (participantProfileBuilds.has(buildKey)) {
        return null;
    }

    participantProfileBuilds.add(buildKey);
    const profileTaskMeta = buildParticipantProfileTaskMeta(namespaceOptions, speakerIdentity);
    updateParticipantProfileProgress({
        running: true,
        stage: 'collecting',
        triggeredBy: options.triggeredBy || 'auto',
        participantId: String(speakerIdentity.participantId),
        participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
        scopeType: namespaceOptions?.scopeType || null,
        scopeKey: namespaceOptions?.scopeKey || null,
        analysisMode: participantProfileConfig.analysisMode,
        sourceMessageCount: 0,
        hasEnoughNewInfo: false,
        currentMessage: '正在收集人物档案源消息',
        progressPercent: 10,
        lastStartedAt: Date.now(),
        lastError: null,
        lastResult: null
    });
    setParticipantProfileTask({
        ...profileTaskMeta,
        running: true,
        stage: 'collecting',
        triggeredBy: options.triggeredBy || 'auto',
        analysisMode: participantProfileConfig.analysisMode,
        sourceMessageCount: 0,
        hasEnoughNewInfo: false,
        currentMessage: '正在收集人物档案源消息',
        progressPercent: 10,
        lastStartedAt: Date.now(),
        lastError: null,
        lastResult: null
    });

    try {
        const analysisMode = participantProfileConfig.analysisMode;
        const sourceFilter = (analysisMode === 'bot_only_messages' || analysisMode === 'bot_only_profile')
            ? 'bot_only' : 'all';
        const source = sessionManager.collectParticipantProfileSource(
            speakerIdentity.participantId,
            namespaceOptions,
            {
                threshold: participantProfileConfig.threshold,
                limit: participantProfileConfig.sourceMessageLimit,
                sourceFilter
            }
        );
        const existingProfilesForMerge = typeof sessionManager.listParticipantProfileIdentityProfiles === 'function'
            ? sessionManager.listParticipantProfileIdentityProfiles(namespaceOptions, speakerIdentity.participantId)
            : (source.existing ? [source.existing] : []);
        updateParticipantProfileProgress({
            stage: 'collecting',
            sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: `已收集 ${Array.isArray(source.messages) ? source.messages.length : 0} 条源消息`,
            progressPercent: 28
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: true,
            stage: 'collecting',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: `已收集 ${Array.isArray(source.messages) ? source.messages.length : 0} 条源消息`,
            progressPercent: 28
        });

        if (!options.force && !source.hasEnoughNewInfo) {
            const refreshedExisting = refreshExistingParticipantProfileIdentity(sessionManager, source.existing, speakerIdentity);
            const skippedMessage = source.existing
                ? '新信息不足，沿用现有人物档案'
                : '新信息不足，尚未生成档案';
            updateParticipantProfileProgress({
                running: false,
                stage: 'completed',
                currentMessage: skippedMessage,
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'not_enough_new_info',
                    participantId: String(speakerIdentity.participantId),
                    profileId: refreshedExisting?.id || null
                }
            });
            setParticipantProfileTask({
                ...profileTaskMeta,
                running: false,
                stage: 'completed',
                triggeredBy: options.triggeredBy || 'auto',
                analysisMode: participantProfileConfig.analysisMode,
                sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
                hasEnoughNewInfo: !!source.hasEnoughNewInfo,
                currentMessage: skippedMessage,
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'not_enough_new_info',
                    participantId: String(speakerIdentity.participantId),
                    profileId: refreshedExisting?.id || null
                }
            });
            return refreshedExisting;
        }

        if (!source.messages.length) {
            const refreshedExisting = refreshExistingParticipantProfileIdentity(sessionManager, source.existing, speakerIdentity);
            updateParticipantProfileProgress({
                running: false,
                stage: 'completed',
                currentMessage: '没有可用于建档的新消息',
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'no_source_messages',
                    participantId: String(speakerIdentity.participantId),
                    profileId: refreshedExisting?.id || null
                }
            });
            setParticipantProfileTask({
                ...profileTaskMeta,
                running: false,
                stage: 'completed',
                triggeredBy: options.triggeredBy || 'auto',
                analysisMode: participantProfileConfig.analysisMode,
                sourceMessageCount: 0,
                hasEnoughNewInfo: false,
                currentMessage: '没有可用于建档的新消息',
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'no_source_messages',
                    participantId: String(speakerIdentity.participantId),
                    profileId: refreshedExisting?.id || null
                }
            });
            return refreshedExisting;
        }

        updateParticipantProfileProgress({
            stage: 'prompting',
            currentMessage: '正在构建人物档案分析提示词',
            progressPercent: 45
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: true,
            stage: 'prompting',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: '正在构建人物档案分析提示词',
            progressPercent: 45
        });
        const profilePrompt = buildParticipantProfilePrompt(source, participantProfileConfig.analysisMode);
        updateParticipantProfileProgress({
            stage: 'generating',
            currentMessage: '正在调用 AI 生成人物档案',
            progressPercent: 70
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: true,
            stage: 'generating',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: '正在调用 AI 生成人物档案',
            progressPercent: 70
        });
        recordDashboardMetric('participantProfile');
        const participantProfileAIOverrides = buildParticipantProfileAIOverrides(participantProfileConfig);
        const profileResult = await aiClient.chat(
            [{ role: 'user', content: profilePrompt }],
            participantProfileAIOverrides
        );
        let profileText = String(aiClient.getVisibleResponseContent(profileResult) || '').trim();
        if (!profileText) {
            throw new Error('AI 未生成可保存的人物档案');
        }

        const oldProfileText = existingProfilesForMerge
            .map((item, index) => {
                const title = item.participantName || item.title || item.participantId || `profile-${index + 1}`;
                return `【旧档案 ${index + 1}: ${title}】\n${String(item.content || '').trim()}`;
            })
            .filter((text) => text.trim())
            .join('\n\n');
        let mergedAt = null;
        let mergedProfileCount = 0;
        if (oldProfileText) {
            updateParticipantProfileProgress({
                stage: 'merging',
                currentMessage: '正在合并旧档案和新版本',
                progressPercent: 82
            });
            setParticipantProfileTask({
                ...profileTaskMeta,
                running: true,
                stage: 'merging',
                triggeredBy: options.triggeredBy || 'auto',
                analysisMode: participantProfileConfig.analysisMode,
                sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
                hasEnoughNewInfo: !!source.hasEnoughNewInfo,
                currentMessage: '正在合并旧档案和新版本',
                progressPercent: 82
            });
            const mergePrompt = buildParticipantProfileMergePrompt({
                participantId: speakerIdentity.participantId,
                participantName: speakerIdentity.participantName,
                oldProfile: oldProfileText,
                newProfile: profileText
            });
            const mergeResult = await aiClient.chat(
                [{ role: 'user', content: mergePrompt }],
                participantProfileAIOverrides
            );
            const mergedProfileText = String(aiClient.getVisibleResponseContent(mergeResult) || '').trim();
            if (!mergedProfileText) {
                throw new Error('AI 未生成可保存的人物档案合并结果');
            }
            profileText = mergedProfileText;
            mergedAt = Date.now();
            mergedProfileCount = existingProfilesForMerge.length + 1;
        }

        updateParticipantProfileProgress({
            stage: 'saving',
            currentMessage: '正在保存人物档案结果',
            progressPercent: 88
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: true,
            stage: 'saving',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            sourceMessageCount: Array.isArray(source.messages) ? source.messages.length : 0,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: '正在保存人物档案结果',
            progressPercent: 88
        });
        const lastMessage = source.messages[source.messages.length - 1] || null;
        const lastProcessedMessageAt = lastMessage?.timestamp || source.since;
        sessionManager.upsertParticipantProfile(namespaceOptions, {
            participantId: speakerIdentity.participantId,
            title: speakerIdentity.participantName,
            content: profileText,
            tags: sessionManager.buildKeywordsFromText(profileText),
            metadata: {
                participantId: speakerIdentity.participantId,
                participantName: speakerIdentity.participantName,
                lastProcessedMessageAt,
                lastProcessedSessionId: lastMessage?.sessionId || null,
                lastSourceMessageCount: source.messages.length,
                analysisMode: participantProfileConfig.analysisMode,
                source: 'participant_profile',
                triggeredBy: options.triggeredBy || 'auto',
                groupId: speakerIdentity.groupId || null,
                messageType: speakerIdentity.messageType || null,
                participantNameSource: speakerIdentity.identitySource || 'runtime_identity',
                ...(mergedAt ? {
                    lastMergeAt: mergedAt,
                    mergedProfileCount,
                    mergeSource: 'llm'
                } : {})
            }
        });

        const savedProfile = sessionManager.getParticipantProfile(namespaceOptions, speakerIdentity.participantId);
        updateParticipantProfileProgress({
            running: false,
            stage: 'completed',
            currentMessage: '人物档案已更新完成',
            progressPercent: 100,
            lastCompletedAt: Date.now(),
            lastSuccessAt: Date.now(),
            lastResult: {
                skipped: false,
                participantId: String(speakerIdentity.participantId),
                participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
                profileId: savedProfile?.id || null,
                sourceMessageCount: source.messages.length,
                analysisMode: participantProfileConfig.analysisMode,
                triggeredBy: options.triggeredBy || 'auto'
            }
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: false,
            stage: 'completed',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            sourceMessageCount: source.messages.length,
            hasEnoughNewInfo: !!source.hasEnoughNewInfo,
            currentMessage: '人物档案已更新完成',
            progressPercent: 100,
            lastCompletedAt: Date.now(),
            lastSuccessAt: Date.now(),
            lastResult: {
                skipped: false,
                participantId: String(speakerIdentity.participantId),
                participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
                profileId: savedProfile?.id || null,
                sourceMessageCount: source.messages.length,
                analysisMode: participantProfileConfig.analysisMode,
                triggeredBy: options.triggeredBy || 'auto'
            }
        });
        logger.info(`[画像] 已更新人物档案: ${speakerIdentity.participantName}(${speakerIdentity.participantId})`);
        return savedProfile;
    } catch (error) {
        const retryEnabled = participantProfileConfig.retryOnError !== false;
        const retryCount = options._retryCount || 0;

        if (retryEnabled && retryCount < 2) {
            logger.warn(`[画像] LLM调用失败，重试 ${retryCount+1}/2: ${error.message}`);
            participantProfileBuilds.delete(buildKey);
            await sleep(2000);
            return maybeBuildParticipantProfile(sessionManager, aiClient, namespaceOptions, speakerIdentity, logger, {
                ...options, _retryCount: retryCount + 1
            });
        }

        // 重试耗尽，挂起到队列下次再试
        if (retryEnabled) {
            const queueKey = buildKey;
            participantProfileRetryQueue.set(queueKey, { namespaceOptions, speakerIdentity, addedAt: Date.now(), error: error.message });
            logger.warn(`[画像] 重试失败已挂起: ${speakerIdentity.participantName}(${speakerIdentity.participantId})，下次触发再试`);
        }

        updateParticipantProfileProgress({
            running: false,
            stage: retryEnabled ? 'queued' : 'failed',
            currentMessage: retryEnabled ? '重试失败已挂起，下次继续' : `人物档案分析失败: ${error.message}`,
            progressPercent: 100,
            lastCompletedAt: Date.now(),
            lastFailureAt: Date.now(),
            lastError: error.message,
            lastResult: {
                skipped: false,
                participantId: String(speakerIdentity.participantId),
                participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
                triggeredBy: options.triggeredBy || 'auto'
            }
        });
        setParticipantProfileTask({
            ...profileTaskMeta,
            running: false,
            stage: retryEnabled ? 'queued' : 'failed',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            currentMessage: retryEnabled ? '重试失败已挂起，下次继续' : `人物档案分析失败: ${error.message}`,
            progressPercent: 100,
            lastCompletedAt: Date.now(),
            lastFailureAt: Date.now(),
            lastError: error.message,
            lastResult: {
                skipped: false,
                participantId: String(speakerIdentity.participantId),
                participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
                triggeredBy: options.triggeredBy || 'auto'
            }
        });
    } finally {
        participantProfileBuilds.delete(buildKey);
    }
}

function startParticipantProfileIntervalScheduler(sessionManager, aiClient, logger) {
    if (participantProfileIntervalTimer) {
        clearInterval(participantProfileIntervalTimer);
        participantProfileIntervalTimer = null;
    }

    const participantProfileConfig = getParticipantProfileConfig(config);
    if (!participantProfileConfig.enabled || !shouldUseIntervalParticipantProfileTrigger(participantProfileConfig)) {
        return;
    }

    participantProfileIntervalTimer = setInterval(() => {
        // 先处理重试队列
        if (participantProfileRetryQueue.size > 0) {
            for (const [key, item] of participantProfileRetryQueue) {
                logger.info(`[画像] 重试挂起的档案: ${item.speakerIdentity?.participantName}(${item.speakerIdentity?.participantId})`);
                participantProfileRetryQueue.delete(key);
                maybeBuildParticipantProfile(sessionManager, aiClient, item.namespaceOptions, item.speakerIdentity, logger, {
                    triggeredBy: 'retry'
                }).catch(() => {});
            }
        }
        for (const target of participantProfileTargets.values()) {
            updateParticipantProfileProgress({
                running: false,
                stage: 'queued',
                triggeredBy: 'interval',
                participantId: String(target.speakerIdentity?.participantId || ''),
                participantName: target.speakerIdentity?.participantName || String(target.speakerIdentity?.participantId || ''),
                scopeType: target.namespaceOptions?.scopeType || null,
                scopeKey: target.namespaceOptions?.scopeKey || null,
                currentMessage: '定时巡检命中，准备执行人物档案更新',
                lastQueuedAt: Date.now(),
                lastError: null
            });
            maybeBuildParticipantProfile(
                sessionManager,
                aiClient,
                target.namespaceOptions,
                target.speakerIdentity,
                logger,
                {
                    triggeredBy: 'interval'
                }
            ).catch((error) => {
                logger.warn(`[画像] 定时建档失败: ${target.speakerIdentity?.participantId || 'unknown'} ${error.message}`);
            });
        }
    }, participantProfileConfig.intervalMs);
}

function scheduleParticipantProfileUpdate(sessionManager, aiClient, namespaceOptions, speakerIdentity, logger) {
    if (!speakerIdentity?.participantId) {
        return;
    }

    const participantProfileConfig = getParticipantProfileConfig(config);
    if (!participantProfileConfig.enabled || isParticipantProfileBlacklisted(participantProfileConfig, speakerIdentity.participantId)) {
        return;
    }

    const timerKey = trackParticipantProfileTarget(participantProfileTargets, namespaceOptions, speakerIdentity);
    if (!timerKey) {
        return;
    }
    const profileTaskMeta = buildParticipantProfileTaskMeta(namespaceOptions, speakerIdentity);

    updateParticipantProfileProgress({
        running: false,
        stage: 'queued',
        triggeredBy: 'idle',
        participantId: String(speakerIdentity.participantId),
        participantName: speakerIdentity.participantName || String(speakerIdentity.participantId),
        scopeType: namespaceOptions?.scopeType || null,
        scopeKey: namespaceOptions?.scopeKey || null,
        currentMessage: '已进入空闲建档队列，等待触发',
        progressPercent: 5,
        lastQueuedAt: Date.now(),
        lastError: null
    });
    setParticipantProfileTask({
        ...profileTaskMeta,
        running: false,
        stage: 'queued',
        triggeredBy: 'idle',
        currentMessage: '已进入空闲建档队列，等待触发',
        progressPercent: 5,
        lastQueuedAt: Date.now(),
        lastError: null
    });

    if (!shouldUseIdleParticipantProfileTrigger(participantProfileConfig)) {
        return;
    }

    const existingTimer = participantProfileTimers.get(timerKey);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
        participantProfileTimers.delete(timerKey);
        try {
            await maybeBuildParticipantProfile(sessionManager, aiClient, namespaceOptions, speakerIdentity, logger, {
                triggeredBy: 'idle'
            });
        } catch (error) {
            logger.warn(`[画像] 空闲建档失败: ${speakerIdentity.participantId} ${error.message}`);
        }
    }, participantProfileConfig.idleMs);

    participantProfileTimers.set(timerKey, timer);
}

function clearParticipantProfileTimers() {
    for (const timer of participantProfileTimers.values()) {
        clearTimeout(timer);
    }

    participantProfileTimers.clear();
    updateParticipantProfileProgress({
        running: false,
        stage: 'idle',
        currentMessage: '人物档案任务已重置',
        lastQueuedAt: null
    });

    if (participantProfileIntervalTimer) {
        clearInterval(participantProfileIntervalTimer);
        participantProfileIntervalTimer = null;
    }

    startParticipantProfileIntervalScheduler(sessionManager, aiClient, logger);
}

async function backfillParticipantProfilesFromHistory(sessionManager, aiClient, logger) {
    const participantProfileConfig = getParticipantProfileConfig(config);
    if (!participantProfileConfig.enabled) {
        return;
    }

    const currentCharacterName = config.chat.defaultCharacter || null;
    const scopeType = 'global_shared';
    const scopeKey = 'global_shared_memory';
    const namespaceOptions = {
        scopeType,
        scopeKey,
        characterName: currentCharacterName,
        presetName: null
    };
    const db = sessionManager.db;
    const rows = db.prepare(`
        SELECT
            json_extract(metadata_json, '$.userId') AS participant_id,
            MAX(COALESCE(json_extract(metadata_json, '$.groupId'), '')) AS group_id,
            MAX(COALESCE(json_extract(metadata_json, '$.participants[0]'), '')) AS participant_label,
            COUNT(*) AS message_count
        FROM messages
        WHERE role = 'user'
          AND json_extract(metadata_json, '$.userId') IS NOT NULL
        GROUP BY json_extract(metadata_json, '$.userId')
        HAVING COUNT(*) >= ?
        ORDER BY COUNT(*) DESC
    `).all(participantProfileConfig.threshold || 8);

    for (const row of rows) {
        const participantId = String(row.participant_id || '').trim();
        if (!participantId || isParticipantProfileBlacklisted(participantProfileConfig, participantId)) {
            continue;
        }
        if (sessionManager.getParticipantProfile(namespaceOptions, participantId)) {
            continue;
        }

        const latestIdentity = sessionManager.getLatestParticipantIdentity?.(participantId) || null;
        const participantName = latestIdentity?.participantName || participantId;
        const speakerIdentity = {
            participantId,
            participantName,
            messageType: 'group',
            groupId: latestIdentity?.groupId || String(row.group_id || '') || null
        };

        try {
            await maybeBuildParticipantProfile(sessionManager, aiClient, namespaceOptions, speakerIdentity, logger, {
                force: true,
                triggeredBy: 'backfill'
            });
        } catch (error) {
            logger.warn(`[画像] 启动补建失败: ${participantId} ${error.message}`);
        }
    }
}

async function handleParticipantProfileManualCommand(event, plainText) {
    const participantProfileConfig = getParticipantProfileConfig(config);
    const commandConfig = config.chat?.commands?.participantProfileManual || {};
    const commandEnabled = commandConfig.enabled !== false;
    const manualCommand = (commandConfig.command || participantProfileConfig.manualCommand || '').trim();
    if (!isParticipantProfileManualCommand(plainText, manualCommand)) {
        return false;
    }

    if (!commandEnabled) {
        return false;
    }

    sendEmojiReactionForEvent(event);

    if (!isAdminUser(config, event.user_id)) {
        await sendFailureMessage(event, '只有管理员可以手动分析人物档案');
        return true;
    }

    const mentionedParticipant = extractMentionedParticipant(event);
    if (!mentionedParticipant?.participantId) {
        await sendFailureMessage(event, `请使用 ${manualCommand} @某人 来手动分析人物档案`);
        return true;
    }

    const speakerIdentity = buildSpeakerIdentity(event, mentionedParticipant);
    if (!speakerIdentity?.participantId) {
        await sendFailureMessage(event, '当前消息缺少可识别的用户身份，无法手动分析人物档案');
        return true;
    }

    if (!participantProfileConfig.enabled) {
        await sendFailureMessage(event, '人物档案功能未启用，无法手动分析');
        return true;
    }

    if (isParticipantProfileBlacklisted(participantProfileConfig, speakerIdentity.participantId)) {
        await sendFailureMessage(event, `QQ ${speakerIdentity.participantId} 已在人物档案黑名单中，无法手动分析`);
        return true;
    }

    const memoryScope = buildMemoryScope(config, {
        ...event,
        user_id: speakerIdentity.participantId
    });
    const recallNamespace = buildRecallNamespace(config, memoryScope, config.chat.defaultCharacter);

    try {
        await sendQuotedStatusMessage(
            event,
            `正在分析${speakerIdentity.participantName || `QQ ${speakerIdentity.participantId}`}的人物档案，请稍等`
        );

        const profile = await maybeBuildParticipantProfile(
            sessionManager,
            aiClient,
            recallNamespace,
            speakerIdentity,
            logger,
            {
                force: true,
                triggeredBy: 'admin_command'
            }
        );

        if (!profile) {
            throw new Error('未能生成人物档案');
        }

        const savedProfile = sessionManager.saveParticipantProfile(profile.id, {
            title: profile.title,
            content: profile.content,
            tags: profile.tags,
            metadata: {
                ...profile.metadata,
                updatedBy: `admin:${event.user_id}`,
                editedBy: `admin:${event.user_id}`
            }
        }) || profile;

        const summary = (savedProfile.content || '').split('\n').map((line) => line.trim()).filter(Boolean)[0] || '已完成人物档案分析';
        await dispatchReply(event, `已手动分析人物档案：${savedProfile.participantName || savedProfile.title || speakerIdentity.participantName}\n${summary}`);
    } catch (error) {
        logger.warn(`[画像] 管理员手动分析失败: ${speakerIdentity.participantId} ${error.message}`);
        await sendFailureMessage(event, `手动分析人物档案失败: ${error.message}`);
    }

    return true;
}

async function handleAdminMentionCommand(event, plainText) {
    const commandConfig = config.chat?.commands?.adminMention || {};
    const mentionCommand = (commandConfig.command || '/at').trim();
    if (!isCommandInvocation(plainText, mentionCommand)) {
        return false;
    }

    if (commandConfig.enabled === false) {
        return false;
    }

    sendEmojiReactionForEvent(event);

    if (!isAdminUser(config, event.user_id)) {
        await sendFailureMessage(event, '只有管理员可以使用主动 @ 指令');
        return true;
    }

    if (event.message_type !== 'group' || !event.group_id) {
        await sendFailureMessage(event, '主动 @ 仅支持群聊使用');
        return true;
    }

    const segments = Array.isArray(event.message) ? event.message : [];
    const hasAtAll = segments.some((segment) => segment?.type === 'at' && String(segment.data?.qq) === 'all');
    if (hasAtAll) {
        await sendFailureMessage(event, '不支持向 @全体成员 主动发送消息');
        return true;
    }

    const mentionedParticipants = extractMentionedParticipants(event);
    if (mentionedParticipants.length === 0) {
        await sendFailureMessage(event, `请使用 ${mentionCommand} @某人 让 AI 生成的内容要求`);
        return true;
    }

    const promptText = extractTextAfterMentionCommand(event, mentionCommand, mentionedParticipants[0].participantId);
    if (!promptText) {
        await sendFailureMessage(event, `请在 ${mentionCommand} @某人 后填写让 AI 生成的内容要求`);
        return true;
    }

    try {
        for (const mentionedParticipant of mentionedParticipants) {
            const messageText = await generateAdminMentionReply(event, mentionedParticipant, promptText);
            if (!messageText) {
                throw new Error('AI 未生成可发送内容');
            }

            await bot.sendGroupMessage(event.group_id, buildMentionMessage(mentionedParticipant.participantId, messageText));
        }
    } catch (error) {
        logger.warn(`[主动@] 管理员触发主动 @ 失败: ${mentionedParticipants.map((item) => item.participantId).join(',')} ${error.message}`);
        await sendFailureMessage(event, `主动 @ 生成失败: ${error.message}`);
    }
    return true;
}

async function handleAdminPokeCommand(event, plainText) {
    const commandConfig = config.chat?.commands?.adminPoke || {};
    const result = await executeAdminPokeCommand({
        event,
        plainText,
        command: commandConfig.command || '/戳一戳',
        enabled: commandConfig.enabled !== false,
        repeatCount: commandConfig.repeatCount ?? 5,
        isAdmin: isAdminUser(config, event.user_id),
        bot,
        onCommandAccepted: () => sendEmojiReactionForEvent(event),
        sendFailureMessage: (message) => sendFailureMessage(event, message),
        sendStatusMessage: (message) => sendQuotedStatusMessage(event, message),
        logger
    });

    return result.handled === true;
}

async function processBatch(batch) {
    const responseItem = [...batch.items].reverse().find((item) => item.routingDecision?.shouldRespond) || null;
    const primary = responseItem || batch.items[batch.items.length - 1];
    const event = primary.event;
    const sessionId = batch.sessionKey;
    const shouldRunLlm = Boolean(responseItem);
    const hasGroupRepeatObservable = batch.items.some((item) => shouldObserveGroupRepeatMessage({
        config,
        event: item?.event || {},
        text: item?.plainText || '',
        routingDecision: item?.routingDecision || {},
        botSelfId: bot.selfId,
        item,
        messageSegments: item?.messageSegments || []
    }));
    lastProcessedBatchAt = Date.now();
    const mergedPlainText = batch.items
        .map((item) => item.plainText)
        .filter(Boolean)
        .join('\n')
        .trim();

    if (!mergedPlainText) {
        return;
    }

    const mergedStructuredText = batch.items
        .map((item) => item.structuredText)
        .filter(Boolean)
        .join('\n')
        .trim();

    await sessionManager.withSessionLock(sessionId, async () => {
        logger.info(`收到消息 [${sessionId}]: ${mergedPlainText.substring(0, 100)}...`);
        logger.debug(`完整消息内容: ${mergedStructuredText}`);

        let runtimeContext = null;
        let thinkingTimer = null;
        const userMessagePreview = buildThinkingPreview(primary.plainText || primary.event?.raw_message || '');
        try {
            const currentCharacterName = config.chat.defaultCharacter;
            const effectiveBinding = getEffectiveBinding(config, currentCharacterName);
            sessionManager.setConfig(config, { storagePath: effectiveBinding.memoryDbPath || config.memory?.storage?.path });
            promptBuilder.updateConfig(config, effectiveBinding.preset);
            regexProcessor.updateConfig(config.regex || {}, effectiveBinding.regexRules, effectiveBinding.presetRegexRules, effectiveBinding.globalRegexRules);
            if (effectiveBinding.worldbook) {
                try {
                    await worldBookManager.loadWorldBook(effectiveBinding.worldbook);
                } catch (error) {
                    logger.warn(`加载绑定世界书失败: ${error.message}`);
                }
            }

            const summaryAIOverrides = buildAIOverridesFromProviderSelection(config, {
                providerId: config.memory?.summary?.modelProviderId || '',
                model: config.memory?.summary?.model || ''
            });
            const summaryModel = summaryAIOverrides.model || null;
            if (shouldRunLlm && !hasGroupRepeatObservable) {
                await sessionManager.maybeSummarizeSession(sessionId, async (messages, lockedSessionId) => {
                    logger.info(`[摘要] 开始生成 (${messages.length}条消息) 模型:${summaryModel||'默认'}`);
                    const result = await aiClient.summarize(messages, lockedSessionId, summaryAIOverrides);
                    logger.info(`[摘要] 完成 (${result?.length||0}字)`);
                    return result;
                });
            }

            const context = sessionManager.getContext(sessionId, config.chat.historyLimit || 30);
            const stickyKeys = sessionManager.getStickyEntryKeys(sessionId);
            const adminUser = isAdminUser(config, event.user_id);
            let processedInput = regexProcessor.processInput(mergedStructuredText);
            const injectionRisk = detectPromptInjectionRisk(processedInput, {
                sourceType: adminUser ? 'admin_user_message' : 'user_message',
                trusted: adminUser
            });
            if (shouldRunLlm && injectionRisk.level === 'high') {
                logger.warn(`[安全] 高风险注入已拦截 [${sessionId}] 规则:${injectionRisk.matchedRules.join(',')} 分数:${injectionRisk.score}`, { userId: event.user_id, groupId: event.group_id, preview: processedInput.slice(0, 80) });
                await dispatchReply(event, '⚠️ 检测到提示注入攻击，已拦截。');
                return;
            }
            if (shouldRunLlm && injectionRisk.level !== 'none') {
                logger.warn(`[安全] 疑似注入 (${injectionRisk.level}) [${sessionId}] 规则:${injectionRisk.matchedRules.join(',')}`, injectionRisk);
            }
            runtimeContext = {
                sessionId,
                memoryScope: batch.memoryScope,
                recallNamespace: buildRecallNamespace(config, batch.memoryScope, currentCharacterName),
                messageType: event.message_type,
                messageCount: batch.items.length,
                participants: buildParticipants(batch.items),
                standardEvents: batch.items.map((item) => item.standardEvent).filter(Boolean),
                primaryStandardEvent: primary.standardEvent || null,
                triggerReason: primary.triggerReason,
                routingDecisions: batch.items.map((item) => item.routingDecision).filter(Boolean),
                replyReference: buildReplyReference(batch.items),
                injectionRisk
            };
            runtimeContext.currentSpeaker = buildSpeakerIdentity(event);
            runtimeContext.currentSpeakerProfile = runtimeContext.currentSpeaker
                ? sessionManager.getParticipantProfile(runtimeContext.recallNamespace, runtimeContext.currentSpeaker.participantId)
                : null;
            runtimeContext.recalledEntries = sessionManager.recallMemory(runtimeContext.recallNamespace, processedInput, {
                currentParticipantId: runtimeContext.currentSpeaker?.participantId || null,
                recentLimit: 3,
                searchLimit: 3,
                summaryLimit: 2,
                limit: 5
            });
            lastRecallSnapshot = {
                at: Date.now(),
                namespace: runtimeContext.recallNamespace,
                query: processedInput.slice(0, 160),
                hits: runtimeContext.recalledEntries.map((entry) => ({
                    id: entry.id,
                    title: entry.title || '',
                    sourceKind: entry.sourceKind,
                    recallReason: entry.recallReason,
                    recallScore: entry.recallScore,
                    preview: entry.content.slice(0, 160)
                }))
            };
            lastInjectionObservation = buildObservationEnvelope({
                trusted_context: {
                    sessionMode: config.chat?.sessionMode,
                    accessControlMode: config.chat?.accessControlMode,
                    character: currentCharacterName,
                    trustedSources: ['character_card', 'worldbook', 'preset', 'database_recall', 'system_summary'],
                    adminUsers: config.chat?.adminUsers || []
                },
                runtime_stats: {
                    sessionId,
                    messageType: event.message_type,
                    triggerReason: primary.triggerReason
                },
                untrusted_user_inputs: [{
                    type: 'user_message',
                    trusted: false,
                    content: processedInput,
                    risk: injectionRisk
                }].filter(() => !adminUser),
                trusted_admin_inputs: [{
                    type: 'admin_user_message',
                    trusted: true,
                    content: processedInput,
                    risk: injectionRisk
                }].filter(() => adminUser),
                system_generated_memory: runtimeContext.recalledEntries.map((entry) => ({
                    trusted: true,
                    type: entry.sourceKind,
                    title: entry.title || '',
                    content: entry.content,
                    reason: entry.recallReason
                }))
            });
            rememberObservationEvent(buildObservationEvent({
                observation: lastInjectionObservation,
                adminUser
            }));

            const userRecord = sessionManager.addMessage(sessionId, 'user', processedInput, {
                messageType: event.message_type,
                userId: event.user_id,
                groupId: event.group_id,
                participantName: runtimeContext.currentSpeaker?.participantName || event.sender?.card || event.sender?.nickname || '',
                mergedCount: batch.items.length,
                triggerReason: primary.triggerReason,
                replyToMessageId: primary.replyToMessageId || null,
                participants: runtimeContext.participants,
                standardEvents: runtimeContext.standardEvents,
                inboundMessageIds: batch.items
                    .map((item) => item.event?.message_id)
                    .filter(Boolean)
            });
            sessionManager.upsertConversationMemory(runtimeContext.recallNamespace, {
                userMessage: processedInput,
                sourceSessionId: sessionId,
                sourceMessageId: userRecord.id
            });

            const groupRepeatResult = groupRepeatDetector.observeBatch({
                config,
                items: batch.items,
                botSelfId: bot.selfId
            });
            if (groupRepeatResult.shouldRepeat) {
                const groupRepeatEvent = groupRepeatResult.event || event;
                logger.info('[复读] 命中群聊复读直发', {
                    sessionId,
                    groupId: groupRepeatResult.groupId,
                    repeatText: groupRepeatResult.repeatText,
                    count: groupRepeatResult.count,
                    triggerCount: groupRepeatResult.triggerCount
                });
                sessionManager.addMessage(sessionId, 'assistant', groupRepeatResult.repeatText, {
                    replyTo: groupRepeatEvent.user_id,
                    messageType: groupRepeatEvent.message_type,
                    groupId: groupRepeatEvent.group_id,
                    generatedBy: 'group_repeat'
                });
                sessionManager.upsertConversationMemory(runtimeContext.recallNamespace, {
                    userMessage: processedInput,
                    assistantMessage: groupRepeatResult.repeatText,
                    sourceSessionId: sessionId,
                    sourceMessageId: userRecord.id
                });
                await bot.sendGroupMessage(groupRepeatEvent.group_id, groupRepeatResult.repeatText);
                logger.info('[复读] 群聊复读已直发，跳过 LLM', {
                    sessionId,
                    groupId: groupRepeatResult.groupId
                });
                return;
            }

            if (!shouldRunLlm) {
                logger.debug('[复读] 群聊消息已入库但未触发复读，跳过 LLM', {
                    sessionId,
                    itemCount: batch.items.length
                });
                return;
            }

            const summaryBeforeReply = await sessionManager.maybeSummarizeSession(sessionId, async (messages, lockedSessionId) => {
                return aiClient.summarize(messages, lockedSessionId, summaryAIOverrides);
            });
            if (summaryBeforeReply) {
                sessionManager.upsertSummaryIndexFromSummary(runtimeContext.recallNamespace, summaryBeforeReply, sessionId);
            }
            const currentContext = sessionManager.getContext(sessionId, config.chat.historyLimit || 30);
            currentContext.recentMessages = currentContext.recentMessages.filter((message) => {
                return message.metadata?.id !== userRecord.id;
            });

            const { messages, worldBookCount, worldBookEntries } = await promptBuilder.build(
                config.chat.defaultCharacter,
                processedInput,
                currentContext,
                stickyKeys,
                runtimeContext
            );

            // 变量桥接：静态 setvar 初始化 + 解析宏 + 注入当前变量状态到 prompt
            try {
                const { applyStaticSetvarsFromText, buildVariableStatusBlock, resolveVariableMacros } = await import('./variable-bridge.js');
                const ns = runtimeContext?.recallNamespace;
                if (ns) {
                    // 变量按人隔离（userId），不按群隔离
                    const varScopeKey = event.user_id ? `user:${event.user_id}` : ns.scopeKey;
                    const scopeOpts = {
                        scopeType: 'user_persistent', scopeKey: varScopeKey,
                        characterName: ns.characterName, presetName: ns.presetName
                    };
                    // 第一步：执行静态 setvar，把初始化值写入变量存储
                    for (const msg of messages) {
                        if (typeof msg.content === 'string') {
                            const r = applyStaticSetvarsFromText(msg.content, sessionManager, scopeOpts, { keepMacros: false });
                            msg.content = r.cleanedText;
                        }
                    }
                    // 1.5步：新用户变量初始化 —— 如 scope 下只有系统变量，从角色卡 variable_defaults 初始化
                    try {
                        const allVars = sessionManager.listVariables({ scopeKey: varScopeKey, characterName: ns.characterName });
                        const hasUserVars = allVars.some(v => !(v.tags || []).includes('system'));
                        if (!hasUserVars) {
                            const char = characterManager.readFromPng(ns.characterName);
                            const overrides = characterManager.readOverrides?.(ns.characterName) || {};
                            const defaults = char?.variable_defaults || overrides?.variable_defaults;
                            if (defaults && typeof defaults === 'object') {
                                for (const [k, v] of Object.entries(defaults)) {
                                    sessionManager.upsertVariable(scopeOpts, {
                                        key: k, rawValue: String(v ?? ''),
                                        valueType: typeof v === 'number' ? 'number' : 'string',
                                        source: 'auto-init'
                                    });
                                }
                                logger.info('[变量] 新用户初始化', { scopeKey: varScopeKey, count: Object.keys(defaults).length });
                            }
                        }
                    } catch {}

                    // 第二步：解析所有消息中的 {{get_message_variable::}} / {{getvar::}} 宏
                    for (const msg of messages) {
                        if (typeof msg.content === 'string') {
                            msg.content = resolveVariableMacros(msg.content, sessionManager, scopeOpts);
                        }
                    }
                    // 注入 <status_current_variable> 状态块
                    const statusBlock = buildVariableStatusBlock(sessionManager, scopeOpts);
                    if (statusBlock) {
                        const firstSysIdx = messages.findIndex(m => m.role === 'system');
                        if (firstSysIdx >= 0) {
                            messages[firstSysIdx].content += '\n' + statusBlock;
                        } else {
                            messages.unshift({ role: 'system', content: statusBlock });
                        }
                    }
                }
            } catch (e) { logger.warn('[变量] 宏解析失败:', e.message); }

            logger.info('[执行] Prompt 构建完成', {
                sessionId,
                messageCount: messages.length,
                messageTrace: messages.map((message, index) => ({
                    index,
                    role: message.role,
                    contentLength: typeof message.content === 'string' ? message.content.length : 0,
                    contentPreview: typeof message.content === 'string' ? message.content.slice(0, 120) : null,
                    source: message.meta?.source || null,
                    sourceId: message.meta?.sourceId || null
                }))
            });

            const keywordTriggered = worldBookEntries.filter((entry) => entry.triggeredByKeyword).length;
            const stickyTriggered = worldBookEntries.filter((entry) => entry.triggeredBySticky).length;
            logger.info(`世界书匹配: ${worldBookCount} 条 (关键词: ${keywordTriggered}, 粘性: ${stickyTriggered})`);

            const timeoutMs = config.ai.timeout || 60000;
            const toolContext = buildAIToolContext({
                config,
                aiClient,
                bot,
                logger,
                defaultGroupId: event.group_id,
                defaultTargetUserId: runtimeContext.currentSpeaker?.participantId || null,
                defaultTargetName: runtimeContext.currentSpeaker?.participantName || null,
                mentionGenerator: ({ groupId, targetUserId, targetName, promptText }) => {
                    return generateContextualMentionReply({
                        event: {
                            ...event,
                            group_id: groupId || event.group_id
                        },
                        targetUserId,
                        targetName,
                        promptText,
                        currentSpeakerOverride: runtimeContext.currentSpeaker,
                        sendMessage: true
                    });
                }
            });
            if (Array.isArray(toolContext.toolHints) && toolContext.toolHints.length > 0) {
                messages.unshift({
                    role: 'system',
                    content: `【工具使用说明】\n${toolContext.toolHints.join('\n\n')}`,
                    meta: { source: 'tool_hints' }
                });
            }
            if (toolContext.isRealtimeQuery?.(processedInput)) {
                const grounding = await buildRealtimeGroundingMessage({
                    config,
                    query: processedInput,
                    logger
                });
                if (grounding?.message) {
                    messages.unshift({
                        role: 'system',
                        content: grounding.message,
                        meta: {
                            source: 'realtime_grounding',
                            provider: grounding.provider,
                            resultCount: grounding.resultCount || 0,
                            searchSource: grounding.source || ''
                        }
                    });
                } else {
                    messages.unshift({
                        role: 'system',
                        content: toolContext.buildRealtimeSearchPrompt?.(processedInput) || `这条问题需要先联网检索再回答：${processedInput}`,
                        meta: { source: 'realtime_tool_hints' }
                    });
                }
            }
            const chatAIOverrides = buildChatAIOverrides(config);
            const chatAISelection = getChatAISelectionSnapshot(config);
            logger.info('[执行] 准备调用 AI', {
                sessionId,
                timeoutMs,
                requestedProviderId: chatAISelection.providerId,
                requestedModel: chatAISelection.model,
                hasProviderOverride: chatAISelection.hasProviderOverride,
                messageCount: messages.length,
                lastMessageRole: messages.at(-1)?.role || null,
                lastMessageSource: messages.at(-1)?.meta?.source || null,
                toolsEnabled: toolContext.tools.map((tool) => tool?.function?.name).filter(Boolean)
            });
            recordDashboardMetric('chat');

            const emptyReplyRetryConfig = config.chat?.emptyReplyRetry || {};
            const chainLeakRetryConfig = config.chat?.chainLeakRetry || {};
            const thinkingPreview = userMessagePreview;

            // 思考中提示：超过指定秒数还没回复就先发一条提示
            const thinkingNotifyConfig = config.chat?.thinkingNotify || {};
            const thinkingEnabled = thinkingNotifyConfig.enabled !== false;
            const thinkingDelaySec = thinkingNotifyConfig.delaySec ?? 60;
            let thinkingNotified = false;
            if (thinkingEnabled && thinkingDelaySec > 0) {
                thinkingTimer = setTimeout(async () => {
                    thinkingNotified = true;
                    const msg = thinkingNotifyConfig.message
                        || `已思考${thinkingDelaySec}s`;
                    try {
                        await sendQuotedStatusMessage(event, msg);
                    } catch {}
                }, thinkingDelaySec * 1000);
            }

            const { replyResult, reply } = await generateReplyWithRetry({
                aiClient,
                messages,
                toolContext,
                chatAIOverrides,
                timeoutMs,
                logger,
                sessionId,
                retryConfig: emptyReplyRetryConfig,
                chainLeakRetryConfig,
                userInput: processedInput
            });
            if (thinkingTimer) clearTimeout(thinkingTimer);
            logger.info('[执行] AI 调用完成', {
                sessionId,
                replyLength: reply.length,
                replyPreview: reply.slice(0, 200),
                reasoningLength: typeof replyResult?.reasoningContent === 'string' ? replyResult.reasoningContent.length : 0
            });
            const { extractTaggedContent, extractVisibleContent } = await import('./variable-bridge.js');
            const reasoningContent = (
                extractTaggedContent(reply, 'thinking')
                || (typeof replyResult?.reasoningContent === 'string' ? replyResult.reasoningContent.trim() : '')
            );
            const visibleReply = extractVisibleContent(reply);
            let processedReply = regexProcessor.processOutput(visibleReply);
            // 清洗 ST 卡常见内部标签（draft_notes / thinking / cot 等）
            try {
                const { stripInternalTags } = await import('./variable-bridge.js');
                const beforeLen = processedReply.length;
                processedReply = stripInternalTags(processedReply);
                if (processedReply.length !== beforeLen) {
                    logger.info(`[清洗] 标签剥离: ${beforeLen}→${processedReply.length} 字`);
                }
            } catch (e) { logger.warn('[变量] 标签清洗失败:', e.message); }
            // 变量桥接：提取 <UpdateVariable> 块并写入变量存储
            try {
                const { extractAndApplyVariables } = await import('./variable-bridge.js');
                const ns = runtimeContext?.recallNamespace;
                if (ns) {
                    const varScopeKey = event.user_id ? `user:${event.user_id}` : ns.scopeKey;
                    const scopeOpts = {
                        scopeType: 'user_persistent', scopeKey: varScopeKey,
                        characterName: ns.characterName, presetName: ns.presetName
                    };
                    const result = extractAndApplyVariables(processedReply, sessionManager, scopeOpts);
                    processedReply = result.cleanedOutput;
                    if (result.applied.length > 0) {
                        logger.info('[变量] 已应用', { count: result.applied.length, patches: result.applied });
                    }

                    // 额外模型解析：主回复未含 UpdateVariable 时，异步调 AI 提取变量
                    if (result.applied.length === 0 && config.ai?.variableParsing?.enabled !== false) {
                        setImmediate(async () => {
                            try {
                                const vpModel = config.chat?.varparseModel || config.ai?.variableParsing?.model || config.ai.model;
                                const vpProviderId = config.chat?.varparseModelProviderId || config.ai?.variableParsing?.providerId || config.ai.activeProviderId;
                                if (!config.chat?.varparseModel && !config.ai?.variableParsing?.model) { return; } // 未配置变量解析模型则跳过
                                const vpOverrides = buildAIOverridesFromProviderSelection(config, {
                                    providerId: vpProviderId,
                                    model: vpModel
                                });

                                let varStatus = '';
                                try {
                                    const { buildVariableStatusBlock } = await import('./variable-bridge.js');
                                    varStatus = buildVariableStatusBlock(sessionManager, scopeOpts) || '';
                                } catch {}

                                const varParsePrompt = `你是变量更新解析器。根据对话分析变量变化，输出 JSON Patch。

当前变量：
${varStatus || '(无)'}

用户：${processedInput}
角色：${processedReply}

请输出变量更新（无变化输出空数组）：
<UpdateVariable>
[{"op":"replace","path":"/变量名","value":新值}]
</UpdateVariable>`;

                                const vpMessages = [{ role: 'user', content: varParsePrompt }];
                                const vpResult = await aiClient.chat(vpMessages, {
                                    temperature: 0.1, maxTokens: 1024,
                                    ...vpOverrides
                                });
                                const vpReply = aiClient.getVisibleResponseContent(vpResult);
                                if (vpReply && vpReply.includes('<UpdateVariable>')) {
                                    const vpExtract = extractAndApplyVariables(vpReply, sessionManager, scopeOpts);
                                    if (vpExtract.applied.length > 0) {
                                        logger.info('[变量-额外解析] 已应用', { count: vpExtract.applied.length, patches: vpExtract.applied });
                                    }
                                }
                            } catch (e) { logger.warn('[变量-额外解析] 失败:', e.message); }
                        });
                    }
                }
            } catch (e) { logger.warn('[变量] 提取失败:', e.message); }
            const sendReasoningToQQ = config.chat?.sendReasoningToQQ === true;
            const replyToSend = sendReasoningToQQ && reasoningContent
                ? buildDebugReplyWithReasoning(reasoningContent, processedReply)
                : processedReply;
            logger.info('[执行] 输出后处理完成', {
                sessionId,
                processedReplyLength: typeof processedReply === 'string' ? processedReply.length : 0,
                processedReplyPreview: typeof processedReply === 'string' ? processedReply.slice(0, 200) : null,
                sendReplyLength: typeof replyToSend === 'string' ? replyToSend.length : 0,
                reasoningAvailable: !!reasoningContent,
                sendReplyIncludesReasoning: sendReasoningToQQ && !!reasoningContent
            });

            sessionManager.addMessage(sessionId, 'assistant', processedReply, {
                replyTo: event.user_id,
                messageType: event.message_type
            });
            logger.info('[执行] assistant 回复已写入会话', {
                sessionId,
                replyLength: processedReply.length
            });
            sessionManager.upsertConversationMemory(runtimeContext.recallNamespace, {
                userMessage: processedInput,
                assistantMessage: processedReply,
                sourceSessionId: sessionId,
                sourceMessageId: userRecord.id
            });
            logger.info('[执行] 对话记忆已更新', {
                sessionId,
                recallNamespace: runtimeContext.recallNamespace
            });
            sessionManager.updateStickyEntries(sessionId, worldBookEntries);

            logger.info(`回复 [${sessionId}]: ${processedReply.substring(0, 80)}...`);
            logger.info('[执行] 准备下发回复', {
                sessionId,
                messageType: event.message_type,
                splitMessage: sendReasoningToQQ && reasoningContent ? false : config.chat.splitMessage !== false,
                includeReasoningContent: sendReasoningToQQ && !!reasoningContent
            });
            await dispatchReply(event, replyToSend, { forceSingleMessage: sendReasoningToQQ && !!reasoningContent });
            logger.info('[执行] 回复下发完成', {
                sessionId
            });

            if (runtimeContext.currentSpeaker) {
                scheduleParticipantProfileUpdate(
                    sessionManager,
                    aiClient,
                    runtimeContext.recallNamespace,
                    runtimeContext.currentSpeaker,
                    logger
                );
            }
        } catch (error) {
            if (thinkingTimer) {
                clearTimeout(thinkingTimer);
                thinkingTimer = null;
            }
            if (runtimeContext?.currentSpeaker) {
                scheduleParticipantProfileUpdate(
                    sessionManager,
                    aiClient,
                    runtimeContext.recallNamespace,
                    runtimeContext.currentSpeaker,
                    logger
                );
            }
            const failMessage = buildAIServiceFailureMessage(error, config);

            if (error.message === 'AI API 返回了空消息内容' && error.diagnostic) {
                logger.error(`[AI诊断] 会话 ${sessionId} 收到空回复`, error.diagnostic);
            }

            logger.error(`处理会话 ${sessionId} 失败: ${error.message}`);
            await sendQuotedStatusMessage(event, failMessage);
        }
    });
}

const runtime = new MessageRuntime(config, logger, processBatch);

const managers = {
    characterManager,
    worldBookManager,
    sessionManager,
    regexProcessor,
    aiClient,
    promptBuilder,
    logger,
    bot,
    ttsManager,
    VOICE_TYPES,
    runtime,
    getLastRoutingSnapshot,
    formatSessionLabel,
    getLastInjectionObservation,
    getRecentInjectionObservations,
    getLastRecallSnapshot,
    clearParticipantProfileTimers,
    analyzeParticipantProfile: analyzeParticipantProfileEntry,
    updateKnowledgeImportProgress,
    getParticipantProfileProgress: getParticipantProfileProgressSnapshot,
    getKnowledgeImportProgress: getKnowledgeImportProgressSnapshot,
    recordDashboardMetric,
    getDashboardMetricsSnapshot: () => ({
        ...getDashboardMetricsSnapshot(),
        composition: sessionManager.getDashboardCompositionStats()
    }),
    getLlmEnabled: () => llmEnabled,
    setLlmEnabled
};
setupRoutes(app, config, saveConfig, managers);

app.use('/api', (error, req, res, next) => {
    logger.error(`[API ${req?.requestId || 'no-id'}] 未捕获错误`, {
        method: req?.method,
        url: req?.originalUrl,
        message: error?.message || String(error),
        stack: error?.stack || null
    });
    if (res.headersSent) {
        return next(error);
    }

    res.status(error?.status || 500).json({
        success: false,
        error: error?.message || '服务器内部错误',
        needLogin: error?.needLogin === true
    });
});

const wss = new WebSocketServer({ server, path: '/ws/logs' });
wss.on('connection', (ws) => {
    logger.info('Web 面板已连接');
    logger.addListener((log) => {
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(log));
        }
    });
});

async function handlePokeEvent(event) {
    const selfId = String(bot.selfId || '');
    const targetId = String(event.target_id || '');
    const userId = String(event.user_id || '');
    const groupId = event.group_id;
    const recordPokeRouting = (patch = {}) => {
        lastRoutingSnapshot = {
            at: Date.now(),
            sessionKey: groupId ? `group:${groupId}` : '',
            sessionLabel: groupId ? `群 ${groupId}` : '戳一戳事件',
            scopeType: null,
            scopeLabel: '',
            messageType: 'group',
            userId,
            groupId: groupId || null,
            targetId,
            eventType: 'poke',
            triggerReason: patch.triggerReason || '',
            skipReason: patch.skipReason || '',
            shouldRespond: patch.shouldRespond === true,
            routingDecision: patch.routingDecision || null,
            dbPath: sessionManager.getDbPath()
        };
        if (patch.skipReason) {
            logger.debug('[路由] 戳一戳未触发回复', lastRoutingSnapshot);
        }
    };

    if (config.chat?.pokeReaction === false) {
        recordPokeRouting({ skipReason: 'poke_reaction_disabled' });
        return;
    }

    // 只响应戳机器人的事件
    if (targetId !== selfId) {
        recordPokeRouting({ skipReason: 'poke_target_not_bot' });
        return;
    }

    // 冷却：15秒内不重复响应
    const now = Date.now();
    if (_lastPokeResponse && (now - _lastPokeResponse) < 15000) {
        recordPokeRouting({ skipReason: 'poke_cooldown' });
        return;
    }
    _lastPokeResponse = now;

    try {
        // 将戳一戳注入为对话消息，让角色自然感知
        const defaultCharacter = config.chat?.defaultCharacter || '';
        if (!defaultCharacter) {
            recordPokeRouting({ skipReason: 'poke_missing_default_character' });
            return;
        }
        if (!groupId) {
            recordPokeRouting({ skipReason: 'poke_missing_group_id' });
            return;
        }
        const senderName = event.sender?.nickname || event.sender?.card || '群友';
        const groupName = event.group_name || groupId;
        const pokeEvent = {
            ...event,
            post_type: 'notice',
            message_type: 'group',
            group_id: groupId,
            group_name: groupName,
            user_id: userId,
            sender: event.sender || { nickname: senderName }
        };
        const pokeSegments = [{ type: 'poke', targetId, userId }];
        const routingDecision = {
            shouldRespond: true,
            triggerReason: 'poke',
            skipReason: '',
            checks: {
                targetIsBot: targetId === selfId,
                pokeReactionEnabled: config.chat?.pokeReaction !== false,
                cooldownPassed: true,
                hasDefaultCharacter: Boolean(defaultCharacter),
                hasGroupId: Boolean(groupId)
            }
        };
        const standardEvent = buildStandardEvent({
            event: pokeEvent,
            contentText: '（戳了戳你）',
            rawText: '（戳了戳你）',
            eventType: 'poke',
            isAtBot: false,
            replyToMessageId: null,
            replyInfo: { toBot: false },
            messageSegments: pokeSegments,
            botSelfId: bot.selfId,
            routingDecision
        });
        const pokeText = buildStructuredMessage(pokeEvent, '（戳了戳你）', {
            eventType: 'poke',
            isAtBot: false,
            replyToBot: false,
            messageSegments: pokeSegments
        });
        const memoryScope = buildMemoryScope(config, pokeEvent);
        const enqueued = runtime.enqueue({
            sessionKey: memoryScope.sessionKey,
            memoryScope,
            dedupeKey: `poke:${groupId}:${userId}:${now}`,
            event: pokeEvent,
            plainText: '（戳了戳你）',
            structuredText: pokeText,
            isAtMe: true,
            replyToMessageId: null,
            replyToBot: false,
            replyInfo: null,
            messageSegments: pokeSegments,
            standardEvent,
            triggerReason: 'poke',
            routingDecision
        });
        recordPokeRouting({
            shouldRespond: enqueued,
            triggerReason: enqueued ? 'poke' : '',
            skipReason: enqueued ? '' : 'poke_duplicate',
            routingDecision
        });
    } catch (error) {
        recordPokeRouting({ skipReason: 'poke_error' });
        logger.warn(`[路由] 戳一戳处理失败: ${error.message}`);
    }
}
let _lastPokeResponse = null;

async function handleMessage(event) {
    if (!event || event.post_type !== 'message') {
        return;
    }
    const eventSelfId = event.self_id || bot.selfId;
    if (eventSelfId && String(event.user_id) === String(eventSelfId)) {
        return;
    }

    const messageInfo = await extractMessageInfo(config, event, bot);
    const { plainText, isAtMe, structuredText, replyToMessageId, replyToBot, replyInfo, messageSegments, standardEvent } = messageInfo;

    // /llm 指令：管理员切换 LLM 开关
    if (plainText.trim() === '/llm' && isAdminUser(config, event.user_id)) {
        const newState = setLlmEnabled(!llmEnabled);
        const statusText = newState ? '✅ LLM 已开启' : '⛔ LLM 已关闭';
        logger.info(`[指令] 管理员 ${event.user_id} 切换 LLM 状态: ${newState}`);
        sendEmojiReactionForEvent(event);
        if (event.message_type === 'group') {
            await bot.sendGroupMessage(event.group_id, statusText);
        } else {
            await bot.sendPrivateMessage(event.user_id, statusText);
        }
        return;
    }

    // LLM 关闭时不处理任何消息
    if (!llmEnabled) {
        return;
    }

    if (await handleParticipantProfileManualCommand(event, plainText)) {
        return;
    }
    if (await handleAdminPokeCommand(event, plainText)) {
        return;
    }
    if (await handleAdminMentionCommand(event, plainText)) {
        return;
    }
    const routingDecision = buildRoutingDecision(config, event, plainText, isAtMe, messageInfo);
    if (standardEvent) {
        updateStandardEventRouting(standardEvent, routingDecision);
    }
    const groupRepeatWatch = shouldObserveGroupRepeatMessage({
        config,
        event,
        text: plainText,
        routingDecision,
        botSelfId: bot.selfId
    });
    if (!routingDecision.shouldRespond && !groupRepeatWatch) {
        lastRoutingSnapshot = {
            at: Date.now(),
            sessionKey: event.message_type === 'group' ? `group:${event.group_id || ''}` : `private:${event.user_id || ''}`,
            sessionLabel: event.message_type === 'group' ? `群 ${event.group_id || ''}` : `私聊 ${event.user_id || ''}`,
            scopeType: null,
            scopeLabel: '',
            messageType: event.message_type,
            userId: event.user_id,
            groupId: event.group_id || null,
            triggerReason: '',
            skipReason: routingDecision.skipReason,
            shouldRespond: false,
            routingDecision,
            replyToBot,
            replyToMessageId,
            replyFetchStatus: replyInfo?.fetchStatus || '',
            replyFetchReason: replyInfo?.fetchReason || '',
            dbPath: sessionManager.getDbPath()
        };
        logger.debug('[路由] 消息未触发回复', lastRoutingSnapshot);
        return;
    }

    // 表情回应：收到消息后自动加表情，表示已收到
    if (routingDecision.shouldRespond) {
        sendEmojiReactionForEvent(event);
    }

    lastInboundMessageAt = Date.now();

    const memoryScope = buildMemoryScope(config, event);
    const sessionKey = memoryScope.sessionKey;
    const triggerReason = routingDecision.shouldRespond
        ? (routingDecision.triggerReason || getTriggerReason(config, event, plainText, isAtMe, messageInfo))
        : 'group_repeat_watch';
    lastRoutingSnapshot = {
        at: Date.now(),
        sessionKey,
        sessionLabel: describeSessionId(sessionKey),
        scopeType: memoryScope.scopeType,
        scopeLabel: memoryScope.scopeLabel,
        messageType: event.message_type,
        userId: event.user_id,
        groupId: event.group_id || null,
        triggerReason,
        skipReason: routingDecision.shouldRespond ? '' : routingDecision.skipReason,
        shouldRespond: routingDecision.shouldRespond,
        routingDecision,
        dbPath: sessionManager.getDbPath()
    };
    runtime.enqueue({
        sessionKey,
        memoryScope,
        dedupeKey: event.message_id ? `${sessionKey}:${event.message_id}` : `${sessionKey}:${event.time}:${plainText}`,
        event,
        plainText,
        structuredText,
        isAtMe,
        replyToMessageId,
        replyToBot,
        replyInfo,
        messageSegments,
        standardEvent,
        triggerReason,
        routingDecision
    });
}

bot.on('message', (event) => {
    // 戳一戳通知单独处理
    if (event && event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke') {
        handlePokeEvent(event);
        return;
    }
    handleMessage(event);
});
bot.on('connected', () => {
    logger.info(`已连接到 OneBot: ${config.onebot.url}`);
});
bot.on('disconnected', () => {
    logger.warn('OneBot 连接断开，将自动重连...');
});

// --- MCP 端点 (外部 AI 工具接口) ---
if (config.mcp?.enabled !== false) {
    const mcpPath = config.mcp?.path || '/mcp';
    const { createMCPHandler } = await import('./mcp.js');
    app.all(mcpPath, createMCPHandler(managers, config, saveConfig));
    logger.info(`MCP 端点已挂载: ${mcpPath}`);
} else {
    logger.info('MCP 端点已禁用');
}

server.listen(config.server.port, config.server.host, () => {
    logger.info(`服务器已启动: http://${config.server.host}:${config.server.port}`);
    startHealthTicker();
    startParticipantProfileIntervalScheduler(sessionManager, aiClient, logger);

    const defaultCharacter = config.chat.defaultCharacter;
    applyMemoryBinding();
    if (defaultCharacter && defaultCharacter !== '你的角色名') {
        try {
            const character = characterManager.loadCharacter(defaultCharacter);
            logger.info(`已加载默认角色: ${defaultCharacter}`);

            const charName = character.name || defaultCharacter;
            let worldBook = worldBookManager.readWorldBook(charName);
            // 如果没有独立世界书文件，尝试从角色卡提取内嵌世界书
            if (!worldBook) {
                const meta = characterManager.extractSillyTavernMetadata(defaultCharacter);
                const embedded = meta?.metadata?.worldBook;
                if (embedded?.entries) {
                    const wbDir = config.chat?.dataDir || join(ROOT_DIR, 'data');
                    const wbPath = join(wbDir, 'worlds', `${charName}'s Lorebook.json`);
                    const rawEntries = embedded.entries;
                    const v1Entries = Array.isArray(rawEntries) ? rawEntries : Object.values(rawEntries);
                    // 统一转为 MimirLink V2 格式
                    const entries = v1Entries.map(e => ({
                        id: e.uid || e.id || 0,
                        keys: typeof e.key === 'string' ? e.key.split(',').map(k => k.trim()).filter(Boolean) : (e.keys || []),
                        secondary_keys: e.secondary_keys || [],
                        comment: e.comment || '',
                        content: e.content || '',
                        constant: e.constant || false,
                        selective: e.selective !== false,
                        insertion_order: e.order || e.insertion_order || 100,
                        enabled: e.enabled !== false,
                        position: (e.position === 0 || e.position === 'before_char') ? 'before_char' : 'after_char',
                        use_regex: e.use_regex !== false,
                        extensions: e.extensions || {}
                    }));
                    const wb = { name: `${charName} 世界书`, description: `从角色卡提取`, entries };
                    fs.mkdirSync(dirname(wbPath), { recursive: true });
                    fs.writeFileSync(wbPath, JSON.stringify(wb, null, 2), 'utf8');
                    worldBookManager.scanWorldBooks();
                    worldBook = worldBookManager.readWorldBook(charName);
                    logger.info(`[启动] 从角色卡提取内嵌世界书: ${charName} (${entries.length} 条)`);
                }
            }
            if (worldBook) {
                worldBookManager.currentWorldBook = worldBook;
                worldBookManager.currentWorldBookName = charName;
                logger.info(`已自动加载世界书: ${charName}`);
            }
        } catch (error) {
            logger.warn(`加载默认角色失败: ${error.message}`);
        }
    } else {
        logger.info('未配置默认角色，跳过自动加载');
    }

    bot.connect();
    backfillParticipantProfilesFromHistory(sessionManager, aiClient, logger).catch((error) => {
        logger.warn(`[画像] 启动补建失败: ${error.message}`);
    });
});

export function getLastRoutingSnapshot() {
    return lastRoutingSnapshot;
}

export function formatSessionLabel(sessionId) {
    return describeSessionId(sessionId);
}

export function getLastInjectionObservation() {
    return lastInjectionObservation;
}

export function getRecentInjectionObservations() {
    return recentInjectionObservations;
}

export function getLastRecallSnapshot() {
    return lastRecallSnapshot;
}

