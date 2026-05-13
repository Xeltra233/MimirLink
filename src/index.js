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
import { buildAIToolContext, buildRealtimeGroundingMessage, buildVoicePrefaceText, appendMentionTaskToPromptMessages, generateMentionTextFromPrompt, generateRealtimeAnswer } from './tools.js';
import { CharacterManager } from './character.js';
import { WorldBookManager } from './worldbook.js';
import { PromptBuilder } from './prompt.js';
import { AIClient } from './ai.js';
import { SessionManager } from './session.js';
import { RegexProcessor } from './regex.js';
import { setupRoutes } from './routes.js';
import { Logger } from './logger.js';
import { TTSManager, VOICE_TYPES, parseVoiceTags } from './tts.js';
import { MessageRuntime } from './runtime.js';
import { detectPromptInjectionRisk, buildObservationEnvelope } from './security.js';
import { getParticipantProfileConfig, normalizeParticipantProfileConfig } from './participant-profile-config.js';
import {
    getParticipantProfileTimerKey,
    trackParticipantProfileTarget,
    shouldUseIdleParticipantProfileTrigger,
    shouldUseIntervalParticipantProfileTrigger,
    buildParticipantProfilePrompt,
    buildParticipantProfileAIOverrides,
    buildParticipantProfileTaskMeta
} from './participant-profile-runtime.js';

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
    const configPath = join(ROOT_DIR, 'config.json');
    const exampleConfigPath = join(ROOT_DIR, 'config.example.json');
    if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        normalizeConfig(config);
        return config;
    }

    if (fs.existsSync(exampleConfigPath)) {
        const exampleConfig = JSON.parse(fs.readFileSync(exampleConfigPath, 'utf8'));
        normalizeConfig(exampleConfig);
        fs.writeFileSync(configPath, JSON.stringify(exampleConfig, null, 2), 'utf8');
        return exampleConfig;
    }

    throw new Error('配置文件不存在: config.json');
}

function saveConfig(config) {
    const configPath = join(ROOT_DIR, 'config.json');
    normalizeConfig(config);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
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
    const providerId = toOptionalString(chatConfig.modelProviderId);
    const selectedProvider = providerId && Array.isArray(config.ai?.providers)
        ? config.ai.providers.find((provider) => provider?.id === providerId)
        : null;
    const model = toOptionalString(chatConfig.model) || toOptionalString(selectedProvider?.model);
    const overrides = {};

    if (model) {
        overrides.model = model;
    }
    if (selectedProvider) {
        const baseUrl = toOptionalString(selectedProvider.baseUrl);
        const apiKey = toOptionalString(selectedProvider.apiKey);
        if (baseUrl) {
            overrides.baseUrl = baseUrl;
        }
        if (apiKey) {
            overrides.apiKey = apiKey;
        }
    }

    return overrides;
}

function getChatAISelectionSnapshot(config = {}) {
    const overrides = buildChatAIOverrides(config);
    return {
        providerId: toOptionalString(config.chat?.modelProviderId) || null,
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
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = toPositiveInteger(value, fallback);
    return Math.min(maximum, Math.max(minimum, normalized));
}

function ensureCommandAndToolConfig(config) {
    config.chat = config.chat || {};
    config.chat.commands = config.chat.commands || {};
    config.ai = config.ai || {};
    config.ai.tools = config.ai.tools || {};

    const participantProfileConfig = getParticipantProfileConfig(config);
    const adminMention = config.chat.commands.adminMention || {};
    const participantProfileManual = config.chat.commands.participantProfileManual || {};
    const webSearch = config.ai.tools.webSearch || {};
    const sendMention = config.ai.tools.sendMention || {};

    config.chat.commands.adminMention = {
        enabled: typeof adminMention.enabled === 'boolean' ? adminMention.enabled : true,
        command: normalizeCommandText(adminMention.command, '/at')
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

function buildGroupMentionPrefix(userId) {
    if (userId === undefined || userId === null || userId === '') {
        return '';
    }

    return `[CQ:at,qq=${String(userId)}] `;
}

function sanitizeContent(text) {
    return (text || '').replace(/\r/g, '').trim();
}

function buildStructuredMessage(event, plainText) {
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

    return `[${chatType}|QQ:${user_id}|昵称:${userName}|群号:${actualGroupId}|群名:${groupName}|时间:${timestamp}] ${plainText}`;
}

function extractMessageInfo(config, event, bot) {
    const segments = Array.isArray(event.message) ? event.message : [];
    let plainText = '';
    let isAtMe = false;
    let replyToMessageId = null;

    for (const segment of segments) {
        if (segment.type === 'text') {
            plainText += segment.data?.text || '';
        } else if (segment.type === 'at' && String(segment.data?.qq) === String(bot.selfId)) {
            isAtMe = true;
        } else if (segment.type === 'reply') {
            replyToMessageId = segment.data?.id || null;
        }
    }

    plainText = sanitizeContent(plainText || event.raw_message || '');
    const structuredText = plainText
        ? (config.chat?.attachMetadata === false ? plainText : buildStructuredMessage(event, plainText))
        : '';
    return {
        plainText,
        isAtMe,
        replyToMessageId,
        structuredText
    };
}

function getTriggerReason(config, event, plainText, isAtMe) {
    const triggerPrefix = config.chat.triggerPrefix || '';
    const hasPrefix = triggerPrefix ? plainText.startsWith(triggerPrefix) : false;
    const hasKeyword = matchesKeywords(plainText, config.chat.triggerKeywords || []);
    if (event.message_type === 'group' && isAtMe) {
        return 'at';
    }
    if (hasPrefix) {
        return 'prefix';
    }
    if (hasKeyword) {
        return 'keyword';
    }
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

function extractMentionedParticipant(event) {
    const segments = Array.isArray(event?.message) ? event.message : [];
    for (const segment of segments) {
        if (segment.type !== 'at') {
            continue;
        }

        const qq = segment.data?.qq;
        if (qq === undefined || qq === null || qq === 'all') {
            continue;
        }

        return {
            participantId: String(qq)
        };
    }

    return null;
}

function isParticipantProfileManualCommand(plainText, manualCommand) {
    if (!manualCommand) {
        return false;
    }

    return plainText === manualCommand || plainText.startsWith(`${manualCommand} `);
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

    if (sendMessage) {
        await bot.sendGroupMessage(event.group_id, buildMentionMessage(targetUserId, mentionResult.generatedMessage));
    }

    return {
        groupId: String(event.group_id),
        targetUserId: String(targetUserId),
        generatedMessage: sanitizeContent(mentionResult.generatedMessage),
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
            targetName: mentionedParticipant?.participantName || event.sender?.card || event.sender?.nickname || null,
            promptText,
            currentSpeakerOverride: buildSpeakerIdentity(event)
        });
        return result.generatedMessage;
    }, timeoutMs);
    return sanitizeContent(reply);
}

function buildReplyReference(items) {
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

function shouldRespond(config, event, plainText, isAtMe) {
    if (!plainText || !isAllowed(config, event)) {
        return false;
    }

    const triggerMode = config.chat.triggerMode || 'auto';
    const requireAtInGroup = config.chat.requireAtInGroup !== false;
    const triggerPrefix = config.chat.triggerPrefix || '';
    const triggerKeywords = config.chat.triggerKeywords || [];
    const hasPrefix = triggerPrefix ? plainText.startsWith(triggerPrefix) : false;
    const hasKeyword = matchesKeywords(plainText, triggerKeywords);

    if (event.message_type === 'group') {
        if (triggerMode === 'always') {
            return true;
        }
        if (triggerMode === 'prefix') {
            return hasPrefix || (!requireAtInGroup && isAtMe);
        }
        if (triggerMode === 'keyword') {
            return hasKeyword || isAtMe;
        }
        return requireAtInGroup ? isAtMe || hasPrefix || hasKeyword : hasPrefix || hasKeyword || isAtMe;
    }

    if (triggerMode === 'keyword') {
        return hasKeyword;
    }
    if (triggerMode === 'prefix') {
        return hasPrefix;
    }
    return true;
}

async function callWithTimeout(promiseFactory, timeoutMs) {
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs);
    });
    return Promise.race([promiseFactory(), timeoutPromise]);
}

const config = loadConfig();
ensureBindingConfig(config);
const logger = new Logger();
const DATA_DIR = config.chat?.dataDir || join(ROOT_DIR, 'data');

const characterManager = new CharacterManager(DATA_DIR);
const worldBookManager = new WorldBookManager(DATA_DIR);
const sessionManager = new SessionManager(DATA_DIR, config, logger);
const regexProcessor = new RegexProcessor(config.regex, logger);
const aiClient = new AIClient(config.ai, logger);
const promptBuilder = new PromptBuilder(characterManager, worldBookManager, config, logger);
const ttsManager = new TTSManager(logger);

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
    participantProfileProgress.savedCount = taskList.filter((item) => item.stage === 'completed').length;
    participantProfileProgress.progressPercent = taskList.length > 0
        ? Math.round(taskList.reduce((sum, item) => sum + (Number(item.progressPercent) || 0), 0) / taskList.length)
        : (participantProfileProgress.progressPercent || 0);
    participantProfileProgress.updatedAt = Date.now();
    return participantProfileProgress;
}

function getParticipantProfileProgressSnapshot() {
    return {
        ...participantProfileProgress,
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

async function sendFailureMessage(event, message) {
    try {
        if (event.message_type === 'group') {
            await bot.sendGroupMessage(event.group_id, message);
        } else {
            await bot.sendPrivateMessage(event.user_id, message);
        }
    } catch (error) {
        logger.error(`发送失败提示失败: ${error.message}`);
    }
}

async function dispatchReply(event, processedReply) {
    const ttsConfig = ttsManager.getConfig();
    const { textParts } = parseVoiceTags(processedReply);
    const splitMessage = config.chat.splitMessage !== false;
    const segmentDelayMs = config.chat.segmentDelayMs ?? 300;
    const proactiveIntervalMs = config.chat.proactiveMessageIntervalMs ?? Math.max(segmentDelayMs, 1200);
    const quoteReplyEnabled = config.chat.quoteReplyEnabled !== false;
    const mentionSenderOnReply = config.chat.mentionSenderOnReply !== false;
    const mentionPrefix = event.message_type === 'group' && mentionSenderOnReply ? buildGroupMentionPrefix(event.user_id) : '';
    let hasSentPrimary = false;

    const sendText = async (content) => {
        const message = !hasSentPrimary && mentionPrefix ? `${mentionPrefix}${content}` : content;
        if (event.message_type === 'group') {
            if (quoteReplyEnabled && !splitMessage && !hasSentPrimary && event.message_id) {
                await bot.sendGroupReply(event.group_id, event.message_id, message);
            } else {
                await bot.sendGroupMessage(event.group_id, message);
            }
        } else if (quoteReplyEnabled && !splitMessage && !hasSentPrimary && event.message_id) {
            await bot.sendPrivateReply(event.user_id, event.message_id, message);
        } else {
            await bot.sendPrivateMessage(event.user_id, message);
        }

        hasSentPrimary = true;
    };

    const sendVoice = async (audioPath, fallbackText) => {
        const fallbackMessage = !hasSentPrimary && mentionPrefix && fallbackText
            ? `${mentionPrefix}${fallbackText}`
            : fallbackText;

        if (event.message_type === 'group') {
            if (quoteReplyEnabled && !splitMessage && !hasSentPrimary && fallbackMessage && event.message_id) {
                await bot.sendGroupReply(event.group_id, event.message_id, fallbackMessage);
            } else {
                if (!hasSentPrimary && fallbackMessage) {
                    await bot.sendGroupMessage(event.group_id, fallbackMessage);
                }
                await bot.sendGroupRecord(event.group_id, audioPath);
            }
        } else if (quoteReplyEnabled && !splitMessage && !hasSentPrimary && fallbackMessage && event.message_id) {
            await bot.sendPrivateReply(event.user_id, event.message_id, fallbackMessage);
        } else {
            if (!hasSentPrimary && fallbackMessage) {
                await bot.sendPrivateMessage(event.user_id, fallbackMessage);
            }
            await bot.sendPrivateRecord(event.user_id, audioPath);
        }

        hasSentPrimary = true;
    };

    for (const part of textParts) {
        if (part.type === 'text') {
            const segments = splitMessage
                ? part.content.split(/\n\n+/).filter((segment) => segment.trim())
                : [part.content];

            for (let index = 0; index < segments.length; index += 1) {
                const segment = segments[index];
                const content = segment.trim();
                if (!content) {
                    continue;
                }

                const isPrimarySend = !hasSentPrimary;
                await sendText(content);
                const hasMoreSegments = index < segments.length - 1 || textParts.indexOf(part) < textParts.length - 1;
                const delayMs = isPrimarySend ? segmentDelayMs : proactiveIntervalMs;
                if (hasMoreSegments && delayMs > 0) {
                    await sleep(delayMs);
                }
            }
            continue;
        }

        if (part.type === 'voice' && ttsConfig.enabled) {
            try {
                logger.info(`[TTS] 合成语音: ${part.content.substring(0, 30)}...`);
                recordDashboardMetric('tts');
                const audioPath = await ttsManager.synthesize(part.content);
                await sendVoice(audioPath, buildVoicePrefaceText(part.content));
                logger.info('[TTS] 语音发送成功');
            } catch (error) {
                logger.warn(`[TTS] 语音合成失败: ${error.message}`);
                const fallbackText = buildVoicePrefaceText(part.content);
                await sendText(fallbackText);
            }
            continue;
        }

        if (part.type === 'voice') {
            const fallbackText = buildVoicePrefaceText(part.content);
            await sendText(fallbackText);
        }
    }
}

function isParticipantProfileBlacklisted(participantProfileConfig, participantId) {
    if (!participantId) {
        return false;
    }

    return participantProfileConfig.blacklistParticipantIds.includes(String(participantId));
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
            updateParticipantProfileProgress({
                running: false,
                stage: 'completed',
                currentMessage: '新信息不足，沿用现有人物档案',
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'not_enough_new_info',
                    participantId: String(speakerIdentity.participantId),
                    profileId: source.existing?.id || null
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
                currentMessage: '新信息不足，沿用现有人物档案',
                progressPercent: 100,
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastResult: {
                    skipped: true,
                    reason: 'not_enough_new_info',
                    participantId: String(speakerIdentity.participantId),
                    profileId: source.existing?.id || null
                }
            });
            return source.existing;
        }

        if (!source.messages.length) {
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
                    profileId: source.existing?.id || null
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
                    profileId: source.existing?.id || null
                }
            });
            return source.existing;
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
        const profileResult = await aiClient.chat(
            [{ role: 'user', content: profilePrompt }],
            buildParticipantProfileAIOverrides(participantProfileConfig)
        );
        const profileText = aiClient.getVisibleResponseContent(profileResult);

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
            content: profileText.trim(),
            tags: sessionManager.buildKeywordsFromText(profileText),
            metadata: {
                participantId: speakerIdentity.participantId,
                participantName: speakerIdentity.participantName,
                lastProcessedMessageAt,
                lastProcessedSessionId: lastMessage?.sessionId || null,
                lastSourceMessageCount: source.messages.length,
                analysisMode: participantProfileConfig.analysisMode,
                source: 'participant_profile',
                triggeredBy: options.triggeredBy || 'auto'
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
        updateParticipantProfileProgress({
            running: false,
            stage: 'failed',
            currentMessage: `人物档案分析失败: ${error.message}`,
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
            stage: 'failed',
            triggeredBy: options.triggeredBy || 'auto',
            analysisMode: participantProfileConfig.analysisMode,
            currentMessage: `人物档案分析失败: ${error.message}`,
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
        throw error;
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

        const participantName = String(row.participant_label || '').split('(')[0].trim() || participantId;
        const speakerIdentity = {
            participantId,
            participantName,
            messageType: 'group',
            groupId: String(row.group_id || '') || null
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

    if (!isAdminUser(config, event.user_id)) {
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
    if (plainText !== mentionCommand && !plainText.startsWith(`${mentionCommand} `)) {
        return false;
    }

    if (commandConfig.enabled === false) {
        return false;
    }

    if (!isAdminUser(config, event.user_id)) {
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

    const mentionedParticipant = extractMentionedParticipant(event);
    if (!mentionedParticipant?.participantId) {
        await sendFailureMessage(event, `请使用 ${mentionCommand} @某人 让 AI 生成的内容要求`);
        return true;
    }

    const promptText = extractTextAfterMentionCommand(event, mentionCommand, mentionedParticipant.participantId);
    if (!promptText) {
        await sendFailureMessage(event, `请在 ${mentionCommand} @某人 后填写让 AI 生成的内容要求`);
        return true;
    }

    try {
        const messageText = await generateAdminMentionReply(event, mentionedParticipant, promptText);
        if (!messageText) {
            throw new Error('AI 未生成可发送内容');
        }

        await bot.sendGroupMessage(event.group_id, buildMentionMessage(mentionedParticipant.participantId, messageText));
    } catch (error) {
        logger.warn(`[主动@] 管理员触发主动 @ 失败: ${mentionedParticipant.participantId} ${error.message}`);
        await sendFailureMessage(event, `主动 @ 生成失败: ${error.message}`);
    }
    return true;
}

async function processBatch(batch) {
    const primary = batch.items[batch.items.length - 1];
    const event = primary.event;
    const sessionId = batch.sessionKey;
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

            await sessionManager.maybeSummarizeSession(sessionId, async (messages, lockedSessionId) => {
                return aiClient.summarize(messages, lockedSessionId);
            });

            const context = sessionManager.getContext(sessionId, config.chat.historyLimit || 30);
            const stickyKeys = sessionManager.getStickyEntryKeys(sessionId);
            const adminUser = isAdminUser(config, event.user_id);
            let processedInput = regexProcessor.processInput(mergedStructuredText);
            const injectionRisk = detectPromptInjectionRisk(processedInput, {
                sourceType: adminUser ? 'admin_user_message' : 'user_message',
                trusted: adminUser
            });
            if (injectionRisk.level === 'high') {
                logger.warn(`[安全] 高风险注入已拦截 [${sessionId}]`, injectionRisk);
                await dispatchReply(event, '⚠️ 检测到提示注入攻击，已拦截。');
                return;
            }
            if (injectionRisk.level !== 'none') {
                logger.warn(`[安全] 检测到疑似提示注入 (${injectionRisk.level}) [${sessionId}]`, injectionRisk);
            }
            runtimeContext = {
                sessionId,
                memoryScope: batch.memoryScope,
                recallNamespace: buildRecallNamespace(config, batch.memoryScope, currentCharacterName),
                messageType: event.message_type,
                messageCount: batch.items.length,
                participants: buildParticipants(batch.items),
                triggerReason: primary.triggerReason,
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
                inboundMessageIds: batch.items
                    .map((item) => item.event?.message_id)
                    .filter(Boolean)
            });
            sessionManager.upsertConversationMemory(runtimeContext.recallNamespace, {
                userMessage: processedInput,
                sourceSessionId: sessionId,
                sourceMessageId: userRecord.id
            });

            const summaryBeforeReply = await sessionManager.maybeSummarizeSession(sessionId, async (messages, lockedSessionId) => {
                return aiClient.summarize(messages, lockedSessionId);
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
            const shouldUseRealtimeBypass = toolContext.isRealtimeQuery?.(processedInput);
            const realtimeIntentMatch = toolContext.matchRealtimeIntent?.(processedInput) || null;
            if (shouldUseRealtimeBypass) {
                const realtimeAnswer = await generateRealtimeAnswer({
                    aiClient,
                    config,
                    query: processedInput,
                    logger
                });
                if (realtimeAnswer?.reply) {
                    const processedReply = regexProcessor.processOutput(realtimeAnswer.reply);
                    logger.info('[执行] 实时问题走轻量回答旁路', {
                        sessionId,
                        query: processedInput.slice(0, 120),
                        groundingSource: realtimeAnswer.grounding?.source || '',
                        groundingProvider: realtimeAnswer.grounding?.provider || '',
                        groundingResultCount: realtimeAnswer.grounding?.resultCount || 0,
                        realtimeIntent: realtimeIntentMatch?.intent || '',
                        realtimeMatchReason: realtimeIntentMatch?.reason || '',
                        realtimeMatchScore: Number(realtimeIntentMatch?.score || 0).toFixed(3),
                        realtimeMatchPrototype: realtimeIntentMatch?.matchedPrototype || '',
                        processedReplyPreview: processedReply.slice(0, 200)
                    });

                    sessionManager.addMessage(sessionId, 'assistant', processedReply, {
                        replyTo: event.user_id,
                        messageType: event.message_type
                    });
                    sessionManager.upsertConversationMemory(runtimeContext.recallNamespace, {
                        userMessage: processedInput,
                        assistantMessage: processedReply,
                        sourceSessionId: sessionId,
                        sourceMessageId: userRecord.id
                    });
                    sessionManager.updateStickyEntries(sessionId, worldBookEntries);
                    await dispatchReply(event, processedReply);

                    if (runtimeContext.currentSpeaker) {
                        scheduleParticipantProfileUpdate(
                            sessionManager,
                            aiClient,
                            runtimeContext.recallNamespace,
                            runtimeContext.currentSpeaker,
                            logger
                        );
                    }
                    return;
                }
            }
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
            const replyResult = await callWithTimeout(() => aiClient.chatWithTools(messages, toolContext, chatAIOverrides), timeoutMs);
            const reply = aiClient.getVisibleResponseContent(replyResult);
            logger.info('[执行] AI 调用完成', {
                sessionId,
                replyLength: reply.length,
                replyPreview: reply.slice(0, 200),
                reasoningLength: typeof replyResult?.reasoningContent === 'string' ? replyResult.reasoningContent.length : 0
            });
            let processedReply = regexProcessor.processOutput(reply);
            // 清洗 ST 卡常见内部标签（draft_notes / thinking / cot 等）
            try {
                const { stripInternalTags } = await import('./variable-bridge.js');
                processedReply = stripInternalTags(processedReply);
            } catch (e) { logger.warn('[变量] 标签清洗失败:', e.message); }
            // 变量桥接：提取 <UpdateVariable> 块并写入变量存储
            try {
                const { extractAndApplyVariables } = await import('./variable-bridge.js');
                const ns = runtimeContext?.recallNamespace;
                if (ns) {
                    const varScopeKey = event.user_id ? `user:${event.user_id}` : ns.scopeKey;
                    const result = extractAndApplyVariables(processedReply, sessionManager, {
                        scopeType: 'user_persistent', scopeKey: varScopeKey,
                        characterName: ns.characterName, presetName: ns.presetName
                    });
                    processedReply = result.cleanedOutput;
                    if (result.applied.length > 0) {
                        logger.info('[变量] 已应用', { count: result.applied.length, patches: result.applied });
                    }
                }
            } catch (e) { logger.warn('[变量] 提取失败:', e.message); }
            logger.info('[执行] 输出后处理完成', {
                sessionId,
                processedReplyLength: typeof processedReply === 'string' ? processedReply.length : 0,
                processedReplyPreview: typeof processedReply === 'string' ? processedReply.slice(0, 200) : null
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
                splitMessage: config.chat.splitMessage !== false
            });
            await dispatchReply(event, processedReply);
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
            if (runtimeContext?.currentSpeaker) {
                scheduleParticipantProfileUpdate(
                    sessionManager,
                    aiClient,
                    runtimeContext.recallNamespace,
                    runtimeContext.currentSpeaker,
                    logger
                );
            }
            let failMessage = '处理消息时出现错误，请稍后重试';
            if (error.message === 'AI_TIMEOUT') {
                const timeoutSeconds = Math.floor((config.ai.timeout || 60000) / 1000);
                failMessage = `AI 响应超时（等待超过${timeoutSeconds}秒），请稍后再试或增大超时设置`;
            } else if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
                failMessage = '连接 AI 服务失败，请检查网络或 API 配置';
            } else if (error.message.includes('401') || error.message.includes('403')) {
                failMessage = 'API 密钥无效，请联系管理员检查配置';
            } else if (error.message.includes('500') || error.message.includes('502')) {
                failMessage = 'AI 服务暂时不可用，请稍后重试';
            }

            if (error.message === 'AI API 返回了空消息内容' && error.diagnostic) {
                logger.error(`[AI诊断] 会话 ${sessionId} 收到空回复`, error.diagnostic);
            }

            logger.error(`处理会话 ${sessionId} 失败: ${error.message}`);
            await sendFailureMessage(event, failMessage);
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
    })
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

async function handleMessage(event) {
    if (!event || event.post_type !== 'message') {
        return;
    }
    if (String(event.user_id) === String(bot.selfId)) {
        return;
    }

    const { plainText, isAtMe, structuredText, replyToMessageId } = extractMessageInfo(config, event, bot);
    if (await handleParticipantProfileManualCommand(event, plainText)) {
        return;
    }
    if (await handleAdminMentionCommand(event, plainText)) {
        return;
    }
    if (!shouldRespond(config, event, plainText, isAtMe)) {
        return;
    }

    lastInboundMessageAt = Date.now();

    const memoryScope = buildMemoryScope(config, event);
    const sessionKey = memoryScope.sessionKey;
    const triggerReason = getTriggerReason(config, event, plainText, isAtMe);
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
        triggerReason
    });
}

bot.on('message', handleMessage);
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
    app.post(mcpPath, createMCPHandler(managers, config, saveConfig));
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
            const worldBook = worldBookManager.readWorldBook(charName);
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

