/**
 * API 路由模块
 * 提供 Web 管理面板的后端接口
 */

import express from 'express';
import path from 'path';
import fs from 'fs/promises';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { RegexProcessor } from './regex.js';
import { PromptBuilder } from './prompt.js';
import { inspectMemoryDatabase } from './session.js';
import { buildChatRuntimePreview } from './runtime/chat-preview.js';
import { resolveChatRuntimeInputs } from './runtime/source-resolver.js';
import { buildAIToolContext, buildRealtimeGroundingMessage, sendGroupMentionFromPrompt, generateRealtimeAnswer, runConfiguredWebSearch } from './tools.js';
import { scanVariableUsage, applyScannedVariableInitializers } from './variable-bridge.js';

function estimateTokenCount(text) {
    if (!text) return 0;
    let count = 0;
    for (const ch of text) {
        count += /[\u4e00-\u9fff\u3400-\u4dbf]/.test(ch) ? 1.3 : 0.3;
    }
    return Math.round(count);
}

function toComparableId(value) {
    return value === undefined || value === null ? '' : String(value);
}

function isPreviewAccessAllowed(config, event) {
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


function isConfiguredAllowlistGroup(config, groupId) {
    const allowedGroups = (config.chat?.allowedGroups || []).map(toComparableId).filter(Boolean);
    return Boolean(toComparableId(groupId)) && allowedGroups.includes(toComparableId(groupId));
}

function rejectNonAllowlistTestGroup(res) {
    return res.status(403).json({
        success: false,
        error: '测试功能只能在设置里的群聊白名单中执行，请填写已配置的白名单群号'
    });
}


function getAITimeoutMs(config) {
    const raw = Number(config.ai?.timeout);
    if (!Number.isFinite(raw)) {
        return 60000;
    }
    return Math.min(Math.max(Math.trunc(raw), 1000), 3600000);
}

async function callWithTimeout(promiseFactory, timeoutMs) {
    let timer = null;
    try {
        return await Promise.race([
            promiseFactory(),
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('AI_TIMEOUT')), timeoutMs);
            })
        ]);
    } finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}

function getAITimeoutErrorMessage(config) {
    const timeoutSeconds = Math.floor(getAITimeoutMs(config) / 1000);
    return `AI \u8bf7\u6c42\u8d85\u65f6\uff08${timeoutSeconds}\u79d2\uff09\uff0c\u8bf7\u68c0\u67e5\u6a21\u578b\u6216\u7f51\u7edc`;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 设置路由
 * @param {express.Application} app - Express 应用
 * @param {Object} deps - 依赖注入
 */
export function setupRoutes(app, config, saveConfig, managers) {
    const sanitizeFilename = (name) => String(name || 'unknown').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').replace(/\.\.+/g, '.').substring(0, 200);

    const { characterManager, worldBookManager, sessionManager, regexProcessor, aiClient, promptBuilder, logger, bot, ttsManager, VOICE_TYPES, runtime, getLastRoutingSnapshot, formatSessionLabel, getLastInjectionObservation, getRecentInjectionObservations, getLastRecallSnapshot, clearParticipantProfileTimers, analyzeParticipantProfile, updateKnowledgeImportProgress, getParticipantProfileProgress, getKnowledgeImportProgress, getDashboardMetricsSnapshot, recordDashboardMetric } = managers;

    const summarizePayload = (payload, maxLen = 400) => {
        try {
            const text = JSON.stringify(payload);
            if (!text) {
                return '';
            }
            return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
        } catch {
            return '[unserializable payload]';
        }
    };

    const summarizeText = (value, maxLength = 160) => {
        const normalized = String(value || '').trim();
        return {
            length: normalized.length,
            preview: normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized
        };
    };

    const isWriteMethod = (method) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());

    const isAllowedPanelOrigin = (req, originValue) => {
        if (!originValue) {
            return true;
        }
        try {
            const origin = new URL(originValue);
            const host = req.headers.host || '';
            const [hostname, port = ''] = host.split(':');
            const originPort = origin.port || (origin.protocol === 'https:' ? '443' : '80');
            const hostPort = port || (req.protocol === 'https' ? '443' : '80');
            const allowedHostnames = new Set([hostname, '127.0.0.1', 'localhost', '::1']);
            return ['http:', 'https:'].includes(origin.protocol)
                && allowedHostnames.has(origin.hostname)
                && originPort === hostPort;
        } catch {
            return false;
        }
    };

    const requireSameOriginWrite = (req, res, next) => {
        if (!isWriteMethod(req.method)) {
            return next();
        }

        const origin = req.headers.origin;
        const referer = req.headers.referer;
        const refererOrigin = referer ? (() => {
            try {
                return new URL(referer).origin;
            } catch {
                return null;
            }
        })() : null;
        const sourceOrigin = origin || refererOrigin;
        if (sourceOrigin && !isAllowedPanelOrigin(req, sourceOrigin)) {
            logger.warn(`[API ${req.requestId || 'no-id'}] cross-origin write blocked`, {
                method: req.method,
                originalUrl: req.originalUrl,
                origin: origin || '',
                referer: referer || ''
            });
            return res.status(403).json({ success: false, error: '跨源写入请求已被拒绝' });
        }

        return next();
    };

    app.use('/api', (req, res, next) => {
        const startedAt = Date.now();
        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        req.requestId = requestId;

        logger.info(`[API ${requestId}] ${req.method} ${req.originalUrl} <- request`, {
            authenticated: !!req.session?.authenticated,
            contentType: req.headers['content-type'] || '',
            referer: req.headers.referer || '',
            bodyPreview: summarizePayload(req.body)
        });

        res.on('finish', () => {
            logger.info(`[API ${requestId}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - startedAt}ms)`);
        });

        next();
    });

    app.use('/api', requireSameOriginWrite);

    const ensureImportsConfig = () => {
        if (!config.imports || typeof config.imports !== 'object' || Array.isArray(config.imports)) {
            config.imports = {};
        }
        if (!Array.isArray(config.imports.presetFiles)) {
            config.imports.presetFiles = [];
        }
        if (!Array.isArray(config.imports.regexFiles)) {
            config.imports.regexFiles = [];
        }
    };

    const createImportRecordId = (type) => `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const stableStringify = (value) => {
        if (Array.isArray(value)) {
            return `[${value.map((item) => stableStringify(item)).join(',')}]`;
        }
        if (value && typeof value === 'object') {
            return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
        }
        return JSON.stringify(value);
    };

    const areSnapshotsEqual = (left, right) => stableStringify(left) === stableStringify(right);

    const cloneImportSnapshot = (value) => JSON.parse(JSON.stringify(value ?? null));

    const getRegexTargetRules = (targetLayer) => {
        ensureBindingConfig();
        if (targetLayer === 'preset') {
            config.preset = { ...(config.preset || {}), regexRules: Array.isArray(config.preset?.regexRules) ? config.preset.regexRules : [] };
            return config.preset.regexRules;
        }
        if (targetLayer === 'character') {
            const currentCharacterName = config.chat?.defaultCharacter;
            if (!currentCharacterName) {
                return null;
            }
            const binding = getCharacterBinding(currentCharacterName);
            binding.regexRules = Array.isArray(binding.regexRules) ? binding.regexRules : [];
            return binding.regexRules;
        }
        config.bindings.global.regexRules = Array.isArray(config.bindings.global.regexRules) ? config.bindings.global.regexRules : [];
        return config.bindings.global.regexRules;
    };

    const removeMatchingRules = (targetRules = [], importedRules = []) => {
        if (!Array.isArray(targetRules) || !Array.isArray(importedRules) || importedRules.length === 0) {
            return 0;
        }

        const signatures = new Set(importedRules.map((rule) => stableStringify(rule)));
        const before = targetRules.length;
        const kept = targetRules.filter((rule) => !signatures.has(stableStringify(rule)));
        targetRules.splice(0, targetRules.length, ...kept);
        return before - targetRules.length;
    };

    const getPresetFieldsFromSnapshot = (snapshot = {}) => Object.keys(snapshot).filter((key) => key !== 'regexRules');

    const deleteTrackedRegexImport = (recordId) => {
        ensureImportsConfig();
        const index = config.imports.regexFiles.findIndex((item) => item?.id === recordId);
        if (index < 0) {
            return { found: false, removedCount: 0 };
        }

        const [record] = config.imports.regexFiles.splice(index, 1);
        const targetRules = getRegexTargetRules(record.targetLayer || 'global');
        if (!targetRules) {
            return { found: true, removedCount: 0, record };
        }

        const importedRules = Array.isArray(record.importedRules) ? record.importedRules : [];
        let removedCount = 0;
        if (record.sourceType === 'preset' && record.targetLayer === 'preset') {
            if (areSnapshotsEqual(targetRules, importedRules)) {
                removedCount = importedRules.length;
                config.preset.regexRules = cloneImportSnapshot(record.previousRules || []);
            } else {
                removedCount = removeMatchingRules(targetRules, importedRules);
            }
        } else {
            removedCount = removeMatchingRules(targetRules, importedRules);
        }
        return { found: true, removedCount, record };
    };

    const deleteTrackedPresetImport = (recordId) => {
        ensureImportsConfig();
        const index = config.imports.presetFiles.findIndex((item) => item?.id === recordId);
        if (index < 0) {
            return { found: false, removedCount: 0, restoredFields: [] };
        }

        const [record] = config.imports.presetFiles.splice(index, 1);
        if (record.linkedRegexImportId) {
            config.imports.regexFiles = config.imports.regexFiles.filter((item) => item?.id !== record.linkedRegexImportId);
        }
        config.preset = { ...(config.preset || {}) };

        const restoredFields = [];
        const previousPreset = record.previousPreset || {};
        const importedPreset = record.importedPreset || {};
        for (const key of getPresetFieldsFromSnapshot(importedPreset)) {
            if (!areSnapshotsEqual(config.preset[key], importedPreset[key])) {
                continue;
            }

            if (previousPreset[key] === undefined) {
                delete config.preset[key];
            } else {
                config.preset[key] = cloneImportSnapshot(previousPreset[key]);
            }
            restoredFields.push(key);
        }

        const currentRegexRules = Array.isArray(config.preset.regexRules) ? config.preset.regexRules : [];
        const importedRegexRules = Array.isArray(record.importedRegexRules) ? record.importedRegexRules : [];
        const previousRegexRules = record.previousRegexRules;
        let removedCount = 0;
        if (areSnapshotsEqual(currentRegexRules, importedRegexRules)) {
            removedCount = importedRegexRules.length;
            if (previousRegexRules === undefined) {
                delete config.preset.regexRules;
            } else {
                config.preset.regexRules = cloneImportSnapshot(previousRegexRules);
            }
        } else {
            removedCount = removeMatchingRules(currentRegexRules, importedRegexRules);
            config.preset.regexRules = currentRegexRules;
        }
        return { found: true, removedCount, restoredFields, record };
    };

    const summarizePresetImportRecord = (record = {}) => ({
        id: record.id,
        filename: record.filename,
        createdAt: record.createdAt,
        importedFields: Array.isArray(record.importedFields) ? record.importedFields : [],
        importedPreset: cloneImportSnapshot(record.importedPreset || {}),
        importedRegexCount: Array.isArray(record.importedRegexRules) ? record.importedRegexRules.length : 0,
        linkedRegexImportId: record.linkedRegexImportId || null
    });

    const summarizeRegexImportRecord = (record = {}) => ({
        id: record.id,
        filename: record.filename,
        createdAt: record.createdAt,
        targetLayer: record.targetLayer || 'global',
        sourceType: record.sourceType || 'regex',
        presetImportId: record.presetImportId || null,
        importedRules: cloneImportSnapshot(Array.isArray(record.importedRules) ? record.importedRules : []),
        importedCount: Array.isArray(record.importedRules) ? record.importedRules.length : 0
    });

    const isImportSummaryOnlyRequest = (req) => req.query?.summary === '1';

    const isBackendCompatibleRegexRule = (rule) => {
        if (!rule || typeof rule !== 'object') {
            return false;
        }

        const placement = rule.stage ?? rule.placement;
        if (Array.isArray(placement)) {
            return false;
        }

        if (rule.markdownOnly || rule.runOnEdit || rule.substituteRegex) {
            return false;
        }

        return !!RegexProcessor.normalizeImportedRule(rule);
    };

    const ensureBindingConfig = () => {
        if (!config.bindings) {
            config.bindings = { global: { memoryDbPath: null, worldbook: null, preset: null, regexRules: null }, characters: {} };
        }
        if (!config.bindings.global) {
            config.bindings.global = { memoryDbPath: null, worldbook: null, preset: null, regexRules: null };
        }
        if (!config.bindings.characters) {
            config.bindings.characters = {};
        }
    };

    const getCharacterBinding = (characterName) => {
        ensureBindingConfig();
        if (!config.bindings.characters[characterName]) {
            config.bindings.characters[characterName] = {
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
        return config.bindings.characters[characterName];
    };

    const getBindingSummary = (characterName) => {
        ensureBindingConfig();
        const binding = getCharacterBinding(characterName);
        const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
        const regexResolution = PromptBuilder.getRegexResolution(config, characterName);

        const resolveSource = (explicitValue, importedValue, globalValue, legacyValue) => {
            if (explicitValue) return 'character';
            if (importedValue && (Array.isArray(importedValue) ? importedValue.length > 0 : true)) return 'card';
            if (globalValue && (Array.isArray(globalValue) ? globalValue.length > 0 : true)) return 'global';
            if (legacyValue && (Array.isArray(legacyValue) ? legacyValue.length > 0 : true)) return 'legacy';
            return 'none';
        };

        const normalizePresetSummarySource = (source) => {
            if (source === 'character_binding') return 'character';
            if (source === 'imported_from_card') return 'card';
            return source;
        };

        return {
            memoryDbPath: {
                source: binding.memoryDbPath ? 'character' : config.bindings.global.memoryDbPath ? 'global' : 'default',
                value: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path || null
            },
            worldbook: {
                source: resolveSource(binding.worldbook, binding.importedFromCard?.worldbook, config.bindings.global.worldbook, null),
                value: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null
            },
            preset: {
                source: normalizePresetSummarySource(presetResolution.source),
                value: presetResolution.preset?.name || null,
                layers: presetResolution.layers,
                lockedIdentifiers: presetResolution.lockedIdentifiers,
                itemSources: presetResolution.itemSources
            },
            regexRules: {
                source: normalizePresetSummarySource(regexResolution.regexRules.source),
                count: regexResolution.regexRules.count
            },
            presetRegexRules: {
                source: normalizePresetSummarySource(regexResolution.presetRegexRules.source),
                layers: regexResolution.presetRegexRules.layers,
                count: regexResolution.presetRegexRules.count
            },
            globalRegexRules: {
                source: normalizePresetSummarySource(regexResolution.globalRegexRules.source),
                count: regexResolution.globalRegexRules.count
            }
        };
    };

    const buildCharacterMetadataPlan = (characterName) => {
        const { metadata } = characterManager.extractSillyTavernMetadata(characterName);
        const compatibleRegexScripts = (metadata?.regexScripts || []).filter(isBackendCompatibleRegexRule);
        const preferredPreset = metadata?.preferredPreset || null;
        const plan = {
            importWorldBook: !!(metadata?.hasEmbeddedWorldBook && metadata?.worldBook),
            importPreset: !!(
                preferredPreset?.systemPrompt
                || preferredPreset?.postHistoryInstructions
                || preferredPreset?.assistantPrefill
                || metadata?.postHistoryInstructions
                || metadata?.systemPrompt
            ),
            importRegex: compatibleRegexScripts.length > 0
        };

        return { metadata, plan, compatibleRegexScripts };
    };

    const applyCharacterMetadata = async (characterName, options = {}) => {
        const { metadata, plan, compatibleRegexScripts } = buildCharacterMetadataPlan(characterName);
        const applied = [];

        const finalOptions = {
            importWorldBook: options.importWorldBook ?? plan.importWorldBook,
            importPreset: options.importPreset ?? plan.importPreset,
            importRegex: options.importRegex ?? plan.importRegex
        };

        if (finalOptions.importWorldBook && metadata.hasEmbeddedWorldBook && metadata.worldBook) {
            const worldbookFilename = `${sanitizeFilename(metadata.name)}'s Lorebook.json`;
            const worldbookPath = path.join(config.chat.dataDir || './data', 'worlds', worldbookFilename);

            // 读取已存在的独立世界书（保留之前合并的变量条目等）
            let extraEntries = [];
            try {
                const existingRaw = await fs.readFile(worldbookPath, 'utf-8');
                const existing = JSON.parse(existingRaw);
                const existingKeys = new Set((metadata.worldBook.entries || []).map(e => JSON.stringify(e.keys || e.key || '')));
                extraEntries = (existing.entries || []).filter(e => {
                    const ek = JSON.stringify(e.keys || e.key || '');
                    return !existingKeys.has(ek);
                });
            } catch { /* 文件不存在, 无额外条目 */ }

            // 扫描卡内变量, 自动生成变量初始化条目
            try {
                const cardSources = buildCharacterVariableSources(characterName, metadata);
                const varScan = scanVariableUsage(cardSources);
                if (!extraEntries.some(e => (e.id || e.uid) === 1001) && varScan.writes.length === 0) {
                    // 生成通用变量追踪条目
                    const initVars = ['好感度', '关系状态', '心情', '今日互动次数'];
                    const initContent = initVars.map(k => `{{setvar::${k}::0}}`).join('');
                    extraEntries.push({
                        id: 1001,
                        keys: [`${sanitizeFilename(metadata.name)}_变量初始化`],
                        secondary_keys: [],
                        content: initContent,
                        constant: true,
                        enabled: true,
                        selective: false,
                        position: 'before_char',
                        insertion_order: 1000,
                        comment: '自动生成的通用变量初始化'
                    });
                    extraEntries.push({
                        id: 1002,
                        keys: [`${sanitizeFilename(metadata.name)}_变量更新`],
                        secondary_keys: [],
                        content: `[变量更新规则]\n在回复末尾如有变化，输出：\n<UpdateVariable>\n[{"op":"replace","path":"/变量名","value":数值}]\n</UpdateVariable>\n跟踪变量：${initVars.join('、')}`,
                        constant: true,
                        enabled: true,
                        selective: false,
                        position: 'after_char',
                        insertion_order: 999,
                        comment: '自动生成的变量更新规则'
                    });
                }
            } catch { /* 变量扫描失败不影响世界书提取 */ }

            const worldbook = {
                name: `${metadata.name} 世界书`,
                description: `从角色卡 ${metadata.name} 自动提取的世界书`,
                entries: [...(metadata.worldBook.entries || []), ...extraEntries]
            };

            await fs.writeFile(worldbookPath, JSON.stringify(worldbook, null, 2), 'utf-8');
            await worldBookManager.scanWorldBooks();
            const binding = getCharacterBinding(characterName);
            binding.importedFromCard.worldbook = worldbookFilename;
            applied.push(`已自动加载内嵌世界书 (${metadata.worldBookEntries} 条)`);
        }

        if (finalOptions.importPreset) {
            const preferredPreset = metadata?.preferredPreset || {};
            const hasPresetFields = !!(
                preferredPreset.systemPrompt
                || preferredPreset.postHistoryInstructions
                || preferredPreset.assistantPrefill
                || metadata?.postHistoryInstructions
                || metadata?.systemPrompt
            );

            if (hasPresetFields) {
                const binding = getCharacterBinding(characterName);
                binding.importedFromCard.preset = PromptBuilder.normalizePreset({
                    enabled: true,
                    name: preferredPreset.name,
                    systemPrompt: preferredPreset.systemPrompt ?? metadata?.systemPrompt,
                    postHistoryInstructions: preferredPreset.postHistoryInstructions ?? metadata?.postHistoryInstructions,
                    assistantPrefill: preferredPreset.assistantPrefill,
                    jailbreak: binding.preset?.jailbreak || config.preset?.jailbreak || '',
                    regexRules: []
                });
                applied.push('已自动同步角色卡中的预设相关字段');
            }
        }

        if (finalOptions.importRegex && compatibleRegexScripts.length > 0) {
            const importedRules = RegexProcessor.importRules({ rules: compatibleRegexScripts });
            if (!Array.isArray(config.regex.rules)) {
                config.regex.rules = [];
            }

            const existingKeys = new Set(config.regex.rules.map((rule) => `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`));
            const nextRules = importedRules.filter((rule) => {
                const key = `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`;
                if (existingKeys.has(key)) {
                    return false;
                }
                existingKeys.add(key);
                return true;
            });

            if (nextRules.length > 0) {
                const binding = getCharacterBinding(characterName);
                binding.importedFromCard.regexRules = nextRules;
                applied.push(`已自动导入 ${nextRules.length} 条角色卡附带正则`);
            }
        }

        saveConfig(config);
        return metadata ? { metadata, applied, plan, options: finalOptions } : { metadata: null, applied, plan, options: finalOptions };
    };

    const summarizeCharacterMetadata = (metadata) => ({
        hasEmbeddedWorldBook: !!metadata?.hasEmbeddedWorldBook,
        worldBookEntries: metadata?.worldBookEntries || 0,
        regexScriptCount: Array.isArray(metadata?.regexScripts) ? metadata.regexScripts.length : 0,
        importableRegexScriptCount: Array.isArray(metadata?.regexScripts)
            ? metadata.regexScripts.filter(isBackendCompatibleRegexRule).length
            : 0,
        alternateGreetingsCount: Array.isArray(metadata?.alternateGreetings) ? metadata.alternateGreetings.length : 0,
        hasPostHistoryInstructions: !!(metadata?.preferredPreset?.postHistoryInstructions || metadata?.postHistoryInstructions),
        hasSystemPrompt: !!(metadata?.preferredPreset?.systemPrompt || metadata?.systemPrompt),
        tags: Array.isArray(metadata?.tags) ? metadata.tags : [],
        creatorNotes: metadata?.creatorNotes || '',
        spec: metadata?.spec || '',
        specVersion: metadata?.specVersion || ''
    });

    const getActiveMemoryInfo = () => {
        const currentCharacterName = config.chat.defaultCharacter || null;
        const binding = currentCharacterName ? getBindingSummary(currentCharacterName) : null;
        return {
            currentCharacter: currentCharacterName,
            dbPath: sessionManager.getDbPath(),
            sessionMode: config.chat?.sessionMode || 'user_persistent',
            accessControlMode: config.chat?.accessControlMode || 'allowlist',
            adminUsers: config.chat?.adminUsers || [],
            scopeDescription: {
                user_persistent: '同一 QQ 跨群/跨私聊共享长期记忆',
                group_user: '每个群内每个用户单独记忆',
                group_shared: '同一群共享一份记忆',
                global_shared: '所有来源共享一份记忆'
            }[config.chat?.sessionMode || 'user_persistent'],
            binding
        };
    };

    const buildCharacterVariableSources = (characterName, metadata = {}) => {
        const character = characterManager.readFromPng(characterName);
        const preferredPreset = metadata?.preferredPreset || {};
        const worldBookEntries = Array.isArray(metadata?.worldBook?.entries)
            ? metadata.worldBook.entries
            : Object.values(metadata?.worldBook?.entries || {});

        const sources = [
            { name: 'character.description', content: character.description || character.data?.description || '' },
            { name: 'character.personality', content: character.personality || character.data?.personality || '' },
            { name: 'character.scenario', content: character.scenario || character.data?.scenario || '' },
            { name: 'character.first_mes', content: character.first_mes || character.data?.first_mes || '' },
            { name: 'character.mes_example', content: character.mes_example || character.data?.mes_example || '' },
            { name: 'character.system_prompt', content: character.system_prompt || character.data?.system_prompt || '' },
            { name: 'character.post_history_instructions', content: character.post_history_instructions || character.data?.post_history_instructions || '' },
            { name: 'preset.systemPrompt', content: preferredPreset.systemPrompt || '' },
            { name: 'preset.postHistoryInstructions', content: preferredPreset.postHistoryInstructions || '' },
            { name: 'preset.assistantPrefill', content: preferredPreset.assistantPrefill || '' }
        ];

        for (let index = 0; index < worldBookEntries.length; index += 1) {
            const entry = worldBookEntries[index] || {};
            sources.push({
                name: `worldbook.${index}`,
                content: typeof entry.content === 'string' ? entry.content : ''
            });
        }

        // 也扫描独立的已加载世界书（如变量追踪世界书）
        try {
            const standaloneWb = worldBookManager.readWorldBook(characterName);
            if (standaloneWb) {
                const standaloneEntries = Array.isArray(standaloneWb.entries)
                    ? standaloneWb.entries
                    : Object.values(standaloneWb.entries || {});
                for (let index = 0; index < standaloneEntries.length; index += 1) {
                    const entry = standaloneEntries[index] || {};
                    sources.push({
                        name: `standalone_wb.${index}`,
                        content: typeof entry.content === 'string' ? entry.content : ''
                    });
                }
            }
        } catch { /* 无独立世界书，跳过 */ }

        for (const rule of Array.isArray(metadata?.regexScripts) ? metadata.regexScripts : []) {
            const text = [rule?.findRegex, rule?.replaceString, rule?.prompt, rule?.comment]
                .filter((item) => typeof item === 'string' && item.trim())
                .join('\n');
            if (text) {
                sources.push({ name: `regex.${rule?.scriptName || rule?.name || 'rule'}`, content: text });
            }
        }

        return sources;
    };

    const applyCharacterVariableInitializers = (characterName, metadata = {}) => {
        const hasActualPreset = !!(metadata?.preferredPreset?.systemPrompt || metadata?.preferredPreset?.postHistoryInstructions);
        const scopeOptions = normalizeKnowledgeScopeInput({
            scopeType: config.chat?.sessionMode || 'user_persistent',
            scopeKey: 'default',
            characterName,
            presetName: hasActualPreset ? (metadata?.preferredPreset?.name || '') : ''
        });
        const scanResult = scanVariableUsage(buildCharacterVariableSources(characterName, metadata));
        const applied = applyScannedVariableInitializers(scanResult, sessionManager, scopeOptions, { skipExisting: true });
        return {
            scopeOptions,
            scanResult,
            applied,
            summary: {
                readCount: scanResult.reads.length,
                writeCount: scanResult.writes.length,
                appliedCount: applied.length,
                unsupportedCount: scanResult.unsupported.length,
                updateProtocol: scanResult.updateProtocol
            }
        };
    };


    const normalizeOptionalText = (value) => {
        const text = typeof value === 'string' ? value.trim() : '';
        return text || null;
    };

    const normalizeVariableScopeInput = (input = {}) => ({
        scopeType: normalizeOptionalText(input.scopeType) || (config.chat?.sessionMode || 'user_persistent'),
        scopeKey: normalizeOptionalText(input.scopeKey) || 'default',
        characterName: normalizeOptionalText(input.characterName),
        presetName: normalizeOptionalText(input.presetName)
    });

    const normalizeKnowledgeCharacterInput = (input = {}) => ({
        characterName: normalizeOptionalText(input.characterName)
            || normalizeOptionalText(input.character)
            || normalizeOptionalText(input.roleName)
            || normalizeOptionalText(input.role),
        presetName: normalizeOptionalText(input.presetName)
            || normalizeOptionalText(input.preset)
    });

    const normalizeKnowledgeScopeInput = (input = {}) => {
        const normalizedScope = normalizeVariableScopeInput(input);
        const normalizedCharacter = normalizeKnowledgeCharacterInput(input);
        return {
            ...normalizedScope,
            characterName: normalizedCharacter.characterName || normalizedScope.characterName,
            presetName: normalizedCharacter.presetName || normalizedScope.presetName
        };
    };

    const sanitizePathForClient = (value) => {
        if (typeof value !== 'string' || !value) {
            return value;
        }
        if (!path.isAbsolute(value)) {
            return value;
        }
        const relative = path.relative(process.cwd(), value);
        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return `./${relative.replace(/\\/g, '/')}`;
        }
        return path.basename(value);
    };

    const stripAbsolutePaths = (value) => {
        if (typeof value === 'string') {
            return /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(value) ? sanitizePathForClient(value) : value;
        }
        if (Array.isArray(value)) {
            return value.map((item) => stripAbsolutePaths(item));
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, stripAbsolutePaths(item)]));
        }
        return value;
    };

    const normalizeSearchQuery = (query = {}) => ({
        q: normalizeOptionalText(query.q || query.query || query.keyword),
        limit: Math.min(Math.max(Number(query.limit) || 8, 1), 20)
    });

    const fuzzyMatch = (value, query) => {
        const v = String(value || '').toLowerCase();
        const q = String(query || '').toLowerCase();
        if (!q) return true;
        if (v.includes(q)) return true;
        let qi = 0;
        for (let vi = 0; vi < v.length && qi < q.length; vi++) {
            if (v[vi] === q[qi]) qi++;
        }
        return qi === q.length;
    };

    const includesSearchText = (value, query) => fuzzyMatch(value, query);

    const buildSearchResult = ({ type, title, subtitle = '', preview = '', panelId, entryId = '', score = 1, action = {} }) => ({
        type,
        title: String(title || '').trim(),
        subtitle: String(subtitle || '').trim(),
        preview: String(preview || '').trim(),
        panelId,
        entryId: String(entryId || ''),
        score,
        action
    });

    const limitSearchGroup = (items, limit) => items
        .filter((item) => item.title || item.preview)
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, limit);

    const searchStaticEntries = (items, query, mapper) => items
        .map((item, index) => mapper(item, index))
        .filter((item) => [item.title, item.subtitle, item.preview].some((value) => includesSearchText(value, query)));
    const normalizeVariableFilters = (query = {}) => ({
        scopeType: normalizeOptionalText(query.scopeType),
        scopeKey: normalizeOptionalText(query.scopeKey),
        characterName: normalizeOptionalText(query.characterName),
        presetName: normalizeOptionalText(query.presetName),
        search: normalizeOptionalText(query.search),
        limit: Math.min(Math.max(Number(query.limit) || 100, 1), 500)
    });

    const normalizeVariablePayload = (body = {}) => {
        const key = typeof body.key === 'string' ? body.key.trim() : '';
        if (!key) {
            throw new Error('变量名不能为空');
        }

        return {
            key,
            valueType: typeof body.valueType === 'string' ? body.valueType.trim() : 'string',
            rawValue: typeof body.rawValue === 'string' ? body.rawValue : '',
            tags: Array.isArray(body.tags) ? body.tags : [],
            source: 'admin',
            metadata: {
                ...(body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : {}),
                note: normalizeOptionalText(body.note),
                updatedBy: normalizeOptionalText(body.updatedBy) || 'admin-panel',
                source: 'admin'
            }
        };
    };

    const normalizeKnowledgeFilters = (query = {}) => {
        const scope = normalizeKnowledgeScopeInput(query);
        return {
            scopeType: scope.scopeType,
            scopeKey: scope.scopeKey,
            characterName: scope.characterName,
            presetName: scope.presetName,
            search: normalizeOptionalText(query.search),
            knowledgeType: normalizeOptionalText(query.knowledgeType),
            limit: Math.min(Math.max(Number(query.limit) || 100, 1), 500)
        };
    };

    const normalizeKnowledgePayload = (body = {}) => {
        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
            throw new Error('知识标题不能为空');
        }

        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
            throw new Error('知识内容不能为空');
        }

        const knowledgeType = normalizeOptionalText(body.knowledgeType) === 'fixed' ? 'fixed' : 'dynamic';
        const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata
            : {};

        return {
            entryId: normalizeOptionalText(body.id || body.entryId),
            title,
            content,
            knowledgeType,
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            metadata: {
                ...metadata,
                note: normalizeOptionalText(body.note ?? metadata.note),
                updatedBy: normalizeOptionalText(body.updatedBy ?? metadata.updatedBy) || 'admin-panel',
                source: normalizeOptionalText(body.source ?? metadata.source) || 'admin',
                knowledgeType
            }
        };
    };

    const normalizeKnowledgeImportPayload = (body = {}) => {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) {
            throw new Error('导入文本不能为空');
        }

        const title = normalizeOptionalText(body.title) || '小说导入';
        const knowledgeType = normalizeOptionalText(body.knowledgeType) === 'dynamic' ? 'dynamic' : 'fixed';
        const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata
            : {};
        const requestedChunkSize = Number(body.chunkSize);
        const chunkSize = Number.isFinite(requestedChunkSize)
            ? Math.min(Math.max(Math.floor(requestedChunkSize), 200), 4000)
            : 1200;

        return {
            text,
            title,
            knowledgeType,
            chunkSize,
            tags: Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()) : [],
            metadata: {
                ...metadata,
                note: normalizeOptionalText(body.note ?? metadata.note),
                updatedBy: normalizeOptionalText(body.updatedBy ?? metadata.updatedBy) || 'admin-panel',
                source: normalizeOptionalText(body.source ?? metadata.source) || 'novel-import',
                importTitle: title,
                knowledgeType
            }
        };
    };

    const splitImportedNovelText = (text, maxChunkLength = 1200) => {
        const normalized = String(text || '').replace(/\r\n/g, '\n').trim();
        if (!normalized) {
            return [];
        }

        const normalizedMaxChunkLength = Math.min(Math.max(Number(maxChunkLength) || 1200, 200), 4000);
        const paragraphs = normalized
            .split(/\n{2,}/)
            .map((part) => part.trim())
            .filter(Boolean);
        const chunks = [];
        let current = '';

        const flushCurrent = () => {
            const trimmed = current.trim();
            if (trimmed) {
                chunks.push(trimmed);
            }
            current = '';
        };

        const pushWithSentenceFallback = (paragraph) => {
            const sentences = paragraph.match(/[^。！？!?\n]+[。！？!?]?/g) || [paragraph];
            let buffer = '';
            for (const sentence of sentences) {
                const trimmedSentence = sentence.trim();
                if (!trimmedSentence) {
                    continue;
                }

                const candidate = buffer ? `${buffer}${trimmedSentence}` : trimmedSentence;
                if (candidate.length <= normalizedMaxChunkLength) {
                    buffer = candidate;
                    continue;
                }

                if (buffer) {
                    chunks.push(buffer.trim());
                    buffer = '';
                }

                if (trimmedSentence.length <= normalizedMaxChunkLength) {
                    buffer = trimmedSentence;
                    continue;
                }

                for (let offset = 0; offset < trimmedSentence.length; offset += normalizedMaxChunkLength) {
                    const piece = trimmedSentence.slice(offset, offset + normalizedMaxChunkLength).trim();
                    if (piece) {
                        chunks.push(piece);
                    }
                }
            }

            if (buffer.trim()) {
                chunks.push(buffer.trim());
            }
        };

        for (const paragraph of paragraphs.length > 0 ? paragraphs : [normalized]) {
            if (paragraph.length > normalizedMaxChunkLength) {
                flushCurrent();
                pushWithSentenceFallback(paragraph);
                continue;
            }

            const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
            if (candidate.length <= normalizedMaxChunkLength) {
                current = candidate;
            } else {
                flushCurrent();
                current = paragraph;
            }
        }

        flushCurrent();
        return chunks;
    };

    const buildImportedKnowledgeTitle = (baseTitle, index, total) => {
        const normalizedBaseTitle = normalizeOptionalText(baseTitle) || '小说导入';
        if (total <= 1) {
            return normalizedBaseTitle;
        }
        return `${normalizedBaseTitle} · 第${index + 1}/${total}段`;
    };

    const buildKnowledgeImportPrompt = ({ title, chunk, chunkIndex, totalChunks, knowledgeType }) => ([
        {
            role: 'system',
            content: [
                '你是小说知识整理助手。',
                '任务是把原文片段提炼成适合写入知识库的结构化知识。',
                '严禁原样大段摘抄原文，输出必须是经过提炼后的知识。',
                '保留人物、身份、关系、事件、目标、设定、地点、规则、冲突、线索等高价值信息。',
                '输出严格 JSON，不要使用 Markdown 代码块，不要解释。',
                'JSON 格式: {"entries":[{"title":"知识标题","content":"提炼后的知识内容","tags":["标签1","标签2"]}] }',
                'entries 最多 5 条；title 简洁明确；content 使用简体中文，写成可检索、可复用的知识描述。',
                `knowledgeType 固定为 ${knowledgeType === 'dynamic' ? 'dynamic' : 'fixed'}。`
            ].join('\n')
        },
        {
            role: 'user',
            content: [
                `知识库主题: ${title || '小说导入'}`,
                `当前分块: ${chunkIndex + 1}/${totalChunks}`,
                '请从下面片段中提炼知识：',
                chunk
            ].join('\n\n')
        }
    ]);

    const stripJsonCodeFence = (text = '') => {
        const normalized = String(text || '').trim();
        if (!normalized.startsWith('```')) {
            return normalized;
        }
        return normalized
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
    };

    const parseKnowledgeImportAIResponse = (text = '') => {
        const normalized = stripJsonCodeFence(text);
        if (!normalized) {
            throw new Error('AI 未返回可解析的知识内容');
        }

        let parsed;
        try {
            parsed = JSON.parse(normalized);
        } catch (error) {
            throw new Error('AI 返回结果不是合法 JSON');
        }

        const rawEntries = Array.isArray(parsed)
            ? parsed
            : (Array.isArray(parsed?.entries) ? parsed.entries : []);

        const entries = rawEntries
            .map((item, index) => {
                const title = normalizeOptionalText(item?.title) || `提炼知识 ${index + 1}`;
                const content = normalizeOptionalText(item?.content)
                    || normalizeOptionalText(item?.summary)
                    || normalizeOptionalText(item?.description)
                    || normalizeOptionalText(item?.text);
                const tags = Array.isArray(item?.tags)
                    ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim()).slice(0, 8)
                    : [];

                if (!content) {
                    return null;
                }

                return {
                    title,
                    content,
                    tags
                };
            })
            .filter(Boolean)
            .slice(0, 5);

        if (entries.length === 0) {
            throw new Error('AI 未提炼出有效知识条目');
        }

        return entries;
    };

    const normalizeParticipantProfilePayload = (body = {}) => {
        const entryId = normalizeOptionalText(body.id || body.entryId);
        if (!entryId) {
            throw new Error('人物档案 ID 不能为空');
        }

        const title = typeof body.title === 'string' ? body.title.trim() : '';
        if (!title) {
            throw new Error('人物档案标题不能为空');
        }

        const content = typeof body.content === 'string' ? body.content.trim() : '';
        if (!content) {
            throw new Error('人物档案内容不能为空');
        }

        const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
            ? body.metadata
            : {};

        return {
            entryId,
            title,
            content,
            tags: Array.isArray(body.tags) ? body.tags : undefined,
            metadata: {
                ...metadata,
                note: normalizeOptionalText(body.note ?? metadata.note),
                updatedBy: normalizeOptionalText(body.updatedBy ?? metadata.updatedBy) || 'admin-panel',
                editedBy: normalizeOptionalText(body.editedBy ?? metadata.editedBy) || 'admin-panel',
                source: normalizeOptionalText(metadata.source) || 'participant_profile'
            }
        };
    };

    const listKnownMemoryDatabases = async () => {
        const dataDir = config.chat.dataDir || './data';
        const baseDir = path.join(dataDir, 'chats');
        await fs.mkdir(baseDir, { recursive: true });

        const files = new Map();
        const rememberFile = async (fullPath) => {
            const normalizedPath = path.isAbsolute(fullPath) ? fullPath : path.resolve(process.cwd(), fullPath);
            if (files.has(normalizedPath)) {
                return files.get(normalizedPath);
            }

            try {
                const stat = await fs.stat(normalizedPath);
                const item = { path: normalizedPath, sizeBytes: stat.size, updatedAt: stat.mtimeMs, bindings: [] };
                files.set(normalizedPath, item);
                return item;
            } catch {
                const item = { path: normalizedPath, sizeBytes: 0, updatedAt: 0, bindings: [], missing: true };
                files.set(normalizedPath, item);
                return item;
            }
        };

        const walk = async (dir) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    await walk(fullPath);
                    continue;
                }
                if (entry.name.endsWith('.sqlite')) {
                    await rememberFile(fullPath);
                }
            }
        };

        await walk(baseDir);

        const bindDb = async (dbPath, bindingInfo) => {
            if (!dbPath) {
                return;
            }
            const item = await rememberFile(dbPath);
            item.bindings.push(bindingInfo);
        };

        await bindDb(config.bindings?.global?.memoryDbPath || config.memory?.storage?.path, { type: 'global-default', name: '全局默认记忆库' });
        for (const [characterName, binding] of Object.entries(config.bindings?.characters || {})) {
            if (binding?.memoryDbPath) {
                await bindDb(binding.memoryDbPath, { type: 'character', name: characterName });
            }
        }

        return Array.from(files.values()).sort((a, b) => b.updatedAt - a.updatedAt);
    };

    const applyRuntimeConfig = () => {
        aiClient.updateConfig(config.ai || {});
        sessionManager.setConfig(config);
        const currentCharacter = config.chat?.defaultCharacter || '';
        const effectiveBinding = currentCharacter ? PromptBuilder.getEffectiveBinding(config, currentCharacter) : PromptBuilder.getEffectiveBinding(config, '');
        regexProcessor.updateConfig(
            config.regex || {},
            effectiveBinding.regexRules,
            effectiveBinding.presetRegexRules,
            effectiveBinding.globalRegexRules
        );
        promptBuilder.updateConfig(config);
        runtime?.updateConfig(config);
        clearParticipantProfileTimers?.();
    };

    const mergeConfig = (target, source) => {
        for (const [key, value] of Object.entries(source || {})) {
            if (value && typeof value === 'object' && !Array.isArray(value)) {
                target[key] = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
                    ? target[key]
                    : {};
                mergeConfig(target[key], value);
            } else {
                target[key] = value;
            }
        }
    };

    const normalizeAccessControlConfig = () => {
        config.chat = config.chat || {};
        const mode = config.chat.accessControlMode || 'allowlist';

        if (mode === 'blocklist') {
            config.chat.allowedGroups = [];
            config.chat.allowedUsers = [];
        }

        if (mode === 'allowlist') {
            config.chat.blockedGroups = [];
            config.chat.blockedUsers = [];
        }

        if (mode === 'disabled') {
            config.chat.allowedGroups = [];
            config.chat.allowedUsers = [];
            config.chat.blockedGroups = [];
            config.chat.blockedUsers = [];
        }
    };

    // ==================== 认证中间件 ====================
    
    // 检查是否需要认证
    const requireAuth = (req, res, next) => {
        // 如果认证未启用，直接通过
        if (!config.auth?.enabled) {
            logger.debug(`[API ${req.requestId || 'no-id'}] auth bypassed (disabled)`);
            return next();
        }
        
        // 检查是否已登录
        if (req.session?.authenticated) {
            logger.debug(`[API ${req.requestId || 'no-id'}] auth passed`, { username: req.session?.username || null });
            return next();
        }
        
        // 未登录，返回 401
        logger.warn(`[API ${req.requestId || 'no-id'}] auth failed`, {
            originalUrl: req.originalUrl,
            referer: req.headers.referer || '',
            cookiesPresent: !!req.headers.cookie
        });
        res.status(401).json({ error: '未登录', needLogin: true });
    };

    // ==================== 登录相关路由 ====================

    // 检查登录状态
    app.get('/api/auth/status', (req, res) => {
        if (!config.auth?.enabled) {
            return res.json({ enabled: false, authenticated: true });
        }
        res.json({ 
            enabled: true, 
            authenticated: req.session?.authenticated || false,
            username: req.session?.username || null,
            expiresAt: req.session?.cookie?.expires || null
        });
    });

    // 登录
    app.post('/api/auth/login', (req, res) => {
        if (!config.auth?.enabled) {
            return res.json({ success: true, message: '认证未启用' });
        }
        
        const { username, password, rememberMe } = req.body;
        
        if (username === config.auth.username && password === config.auth.password) {
            req.session.authenticated = true;
            req.session.username = username;
            const longDays = config.auth.sessionDays ?? 30;
            const shortHours = config.auth.shortSessionHours ?? 12;
            req.session.cookie.maxAge = rememberMe
                ? longDays * 24 * 60 * 60 * 1000
                : shortHours * 60 * 60 * 1000;
            logger.info(`用户 ${username} 登录成功`);
            res.json({ success: true, message: '登录成功', expiresInMs: req.session.cookie.maxAge });
        } else {
            logger.warn(`登录失败: 用户名或密码错误`);
            res.status(401).json({ success: false, error: '用户名或密码错误' });
        }
    });

    // 登出
    app.post('/api/auth/logout', (req, res) => {
        if (req.session) {
            req.session.destroy();
        }
        res.json({ success: true, message: '已登出' });
    });

    // 文件上传配置
    const storage = multer.diskStorage({
        destination: (req, file, cb) => {
            const isCharacter = req.path.includes('/characters/');
            const isWorldbook = req.path.includes('/worldbooks/');
            let destDir;
            if (isCharacter) {
                destDir = path.join(config.chat.dataDir || './data', 'characters');
            } else if (isWorldbook) {
                destDir = path.join(config.chat.dataDir || './data', 'worlds');
            } else {
                destDir = config.chat.dataDir || './data';
            }
            // 确保目录存在
            fs.mkdir(destDir, { recursive: true }).then(() => cb(null, destDir)).catch(err => cb(err));
        },
        filename: (req, file, cb) => {
            // 保持原文件名，处理中文编码
            const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, originalName);
        }
    });
    
    const upload = multer({ 
        storage,
        fileFilter: (req, file, cb) => {
            const isCharacter = req.path.includes('/characters/');
            const isWorldbook = req.path.includes('/worldbooks/');
            if (isCharacter && !file.originalname.toLowerCase().endsWith('.png')) {
                cb(new Error('角色卡必须是 PNG 格式'));
            } else if (isWorldbook && !file.originalname.toLowerCase().endsWith('.json')) {
                cb(new Error('世界书必须是 JSON 格式'));
            } else {
                cb(null, true);
            }
        },
        limits: { fileSize: 50 * 1024 * 1024 } // 50MB 限制
    });

    // ==================== 配置管理 ====================

    // 获取配置（需要认证）
    app.get('/api/config', requireAuth, (req, res) => {
        ensureImportsConfig();
        // 隐藏敏感信息，仅返回是否已配置，避免接口泄露密钥或口令
        const safeAIProviders = Array.isArray(config.ai?.providers)
            ? config.ai.providers.map((provider) => {
                const { apiKey, ...safeProvider } = provider;
                return {
                    ...safeProvider,
                    hasApiKey: Boolean(apiKey)
                };
            })
            : [];
        const { apiKey: webSearchApiKey, ...safeWebSearchConfig } = config.ai?.tools?.webSearch || {};
        safeWebSearchConfig.hasApiKey = Boolean(webSearchApiKey);
        const { password, sessionSecret, ...safeAuthConfig } = config.auth || {};
        safeAuthConfig.passwordSet = Boolean(password);
        safeAuthConfig.sessionSecretSet = Boolean(sessionSecret);
        const { accessToken, ...safeOneBotConfig } = config.onebot || {};
        safeOneBotConfig.hasAccessToken = Boolean(accessToken);
        const { apiKey: ttsApiKey, ...safeTtsConfig } = config.tts || {};
        safeTtsConfig.hasApiKey = Boolean(ttsApiKey);
        const { apiKey: participantProfileApiKey, ...safeParticipantProfileConfig } = config.memory?.participantProfile || {};
        safeParticipantProfileConfig.hasApiKey = Boolean(participantProfileApiKey);
        const safeConfig = {
            ...config,
            auth: safeAuthConfig,
            onebot: safeOneBotConfig,
            imports: {
                ...(config.imports || {}),
                presetFiles: config.imports.presetFiles.map((record) => summarizePresetImportRecord(record)),
                regexFiles: config.imports.regexFiles.map((record) => summarizeRegexImportRecord(record))
            },
            ai: {
                ...config.ai,
                apiKey: undefined,
                hasApiKey: Boolean(config.ai.apiKey),
                providers: safeAIProviders,
                tools: {
                    ...(config.ai?.tools || {}),
                    webSearch: safeWebSearchConfig
                }
            },
            tts: safeTtsConfig,
            memory: {
                ...(config.memory || {}),
                participantProfile: safeParticipantProfileConfig
            }
        };
        delete safeConfig.ai.apiKey;
        res.json(safeConfig);
    });

    // 更新配置（需要认证）
	app.post('/api/config', requireAuth, async (req, res) => {
		try {
			const newConfig = req.body;

			if (newConfig?.onebot?.accessToken === '******') {
				delete newConfig.onebot.accessToken;
			}
            if (Array.isArray(newConfig?.ai?.providers)) {
                const existingProviders = new Map((config.ai?.providers || []).map((provider) => [provider.id, provider]));
                newConfig.ai.providers = newConfig.ai.providers.map((provider) => {
                    if (provider?.apiKey === '******') {
                        const existingApiKey = existingProviders.get(provider.id)?.apiKey
                            || ((provider.id === config.ai?.activeProviderId || provider.id === 'default') ? config.ai?.apiKey : '')
                            || '';
                        return {
                            ...provider,
                            apiKey: existingApiKey
                        };
                    }
                    return provider;
                });
            }
			if (newConfig?.ai?.apiKey === '******') {
				delete newConfig.ai.apiKey;
			}
            if (newConfig?.ai?.tools?.webSearch?.apiKey === '******') {
                newConfig.ai.tools.webSearch.apiKey = config.ai?.tools?.webSearch?.apiKey || '';
            }
            if (newConfig?.memory?.participantProfile?.apiKey === '******') {
                delete newConfig.memory.participantProfile.apiKey;
            }

			const onebotChanged = (
				newConfig.onebot?.url !== undefined && newConfig.onebot.url !== config.onebot?.url
				|| newConfig.onebot?.accessToken !== undefined && newConfig.onebot.accessToken !== config.onebot?.accessToken
				|| newConfig.onebot?.mode !== undefined && newConfig.onebot.mode !== config.onebot?.mode
				|| newConfig.onebot?.tokenMode !== undefined && newConfig.onebot.tokenMode !== config.onebot?.tokenMode
			);
			mergeConfig(config, newConfig);
			normalizeAccessControlConfig();
			applyRuntimeConfig();
            clearParticipantProfileTimers();
			saveConfig(config);
			if (onebotChanged && bot) {
				bot.reconnect();
				logger.info('OneBot 配置变更，自动重连');
			}

			logger.info(`[API ${req.requestId || 'no-id'}] 配置已更新`, {
                topLevelKeys: Object.keys(newConfig || {}),
                aiProvider: config.ai?.provider || '',
                model: config.ai?.model || '',
                defaultCharacter: config.chat?.defaultCharacter || '',
                ttsEnabled: !!config.tts?.enabled,
                knowledgeBases: Array.isArray(config.knowledgeBases) ? config.knowledgeBases.length : 0
            });
			res.json({ success: true, message: '配置已保存并立即生效（无需重启）' });
		} catch (error) {
			logger.error('保存配置失败', error);
			res.status(500).json({ success: false, error: error.message });
		}
	});

    // ==================== 角色卡管理 ====================

    // === 配置备份/恢复（tar.gz 全量打包） ===
    app.get('/api/config/backup', requireAuth, async (req, res) => {
        const tmpDir = path.join(__dirname, '..', 'data', '_backup_tmp');
        const includeKeys = req.query.includeKeys === 'true';
        const dateStr = new Date().toISOString().slice(0,10);
        const suffix = includeKeys ? 'full' : 'safe';
        const archiveName = `mimirlink-backup-${dateStr}-${suffix}.tar.gz`;
        try {
            const { pack } = await import('tar-fs');
            const { createGzip } = await import('zlib');
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
            fsSync.mkdirSync(tmpDir, { recursive: true });
            // config.json：根据 includeKeys 决定是否脱敏
            const exportConfig = includeKeys ? config : maskConfigSecrets(config);
            fsSync.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(exportConfig, null, 2), 'utf8');
            // 复制 data 目录
            const dataDir = config.chat?.dataDir || path.join(__dirname, '..', 'data');
            copyDirSync(dataDir, path.join(tmpDir, 'data'), new Set(['_backup_tmp', 'restore-backups']));
            // 流式打包
            res.setHeader('Content-Type', 'application/gzip');
            res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
            const gzip = createGzip();
            pack(tmpDir).pipe(gzip).pipe(res);
            res.on('finish', () => { try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
            logger.info(`[备份] ${includeKeys ? '含密钥' : '安全'}模式: ${archiveName}`);
        } catch (e) {
            try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            logger.error('[备份] 导出失败:', e.message);
            if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/config/restore', requireAuth, async (req, res) => {
        const tmpDir = path.join(__dirname, '..', 'data', '_restore_tmp');
        const changes = { replaced: [], merged: [], added: [], skipped: [] };
        try {
            const { extract } = await import('tar-fs');
            const { createGunzip } = await import('zlib');
            const { Writable } = await import('stream');
            // 接收 tar.gz 流，解压到临时目录
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
            fsSync.mkdirSync(tmpDir, { recursive: true });

            await new Promise((resolve, reject) => {
                const gunzip = createGunzip();
                const tarExtract = extract(tmpDir);
                req.pipe(gunzip).pipe(tarExtract);
                tarExtract.on('finish', resolve);
                tarExtract.on('error', reject);
                gunzip.on('error', reject);
                req.on('error', reject);
            });

            // === 恢复前自动备份 ===
            const autoBackupDir = path.join(__dirname, '..', 'data', 'restore-backups');
            fsSync.mkdirSync(autoBackupDir, { recursive: true });
            const autoBackupFile = `pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.tar.gz`;
            const { pack } = await import('tar-fs');
            const { createGzip } = await import('zlib');
            const dataDir = config.chat?.dataDir || path.join(__dirname, '..', 'data');
            fsSync.writeFileSync(path.join(tmpDir, '_current_config.json'), JSON.stringify(config, null, 2), 'utf8');
            const autoStream = pack(tmpDir).pipe(createGzip()).pipe(fsSync.createWriteStream(path.join(autoBackupDir, autoBackupFile)));

            // 读取备份中的 config.json
            const backupConfigPath = path.join(tmpDir, 'config.json');
            if (fsSync.existsSync(backupConfigPath)) {
                const backupConfig = JSON.parse(fsSync.readFileSync(backupConfigPath, 'utf8'));
                const merged = deepMergeConfig(config, backupConfig);
                // 将合并结果逐字段写回 config 对象（保留引用）
                for (const key of Object.keys(merged)) {
                    config[key] = merged[key];
                }
                // 删除备份中没有的 key（说明被故意移除）
                for (const key of Object.keys(config)) {
                    if (!(key in merged)) delete config[key];
                }
                saveConfig(config);
                changes.replaced.push('config.json');
            }

            // 复制备份中的 data 目录内容（智能合并）
            const backupDataDir = path.join(tmpDir, 'data');
            if (fsSync.existsSync(backupDataDir)) {
                const currentDataDir = config.chat?.dataDir || path.join(__dirname, '..', 'data');
                const skipDirs = new Set(['_backup_tmp', '_restore_tmp', 'restore-backups', 'chats']);
                mergeDirSync(backupDataDir, currentDataDir, skipDirs, changes);
            }

            // 清理
            await new Promise(r => autoStream.on('finish', r));
            fsSync.rmSync(tmpDir, { recursive: true, force: true });
            characterManager.clearCache?.();

            logger.info('[恢复] 完成:', JSON.stringify(changes));
            res.json({ success: true, changes, autoBackup: autoBackupFile });
        } catch (e) {
            try { fsSync.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
            logger.error('[恢复] 导入失败:', e.message);
            if (!res.headersSent) res.status(500).json({ success: false, error: e.message });
        }
    });

    // 递归复制目录（跳过指定目录名）
    function copyDirSync(src, dest, skipNames = new Set()) {
        fsSync.mkdirSync(dest, { recursive: true });
        for (const entry of fsSync.readdirSync(src, { withFileTypes: true })) {
            if (skipNames.has(entry.name)) continue;
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                copyDirSync(srcPath, destPath, skipNames);
            } else {
                fsSync.copyFileSync(srcPath, destPath);
            }
        }
    }

    // 智能合并目录：备份文件覆盖当前，但保留当前独有的文件
    function mergeDirSync(src, dest, skipNames, changes) {
        fsSync.mkdirSync(dest, { recursive: true });
        for (const entry of fsSync.readdirSync(src, { withFileTypes: true })) {
            if (skipNames.has(entry.name)) continue;
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
                mergeDirSync(srcPath, destPath, skipNames, changes);
            } else {
                const existed = fsSync.existsSync(destPath);
                fsSync.copyFileSync(srcPath, destPath);
                const relPath = path.relative(path.dirname(dest), destPath);
                changes[existed ? 'replaced' : 'added'].push(relPath);
            }
        }
    }

    // 安全深度合并 config：保护 API key，数组以备份为准但保留当前独有的项
    function deepMergeConfig(current, backup) {
        const merged = JSON.parse(JSON.stringify(current)); // 深拷贝当前
        for (const key of Object.keys(backup)) {
            if (key === 'ai' && backup.ai && current.ai) {
                // AI 配置特殊处理：保护 API keys
                merged.ai = { ...current.ai, ...backup.ai };
                if (current.ai.apiKey && backup.ai.apiKey === '******') {
                    merged.ai.apiKey = current.ai.apiKey;
                }
                // 合并 providers：备份的替换，但保留 key
                if (Array.isArray(backup.ai.providers) && Array.isArray(current.ai.providers)) {
                    const currentMap = new Map(current.ai.providers.map(p => [p.id, p]));
                    const backupMap = new Map(backup.ai.providers.map(p => [p.id, p]));
                    const mergedProviders = [];
                    // 备份中的 provider 覆盖当前
                    for (const bp of backup.ai.providers) {
                        const cp = currentMap.get(bp.id);
                        if (cp && bp.apiKey === '******') bp.apiKey = cp.apiKey;
                        mergedProviders.push(bp);
                    }
                    // 当前独有的 provider 保留
                    for (const cp of current.ai.providers) {
                        if (!backupMap.has(cp.id)) mergedProviders.push(cp);
                    }
                    merged.ai.providers = mergedProviders;
                }
                continue;
            }
            if (key === 'imports' && backup.imports && current.imports) {
                // 预设文件合并：去重 + 备份优先
                merged.imports = { ...current.imports, ...backup.imports };
                if (Array.isArray(backup.imports.presetFiles) && Array.isArray(current.imports.presetFiles)) {
                    const bIds = new Set(backup.imports.presetFiles.map(p => p.id));
                    merged.imports.presetFiles = [
                        ...current.imports.presetFiles.filter(p => !bIds.has(p.id)),
                        ...backup.imports.presetFiles
                    ];
                }
                continue;
            }
            // 普通字段：直接覆盖
            if (typeof backup[key] === 'object' && backup[key] !== null && !Array.isArray(backup[key])) {
                merged[key] = { ...(current[key] || {}), ...backup[key] };
            } else {
                merged[key] = backup[key];
            }
        }
        return merged;
    }

    // 脱敏 config：把 apiKey/accessToken/password/sessionSecret 替换为 ******
    function maskConfigSecrets(cfg) {
        const masked = JSON.parse(JSON.stringify(cfg));
        const maskKeys = ['apiKey', 'accessToken', 'password', 'sessionSecret', 'secret'];
        function walk(obj) {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
                if (maskKeys.includes(key) && typeof obj[key] === 'string' && obj[key].length > 0) {
                    obj[key] = '******';
                } else if (typeof obj[key] === 'object') {
                    walk(obj[key]);
                }
            }
        }
        walk(masked);
        return masked;
    }

    // 获取角色列表（需要认证）
    app.get('/api/characters', requireAuth, async (req, res) => {
        try {
            const filenames = characterManager.listCharacters();
            // 返回包含 name 和 filename 的对象数组
            const characters = filenames.map(filename => {
                try {
                    const char = characterManager.readFromPng(filename);
                    return {
                        name: char.name || filename,
                        filename: filename + '.png'
                    };
                } catch (e) {
                    return {
                        name: filename,
                        filename: filename + '.png'
                    };
                }
            });
            res.json(characters);
        } catch (error) {
            logger.error('获取角色列表失败', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 获取当前角色（需要认证）
    app.get('/api/characters/current', requireAuth, (req, res) => {
        const character = characterManager.getCurrentCharacter();
        if (character) {
            res.json(character);
        } else {
            res.status(404).json({ error: '未选择角色' });
        }
    });

    // 选择角色（需要认证）
    app.post('/api/characters/select', requireAuth, async (req, res) => {
        try {
            const { filename, importOptions, memoryBinding } = req.body;
            // 移除 .png 扩展名
            const characterName = filename.replace(/\.png$/i, '');
            const character = characterManager.loadCharacter(characterName);
            const characterMeta = await applyCharacterMetadata(characterName, importOptions || {});

            if (memoryBinding?.mode) {
                const binding = getCharacterBinding(characterName);
                if (memoryBinding.mode === 'inherit') {
                    binding.memoryDbPath = null;
                } else if (memoryBinding.mode === 'character') {
                    const normalizedName = characterName.replace(/[\\/:*?"<>|]/g, '_');
                    binding.memoryDbPath = memoryBinding.dbPath || `./data/chats/characters/${normalizedName}.sqlite`;
                } else if (memoryBinding.mode === 'custom' && memoryBinding.dbPath) {
                    binding.memoryDbPath = memoryBinding.dbPath;
                }

                if (memoryBinding.migrateFromCurrent === true && binding.memoryDbPath) {
                    const snapshot = sessionManager.exportMemory();
                    const TargetManagerClass = sessionManager.constructor;
                    const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    targetManager.setConfig(config, { storagePath: binding.memoryDbPath });
                    targetManager.importMemorySnapshot(snapshot, { replace: true });
                }
            }
            
            // 更新配置并保存，确保重启后仍然使用选择的角色
            config.chat.defaultCharacter = characterName;
            if (memoryBinding?.mode) {
                const binding = getCharacterBinding(characterName);
                sessionManager.setConfig(config, { storagePath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }
            saveConfig(config);
            
            // 自动加载角色绑定的世界书
            if (characterMeta.applied?.some(a => a.includes('内嵌世界书'))) {
                const binding = getCharacterBinding(characterName);
                const wbFile = binding.importedFromCard?.worldbook || binding.worldbook;
                if (wbFile) {
                    try {
                        worldBookManager.loadWorldBook(wbFile);
                        logger.info(`已自动加载世界书: ${wbFile}`);
                    } catch (e) { logger.warn(`加载世界书失败: ${wbFile}`, e.message); }
                }
            }

            const varInit = applyCharacterVariableInitializers(characterName, characterMeta.metadata);
            logger.info(`已选择角色: ${characterName}`, {
                varReads: varInit.summary.readCount,
                varWrites: varInit.summary.appliedCount,
                varUnsupported: varInit.summary.unsupportedCount,
                varKeys: varInit.applied.map(i => `${i.key}=${i.parsedValue}`).join(', ') || '无'
            });
            res.json({
                success: true,
                character,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                appliedActions: [...characterMeta.applied, ...varInit.applied.map(i =>
                    `变量初始化: ${i.key} = ${String(i.parsedValue).slice(0, 40)}`
                )],
                importPlan: characterMeta.plan,
                importOptions: characterMeta.options,
                bindingSummary: getBindingSummary(characterName),
                variableInit: varInit.summary
            });
        } catch (error) {
            logger.error('选择角色失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新角色列表（需要认证）
    app.post('/api/characters/refresh', requireAuth, async (req, res) => {
        try {
            await characterManager.scanCharacters();
            const characters = await characterManager.listCharacters();
            res.json({ success: true, characters });
        } catch (error) {
            logger.error('刷新角色列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 上传角色卡（需要认证）
    app.post('/api/characters/upload', requireAuth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: '未上传文件' });
            }
            logger.info(`角色卡已上传: ${req.file.filename}`);
            // 刷新角色列表
            await characterManager.scanCharacters();
            const characters = await characterManager.listCharacters();
            const characterName = req.file.filename.replace(/\.png$/i, '');
            const characterMeta = characterManager.extractSillyTavernMetadata(characterName);
            const plan = buildCharacterMetadataPlan(characterName);
            const varInit = characterManager.readFromPng(characterName) ? applyCharacterVariableInitializers(characterName, characterMeta.metadata) : null;
            res.json({
                success: true,
                message: '角色卡上传成功',
                filename: req.file.filename,
                characters,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                importPlan: plan.plan,
                bindingSummary: getBindingSummary(characterName),
                variableInit: varInit?.summary || null
            });
        } catch (error) {
            logger.error('上传角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除角色卡（需要认证）
    app.delete('/api/characters/:filename', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { deleteMemoryDb, migrateMemoryToDefault } = req.body || {};
            const characterName = filename.replace(/\.png$/i, '');
            const binding = getCharacterBinding(characterName);
            const boundDbPath = binding.memoryDbPath;

            if (migrateMemoryToDefault === true && boundDbPath) {
                const TargetManagerClass = sessionManager.constructor;
                const sourceManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                sourceManager.setConfig(config, { storagePath: boundDbPath });
                const snapshot = sourceManager.exportMemory();
                const defaultPath = config.bindings.global.memoryDbPath || config.memory?.storage?.path;
                const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                targetManager.setConfig(config, { storagePath: defaultPath });
                targetManager.importMemorySnapshot(snapshot, { replace: false });
            }

            const filePath = path.join(config.chat.dataDir || './data', 'characters', filename);
            await fs.unlink(filePath);

            if (deleteMemoryDb === true && boundDbPath) {
                try {
                    await fs.unlink(path.isAbsolute(boundDbPath) ? boundDbPath : path.resolve(process.cwd(), boundDbPath));
                } catch {
                    // ignore missing db file
                }
            }

            delete config.bindings?.characters?.[characterName];
            if (config.chat.defaultCharacter === characterName) {
                config.chat.defaultCharacter = '';
                sessionManager.setConfig(config, { storagePath: config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }
            saveConfig(config);
            await characterManager.scanCharacters();
            logger.info(`角色卡已删除: ${filename}`);
            res.json({ success: true, message: '角色卡已删除' });
        } catch (error) {
            logger.error('删除角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取角色卡详情（需要认证）
    app.get('/api/characters/:filename/detail', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const characterName = filename.replace(/\.png$/i, '');
            const character = characterManager.readFromPng(characterName);
            const characterMeta = characterManager.extractSillyTavernMetadata(characterName);
            res.json({
                success: true,
                character,
                importedMetadata: characterMeta.metadata,
                metadataSummary: summarizeCharacterMetadata(characterMeta.metadata),
                importPlan: buildCharacterMetadataPlan(characterName).plan,
                bindingSummary: getBindingSummary(characterName),
                variableScanSummary: scanVariableUsage(buildCharacterVariableSources(characterName, characterMeta.metadata))
            });
        } catch (error) {
            logger.error('获取角色卡详情失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 更新角色卡（保存编辑，需要认证）
    app.post('/api/characters/:filename/update', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const updates = req.body;
            
            // 更新角色卡数据
            const characterName = filename.replace(/\.png$/i, '');
            const updated = characterManager.updateCharacter(characterName, updates);
            
            logger.info(`角色卡已更新: ${filename}`);
            res.json({ success: true, message: '角色卡已保存', character: updated });
        } catch (error) {
            logger.error('更新角色卡失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 世界书管理 ====================

    // 获取世界书列表（需要认证）
    app.get('/api/worldbooks', requireAuth, async (req, res) => {
        try {
            const worldbooks = await worldBookManager.listWorldBooks();
            // 过滤掉无效的文件名
            const validWorldbooks = worldbooks.filter(f => f && f !== 'undefined' && f.endsWith('.json'));
            res.json(validWorldbooks);
        } catch (error) {
            logger.error('获取世界书列表失败', error);
            res.status(500).json({ error: error.message });
        }
    });

    // 获取当前世界书（需要认证）
    app.get('/api/worldbooks/current', requireAuth, (req, res) => {
        const worldbook = worldBookManager.getCurrentWorldBook();
        if (worldbook) {
            res.json(worldbook);
        } else {
            res.status(404).json({ error: '未加载世界书' });
        }
    });

    // 选择世界书（需要认证）
    app.post('/api/worldbooks/select', requireAuth, async (req, res) => {
        try {
            const { filename } = req.body;
            const worldbook = await worldBookManager.loadWorldBook(filename);
            ensureBindingConfig();
            config.bindings.global.worldbook = filename;
            saveConfig(config);
            res.json({ success: true, worldbook });
        } catch (error) {
            logger.error('选择世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 刷新世界书列表（需要认证）
    app.post('/api/worldbooks/refresh', requireAuth, async (req, res) => {
        try {
            await worldBookManager.scanWorldBooks();
            const worldbooks = await worldBookManager.listWorldBooks();
            res.json({ success: true, worldbooks });
        } catch (error) {
            logger.error('刷新世界书列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 上传世界书（需要认证）
    app.post('/api/worldbooks/upload', requireAuth, upload.single('file'), async (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ success: false, error: '未上传文件' });
            }
            logger.info(`世界书已上传: ${req.file.filename}`);
            // 刷新世界书列表
            await worldBookManager.scanWorldBooks();
            const worldbooks = await worldBookManager.listWorldBooks();
            res.json({ success: true, message: '世界书上传成功', filename: req.file.filename, worldbooks });
        } catch (error) {
            logger.error('上传世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除世界书（需要认证）
    app.delete('/api/worldbooks/:filename', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            await fs.unlink(filePath);
            await worldBookManager.scanWorldBooks();
            logger.info(`世界书已删除: ${filename}`);
            res.json({ success: true, message: '世界书已删除' });
        } catch (error) {
            logger.error('删除世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试世界书匹配（需要认证）
    app.post('/api/worldbooks/test', requireAuth, (req, res) => {
        try {
            const { text } = req.body;
            const entries = worldBookManager.findMatchingEntries(text);
            res.json({ success: true, entries });
        } catch (error) {
            logger.error('测试世界书匹配失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/runtime/prompt-preview', requireAuth, async (req, res) => {
        try {
            const messageType = req.body.messageType === 'group' ? 'group' : 'private';
            const userId = toComparableId(req.body.userId).trim();
            const groupId = messageType === 'group' ? toComparableId(req.body.groupId).trim() : '';

            if (!userId) {
                return res.status(400).json({ error: '请提供用户 QQ，用于匹配访问控制名单' });
            }

            if (messageType === 'group' && !groupId) {
                return res.status(400).json({ error: '群聊预览必须提供群号' });
            }

            const previewEvent = {
                user_id: userId,
                group_id: groupId,
                message_type: messageType
            };

            if (!isPreviewAccessAllowed(config, previewEvent)) {
                return res.status(403).json({ error: '该用户或群聊不在当前访问控制允许范围内，无法预览' });
            }

            const preview = await buildChatRuntimePreview({
                characterName: req.body.characterName,
                userMessage: req.body.userMessage || '',
                context: req.body.context || { recentMessages: [], summaries: [] },
                stickyKeys: new Set(req.body.stickyKeys || []),
                runtimeContext: req.body.runtimeContext || {}
            }, {
                config,
                characterManager,
                worldBookManager,
                promptBuilder
            });

            res.json(preview);
        } catch (error) {
            logger.error('构建运行时 Prompt 预览失败', error);
            res.status(500).json({ error: '构建运行时 Prompt 预览失败' });
        }
    });

    // 获取世界书内容（用于编辑，需要认证）
    app.get('/api/worldbooks/:filename/content', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            const content = await fs.readFile(filePath, 'utf-8');
            const worldbook = JSON.parse(content);
            res.json({ success: true, worldbook });
        } catch (error) {
            logger.error('获取世界书内容失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 保存世界书内容（需要认证）
    app.post('/api/worldbooks/:filename/save', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { worldbook } = req.body;
            
            if (!worldbook) {
                return res.status(400).json({ success: false, error: '请提供世界书数据' });
            }
            
            const filePath = path.join(config.chat.dataDir || './data', 'worlds', filename);
            await fs.writeFile(filePath, JSON.stringify(worldbook, null, 2), 'utf-8');
            
            // 清除缓存，强制重新加载
            worldBookManager.clearCache();
            
            // 如果当前加载的是这个世界书，重新加载
            const currentWorldBook = worldBookManager.getCurrentWorldBook();
            const currentFilename = currentWorldBook ? currentWorldBook.name + '.json' : null;
            if (currentFilename === filename) {
                await worldBookManager.loadWorldBook(filename);
            }
            
            logger.info(`世界书已保存: ${filename}`);
            res.json({ success: true, message: '世界书已保存' });
        } catch (error) {
            logger.error('保存世界书失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 从角色卡提取内嵌世界书（需要认证）
    app.post('/api/worldbooks/extract-from-character', requireAuth, async (req, res) => {
        try {
            const { filename } = req.body;
            
            // 验证 filename
            if (!filename || typeof filename !== 'string') {
                return res.status(400).json({ success: false, error: '请提供有效的角色卡文件名' });
            }
            
            const characterName = filename.replace(/\.png$/i, '');
            
            // 读取角色卡
            const character = characterManager.readFromPng(characterName);
            
            // 查找内嵌世界书（可能在顶层或 data 对象内）
            const characterBook = character.character_book || character.data?.character_book;
            
            if (!characterBook) {
                return res.status(404).json({ success: false, error: '该角色卡没有内嵌世界书' });
            }
            
            // 获取角色名称（可能在顶层或 data 对象内）
            const charName = character.name || character.data?.name || characterName;
            
            // 生成世界书文件名（使用 Lorebook 格式）
            const worldbookFilename = `${sanitizeFilename(charName)}'s Lorebook.json`;
            const worldbookPath = path.join(config.chat.dataDir || './data', 'worlds', worldbookFilename);
            
            // 转换为标准世界书格式
            const worldbook = {
                name: `${charName} 世界书`,
                description: `从角色卡 ${charName} 提取的世界书`,
                entries: characterBook.entries || []
            };
            
            // 保存世界书文件
            await fs.writeFile(worldbookPath, JSON.stringify(worldbook, null, 2), 'utf-8');
            
            // 刷新世界书列表
            await worldBookManager.scanWorldBooks();
            
            logger.info(`已从角色卡提取世界书: ${worldbookFilename}`);
            res.json({ 
                success: true, 
                message: '世界书已提取并保存', 
                filename: worldbookFilename,
                entriesCount: worldbook.entries.length
            });
        } catch (error) {
			logger.error('提取世界书失败', error);  // ✅ 只保留一行
			res.status(500).json({ success: false, error: error.message });
		}

    });

    // ==================== 会话管理 ====================

    // 获取所有会话（需要认证）
    app.get('/api/sessions', requireAuth, (req, res) => {
        const sessions = sessionManager.listSessions().map((session) => ({
            ...session,
            label: typeof formatSessionLabel === 'function' ? formatSessionLabel(session.id) : session.id
        }));
        res.json(sessions);
    });

    // 获取指定会话（需要认证）
    app.get('/api/sessions/:sessionId', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        const session = sessionManager.getSession(sessionId);
        if (session) {
            res.json(session);
        } else {
            res.status(404).json({ error: '会话不存在' });
        }
    });

    // 获取会话历史（需要认证）
    app.get('/api/sessions/:sessionId/history', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const history = sessionManager.getHistory(sessionId, limit);
        res.json(history);
    });

    // 清除会话历史（需要认证）
    app.delete('/api/sessions/:sessionId/history', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        sessionManager.clearHistory(sessionId);
        res.json({ success: true, message: '会话历史已清除' });
    });

    // 删除会话（需要认证）
    app.delete('/api/sessions/:sessionId', requireAuth, (req, res) => {
        const { sessionId } = req.params;
        sessionManager.deleteSession(sessionId);
        res.json({ success: true, message: '会话已删除' });
    });

    // ==================== 全局记忆管理 ====================

    // 获取全局记忆统计（需要认证）
    app.get('/api/memory/stats', requireAuth, (req, res) => {
        const stats = {
            ...sessionManager.getStats(),
            runtime: runtime?.getStats?.() || null,
            activeMemory: getActiveMemoryInfo()
        };
        res.json(stats);
    });

    app.post('/api/memory/migrate', requireAuth, (req, res) => {
        try {
            const { targetPath, sourcePath, replace, sessionIds, sessionPrefix, userId } = req.body || {};
            if (!targetPath) {
                return res.status(400).json({ success: false, error: '目标数据库路径不能为空' });
            }

            const SourceManagerClass = sessionManager.constructor;
            const sourceManager = sourcePath
                ? new SourceManagerClass(config.chat.dataDir || './data', config, logger)
                : sessionManager;

            if (sourcePath) {
                sourceManager.setConfig(config, { storagePath: sourcePath });
            }

            const snapshot = (sessionIds?.length || sessionPrefix || userId)
                ? sourceManager.exportMemoryByFilter({ sessionIds, sessionPrefix, userId })
                : sourceManager.exportMemory();
            const targetManager = new SourceManagerClass(config.chat.dataDir || './data', config, logger);
            targetManager.setConfig(config, { storagePath: targetPath });
            const result = targetManager.importMemorySnapshot(snapshot, { replace });

            res.json({
                success: true,
                result,
                sourcePath: sourceManager.getDbPath(),
                targetPath: targetManager.getDbPath(),
                message: '记忆迁移完成'
            });
        } catch (error) {
            logger.error('迁移记忆失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/memory/databases', requireAuth, async (req, res) => {
        try {
            const databases = await listKnownMemoryDatabases();
            const enriched = databases.map((db) => {
                const stats = inspectMemoryDatabase(db.path);
                return {
                    ...db,
                    path: sanitizePathForClient(db.path),
                    stats: stripAbsolutePaths(stats)
                };
            });
            res.json({ success: true, databases: enriched, active: stripAbsolutePaths(getActiveMemoryInfo()) });
        } catch (error) {
            logger.error('获取数据库列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/characters/:filename/memory-binding', requireAuth, async (req, res) => {
        try {
            const { filename } = req.params;
            const { mode, dbPath, migrateToDefault } = req.body || {};
            const characterName = filename.replace(/\.png$/i, '');
            const binding = getCharacterBinding(characterName);
            const currentBindingPath = binding.memoryDbPath;

            if (mode === 'inherit') {
                if (migrateToDefault === true && currentBindingPath) {
                    const TargetManagerClass = sessionManager.constructor;
                    const sourceManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    sourceManager.setConfig(config, { storagePath: currentBindingPath });
                    const snapshot = sourceManager.exportMemory();
                    const defaultPath = config.bindings.global.memoryDbPath || config.memory?.storage?.path;
                    const targetManager = new TargetManagerClass(config.chat.dataDir || './data', config, logger);
                    targetManager.setConfig(config, { storagePath: defaultPath });
                    targetManager.importMemorySnapshot(snapshot, { replace: false });
                }
                binding.memoryDbPath = null;
            } else if (mode === 'character') {
                const normalizedName = characterName.replace(/[\\/:*?"<>|]/g, '_');
                binding.memoryDbPath = dbPath || `./data/chats/characters/${normalizedName}.sqlite`;
            } else if (mode === 'custom') {
                if (!dbPath) {
                    return res.status(400).json({ success: false, error: '自定义数据库路径不能为空' });
                }
                binding.memoryDbPath = dbPath;
            } else {
                return res.status(400).json({ success: false, error: '未知的绑定模式' });
            }

            if (config.chat.defaultCharacter === characterName) {
                sessionManager.setConfig(config, { storagePath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path });
            }

            saveConfig(config);
            res.json({
                success: true,
                bindingSummary: getBindingSummary(characterName),
                message: mode === 'inherit' ? '角色数据库绑定已解绑，已回退到全局默认库' : '角色数据库绑定已更新'
            });
        } catch (error) {
            logger.error('更新角色数据库绑定失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取全局记忆（需要认证）
    app.get('/api/memory/global', requireAuth, (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        const includeMetadata = req.query.metadata === 'true';
        const messages = sessionManager.getGlobalHistory(limit, includeMetadata);
        res.json({ messages, stats: sessionManager.getStats() });
    });

    app.get('/api/memory/variables', requireAuth, (req, res) => {
        try {
            const filters = normalizeVariableFilters(req.query || {});
            const items = sessionManager.listVariables(filters);
            res.json({ success: true, items, filters, activeMemory: getActiveMemoryInfo() });
        } catch (error) {
            logger.error('获取变量列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/memory/variables/:id', requireAuth, (req, res) => {
        try {
            const item = sessionManager.getVariableByEntryId(req.params.id);
            if (!item) {
                return res.status(404).json({ success: false, error: '变量不存在' });
            }
            res.json({ success: true, item });
        } catch (error) {
            logger.error('获取变量详情失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/memory/variables', requireAuth, (req, res) => {
        try {
            const scope = normalizeVariableScopeInput(req.body || {});
            const variable = normalizeVariablePayload(req.body || {});
            const result = sessionManager.upsertVariable(scope, variable);
            const item = sessionManager.getVariableByEntryId(result.id);
            res.json({
                success: true,
                item,
                created: !result.updated,
                message: result.updated ? '变量已更新' : '变量已创建'
            });
        } catch (error) {
            const statusCode = error.message === '变量名不能为空' ? 400 : 500;
            logger.error('保存变量失败', error);
            res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/memory/variables/:id', requireAuth, (req, res) => {
        try {
            const deleted = sessionManager.deleteVariable(req.params.id);
            if (!deleted) {
                return res.status(404).json({ success: false, error: '变量不存在' });
            }
            res.json({ success: true, message: '变量已删除' });
        } catch (error) {
            logger.error('删除变量失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/memory/knowledge', requireAuth, (req, res) => {
        try {
            const filters = normalizeKnowledgeFilters(req.query || {});
            const items = sessionManager.listKnowledgeEntries(filters);
            logger.info(`[API ${req.requestId || 'no-id'}] 知识库列表获取完成`, {
                filters,
                itemCount: items.length
            });
            res.json({ success: true, items, filters, activeMemory: getActiveMemoryInfo() });
        } catch (error) {
            logger.error('获取知识库列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/memory/knowledge/:id', requireAuth, (req, res) => {
        try {
            const item = sessionManager.getKnowledgeByEntryId(req.params.id);
            if (!item) {
                return res.status(404).json({ success: false, error: '知识条目不存在' });
            }
            res.json({ success: true, item });
        } catch (error) {
            logger.error('获取知识条目详情失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/memory/knowledge', requireAuth, (req, res) => {
        try {
            const payload = normalizeKnowledgePayload(req.body || {});
            let item;
            let created = false;

            if (payload.entryId) {
                item = sessionManager.saveKnowledgeEntry(payload.entryId, payload);
                if (!item) {
                    return res.status(404).json({ success: false, error: '知识条目不存在' });
                }
            } else {
                const scope = normalizeKnowledgeScopeInput(req.body || {});
                const result = sessionManager.upsertKnowledgeEntry(scope, payload);
                item = sessionManager.getKnowledgeByEntryId(result.id);
                created = true;
            }

            logger.info(`[API ${req.requestId || 'no-id'}] 知识条目保存完成`, {
                entryId: item?.id || payload.entryId || '',
                knowledgeType: item?.knowledgeType || payload.knowledgeType,
                title: item?.title || payload.title,
                created
            });
            res.json({
                success: true,
                item,
                created,
                message: created ? '知识条目已创建' : '知识条目已更新'
            });
        } catch (error) {
            const statusCode = ['知识标题不能为空', '知识内容不能为空'].includes(error.message) ? 400 : 500;
            logger.error('保存知识条目失败', error);
            res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.post('/api/memory/knowledge/import', requireAuth, async (req, res) => {
        try {
            const payload = normalizeKnowledgeImportPayload(req.body || {});
            const scope = normalizeKnowledgeScopeInput(req.body || {});
            const queuedAt = Date.now();
            const knowledgeTaskKey = [
                payload.title || 'untitled',
                scope.scopeType || '',
                scope.scopeKey || '',
                scope.characterName || '',
                scope.presetName || ''
            ].join('|');

            updateKnowledgeImportProgress?.({
                running: true,
                stage: 'queued',
                triggeredBy: 'admin_panel',
                title: payload.title,
                knowledgeType: payload.knowledgeType,
                scopeType: scope.scopeType,
                scopeKey: scope.scopeKey,
                characterName: scope.characterName,
                presetName: scope.presetName,
                totalChunks: 0,
                processedChunks: 0,
                savedCount: 0,
                currentChunk: 0,
                currentMessage: '任务已入队，准备切块',
                progressPercent: 4,
                tasks: [{
                    taskKey: knowledgeTaskKey,
                    running: true,
                    stage: 'queued',
                    triggeredBy: 'admin_panel',
                    title: payload.title,
                    knowledgeType: payload.knowledgeType,
                    scopeType: scope.scopeType,
                    scopeKey: scope.scopeKey,
                    characterName: scope.characterName,
                    presetName: scope.presetName,
                    totalChunks: 0,
                    processedChunks: 0,
                    savedCount: 0,
                    currentChunk: 0,
                    currentMessage: '任务已入队，准备切块',
                    progressPercent: 4,
                    lastQueuedAt: queuedAt,
                    lastStartedAt: queuedAt,
                    lastCompletedAt: null,
                    lastError: null,
                    lastResult: null
                }],
                lastQueuedAt: queuedAt,
                lastStartedAt: queuedAt,
                lastCompletedAt: null,
                lastError: null,
                lastResult: null
            });

            updateKnowledgeImportProgress?.({
                stage: 'splitting',
                currentMessage: '正在切分导入文本',
                progressPercent: 10,
                tasks: [{
                    ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                    taskKey: knowledgeTaskKey,
                    running: true,
                    stage: 'splitting',
                    currentMessage: '正在切分导入文本',
                    progressPercent: 10
                }]
            });

            const chunks = splitImportedNovelText(payload.text, payload.chunkSize);
            if (chunks.length === 0) {
                return res.status(400).json({ success: false, error: '导入文本不能为空' });
            }

            if (!aiClient || typeof aiClient.chat !== 'function') {
                throw new Error('AI 客户端不可用，无法执行知识提炼');
            }

            const importedItems = [];
            let savedCount = 0;

            updateKnowledgeImportProgress?.({
                stage: 'prompting',
                totalChunks: chunks.length,
                currentMessage: `已切分 ${chunks.length} 段，准备逐段提炼知识`,
                progressPercent: 18,
                tasks: [{
                    ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                    taskKey: knowledgeTaskKey,
                    running: true,
                    stage: 'prompting',
                    totalChunks: chunks.length,
                    currentMessage: `已切分 ${chunks.length} 段，准备逐段提炼知识`,
                    progressPercent: 18
                }]
            });

            for (const [index, chunk] of chunks.entries()) {
                updateKnowledgeImportProgress?.({
                    stage: 'generating',
                    totalChunks: chunks.length,
                    processedChunks: index,
                    savedCount,
                    currentChunk: index + 1,
                    currentMessage: `正在提炼第 ${index + 1}/${chunks.length} 段知识`,
                    progressPercent: Math.max(20, Math.min(78, Math.round(((index + 0.2) / chunks.length) * 100))),
                    tasks: [{
                        ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                        taskKey: knowledgeTaskKey,
                        running: true,
                        stage: 'generating',
                        totalChunks: chunks.length,
                        processedChunks: index,
                        savedCount,
                        currentChunk: index + 1,
                        currentMessage: `正在提炼第 ${index + 1}/${chunks.length} 段知识`,
                        progressPercent: Math.max(20, Math.min(78, Math.round(((index + 0.2) / chunks.length) * 100)))
                    }]
                });

                const messages = buildKnowledgeImportPrompt({
                    title: payload.title,
                    chunk,
                    chunkIndex: index,
                    totalChunks: chunks.length,
                    knowledgeType: payload.knowledgeType
                });
                recordDashboardMetric?.('knowledgeImport');
                const aiResponseText = aiClient.getVisibleResponseContent(aiResponse);
                const generatedEntries = parseKnowledgeImportAIResponse(aiResponseText);

                updateKnowledgeImportProgress?.({
                    stage: 'saving',
                    totalChunks: chunks.length,
                    processedChunks: index,
                    savedCount,
                    currentChunk: index + 1,
                    currentMessage: `正在保存第 ${index + 1}/${chunks.length} 段提炼结果`,
                    progressPercent: Math.max(24, Math.min(88, Math.round(((index + 0.65) / chunks.length) * 100))),
                    tasks: [{
                        ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                        taskKey: knowledgeTaskKey,
                        running: true,
                        stage: 'saving',
                        totalChunks: chunks.length,
                        processedChunks: index,
                        savedCount,
                        currentChunk: index + 1,
                        currentMessage: `正在保存第 ${index + 1}/${chunks.length} 段提炼结果`,
                        progressPercent: Math.max(24, Math.min(88, Math.round(((index + 0.65) / chunks.length) * 100)))
                    }]
                });

                for (const [entryIndex, entry] of generatedEntries.entries()) {
                    const metadata = {
                        ...payload.metadata,
                        chunkIndex: index,
                        chunkNumber: index + 1,
                        chunkCount: chunks.length,
                        chunkSize: payload.chunkSize,
                        generatedEntryIndex: entryIndex,
                        generatedEntryCount: generatedEntries.length,
                        source: 'novel-import-llm',
                        importMode: 'llm-structured',
                        originalTitle: payload.title
                    };
                    const result = sessionManager.upsertKnowledgeEntry(scope, {
                        title: generatedEntries.length > 1
                            ? `${entry.title} · 第${entryIndex + 1}条`
                            : entry.title,
                        content: entry.content,
                        knowledgeType: payload.knowledgeType,
                        tags: Array.from(new Set([...(payload.tags || []), ...(entry.tags || [])])),
                        metadata
                    });
                    const savedItem = sessionManager.getKnowledgeByEntryId(result.id);
                    if (savedItem) {
                        importedItems.push(savedItem);
                        savedCount += 1;
                    }
                }

                updateKnowledgeImportProgress?.({
                    stage: index === chunks.length - 1 ? 'saving' : 'generating',
                    totalChunks: chunks.length,
                    processedChunks: index + 1,
                    savedCount,
                    currentChunk: index + 1,
                    currentMessage: `已完成第 ${index + 1}/${chunks.length} 段，累计保存 ${savedCount} 条知识`,
                    progressPercent: Math.max(30, Math.min(92, Math.round(((index + 1) / chunks.length) * 100))),
                    tasks: [{
                        ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                        taskKey: knowledgeTaskKey,
                        running: true,
                        stage: index === chunks.length - 1 ? 'saving' : 'generating',
                        totalChunks: chunks.length,
                        processedChunks: index + 1,
                        savedCount,
                        currentChunk: index + 1,
                        currentMessage: `已完成第 ${index + 1}/${chunks.length} 段，累计保存 ${savedCount} 条知识`,
                        progressPercent: Math.max(30, Math.min(92, Math.round(((index + 1) / chunks.length) * 100)))
                    }]
                });
            }

            updateKnowledgeImportProgress?.({
                running: false,
                stage: 'completed',
                totalChunks: chunks.length,
                processedChunks: chunks.length,
                savedCount,
                currentChunk: chunks.length,
                currentMessage: `知识导入完成，共保存 ${savedCount} 条知识`,
                progressPercent: 100,
                tasks: [{
                    ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                    taskKey: knowledgeTaskKey,
                    running: false,
                    stage: 'completed',
                    totalChunks: chunks.length,
                    processedChunks: chunks.length,
                    savedCount,
                    currentChunk: chunks.length,
                    currentMessage: `知识导入完成，共保存 ${savedCount} 条知识`,
                    progressPercent: 100,
                    lastCompletedAt: Date.now(),
                    lastSuccessAt: Date.now(),
                    lastError: null,
                    lastResult: {
                        status: 'success',
                        importedCount: savedCount,
                        chunkCount: chunks.length
                    }
                }],
                lastCompletedAt: Date.now(),
                lastSuccessAt: Date.now(),
                lastError: null,
                lastResult: {
                    status: 'success',
                    importedCount: savedCount,
                    chunkCount: chunks.length
                }
            });

            logger.info(`[API ${req.requestId || 'no-id'}] 小说导入完成`, {
                title: payload.title,
                knowledgeType: payload.knowledgeType,
                chunkCount: chunks.length,
                importedCount: importedItems.length,
                scopeType: scope.scopeType,
                scopeKey: scope.scopeKey,
                characterName: scope.characterName,
                presetName: scope.presetName
            });

            res.json({
                success: true,
                message: `已导入 ${importedItems.length} 条知识`,
                importedCount: importedItems.length,
                chunkCount: chunks.length,
                knowledgeType: payload.knowledgeType,
                scope,
                items: importedItems
            });
        } catch (error) {
            const statusCode = error.message === '导入文本不能为空' ? 400 : 500;
            updateKnowledgeImportProgress?.({
                running: false,
                stage: 'failed',
                currentMessage: `知识导入失败: ${error.message}`,
                progressPercent: 100,
                tasks: [{
                    ...(getKnowledgeImportProgress?.().tasks?.[0] || {}),
                    taskKey: (getKnowledgeImportProgress?.().tasks?.[0]?.taskKey || 'knowledge-import-default'),
                    running: false,
                    stage: 'failed',
                    currentMessage: `知识导入失败: ${error.message}`,
                    progressPercent: 100,
                    lastCompletedAt: Date.now(),
                    lastFailureAt: Date.now(),
                    lastError: error.message,
                    lastResult: {
                        status: 'failed',
                        reason: error.message
                    }
                }],
                lastCompletedAt: Date.now(),
                lastFailureAt: Date.now(),
                lastError: error.message,
                lastResult: {
                    status: 'failed',
                    reason: error.message
                }
            });
            logger.error('导入小说知识失败', error);
            res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/memory/knowledge/:id', requireAuth, (req, res) => {
        try {
            const deleted = sessionManager.deleteKnowledgeEntry(req.params.id);
            if (!deleted) {
                return res.status(404).json({ success: false, error: '知识条目不存在' });
            }
            logger.info(`[API ${req.requestId || 'no-id'}] 知识条目删除完成`, {
                entryId: req.params.id
            });
            res.json({ success: true, message: '知识条目已删除' });
        } catch (error) {
            logger.error('删除知识条目失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/search', requireAuth, async (req, res) => {
        try {
            const { q, limit } = normalizeSearchQuery(req.query || {});
            if (!q) {
                return res.json({ success: true, query: '', groups: [], results: [], recentEligible: false });
            }

            const groups = [];
            const pushGroup = (type, label, items) => {
                const limited = limitSearchGroup(items, limit).map((item) => ({ ...item, type }));
                if (limited.length > 0) {
                    groups.push({ type, label, items: limited, count: limited.length });
                }
            };

            const knowledgeItems = sessionManager.listKnowledgeEntries({ search: q, limit }).map((item) => buildSearchResult({
                type: 'knowledge',
                title: item.title || '未命名知识',
                subtitle: `${item.knowledgeType || 'knowledge'} · ${item.scopeType || '-'} / ${item.scopeKey || '-'}`,
                preview: item.content || '',
                panelId: 'knowledge',
                entryId: item.id,
                score: includesSearchText(item.title, q) ? 30 : 20,
                action: { kind: 'knowledge', id: item.id }
            }));
            pushGroup('knowledge', '知识库', knowledgeItems);

            const variableItems = sessionManager.listVariables({ search: q, limit }).map((item) => buildSearchResult({
                type: 'variable',
                title: item.key || item.title || '未命名变量',
                subtitle: `${item.valueType || 'string'} · ${item.scopeType || '-'} / ${item.scopeKey || '-'}`,
                preview: item.rawValue || item.content || '',
                panelId: 'variables',
                entryId: item.id,
                score: includesSearchText(item.key || item.title, q) ? 30 : 20,
                action: { kind: 'variable', id: item.id }
            }));
            pushGroup('variable', '变量', variableItems);

            const messageItems = (sessionManager.searchMessages(q, limit) || []).map((item) => buildSearchResult({
                type: 'message',
                title: typeof formatSessionLabel === 'function' ? formatSessionLabel(item.sessionId || item.session_id || '') : (item.sessionId || item.session_id || '会话消息'),
                subtitle: item.timestamp ? new Date(item.timestamp).toLocaleString('zh-CN', { hour12: false }) : '聊天记录',
                preview: item.content || item.message || JSON.stringify(item),
                panelId: 'sessions',
                entryId: item.sessionId || item.session_id || '',
                score: 10,
                action: { kind: 'session', id: item.sessionId || item.session_id || '' }
            }));
            pushGroup('message', '聊天记录', messageItems);

            const characterItems = searchStaticEntries(characterManager.listCharacters(), q, (filename) => buildSearchResult({
                type: 'character',
                title: filename,
                subtitle: '角色卡',
                preview: `${filename}.png`,
                panelId: 'characters',
                entryId: `${filename}.png`,
                score: 15,
                action: { kind: 'character', filename: `${filename}.png` }
            }));
            pushGroup('character', '角色卡', characterItems);

            const worldbookItems = searchStaticEntries(worldBookManager.listWorldBooks(), q, (filename) => buildSearchResult({
                type: 'worldbook',
                title: filename.replace(/\.json$/i, ''),
                subtitle: '世界书',
                preview: filename,
                panelId: 'worldbooks',
                entryId: filename,
                score: 15,
                action: { kind: 'worldbook', filename }
            }));
            pushGroup('worldbook', '世界书', worldbookItems);

            ensureBindingConfig();
            const regexRules = Array.isArray(config.bindings.global.regexRules) ? config.bindings.global.regexRules : [];
            const regexItems = searchStaticEntries(regexRules, q, (rule, index) => buildSearchResult({
                type: 'regex',
                title: rule.name || `规则 ${index + 1}`,
                subtitle: rule.stage || '正则规则',
                preview: [rule.pattern, rule.replacement].filter(Boolean).join(' → '),
                panelId: 'regex',
                entryId: String(index),
                score: 12,
                action: { kind: 'regex', index }
            }));
            pushGroup('regex', '正则规则', regexItems);

            const configItems = searchStaticEntries([
                ['配置', '系统配置、OneBot、聊天、AI、记忆、预设', 'config'],
                ['语音合成', 'TTS、音色、速度、音量、测试语音', 'tts'],
                ['实时日志', '日志、错误、请求、运行状态', 'logs'],
                ['任务中心', '人物档案任务、知识导入任务、进度', 'tasks']
            ], q, ([title, preview, panelId]) => buildSearchResult({
                type: 'panel',
                title,
                subtitle: '面板入口',
                preview,
                panelId,
                score: 8,
                action: { kind: 'panel', panelId }
            }));
            pushGroup('panel', '面板入口', configItems);

            const results = groups.flatMap((group) => group.items);
            res.json({ success: true, query: q, groups, results, count: results.length, recentEligible: true });
        } catch (error) {
            logger.error('全局搜索失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/tools/web-search/test', requireAuth, async (req, res) => {
        try {
            const { query, draft, limit } = req.body || {};
            const webSearchDraft = draft && typeof draft === 'object' && !Array.isArray(draft)
                ? draft
                : (config.ai?.tools?.webSearch || {});
            const result = await runConfiguredWebSearch({
                config: { ai: { tools: { webSearch: webSearchDraft } } },
                query,
                limit,
                logger
            });
            res.json({ success: true, ...result });
        } catch (error) {
            logger.error('测试 web_search 失败', error);
            res.status(400).json({ success: false, error: error.message });
        }
    });

    // 搜索全局记忆（需要认证）
    app.post('/api/memory/search', requireAuth, (req, res) => {
        const { keyword, limit } = req.body;
        const results = sessionManager.searchMessages(keyword, limit || 50);
        res.json({ results, count: results.length });
    });

    // 清空全局记忆（需要认证，危险操作）
    app.post('/api/memory/clear-all', requireAuth, (req, res) => {
        const { confirm } = req.body;
        if (confirm === 'CLEAR_ALL_MEMORY') {
            sessionManager.clearGlobalMemory();
            logger.warn('全局记忆已被清空');
            res.json({ success: true, message: '全局记忆已清空' });
        } else {
            res.status(400).json({ success: false, error: '请提供确认码: CLEAR_ALL_MEMORY' });
        }
    });

    // 导出全局记忆（需要认证）
    app.get('/api/memory/export', requireAuth, (req, res) => {
        const data = sessionManager.exportMemory();
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=memory-export-${Date.now()}.json`);
        res.json(data);    });

    // ==================== 正则规则管理 ====================

    // 获取正则规则（需要认证）
    app.get('/api/regex', requireAuth, (req, res) => {
        ensureBindingConfig();
        if (isImportSummaryOnlyRequest(req)) {
            ensureImportsConfig();
            return res.json(config.imports.regexFiles.map((record) => summarizeRegexImportRecord(record)));
        }
        const rules = Array.isArray(config.bindings.global.regexRules) ? config.bindings.global.regexRules : [];
        res.json(rules);
    });

    // 添加正则规则（需要认证）
    app.post('/api/regex', requireAuth, (req, res) => {
        try {
            const rule = req.body;
            ensureBindingConfig();
            if (!Array.isArray(config.bindings.global.regexRules)) {
                config.bindings.global.regexRules = Array.isArray(config.regex.rules) ? config.regex.rules : [];
            }
            config.bindings.global.regexRules.push(rule);
            applyRuntimeConfig();
            saveConfig(config);
            res.json({ success: true, message: '规则已添加' });
        } catch (error) {
            logger.error('添加正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 删除正则规则（需要认证）
    app.delete('/api/regex/:index', requireAuth, (req, res) => {
        const index = parseInt(req.params.index);
        ensureBindingConfig();
        if (!Array.isArray(config.bindings.global.regexRules)) {
            config.bindings.global.regexRules = Array.isArray(config.regex.rules) ? config.regex.rules : [];
        }
        if (index >= 0 && index < config.bindings.global.regexRules.length) {
            config.bindings.global.regexRules.splice(index, 1);
        }
        applyRuntimeConfig();
        saveConfig(config);
        res.json({ success: true, message: '规则已删除' });
    });

    // 更新正则规则（需要认证）
    app.put('/api/regex/:index', requireAuth, (req, res) => {
        try {
            const index = parseInt(req.params.index);
            ensureBindingConfig();
            if (!Array.isArray(config.bindings.global.regexRules)) {
                config.bindings.global.regexRules = Array.isArray(config.regex.rules) ? config.regex.rules : [];
            }
            if (index < 0 || index >= config.bindings.global.regexRules.length) {
                return res.status(404).json({ success: false, error: '规则不存在' });
            }

            config.bindings.global.regexRules[index] = {
                ...config.bindings.global.regexRules[index],
                ...req.body
            };
            applyRuntimeConfig();
            saveConfig(config);
            res.json({ success: true, message: '规则已更新' });
        } catch (error) {
            logger.error('更新正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 测试正则规则（需要认证）
    app.post('/api/regex/test', requireAuth, (req, res) => {
        try {
            const { pattern, flags, replacement, testText } = req.body;
            const result = regexProcessor.testRule(pattern, flags, replacement, testText);
            res.json(result);
        } catch (error) {
            logger.error('测试正则规则失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 测试功能 ====================

    // 测试 AI 调用（需要认证）
    app.post('/api/test/ai', requireAuth, async (req, res) => {
        try {
            const { message, groupId, targetUserId, targetName } = req.body || {};
            const normalizedMessage = String(message || '').trim();
            if (!normalizedMessage) {
                return res.status(400).json({ success: false, error: 'message 不能为空' });
            }

            if (!isConfiguredAllowlistGroup(config, groupId)) {
                return rejectNonAllowlistTestGroup(res);
            }

            const timeoutMs = getAITimeoutMs(config);

            const toolContext = buildAIToolContext({
                config,
                aiClient,
                bot,
                logger,
                defaultGroupId: groupId,
                defaultTargetUserId: targetUserId,
                defaultTargetName: targetName
            });
            if (toolContext.isRealtimeQuery?.(normalizedMessage)) {
                const realtimeIntentMatch = toolContext.matchRealtimeIntent?.(normalizedMessage) || null;
                const realtimeAnswer = await callWithTimeout(() => generateRealtimeAnswer({
                    aiClient,
                    config,
                    query: normalizedMessage,
                    logger
                }), timeoutMs);
                if (realtimeAnswer?.reply) {
                    logger.info(`[API ${req.requestId || 'no-id'}] AI 测试走实时轻量旁路`, {
                        query: summarizeText(normalizedMessage),
                        groundingSource: realtimeAnswer.grounding?.source || '',
                        groundingProvider: realtimeAnswer.grounding?.provider || '',
                        groundingResultCount: realtimeAnswer.grounding?.resultCount || 0,
                        realtimeIntent: realtimeIntentMatch?.intent || '',
                        realtimeMatchReason: realtimeIntentMatch?.reason || '',
                        realtimeMatchScore: Number(realtimeIntentMatch?.score || 0).toFixed(3),
                        realtimeMatchPrototype: realtimeIntentMatch?.matchedPrototype || ''
                    });
                    return res.json({
                        success: true,
                        response: realtimeAnswer.reply,
                        toolsEnabled: toolContext.tools.map((tool) => tool?.function?.name).filter(Boolean),
                        mode: 'realtime_bypass'
                    });
                }
            }
            const messages = [
                ...(Array.isArray(toolContext.toolHints) && toolContext.toolHints.length > 0
                    ? [{ role: 'system', content: `【工具使用说明】\n${toolContext.toolHints.join('\n\n')}` }]
                    : []),
                { role: 'user', content: normalizedMessage }
            ];
            if (toolContext.isRealtimeQuery?.(normalizedMessage)) {
                const grounding = await buildRealtimeGroundingMessage({
                    config,
                    query: normalizedMessage,
                    logger
                });
                messages.unshift({
                    role: 'system',
                    content: grounding?.message || toolContext.buildRealtimeSearchPrompt?.(normalizedMessage) || `这条问题需要先联网检索再回答：${normalizedMessage}`
                });
            }
            const responseResult = await callWithTimeout(() => aiClient.chatWithTools(messages, toolContext), timeoutMs);
            const response = aiClient.getVisibleResponseContent(responseResult);
            logger.info(`[API ${req.requestId || 'no-id'}] AI 测试完成`, {
                message: summarizeText(normalizedMessage),
                groupId: groupId ? String(groupId) : '',
                targetUserId: targetUserId ? String(targetUserId) : '',
                toolNames: toolContext.tools.map((tool) => tool?.function?.name).filter(Boolean),
                responseType: typeof response,
                reasoningLength: typeof responseResult?.reasoningContent === 'string' ? responseResult.reasoningContent.length : 0
            });
            res.json({
                success: true,
                response,
                reasoningContent: typeof responseResult?.reasoningContent === 'string' ? responseResult.reasoningContent : null,
                toolsEnabled: toolContext.tools.map((tool) => tool?.function?.name).filter(Boolean)
            });
        } catch (error) {
            logger.error('测试 AI 调用失败', error);
            res.status(500).json({ success: false, error: error.message === 'AI_TIMEOUT' ? getAITimeoutErrorMessage(config) : error.message });
        }
    });

    app.post('/api/test/mention', requireAuth, async (req, res) => {
        try {
            const { groupId, targetUserId, targetName, message } = req.body || {};
            if (!groupId || !targetUserId || !String(message || '').trim()) {
                return res.status(400).json({ success: false, error: 'groupId、targetUserId 和 message 不能为空' });
            }

            if (String(targetUserId) === 'all') {
                return res.status(400).json({ success: false, error: '不支持向 @全体成员 主动发送消息' });
            }

            if (!isConfiguredAllowlistGroup(config, groupId)) {
                return rejectNonAllowlistTestGroup(res);
            }

            const timeoutMs = getAITimeoutMs(config);
            const sent = await callWithTimeout(() => sendGroupMentionFromPrompt({
                aiClient,
                bot,
                groupId,
                targetUserId,
                targetName,
                promptText: String(message || '').trim()
            }), timeoutMs);
            logger.info(`[API ${req.requestId || 'no-id'}] 主动@测试完成`, {
                groupId: String(groupId),
                targetUserId: String(targetUserId),
                targetName: targetName || '',
                prompt: sent.prompt || summarizeText(message),
                generatedMessage: summarizeText(sent.generatedMessage),
                usedPromptBuilder: !!sent.usedPromptBuilder,
                finalMessageCount: sent.finalMessageCount || 0,
                durationMs: sent.durationMs || 0
            });
            res.json({ success: true, message: '主动 @ 消息已发送', generatedMessage: sent.generatedMessage });
        } catch (error) {
            logger.error('测试主动 @ 发送失败', error);
            res.status(500).json({ success: false, error: error.message === 'AI_TIMEOUT' ? getAITimeoutErrorMessage(config) : error.message });
        }
    });

    app.post('/api/ai/models', requireAuth, async (req, res) => {
        try {
            const { baseUrl, apiKey } = req.body || {};
            const models = await aiClient.listModels({
                baseUrl: baseUrl || config.ai?.baseUrl,
                apiKey: apiKey || config.ai?.apiKey
            });
            logger.info(`[API ${req.requestId || 'no-id'}] 模型列表拉取完成`, {
                baseUrl: baseUrl || config.ai?.baseUrl || '',
                modelCount: Array.isArray(models) ? models.length : 0
            });
            res.json({ success: true, models });
        } catch (error) {
            logger.error('拉取模型列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/ai/probe', requireAuth, async (req, res) => {
        try {
            const { baseUrl, apiKey, model } = req.body || {};
            const result = await aiClient.probeModel(model, {
                baseUrl: baseUrl || config.ai?.baseUrl,
                apiKey: apiKey || config.ai?.apiKey
            });
            logger.info(`[API ${req.requestId || 'no-id'}] 模型探测完成`, {
                baseUrl: baseUrl || config.ai?.baseUrl || '',
                model,
                resolvedModel: result.model?.id || result.model?.name || '',
                probeOnly: true,
                autoMaxTokens: result.model?.recommendedMaxTokens || result.model?.maxOutputTokens || null
            });
            res.json({
                success: true,
                model: result.model,
                probeResponse: result.probeResponse || null,
                autoMaxTokens: result.model?.recommendedMaxTokens || result.model?.maxOutputTokens || null
            });
        } catch (error) {
            logger.error('探测模型元数据失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 日志 ====================

    // 获取最近日志（需要认证）
    app.get('/api/logs', requireAuth, (req, res) => {
        const logs = logger.getRecentLogs();
        res.json(logs);
    });

    app.get('/api/participant-profiles', requireAuth, (req, res) => {
        try {
            const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
            const items = sessionManager.listParticipantProfiles(limit);
            res.json({ success: true, items });
        } catch (error) {
            logger.error('获取人物档案列表失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/participant-profiles/:id', requireAuth, (req, res) => {
        try {
            const item = sessionManager.getParticipantProfileByEntryId(req.params.id);
            if (!item) {
                return res.status(404).json({ success: false, error: '人物档案不存在' });
            }

            res.json({ success: true, item });
        } catch (error) {
            logger.error('获取人物档案详情失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/participant-profiles', requireAuth, (req, res) => {
        try {
            const payload = normalizeParticipantProfilePayload(req.body || {});
            const item = sessionManager.saveParticipantProfile(payload.entryId, payload);
            if (!item) {
                return res.status(404).json({ success: false, error: '人物档案不存在' });
            }

            res.json({
                success: true,
                item,
                message: '人物档案已更新'
            });
        } catch (error) {
            const statusCode = ['人物档案 ID 不能为空', '人物档案标题不能为空', '人物档案内容不能为空'].includes(error.message) ? 400 : 500;
            logger.error('保存人物档案失败', error);
            res.status(statusCode).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/participant-profiles/:id', requireAuth, (req, res) => {
        try {
            const deleted = sessionManager.deleteParticipantProfile(req.params.id);
            if (!deleted) {
                return res.status(404).json({ success: false, error: '人物档案不存在' });
            }

            res.json({ success: true, message: '人物档案已删除' });
        } catch (error) {
            logger.error('删除人物档案失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/participant-profiles/:id/analyze', requireAuth, async (req, res) => {
        try {
            if (typeof analyzeParticipantProfile !== 'function') {
                return res.status(501).json({ success: false, error: '人物档案手动分析未启用' });
            }

            const existing = sessionManager.getParticipantProfileByEntryId(req.params.id);
            if (!existing) {
                return res.status(404).json({ success: false, error: '人物档案不存在' });
            }

            const item = await analyzeParticipantProfile(existing, {
                triggeredBy: 'admin_panel',
                operator: req.session?.username || 'admin-panel'
            });
            res.json({ success: true, item, message: '人物档案已重新分析' });
        } catch (error) {
            logger.error('手动分析人物档案失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/participant-profiles/:id/refresh-name', requireAuth, (req, res) => {
        try {
            if (typeof sessionManager.refreshParticipantProfileName !== 'function') {
                return res.status(501).json({ success: false, error: '刷新用户名未启用' });
            }

            const result = sessionManager.refreshParticipantProfileName(req.params.id);
            if (!result) {
                return res.status(404).json({ success: false, error: '人物档案不存在' });
            }
            if (result.reason === 'no_latest_name') {
                return res.status(409).json({ success: false, error: '没有找到该 QQ 的最新用户名来源，请先让该用户在群里发言' });
            }

            res.json({
                success: true,
                item: result.item,
                changed: result.changed,
                message: result.changed ? '用户名已按最新聊天记录刷新' : '用户名已是最新'
            });
        } catch (error) {
            logger.error('刷新人物档案用户名失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });



    // ==================== TTS 语音合成 ====================

    // 获取 TTS 配置（需要认证）
    app.get('/api/tts/config', requireAuth, (req, res) => {
        const ttsConfig = ttsManager.getConfig();
        const { apiKey, accessToken, token, ...safeTtsConfig } = ttsConfig;
        res.json({
            ...safeTtsConfig,
            hasApiKey: Boolean(apiKey || accessToken || token)
        });
    });

    // 更新 TTS 配置（需要认证）
    app.post('/api/tts/config', requireAuth, (req, res) => {
        try {
            const newConfig = req.body;
            const hasIncomingApiKey = Object.prototype.hasOwnProperty.call(newConfig, 'apiKey')
                || Object.prototype.hasOwnProperty.call(newConfig, 'accessToken')
                || Object.prototype.hasOwnProperty.call(newConfig, 'token');
            const incomingApiKey = newConfig.apiKey || newConfig.accessToken || newConfig.token;
            const resolvedApiKey = !hasIncomingApiKey || incomingApiKey === '******'
                ? (config.tts?.apiKey || '')
                : incomingApiKey;
            const mappedConfig = {
                enabled: newConfig.enabled,
                provider: newConfig.provider || 'doubao',
                baseUrl: newConfig.baseUrl || '',
                apiKey: resolvedApiKey,
                modelId: newConfig.modelId || newConfig.model || '',
                voiceId: newConfig.voiceId || newConfig.voiceType || '',
                speed: newConfig.speed || newConfig.speedRatio || 1.0,
                volume: newConfig.volume || newConfig.volumeRatio || 1.0,
                pitch: newConfig.pitch || newConfig.pitchRatio || 1.0,
                appId: newConfig.appId || newConfig.appid || ''
            };
            config.tts = {
                ...(config.tts || {}),
                ...mappedConfig
            };
            ttsManager.updateConfig(mappedConfig);
            saveConfig(config);
            logger.info(`[API ${req.requestId || 'no-id'}] TTS 配置已更新`, {
                enabled: !!mappedConfig.enabled,
                provider: mappedConfig.provider,
                modelId: mappedConfig.modelId || '',
                voiceId: mappedConfig.voiceId || '',
                hasApiKey: !!resolvedApiKey
            });
            res.json({ success: true, message: 'TTS 配置已保存' });
        } catch (error) {
            logger.error('更新 TTS 配置失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // 获取可用音色列表（需要认证）
    app.get('/api/tts/voices', requireAuth, (req, res) => {
        // 将对象格式转换为数组格式 [{id, name}]
        const voiceList = Object.entries(VOICE_TYPES).map(([id, name]) => ({
            id,
            name
        }));
        res.json(voiceList);
    });

    // 测试 TTS 合成（需要认证）
    app.post('/api/tts/test', requireAuth, async (req, res) => {
        try {
            const { text } = req.body;
            if (!text) {
                return res.status(400).json({ success: false, error: '请提供测试文本' });
            }

            recordDashboardMetric?.('tts');
            const audioPath = await ttsManager.synthesize(text);
            // 提取文件名，生成可访问的 URL
            const filename = path.basename(audioPath);
            const audioUrl = `/audio/${filename}`;

            logger.info(`[API ${req.requestId || 'no-id'}] TTS 测试完成`, {
                text: summarizeText(text),
                filename,
                audioUrl
            });
            logger.info(`TTS 测试成功: ${audioPath}`);
            res.json({
                success: true,
                audioUrl,
                filePath: audioPath,
                message: '语音合成成功'
            });
        } catch (error) {
            logger.error('TTS 测试失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ==================== 系统信息 ====================

    // 获取系统状态（需要认证）
    app.get('/api/status', requireAuth, (req, res) => {
        const status = {
            version: '1.0.0',
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            onebot: bot && typeof bot.getStatus === 'function'
                ? bot.getStatus()
                : { connected: bot ? bot.isConnected() : false },
            character: characterManager.getCurrentCharacter()?.name || '未选择',
            characterFile: config.chat?.defaultCharacter ? `${config.chat.defaultCharacter}.png` : null,
            worldbook: worldBookManager.getCurrentWorldBook()?.name || '未加载',
            sessions: sessionManager.listSessions().length,
            globalMemory: sessionManager.getStats(),
            runtime: runtime?.getStats?.() || null,
            activeMemory: getActiveMemoryInfo(),
            participantProfileProgress: typeof getParticipantProfileProgress === 'function' ? getParticipantProfileProgress() : null,
            knowledgeImportProgress: typeof getKnowledgeImportProgress === 'function' ? getKnowledgeImportProgress() : null,
            corpusEmbedProgress: { ...corpusEmbedProgress },
            dashboardMetrics: typeof getDashboardMetricsSnapshot === 'function' ? getDashboardMetricsSnapshot() : null,
            lastRouting: typeof getLastRoutingSnapshot === 'function' ? getLastRoutingSnapshot() : null,
            lastInjectionObservation: typeof getLastInjectionObservation === 'function' ? getLastInjectionObservation() : null,
            recentInjectionObservations: typeof getRecentInjectionObservations === 'function' ? getRecentInjectionObservations() : [],
            lastRecall: typeof getLastRecallSnapshot === 'function' ? getLastRecallSnapshot() : null,
            tokenStats: aiClient && typeof aiClient.getTokenStats === 'function' ? aiClient.getTokenStats() : null,
            server: {
                host: config.server?.host,
                port: config.server?.port,
                healthLogIntervalMs: config.server?.healthLogIntervalMs ?? 60000
            }
        };
        res.json(stripAbsolutePaths(status));
    });

    app.post('/api/regex/import', requireAuth, (req, res) => {
        try {
            logger.info(`[API ${req.requestId || 'no-id'}] regex import started`, {
                bodyPreview: summarizePayload(req.body, 1200)
            });
            ensureImportsConfig();
            const importedRules = RegexProcessor.importRules(req.body);
            const diagnostics = RegexProcessor.diagnoseImport(req.body);
            const targetLayer = req.body?.targetLayer || 'global';
            const sourceFilename = String(req.body?.sourceFilename || '').trim() || `regex-${Date.now()}.json`;
            logger.info(`[API ${req.requestId || 'no-id'}] regex import diagnostics`, diagnostics);
            if (importedRules.length === 0) {
                logger.warn(`[API ${req.requestId || 'no-id'}] regex import produced zero compatible rules`);
                return res.status(400).json({ success: false, error: '未识别到可导入的正则规则' });
            }

            const targetRules = getRegexTargetRules(targetLayer);
            if (!targetRules) {
                return res.status(400).json({ success: false, error: '当前没有选中角色，无法导入到角色层' });
            }

            const existingKeys = new Set(targetRules.map((rule) => `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`));
            const nextRules = importedRules.filter((rule) => {
                const key = `${rule.name || ''}|${rule.pattern || ''}|${rule.replacement || ''}`;
                if (existingKeys.has(key)) {
                    return false;
                }
                existingKeys.add(key);
                return true;
            });

            targetRules.push(...nextRules);
            const record = {
                id: createImportRecordId('regex'),
                type: 'regex',
                filename: sourceFilename,
                targetLayer,
                createdAt: new Date().toISOString(),
                importedRules: cloneImportSnapshot(nextRules)
            };
            config.imports.regexFiles.unshift(record);
            applyRuntimeConfig();
            saveConfig(config);
            logger.info(`[API ${req.requestId || 'no-id'}] regex import completed`, {
                targetLayer,
                importedCount: nextRules.length,
                diagnostics,
                importRecord: summarizeRegexImportRecord(record)
            });
            res.json({
                success: true,
                count: nextRules.length,
                importedRules: nextRules,
                diagnostics,
                targetLayer,
                importRecord: summarizeRegexImportRecord(record),
                message: `已导入 ${nextRules.length} 条规则到${targetLayer === 'preset' ? '预设层' : targetLayer === 'character' ? '角色层' : '全局层'}`
            });
        } catch (error) {
            logger.error(`[API ${req.requestId || 'no-id'}] 导入正则规则失败`, {
                message: error.message,
                stack: error.stack,
                bodyPreview: summarizePayload(req.body, 1200)
            });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/regex/imports/:id', requireAuth, (req, res) => {
        try {
            const result = deleteTrackedRegexImport(req.params.id);
            if (!result.found) {
                return res.status(404).json({ success: false, error: '导入记录不存在' });
            }
            applyRuntimeConfig();
            saveConfig(config);
            res.json({
                success: true,
                removedCount: result.removedCount,
                message: `已删除导入文件记录，并移除 ${result.removedCount} 条关联规则`
            });
        } catch (error) {
            logger.error('删除正则导入文件失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/regex/export', requireAuth, (req, res) => {
        const format = req.query.format === 'sillytavern' ? 'sillytavern' : 'native';
        const payload = RegexProcessor.exportRules(regexProcessor.getRules().filter((rule) => rule.source !== 'preset'), format);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=regex-${format}-${Date.now()}.json`);
        res.send(JSON.stringify(payload, null, 2));
    });

    app.post('/api/preset/import', requireAuth, (req, res) => {
        try {
            logger.info(`[API ${req.requestId || 'no-id'}] preset import started`, {
                bodyPreview: summarizePayload(req.body, 1200)
            });
            ensureImportsConfig();
            const preset = PromptBuilder.importPreset(req.body);
            const diagnostics = PromptBuilder.diagnosePresetImport(req.body);
            const importedRegexRules = RegexProcessor.importRules(req.body);
            const regexDiagnostics = RegexProcessor.diagnoseImport(req.body);
            const sourceFilename = String(req.body?.sourceFilename || '').trim() || `preset-${Date.now()}.json`;
            logger.info(`[API ${req.requestId || 'no-id'}] preset import diagnostics`, diagnostics);
            logger.info(`[API ${req.requestId || 'no-id'}] preset-linked regex diagnostics`, regexDiagnostics);
            const previousPreset = { ...(config.preset || {}) };
            const presetImportRecordId = createImportRecordId('preset');
            const linkedRegexImportRecord = importedRegexRules.length > 0 ? {
                id: createImportRecordId('regex'),
                type: 'regex',
                sourceType: 'preset',
                presetImportId: presetImportRecordId,
                filename: `${sourceFilename} / 预设关联正则`,
                targetLayer: 'preset',
                createdAt: new Date().toISOString(),
                importedRules: cloneImportSnapshot(importedRegexRules),
                previousRules: cloneImportSnapshot(previousPreset.regexRules || [])
            } : null;
            config.preset = {
                ...(config.preset || {}),
                ...preset,
                regexRules: importedRegexRules
            };
            const importedFields = Object.keys(preset).filter((key) => preset[key] !== '' && preset[key] !== false);
            const record = {
                id: presetImportRecordId,
                type: 'preset',
                filename: sourceFilename,
                createdAt: new Date().toISOString(),
                importedFields,
                importedPreset: cloneImportSnapshot(preset),
                importedRegexRules: cloneImportSnapshot(importedRegexRules),
                linkedRegexImportId: linkedRegexImportRecord?.id || null,
                previousRegexRules: cloneImportSnapshot(previousPreset.regexRules),
                previousPreset: Object.fromEntries(importedFields.map((key) => [key, cloneImportSnapshot(previousPreset[key])]))
            };
            config.imports.presetFiles.unshift(record);
            if (linkedRegexImportRecord) {
                config.imports.regexFiles.unshift(linkedRegexImportRecord);
            }
            applyRuntimeConfig();
            saveConfig(config);
            logger.info(`[API ${req.requestId || 'no-id'}] preset import completed`, {
                importedFields,
                importedRegexCount: importedRegexRules.length,
                diagnostics,
                regexDiagnostics,
                importRecord: summarizePresetImportRecord(record)
            });
            res.json({
                success: true,
                preset: config.preset,
                diagnostics,
                regexDiagnostics,
                importedRegexCount: importedRegexRules.length,
                importedFields,
                importRecord: summarizePresetImportRecord(record),
                message: importedRegexRules.length > 0 ? `预设已导入，并同步导入 ${importedRegexRules.length} 条正则` : '预设已导入'
            });
        } catch (error) {
            logger.error(`[API ${req.requestId || 'no-id'}] 导入预设失败`, {
                message: error.message,
                stack: error.stack,
                bodyPreview: summarizePayload(req.body, 1200)
            });
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/preset/imports/:id', requireAuth, (req, res) => {
        try {
            const result = deleteTrackedPresetImport(req.params.id);
            if (!result.found) {
                return res.status(404).json({ success: false, error: '导入记录不存在' });
            }
            applyRuntimeConfig();
            saveConfig(config);
            res.json({
                success: true,
                removedCount: result.removedCount,
                restoredFields: result.restoredFields,
                message: `已删除预设导入文件，并恢复 ${result.restoredFields.length} 个字段，移除 ${result.removedCount} 条关联正则`
            });
        } catch (error) {
            logger.error('删除预设导入文件失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/preset/export', requireAuth, (req, res) => {
        const format = req.query.format === 'sillytavern' ? 'sillytavern' : 'native';
        const payload = PromptBuilder.exportPreset(config.preset || {}, format);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename=preset-${format}-${Date.now()}.json`);
        res.send(JSON.stringify(payload, null, 2));
    });

    // OneBot 重连（需要认证）
    app.post('/api/preset/train', requireAuth, async (req, res) => {
        try {
            const rounds = Math.min(Math.max(parseInt(req.body?.rounds) || 10, 1), 50);
            const { runPromptTraining } = await import('./prompt-trainer.js');
            const result = await runPromptTraining({ config, rounds });
            res.json(result);
        } catch (e) {
            logger.error('提示词训练失败', e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    app.post('/api/preset/tune', requireAuth, async (req, res) => {
        try {
            const character = characterManager.getCurrentCharacter();
            const cardData = character?.data || character || {};
            const charName = cardData.name || character?.name || '未知角色';
            const charDesc = [
                cardData.description || '',
                cardData.personality || '',
                cardData.scenario || '',
                cardData.first_mes || '',
                cardData.mes_example || '',
                cardData.system_prompt || ''
            ].filter(Boolean).join('\n');

            // 取最近聊天记录（只读，不写入）
            let chatSamples = '';
            try {
                const sessions = sessionManager.listSessions();
                const activeSessionId = config.chat?.sessionMode === 'global_shared' ? 'global_shared_memory' : (sessions[0]?.id || '');
                if (activeSessionId) {
                    const recentMessages = sessionManager.getRecentMessages?.(activeSessionId, 20) || [];
                    const aiReplies = recentMessages
                        .filter(m => m.role === 'assistant' && m.content && m.content.length > 20)
                        .slice(-5);
                    if (aiReplies.length > 0) {
                        chatSamples = '\n## 最近AI实际回复（用于判断提示词效果）\n' +
                            aiReplies.map((m, i) => `[第${i + 1}条] ${m.content.substring(0, 600)}`).join('\n---\n');
                    }
                }
            } catch {}

            const binding = promptBuilder?.getEffectiveBinding?.(config, charName) || {};
            const allPrompts = (binding.prompts || config.preset?.prompts || []);
            const enabledList = allPrompts.filter(p => p.enabled !== false);
            const promptListText = enabledList.map((p, i) => {
                const id = p.identifier || p.name || `item-${i}`;
                return `<prompt index="${i}">\n<id>${id}</id>\n<role>${p.role || 'system'}</role>\n<content>${(p.content || '').substring(0, 1500)}</content>\n</prompt>`;
            }).join('\n');

            const tunePrompt = `任务：优化角色扮演 AI 的提示词，让它更像角色。

角色名：${charName}
角色设定：${charDesc.substring(0, 2000)}
${chatSamples}

当前已启用的提示词（只改<content>，不动<id><role>）：
${promptListText}

要求：
1. 参考"角色设定"和"最近AI实际回复"，找出提示词的问题
2. 如果 AI 回复和角色设定差距大，加强相关提示词的约束
3. 只修改<content>标签内的文本，<id>和<role>一个字都不能改
4. 让提示词更贴合角色语气、用词习惯、思维方式
5. 去掉冗余表述，保留核心指令
6. 如果某条提示词已经很好，原样保留
7. 输出合法 JSON 数组：
[{"index":0,"content":"优化后提示词"},...]

只输出 JSON 数组：`;

            const result = await aiClient.chat([{ role: 'user', content: tunePrompt }], {
                temperature: 0.3,
                maxTokens: 4096
            });

            // 多策略提取 JSON
            let optimizedPrompts = null;
            const strategies = [
                // 策略1：提取 ```json ... ``` 代码块
                () => { const m = result.match(/```json\s*([\s\S]*?)```/); if (!m) throw new Error('no json block'); const v = JSON.parse(m[1]); if (Array.isArray(v)) return v; throw new Error('not array'); },
                // 策略2：提取 ``` ... ``` 代码块
                () => { const m = result.match(/```\s*([\s\S]*?)```/); if (!m) throw new Error('no code block'); const v = JSON.parse(m[1]); if (Array.isArray(v)) return v; throw new Error('not array'); },
                // 策略3：提取 JSON 数组 [...]
                () => { const m = result.match(/\[([\s\S]*)\]/); if (!m) throw new Error('no brackets'); const v = JSON.parse('[' + m[1] + ']'); if (Array.isArray(v)) return v; throw new Error('not array'); },
                // 策略4：整个回复就是 JSON
                () => { const v = JSON.parse(result.trim()); if (Array.isArray(v)) return v; throw new Error('not array'); },
            ];

            let extractError = null;
            for (const strategy of strategies) {
                try {
                    optimizedPrompts = strategy();
                    if (Array.isArray(optimizedPrompts) && optimizedPrompts.length > 0) break;
                } catch (e) { extractError = e; }
            }

            // 校验每个优化结果
            const validPrompts = [];
            if (Array.isArray(optimizedPrompts)) {
                for (const opt of optimizedPrompts) {
                    const index = opt.index ?? opt.i;
                    if (typeof index !== 'number' || index < 0 || index >= allPrompts.length) continue;
                    if (typeof opt.content !== 'string' || opt.content.trim().length === 0) continue;
                    // 确保优化后的内容和原始内容有本质区别或至少不是乱码
                    if (opt.content.length < 10) continue;
                    validPrompts.push({ index, content: opt.content.trim() });
                }
            }

            res.json({
                success: true,
                optimizedPrompts: validPrompts.length > 0 ? validPrompts : null,
                suggestion: validPrompts.length === 0 ? result : null,
                debug: req.body?._debug ? { rawResponse: result, extractError: extractError?.message } : undefined,
                message: validPrompts.length > 0
                    ? `AI 优化了 ${validPrompts.length} 条提示词，点击保存生效`
                    : 'AI 返回了建议但无法自动解析，请查看文本框手动参考'
            });
        } catch (e) {
            logger.error('提示词优化失败', e);
            res.status(500).json({ success: false, error: e.message });
        }
    });

    // ==================== 提示词优化靶场 ====================

    const promptSnapshots = new Map();
    let rangeCorpusStore = { lines: [], stats: null, updatedAt: 0, embeddings: null };
    let corpusEmbedProgress = { running: false, stage: 'idle', currentMessage: '', progressPercent: 0, totalBatches: 0, currentBatch: 0, error: null };
    let corpusEmbedAborted = false;

    // 启动时从磁盘加载语料和嵌入
    (() => {
        try {
            const storePath = path.join(__dirname, '..', 'data', 'range-corpus.json');
            if (fsSync.existsSync(storePath)) {
                const saved = JSON.parse(fsSync.readFileSync(storePath, 'utf8'));
                if (Array.isArray(saved.lines)) {
                    rangeCorpusStore.lines = saved.lines;
                    rangeCorpusStore.stats = saved.stats || null;
                    rangeCorpusStore.updatedAt = saved.updatedAt || 0;
                    logger.info(`[靶场] 已从磁盘加载 ${saved.lines.length} 条语料`);
                }
            }
            const embedPath = path.join(__dirname, '..', 'data', 'range-corpus-embeddings.json');
            if (fsSync.existsSync(embedPath)) {
                const embedSaved = JSON.parse(fsSync.readFileSync(embedPath, 'utf8'));
                if (Array.isArray(embedSaved.embeddings) && embedSaved.embeddings.length > 0) {
                    rangeCorpusStore.embeddings = embedSaved.embeddings;
                    rangeCorpusStore.embedModel = embedSaved.model || null;
                    rangeCorpusStore.embedProvider = embedSaved.provider || null;
                    rangeCorpusStore.embedProviderId = embedSaved.providerId || null;
                    logger.info(`[靶场] 已从磁盘加载 ${embedSaved.embeddings.length} 条嵌入向量`);
                }
            }
        } catch (e) { /* 静默 */ }
    })();

    function buildRangeAgentContextPrompt(rangeContext = {}) {
        if (!rangeContext || typeof rangeContext !== 'object') {
            return '';
        }

        const parts = [];
        const latestTest = rangeContext.latestTest && typeof rangeContext.latestTest === 'object'
            ? rangeContext.latestTest
            : null;

        if (latestTest && (latestTest.userMessage || latestTest.aiResponse || latestTest.reasoningContent)) {
            parts.push('## 左侧最新测试结果');
            if (latestTest.userMessage) {
                parts.push(`用户消息: ${String(latestTest.userMessage).slice(0, 500)}`);
            }
            if (latestTest.aiResponse) {
                parts.push(`角色回复: ${String(latestTest.aiResponse).slice(0, 2000)}`);
            }
            if (latestTest.reasoningContent) {
                parts.push(`思维链: ${String(latestTest.reasoningContent).slice(0, 2000)}`);
            }
        }

        if (Array.isArray(rangeContext.recentTests) && rangeContext.recentTests.length > 0) {
            const recent = rangeContext.recentTests
                .slice(-3)
                .map((item, index) => {
                    const userMessage = String(item?.userMessage || '').slice(0, 200);
                    const aiResponse = String(item?.aiResponse || '').slice(0, 500);
                    if (!userMessage && !aiResponse) return '';
                    return `#${index + 1} 用户: ${userMessage || '(空)'} | 回复: ${aiResponse || '(空)'}`;
                })
                .filter(Boolean);
            if (recent.length > 0) {
                parts.push('## 左侧最近测试摘要');
                parts.push(...recent);
            }
        }

        if (Array.isArray(rangeContext.recentTestBubbles) && rangeContext.recentTestBubbles.length > 0) {
            const bubbleLines = rangeContext.recentTestBubbles
                .slice(-6)
                .map((item, index) => {
                    const meta = String(item?.meta || '').slice(0, 120);
                    const content = String(item?.content || '').slice(0, 400);
                    if (!content) return '';
                    return `#${index + 1} ${meta || '测试气泡'}: ${content}`;
                })
                .filter(Boolean);
            if (bubbleLines.length > 0) {
                parts.push('## 左侧测试区最近气泡');
                parts.push(...bubbleLines);
            }
        }

        if (rangeContext.currentPhase || rangeContext.iteration || rangeContext.maxIterations) {
            parts.push('## 当前优化进度');
            parts.push(`阶段: ${rangeContext.currentPhase || 0}`);
            parts.push(`轮次: ${rangeContext.iteration || 0}/${rangeContext.maxIterations || 0}`);
        }

        if (rangeContext.sceneInfo) {
            parts.push('## 场景信息');
            parts.push(String(rangeContext.sceneInfo).slice(0, 500));
        }

        if (rangeContext.embedStatus) {
            parts.push('## 语料状态');
            parts.push(String(rangeContext.embedStatus).slice(0, 200));
        }

        if (rangeContext.agentMemory) {
            parts.push('## 跨轮记忆');
            parts.push(String(rangeContext.agentMemory).slice(0, 1000));
        }

        if (rangeContext.corpusSample) {
            parts.push('## 语料样本');
            parts.push(String(rangeContext.corpusSample).slice(0, 1000));
        }

        if (parts.length === 0) {
            return '';
        }

        return `以下是靶场左侧测试区的结构化上下文。你必须优先依据这些真实测试结果继续分析、评分、改写，不要忽略它，也不要假装“还没有测试结果”。\n\n${parts.join('\n')}`;
    }

    const MODEL_CAP_RE = {
        embedding: /(?:text-embedding|embed|bge-|e5-|gte-|voyage-|jina-embeddings|llm2vec|retrieval|uae-)/i,
        rerank: /(?:rerank|re-rank|bge-rerank|cohere.*rerank|jina.*rerank)/i,
        vision: /(?:vision|vl|gemini-2\\.5|claude-3|gpt-4o|pixtral|qwen-vl|glm-4v|cogview|dall-e|flux|imagen)/i
    };

    function classifyModel(modelId = '') {
        const id = String(modelId).toLowerCase();
        if (MODEL_CAP_RE.rerank.test(id)) return 'rerank';
        if (MODEL_CAP_RE.embedding.test(id)) return 'embedding';
        if (MODEL_CAP_RE.vision.test(id)) return 'vision';
        return 'chat';
    }

    app.post('/api/prompt-range/test', requireAuth, async (req, res) => {
        try {
            const {
                userMessage, characterName, messageType = 'group',
                groupId = '', userId = '',
                modelProviderId, model,
                worldbookName, presetId,
                context = {},
                contextConfig: contextOverrides = {},
                injectVariables = true,
                injectProfiles = true
            } = req.body || {};

            const normalizedMessage = String(userMessage || '').trim();
            if (!normalizedMessage) {
                return res.status(400).json({ success: false, error: '请提供测试消息' });
            }

            // 临时覆盖上下文配置以支持靶场开关测试
            const savedContextConfig = promptBuilder.contextConfig;
            if (Object.keys(contextOverrides).length > 0) {
                promptBuilder.updateConfig({ ...config, context: {
                    enabled: contextOverrides.enabled !== undefined ? contextOverrides.enabled : config.context?.enabled,
                    includeSessionFacts: contextOverrides.includeSessionFacts !== undefined ? contextOverrides.includeSessionFacts : config.context?.includeSessionFacts,
                    includeParticipants: contextOverrides.includeParticipants !== undefined ? contextOverrides.includeParticipants : config.context?.includeParticipants,
                    includeReplyReference: contextOverrides.includeReplyReference !== undefined ? contextOverrides.includeReplyReference : config.context?.includeReplyReference,
                    includeRecentUserIntent: contextOverrides.includeRecentUserIntent !== undefined ? contextOverrides.includeRecentUserIntent : config.context?.includeRecentUserIntent
                }});
            }

            const resolvedCharacterName = characterName || config.chat?.defaultCharacter || '';
            const resolvedInputs = resolveChatRuntimeInputs({
                characterName: resolvedCharacterName, config, characterManager, worldBookManager
            });

            // 世界书覆盖
            if (worldbookName) {
                const overrideWb = worldBookManager.readWorldBook(worldbookName);
                if (overrideWb) resolvedInputs.worldBook = overrideWb;
            }

            // 预设覆盖
            if (presetId && Array.isArray(config.imports?.presetFiles)) {
                const importRecord = config.imports.presetFiles.find(r => r?.id === presetId);
                if (importRecord?.importedPreset) {
                    resolvedInputs.preset = PromptBuilder.normalizePreset(importRecord.importedPreset);
                }
            }

            const recallNamespace = {
                scopeType: messageType === 'group' ? 'group' : 'private',
                scopeKey: messageType === 'group' ? String(groupId || '_test_') : String(userId || '_test_'),
                characterName: resolvedCharacterName,
                presetName: resolvedInputs.preset?.name || ''
            };
            let recalledEntries = [];
            try {
                recalledEntries = sessionManager.recallMemory(recallNamespace, normalizedMessage, {
                    recentLimit: 4, searchLimit: 4, summaryLimit: 3, fixedLimit: 6
                });
            } catch (e) {
                logger.warn('[靶场] 记忆召回失败', e.message);
            }

            const built = await promptBuilder.build(
                resolvedCharacterName, normalizedMessage,
                context || { recentMessages: [], summaries: [] },
                new Set(),
                {
                    sessionId: `range_${Date.now()}`, messageType, messageCount: 1,
                    recalledEntries, participants: [], injectionRisk: null, replyReference: null
                },
                { character: resolvedInputs.character, worldBook: resolvedInputs.worldBook, presetConfig: resolvedInputs.preset }
            );

            // 恢复原始上下文配置
            if (Object.keys(contextOverrides).length > 0 && savedContextConfig) {
                promptBuilder.contextConfig = savedContextConfig;
            }

            const comp = built.runtimeComposition;
            const segments = [];
            const pushSegment = (seg) => {
                if (!seg || !seg.content) return;
                segments.push({
                    id: seg.id || '', kind: seg.kind || 'unknown',
                    label: seg.label || '', content: seg.content,
                    order: seg.order || 0, stage: seg.stage || '',
                    meta: seg.meta || {}, tokenEstimate: estimateTokenCount(seg.content)
                });
            };
            for (const seg of (comp.systemSegments || [])) pushSegment(seg);
            for (const msg of (comp.historyMessages || [])) {
                segments.push({
                    id: msg.meta?.sourceId || `history-${segments.length}`,
                    kind: 'history_message',
                    label: `历史消息 (${msg.role || 'unknown'})`,
                    content: msg.content, order: 90, stage: 'history',
                    meta: msg.meta || {}, tokenEstimate: estimateTokenCount(msg.content)
                });
            }
            for (const seg of (comp.postHistorySegments || [])) pushSegment(seg);
            segments.push({
                id: 'user-input', kind: 'user_input', label: '当前用户输入',
                content: normalizedMessage, order: 130, stage: 'input',
                meta: {}, tokenEstimate: estimateTokenCount(normalizedMessage)
            });
            for (const seg of (comp.assistantPrefillSegments || [])) pushSegment(seg);

            const stats = {
                totalTokenEstimate: segments.reduce((s, sg) => s + (sg.tokenEstimate || 0), 0),
                segmentCount: segments.length,
                worldbookHits: (built.worldBookEntries || []).length,
                memoryRecallCount: recalledEntries.length,
                messageCount: built.messages?.length || 0
            };

            // 变量桥接：靶场也注入变量状态和解析宏（可开关）
            if (injectVariables) {
            try {
                const { buildVariableStatusBlock, resolveVariableMacros } = await import('./variable-bridge.js');
                const scopeOpts = {
                    scopeType: recallNamespace.scopeType, scopeKey: recallNamespace.scopeKey,
                    characterName: recallNamespace.characterName, presetName: recallNamespace.presetName
                };
                for (const msg of built.messages) {
                    if (typeof msg.content === 'string') {
                        msg.content = resolveVariableMacros(msg.content, sessionManager, scopeOpts);
                    }
                }
                const statusBlock = buildVariableStatusBlock(sessionManager, scopeOpts);
                if (statusBlock) {
                    const sysIdx = built.messages.findIndex(m => m.role === 'system');
                    if (sysIdx >= 0) built.messages[sysIdx].content += '\n' + statusBlock;
                    else built.messages.unshift({ role: 'system', content: statusBlock });
                }
            } catch (e) { logger.warn('[靶场] 变量注入失败:', e.message); }
            }

            // 人物档案注入（可开关）
            if (injectProfiles) {
            try {
                const profiles = sessionManager?.listParticipantProfiles?.(10) || [];
                if (profiles.length > 0) {
                    const profileText = profiles.map(p => `[档案:${p.participantName||p.title}]\n${(p.content||'').slice(0, 300)}`).join('\n\n');
                    const sysIdx = built.messages.findIndex(m => m.role === 'system');
                    if (sysIdx >= 0) built.messages[sysIdx].content += '\n' + profileText;
                }
            } catch (e) { logger.warn('[靶场] 档案注入失败:', e.message); }
            }

            let aiResponse = null;
            if (req.body.includeAIResponse) {
                try {
                    const overrides = {};
                    const provider = modelProviderId
                        ? (config.ai?.providers || []).find((item) => item.id === modelProviderId)
                        : null;
                    if (provider) { overrides.baseUrl = provider.baseUrl; overrides.apiKey = provider.apiKey; }
                    if (model) overrides.model = String(model).includes('||') ? String(model).split('||').pop() : model;

                    const debugBaseUrl = String(overrides.baseUrl || config.ai?.baseUrl || '').replace(/\/+$/, '');
                    const debugApiKey = overrides.apiKey || config.ai?.apiKey || '';
                    const debugModel = overrides.model || provider?.model || config.ai?.model;
                    const debugPayload = {
                        model: debugModel,
                        messages: built.messages,
                        max_tokens: overrides.maxTokens ?? config.ai?.maxTokens,
                        temperature: overrides.temperature ?? config.ai?.temperature,
                        stream: false
                    };

                    const upstreamResponse = await fetch(`${debugBaseUrl}/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            ...(debugApiKey ? { Authorization: `Bearer ${debugApiKey}` } : {})
                        },
                        body: JSON.stringify(debugPayload)
                    });
                    const upstreamRawText = await upstreamResponse.text();
                    let upstreamParsed = null;
                    try {
                        upstreamParsed = JSON.parse(upstreamRawText);
                    } catch {}
                    const upstreamMessage = upstreamParsed?.choices?.[0]?.message || {};
                    const rawText = aiClient.extractTextContent(upstreamMessage.content) || '';
                    // 清洗 ST 卡常见内部标签
                    let cleanedText = rawText;
                    try {
                        const { stripInternalTags } = await import('./variable-bridge.js');
                        cleanedText = stripInternalTags(rawText);
                    } catch {}

                    const reasoningContent = aiClient.extractTextContent(upstreamMessage.reasoning_content) || null;

                    // 模拟QQ分段下发
                    const splitEnabled = config.chat.splitMessage !== false;
                    const mentionPrefix = messageType === 'group' && config.chat.mentionSenderOnReply !== false ? `[CQ:at,qq=${userId || '000000'}] ` : '';
                    const rawSegments = splitEnabled
                        ? cleanedText.split(/\n\n+/).filter(s => s.trim())
                        : [cleanedText];
                    const qqSegments = rawSegments.map((seg, idx) => ({
                        index: idx,
                        text: seg.trim(),
                        qqText: idx === 0 ? `${mentionPrefix}${seg.trim()}` : seg.trim(),
                        isFirst: idx === 0,
                        hasPrefix: idx === 0 && !!mentionPrefix,
                        charCount: seg.trim().length
                    }));

                    aiResponse = {
                        text: cleanedText,
                        reasoningContent,
                        rawReasoningContent: upstreamMessage.reasoning_content ?? null,
                        rawContent: upstreamMessage.content ?? null,
                        rawMessage: upstreamMessage,
                        rawResponse: upstreamParsed,
                        rawResponseText: upstreamRawText,
                        usage: aiClient.getTokenStats(),
                        segments: qqSegments,
                        segmentCount: qqSegments.length,
                        splitConfig: { splitEnabled, mentionPrefix: !!mentionPrefix, segmentDelayMs: config.chat.segmentDelayMs ?? 300 }
                    };
                } catch (e) {
                    logger.warn('[靶场] AI调用失败', e.message);
                    aiResponse = { text: `[AI调用失败: ${e.message}]`, reasoningContent: null, usage: null };
                }
            }

            res.json({
                success: true,
                character: { name: built.character?.name || resolvedCharacterName },
                worldBook: resolvedInputs.worldBook ? { name: resolvedInputs.worldBook.name || null } : null,
                segments, stats,
                bindingTrace: resolvedInputs.bindingTrace,
                aiResponse,
                promptConfigSnapshot: resolvedInputs.preset,
                contextConfig: {
                    enabled: promptBuilder.contextConfig?.enabled !== false,
                    includeSessionFacts: promptBuilder.contextConfig?.includeSessionFacts !== false,
                    includeParticipants: promptBuilder.contextConfig?.includeParticipants !== false,
                    includeReplyReference: promptBuilder.contextConfig?.includeReplyReference !== false,
                    includeRecentUserIntent: promptBuilder.contextConfig?.includeRecentUserIntent !== false
                }
            });
        } catch (error) {
            logger.error('[靶场] 测试失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/prompt-range/agent-chat', requireAuth, async (req, res) => {
        try {
            const { messages, baseUrl, apiKey, model, rangeContext } = req.body || {};
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ success: false, error: '请提供消息数组' });
            }

            const normalizedMessages = messages.map((message) => ({ ...message }));
            const contextPrompt = buildRangeAgentContextPrompt(rangeContext);
            if (contextPrompt) {
                const firstSystemIndex = normalizedMessages.findIndex((message) => message?.role === 'system');
                if (firstSystemIndex >= 0) {
                    const originalContent = String(normalizedMessages[firstSystemIndex].content || '').trim();
                    normalizedMessages[firstSystemIndex] = {
                        ...normalizedMessages[firstSystemIndex],
                        content: `${originalContent}\n\n${contextPrompt}`.trim()
                    };
                } else {
                    normalizedMessages.unshift({ role: 'system', content: contextPrompt });
                }
            }

            const safeModel = (typeof model === 'string' && model.includes('||')) ? model.split('||').pop() : model;
            const replyResult = await aiClient.chat(normalizedMessages, { baseUrl, apiKey, model: safeModel });
            const reply = aiClient.getVisibleResponseContent(replyResult);
            const agentDecision = resolveRangeAgentDecision(reply, rangeContext);
            res.json({
                success: true,
                reply,
                reasoningContent: typeof replyResult?.reasoningContent === 'string' ? replyResult.reasoningContent : null,
                agentDecision
            });
        } catch (error) {
            logger.error('[靶场] Agent对话失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // --- 非 JSON 模式：评分 prompt 构建 ---
    function buildNoJsonOptimizePrompt({ goal, iterationNumber, maxIterations, lastResultText, promptsSummary, charSummary, wbSummary, corpusSection }) {
        return `你是 SillyTavern 写卡优化专家，融合明月秋青/萧谴/A.U.T.O 三套方法论。${corpusSection}

## 创作方法论(明月秋青)
性格调色盘: 底色+主色调+点缀+衍生,用行为展现性格,非贴标签
绝对零度: 白描事实,不修饰渲染,用名词动词避形容词,语料展现性格
八股检测(必须砍): 模糊词(似乎/仿佛/宛如) | 劣质比喻(小兽/涟漪/投石) | 微表情(嘴角上扬/闪过光芒) | 语气描写 | 大段内心 | 模板句

## 产出标准
角色卡字段: description/personality/scenario/first_mes/mes_example/system_prompt/post_history_instructions
世界书: key(触发词覆盖角色称呼/特征) | order(核心设定>细节) | position(角色前=人设,后=行为约束)
预设: 修改prompt的content字段,不改marker和name

## 场景策略
QQ群聊→砍冗长,砍动作,≤2条消息每段≤80字,如真人水群
角色扮演→去八股,用语料+行为替代形容词

## 当前任务
优化目标: ${goal} | 轮次: ${iterationNumber}/${maxIterations}

## 测试结果
${lastResultText}

## 当前配置
提示词: ${promptsSummary || '(无)'}
角色卡: ${charSummary || '(未提供)'}
世界书: ${wbSummary || '(未提供)'}

请按以下格式输出你的分析（使用自然语言，严格按分隔线分段）：

---ELO---
A_wins / B_wins / draw
理由：（从性格调色盘/绝对零度/八股角度具体说明判断依据）

---评估---
问题：
- 具体问题1（必须引用原文证据，如"第X句出现了..."）
- 具体问题2
亮点：
- 亮点1（必须引用原文证据）

---修改---
决策: modify 或 stop

仅在决策=modify时输出以下内容（否则留空）：

提示词修改:
标识: <prompt的identifier>
旧内容: <原文>
新内容: <修改后文字>

角色卡修改:
字段: <personality|description|scenario|first_mes|mes_example|system_prompt|post_history_instructions>
旧内容: <原文>
新内容: <修改后文字>

世界书修改:
索引: <条目编号,新增填-1>
操作: <update|add|delete>
key: <触发词,逗号分隔>
content: <新内容>

下一条测试消息: <10-30字>
修改摘要: <一句话>`;
    }

    // --- 非 JSON 模式：文本响应解析 ---
    function parseOptimizeTextResponse(text, prompts) {
        const result = {
            decision: 'stop',
            elo: { result: 'draw', reasoning: '' },
            evaluation: { issues: [], highlights: [] },
            modifiedPrompts: [],
            modifiedCharacter: null,
            modifiedWorldBook: [],
            nextTestMessage: '',
            changeSummary: ''
        };

        // 提取 ELO
        const eloMatch = text.match(/---ELO---\s*([\s\S]*?)(?=---评估---|---修改---|$)/i);
        if (eloMatch) {
            const eloBlock = eloMatch[1].trim();
            if (/B_wins/i.test(eloBlock)) result.elo.result = 'B_wins';
            else if (/A_wins/i.test(eloBlock)) result.elo.result = 'A_wins';
            const reasonMatch = eloBlock.match(/理由[：:]\s*([\s\S]*)/i);
            if (reasonMatch) result.elo.reasoning = reasonMatch[1].trim().slice(0, 500);
        }

        // 提取 评估
        const evalMatch = text.match(/---评估---\s*([\s\S]*?)(?=---修改---|$)/i);
        if (evalMatch) {
            const evalBlock = evalMatch[1];
            const issuesSection = evalBlock.match(/问题[：:]\s*([\s\S]*?)(?=亮点[：:]|$)/i);
            if (issuesSection) {
                result.evaluation.issues = issuesSection[1]
                    .split(/\n\s*[-•]\s*/).filter(s => s.trim())
                    .map(s => s.trim()).filter(Boolean);
            }
            const highlightsSection = evalBlock.match(/亮点[：:]\s*([\s\S]*)/i);
            if (highlightsSection) {
                result.evaluation.highlights = highlightsSection[1]
                    .split(/\n\s*[-•]\s*/).filter(s => s.trim())
                    .map(s => s.trim()).filter(Boolean);
            }
        }

        // 提取 修改
        const modMatch = text.match(/---修改---\s*([\s\S]*)/i);
        if (modMatch) {
            const modBlock = modMatch[1];
            if (/决策\s*[：:]\s*modify/i.test(modBlock)) {
                result.decision = 'modify';
            }

            // 解析提示词修改
            const promptSections = modBlock.split(/提示词修改[：:]/i).slice(1);
            for (const section of promptSections) {
                const endIdx = Math.min(
                    ...[section.indexOf('\n角色卡修改'), section.indexOf('\n世界书修改'), section.indexOf('\n下一条测试消息')].filter(i => i >= 0)
                );
                const block = endIdx >= 0 ? section.slice(0, endIdx) : section;
                const idMatch = block.match(/标识\s*[：:]\s*(.+)/i);
                const oldMatch = block.match(/旧内容\s*[：:]\s*([\s\S]*?)(?=\n新内容[：:]|$)/i);
                const newMatch = block.match(/新内容\s*[：:]\s*([\s\S]*?)(?=\n(?:标识|字段|索引|下一条测试消息|修改摘要|$)|\n\s*$)/i);
                if (idMatch && newMatch) {
                    const identifier = idMatch[1].trim();
                    const oldContent = oldMatch ? oldMatch[1].trim() : '';
                    const newContent = newMatch[1].trim();
                    if (newContent && newContent !== oldContent) {
                        result.modifiedPrompts.push({ identifier, oldContent, newContent });
                    }
                }
            }

            // 解析角色卡修改
            const charSections = modBlock.split(/角色卡修改[：:]/i).slice(1);
            if (charSections.length > 0 && result.decision === 'modify') {
                result.modifiedCharacter = [];
                for (const section of charSections) {
                    const endIdx = Math.min(
                        ...[section.indexOf('\n提示词修改'), section.indexOf('\n世界书修改'), section.indexOf('\n下一条测试消息')].filter(i => i >= 0)
                    );
                    const block = endIdx >= 0 ? section.slice(0, endIdx) : section;
                    const fieldMatch = block.match(/字段\s*[：:]\s*(.+)/i);
                    const oldMatch = block.match(/旧内容\s*[：:]\s*([\s\S]*?)(?=\n新内容[：:]|$)/i);
                    const newMatch = block.match(/新内容\s*[：:]\s*([\s\S]*?)(?=\n(?:字段|标识|索引|下一条测试消息|修改摘要|$)|\n\s*$)/i);
                    if (fieldMatch && newMatch) {
                        const field = fieldMatch[1].trim();
                        const oldContent = oldMatch ? oldMatch[1].trim() : '';
                        const newContent = newMatch[1].trim();
                        if (newContent && newContent !== oldContent) {
                            result.modifiedCharacter.push({ field, oldContent, newContent });
                        }
                    }
                }
                if (result.modifiedCharacter.length === 0) result.modifiedCharacter = null;
            }

            // 解析世界书修改
            const wbSections = modBlock.split(/世界书修改[：:]/i).slice(1);
            for (const section of wbSections) {
                const endIdx = Math.min(
                    ...[section.indexOf('\n提示词修改'), section.indexOf('\n角色卡修改'), section.indexOf('\n下一条测试消息')].filter(i => i >= 0)
                );
                const block = endIdx >= 0 ? section.slice(0, endIdx) : section;
                const idxMatch = block.match(/索引\s*[：:]\s*(-?\d+)/i);
                const actionMatch = block.match(/操作\s*[：:]\s*(update|add|delete)/i);
                const keyMatch = block.match(/key\s*[：:]\s*(.+)/i);
                const contentMatch = block.match(/content\s*[：:]\s*([\s\S]*?)(?=\n(?:索引|操作|key|content|标识|字段|下一条测试消息|修改摘要|$)|\n\s*$)/i);
                if (actionMatch) {
                    const idx = idxMatch ? parseInt(idxMatch[1]) : -1;
                    const entry = {};
                    if (keyMatch) entry.key = keyMatch[1].split(/[,，]/).map(s => s.trim()).filter(Boolean);
                    if (contentMatch) entry.content = contentMatch[1].trim();
                    result.modifiedWorldBook.push({
                        index: idx,
                        action: actionMatch[1],
                        entry,
                        oldContent: '',
                        newContent: entry.content || ''
                    });
                }
            }

            // 下一条测试消息
            const nextMatch = modBlock.match(/下一条测试消息\s*[：:]\s*(.+)/i);
            if (nextMatch) result.nextTestMessage = nextMatch[1].trim().slice(0, 100);

            // 修改摘要
            const summaryMatch = modBlock.match(/修改摘要\s*[：:]\s*(.+)/i);
            if (summaryMatch) result.changeSummary = summaryMatch[1].trim().slice(0, 200);
        }

        return result;
    }

    app.post('/api/prompt-range/optimize-step', requireAuth, async (req, res) => {
        try {
            const {
                goal, iterationNumber = 1, maxIterations = 5,
                lastUserMessage, lastAIResponse,
                currentPromptConfig, currentCharacter, currentWorldBook,
                modelProviderId, model, dryRun = false,
                testCorpus = '', noJsonMode = false
            } = req.body || {};

            if (!goal) {
                return res.status(400).json({ success: false, error: '请提供优化目标' });
            }

            const prompts = (currentPromptConfig?.prompts || []).filter(p => p.enabled !== false);
            const promptsSummary = prompts.map(p =>
                `标识: ${p.identifier || '?'} | 名称: ${p.name || ''} | 角色: ${p.role || 'system'}\n内容: ${(p.content || '').slice(0, 800)}`
            ).join('\n---\n');

            const charSummary = currentCharacter ? [
                currentCharacter.name ? `name: ${currentCharacter.name}` : '',
                currentCharacter.description ? `description: ${currentCharacter.description.slice(0, 600)}` : '',
                currentCharacter.personality ? `personality: ${currentCharacter.personality.slice(0, 400)}` : '',
                currentCharacter.scenario ? `scenario: ${currentCharacter.scenario.slice(0, 300)}` : '',
                currentCharacter.first_mes ? `first_mes: ${currentCharacter.first_mes.slice(0, 400)}` : '',
                currentCharacter.mes_example ? `mes_example: ${currentCharacter.mes_example.slice(0, 500)}` : '',
                currentCharacter.system_prompt ? `system_prompt: ${currentCharacter.system_prompt.slice(0, 600)}` : '',
                currentCharacter.post_history_instructions ? `post_history_instructions: ${currentCharacter.post_history_instructions.slice(0, 400)}` : ''
            ].filter(Boolean).join('\n') : '';

            const wbSummary = currentWorldBook && Array.isArray(currentWorldBook.entries) ? currentWorldBook.entries.slice(0, 20).map((e, i) =>
                `条目#${i}: key=${(e.key||e.keys||[]).join(',')} | order=${e.order||100} | position=${e.position===0?'角色前':'角色后'} | constant=${e.constant||false} | sticky=${e.sticky||0}\ncontent: ${(e.content||'').slice(0, 300)}`
            ).join('\n---\n') : '';

            const lastResultText = lastUserMessage && lastAIResponse
                ? `用户消息: ${lastUserMessage}\nAI回复: ${lastAIResponse}`
                : '(尚无测试结果)';

            const optimizeStartedAt = Date.now();
            const optimizeMetrics = {
                corpusSampleMs: 0,
                promptBuildMs: 0,
                modelCallMs: 0,
                parseMs: 0,
                totalMs: 0
            };

            // 智能语料采样: 有嵌入用语义搜索,无嵌入用随机
            let corpusSection = '';
            const corpusLines = rangeCorpusStore.lines || [];
            const corpusStartedAt = Date.now();
            if (corpusLines.length > 0) {
                const n = Math.min(5, corpusLines.length);
                let samples;
                if (rangeCorpusStore.embeddings && rangeCorpusStore.embeddings.length > 0) {
                    // 用优化目标做语义检索
                    samples = await searchCorpusByEmbedding(goal, n);
                    if (!samples) samples = [...corpusLines].sort(() => Math.random() - 0.5).slice(0, n);
                } else {
                    samples = [...corpusLines].sort(() => Math.random() - 0.5).slice(0, n);
                }
                corpusSection = `\n## 群聊语料(共${corpusLines.length}条,语义匹配${n}条)\n${samples.join('\n')}\n从真实语料风格设计测试消息。`;
            } else if (testCorpus) {
                corpusSection = `\n## 测试语料\n${testCorpus.slice(0, 1500)}`;
            }

            optimizeMetrics.corpusSampleMs = Date.now() - corpusStartedAt;

            const promptStartedAt = Date.now();
            const optimizePrompt = noJsonMode
                ? buildNoJsonOptimizePrompt({ goal, iterationNumber, maxIterations, lastResultText, promptsSummary, charSummary, wbSummary, corpusSection })
                : `你是 SillyTavern 写卡优化专家，融合明月秋青/萧谴/A.U.T.O 三套方法论。${corpusSection}

## 创作方法论(明月秋青)
性格调色盘: 底色+主色调+点缀+衍生,用行为展现性格,非贴标签
绝对零度: 白描事实,不修饰渲染,用名词动词避形容词,语料展现性格
八股检测(必须砍): 模糊词(似乎/仿佛/宛如) | 劣质比喻(小兽/涟漪/投石) | 微表情(嘴角上扬/闪过光芒) | 语气描写 | 大段内心 | 模板句

## 产出标准(萧谴+明月秋青)
角色卡字段: description(浓缩人设) | personality(行为模式) | scenario(场景) | first_mes(开场用语料展现性格) | mes_example(对话示例用<START>标签) | system_prompt(系统级约束) | post_history_instructions(后置注入)
世界书: key(触发词覆盖角色称呼/特征) | order(核心设定>细节) | position(角色前=人设,后=行为约束) | content(去八股,用行为描述)
预设: 修改prompt的content字段,不改marker和name

## 结构化工作流(A.U.T.O)
阶段1 DIAGNOSE: 识别回复中的八股/冗余/角色偏离
阶段2 TUNE: 按性格调色盘+绝对零度修改→ELO对战验证
阶段3 VERIFY: 换语料验证→确保没改坏

## 场景策略
QQ群聊→砍冗长,砍动作,≤2条消息每段≤80字,如真人水群
角色扮演→去八股,用语料+行为替代形容词

## ELO对战
A(旧版回复) vs B(新版回复): A_wins / B_wins / draw
B连胜2次或draw 2次→达标停止

## 优化目标: ${goal} | 轮次: ${iterationNumber}/${maxIterations}

## 测试结果
${lastResultText}

## 当前配置
提示词: ${promptsSummary || '(无)'}
角色卡: ${charSummary || '(未提供)'}
世界书: ${wbSummary || '(未提供)'}

返回JSON:
{
  "decision": "modify"或"stop",
  "elo": {"result":"A_wins"或"B_wins"或"draw","reasoning":"从性格调色盘/绝对零度/八股角度说明"},
  "evaluation": {"issues":["问题"],"highlights":["亮点"]},
  "modifiedPrompts": [{"identifier":"id","oldContent":"原文","newContent":"新文"}],
  "modifiedCharacter": [{"field":"字段名","oldContent":"原文","newContent":"新文"}],
  "modifiedWorldBook": [{"index":-1,"action":"update/add/delete","entry":{}}],
  "nextTestMessage": "验证消息",
  "changeSummary": "一句话"
}`;

            optimizeMetrics.promptBuildMs = Date.now() - promptStartedAt;

            const overrides = { temperature: 0.4, maxTokens: 4096 };
            if (modelProviderId) {
                const provider = (config.ai?.providers || []).find(p => p.id === modelProviderId);
                if (provider) { overrides.baseUrl = provider.baseUrl; overrides.apiKey = provider.apiKey; }
            }
            if (model) overrides.model = String(model).includes('||') ? String(model).split('||').pop() : model;

            const modelStartedAt = Date.now();
            const aiResult = await aiClient.chat([{ role: 'user', content: optimizePrompt }], overrides);
            optimizeMetrics.modelCallMs = Date.now() - modelStartedAt;
            const rawText = aiClient.getVisibleResponseContent(aiResult);

            const parseStartedAt = Date.now();
            let parsed;
            if (noJsonMode) {
                parsed = parseOptimizeTextResponse(rawText, prompts);
            } else {
                const tryParse = (text) => {
                    const trimmed = text.trim();
                    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
                    const jsonText = fence ? fence[1].trim() : trimmed;
                    const bracketStart = jsonText.indexOf('{');
                    const bracketEnd = jsonText.lastIndexOf('}');
                    if (bracketStart >= 0 && bracketEnd > bracketStart) {
                        return JSON.parse(jsonText.slice(bracketStart, bracketEnd + 1));
                    }
                    return JSON.parse(jsonText);
                };
                try { parsed = tryParse(rawText); } catch {
                    try { parsed = JSON.parse(rawText); } catch {
                        parsed = { decision: 'stop', evaluation: { score: 5, reasoning: '无法解析AI返回', meetsExpectation: false }, modifiedPrompts: [], changeSummary: 'AI返回格式异常' };
                    }
                }
            }

            optimizeMetrics.parseMs = Date.now() - parseStartedAt;

            const decision = parsed.decision === 'modify' ? 'modify' : 'stop';

            // 解析提示词修改
            const mods = Array.isArray(parsed.modifiedPrompts) ? parsed.modifiedPrompts : [];
            const changedIdentifiers = new Set();
            const modifiedDetail = [];
            for (const mod of mods) {
                if (!mod.identifier) continue;
                const orig = prompts.find(p => p.identifier === mod.identifier);
                const oldContent = mod.oldContent || orig?.content || '';
                const newContent = mod.newContent || '';
                if (!newContent || newContent === oldContent) continue;
                changedIdentifiers.add(mod.identifier);
                modifiedDetail.push({ type: 'prompt', identifier: mod.identifier, oldContent, newContent });
            }

            // 解析角色卡修改(支持单对象和数组)
            let modifiedCharacter = null;
            const charFields = ['description','personality','scenario','first_mes','mes_example','system_prompt','post_history_instructions'];
            const mcList = Array.isArray(parsed.modifiedCharacter) ? parsed.modifiedCharacter : (parsed.modifiedCharacter ? [parsed.modifiedCharacter] : []);
            if (mcList.length > 0) {
                modifiedCharacter = [];
                for (const mc of mcList) {
                    if (!mc.field || !mc.newContent) continue;
                    if (!charFields.includes(mc.field)) continue;
                    const oldContent = mc.oldContent || (currentCharacter ? (currentCharacter[mc.field] || '') : '');
                    if (mc.newContent === oldContent) continue;
                    modifiedCharacter.push({ field: mc.field, oldContent, newContent: mc.newContent });
                    modifiedDetail.push({ type: 'character', identifier: `角色卡.${mc.field}`, oldContent, newContent: mc.newContent });
                }
                if (modifiedCharacter.length === 0) modifiedCharacter = null;
            }

            // 解析世界书修改(加格式校验)
            const mwbs = Array.isArray(parsed.modifiedWorldBook) ? parsed.modifiedWorldBook : [];
            const modifiedWorldBook = [];
            const SEL_LOGIC_MAP = { 'AND_ANY':0, 'NOT_ALL':1, 'NOT_ANY':2, 'AND_ALL':3 };
            const VALID_POSITIONS = [0, 1, 4];
            for (const mwb of mwbs) {
                if (!mwb.entry || !mwb.action) continue;
                const entry = mwb.entry;
                // 格式校验
                if (typeof entry.selectiveLogic === 'string') {
                    entry.selectiveLogic = SEL_LOGIC_MAP[entry.selectiveLogic] ?? 0;
                }
                if (typeof entry.order !== 'number' || isNaN(entry.order)) entry.order = 100;
                if (!VALID_POSITIONS.includes(entry.position)) entry.position = 1;
                if (typeof entry.depth !== 'number' || isNaN(entry.depth)) entry.depth = 4;
                if (typeof entry.sticky !== 'number' || isNaN(entry.sticky)) entry.sticky = 0;
                if (typeof entry.cooldown !== 'number' || isNaN(entry.cooldown)) entry.cooldown = 0;
                entry.constant = !!entry.constant;
                if (!Array.isArray(entry.key)) entry.key = Array.isArray(entry.keys) ? entry.keys : [];
                if (!Array.isArray(entry.keysecondary)) entry.keysecondary = [];
                const idx = typeof mwb.index === 'number' ? mwb.index : -1;
                const oldEntry = (idx >= 0 && currentWorldBook?.entries) ? currentWorldBook.entries[idx] : null;
                modifiedWorldBook.push({
                    index: idx, action: mwb.action,
                    entry,
                    oldContent: oldEntry?.content || '',
                    newContent: entry?.content || ''
                });
                if (mwb.action === 'update' && oldEntry) {
                    modifiedDetail.push({ type: 'worldbook', identifier: `世界书条目#${idx}`, oldContent: oldEntry.content || '', newContent: entry.content || '' });
                } else if (mwb.action === 'add') {
                    modifiedDetail.push({ type: 'worldbook', identifier: '世界书(新增)', oldContent: '', newContent: entry.content || '' });
                }
            }

            const eloResult = parsed.elo || { result: 'draw', reasoning: '' };
            const evalResult = parsed.evaluation || { issues: [], highlights: [] };
            // ELO: B连胜2次或draw 2次则停止
            const lastEloResults = (rangeCorpusStore._eloHistory = rangeCorpusStore._eloHistory || []);
            lastEloResults.push(eloResult.result);
            if (lastEloResults.length > 3) lastEloResults.shift();
            const bWins = lastEloResults.filter(r => r === 'B_wins').length;
            const shouldStop = decision === 'stop' || iterationNumber >= maxIterations || bWins >= 2;

            optimizeMetrics.totalMs = Date.now() - optimizeStartedAt;
            logger.info('[靶场] optimize-step 阶段耗时', {
                iterationNumber,
                corpusLineCount: corpusLines.length,
                hasEmbeddings: Array.isArray(rangeCorpusStore.embeddings) && rangeCorpusStore.embeddings.length > 0,
                metrics: optimizeMetrics
            });

            res.json({
                success: true,
                elo: {
                    result: eloResult.result || 'draw',
                    reasoning: String(eloResult.reasoning || ''),
                    history: lastEloResults,
                    bWins
                },
                evaluation: {
                    issues: Array.isArray(evalResult.issues) ? evalResult.issues : [],
                    highlights: Array.isArray(evalResult.highlights) ? evalResult.highlights : []
                },
                modifiedPrompts: modifiedDetail.filter(d => d.type === 'prompt'),
                modifiedCharacter,
                modifiedWorldBook,
                allChanges: modifiedDetail,
                changedIdentifiers: [...changedIdentifiers],
                nextTestMessage: String(parsed.nextTestMessage || lastUserMessage || ''),
                changeSummary: String(parsed.changeSummary || ''),
                iterationNumber,
                rawAIResponse: rawText.slice(0, 2000)
            });
        } catch (error) {
            logger.error('[靶场] 优化步骤失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.post('/api/prompt-range/snapshot', requireAuth, (req, res) => {
        try {
            const { label, promptConfig, testMessage, stats } = req.body || {};
            const id = `snap_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            const snapshot = {
                id, label: label || `快照 ${promptSnapshots.size + 1}`,
                createdAt: Date.now(), promptConfig, testMessage, stats
            };
            promptSnapshots.set(id, snapshot);
            res.json({ success: true, snapshot: { id, label: snapshot.label, createdAt: snapshot.createdAt } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/prompt-range/snapshots', requireAuth, (req, res) => {
        const list = [...promptSnapshots.values()]
            .map(s => ({ id: s.id, label: s.label, createdAt: s.createdAt }))
            .sort((a, b) => b.createdAt - a.createdAt);
        res.json({ success: true, snapshots: list });
    });

    app.post('/api/prompt-range/restore', requireAuth, (req, res) => {
        const { snapshotId } = req.body || {};
        const snapshot = promptSnapshots.get(snapshotId);
        if (!snapshot) {
            return res.status(404).json({ success: false, error: '快照不存在' });
        }
        res.json({ success: true, snapshot });
    });

    app.delete('/api/prompt-range/snapshots/:id', requireAuth, (req, res) => {
        const id = req.params.id;
        if (id === '__all__') {
            promptSnapshots.clear();
            res.json({ success: true, message: '已清除所有快照' });
        } else {
            promptSnapshots.delete(id);
            res.json({ success: true, message: '已删除快照' });
        }
    });

    // 靶场偏好持久化
    const RANGE_PREFS_PATH = path.join(__dirname, '..', 'data', 'range-prefs.json');
    function loadRangePrefs() { try { return JSON.parse(fsSync.readFileSync(RANGE_PREFS_PATH, 'utf8')); } catch(e) { return {}; } }
    function saveRangePrefs(prefs) { fsSync.writeFileSync(RANGE_PREFS_PATH, JSON.stringify(prefs, null, 2), 'utf8'); }

    app.get('/api/prompt-range/prefs', requireAuth, (req, res) => {
        res.json({ success: true, prefs: loadRangePrefs() });
    });
    app.post('/api/prompt-range/prefs', requireAuth, (req, res) => {
        const prefs = req.body || {};
        saveRangePrefs(prefs);
        res.json({ success: true });
    });

    app.get('/api/prompt-range/models', requireAuth, (req, res) => {
        const providers = (config.ai?.providers || []).map(p => ({
            id: p.id, name: p.name, provider: p.provider,
            model: p.model,
            models: (p.models || []).map(m => ({
                ...m,
                capability: classifyModel(m.id || m.name || '')
            })),
            chatModels: (p.models || []).filter(m => classifyModel(m.id||m.name||'') === 'chat'),
            embedModels: (p.models || []).filter(m => classifyModel(m.id||m.name||'') === 'embedding'),
            rerankModels: (p.models || []).filter(m => classifyModel(m.id||m.name||'') === 'rerank'),
            hasEmbedSupport: (p.models || []).some(m => classifyModel(m.id||m.name||'') === 'embedding'),
            hasRerankSupport: (p.models || []).some(m => classifyModel(m.id||m.name||'') === 'rerank')
        }));
        const activeProviderId = config.chat?.modelProviderId || config.ai?.activeProviderId || '';
        const activeModel = config.chat?.model || config.ai?.model || '';
        const corpusStatus = rangeCorpusStore.lines.length > 0 ? {
            lineCount: rangeCorpusStore.lines.length,
            hasEmbeddings: Array.isArray(rangeCorpusStore.embeddings) && rangeCorpusStore.embeddings.length > 0,
            embedModel: rangeCorpusStore.embedModel || null,
            embedProvider: rangeCorpusStore.embedProvider || null,
            stats: rangeCorpusStore.stats
        } : null;
        res.json({ success: true, providers, activeProviderId, activeModel, corpusStatus });
    });

    app.post('/api/prompt-range/corpus-embed', requireAuth, async (req, res) => {
        try {
            if (rangeCorpusStore.lines.length === 0) {
                return res.status(400).json({ success: false, error: '请先导入语料' });
            }
            const { modelProviderId, model: explicitModel } = req.body || {};

            // 供应商选择: 指定优先, 否则自动找有嵌入模型的
            let foundProvider = null, foundModel = null;
            const ordered = [...(config.ai?.providers || [])];
            if (modelProviderId) {
                const idx = ordered.findIndex(p => p.id === modelProviderId);
                if (idx >= 0) ordered.unshift(...ordered.splice(idx, 1));
            }

            if (explicitModel) {
                // 用户手动选了模型
                for (const p of ordered) {
                    if (p.baseUrl && p.apiKey) { foundProvider = p; foundModel = explicitModel; break; }
                }
            } else {
                // 自动检测
                for (const p of ordered) {
                    const embedM = (p.models || []).find(m => classifyModel(m.id||m.name||'') === 'embedding');
                    if (embedM && p.baseUrl && p.apiKey) { foundProvider = p; foundModel = embedM.id || embedM.name; break; }
                }
            }
            if (!foundModel || !foundProvider) {
                return res.status(400).json({ success: false, error: '没有可用嵌入模型。嵌入模型名需包含 embed/bge/e5/gte/voyage 等关键字。' });
            }

            const baseUrl = foundProvider.baseUrl.replace(/\/+$/, '');
            const apiKey = foundProvider.apiKey;
            const inputs = rangeCorpusStore.lines.map(l => { const c = l.indexOf(':'); return c > 0 ? l.slice(c+1).trim() : l; });
            const allEmbeddings = [];
            const batchSize = 50;
            const totalBatches = Math.ceil(inputs.length / batchSize);

            corpusEmbedProgress = { running: true, stage: 'embedding', currentMessage: `正在向量化 ${inputs.length} 条语料...`, progressPercent: 0, totalBatches, currentBatch: 0, error: null };
            corpusEmbedAborted = false;

            for (let i = 0; i < inputs.length; i += batchSize) {
                if (corpusEmbedAborted) {
                    corpusEmbedProgress = { running: false, stage: 'cancelled', currentMessage: '已取消', progressPercent: 0, totalBatches, currentBatch: 0, error: null };
                    return res.json({ success: false, error: '已取消' });
                }
                const batch = inputs.slice(i, i + batchSize);
                const batchNum = Math.floor(i / batchSize) + 1;
                corpusEmbedProgress.currentBatch = batchNum;
                corpusEmbedProgress.progressPercent = Math.round((batchNum / totalBatches) * 100);
                corpusEmbedProgress.currentMessage = `向量化中 ${batchNum}/${totalBatches} (${corpusEmbedProgress.progressPercent}%)`;

                const resp = await fetch(`${baseUrl}/embeddings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: foundModel, input: batch })
                });
                if (!resp.ok) throw new Error(`嵌入失败 HTTP ${resp.status}`);
                const result = await resp.json();
                allEmbeddings.push(...(result.data || []).map(d => d.embedding));
            }

            rangeCorpusStore.embeddings = allEmbeddings;
            rangeCorpusStore.embedModel = foundModel;
            rangeCorpusStore.embedProvider = foundProvider.name;
            rangeCorpusStore.embedProviderId = foundProvider.id;
            // 固化嵌入到磁盘
            try {
                const embedPath = path.join(__dirname, '..', 'data', 'range-corpus-embeddings.json');
                fsSync.writeFileSync(embedPath, JSON.stringify({
                    embeddings: allEmbeddings, model: foundModel, provider: foundProvider.name,
                    providerId: foundProvider.id, count: allEmbeddings.length, updatedAt: Date.now()
                }), 'utf8');
            } catch (e) { logger.warn('[靶场] 嵌入固化失败', e.message); }
            corpusEmbedProgress = { running: false, stage: 'completed', currentMessage: `已完成 ${allEmbeddings.length} 条向量化`, progressPercent: 100, totalBatches, currentBatch: totalBatches, error: null };

            res.json({
                success: true, embedded: allEmbeddings.length,
                model: foundModel, provider: foundProvider.name,
                dimension: allEmbeddings[0]?.length || 0
            });
        } catch (error) {
            corpusEmbedProgress = { running: false, stage: 'failed', currentMessage: `嵌入失败: ${error.message}`, progressPercent: 0, totalBatches: 0, currentBatch: 0, error: error.message };
            logger.error('[靶场] 语料嵌入失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.get('/api/prompt-range/corpus', requireAuth, (req, res) => {
        res.json({ success: true, corpus: rangeCorpusStore.lines.join('\n'), stats: rangeCorpusStore.stats });
    });

    app.post('/api/prompt-range/apply-changes', requireAuth, async (req, res) => {
        try {
            const { modifiedPrompts, modifiedCharacter, modifiedWorldBook, characterName, worldbookName } = req.body || {};
            const results = [];
            const backupDir = path.join(config.chat?.dataDir || './data', 'backups', `range_${Date.now()}`);
            fsSync.mkdirSync(backupDir, { recursive: true });

            // 1. 应用预设修改
            if (Array.isArray(modifiedPrompts) && modifiedPrompts.length > 0) {
                const preset = config.preset || {};
                const prompts = preset.prompts || [];
                for (const mod of modifiedPrompts) {
                    const p = prompts.find(pp => pp.identifier === mod.identifier);
                    if (p) {
                        const backupPath = path.join(backupDir, `preset_${mod.identifier}.json`);
                        fsSync.writeFileSync(backupPath, JSON.stringify({ identifier: mod.identifier, oldContent: p.content }, null, 2), 'utf8');
                        p.content = mod.newContent;
                        results.push({ type: 'preset', identifier: mod.identifier, status: 'applied' });
                    }
                }
                preset.prompts = prompts;
                config.preset = preset;
                saveConfig(config);
            }

            // 2. 应用角色卡修改
            if (modifiedCharacter && characterName) {
                const charUpdates = {};
                const charList = Array.isArray(modifiedCharacter) ? modifiedCharacter : [modifiedCharacter];
                for (const mc of charList) {
                    if (mc.field && mc.newContent) { charUpdates[mc.field] = mc.newContent; }
                }
                if (Object.keys(charUpdates).length > 0) {
                    const charFile = characterName.endsWith('.png') ? characterName : `${characterName}.png`;
                    const backupPath = path.join(backupDir, charFile);
                    const charPath = path.join(config.chat?.dataDir || './data', 'characters', charFile);
                    if (fsSync.existsSync(charPath)) {
                        fsSync.copyFileSync(charPath, backupPath);
                    }
                    characterManager.updateCharacter(characterName.replace(/\.png$/i, ''), charUpdates);
                    results.push({ type: 'character', fields: Object.keys(charUpdates), status: 'applied' });
                }
            }

            // 3. 应用世界书修改
            if (Array.isArray(modifiedWorldBook) && modifiedWorldBook.length > 0 && worldbookName) {
                const wbPath = path.join(config.chat?.dataDir || './data', 'worlds', worldbookName);
                const backupPath = path.join(backupDir, worldbookName);
                if (fsSync.existsSync(wbPath)) {
                    fsSync.copyFileSync(wbPath, backupPath);
                }
                let wb = fsSync.existsSync(wbPath) ? JSON.parse(fsSync.readFileSync(wbPath, 'utf8')) : { entries: [] };
                if (!Array.isArray(wb.entries)) wb.entries = [];
                for (const mwb of modifiedWorldBook) {
                    if (mwb.action === 'add') {
                        wb.entries.push(mwb.entry);
                        results.push({ type: 'worldbook', action: 'add', status: 'applied' });
                    } else if (mwb.action === 'delete' && mwb.index >= 0) {
                        wb.entries.splice(mwb.index, 1);
                        results.push({ type: 'worldbook', action: 'delete', index: mwb.index, status: 'applied' });
                    } else if (mwb.action === 'update' && mwb.index >= 0 && mwb.index < wb.entries.length) {
                        Object.assign(wb.entries[mwb.index], mwb.entry);
                        results.push({ type: 'worldbook', action: 'update', index: mwb.index, status: 'applied' });
                    }
                }
                fsSync.writeFileSync(wbPath, JSON.stringify(wb, null, 2), 'utf8');
            }

            res.json({ success: true, results, backupDir });
        } catch (error) {
            logger.error('[靶场] 应用修改失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    function parseRangeAgentDecision(reply = '') {
        const raw = String(reply || '').trim();
        if (!raw) return null;

        if (/^\s*\{/.test(raw)) {
            try {
                const parsed = JSON.parse(raw);
                const type = String(parsed.decision || parsed.action || '').trim().toLowerCase();
                if (!type) return null;
                return {
                    type,
                    phase: String(parsed.phase || '').trim().toLowerCase(),
                    reason: String(parsed.reason || '').trim(),
                    focusIssue: String(parsed.focusIssue || '').trim(),
                    testMessage: String(parsed.testMessage || parsed.message || '').trim(),
                    summary: String(parsed.summary || parsed.info || '').trim(),
                    nextStep: String(parsed.nextStep || '').trim().toLowerCase()
                };
            } catch {
                // 继续走自然语言兜底
            }
        }

        const normalized = raw
            .replace(/\r/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        const lower = normalized.toLowerCase();

        const extractFocusIssue = (text) => {
            const patterns = [
                /焦点问题[:：]\s*([^\n。；;]+)/i,
                /当前最关注的问题[:：]\s*([^\n。；;]+)/i,
                /主要问题[:：]\s*([^\n。；;]+)/i
            ];
            for (const pattern of patterns) {
                const match = String(text || '').match(pattern);
                if (match?.[1]) return match[1].trim();
            }
            return '';
        };

        const extractReason = (text) => {
            const patterns = [
                /原因[:：]\s*([^\n]+)/i,
                /理由[:：]\s*([^\n]+)/i,
                /判断[:：]\s*([^\n]+)/i
            ];
            for (const pattern of patterns) {
                const match = String(text || '').match(pattern);
                if (match?.[1]) return match[1].trim();
            }
            return String(text || '').split('\n').map(line => line.trim()).find(Boolean) || '';
        };

        if (/\baction\s*:\s*test\b/i.test(raw)) {
            const match = raw.match(/ACTION:\s*TEST\s*\|?\s*(.*)/i);
            return {
                type: 'test',
                phase: '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: String(match?.[1] || '').trim(),
                summary: '',
                nextStep: /score_after_reply/i.test(raw) ? 'score_after_reply' : ''
            };
        }

        if (/\baction\s*:\s*score\b/i.test(raw)) {
            return {
                type: 'score',
                phase: '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/\baction\s*:\s*modify\b/i.test(raw)) {
            const match = raw.match(/ACTION:\s*MODIFY\s*\|?\s*(.*)/i);
            return {
                type: 'modify',
                phase: '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: String(match?.[1] || '').trim(),
                nextStep: ''
            };
        }

        if (/\baction\s*:\s*next_phase\b/i.test(raw)) {
            return {
                type: 'next_phase',
                phase: '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/\baction\s*:\s*done\b/i.test(raw)) {
            return {
                type: 'done',
                phase: '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (normalized === '评分') {
            return {
                type: 'score',
                phase: lower.includes('verify') ? 'verify' : lower.includes('tune') ? 'tune' : 'diagnose',
                reason: '模型返回了极短评分动作词',
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (normalized === '测试') {
            return {
                type: 'test',
                phase: lower.includes('verify') ? 'verify' : lower.includes('tune') ? 'tune' : 'diagnose',
                reason: '模型返回了极短测试动作词',
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (normalized === '修改') {
            return {
                type: 'modify',
                phase: lower.includes('tune') ? 'tune' : '',
                reason: '模型返回了极短修改动作词',
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (normalized === '下一阶段') {
            return {
                type: 'next_phase',
                phase: '',
                reason: '模型返回了极短阶段推进动作词',
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (normalized === '完成') {
            return {
                type: 'done',
                phase: lower.includes('verify') ? 'verify' : '',
                reason: '模型返回了极短完成动作词',
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/优先输出 score|先评分|应该先评分|应当先评分|建议先评分|先进行评分|先做评分|需要评分|进行评分|应先评分|先给评分|先根据现有结果评分|先分析当前回复|先分析当前结果|先对当前回复评分/.test(normalized)) {
            return {
                type: 'score',
                phase: lower.includes('verify') ? 'verify' : lower.includes('tune') ? 'tune' : 'diagnose',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/先测试|应该测试|应当测试|建议测试|重新测试|出一条测试|发一条测试|给一条测试|验证消息|测试消息|先出题|先测一轮|再测一轮|需要测试/.test(normalized)) {
            return {
                type: 'test',
                phase: lower.includes('verify') ? 'verify' : lower.includes('tune') ? 'tune' : 'diagnose',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: /评分|score/.test(normalized) ? 'score_after_reply' : ''
            };
        }

        if (/进入下一阶段|下一阶段|转入调优|转入验证|进入调优|进入验证/.test(normalized)) {
            return {
                type: 'next_phase',
                phase: /验证|verify/.test(normalized) ? 'verify' : /调优|tune/.test(normalized) ? 'tune' : '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/结束流程|可以结束|达标|无需继续|停止迭代|完成优化/.test(normalized)) {
            return {
                type: 'done',
                phase: /验证|verify/.test(normalized) ? 'verify' : '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: '',
                nextStep: ''
            };
        }

        if (/修改建议|建议修改|需要修改|进入修改|应该修改|优化建议/.test(normalized)) {
            return {
                type: 'modify',
                phase: /调优|tune/.test(normalized) ? 'tune' : '',
                reason: extractReason(raw),
                focusIssue: extractFocusIssue(raw),
                testMessage: '',
                summary: normalized.slice(0, 200),
                nextStep: ''
            };
        }

        return null;
    }

    function inferRangeAgentDecisionFromNarrative(reply = '', rangeContext = {}) {
        const raw = String(reply || '').trim();
        if (!raw) return null;
        const normalized = raw.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
        const lines = String(reply || '').split('\n').map(line => line.trim()).filter(Boolean);
        const hasLatestTest = !!rangeContext?.latestTest?.userMessage && !!rangeContext?.latestTest?.aiResponse;

        const detectPhase = () => {
            if (/验证|verify/i.test(raw)) return 'verify';
            if (/调优|修改|改写|优化建议|tune/i.test(raw)) return 'tune';
            return 'diagnose';
        };
        const extractFocusIssue = () => {
            for (const p of [/焦点问题[:：]\s*([^\n。；;]+)/i, /当前最关注的问题[:：]\s*([^\n。；;]+)/i, /主要问题[:：]\s*([^\n。；;]+)/i, /问题集中在[:：]\s*([^\n。；;]+)/i, /问题[:：]\s*([^\n。；;]+)/i]) {
                const m = raw.match(p);
                if (m?.[1]) return m[1].trim();
            }
            return '';
        };
        const extractReason = () => { return lines[0] || ''; };
        const extractSuggestedTest = () => {
            for (const p of [/测试消息[:：]\s*([^\n]+)/i, /下一条测试(?:可以是)?[:：]?\s*([^\n]+)/i, /建议先发[:：]?\s*([^\n]+)/i]) {
                const m = raw.match(p);
                if (m?.[1]) return m[1].trim().slice(0, 60);
            }
            return '';
        };

        if (/^\[?评分\]?/m.test(raw) || /综合得分|评分[:：]|改写建议|当前应先评分|应该先评分|应当先评分|建议先评分|先根据现有结果评分|先分析当前回复|先分析当前结果/.test(raw) || (hasLatestTest && /问题[:：]|建议[:：]|当前回复/.test(raw))) {
            return { type: 'score', phase: detectPhase(), reason: extractReason(), focusIssue: extractFocusIssue(), testMessage: '', summary: '', nextStep: '' };
        }
        if (/测试消息|建议先测试|应该测试|应当测试|重新测试|再测一轮|先出题|先测一轮|给一条测试|发一条测试|可以先发一句|可以发一句/.test(raw)) {
            return { type: 'test', phase: detectPhase(), reason: extractReason(), focusIssue: extractFocusIssue(), testMessage: extractSuggestedTest(), summary: '', nextStep: /评分|score/.test(raw) ? 'score_after_reply' : '' };
        }
        if (/修改建议|建议改成|改写如下|可以改成|优化建议|建议改写/.test(raw)) {
            return { type: 'modify', phase: 'tune', reason: extractReason(), focusIssue: extractFocusIssue(), testMessage: '', summary: lines.slice(0, 4).join(' ').slice(0, 200), nextStep: '' };
        }
        if (/进入下一阶段|转入下一阶段|进入调优|进入验证|转入调优|转入验证/.test(raw)) {
            return { type: 'next_phase', phase: /验证/.test(raw) ? 'verify' : 'tune', reason: extractReason(), focusIssue: extractFocusIssue(), testMessage: '', summary: '', nextStep: '' };
        }
        if (/可以结束|结束流程|无需继续|停止迭代|完成优化|已经达标/.test(raw)) {
            return { type: 'done', phase: detectPhase(), reason: extractReason(), focusIssue: extractFocusIssue(), testMessage: '', summary: '', nextStep: '' };
        }
        return null;
    }

    function resolveRangeAgentDecision(reply = '', rangeContext = {}) {
        return parseRangeAgentDecision(reply) || inferRangeAgentDecisionFromNarrative(reply, rangeContext) || null;
    }

    app.post('/api/prompt-range/corpus-clear', requireAuth, (req, res) => {
        rangeCorpusStore = { lines: [], stats: null, updatedAt: 0, embeddings: null };
        clearCorpusSearchCache();
        try {
            const storePath = path.join(__dirname, '..', 'data', 'range-corpus.json');
            const embedPath = path.join(__dirname, '..', 'data', 'range-corpus-embeddings.json');
            if (fsSync.existsSync(storePath)) fsSync.unlinkSync(storePath);
            if (fsSync.existsSync(embedPath)) fsSync.unlinkSync(embedPath);
        } catch (e) {}
        res.json({ success: true });
    });

    app.post('/api/prompt-range/corpus-abort', requireAuth, (req, res) => {
        corpusEmbedAborted = true;
        res.json({ success: true, message: '已发送取消信号' });
    });

    app.get('/api/prompt-range/corpus-search', requireAuth, async (req, res) => {
        try {
            const { q, limit = 3 } = req.query || {};
            if (!q) return res.json({ success: true, results: [] });
            const topK = Math.min(Number(limit) || 3, 10);
            let results;
            if (rangeCorpusStore.embeddings && rangeCorpusStore.embeddings.length > 0) {
                results = await searchCorpusByEmbedding(q, topK);
            }
            if (!results || results.length === 0) {
                // 回退到关键词匹配
                const query = String(q).toLowerCase();
                results = rangeCorpusStore.lines
                    .filter(l => l.toLowerCase().includes(query))
                    .slice(0, topK);
            }
            res.json({ success: true, results: results || [], hasEmbeddings: !!rangeCorpusStore.embeddings });
        } catch (error) {
            res.json({ success: true, results: [], error: error.message });
        }
    });

    const corpusSearchCache = new Map();

    function buildCorpusSearchCacheKey(query, topK = 5) {
        return JSON.stringify({
            query: String(query || '').trim(),
            topK,
            embedModel: rangeCorpusStore.embedModel || 'text-embedding-3-small',
            embedProviderId: rangeCorpusStore.embedProviderId || '',
            corpusUpdatedAt: rangeCorpusStore.updatedAt || 0,
            corpusLineCount: Array.isArray(rangeCorpusStore.lines) ? rangeCorpusStore.lines.length : 0,
            embeddingCount: Array.isArray(rangeCorpusStore.embeddings) ? rangeCorpusStore.embeddings.length : 0
        });
    }

    function clearCorpusSearchCache() {
        corpusSearchCache.clear();
    }

    async function searchCorpusByEmbedding(query, topK = 5) {
        if (!rangeCorpusStore.embeddings || rangeCorpusStore.embeddings.length === 0) return null;

        const cacheKey = buildCorpusSearchCacheKey(query, topK);
        if (corpusSearchCache.has(cacheKey)) {
            return corpusSearchCache.get(cacheKey);
        }

        const embedModel = rangeCorpusStore.embedModel || 'text-embedding-3-small';
        const embedProviderId = rangeCorpusStore.embedProviderId;
        const providers = config.ai?.providers || [];
        const embedProv = embedProviderId ? providers.find(p => p.id === embedProviderId) : providers[0];
        if (!embedProv?.baseUrl || !embedProv?.apiKey) return null;

        const baseUrl = embedProv.baseUrl.replace(/\/+$/, '');
        const apiKey = embedProv.apiKey;
        const apiUrl = `${baseUrl}/embeddings`;

        try {
            const qResp = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({ model: embedModel, input: [query] }),
                signal: AbortSignal.timeout(15000)
            });
            if (!qResp.ok) return null;
            const qResult = await qResp.json();
            const qVec = qResult.data[0].embedding;

            const embeds = rangeCorpusStore.embeddings;
            const scores = embeds.map((vec, idx) => {
                let dot = 0, qn = 0, vn = 0;
                for (let j = 0; j < qVec.length; j++) {
                    dot += qVec[j] * vec[j];
                    qn += qVec[j] * qVec[j];
                    vn += vec[j] * vec[j];
                }
                return { idx, score: dot / (Math.sqrt(qn) * Math.sqrt(vn) + 1e-10) };
            });
            scores.sort((a, b) => b.score - a.score);

            let results = null;
            const rerankModel = (embedProv.models || []).find(m => classifyModel(m.id || m.name || '') === 'rerank');
            if (rerankModel) {
                const candidates = scores.slice(0, Math.min(20, scores.length));
                const docs = candidates.map(s => rangeCorpusStore.lines[s.idx]);
                const rrResp = await fetch(`${baseUrl}/rerank`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                    body: JSON.stringify({ model: rerankModel.id || rerankModel.name, query, documents: docs }),
                    signal: AbortSignal.timeout(15000)
                });
                if (rrResp.ok) {
                    const rrResult = await rrResp.json();
                    const rrData = rrResult.results || rrResult.data || [];
                    results = rrData.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0))
                        .slice(0, topK)
                        .map(r => docs[r.index])
                        .filter(Boolean);
                }
            }

            if (!results || results.length === 0) {
                results = scores.slice(0, topK).map(s => rangeCorpusStore.lines[s.idx]).filter(Boolean);
            }

            corpusSearchCache.set(cacheKey, results);
            if (corpusSearchCache.size > 100) {
                const oldestKey = corpusSearchCache.keys().next().value;
                if (oldestKey) corpusSearchCache.delete(oldestKey);
            }
            return results;
        } catch (e) {
            return null;
        }
    }

    const corpusUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });


    app.post('/api/prompt-range/corpus-import', requireAuth, corpusUpload.single('file'), (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ success: false, error: '请上传JSON文件' });
            const { limit = 300, includeSelf = false } = req.body || {};

            const raw = req.file.buffer.toString('utf8');
            const data = JSON.parse(raw);
            const messages = data.messages || [];
            const selfUid = data.chatInfo?.selfUid || '';
            const selfUin = data.chatInfo?.selfUin || '';

            const isSelfMsg = (msg) => {
                const uid = msg.sender?.uid || '';
                const uin = msg.sender?.uin || '';
                return uid === selfUid || uin === selfUin || String(uin) === String(selfUin);
            };

            const limitNum = Number(limit) || 0;
            const textMsgsAll = messages
                .filter(m => !m.recalled && !m.system && m.type === 'type_1' && m.content?.text?.trim())
                .filter(m => includeSelf || !isSelfMsg(m))
                .filter(m => m.sender?.name && m.sender.name !== '0');
            const textMsgs = limitNum > 0 ? textMsgsAll.slice(-Math.min(limitNum, textMsgsAll.length)) : textMsgsAll;

            const corpus = textMsgs.map(m => `${m.sender?.name}: ${m.content.text.trim()}`).join('\n');

            // 存服务端 + 持久化到磁盘
            const storePath = path.join(__dirname, '..', 'data', 'range-corpus.json');
            rangeCorpusStore = {
                lines: textMsgs.map(m => `${m.sender?.name}: ${m.content.text.trim()}`),
                stats: {
                    fileName: req.file.originalname, groupName: data.chatInfo?.name || '',
                    totalMessages: messages.length, extracted: textMsgs.length,
                    speakerCount: [...new Set(textMsgs.map(m => m.sender?.name))].length
                },
                updatedAt: Date.now()
            };
            clearCorpusSearchCache();
            try {
                fsSync.writeFileSync(storePath, JSON.stringify({ lines: rangeCorpusStore.lines, stats: rangeCorpusStore.stats, updatedAt: rangeCorpusStore.updatedAt }, null, 2), 'utf8');
            } catch (e) { logger.warn('[靶场] 语料持久化失败', e.message); }

            // 返回前端预览文本(全部)
            const preview = rangeCorpusStore.lines.join('\n');
            res.json({ success: true, corpus: preview, stats: rangeCorpusStore.stats });
        } catch (error) {
            logger.error('[靶场] 语料导入失败', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // OneBot HTTP 上报端点（无需认证，由 OneBot access_token 保护）
    app.post('/onebot/event', (req, res) => {
        try {
            if (!bot || typeof bot.handleHttpEvent !== 'function') {
                return res.status(503).json({ error: 'OneBot 未就绪或未启用 HTTP 模式' });
            }
            bot.handleHttpEvent(req.body);
            res.json({ status: 'ok' });
        } catch (e) {
            logger.error('[OneBot] HTTP 事件处理失败:', e.message);
            res.status(500).json({ error: e.message });
        }
    });

    app.post('/api/status/onebot/reconnect', requireAuth, (req, res) => {
        if (bot) {
            bot.reconnect();
            logger.info(`[API ${req.requestId || 'no-id'}] 已触发 OneBot 重连`, {
                connectedBeforeReconnect: bot.isConnected()
            });
            res.json({ success: true, message: '正在重新连接...' });
        } else {
            res.status(500).json({ success: false, error: 'OneBot 客户端未初始化' });
        }
    });

    logger.info('API 路由已设置');
}

