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
    // 1. 先洗成对标签（draft_notes/details/style 等，标签+内容全删）
    for (const regex of INTERNAL_TAGS) {
        result = result.replace(regex, '');
    }
    // 2. 单独洗 <style> 块
    result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    // 3. 洗所有裸 HTML 标签（开/闭/自闭合），但保留 <UpdateVariable>
    const uvPlaceholder = '___UV_PLACEHOLDER___';
    const uvBlocks = [];
    result = result.replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, (match) => {
        uvBlocks.push(match);
        return uvPlaceholder;
    });
    // 去掉所有 HTML 标签
    result = result.replace(/<[^>]+>/g, '');
    // 还原 UpdateVariable
    let idx = 0;
    result = result.replace(new RegExp(uvPlaceholder, 'g'), () => uvBlocks[idx++] || '');
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
        } catch {
            // 不是合法 JSON，跳过
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
            source: 'imported-card'
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
            source: 'imported-card'
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

    return result;
}
