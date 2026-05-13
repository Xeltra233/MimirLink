import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createMCPHandler(managers, config, saveConfig) {
    const { aiClient, promptBuilder, characterManager, worldBookManager, sessionManager, logger } = managers;

    // === ST 格式校验 ===
    const ST_WORLDBOOK_ENTRY_FIELDS = {
        required: ['id', 'keys', 'content'],
        standard: ['id', 'keys', 'secondary_keys', 'comment', 'content', 'constant', 'selective', 'insertion_order', 'enabled', 'position', 'use_regex', 'extensions'],
        position_values: ['before_char', 'after_char', 'before_character', 'after_character', 0, 1]
    };

    function validateWorldbookEntry(entry, index) {
        const issues = [];
        // 必填字段
        for (const field of ST_WORLDBOOK_ENTRY_FIELDS.required) {
            if (entry[field] === undefined) {
                issues.push(`条目#${index} 缺少必要字段: ${field}`);
            }
        }
        // 非标字段警告
        for (const key of Object.keys(entry)) {
            if (!ST_WORLDBOOK_ENTRY_FIELDS.standard.includes(key)) {
                issues.push(`条目#${index} 含非 ST 标准字段: "${key}"（导出 ST 时可能被忽略）`);
            }
        }
        // 旧字段名警告
        if (entry.uid !== undefined && entry.id === undefined) issues.push(`条目#${index}: 使用了旧字段 uid，应改为 id`);
        if (entry.order !== undefined && entry.insertion_order === undefined) issues.push(`条目#${index}: 使用了旧字段 order，应改为 insertion_order`);
        if (entry.position !== undefined && typeof entry.position === 'number') issues.push(`条目#${index}: position 应为字符串 "before_char"/"after_char"`);
        return issues;
    }

    function validateWorldbookFormat(wb, name) {
        const allIssues = [];
        const entries = wb?.entries || [];
        if (!Array.isArray(entries)) {
            allIssues.push(`世界书 "${name}" 的 entries 不是数组`);
            return { valid: false, issues: allIssues };
        }
        for (let i = 0; i < entries.length; i++) {
            allIssues.push(...validateWorldbookEntry(entries[i], i));
        }
        return { valid: allIssues.length === 0, issues: allIssues, entryCount: entries.length };
    }

    // 自动修复：把非标字段转 ST 格式
    function normalizeToSTFormat(entry) {
        const fixed = { ...entry };
        if (fixed.uid !== undefined && fixed.id === undefined) { fixed.id = fixed.uid; delete fixed.uid; }
        if (fixed.order !== undefined && fixed.insertion_order === undefined) { fixed.insertion_order = fixed.order; delete fixed.order; }
        if (typeof fixed.position === 'number') { fixed.position = fixed.position === 0 ? 'before_char' : 'after_char'; }
        fixed.secondary_keys = fixed.secondary_keys || [];
        fixed.selective = fixed.selective ?? false;
        return fixed;
    }

    // 工具注册表
    const tools = {

        range_test: {
            description: '发送测试消息到指定角色，获取 AI 回复。用于测试角色卡表现。',
            inputSchema: {
                type: 'object',
                properties: {
                    message: { type: 'string', description: '测试消息内容' },
                    characterName: { type: 'string', description: '角色名，可选，默认用当前靶场选择的角色' }
                },
                required: ['message']
            },
            handler: async ({ message, characterName }) => {
                const resolvedChar = characterName || config.chat?.defaultCharacter || '';
                if (!resolvedChar) return { content: [{ type: 'text', text: '请指定 characterName' }] };

                const charName = resolvedChar.replace(/\.png$/i, '');
                let character = null;
                try { character = characterManager.readFromPng(charName); } catch {}
                if (!character) return { content: [{ type: 'text', text: `角色 "${resolvedChar}" 未找到` }] };

                try {
                    const built = await promptBuilder.build(
                        resolvedChar, message,
                        { recentMessages: [], summaries: [] },
                        new Set(),
                        { sessionId: `mcp_${Date.now()}`, messageType: 'group', messageCount: 1, recalledEntries: [], participants: [], injectionRisk: null, replyReference: null },
                        { character, worldBook: null, presetConfig: null }
                    );

                    const aiResult = await aiClient.chat(built.messages, {});
                    const reply = aiClient.getVisibleResponseContent(aiResult);
                    const usage = aiResult?.usage || null;

                    return {
                        content: [{ type: 'text', text: JSON.stringify({ reply, tokenUsage: usage }, null, 2) }]
                    };
                } catch (e) {
                    return { content: [{ type: 'text', text: `测试失败: ${e.message}` }] };
                }
            }
        },

        range_analyze: {
            description: '分析/评分角色回复质量，检测八股词、冗余描写、角色偏离等问题，返回具体修改建议和下一轮测试消息。',
            inputSchema: {
                type: 'object',
                properties: {
                    goal: { type: 'string', description: '优化目标描述' },
                    lastUserMessage: { type: 'string', description: '用户测试消息' },
                    lastAIResponse: { type: 'string', description: '角色 AI 回复内容' },
                    characterName: { type: 'string', description: '角色名，可选' }
                },
                required: ['goal', 'lastUserMessage', 'lastAIResponse']
            },
            handler: async ({ goal, lastUserMessage, lastAIResponse, characterName }) => {
                try {
                    const resolvedChar = characterName || config.chat?.defaultCharacter || '';
                    let charSummary = '';
                    let wbSummary = '';

                    if (resolvedChar) {
                        const charName = resolvedChar.replace(/\.png$/i, '');
                        try {
                            const ch = characterManager.readFromPng(charName);
                            if (ch) {
                                charSummary = [
                                    ch.name ? `name: ${ch.name}` : '',
                                    ch.description ? `description: ${ch.description.slice(0, 600)}` : '',
                                    ch.personality ? `personality: ${ch.personality.slice(0, 400)}` : '',
                                    ch.scenario ? `scenario: ${ch.scenario.slice(0, 300)}` : '',
                                    ch.first_mes ? `first_mes: ${ch.first_mes.slice(0, 400)}` : '',
                                    ch.system_prompt ? `system_prompt: ${ch.system_prompt.slice(0, 600)}` : ''
                                ].filter(Boolean).join('\n');
                            }
                        } catch {}

                        try {
                            const wb = worldBookManager.readWorldBook(resolvedChar);
                            if (wb?.entries) {
                                wbSummary = wb.entries.slice(0, 10).map((e, i) =>
                                    `条目#${i}: key=${(e.key||e.keys||[]).join(',')} | content: ${(e.content||'').slice(0, 200)}`
                                ).join('\n');
                            }
                        } catch {}
                    }

                    const analyzePrompt = `你是写卡优化专家，融合明月秋青/萧谴/A.U.T.O 三套方法论。

## 创作方法论
性格调色盘: 用行为展现性格,非贴标签
绝对零度: 白描事实,不修饰渲染,用名词动词避形容词
八股检测(必须砍): 模糊词(似乎/仿佛/宛如) | 劣质比喻(小兽/涟漪/投石) | 微表情(嘴角上扬/闪过光芒) | 语气描写 | 大段内心

## 优化目标: ${goal}

## 测试结果
用户消息: ${lastUserMessage}
AI回复: ${lastAIResponse}

## 角色卡
${charSummary || '(未提供)'}

## 世界书
${wbSummary || '(未提供)'}

请分析此回复存在的问题，按以下格式输出：

---评估---
问题：
- 具体问题1（引用原文证据）
- 具体问题2
亮点：
- 亮点1

---修改建议---
需要修改的字段和具体方案

---下一条测试---
建议的下一条测试消息`;

                    const aiResult = await aiClient.chat([{ role: 'user', content: analyzePrompt }], { temperature: 0.4, maxTokens: 2048 });
                    const analysis = aiClient.getVisibleResponseContent(aiResult);

                    return { content: [{ type: 'text', text: analysis }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `分析失败: ${e.message}` }] };
                }
            }
        },

        range_list_characters: {
            description: '列出所有可用角色',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const list = characterManager.listCharacters();
                    const names = Array.isArray(list) ? list.map(c => typeof c === 'string' ? c : (c.name || c.filename || c)).filter(Boolean) : [];
                    return { content: [{ type: 'text', text: names.length > 0 ? names.join('\n') : '(无角色)' }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `获取失败: ${e.message}` }] };
                }
            }
        },

        range_list_models: {
            description: '列出所有可用 AI 模型（含 provider 信息）',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const providers = (config.ai?.providers || []).map(p => ({
                        provider: p.name || p.id,
                        models: (p.models || []).map(m => ({
                            id: (m.id || m.name || '').replace(/^\[[^\]]*\]\s*/, ''),
                            name: m.name || m.id || ''
                        }))
                    }));
                    return { content: [{ type: 'text', text: JSON.stringify(providers, null, 2) }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `获取失败: ${e.message}` }] };
                }
            }
        },

        range_get_prefs: {
            description: '读取靶场当前偏好（角色/世界书/预设/模型选择）',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const prefsPath = resolve(__dirname, '..', 'data', 'range-prefs.json');
                    let prefs = {};
                    try { prefs = JSON.parse(readFileSync(prefsPath, 'utf8')); } catch {}
                    return { content: [{ type: 'text', text: JSON.stringify(prefs, null, 2) }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `获取失败: ${e.message}` }] };
                }
            }
        },

        // ======== 写工具 ========

        range_update_character: {
            description: '修改角色卡字段。可更新 system_prompt、first_mes、scenario、post_history_instructions 等。',
            inputSchema: {
                type: 'object',
                properties: {
                    characterName: { type: 'string', description: '角色名' },
                    updates: { type: 'object', description: '要更新的字段，如 {"system_prompt":"新内容","first_mes":"新开场白"}' }
                },
                required: ['characterName', 'updates']
            },
            handler: async ({ characterName, updates }) => {
                try {
                    const name = characterName.replace(/\.png$/i, '');
                    characterManager.updateCharacter(name, updates);
                    return { content: [{ type: 'text', text: `已更新角色 "${name}" 的 ${Object.keys(updates).join('、')}` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `更新失败: ${e.message}` }] };
                }
            }
        },

        range_get_preset_status: {
            description: '列出所有预设 prompt 及其启用状态。可用于审查哪些功能开着。',
            inputSchema: { type: 'object', properties: {
                filter: { type: 'string', description: '可选，只返回名称包含此关键词的 prompt' }
            }},
            handler: async ({ filter }) => {
                const presetFiles = config.imports?.presetFiles || [];
                let all = [];
                for (const pf of presetFiles) {
                    for (const p of pf?.importedPreset?.prompts || []) {
                        if (!filter || (p.name || '').includes(filter)) {
                            all.push({ name: p.name, enabled: p.enabled !== false, role: p.role || 'system' });
                        }
                    }
                }
                return { content: [{ type: 'text', text: JSON.stringify(all, null, 2) }] };
            }
        },

        range_batch_set_prompts: {
            description: '批量启用/禁用预设 prompt。patterns 数组中的每个关键词会匹配所有名称包含它的 prompt。',
            inputSchema: {
                type: 'object',
                properties: {
                    disablePatterns: { type: 'array', items: { type: 'string' }, description: '含这些关键词的 prompt 全部禁用' },
                    enablePatterns: { type: 'array', items: { type: 'string' }, description: '含这些关键词的 prompt 全部启用' }
                },
                required: []
            },
            handler: async ({ disablePatterns, enablePatterns }) => {
                let report = { disabled: [], enabled: [] };
                const presetFiles = config.imports?.presetFiles || [];
                for (const pf of presetFiles) {
                    for (const p of pf?.importedPreset?.prompts || []) {
                        for (const kw of (disablePatterns || [])) {
                            if ((p.name || '').includes(kw)) { p.enabled = false; report.disabled.push(p.name); break; }
                        }
                        for (const kw of (enablePatterns || [])) {
                            if ((p.name || '').includes(kw)) { p.enabled = true; report.enabled.push(p.name); break; }
                        }
                    }
                }
                if (saveConfig) saveConfig(config);
                return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
            }
        },

        range_batch_test: {
            description: '批量发送测试消息，返回所有回复。用于快速验证角色表现。',
            inputSchema: {
                type: 'object',
                properties: {
                    messages: { type: 'array', items: { type: 'string' }, description: '测试消息列表' },
                    characterName: { type: 'string', description: '角色名' }
                },
                required: ['messages']
            },
            handler: async ({ messages, characterName }) => {
                const resolvedChar = characterName || config.chat?.defaultCharacter || '';
                const charName = resolvedChar.replace(/\.png$/i, '');
                let character = null;
                try { character = characterManager.readFromPng(charName); } catch {}
                if (!character) return { content: [{ type: 'text', text: `角色 "${resolvedChar}" 未找到` }] };

                let results = [];
                for (const msg of messages.slice(0, 10)) {
                    try {
                        const built = await promptBuilder.build(
                            resolvedChar, msg, { recentMessages: [], summaries: [] }, new Set(),
                            { sessionId: `mcp_${Date.now()}`, messageType: 'group', messageCount: 1, recalledEntries: [], participants: [], injectionRisk: null, replyReference: null },
                            { character, worldBook: null, presetConfig: null }
                        );
                        const aiResult = await aiClient.chat(built.messages, {});
                        const reply = aiClient.getVisibleResponseContent(aiResult);
                        results.push({ message: msg, reply, length: reply.length });
                    } catch (e) {
                        results.push({ message: msg, error: e.message });
                    }
                }
                return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
            }
        },

        range_set_preset_prompt: {
            description: '启用/禁用预设中的指定 prompt，或修改其内容。用 name 关键词匹配。',
            inputSchema: {
                type: 'object',
                properties: {
                    namePattern: { type: 'string', description: 'prompt 名称匹配关键词，如 "少字数"、"COT"、"日式轻小说"' },
                    enabled: { type: 'boolean', description: 'true=启用, false=禁用' },
                    newContent: { type: 'string', description: '可选，替换 prompt 的 content 内容' }
                },
                required: ['namePattern']
            },
            handler: async ({ namePattern, enabled, newContent }) => {
                try {
                    let updated = [];
                    const presetFiles = config.imports?.presetFiles || [];
                    for (const pf of presetFiles) {
                        const prompts = pf?.importedPreset?.prompts || [];
                        for (const p of prompts) {
                            if ((p.name || '').includes(namePattern)) {
                                if (enabled !== undefined) p.enabled = enabled;
                                if (newContent !== undefined) p.content = newContent;
                                updated.push(p.name);
                            }
                        }
                    }
                    if (saveConfig) saveConfig(config);
                    return { content: [{ type: 'text', text: updated.length > 0 ? `已更新 ${updated.length} 个 prompt: ${updated.join(', ')}` : `未匹配到 "${namePattern}"` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `操作失败: ${e.message}` }] };
                }
            }
        },

        range_validate_worldbook: {
            description: '校验世界书格式是否符合 SillyTavern 标准，列出非标字段和潜在兼容问题',
            inputSchema: {
                type: 'object',
                properties: {
                    characterName: { type: 'string', description: '角色名（不含 .png），不填则校验当前加载的世界书' }
                }
            },
            handler: async ({ characterName }) => {
                try {
                    let wb = null;
                    let wbName = '';
                    if (characterName) {
                        wb = worldBookManager.readWorldBook(characterName);
                        wbName = characterName;
                    } else {
                        const cur = worldBookManager.getCurrentWorldBook();
                        if (cur && cur.name) {
                            wb = worldBookManager.readWorldBook(cur.name);
                            wbName = cur.name;
                        }
                    }
                    if (!wb) return { content: [{ type: 'text', text: '未找到世界书' }] };
                    const result = validateWorldbookFormat(wb, wbName);
                    const lines = [
                        `世界书: ${wbName}`,
                        `条目: ${result.entryCount}`,
                        `格式: ${result.valid ? '✔ ST兼容' : '✗ 存在问题'}`,
                        ...result.issues.map(i => `  - ${i}`)
                    ];
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `校验失败: ${e.message}` }] };
                }
            }
        },

        range_validate_preset: {
            description: '校验预设格式，检查 prompt 条目是否完整、字段是否合规',
            inputSchema: { type: 'object', properties: {} },
            handler: async () => {
                try {
                    const issues = [];
                    const pfiles = config.imports?.presetFiles || [];
                    const prompts = config.preset?.prompts || [];

                    // 检查内置预设
                    for (let i = 0; i < prompts.length; i++) {
                        const p = prompts[i];
                        if (!p.identifier && !p.name) issues.push(`内置预设#${i}: 缺少 identifier 或 name`);
                        if (p.enabled === undefined) issues.push(`内置预设#${i}: 缺少 enabled 字段`);
                    }

                    // 检查导入的预设
                    for (const pf of pfiles) {
                        const pp = pf.importedPreset?.prompts || [];
                        for (let i = 0; i < pp.length; i++) {
                            const p = pp[i];
                            if (!p.identifier && !p.name) issues.push(`${pf.filename}: prompt#${i} 缺少 identifier/name`);
                            if (typeof p.content !== 'string') issues.push(`${pf.filename}: prompt#${i}(${p.name}) content 为空或非文本`);
                            if (p.role && !['system','assistant','user'].includes(p.role)) issues.push(`${pf.filename}: prompt#${i}(${p.name}) role 无效: ${p.role}`);
                        }
                    }

                    const totalPrompts = prompts.length + pfiles.reduce((s, pf) => s + (pf.importedPreset?.prompts?.length || 0), 0);
                    const valid = issues.length === 0;
                    return { content: [{ type: 'text', text: [
                        `预设文件: ${pfiles.length} 个导入`,
                        `Prompt 总数: ${totalPrompts}`,
                        `格式: ${valid ? '✔ 正常' : '✗ 存在问题'}`,
                        ...issues.map(i => `  - ${i}`)
                    ].join('\n') }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `校验失败: ${e.message}` }] };
                }
            }
        },

        range_fix_worldbook_format: {
            description: '自动修复世界书条目的 ST 格式问题（uid→id, order→insertion_order, position数字→字符串）',
            inputSchema: {
                type: 'object',
                properties: {
                    characterName: { type: 'string', description: '角色名（不含 .png），不填则修复当前加载的世界书' }
                }
            },
            handler: async ({ characterName }) => {
                try {
                    const fs = await import('fs');
                    let wbFile = null;
                    if (characterName) {
                        const possibleNames = [
                            `data/worlds/${characterName}'s Lorebook.json`,
                            `data/worlds/${characterName}'s Lorebook.json`,
                        ];
                        for (const n of possibleNames) {
                            try { fs.readFileSync(resolve(process.cwd(), n)); wbFile = n; break; } catch {}
                        }
                    }
                    if (!wbFile) {
                        const cur = worldBookManager.getCurrentWorldBook();
                        wbFile = cur?.name ? `data/worlds/${cur.name}.json` : null;
                    }
                    if (!wbFile) return { content: [{ type: 'text', text: '未找到世界书文件' }] };

                    const content = fs.readFileSync(resolve(process.cwd(), wbFile), 'utf-8');
                    const wb = JSON.parse(content);
                    let fixed = 0;
                    for (const e of (wb.entries || [])) {
                        const before = JSON.stringify(e);
                        const fixed_e = normalizeToSTFormat(e);
                        if (JSON.stringify(fixed_e) !== before) {
                            Object.assign(e, fixed_e);
                            fixed++;
                        }
                    }
                    fs.writeFileSync(resolve(process.cwd(), wbFile), JSON.stringify(wb, null, 2), 'utf-8');
                    worldBookManager.clearCache();
                    return { content: [{ type: 'text', text: `已修复 ${fixed} 个条目 (${wbFile})` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `修复失败: ${e.message}` }] };
                }
            }
        },

        range_validate_character: {
            description: '校验角色卡格式：检查必要字段、八股词、冗余描写、ST兼容性',
            inputSchema: {
                type: 'object',
                properties: {
                    characterName: { type: 'string', description: '角色名（不含 .png）' }
                },
                required: ['characterName']
            },
            handler: async ({ characterName }) => {
                try {
                    const ch = characterManager.readFromPng(characterName);
                    const issues = [];
                    // 必要字段检查
                    if (!ch.name && !ch.data?.name) issues.push('缺少 name');
                    if (!ch.description && !ch.data?.description) issues.push('缺少 description（人设描述）');
                    if (!ch.first_mes && !ch.data?.first_mes) issues.push('缺少 first_mes（开场白）');

                    // 八股词检测
                    const cliches = ['仿佛','宛如','似乎','似是','犹如','恍若','嘴角上扬','闪过','光芒','涟漪','小兽','投石','心头一颤'];
                    const fields = {
                        description: ch.description || ch.data?.description || '',
                        personality: ch.personality || ch.data?.personality || '',
                        scenario: ch.scenario || ch.data?.scenario || '',
                        first_mes: ch.first_mes || ch.data?.first_mes || '',
                        mes_example: ch.mes_example || ch.data?.mes_example || '',
                        system_prompt: ch.system_prompt || ch.data?.system_prompt || '',
                        post_history_instructions: ch.post_history_instructions || ch.data?.post_history_instructions || ''
                    };
                    const clicheHits = {};
                    for (const [field, content] of Object.entries(fields)) {
                        const hits = cliches.filter(c => content.includes(c));
                        if (hits.length > 0) clicheHits[field] = hits;
                    }
                    const totalCliches = Object.values(clicheHits).reduce((s, a) => s + a.length, 0);

                    // HTML标签检测
                    const htmlHits = {};
                    for (const [field, content] of Object.entries(fields)) {
                        const tags = content.match(/<[^>]+>/g);
                        if (tags) htmlHits[field] = [...new Set(tags)].slice(0, 5);
                    }

                    // 统计
                    const fieldSizes = Object.entries(fields).map(([k,v]) => ({field:k, len: v.length}));

                    const lines = [
                        `角色: ${ch.name || ch.data?.name || characterName}`,
                        `字段数: ${Object.values(fields).filter(v=>v).length}/7 有内容`,
                        ...fieldSizes.filter(f=>f.len>0).map(f => `  ${f.field}: ${f.len}字`),
                        '',
                        totalCliches > 0 ? `⚠ 八股词 ${totalCliches}处:` : '✔ 无八股词',
                        ...Object.entries(clicheHits).map(([f, h]) => `  ${f}: ${h.join(', ')}`),
                        '',
                        Object.keys(htmlHits).length > 0 ? `⚠ HTML标签:` : '✔ 无HTML标签',
                        ...Object.entries(htmlHits).map(([f, h]) => `  ${f}: ${h.join(', ')}`),
                        '',
                        `内置世界书: ${ch.character_book ? '有' : '无'}`,
                        `正则脚本: ${(ch.extensions?.regex_scripts || ch.data?.extensions?.regex_scripts || []).length} 条`
                    ].filter(l => l !== '');
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `校验失败: ${e.message}` }] };
                }
            }
        },

        range_seed_test_data: {
            description: '注入假数据用于全链路测试：变量、知识库、人物档案。可指定 scopeKey 和 characterName。',
            inputSchema: {
                type: 'object',
                properties: {
                    characterName: { type: 'string', description: '角色名，默认当前角色' },
                    scopeKey: { type: 'string', description: '变量scopeKey，默认 user:test' },
                    vars: { type: 'array', description: '变量列表 [{key,value,valueType}]，不填则用默认值' },
                    knowledge: { type: 'array', description: '知识列表 [{title,content}]，不填则用默认值' },
                    profile: { type: 'object', description: '人物档案 {title,content}' }
                }
            },
            handler: async ({ characterName, scopeKey, vars, knowledge, profile }) => {
                try {
                    const charName = characterName || config.chat?.defaultCharacter || '未知';
                    const sk = scopeKey || 'user:test';
                    const results = { variables: 0, knowledge: 0, profile: 0 };

                    // 变量
                    const defaultVars = [
                        { key: '好感度', rawValue: '75', valueType: 'number' },
                        { key: '装逼值', rawValue: '888', valueType: 'number' },
                        { key: '心情', rawValue: '得意', valueType: 'string' },
                        { key: '关系状态', rawValue: '老铁', valueType: 'string' },
                        { key: '今日吹牛次数', rawValue: '12', valueType: 'number' },
                    ];
                    const seedVars = Array.isArray(vars) && vars.length > 0 ? vars : defaultVars;
                    for (const v of seedVars) {
                        const scope = { scopeType: 'user_persistent', scopeKey: sk, characterName: charName, presetName: '' };
                        sessionManager.upsertVariable(scope, {
                            key: v.key, rawValue: String(v.rawValue ?? ''), valueType: v.valueType || 'string', source: 'seed'
                        });
                        results.variables++;
                    }

                    // 知识库
                    const defaultKnowledge = [
                        { title: '用户画像', content: '测试用户，喜欢修仙话题，说话风格直接粗犷，常用网络用语。' },
                        { title: '帮派规则', content: '炸天帮帮规：1.装逼第一 2.不认怂 3.欠债不还' },
                    ];
                    const seedKnowledge = Array.isArray(knowledge) && knowledge.length > 0 ? knowledge : defaultKnowledge;
                    for (const k of seedKnowledge) {
                        const scope = { scopeType: 'user_persistent', scopeKey: sk, characterName: charName, presetName: '' };
                        sessionManager.upsertKnowledgeEntry(scope, { title: k.title, content: k.content, knowledgeType: 'fixed' });
                        results.knowledge++;
                    }

                    // 档案
                    if (profile) {
                        const scope = { scopeType: 'user_persistent', scopeKey: sk, characterName: charName, presetName: '' };
                        sessionManager.upsertParticipantProfile(scope, {
                            participantId: sk.replace('user:', ''),
                            title: profile.title || '测试用户',
                            content: profile.content || '',
                            metadata: { source: 'seed' }
                        });
                        results.profile = 1;
                    }

                    return { content: [{ type: 'text', text: [
                        `已注入假数据 (scopeKey=${sk}, 角色=${charName})`,
                        `  变量: ${results.variables} 条`,
                        `  知识: ${results.knowledge} 条`,
                        `  档案: ${results.profile} 条`,
                        '',
                        '现在可以去靶场测试全链路效果'
                    ].join('\n') }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `注入失败: ${e.message}` }] };
                }
            }
        },

        range_clear_test_data: {
            description: '清除指定 scope 的假测试数据（变量/知识/档案）',
            inputSchema: {
                type: 'object',
                properties: {
                    scopeKey: { type: 'string', description: '要清除的 scopeKey，默认 user:test' },
                    characterName: { type: 'string', description: '角色名，默认当前角色' }
                }
            },
            handler: async ({ scopeKey, characterName }) => {
                try {
                    const sk = scopeKey || 'user:test';
                    const charName = characterName || config.chat?.defaultCharacter || '';
                    const filters = { scopeType: 'user_persistent', scopeKey: sk, characterName: charName, limit: 500 };
                    let deleted = 0;

                    // 删变量
                    const vars = sessionManager.listVariables(filters);
                    for (const v of vars) { sessionManager.deleteVariable(v.id); deleted++; }

                    // 删知识
                    const knowledge = sessionManager.listKnowledgeEntries(filters);
                    for (const k of knowledge) { sessionManager.deleteKnowledgeEntry?.(k.id) || sessionManager.deleteVariable(k.id); deleted++; }

                    return { content: [{ type: 'text', text: `已清除 ${deleted} 条数据 (scopeKey=${sk}, 角色=${charName})` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `清除失败: ${e.message}` }] };
                }
            }
        },

        range_trace_output: {
            description: '分析 AI 输出内容的来源：匹配启用的预设 prompt、世界书条目，找出可能生成特定格式/内容的源头。',
            inputSchema: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: '要分析的 AI 输出文本' }
                },
                required: ['text']
            },
            handler: async ({ text, characterName }) => {
                try {
                    const findings = [];
                    const patterns = [
                        { regex: /[A-E][：:].*\n?/g, label: '行动选项(A/B/C/D/E)' },
                        { regex: /咪咪点评|喵呜|本咪/g, label: 'TGD咪咪吐槽' },
                        { regex: /平行事件/g, label: '平行事件' },
                        { regex: /时间地点|日期[：:]\s*\d{4}/g, label: '显示时间地点' },
                        { regex: /摘要|\[.*?月.*?日.*?\|/g, label: '摘要' },
                        { regex: /《end》|<\/?end>/gi, label: 'end标记' },
                        { regex: /draft_notes|<\/?thinking>/gi, label: '思维链/草稿' },
                        { regex: /<details|<summary|<\/?div[^>]*class=/gi, label: 'HTML标签' },
                        { regex: /内心独白/g, label: 'NPC内心独白' },
                        { regex: /剧情推动/g, label: '剧情推动' },
                        { regex: /\bStatusBlock\b|status_current_variable/gi, label: '变量状态块' },
                    ];
                    for (const { regex, label } of patterns) {
                        const matches = text.match(regex);
                        if (matches) findings.push({ label, count: matches.length, sample: matches.slice(0, 2).map(m => m.slice(0, 60)) });
                    }

                    // 查六个来源
                    const sources = { preset: [], worldbook: [], character: [], profile: [], knowledge: [], memory: [] };

                    // 来源1: 启用的预设
                    const pfiles = config.imports?.presetFiles || [];
                    for (const pf of pfiles) {
                        for (const p of (pf.importedPreset?.prompts || [])) {
                            if (p.enabled !== false) sources.preset.push({ source: pf.filename, name: p.name || p.identifier, content: p.content || '' });
                        }
                    }
                    for (const p of (config.preset?.prompts || [])) {
                        if (p.enabled !== false) sources.preset.push({ source: '内置预设', name: p.name || p.identifier, content: p.content || '' });
                    }

                    // 来源2: 当前角色卡
                    const charName = characterName || config.chat?.defaultCharacter || '';
                    if (charName) {
                        try {
                            const ch = characterManager.readFromPng(charName.replace(/\.png$/i, ''));
                            const cardFields = [
                                { name: 'system_prompt', content: ch.system_prompt || ch.data?.system_prompt || '' },
                                { name: 'post_history_instructions', content: ch.post_history_instructions || ch.data?.post_history_instructions || '' },
                                { name: 'description', content: ch.description || ch.data?.description || '' },
                                { name: 'personality', content: ch.personality || ch.data?.personality || '' },
                                { name: 'first_mes', content: ch.first_mes || ch.data?.first_mes || '' },
                                { name: 'mes_example', content: ch.mes_example || ch.data?.mes_example || '' },
                            ];
                            for (const f of cardFields) {
                                if (f.content) sources.character.push({ source: charName, name: f.name, content: f.content });
                            }
                        } catch {}
                    }

                    // 来源3: 当前世界书
                    try {
                        const wb = worldBookManager.getCurrentWorldBook();
                        const wbName = wb?.name || worldBookManager.currentWorldBookName;
                        if (wbName) {
                            const wbData = worldBookManager.readWorldBook(wbName);
                            for (const e of (wbData?.entries || [])) {
                                if (e.enabled !== false) sources.worldbook.push({ source: wbName, name: (e.keys || e.key || []).slice(0,3).join(',') || e.comment || 'entry', content: e.content || '' });
                            }
                        }
                    } catch {}

                    // 来源4: 人物档案
                    try {
                        const profiles = sessionManager?.listParticipantProfiles?.(20) || [];
                        for (const p of profiles) {
                            const text = [p.title, p.content, p.metadata?.summary].filter(Boolean).join('\n');
                            if (text) sources.profile.push({ source: '人物档案', name: p.title || p.participantId || '?', content: text });
                        }
                    } catch {}

                    // 来源5: 知识库
                    try {
                        const knowledge = sessionManager?.listKnowledgeEntries?.({ limit: 20 }) || [];
                        for (const k of knowledge) {
                            if (k.content) sources.knowledge.push({ source: '知识库', name: k.title || '?', content: k.content });
                        }
                    } catch {}

                    // 来源6: 会话摘要/记忆
                    try {
                        const summaries = sessionManager?.listRecentSummaryIndexEntries?.({ scopeType: 'global_shared', scopeKey: 'global_shared_memory' }, 5) || [];
                        for (const s of summaries) {
                            if (s.outline) sources.memory.push({ source: '会话摘要', name: s.id?.slice(0,8) || '?', content: s.outline });
                        }
                    } catch {}

                    // 匹配：每个finding对应哪个source
                    const traces = [];
                    for (const f of findings) {
                        const matchedSources = new Set();
                        for (const cat of ['preset', 'character', 'worldbook', 'profile', 'knowledge', 'memory']) {
                            for (const s of sources[cat]) {
                                if (s.content && f.sample.some(sample => s.content.includes(sample.slice(0, 30)) || sample.slice(0, 30).includes(s.content.slice(0, 30)))) {
                                    matchedSources.add(`[${cat}] ${s.name} (${s.source})`);
                                }
                            }
                        }
                        traces.push({ finding: f.label, count: f.count, sources: [...matchedSources] });
                    }

                    const lines = findings.length === 0
                        ? ['未检测到已知格式化模式']
                        : [
                            `=== 来源追踪 (${findings.length} 类) ===`,
                            ...traces.map(t => {
                                const srcStr = t.sources.length > 0 ? t.sources.join(' | ') : '未定位到具体来源';
                                return `  ${t.finding} (${t.count}处) ← ${srcStr}`;
                            }),
                            '',
                            `来源统计: 预设${sources.preset.length} | 角色卡${sources.character.length} | 世界书${sources.worldbook.length} | 档案${sources.profile?.length||0} | 知识${sources.knowledge?.length||0} | 记忆${sources.memory?.length||0}`
                        ];
                    return { content: [{ type: 'text', text: lines.join('\n') }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `分析失败: ${e.message}` }] };
                }
            }
        }
    };

    // JSON-RPC handler
    const serverInfo = { name: 'mimirlink-range', version: '1.0.0' };
    const toolList = Object.entries(tools).map(([name, t]) => ({
        name, description: t.description, inputSchema: t.inputSchema
    }));

    return async function mcpHandler(req, res) {
        const sessionId = req.headers['mcp-session-id'];

        try {
            // Parse body
            let body = req.body;
            if (!body || typeof body !== 'object') {
                return res.status(400).json(jsonRpcError(null, -32700, 'Parse error'));
            }

            const { method, params, id } = body;
            if (!method) {
                return res.status(400).json(jsonRpcError(id, -32600, 'Invalid Request'));
            }

            logger.info(`[MCP] ${method} id=${id}`);

            switch (method) {
                case 'initialize':
                    res.setHeader('Mcp-Session-Id', `mcp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
                    return res.json(jsonRpcResult(id, {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo
                    }));

                case 'initialized':
                    return res.json(jsonRpcResult(id, {}));

                case 'tools/list':
                    return res.json(jsonRpcResult(id, { tools: toolList }));

                case 'tools/call': {
                    const { name, arguments: args } = params || {};
                    const tool = tools[name];
                    if (!tool) {
                        return res.json(jsonRpcError(id, -32601, `Tool not found: ${name}`));
                    }
                    try {
                        const result = await tool.handler(args || {});
                        return res.json(jsonRpcResult(id, result));
                    } catch (e) {
                        return res.json(jsonRpcError(id, -32000, e.message));
                    }
                }

                case 'ping':
                    return res.json(jsonRpcResult(id, {}));

                default:
                    return res.json(jsonRpcError(id, -32601, `Method not found: ${method}`));
            }
        } catch (e) {
            logger.error(`[MCP] 未捕获错误:`, e.message);
            if (!res.headersSent) {
                return res.status(500).json(jsonRpcError(null, -32603, 'Internal error'));
            }
        }
    };
}

function jsonRpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
