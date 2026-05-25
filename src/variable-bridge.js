/**
 * 变量桥接层：连接 AI 输出的 UpdateVariable/JSONPatch 与 MimirLink 变量存储
 *
 * 参考卡（SillyTavern 格式）的 AI 会输出：
 *   <UpdateVariable>
 *   [{"op":"replace","path":"/好感度","value":50}]
 *   </UpdateVariable>
 *
 * 本模块将其解析并写入 MimirLink 的变量存储，同时从 AI 输出中剥离标签。
 */

const GET_MESSAGE_VARIABLE_REGEX = /\{\{get_message_variable::([^}]+)\}\}/gi;
const GETVAR_REGEX = /\{\{getvar::([^}]+)\}\}/gi;
const SETVAR_REGEX = /\{\{setvar::([^}:]+?)::([\s\S]*?)\}\}/gi;
const UPDATE_VARIABLE_TAG_REGEX = /<UpdateVariable>\s*([\s\S]*?)\s*<\/UpdateVariable>/gi;

export function extractTaggedContent(text, tagName) {
    if (!text || !tagName) return '';
    const escapedTag = String(tagName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = String(text).match(new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, 'i'));
    return match ? match[1].trim() : '';
}

export function extractVisibleContent(text) {
    const content = extractTaggedContent(text, 'content');
    return content || String(text || '');
}

// ST 卡常见内部标签（支持带属性的情况如 <details class="...">）
const INTERNAL_TAGS = [
    // 思维/草稿类
    /<draft_notes[^>]*>[\s\S]*?<\/draft_notes>/gi,
    /<draft[^>]*>[\s\S]*?<\/draft>/gi,
    /<thinking[^>]*>[\s\S]*?<\/thinking>/gi,
    /<analysis[^>]*>[\s\S]*?<\/analysis>/gi,
    /<reflection[^>]*>[\s\S]*?<\/reflection>/gi,
    /<cot[^>]*>[\s\S]*?<\/cot>/gi,
    /<内部分析[^>]*>[\s\S]*?<\/内部分析>/gi,
    // ST 状态/格式类
    /<bginfor[^>]*>[\s\S]*?<\/bginfor>/gi,
    /<maintext[^>]*>[\s\S]*?<\/maintext>/gi,
    /<contenttext[^>]*>[\s\S]*?<\/contenttext>/gi,
    /<details[^>]*>[\s\S]*?<\/details>/gi,
    /<summary[^>]*>[\s\S]*?<\/summary>/gi,
    /<WMM[^>]*>[\s\S]*?<\/WMM>/gi,
    /<StatusBlock[^>]*>[\s\S]*?<\/StatusBlock>/gi,
    // ST 行动选项
    /<option[^>]*>[\s\S]*?<\/option>/gi,
    // XML 注释
    /<!--[\s\S]*?-->/g,
];

/**
 * 剥离 ST 卡常见的内部思考标签（draft_notes / thinking / cot 等）
 * 不处理 UpdateVariable（由 extractAndApplyVariables 单独处理）
 */
export function stripInternalTags(text) {
    if (!text) return text;
    let result = text;

    // 1. 保存 UpdateVariable 块
    const uvBlocks = [];
    result = result.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, (match) => {
        uvBlocks.push(match);
        return `___UV_${uvBlocks.length - 1}___`;
    });

    // 2. 删除整个内容块（style/script/XML注释）
    result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    result = result.replace(/<!--[\s\S]*?-->/g, '');

    // 3. 完全删除的标签（连内容一起删）
    const deleteWithContent = ['thinking', 'cot', 'analysis', 'reflection', 'draft_notes', 'draft', '内部分析'];
    for (const tag of deleteWithContent) {
        result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi'), '');
        result = result.replace(new RegExp(`<${tag}[^>]*>[\\s\\S]*$`, 'gi'), '');
    }
    // 只去标签保内容的标签
    const stripTagOnly = ['bginfor', 'maintext', 'contenttext', 'details', 'summary', 'WMM', 'StatusBlock', 'option'];
    for (const tag of stripTagOnly) {
        result = result.replace(new RegExp(`<${tag}[^>]*>`, 'gi'), '');
        result = result.replace(new RegExp(`</${tag}>`, 'gi'), '');
    }

    // 4. 去掉所有残留 HTML 标签
    result = result.replace(/<[^>]+>/g, '');

    // 5. 还原 UpdateVariable
    result = result.replace(/___UV_(\d+)___/g, (_, i) => uvBlocks[parseInt(i)] || '');

    return result.replace(/\n{3,}/g, '\n\n').trim();
}

export function extractAndApplyVariables(rawOutput, sessionManager, scopeOptions) {
    if (!rawOutput || !sessionManager) return { cleanedOutput: rawOutput, applied: [] };

    const applied = [];
    let cleanedOutput = rawOutput;

    const matches = [...rawOutput.matchAll(UPDATE_VARIABLE_TAG_REGEX)];

    for (const match of matches) {
        const blockContent = match[1].trim();
        try {
            const patches = JSON.parse(blockContent);
            if (Array.isArray(patches)) {
                for (const patch of patches) {
                    applyPatch(patch, sessionManager, scopeOptions);
                    applied.push(patch);
                }
            }
        } catch (error) {
            // JSON 解析失败，记录日志并跳过
            console.warn(`[变量桥接] UpdateVariable 解析失败: ${error.message}`, {
                blockContent: blockContent.slice(0, 100)
            });
        }
        cleanedOutput = cleanedOutput.replace(match[0], '');
    }

    cleanedOutput = cleanedOutput.replace(/\n{3,}/g, '\n\n').trim();

    return { cleanedOutput, applied };
}

export function scanVariableUsage(sources = []) {
    const reads = [];
    const writes = [];
    const unsupported = [];
    let hasUpdateVariable = false;
    let hasJsonPatch = false;
    let hasMVU = false;

    for (const source of normalizeSources(sources)) {
        const text = source.content;
        if (!text) continue;

        for (const match of text.matchAll(GET_MESSAGE_VARIABLE_REGEX)) {
            const rawKey = String(match[1] || '').trim();
            if (!rawKey) continue;
            reads.push({
                type: 'get_message_variable',
                key: normalizeLookupKey(rawKey),
                rawKey,
                source: source.name
            });
        }

        for (const match of text.matchAll(GETVAR_REGEX)) {
            const rawKey = String(match[1] || '').trim();
            if (!rawKey) continue;
            reads.push({
                type: 'getvar',
                key: normalizeLookupKey(rawKey),
                rawKey,
                source: source.name
            });
        }

        for (const match of text.matchAll(SETVAR_REGEX)) {
            const rawKey = String(match[1] || '').trim();
            const rawValue = String(match[2] || '').trim();
            if (!rawKey) continue;
            writes.push({
                type: 'setvar',
                key: normalizeStorageKey(rawKey),
                rawKey,
                rawValue,
                parsedValue: parseLiteralValue(rawValue),
                source: source.name
            });
        }

        if (UPDATE_VARIABLE_TAG_REGEX.test(text)) hasUpdateVariable = true;
        UPDATE_VARIABLE_TAG_REGEX.lastIndex = 0;
        if (/JSONPatch/i.test(text)) hasJsonPatch = true;
        if (/\bMVU\b/i.test(text) || /mvu_/i.test(text)) hasMVU = true;
        if (/type\s*[:=]\s*["']script["']/i.test(text) || /\bJS_CODE\b/i.test(text)) {
            unsupported.push({
                type: 'script_runtime',
                source: source.name
            });
        }
    }

    return {
        reads: dedupeRecords(reads, (item) => `${item.type}::${item.key}::${item.source}`),
        writes: dedupeRecords(writes, (item) => `${item.key}::${item.rawValue}::${item.source}`),
        updateProtocol: {
            hasUpdateVariable,
            hasJsonPatch,
            hasMVU
        },
        unsupported: dedupeRecords(unsupported, (item) => `${item.type}::${item.source}`)
    };
}

export function applyStaticSetvarsFromText(text, sessionManager, scopeOptions, options = {}) {
    if (!text || !sessionManager) {
        return { cleanedText: text, applied: [] };
    }

    const keepMacros = options.keepMacros === true;
    const applied = [];
    let cleanedText = text;

    for (const match of text.matchAll(SETVAR_REGEX)) {
        const rawKey = String(match[1] || '').trim();
        const rawValue = String(match[2] || '').trim();
        if (!rawKey) continue;
        const parsedValue = parseLiteralValue(rawValue);
        const key = normalizeStorageKey(rawKey);
        sessionManager.upsertVariable(scopeOptions, {
            key,
            rawValue: String(parsedValue ?? ''),
            valueType: inferType(parsedValue),
            source: 'imported-card',
            tags: ['system']  // 预设注入变量标记，UI据此折叠
        });
        applied.push({ key, rawKey, rawValue, parsedValue });
        if (!keepMacros) {
            cleanedText = cleanedText.replace(match[0], '');
        }
    }

    if (!keepMacros) {
        cleanedText = cleanedText.replace(/\n{3,}/g, '\n\n').trim();
    }

    return { cleanedText, applied };
}

export function applyScannedVariableInitializers(scanResult, sessionManager, scopeOptions, options = {}) {
    if (!scanResult || !sessionManager) return [];
    const existingOnly = options.skipExisting === true;
    const applied = [];

    for (const item of scanResult.writes || []) {
        if (!item.key) continue;
        if (existingOnly && sessionManager.getVariable?.(scopeOptions, item.key)) continue;
        sessionManager.upsertVariable(scopeOptions, {
            key: item.key,
            rawValue: String(item.parsedValue ?? ''),
            valueType: inferType(item.parsedValue),
            source: 'imported-card',
            tags: ['system']
        });
        applied.push(item);
    }

    return applied;
}

function applyPatch(patch, sessionManager, scopeOptions) {
    const { op, path, value } = patch;
    if (!op || !path) return;

    const key = normalizePatchPath(path);

    switch (op) {
        case 'replace':
        case 'add':
            sessionManager.upsertVariable(scopeOptions, {
                key,
                rawValue: String(value ?? ''),
                valueType: inferType(value),
                source: 'ai'
            });
            break;
        case 'remove':
            sessionManager.deleteVariableByName?.(scopeOptions, key);
            break;
    }
}

function inferType(value) {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    if (typeof value === 'object' && value !== null) return 'json';
    return 'string';
}

function parseLiteralValue(rawValue) {
    const value = String(rawValue ?? '').trim();
    if (!value) return '';
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
    return value;
}

function normalizePatchPath(path) {
    return String(path || '').replace(/^\/+/, '').replace(/\//g, '.');
}

function normalizeLookupKey(key) {
    const cleanKey = String(key || '').trim().replace(/^\/+/, '').replace(/\//g, '.');
    return cleanKey.replace(/^stat_data\./, '');
}

function normalizeStorageKey(key) {
    return normalizeLookupKey(key);
}

function normalizeSources(sources) {
    return (Array.isArray(sources) ? sources : []).map((item, index) => {
        if (typeof item === 'string') {
            return { name: `source_${index + 1}`, content: item };
        }
        return {
            name: item?.name || `source_${index + 1}`,
            content: typeof item?.content === 'string' ? item.content : ''
        };
    });
}

function dedupeRecords(items, getKey) {
    const seen = new Set();
    const result = [];
    for (const item of items) {
        const key = getKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item);
    }
    return result;
}

/**
 * 构建变量状态快照，注入到 system prompt 中
 * 格式参考 SillyTavern 的 <status_current_variable>
 */
export function buildVariableStatusBlock(sessionManager, scopeOptions) {
    try {
        let vars = sessionManager.listVariables?.(scopeOptions) || [];
        // 实际 scope 没变量时，fallback 到 default scope
        if (vars.length === 0 && scopeOptions.scopeKey !== 'default') {
            vars = sessionManager.listVariables?.({ ...scopeOptions, scopeKey: 'default' }) || [];
        }

        // 过滤内部宏变量（{{setvar}} 产生的 COT-*/gs-* 等）
        const SYSTEM_VAR_PREFIXES = ['COT-', 'gs-', 'mvuvar', 'supernsfw'];
        vars = vars.filter(v => {
            const key = v.key || v.title || '';
            return !SYSTEM_VAR_PREFIXES.some(p => key.startsWith(p));
        });

        if (vars.length === 0) return '';

        const entries = vars.map(v => {
            const val = v.rawValue || v.value || '';
            return `${v.key || v.title}: ${val}`;
        });

        if (entries.length === 0) return '';
        return `\n<status_current_variable>\n${entries.join('\n')}\n</status_current_variable>\n`;
    } catch {
        return '';
    }
}

/**
 * 解析 prompt 中的 {{get_message_variable::path}} 宏
 * path 格式：stat_data.角色.西园寺爱丽莎.好感度
 * MimirLink 存储 key：角色.西园寺爱丽莎.好感度（去掉 stat_data 前缀）
 * 也支持：{{getvar::key}} 格式
 */
export function resolveVariableMacros(text, sessionManager, scopeOptions) {
    if (!text || !sessionManager) return text;

    let allVars = sessionManager.listVariables?.(scopeOptions) || [];
    // 实际 scope 没变量时，fallback 到 default scope
    if (allVars.length === 0 && scopeOptions.scopeKey !== 'default') {
        allVars = sessionManager.listVariables?.({ ...scopeOptions, scopeKey: 'default' }) || [];
    }
    if (allVars.length === 0) return text;

    const varMap = new Map();
    for (const v of allVars) {
        const rawKey = normalizeStorageKey(v.key || v.title || '');
        const val = v.rawValue || v.value || '';
        varMap.set(rawKey, val);
        varMap.set('stat_data.' + rawKey, val);
    }

    let result = text.replace(GET_MESSAGE_VARIABLE_REGEX, (match, key) => {
        const cleanKey = normalizeLookupKey(key);
        if (varMap.has(cleanKey)) return varMap.get(cleanKey);
        const withPrefix = 'stat_data.' + cleanKey;
        if (varMap.has(withPrefix)) return varMap.get(withPrefix);
        for (const [k, v] of varMap) {
            if (k.endsWith(cleanKey) || cleanKey.endsWith(k)) return v;
        }
        return match;
    });

    result = result.replace(GETVAR_REGEX, (match, key) => {
        const cleanKey = normalizeLookupKey(key);
        if (varMap.has(cleanKey)) return varMap.get(cleanKey);
        const withPrefix = 'stat_data.' + cleanKey;
        if (varMap.has(withPrefix)) return varMap.get(withPrefix);
        return match;
    });

    // {{format_message_variable::stat_data}} — SillyTavern 标准宏，展示所有变量
    result = result.replace(/\{\{format_message_variable::([^}]+)\}\}/gi, (match, prefix) => {
        const lines = [];
        for (const [k, v] of varMap) {
            // 过滤掉 stat_data. 前缀重复键
            if (k.startsWith('stat_data.')) continue;
            lines.push(`${k}: ${v}`);
        }
        return lines.length > 0 ? lines.join('\n') : match;
    });

    return result;
}
