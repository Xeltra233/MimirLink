/**
 * 正则处理模块
 * 支持内置预设规则与自定义规则配置。
 */

export class RegexProcessor {
    constructor(config = {}, logger = console) {
        this.logger = logger;
        this.enabled = true;
        this.rules = [];
        this.updateConfig(config);
    }

    updateConfig(config = {}, bindingRules = null, presetBindingRules = null, globalBindingRules = null) {
        const usePresetRules = config.usePresetRules !== false;
        const globalRules = Array.isArray(globalBindingRules)
            ? globalBindingRules
            : Array.isArray(config.globalRules)
                ? config.globalRules
                : Array.isArray(config.rules)
                    ? config.rules
                    : [];
        const presetRulesBound = Array.isArray(presetBindingRules) ? presetBindingRules : (Array.isArray(config.presetRules) ? config.presetRules : []);
        const characterRules = Array.isArray(bindingRules) ? bindingRules : (Array.isArray(config.characterRules) ? config.characterRules : []);
        this.enabled = config.enabled !== false;
        const mergedRules = usePresetRules
            ? [...presetRules, ...globalRules, ...presetRulesBound, ...characterRules]
            : [...globalRules, ...characterRules];
        mergedRules.push({
            name: '【内置】移除当前消息焦点泄漏',
            pattern: '^[ \\t]*事件:\\s*[^\\r\\n]*(?:\\r?\\n[ \\t]*(?:发言人|意图|回复目标|触发|低信息|最新输入|策略):[^\\r\\n]*){1,7}(?:\\r?\\n)?|\\r?\\n[ \\t]*事件:\\s*[^\\r\\n]*(?:\\r?\\n[ \\t]*(?:发言人|意图|回复目标|触发|低信息|最新输入|策略):[^\\r\\n]*){1,7}',
            flags: 'g',
            replacement: '',
            enabled: true,
            stage: 'output',
            source: 'built-in',
            markdownOnly: false
        });
        mergedRules.push({
            name: '【内置】去除思考链标签',
            pattern: '<thinking>[\\s\\S]*?</thinking>',
            flags: 'g',
            replacement: '',
            enabled: true,
            stage: 'output',
            source: 'built-in',
            markdownOnly: false
        });
        this.loadRules(mergedRules);
    }

    loadRules(rules) {
        this.rules = rules.map((rule) => ({
            ...rule,
            pattern: new RegExp(rule.pattern, rule.flags || 'g')
        }));
        this.logger.info?.(`[正则] 已加载 ${this.rules.length} 条规则`);
    }

    addRule(rule) {
        this.rules.push({
            ...rule,
            pattern: new RegExp(rule.pattern, rule.flags || 'g')
        });
    }

    removeRule(index) {
        if (index >= 0 && index < this.rules.length) {
            this.rules.splice(index, 1);
        }
    }

    getRules() {
        return this.rules.filter((rule) => rule.source !== 'built-in').map((rule) => ({
            name: rule.name,
            pattern: rule.pattern.source,
            flags: rule.pattern.flags,
            replacement: rule.replacement,
            enabled: rule.enabled !== false,
            description: rule.description || '',
            stage: RegexProcessor.normalizeRuleStage(rule.stage, rule.promptOnly === true),
            source: rule.source || 'custom',
            markdownOnly: rule.markdownOnly === true,
            promptOnly: rule.promptOnly === true,
            minDepth: rule.minDepth ?? null,
            maxDepth: rule.maxDepth ?? null
        }));
    }

    static normalizeImportedRule(rule, index = 0) {
        if (!rule || typeof rule !== 'object') {
            return null;
        }

        let pattern = rule.pattern ?? rule.findRegex ?? rule.match ?? '';
        if (!pattern || typeof pattern !== 'string') {
            return null;
        }

        let flags = typeof rule.flags === 'string' ? rule.flags : 'g';
        const delimitedRegex = pattern.match(/^\/(.*)\/([a-z]*)$/i);
        if (delimitedRegex) {
            pattern = delimitedRegex[1];
            flags = delimitedRegex[2] || flags;
        }

        const placement = Array.isArray(rule.placement) ? rule.placement : Array.isArray(rule.stage) ? rule.stage : null;
        const promptOnly = rule.promptOnly === true;
        const markdownOnly = rule.markdownOnly === true;
        const placementValue = Array.isArray(placement) ? placement[0] : placement;

        let stage = typeof rule.stage === 'string' && rule.stage.trim() ? rule.stage : (promptOnly ? 'input' : 'output');
        if (typeof placementValue === 'number') {
            stage = placementValue === 2 ? 'output' : placementValue === 1 ? 'input' : stage;
        } else if (typeof placementValue === 'string' && placementValue.trim()) {
            stage = placementValue;
        }

        const normalizedStage = RegexProcessor.normalizeRuleStage(stage, promptOnly);

        return {
            name: rule.name || rule.scriptName || `Imported Rule ${index + 1}`,
            pattern,
            flags,
            replacement: rule.replacement ?? rule.replaceString ?? '',
            enabled: rule.enabled !== false && rule.disabled !== true,
            description: rule.description || rule.comment || '',
            stage: normalizedStage,
            source: rule.source || 'imported',
            markdownOnly,
            promptOnly,
            minDepth: rule.minDepth ?? null,
            maxDepth: rule.maxDepth ?? null
        };
    }

    static normalizeRuleStage(stage, promptOnly = false) {
        const normalized = String(stage || '').trim().toLowerCase();

        if (promptOnly) {
            return 'input';
        }

        if (!normalized) {
            return 'output';
        }

        if ([
            'input',
            'prompt',
            'user_input',
            'before_prompt',
            'before_generation'
        ].includes(normalized)) {
            return 'input';
        }

        if ([
            'output',
            'display',
            'response',
            'assistant_output',
            'after_generation'
        ].includes(normalized)) {
            return 'output';
        }

        return 'output';
    }

    static importRules(payload) {
        const items = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.rules)
                ? payload.rules
                : Array.isArray(payload?.regex)
                    ? payload.regex
                    : Array.isArray(payload?.regex_scripts)
                        ? payload.regex_scripts
                        : Array.isArray(payload?.extensions?.regex_scripts)
                            ? payload.extensions.regex_scripts
                            : Array.isArray(payload?.extensions?.SPreset?.RegexBinding?.regexes)
                                ? payload.extensions.SPreset.RegexBinding.regexes
                                : [];

        return items
            .map((rule, index) => RegexProcessor.normalizeImportedRule(rule, index))
            .filter(Boolean);
    }

    static diagnoseImport(payload) {
        const rawItems = Array.isArray(payload)
            ? payload
            : Array.isArray(payload?.rules)
                ? payload.rules
                : Array.isArray(payload?.regex)
                    ? payload.regex
                    : Array.isArray(payload?.regex_scripts)
                        ? payload.regex_scripts
                        : Array.isArray(payload?.extensions?.regex_scripts)
                            ? payload.extensions.regex_scripts
                            : Array.isArray(payload?.extensions?.SPreset?.RegexBinding?.regexes)
                                ? payload.extensions.SPreset.RegexBinding.regexes
                                : [];

        const imported = rawItems
            .map((rule, index) => RegexProcessor.normalizeImportedRule(rule, index))
            .filter(Boolean);

        const markdownOnlyCount = rawItems.filter((rule) => rule?.markdownOnly === true).length;
        const promptOnlyCount = rawItems.filter((rule) => rule?.promptOnly === true).length;
        const runOnEditCount = rawItems.filter((rule) => rule?.runOnEdit === true).length;
        const depthLimitedCount = rawItems.filter((rule) => rule?.minDepth != null || rule?.maxDepth != null).length;

        const warnings = [];
        if (markdownOnlyCount > 0) {
            warnings.push(`检测到 ${markdownOnlyCount} 条 markdownOnly 规则，当前后端没有 markdown 渲染阶段，这些规则会被保留但不会在真实聊天链路执行。`);
        }
        if (runOnEditCount > 0) {
            warnings.push(`检测到 ${runOnEditCount} 条 runOnEdit 规则，当前不会复刻 ST 编辑态执行时机。`);
        }
        if (depthLimitedCount > 0) {
            warnings.push(`检测到 ${depthLimitedCount} 条深度限制规则，当前仅按 depth=0 执行，超出范围的规则会在真实聊天链路中被跳过。`);
        }

        return {
            detectedFormat: Array.isArray(payload?.extensions?.SPreset?.RegexBinding?.regexes) || Array.isArray(payload?.extensions?.regex_scripts) || Array.isArray(payload?.regex_scripts)
                ? 'sillytavern-regex'
                : 'basic-regex',
            totalRules: rawItems.length,
            importableRules: imported.length,
            markdownOnlyCount,
            promptOnlyCount,
            runOnEditCount,
            depthLimitedCount,
            warnings
        };
    }

    static exportRules(rules, format = 'native') {
        if (format === 'sillytavern') {
            return {
                version: 1,
                type: 'regex',
                rules: rules.map((rule) => ({
                    scriptName: rule.name,
                    findRegex: rule.pattern,
                    replaceString: rule.replacement || '',
                    trimStrings: [],
                    placement: RegexProcessor.normalizeRuleStage(rule.stage, rule.promptOnly === true) === 'input' ? 1 : 2,
                    disabled: rule.enabled === false,
                    markdownOnly: rule.markdownOnly === true,
                    promptOnly: rule.promptOnly === true || RegexProcessor.normalizeRuleStage(rule.stage, rule.promptOnly === true) === 'input',
                    runOnEdit: rule.runOnEdit === true,
                    minDepth: rule.minDepth ?? null,
                    maxDepth: rule.maxDepth ?? null
                }))
            };
        }

        return {
            version: 1,
            type: 'regex',
            rules
        };
    }

    process(text, stage = 'output') {
        return this.processWithTrace(text, stage).text;
    }

    processWithTrace(text, stage = 'output') {
        const originalText = text;
        const trace = {
            stage: RegexProcessor.normalizeRuleStage(stage),
            enabled: this.enabled !== false,
            before: typeof originalText === 'string' ? originalText : String(originalText || ''),
            after: typeof originalText === 'string' ? originalText : String(originalText || ''),
            appliedRules: [],
            skippedRules: [],
            errors: []
        };

        if (!this.enabled || !text || this.rules.length === 0) {
            return { text, trace };
        }

        let result = text;
        const normalizedStage = RegexProcessor.normalizeRuleStage(stage);

        for (const rule of this.rules) {
            const ruleName = rule.name || rule.pattern?.source || 'unnamed';
            if (rule.enabled === false) {
                trace.skippedRules.push({ name: ruleName, reason: 'disabled' });
                continue;
            }
            if (rule.markdownOnly === true && normalizedStage === 'input') {
                trace.skippedRules.push({ name: ruleName, reason: 'markdown_only_input' });
                continue;
            }
            if (!RegexProcessor.ruleMatchesStage(rule, normalizedStage)) {
                trace.skippedRules.push({ name: ruleName, reason: 'stage_mismatch' });
                continue;
            }
            if (!RegexProcessor.ruleMatchesDepth(rule, 0)) {
                trace.skippedRules.push({ name: ruleName, reason: 'depth_mismatch' });
                continue;
            }

            try {
                rule.pattern.lastIndex = 0;
                const before = result;
                result = result.replace(rule.pattern, rule.replacement || '');
                if (before !== result) {
                    trace.appliedRules.push({
                        name: ruleName,
                        pattern: rule.pattern.source,
                        replacement: rule.replacement || '',
                        beforeLength: before.length,
                        afterLength: result.length
                    });
                }
            } catch (error) {
                trace.errors.push({ name: ruleName, error: error?.message || String(error) });
                this.logger.error?.(`[正则] 规则执行失败: ${ruleName}`, error);
            }
        }

        if (trace.appliedRules.length > 0) {
            this.logger.debug?.(`[正则] 已应用规则: ${trace.appliedRules.map((rule) => rule.name).join(', ')}`);
        }

        trace.after = result;
        return { text: result, trace };
    }

    processInput(text) {
        return this.process(text, 'input');
    }

    processOutput(text) {
        return this.process(text, 'output');
    }

    processOutputWithTrace(text) {
        return this.processWithTrace(text, 'output');
    }

    static ruleMatchesStage(rule = {}, stage = 'output') {
        return RegexProcessor.normalizeRuleStage(rule.stage, rule.promptOnly === true) === RegexProcessor.normalizeRuleStage(stage);
    }

    static ruleMatchesDepth(rule = {}, depth = 0) {
        if (rule.minDepth != null && Number(depth) < Number(rule.minDepth)) {
            return false;
        }

        if (rule.maxDepth != null && Number(depth) > Number(rule.maxDepth)) {
            return false;
        }

        return true;
    }

    testRule(pattern, flags, replacement, testText) {
        try {
            const regex = new RegExp(pattern, flags || 'g');
            const matches = testText.match(regex);
            const result = testText.replace(regex, replacement || '');
            return {
                success: true,
                matches: matches || [],
                result,
                changed: testText !== result
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

export const presetRules = [
    {
        name: '移除思考标签',
        pattern: '<thinking>[\\s\\S]*?</thinking>',
        flags: 'gi',
        replacement: '',
        stage: 'output',
        enabled: true,
        description: '移除 AI 回复中的思考过程标签'
    },
    {
        name: '移除 OC 标记',
        pattern: '\\(OOC:.*?\\)',
        flags: 'gi',
        replacement: '',
        stage: 'output',
        enabled: false,
        description: '移除 Out of Character 标记'
    },
    {
        name: '移除角色名前缀',
        pattern: '^[^:：]+[:：]\\s*',
        flags: 'm',
        replacement: '',
        stage: 'output',
        enabled: false,
        description: '移除回复开头的角色名前缀'
    },
    {
        name: '移除多余空行',
        pattern: '\\n{3,}',
        flags: 'g',
        replacement: '\n\n',
        stage: 'output',
        enabled: true,
        description: '将连续多个空行压缩为两个'
    },
    {
        name: '移除首尾空白',
        pattern: '^\\s+|\\s+$',
        flags: 'g',
        replacement: '',
        stage: 'output',
        enabled: true,
        description: '移除文本首尾的空白字符'
    }
];
