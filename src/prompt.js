/**
 * Prompt 构建模块
 * 组装轻量预设、摘要、世界书与角色信息。
 */

import { buildInputGuardrail } from './security.js';

export class PromptBuilder {
    constructor(characterManager, worldBookManager, config = {}) {
        this.characterManager = characterManager;
        this.worldBookManager = worldBookManager;
        this.updateConfig(config);
    }

    updateConfig(config = {}, bindingPreset = null) {
        const presetConfig = PromptBuilder.normalizePreset(bindingPreset || config.preset || {});
        const contextConfig = config.context || {};
        this.presetConfig = presetConfig;
        this.contextConfig = {
            enabled: contextConfig.enabled !== false,
            includeSessionFacts: contextConfig.includeSessionFacts !== false,
            includeParticipants: contextConfig.includeParticipants !== false,
            includeReplyReference: contextConfig.includeReplyReference !== false,
            includeRecentUserIntent: contextConfig.includeRecentUserIntent !== false
        };
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
        system_prompt = false
    } = {}) {
        return {
            identifier: String(identifier || '').trim(),
            name: String(name || '').trim(),
            role: String(role || 'system').trim() || 'system',
            content: typeof content === 'string' ? content : '',
            enabled: enabled !== false,
            injection_position: Number.isInteger(injection_position) ? injection_position : 0,
            injection_depth: Number.isInteger(injection_depth) ? injection_depth : 0,
            forbid_overrides: forbid_overrides === true,
            marker: marker === true,
            system_prompt: system_prompt === true
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

        return {
            preSystem: items.filter((item) => item.role === 'system' && item.injection_position !== 1),
            postHistory: items.filter((item) => item.role === 'system' && item.injection_position === 1),
            assistantPrefill: items.filter((item) => item.role === 'assistant')
        };
    }

    async build(characterName, userMessage, context = {}, stickyKeys = new Set(), runtimeContext = {}) {
        const normalizedContext = Array.isArray(context)
            ? { recentMessages: context, summaries: [] }
            : {
                recentMessages: context.recentMessages || [],
                summaries: context.summaries || []
            };

        const character = this.characterManager.readFromPng(characterName);

        let worldBook = this.worldBookManager.currentWorldBook;
        if (!worldBook) {
            worldBook = this.worldBookManager.readWorldBook(characterName);
        }

        const historyText = normalizedContext.recentMessages.map((message) => message.content).join(' ');
        const summaryText = normalizedContext.summaries.map((summary) => summary.content).join(' ');
        const allText = `${historyText} ${summaryText} ${userMessage}`.trim();
        const worldBookEntries = this.worldBookManager.matchEntries(worldBook, allText, 10, stickyKeys);
        const { preSystem, postHistory, assistantPrefill } = PromptBuilder.partitionPromptItems(this.presetConfig);

        let systemPrompt = '';
        const now = new Date();
        const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        systemPrompt += `【当前时间】${timeStr}\n\n`;

        if (this.contextConfig.enabled) {
            const situationalContext = this.buildSituationalContext(normalizedContext, runtimeContext);
            if (situationalContext) {
                systemPrompt += `${situationalContext}\n\n`;
            }
        }

        systemPrompt += `${buildInputGuardrail(runtimeContext.injectionRisk)}\n\n`;

        for (const item of preSystem) {
            systemPrompt += `${item.content}\n\n`;
        }

        if (normalizedContext.summaries.length > 0) {
            systemPrompt += '【历史摘要】\n';
            for (const summary of normalizedContext.summaries) {
                systemPrompt += `${summary.content}\n\n`;
            }
        }

        if (Array.isArray(runtimeContext.recalledEntries) && runtimeContext.recalledEntries.length > 0) {
            systemPrompt += '【数据库召回】\n';
            for (const entry of runtimeContext.recalledEntries) {
                const title = entry.title ? `${entry.title}: ` : '';
                const reason = entry.recallReason ? ` [${entry.recallReason}]` : '';
                systemPrompt += `${title}${entry.content}${reason}\n\n`;
            }
        }

        if (worldBookEntries.length > 0) {
            systemPrompt += '【世界设定】\n';
            for (const entry of worldBookEntries) {
                systemPrompt += `${entry.content}\n\n`;
            }
        }

        if (character.description) {
            systemPrompt += `【角色描述】\n${character.description}\n\n`;
        }

        if (character.personality) {
            systemPrompt += `【${character.name}的性格】\n${character.personality}\n\n`;
        }

        if (character.scenario) {
            systemPrompt += `【场景】\n${character.scenario}\n\n`;
        }

        if (character.system_prompt) {
            systemPrompt += `${character.system_prompt}\n\n`;
        }

        const messages = [
            { role: 'system', content: systemPrompt.trim() }
        ];

        if (normalizedContext.recentMessages.length === 0 && character.first_mes) {
            messages.push({ role: 'assistant', content: character.first_mes });
        }

        for (const message of normalizedContext.recentMessages) {
            messages.push({ role: message.role, content: message.content });
        }

        for (const item of postHistory) {
            messages.push({ role: 'system', content: item.content });
        }

        messages.push({ role: 'user', content: userMessage });

        for (const item of assistantPrefill) {
            messages.push({ role: 'assistant', content: item.content });
        }

        return {
            messages,
            character,
            worldBookCount: worldBookEntries.length,
            worldBookKeys: worldBookEntries.map((entry) => entry.key),
            worldBookEntries: worldBookEntries.map((entry) => ({
                key: entry.key,
                sticky: entry.sticky || 0,
                triggeredByKeyword: entry.triggeredByKeyword,
                triggeredBySticky: entry.triggeredBySticky,
                comment: entry.comment
            }))
        };
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

        return PromptBuilder.normalizePreset({
            enabled: source.enabled !== false,
            name: source.name || source.preset_name || source.title || '',
            systemPrompt: importedSystemPrompt,
            postHistoryInstructions: importedPostHistory,
            jailbreak: importedJailbreak,
            assistantPrefill,
            regexRules: Array.isArray(source.regexRules) ? source.regexRules : []
        });
    }

    static diagnosePresetImport(payload = {}) {
        const source = payload.preset || payload;
        const promptItems = Array.isArray(source.prompts) ? source.prompts : [];
        const enabledPrompts = promptItems.filter((item) => item && item.enabled !== false);
        const absolutePrompts = enabledPrompts.filter((item) => item.injection_position === 1);
        const markerPrompts = enabledPrompts.filter((item) => item.marker === true);
        const assistantRolePrompts = enabledPrompts.filter((item) => String(item.role || '').toLowerCase() === 'assistant');

        const warnings = [];
        if (absolutePrompts.length > 0) {
            warnings.push(`检测到 ${absolutePrompts.length} 条 absolute prompt，当前会降级为普通提示，不会完全复刻 ST 注入位置。`);
        }
        if (markerPrompts.length > 0) {
            warnings.push(`检测到 ${markerPrompts.length} 条 marker prompt，当前不会保留 ST marker 语义。`);
        }
        if (assistantRolePrompts.length > 0) {
            warnings.push(`检测到 ${assistantRolePrompts.length} 条 assistant role prompt，当前仅在可识别场景下映射为 assistant prefill。`);
        }

        return {
            detectedFormat: promptItems.length > 0 ? 'sillytavern-prompts' : 'basic-preset',
            totalPrompts: promptItems.length,
            enabledPrompts: enabledPrompts.length,
            absolutePrompts: absolutePrompts.length,
            markerPrompts: markerPrompts.length,
            assistantRolePrompts: assistantRolePrompts.length,
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
