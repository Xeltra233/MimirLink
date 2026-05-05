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
            : [...globalRules, ...presetRulesBound, ...characterRules];
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
        return this.rules.map((rule) => ({
            name: rule.name,
            pattern: rule.pattern.source,
            flags: rule.pattern.flags,
            replacement: rule.replacement,
            enabled: rule.enabled !== false,
            description: rule.description || '',
            stage: rule.stage || 'output',
            source: rule.source || 'custom'
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

        let stage = rule.stage || (promptOnly ? 'input' : 'output');
        if (typeof placementValue === 'number') {
            stage = placementValue === 2 ? 'output' : placementValue === 1 ? 'input' : stage;
        } else if (typeof placementValue === 'string' && placementValue.trim()) {
            stage = placementValue;
        }

        return {
            name: rule.name || rule.scriptName || `Imported Rule ${index + 1}`,
            pattern,
            flags,
            replacement: rule.replacement ?? rule.replaceString ?? '',
            enabled: rule.enabled !== false && rule.disabled !== true,
            description: rule.description || rule.comment || '',
            stage,
            source: rule.source || 'imported',
            markdownOnly,
            promptOnly,
            minDepth: rule.minDepth ?? null,
            maxDepth: rule.maxDepth ?? null
        };
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
            warnings.push(`检测到 ${markdownOnlyCount} 条 markdownOnly 规则，当前只能按普通文本规则导入。`);
        }
        if (runOnEditCount > 0) {
            warnings.push(`检测到 ${runOnEditCount} 条 runOnEdit 规则，当前不会复刻 ST 编辑态执行时机。`);
        }
        if (depthLimitedCount > 0) {
            warnings.push(`检测到 ${depthLimitedCount} 条深度限制规则，当前仅保留元数据，不会完整复刻 ST 深度执行模型。`);
        }

        return {
            detectedFormat: Array.isArray(payload?.extensions?.SPreset?.RegexBinding?.regexes) || Array.isArray(payload?.regex_scripts)
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
                    placement: rule.stage || 'output',
                    disabled: rule.enabled === false,
                    markdownOnly: false,
                    promptOnly: rule.stage === 'input'
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
        if (!this.enabled || !text || this.rules.length === 0) {
            return text;
        }

        let result = text;
        const appliedRules = [];

        for (const rule of this.rules) {
            if (rule.enabled === false) {
                continue;
            }
            if (rule.stage && rule.stage !== stage) {
                continue;
            }

            try {
                rule.pattern.lastIndex = 0;
                const before = result;
                result = result.replace(rule.pattern, rule.replacement || '');
                if (before !== result) {
                    appliedRules.push(rule.name || rule.pattern.source);
                }
            } catch (error) {
                this.logger.error?.(`[正则] 规则执行失败: ${rule.name || rule.pattern.source}`, error);
            }
        }

        if (appliedRules.length > 0) {
            this.logger.debug?.(`[正则] 已应用规则: ${appliedRules.join(', ')}`);
        }

        return result;
    }

    processInput(text) {
        return this.process(text, 'input');
    }

    processOutput(text) {
        return this.process(text, 'output');
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
