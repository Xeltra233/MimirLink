/**
 * Prompt 构建模块
 * 组装轻量预设、摘要、世界书与角色信息。
 */

import { buildInputGuardrail } from './security.js';
import { createRuntimeSource, compactRuntimeSources } from './runtime/prompt-registry.js';

function createNoopLogger() {
    return {
        debug() {},
        info() {},
        warn() {},
        error() {}
    };
}

export class PromptBuilder {
    constructor(characterManager, worldBookManager, config = {}, logger = null) {
        this.characterManager = characterManager;
        this.worldBookManager = worldBookManager;
        this.logger = logger || createNoopLogger();
        this.updateConfig(config);
    }

    updateConfig(config = {}, bindingPreset = null) {
        const presetConfig = PromptBuilder.normalizePreset(bindingPreset || config.preset || {});
        const contextConfig = config.context || {};
        const securityConfig = config.security || {};
        this.presetConfig = presetConfig;
        this.contextConfig = {
            enabled: contextConfig.enabled !== false,
            includeSessionFacts: contextConfig.includeSessionFacts !== false,
            includeParticipants: contextConfig.includeParticipants !== false,
            includeReplyReference: contextConfig.includeReplyReference !== false,
            includeRecentUserIntent: contextConfig.includeRecentUserIntent !== false
        };
        this.securityConfig = {
            inputGuardrailEnabled: securityConfig.inputGuardrailEnabled === true
        };
    }

    static normalizePromptBoolean(value, fallback = false) {
        if (value === undefined || value === null || value === '') {
            return fallback;
        }

        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['false', '0', 'off', 'no'].includes(normalized)) {
                return false;
            }
            if (['true', '1', 'on', 'yes'].includes(normalized)) {
                return true;
            }
        }

        return Boolean(value);
    }

    static normalizePromptInteger(value, fallback = 0) {
        const normalized = Number(value);
        return Number.isInteger(normalized) ? normalized : fallback;
    }

    static createPromptItem({
        identifier,
        name,
        role = 'system',
        content = '',
        enabled = true,
        injection_position = 0,
        injection_depth = 0,
        forbid_overrides = false,
        marker = false,
        system_prompt = false,
        sourceLabel = '',
        sourceKey = '',
        sourceType = '',
        sourceOrigin = '',
        sourceReadonly = false,
        sourceMeta = null
    } = {}) {
        return {
            identifier: String(identifier || '').trim(),
            name: String(name || '').trim(),
            role: String(role || 'system').trim() || 'system',
            content: typeof content === 'string' ? content : '',
            enabled: PromptBuilder.normalizePromptBoolean(enabled, true),
            injection_position: PromptBuilder.normalizePromptInteger(injection_position, 0),
            injection_depth: PromptBuilder.normalizePromptInteger(injection_depth, 0),
            forbid_overrides: PromptBuilder.normalizePromptBoolean(forbid_overrides, false),
            marker: PromptBuilder.normalizePromptBoolean(marker, false),
            system_prompt: PromptBuilder.normalizePromptBoolean(system_prompt, false),
            sourceLabel: String(sourceLabel || '').trim(),
            sourceKey: String(sourceKey || '').trim(),
            sourceType: String(sourceType || '').trim(),
            sourceOrigin: String(sourceOrigin || '').trim(),
            sourceReadonly: PromptBuilder.normalizePromptBoolean(sourceReadonly, false),
            sourceMeta: sourceMeta && typeof sourceMeta === 'object' ? { ...sourceMeta } : null
        };
    }

    static ensureBindingConfig(config = {}) {
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

    static getCharacterBinding(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        return config.bindings.characters?.[characterName] || {
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

    static hasPresetContent(source = {}) {
        if (!source || typeof source !== 'object') {
            return false;
        }

        if (Array.isArray(source.prompts)) {
            return source.prompts.some((item) => typeof item?.content === 'string' && item.content.trim());
        }

        return [source.systemPrompt, source.postHistoryInstructions, source.jailbreak, source.assistantPrefill]
            .some((value) => typeof value === 'string' && value.trim());
    }

    static createPresetItemKey(item = {}, index = 0) {
        const identifier = String(item.identifier || '').trim();
        if (identifier) {
            return `identifier:${identifier}`;
        }

        return `fallback:${index}:${item.role || 'system'}:${item.name || ''}`;
    }

    static mergePresetLayers(layers = []) {
        const activeLayers = layers
            .filter((layer) => PromptBuilder.hasPresetContent(layer?.preset))
            .map((layer) => ({
                source: layer.source,
                preset: PromptBuilder.normalizePreset(layer.preset)
            }));

        if (activeLayers.length === 0) {
            return {
                preset: null,
                source: 'none',
                layers: [],
                itemSources: {},
                lockedIdentifiers: []
            };
        }

        const mergedItems = [];
        const itemSourceMap = new Map();
        const lockedIdentifiers = new Set();

        for (const layer of activeLayers) {
            for (let index = 0; index < layer.preset.prompts.length; index += 1) {
                const normalizedItem = PromptBuilder.createPromptItem(layer.preset.prompts[index]);
                if (!normalizedItem.content.trim()) {
                    continue;
                }

                const key = PromptBuilder.createPresetItemKey(normalizedItem, index);
                const existingIndex = mergedItems.findIndex((item, itemIndex) => PromptBuilder.createPresetItemKey(item, itemIndex) === key);
                const nextItem = {
                    ...normalizedItem,
                    preset_source: layer.source
                };

                if (existingIndex === -1) {
                    mergedItems.push(nextItem);
                    itemSourceMap.set(key, layer.source);
                    if (normalizedItem.forbid_overrides === true && normalizedItem.identifier) {
                        lockedIdentifiers.add(normalizedItem.identifier);
                    }
                    continue;
                }

                const existingItem = mergedItems[existingIndex];
                if (existingItem.forbid_overrides === true) {
                    if (existingItem.identifier) {
                        lockedIdentifiers.add(existingItem.identifier);
                    }
                    continue;
                }

                mergedItems[existingIndex] = nextItem;
                itemSourceMap.set(key, layer.source);
                if (normalizedItem.forbid_overrides === true && normalizedItem.identifier) {
                    lockedIdentifiers.add(normalizedItem.identifier);
                }
            }
        }

        const contributingSources = [...new Set(mergedItems.map((item) => item.preset_source).filter(Boolean))];
        const highestSource = contributingSources.at(-1) || activeLayers.at(-1)?.source || 'none';

        return {
            preset: {
                enabled: true,
                name: activeLayers.at(-1)?.preset?.name || activeLayers[0]?.preset?.name || '',
                prompts: mergedItems,
                regexRules: activeLayers.at(-1)?.preset?.regexRules || []
            },
            source: contributingSources.length === 1 ? highestSource : 'merged',
            layers: activeLayers.map((layer) => layer.source),
            itemSources: Object.fromEntries(itemSourceMap.entries()),
            lockedIdentifiers: [...lockedIdentifiers]
        };
    }

    static hasBindingValue(value) {
        if (Array.isArray(value)) {
            return value.length > 0;
        }

        if (value && typeof value === 'object') {
            return Object.keys(value).length > 0;
        }

        return value !== null && value !== undefined && value !== '';
    }

    static getPresetResolution(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        return PromptBuilder.mergePresetLayers([
            { source: 'legacy', preset: config.preset },
            { source: 'global', preset: config.bindings.global.preset },
            { source: 'imported_from_card', preset: binding.importedFromCard?.preset },
            { source: 'character_binding', preset: binding.preset }
        ]);
    }

    static getRegexResolution(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
        const resolveSource = (explicitValue, importedValue, globalValue, legacyValue) => {
            if (PromptBuilder.hasBindingValue(explicitValue)) return 'character_binding';
            if (PromptBuilder.hasBindingValue(importedValue)) return 'imported_from_card';
            if (PromptBuilder.hasBindingValue(globalValue)) return 'global';
            if (PromptBuilder.hasBindingValue(legacyValue)) return 'legacy';
            return 'none';
        };

        const globalSource = resolveSource(null, null, config.bindings.global.regexRules, config.regex?.rules);
        const globalRules = config.bindings.global.regexRules || config.regex?.rules || [];
        const characterSource = resolveSource(binding.regexRules, binding.importedFromCard?.regexRules, null, null);
        const characterRules = binding.regexRules || binding.importedFromCard?.regexRules || [];
        const presetRules = presetResolution.preset?.regexRules || [];

        return {
            regexRules: {
                source: characterSource,
                count: characterRules.length,
                value: characterRules
            },
            presetRegexRules: {
                source: presetResolution.source,
                layers: presetResolution.layers,
                count: presetRules.length,
                value: presetRules
            },
            globalRegexRules: {
                source: globalSource,
                count: globalRules.length,
                value: globalRules
            }
        };
    }

    static getEffectiveBinding(config = {}, characterName) {
        PromptBuilder.ensureBindingConfig(config);
        const binding = PromptBuilder.getCharacterBinding(config, characterName);
        const presetResolution = PromptBuilder.getPresetResolution(config, characterName);
        const regexResolution = PromptBuilder.getRegexResolution(config, characterName);
        return {
            memoryDbPath: binding.memoryDbPath || config.bindings.global.memoryDbPath || config.memory?.storage?.path || null,
            worldbook: binding.worldbook || binding.importedFromCard?.worldbook || config.bindings.global.worldbook || null,
            preset: presetResolution.preset || null,
            globalRegexRules: regexResolution.globalRegexRules.value,
            presetRegexRules: regexResolution.presetRegexRules.value,
            regexRules: regexResolution.regexRules.value
        };
    }

    static createLegacyPromptItems(source = {}) {
        const items = [];

        if (typeof source.systemPrompt === 'string' && source.systemPrompt.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'main',
                name: 'Main Prompt',
                role: 'system',
                content: source.systemPrompt,
                injection_position: 0,
                system_prompt: true
            }));
        }

        if (typeof source.postHistoryInstructions === 'string' && source.postHistoryInstructions.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'post-history',
                name: 'Post-History Instructions',
                role: 'system',
                content: source.postHistoryInstructions,
                injection_position: 1,
                system_prompt: true
            }));
        }

        if (typeof source.jailbreak === 'string' && source.jailbreak.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'jailbreak',
                name: 'Jailbreak',
                role: 'system',
                content: source.jailbreak,
                injection_position: 0,
                system_prompt: true
            }));
        }

        if (typeof source.assistantPrefill === 'string' && source.assistantPrefill.trim()) {
            items.push(PromptBuilder.createPromptItem({
                identifier: 'assistant-prefill',
                name: 'Assistant Prefill',
                role: 'assistant',
                content: source.assistantPrefill,
                injection_position: 1,
                system_prompt: false
            }));
        }

        return items;
    }

    static createDefaultPromptItems() {
        return [
            PromptBuilder.createPromptItem({
                identifier: 'main',
                name: 'Main Prompt',
                role: 'system',
                content: '',
                injection_position: 0,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'jailbreak',
                name: 'Jailbreak',
                role: 'system',
                content: '',
                injection_position: 0,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'post-history',
                name: 'Post-History Instructions',
                role: 'system',
                content: '',
                injection_position: 1,
                system_prompt: true
            }),
            PromptBuilder.createPromptItem({
                identifier: 'assistant-prefill',
                name: 'Assistant Prefill',
                role: 'assistant',
                content: '',
                injection_position: 1,
                system_prompt: false
            })
        ];
    }

    static normalizePreset(source = {}) {
        const prompts = Array.isArray(source.prompts) && source.prompts.length > 0
            ? source.prompts
                .map((item) => PromptBuilder.createPromptItem(item))
            : PromptBuilder.createLegacyPromptItems(source);
        const hasPromptContent = prompts.some((item) => item.content.trim());

        return {
            enabled: source.enabled === true,
            name: typeof source.name === 'string' ? source.name : '',
            prompts: hasPromptContent ? prompts : PromptBuilder.createDefaultPromptItems(),
            regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
        };
    }

    static partitionPromptItems(presetConfig = {}) {
        const items = presetConfig.enabled === true && Array.isArray(presetConfig.prompts)
            ? presetConfig.prompts.filter((item) => item.enabled !== false && item.content.trim())
            : [];
        const systemItems = items.filter((item) => item.role === 'system');

        return {
            preSystem: systemItems.filter((item) => item.injection_position !== 1 && Number(item.injection_depth || 0) <= 0),
            historyInjection: systemItems.filter((item) => item.injection_position !== 1 && Number(item.injection_depth || 0) > 0),
            postHistory: systemItems.filter((item) => item.injection_position === 1),
            assistantPrefill: items.filter((item) => item.role === 'assistant')
        };
    }

    static resolvePresetSegmentKind(item, fallbackKind) {
        return item?.marker === true ? 'preset_marker' : fallbackKind;
    }

    static resolveWorldBookPosition(value) {
        const normalized = Number(value);
        if (Number.isFinite(normalized)) {
            return normalized === 1 ? 1 : 0;
        }

        if (typeof value === 'string') {
            const compact = value.trim().toLowerCase();
            if ([
                '1',
                'after',
                'after_char',
                'after_character',
                'after_description',
                'post',
                'post_history',
                'post-history'
            ].includes(compact)) {
                return 1;
            }
        }

        return 0;
    }

    static resolveWorldBookPlacement(entry = {}) {
        const position = PromptBuilder.resolveWorldBookPosition(entry.position);
        return position === 1 ? 'post_history' : 'system';
    }

    static createRuntimeSegment({
        id,
        kind,
        label,
        content = '',
        stage = 'runtime',
        order = 0,
        meta = {}
    } = {}) {
        return {
            id: String(id || '').trim(),
            kind: String(kind || 'unknown').trim(),
            label: String(label || '').trim(),
            content: typeof content === 'string' ? content : '',
            stage: String(stage || 'runtime').trim(),
            order: Number.isFinite(order) ? order : 0,
            meta: meta && typeof meta === 'object' ? meta : {}
        };
    }

    static compactRuntimeSegments(segments = []) {
        return segments
            .filter((segment) => segment && String(segment.content || '').trim())
            .sort((left, right) => {
                const orderDelta = (left.order || 0) - (right.order || 0);
                if (orderDelta !== 0) {
                    return orderDelta;
                }

                return String(left.id || '').localeCompare(String(right.id || ''));
            });
    }

    static createMessageTrace(messages = [], runtimeSources = []) {
        const sourceMatchesMessage = (source, message) => {
            if (!source || !message) {
                return false;
            }

            const role = message.role || 'unknown';
            const placement = source.meta?.placement || 'system';

            if (role === 'system') {
                if (message.meta?.source === 'post_history') {
                    return placement === 'post_history';
                }

                if (message.meta?.source === 'history_injection') {
                    return placement === 'history_injection' && source.id === message.meta?.sourceId;
                }

                return placement === 'system';
            }

            if (role === 'assistant') {
                if (message.meta?.source === 'first_message') {
                    return source.kind === 'character_first_message';
                }

                return placement === 'assistant_prefill';
            }

            if (role === 'user') {
                if (message.meta?.source === 'history') {
                    return source.kind === 'history_message' && source.id === message.meta?.sourceId;
                }

                return source.kind === 'user_input';
            }

            if (role === 'history') {
                return source.kind === 'history_message';
            }

            return false;
        };

        return messages.map((message, index) => {
            const matchedSources = runtimeSources.filter((source) => sourceMatchesMessage(source, message));
            return {
                index,
                role: message.role,
                sourceStages: [...new Set(matchedSources.map((source) => source.stage).filter(Boolean))],
                sourceIds: [...new Set(matchedSources.map((source) => source.id).filter(Boolean))],
                sourceSlots: [...new Set(matchedSources.map((source) => source.sourceSlot).filter(Boolean))]
            };
        });
    }

    buildRuntimeComposition({
        normalizedContext,
        runtimeContext,
        activePreset,
        character,
        worldBookEntries,
        userMessage
    }) {
        const { preSystem, historyInjection, postHistory, assistantPrefill } = PromptBuilder.partitionPromptItems(activePreset);
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const systemSegments = [
            PromptBuilder.createRuntimeSegment({
                id: 'current-time',
                kind: 'current_time',
                label: '当前时间',
                content: `【当前时间】${timeStr}`,
                stage: 'runtime',
                order: 0,
                meta: { placement: 'system' }
            })
        ];

        if (this.contextConfig.enabled) {
            const situationalContext = this.buildSituationalContext(normalizedContext, runtimeContext);
            if (situationalContext) {
                systemSegments.push(PromptBuilder.createRuntimeSegment({
                    id: 'situational-context',
                    kind: 'situational_context',
                    label: '会话上下文',
                    content: situationalContext,
                    stage: 'runtime',
                    order: 10,
                    meta: { placement: 'system' }
                }));
            }
        }

        if (this.securityConfig.inputGuardrailEnabled) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'input-guardrail',
                kind: 'input_guardrail',
                label: '输入护栏',
                content: buildInputGuardrail(runtimeContext.injectionRisk),
                stage: 'runtime',
                order: 15,
                meta: { placement: 'system' }
            }));
        }

        systemSegments.push(...preSystem.map((item, index) => PromptBuilder.createRuntimeSegment({
            id: item.identifier,
            kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_pre_system'),
            label: item.name || item.identifier,
            content: item.content,
            stage: 'preset',
            order: 20 + index,
            meta: {
                placement: 'system',
                role: item.role,
                injection_position: item.injection_position,
                injection_depth: item.injection_depth,
                system_prompt: item.system_prompt === true,
                marker: item.marker === true,
                forbid_overrides: item.forbid_overrides === true
            }
        })));

        systemSegments.push(...normalizedContext.summaries.map((summary, index) => PromptBuilder.createRuntimeSegment({
            id: `summary-${index}`,
            kind: 'summary',
            label: `摘要 ${index + 1}`,
            content: `【历史摘要】\n${summary.content}`,
            stage: 'memory',
            order: 40 + index,
            meta: { placement: 'system' }
        })));

        if (Array.isArray(runtimeContext.recalledEntries) && runtimeContext.recalledEntries.length > 0) {
            const fixedKnowledgeEntries = runtimeContext.recalledEntries.filter((entry) => entry?.sourceKind === 'knowledge_fixed');
            const dynamicKnowledgeEntries = runtimeContext.recalledEntries.filter((entry) => entry?.sourceKind === 'knowledge_dynamic');
            const otherRecallEntries = runtimeContext.recalledEntries.filter((entry) => !['knowledge_fixed', 'knowledge_dynamic'].includes(entry?.sourceKind));
            const renderRecallEntries = (entries, title) => {
                if (!entries.length) {
                    return null;
                }
                return [
                    title,
                    ...entries.map((entry) => {
                        const itemTitle = entry.title ? `${entry.title}: ` : '';
                        const reason = entry.recallReason ? ` [${entry.recallReason}]` : '';
                        return `${itemTitle}${entry.content}${reason}`;
                    })
                ].join('\n');
            };
            const recallSections = [
                renderRecallEntries(fixedKnowledgeEntries, '【固定知识】'),
                renderRecallEntries(dynamicKnowledgeEntries, '【动态知识】'),
                renderRecallEntries(otherRecallEntries, '【其他召回】')
            ].filter(Boolean);

            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'database-recall',
                kind: 'database_recall',
                label: '数据库召回',
                content: [
                    '【数据库召回】',
                    ...recallSections
                ].join('\n\n'),
                stage: 'memory',
                order: 50,
                meta: { placement: 'system' }
            }));
        }


        if (character.description) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-description',
                kind: 'character_description',
                label: '角色描述',
                content: `【角色描述】\n${character.description}`,
                stage: 'character',
                order: 80,
                meta: { placement: 'system' }
            }));
        }

        if (character.personality) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-personality',
                kind: 'character_personality',
                label: '角色性格',
                content: `【${character.name}的性格】\n${character.personality}`,
                stage: 'character',
                order: 81,
                meta: { placement: 'system' }
            }));
        }

        if (character.scenario) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'scenario',
                kind: 'scenario',
                label: '场景',
                content: `【场景】\n${character.scenario}`,
                stage: 'character',
                order: 82,
                meta: { placement: 'system' }
            }));
        }

        if (character.system_prompt) {
            systemSegments.push(PromptBuilder.createRuntimeSegment({
                id: 'character-system-prompt',
                kind: 'character_system_prompt',
                label: '角色系统提示',
                content: character.system_prompt,
                stage: 'character',
                order: 83,
                meta: { placement: 'system' }
            }));
        }

        const historyInjectionSegments = PromptBuilder.compactRuntimeSegments(
            historyInjection.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_injection'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 95 + index,
                meta: {
                    placement: 'history_injection',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true,
                    insertionIndex: Math.max(0, Math.min(normalizedContext.recentMessages.length, Number(item.injection_depth || 0)))
                }
            }))
        );

        const historyMessages = normalizedContext.recentMessages.map((message, index) => ({
            role: message.role,
            content: message.content,
            meta: {
                source: 'history',
                sourceId: `history-${index}`
            }
        }));

        const worldBookSystemSegments = [];
        const worldBookPostHistorySegments = [];
        for (let index = 0; index < worldBookEntries.length; index += 1) {
            const entry = worldBookEntries[index];
            const placement = PromptBuilder.resolveWorldBookPlacement(entry);
            const segment = PromptBuilder.createRuntimeSegment({
                id: `worldbook-${index}`,
                kind: 'worldbook_entry',
                label: entry.key || `世界书条目 ${index + 1}`,
                content: `【世界设定】\n${entry.content}`,
                stage: 'worldbook',
                order: 60 + index,
                meta: {
                    placement,
                    position: PromptBuilder.resolveWorldBookPosition(entry.position),
                    sticky: entry.sticky || 0,
                    triggeredByKeyword: entry.triggeredByKeyword,
                    triggeredBySticky: entry.triggeredBySticky
                }
            });

            if (placement === 'post_history') {
                worldBookPostHistorySegments.push(segment);
                continue;
            }

            worldBookSystemSegments.push(segment);
        }

        systemSegments.push(...worldBookSystemSegments);

        const postHistorySegments = PromptBuilder.compactRuntimeSegments([
            ...worldBookPostHistorySegments,
            ...postHistory.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_post_history'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 100 + index,
                meta: {
                    placement: 'post_history',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true
                }
            }))
        ]);

        const assistantPrefillSegments = PromptBuilder.compactRuntimeSegments(
            assistantPrefill.map((item, index) => PromptBuilder.createRuntimeSegment({
                id: item.identifier,
                kind: PromptBuilder.resolvePresetSegmentKind(item, 'preset_assistant'),
                label: item.name || item.identifier,
                content: item.content,
                stage: 'preset',
                order: 120 + index,
                meta: {
                    placement: 'assistant_prefill',
                    role: item.role,
                    injection_position: item.injection_position,
                    injection_depth: item.injection_depth,
                    system_prompt: item.system_prompt === true,
                    marker: item.marker === true,
                    forbid_overrides: item.forbid_overrides === true
                }
            }))
        );

        const runtimeSources = compactRuntimeSources([
            ...PromptBuilder.compactRuntimeSegments(systemSegments).map((segment) => createRuntimeSource(segment)),
            ...historyMessages.map((message) => createRuntimeSource({
                id: message.meta.sourceId,
                kind: 'history_message',
                label: '历史消息',
                content: message.content,
                stage: 'history',
                order: 90,
                meta: {
                    placement: 'history',
                    role: message.role
                }
            })),
            ...historyInjectionSegments.map((segment) => createRuntimeSource(segment)),
            ...postHistorySegments.map((segment) => createRuntimeSource(segment)),
            createRuntimeSource({
                id: 'user-input',
                kind: 'user_input',
                label: '当前用户输入',
                content: userMessage,
                stage: 'input',
                order: 130,
                meta: { placement: 'user_input' }
            }),
            ...assistantPrefillSegments.map((segment) => createRuntimeSource(segment)),
            ...(normalizedContext.recentMessages.length === 0 && character.first_mes
                ? [createRuntimeSource({
                    id: 'character-first-message',
                    kind: 'character_first_message',
                    label: '角色开场白',
                    content: character.first_mes,
                    stage: 'character',
                    order: 89,
                    meta: { placement: 'assistant_opening' }
                })]
                : [])
        ]);

        return {
            systemSegments: PromptBuilder.compactRuntimeSegments(systemSegments),
            historyMessages,
            historyInjectionSegments,
            postHistorySegments,
            assistantPrefillSegments,
            runtimeSources
        };
    }

    async build(characterName, userMessage, context = {}, stickyKeys = new Set(), runtimeContext = {}, runtimeOverrides = {}) {
        const startedAt = Date.now();
        const normalizedContext = Array.isArray(context)
            ? { recentMessages: context, summaries: [] }
            : {
                recentMessages: context.recentMessages || [],
                summaries: context.summaries || []
            };

        this.logger.debug?.('[Prompt] 开始构建', {
            characterName,
            recentMessageCount: normalizedContext.recentMessages.length,
            summaryCount: normalizedContext.summaries.length,
            stickyKeyCount: stickyKeys instanceof Set ? stickyKeys.size : 0,
            userMessage: {
                length: String(userMessage || '').trim().length,
                preview: String(userMessage || '').trim().slice(0, 120)
            },
            runtimeContext: {
                sessionId: runtimeContext?.sessionId || '',
                messageType: runtimeContext?.messageType || '',
                messageCount: runtimeContext?.messageCount || 0,
                participantCount: Array.isArray(runtimeContext?.participants) ? runtimeContext.participants.length : 0,
                hasReplyReference: !!runtimeContext?.replyReference,
                hasCurrentSpeakerProfile: !!runtimeContext?.currentSpeakerProfile?.content,
                injectionRiskLevel: runtimeContext?.injectionRisk?.level || ''
            }
        });

        const character = runtimeOverrides.character || this.characterManager.readFromPng(characterName);

        let worldBook = runtimeOverrides.worldBook || this.worldBookManager.currentWorldBook;
        if (!worldBook) {
            worldBook = this.worldBookManager.readWorldBook(characterName);
        }

        const historyText = normalizedContext.recentMessages.map((message) => message.content).join(' ');
        const summaryText = normalizedContext.summaries.map((summary) => summary.content).join(' ');
        const allText = `${historyText} ${summaryText} ${userMessage}`.trim();
        const worldBookEntries = this.worldBookManager.matchEntries(worldBook, allText, 10, stickyKeys);
        const activePreset = runtimeOverrides.presetConfig
            ? PromptBuilder.normalizePreset(runtimeOverrides.presetConfig)
            : this.presetConfig;
        const composition = this.buildRuntimeComposition({
            normalizedContext,
            runtimeContext,
            activePreset,
            character,
            worldBookEntries,
            userMessage
        });

        const messages = [
            {
                role: 'system',
                content: composition.systemSegments.map((segment) => segment.content.trim()).filter(Boolean).join('\n\n'),
                meta: { source: 'runtime_composition' }
            }
        ];

        if (normalizedContext.recentMessages.length === 0 && character.first_mes) {
            messages.push({
                role: 'assistant',
                content: character.first_mes,
                meta: { source: 'first_message' }
            });
        }

        const historyInjectionBuckets = new Map();
        for (const segment of composition.historyInjectionSegments || []) {
            const insertionIndex = Number(segment.meta?.insertionIndex || 0);
            if (!historyInjectionBuckets.has(insertionIndex)) {
                historyInjectionBuckets.set(insertionIndex, []);
            }
            historyInjectionBuckets.get(insertionIndex).push(segment);
        }

        const appendHistoryInjectionSegments = (index) => {
            const bucket = historyInjectionBuckets.get(index) || [];
            for (const segment of bucket) {
                messages.push({
                    role: 'system',
                    content: segment.content,
                    meta: {
                        source: 'history_injection',
                        sourceId: segment.id,
                        insertionIndex: index
                    }
                });
            }
        };

        appendHistoryInjectionSegments(0);

        for (let index = 0; index < composition.historyMessages.length; index += 1) {
            const message = composition.historyMessages[index];
            messages.push({ role: message.role, content: message.content, meta: message.meta });
            appendHistoryInjectionSegments(index + 1);
        }

        for (const segment of composition.postHistorySegments) {
            messages.push({
                role: 'system',
                content: segment.content,
                meta: { source: 'post_history', sourceId: segment.id }
            });
        }

        messages.push({
            role: 'user',
            content: userMessage,
            meta: { source: 'user_input' }
        });

        const assistantPrefillText = composition.assistantPrefillSegments
            .map((segment) => segment.content.trim())
            .filter(Boolean)
            .join('\n\n');

        if (assistantPrefillText) {
            messages.push({
                role: 'assistant',
                content: assistantPrefillText,
                meta: {
                    source: 'assistant_prefill',
                    sourceIds: composition.assistantPrefillSegments.map((segment) => segment.id).filter(Boolean)
                }
            });
        }

        const messageTrace = PromptBuilder.createMessageTrace(messages, composition.runtimeSources);
        const result = {
            messages,
            character,
            runtimeComposition: composition,
            runtimeSources: composition.runtimeSources,
            messageTrace,
            worldBookCount: worldBookEntries.length,
            worldBookKeys: worldBookEntries.map((entry) => entry.key),
            worldBookEntries: worldBookEntries.map((entry) => ({
                key: entry.key,
                sticky: entry.sticky || 0,
                triggeredByKeyword: entry.triggeredByKeyword,
                triggeredBySticky: entry.triggeredBySticky,
                comment: entry.comment,
                content: entry.content
            }))
        };

        this.logger.info?.('[Prompt] 构建完成', {
            characterName,
            character: character?.name || characterName,
            durationMs: Date.now() - startedAt,
            recentMessageCount: normalizedContext.recentMessages.length,
            summaryCount: normalizedContext.summaries.length,
            worldBookCount: worldBookEntries.length,
            worldBookKeys: worldBookEntries.map((entry) => entry.key).slice(0, 10),
            historyInjectionCount: composition.historyInjectionSegments.length,
            postHistoryCount: composition.postHistorySegments.length,
            assistantPrefillCount: composition.assistantPrefillSegments.length,
            runtimeSourceCount: composition.runtimeSources.length,
            messageCount: messages.length,
            messageTraceCount: messageTrace.length
        });

        return result;
    }

    buildSituationalContext(context, runtimeContext) {
        const sections = [];

        if (this.contextConfig.includeSessionFacts) {
            const facts = [];
            if (runtimeContext.sessionId) {
                facts.push(`会话ID: ${runtimeContext.sessionId}`);
            }
            if (runtimeContext.messageType) {
                facts.push(`会话类型: ${runtimeContext.messageType}`);
            }
            if (runtimeContext.messageCount) {
                facts.push(`本次聚合消息数: ${runtimeContext.messageCount}`);
            }
            if (runtimeContext.triggerReason) {
                facts.push(`触发原因: ${runtimeContext.triggerReason}`);
            }
            if (facts.length > 0) {
                sections.push(`【会话感知】\n${facts.join(' | ')}`);
            }
        }

        if (this.contextConfig.includeParticipants && Array.isArray(runtimeContext.participants) && runtimeContext.participants.length > 0) {
            sections.push(`【参与者】\n${runtimeContext.participants.join(' | ')}`);
        }

        if (runtimeContext.currentSpeakerProfile?.content) {
            const profileText = runtimeContext.currentSpeakerProfile.content.trim();
            if (profileText) {
                sections.push(`【当前发言人画像】\n${profileText}`);
            }
        }

        if (this.contextConfig.includeReplyReference && runtimeContext.replyReference) {
            sections.push(`【引用上下文】\n${runtimeContext.replyReference}`);
        }

        if (this.contextConfig.includeRecentUserIntent) {
            const recentUserMessages = context.recentMessages
                .filter((message) => message.role === 'user')
                .slice(-3)
                .map((message) => message.content);
            if (recentUserMessages.length > 0) {
                sections.push(`【最近用户意图】\n${recentUserMessages.join('\n')}`);
            }
        }

        return sections.filter(Boolean).join('\n\n');
    }

    static importPreset(payload = {}) {
        const source = payload.preset || payload;

        if (Array.isArray(source.prompts) && source.prompts.length > 0) {
            return PromptBuilder.normalizePreset({
                enabled: source.enabled !== false,
                name: source.name || source.preset_name || source.title || '',
                prompts: source.prompts,
                regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
            });
        }

        const normalizeText = (value) => typeof value === 'string' ? value.trim() : '';

        const promptItems = Array.isArray(source.prompts) ? source.prompts : [];
        const enabledPrompts = promptItems.filter((item) => item && item.enabled !== false && typeof item.content === 'string' && item.content.trim());

        const systemPromptParts = [];
        const postHistoryParts = [];
        let assistantPrefill = normalizeText(source.assistantPrefill || source.assistant_prefill || source.prefill || '');

        for (const item of enabledPrompts) {
            const content = normalizeText(item.content);
            if (!content) {
                continue;
            }

            const identifier = String(item.identifier || '').toLowerCase();
            const name = String(item.name || '').toLowerCase();
            const role = String(item.role || '').toLowerCase();
            const marker = item.marker === true;
            const systemPromptFlag = item.system_prompt === true;

            if (identifier.includes('post') || name.includes('post history')) {
                postHistoryParts.push(content);
                continue;
            }

            if (identifier.includes('assistantprefill') || name.includes('assistant prefill') || identifier.includes('jailbreak')) {
                if (!assistantPrefill) {
                    assistantPrefill = content;
                }
                continue;
            }

            if (role === 'assistant' && !systemPromptFlag) {
                if (!assistantPrefill) {
                    assistantPrefill = content;
                }
                continue;
            }

            if (role === 'system' || systemPromptFlag || marker) {
                systemPromptParts.push(content);
            }
        }

        const importedSystemPrompt = [
            normalizeText(source.systemPrompt || source.system_prompt || source.main_prompt || ''),
            ...systemPromptParts
        ].filter(Boolean).join('\n\n');

        const importedPostHistory = [
            normalizeText(source.postHistoryInstructions || source.post_history_instructions || source.post_history || ''),
            ...postHistoryParts
        ].filter(Boolean).join('\n\n');

        const importedJailbreak = normalizeText(source.jailbreak || source.jailbreak_system || source.nsfw_prompt || '');

        const importedPrompts = [];
        if (importedSystemPrompt) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-system-prompt',
                name: '导入 · 主 System 提示',
                role: 'system',
                content: importedSystemPrompt,
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                marker: true,
                system_prompt: true,
                sourceLabel: '角色描述 / 系统提示 / 主提示合并结果',
                sourceKey: 'system_prompt',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['systemPrompt', 'system_prompt', 'main_prompt', 'prompts[].content(system)'].join(' / '),
                    mappedFields: ['system_prompt / main_prompt']
                }
            }));
        }
        if (importedPostHistory) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-post-history',
                name: '导入 · 后置提示',
                role: 'system',
                content: importedPostHistory,
                enabled: true,
                injection_position: 1,
                injection_depth: 0,
                sourceLabel: '后置提示 / Post History 合并结果',
                sourceKey: 'post_history_instructions',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['postHistoryInstructions', 'post_history_instructions', 'post_history', 'prompts[].content(post-history)'].join(' / '),
                    mappedFields: ['post_history_instructions / post_history']
                }
            }));
        }
        if (assistantPrefill) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-assistant-prefill',
                name: '导入 · Assistant Prefill',
                role: 'assistant',
                content: assistantPrefill,
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                sourceLabel: '助手预填充 / 开场续写',
                sourceKey: 'assistant_prefill',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['assistantPrefill', 'assistant_prefill', 'prefill', 'prompts[].content(assistant)'].join(' / '),
                    mappedFields: ['assistant prefill']
                }
            }));
        }
        if (importedJailbreak) {
            importedPrompts.push(PromptBuilder.createPromptItem({
                identifier: 'imported-jailbreak',
                name: '导入 · Jailbreak / NSFW Prompt',
                role: 'system',
                content: importedJailbreak,
                enabled: true,
                injection_position: 1,
                injection_depth: 0,
                sourceLabel: 'Jailbreak / NSFW 提示',
                sourceKey: 'jailbreak',
                sourceType: 'imported_runtime_prompt',
                sourceOrigin: 'preset-import',
                sourceReadonly: true,
                sourceMeta: {
                    from: ['jailbreak', 'jailbreak_system', 'nsfw_prompt'].join(' / '),
                    mappedFields: ['jailbreak / nsfw_prompt']
                }
            }));
        }

        return PromptBuilder.normalizePreset({
            enabled: source.enabled !== false,
            name: source.name || source.preset_name || source.title || '',
            prompts: importedPrompts,
            regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
        });
    }

    static diagnosePresetImport(payload = {}) {
        const source = payload.preset || payload;
        const promptItems = Array.isArray(source.prompts) ? source.prompts : [];
        const enabledPrompts = promptItems.filter((item) => item && item.enabled !== false);
        const markerPrompts = enabledPrompts.filter((item) => item.marker === true);
        const assistantRolePrompts = enabledPrompts.filter((item) => String(item.role || '').toLowerCase() === 'assistant');
        const postHistoryPrompts = enabledPrompts.filter((item) => Number(item.injection_position || 0) === 1);
        const historyInjectionPrompts = enabledPrompts.filter((item) => Number(item.injection_position || 0) !== 1 && Number(item.injection_depth || 0) > 0);
        const unsupportedRoles = enabledPrompts.filter((item) => {
            const role = String(item.role || 'system').toLowerCase();
            return role !== 'system' && role !== 'assistant';
        });
        const unsupportedPlacements = enabledPrompts.filter((item) => {
            const placement = Number(item.injection_position || 0);
            return placement !== 0 && placement !== 1;
        });

        const warnings = [];
        if (unsupportedPlacements.length > 0) {
            warnings.push(`检测到 ${unsupportedPlacements.length} 条不受支持的 injection_position，当前仅精确支持主 system、history injection、post-history 与 assistant prefill 这几类落位。`);
        }
        if (unsupportedRoles.length > 0) {
            warnings.push(`检测到 ${unsupportedRoles.length} 条非 system/assistant role prompt，当前不会完整复刻这些角色的 ST 运行时语义。`);
        }

        return {
            detectedFormat: promptItems.length > 0 ? 'sillytavern-prompts' : 'basic-preset',
            totalPrompts: promptItems.length,
            enabledPrompts: enabledPrompts.length,
            postHistoryPrompts: postHistoryPrompts.length,
            historyInjectionPrompts: historyInjectionPrompts.length,
            markerPrompts: markerPrompts.length,
            assistantRolePrompts: assistantRolePrompts.length,
            unsupportedPlacements: unsupportedPlacements.length,
            unsupportedRoles: unsupportedRoles.length,
            warnings
        };
    }


    static exportPreset(presetConfig = {}, format = 'native') {
        const normalized = PromptBuilder.normalizePreset(presetConfig);

        if (format === 'sillytavern') {
            return {
                name: normalized.name || 'Imported Preset',
                prompts: normalized.prompts
            };
        }

        return {
            preset: normalized
        };
    }
}
