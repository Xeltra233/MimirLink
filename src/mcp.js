import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createMCPHandler(managers, config, saveConfig) {
    const { aiClient, promptBuilder, characterManager, worldBookManager, logger } = managers;

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
