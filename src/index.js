/**
 * Tavern-Link 入口文件
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
   Tavern-Link Memory Runtime v2
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

import { OneBotClient } from './onebot.js';
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
    ensureBindingConfig(config);
    const binding = getCharacterBinding(config, characterName);
    return {
        memoryDbPath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path || null,
        worldbook: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null,
        preset: binding.preset || binding.importedFromCard?.preset || config.bindings.global.preset || config.preset || null,
        globalRegexRules: config.bindings.global.regexRules || config.regex?.rules || [],
        presetRegexRules: binding.preset?.regexRules || binding.importedFromCard?.preset?.regexRules || config.preset?.regexRules || [],
        regexRules: binding.regexRules || binding.importedFromCard?.regexRules || []
    };
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
    return {
        plainText,
        isAtMe,
        replyToMessageId,
        structuredText: plainText ? buildStructuredMessage(event, plainText) : ''
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
const aiClient = new AIClient(config.ai);
const promptBuilder = new PromptBuilder(characterManager, worldBookManager, config);
const ttsManager = new TTSManager();

if (config.tts) {
    ttsManager.updateConfig(config.tts);
}

const app = express();
const server = createServer(app);
app.use(express.json({ limit: '25mb' }));

if (config.auth?.enabled) {
    const authSessionDays = config.auth.sessionDays ?? 30;
    const FileStore = createFileStore(session);
    const sessionStorePath = config.auth.sessionStorePath || join(DATA_DIR, 'sessions');
    app.use(session({
        secret: config.auth.sessionSecret || 'tavern-link-default-secret',
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
            secure: false,
            httpOnly: true,
            sameSite: 'lax',
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
let lastRecallSnapshot = null;

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
    let hasSentPrimary = false;

    const sendText = async (content) => {
        if (event.message_type === 'group') {
            if (!hasSentPrimary && quoteReplyEnabled && event.message_id) {
                await bot.sendGroupReply(event.group_id, event.message_id, content);
            } else {
                await bot.sendGroupMessage(event.group_id, content);
            }
        } else if (!hasSentPrimary && quoteReplyEnabled && event.message_id) {
            await bot.sendPrivateReply(event.user_id, event.message_id, content);
        } else {
            await bot.sendPrivateMessage(event.user_id, content);
        }

        hasSentPrimary = true;
    };

    const sendVoice = async (audioPath, fallbackText) => {
        if (event.message_type === 'group') {
            if (!hasSentPrimary && fallbackText && quoteReplyEnabled && event.message_id) {
                await bot.sendGroupReply(event.group_id, event.message_id, fallbackText);
            } else {
                await bot.sendGroupRecord(event.group_id, audioPath);
            }
        } else if (!hasSentPrimary && fallbackText && quoteReplyEnabled && event.message_id) {
            await bot.sendPrivateReply(event.user_id, event.message_id, fallbackText);
        } else {
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
                const audioPath = await ttsManager.synthesize(part.content);
                await sendVoice(audioPath, `（语音：${part.content}）`);
                logger.info('[TTS] 语音发送成功');
            } catch (error) {
                logger.warn(`[TTS] 语音合成失败: ${error.message}`);
                const fallbackText = `（语音：${part.content}）`;
                await sendText(fallbackText);
            }
            continue;
        }

        if (part.type === 'voice') {
            const fallbackText = `（语音：${part.content}）`;
            await sendText(fallbackText);
        }
    }
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
            const processedInput = regexProcessor.processInput(mergedStructuredText);
            const adminUser = isAdminUser(config, event.user_id);
            const injectionRisk = detectPromptInjectionRisk(processedInput, {
                sourceType: adminUser ? 'admin_user_message' : 'user_message',
                trusted: adminUser
            });
            if (injectionRisk.level !== 'none') {
                logger.warn(`[安全] 检测到疑似提示注入 (${injectionRisk.level}) [${sessionId}]`, injectionRisk);
            }
            const runtimeContext = {
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
            runtimeContext.recalledEntries = sessionManager.recallMemory(runtimeContext.recallNamespace, processedInput, {
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

            const userRecord = sessionManager.addMessage(sessionId, 'user', processedInput, {
                messageType: event.message_type,
                userId: event.user_id,
                groupId: event.group_id,
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

            const keywordTriggered = worldBookEntries.filter((entry) => entry.triggeredByKeyword).length;
            const stickyTriggered = worldBookEntries.filter((entry) => entry.triggeredBySticky).length;
            logger.info(`世界书匹配: ${worldBookCount} 条 (关键词: ${keywordTriggered}, 粘性: ${stickyTriggered})`);

            const timeoutMs = config.ai.timeout || 60000;
            const reply = await callWithTimeout(() => aiClient.chat(messages), timeoutMs);
            const processedReply = regexProcessor.processOutput(reply);

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

            logger.info(`回复 [${sessionId}]: ${processedReply.substring(0, 80)}...`);
            await dispatchReply(event, processedReply);
        } catch (error) {
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

            logger.error(`处理会话 ${sessionId} 失败: ${error.message}`);
            await sendFailureMessage(event, failMessage);
        }
    });
}

const runtime = new MessageRuntime(config, logger, processBatch);

setupRoutes(app, config, saveConfig, {
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
    getLastRecallSnapshot
});

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

server.listen(config.server.port, config.server.host, () => {
    logger.info(`服务器已启动: http://${config.server.host}:${config.server.port}`);
    startHealthTicker();

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

export function getLastRecallSnapshot() {
    return lastRecallSnapshot;
}
