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
        const presetConfig = bindingPreset || config.preset || {};
        const contextConfig = config.context || {};
        this.presetConfig = {
            enabled: presetConfig.enabled === true,
            name: presetConfig.name || '',
            systemPrompt: presetConfig.systemPrompt || '',
            postHistoryInstructions: presetConfig.postHistoryInstructions || '',
            jailbreak: presetConfig.jailbreak || '',
            assistantPrefill: presetConfig.assistantPrefill || ''
        };
        this.contextConfig = {
            enabled: contextConfig.enabled !== false,
            includeSessionFacts: contextConfig.includeSessionFacts !== false,
            includeParticipants: contextConfig.includeParticipants !== false,
            includeReplyReference: contextConfig.includeReplyReference !== false,
            includeRecentUserIntent: contextConfig.includeRecentUserIntent !== false
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

        if (this.presetConfig.enabled && this.presetConfig.systemPrompt) {
            systemPrompt += `${this.presetConfig.systemPrompt}\n\n`;
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

        if (this.presetConfig.enabled && this.presetConfig.jailbreak) {
            systemPrompt += `${this.presetConfig.jailbreak}\n\n`;
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

        if (this.presetConfig.enabled && this.presetConfig.postHistoryInstructions) {
            messages.push({ role: 'system', content: this.presetConfig.postHistoryInstructions });
        }

        messages.push({ role: 'user', content: userMessage });

        if (this.presetConfig.enabled && this.presetConfig.assistantPrefill) {
            messages.push({ role: 'assistant', content: this.presetConfig.assistantPrefill });
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

        return {
            enabled: source.enabled !== false,
            name: source.name || source.preset_name || source.title || '',
            systemPrompt: importedSystemPrompt,
            postHistoryInstructions: importedPostHistory,
            jailbreak: importedJailbreak,
            assistantPrefill
        };
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
        if (format === 'sillytavern') {
            return {
                name: presetConfig.name || 'Imported Preset',
                system_prompt: presetConfig.systemPrompt || '',
                post_history_instructions: presetConfig.postHistoryInstructions || '',
                jailbreak_system: presetConfig.jailbreak || '',
                assistant_prefill: presetConfig.assistantPrefill || ''
            };
        }

        return {
            preset: {
                enabled: presetConfig.enabled === true,
                name: presetConfig.name || '',
                systemPrompt: presetConfig.systemPrompt || '',
                postHistoryInstructions: presetConfig.postHistoryInstructions || '',
                jailbreak: presetConfig.jailbreak || '',
                assistantPrefill: presetConfig.assistantPrefill || ''
            }
        };
    }
}
