/**
 * AI 工具层
 * - 工具定义（web_search / web_fetch / get_weather / convert_currency / send_group_mention / MCP 工具）
 * - 工具上下文构建（原生 tool_calls）
 * - @ 成员与语音文案辅助
 *
 * 搜索实现位于 ./search/（移植 DDGS + duck-duck-scrape + Mozilla Readability）。
 * 工具是否调用由模型自行决定，这里不做任何预搜索注入或程序直答。
 */

import { buildMentionMessage } from './onebot.js';
import {
    runSearch,
    fetchPageContent,
    fetchWeather,
    fetchCurrency,
    normalizeWebSearchConfig,
    listSearchProviders
} from './search/index.js';

function sanitizeText(value) {
    return String(value || '').replace(/\r/g, '').trim();
}

function toComparableId(value) {
    return value === undefined || value === null ? '' : String(value).trim();
}

function toPositiveInteger(value, fallback) {
    const normalized = Number(value);
    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.floor(normalized);
}

function clampInteger(value, minimum, maximum, fallback) {
    const normalized = toPositiveInteger(value, fallback);
    return Math.min(maximum, Math.max(minimum, normalized));
}

function truncateText(value, maxLength) {
    const text = sanitizeText(value);
    if (!text) {
        return '';
    }

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeText(value, maxLength = 120) {
    const text = sanitizeText(value);
    return {
        length: text.length,
        preview: truncateText(text, maxLength)
    };
}

export function buildVoicePrefaceText(value) {
    const text = sanitizeText(value);
    if (!text) {
        return '我给你发了一条语音，请听一下。';
    }

    const preview = truncateText(text, 40);
    return `我给你发了一条语音：${preview}`;
}

// ==================== @ 成员 ====================

function buildMentionTaskPrompt({ groupId, targetUserId, targetName, promptText }) {
    const normalizedTargetName = sanitizeText(targetName) || `QQ ${targetUserId}`;
    return [
        '当前任务不是继续普通对话，而是由管理员要求你主动对一位群成员说一句话。',
        `目标群号: ${groupId}`,
        `目标成员: ${normalizedTargetName} (${targetUserId})`,
        `管理员要求: ${promptText}`,
        '请严格遵守以下要求：',
        '1. 必须保持当前角色卡、世界书、设定与语气，不要退化成通用助手口吻。',
        '2. 管理员提供的是意图，不要机械复述，也不要自称代管理员转述。',
        '3. 最终输出必须是准备直接发送给该成员的一条中文群聊消息正文。',
        '4. 不要包含 @ 前缀、引号、解释、规则说明或思维过程。',
        '5. 内容自然、简短、贴合群聊场景，避免写成长篇角色扮演。'
    ].join('\n');
}

function appendMentionTaskToMessages(messages, mentionTaskPrompt) {
    const normalizedMessages = Array.isArray(messages)
        ? messages.map((message) => ({ ...message }))
        : [];

    if (normalizedMessages.length === 0) {
        return [{ role: 'user', content: mentionTaskPrompt }];
    }

    const lastMessage = normalizedMessages.at(-1);
    if (lastMessage?.role === 'user' && typeof lastMessage.content === 'string') {
        normalizedMessages[normalizedMessages.length - 1] = {
            ...lastMessage,
            content: `${lastMessage.content}\n\n${mentionTaskPrompt}`
        };
        return normalizedMessages;
    }

    normalizedMessages.push({ role: 'user', content: mentionTaskPrompt });
    return normalizedMessages;
}

export function appendMentionTaskToPromptMessages({ messages, groupId, targetUserId, targetName, promptText }) {
    return appendMentionTaskToMessages(messages, buildMentionTaskPrompt({
        groupId,
        targetUserId,
        targetName,
        promptText
    }));
}

function buildMentionGenerationMessages({ groupId, targetUserId, targetName, promptText }) {
    return [
        {
            role: 'system',
            content: '你是 QQ 群里的聊天助手。现在需要主动 @ 一位群成员并发送一段消息。请直接输出准备发送给该成员的最终中文内容，不要解释你的思路，不要加引号，不要包含 @ 前缀，不要自称是管理员转述。内容应自然、简短、适合群聊场景。'
        },
        {
            role: 'user',
            content: `群号: ${groupId}\n目标成员: ${targetName || `QQ ${targetUserId}`} (${targetUserId})\n要求: ${promptText}\n\n请生成一段适合直接发送给该成员的群聊消息正文。`
        }
    ];
}

export async function generateMentionTextFromPrompt({ aiClient, groupId, targetUserId, targetName, promptText, buildPromptMessages = null, aiOptions = undefined }) {
    const normalizedGroupId = toComparableId(groupId);
    const normalizedTargetUserId = toComparableId(targetUserId);
    const normalizedPromptText = sanitizeText(promptText);
    const startedAt = Date.now();

    if (!normalizedGroupId) {
        throw new Error('群号不能为空');
    }
    if (!normalizedTargetUserId || normalizedTargetUserId === 'all') {
        throw new Error('目标成员不能为空，且不能是 @all');
    }
    if (!normalizedPromptText) {
        throw new Error('消息要求不能为空');
    }

    let messages = null;
    if (typeof buildPromptMessages === 'function') {
        const builtMessages = await buildPromptMessages({
            groupId: normalizedGroupId,
            targetUserId: normalizedTargetUserId,
            targetName,
            promptText: normalizedPromptText
        });
        if (Array.isArray(builtMessages) && builtMessages.length > 0) {
            messages = builtMessages;
        }
    }

    const finalMessages = messages || buildMentionGenerationMessages({
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        targetName,
        promptText: normalizedPromptText
    });

    const responseResult = await aiClient.chat(finalMessages, aiOptions);
    const response = aiClient.getVisibleResponseContent(responseResult);

    const messageText = sanitizeText(response);
    if (!messageText) {
        throw new Error('AI 未生成可发送内容');
    }

    return {
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        usedPromptBuilder: !!messages,
        prompt: summarizeText(normalizedPromptText),
        finalMessageCount: finalMessages.length,
        generatedMessage: messageText,
        durationMs: Date.now() - startedAt
    };
}

export async function sendGroupMentionFromPrompt({ aiClient, bot, groupId, targetUserId, targetName, promptText, buildPromptMessages = null, aiOptions = undefined, outputProcessor = null }) {
    const normalizedGroupId = toComparableId(groupId);
    const normalizedTargetUserId = toComparableId(targetUserId);
    if (!normalizedGroupId) {
        throw new Error('群号不能为空');
    }
    if (!normalizedTargetUserId || normalizedTargetUserId === 'all') {
        throw new Error('目标成员不能为空，且不能是 @all');
    }

    const generated = await generateMentionTextFromPrompt({
        aiClient,
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        targetName,
        promptText,
        buildPromptMessages,
        aiOptions
    });

    const generatedMessage = typeof outputProcessor === 'function'
        ? sanitizeText(outputProcessor(generated.generatedMessage))
        : generated.generatedMessage;

    if (!generatedMessage) {
        throw new Error('AI generated empty mention message after output processing');
    }

    await bot.sendGroupMessage(normalizedGroupId, buildMentionMessage(normalizedTargetUserId, generatedMessage));

    return {
        groupId: normalizedGroupId,
        targetUserId: normalizedTargetUserId,
        generatedMessage,
        prompt: generated.prompt,
        usedPromptBuilder: generated.usedPromptBuilder,
        finalMessageCount: generated.finalMessageCount,
        durationMs: generated.durationMs
    };
}

// ==================== 工具定义 ====================

function buildSearchToolDefinition(webSearchConfig) {
    const providerLabels = listSearchProviders().map((provider) => provider.label).join(' / ');
    return {
        type: 'function',
        function: {
            name: 'web_search',
            description: `搜索公开网页或新闻，返回标题、链接和摘要。适合查询最新信息、新闻、外部事实或需要资料核验的问题。可用 provider：${providerLabels}。`,
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '要搜索的关键词或问题。'
                    },
                    limit: {
                        type: 'integer',
                        description: '期望返回的结果条数（1-10）。'
                    },
                    topic: {
                        type: 'string',
                        enum: ['web', 'news'],
                        description: 'web=网页搜索（默认）；news=新闻搜索。'
                    },
                    timeRange: {
                        type: 'string',
                        enum: ['day', 'week', 'month', 'year'],
                        description: '限制结果时间范围，可选。'
                    },
                    site: {
                        type: 'string',
                        description: '限定站点域名，例如 github.com，可选。'
                    }
                },
                required: ['query']
            }
        }
    };
}

function buildFetchToolDefinition(webSearchConfig) {
    return {
        type: 'function',
        function: {
            name: 'web_fetch',
            description: '打开一个公开网页并提取正文内容，适合在搜索结果基础上深入阅读。只支持 http/https 公开地址。',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: '要读取的网页地址。'
                    },
                    maxChars: {
                        type: 'integer',
                        description: '正文最大字符数（默认使用服务端配置）。'
                    }
                },
                required: ['url']
            }
        }
    };
}

function buildWeatherToolDefinition() {
    return {
        type: 'function',
        function: {
            name: 'get_weather',
            description: '查询指定城市/地点的当前天气与未来几天预报（气温、体感、湿度、风速、降水概率）。',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: '明确的地点名称，例如「北京」「上海」「Tokyo」。'
                    },
                    days: {
                        type: 'integer',
                        description: '预报天数（1-7，默认 3）。'
                    }
                },
                required: ['location']
            }
        }
    };
}

function buildCurrencyToolDefinition() {
    return {
        type: 'function',
        function: {
            name: 'convert_currency',
            description: '按实时中间价换算货币，例如 USD→CNY。',
            parameters: {
                type: 'object',
                properties: {
                    from: {
                        type: 'string',
                        description: '源货币代码，例如 USD。'
                    },
                    to: {
                        type: 'string',
                        description: '目标货币代码，例如 CNY。'
                    },
                    amount: {
                        type: 'number',
                        description: '换算金额，默认 1。'
                    }
                },
                required: ['from', 'to']
            }
        }
    };
}

export function buildAIToolDefinitions(config = {}, options = {}) {
    const webSearchConfig = normalizeWebSearchConfig(config.ai?.tools?.webSearch || {});
    const sendMentionConfig = config.ai?.tools?.sendMention || {};
    const allowSendMention = options.allowSendMention !== false;
    const tools = [];

    if (webSearchConfig.enabled) {
        tools.push(buildSearchToolDefinition(webSearchConfig));
        if (webSearchConfig.fetch.enabled) {
            tools.push(buildFetchToolDefinition(webSearchConfig));
        }
        if (webSearchConfig.spice.enabled) {
            tools.push(buildWeatherToolDefinition());
            tools.push(buildCurrencyToolDefinition());
        }
    }

    if (sendMentionConfig.enabled && allowSendMention) {
        tools.push({
            type: 'function',
            function: {
                name: 'send_group_mention',
                description: '在群聊中主动 @ 某位成员并发送消息。入参里的 prompt 是要求，最终发送正文会由 AI 再生成后发出。禁止 @all。',
                parameters: {
                    type: 'object',
                    properties: {
                        groupId: {
                            type: 'string',
                            description: '目标群号；若当前已在群上下文中可省略。'
                        },
                        targetUserId: {
                            type: 'string',
                            description: '要 @ 的 QQ 号；若希望 @ 当前发言人且上下文明确可省略。'
                        },
                        prompt: {
                            type: 'string',
                            description: '希望发给对方的要求或意图，最终正文会由 AI 生成。'
                        }
                    },
                    required: ['prompt']
                }
            }
        });
    }

    return tools;
}

/** 通用总则：与具体功能无关，所有工具共用 */
export function buildToolHintRules() {
    return [
        '【工具使用总则】',
        '- 本次请求下发的工具定义是你唯一可调用的组件清单；不要调用未下发的工具名，也不要声称调用过。',
        '- 用户明确要求执行某个动作或使用某个能力时，必须真的调用对应工具，不能用文字假装完成。',
        '- 调用工具不受角色人设限制：语气可以保持人设，但不能以“我不会 / 角色做不到”为由拒绝调用。',
        '- 工具失败、超时或无结果时如实说明，不要编造结果，也不要假装成功。',
        '- 不要泄露工具名、JSON、参数，也不要说“我准备调用工具”这类过程话术。',
        '- 工具结果只作为依据，最终回复用自然语言总结。',
        '- 同一目标不要重复完全相同的调用；连续空转不超过 3 轮。'
    ].join('\n');
}

/** 联网检索段：仅在启用联网工具时生成，随配置变化 */
export function buildWebToolHint(config = {}) {
    const webSearchConfig = normalizeWebSearchConfig(config.ai?.tools?.webSearch || {});
    if (!webSearchConfig.enabled) {
        return '';
    }

    const available = ['web_search'];
    if (webSearchConfig.fetch.enabled) {
        available.push('web_fetch');
    }
    if (webSearchConfig.spice.enabled) {
        available.push('get_weather', 'convert_currency');
    }

    const lines = [
        '【功能：联网检索】',
        `可用组件：${available.join('、')}。`
    ];
    if (webSearchConfig.fetch.enabled || webSearchConfig.spice.enabled) {
        lines.push(`必须调用、不得凭记忆或猜测作答的情形：用户明确要求 搜/查/查证/给链接/给来源/给出处/最新情况/是不是真的；涉及新闻、价格、政策、版本、赛事、天气、汇率、人物动态等实时或可能变化的信息；需要外部事实核验（链接、项目、库、资料、图片来源）。`);
    }
    lines.push(
        `- web_search：参数 query（必填）、topic=web|news（新闻用 news）、timeRange=day|week|month|year、site=限定站点、limit=条数（默认 ${webSearchConfig.maxResults}）。`,
        `- 图片出处：先读图中文字或可检索特征，再用 web_search 检索；图中没有可检索信息时直接说“我无法反查图片出处”，不要编 URL，也不要编造“全网都找不到”。`
    );
    if (webSearchConfig.fetch.enabled) {
        lines.push('- web_fetch：参数 url、maxChars；只在需要页面正文细节（确认出处、核对规格）时使用，不要对每条结果都抓取。');
    }
    if (webSearchConfig.spice.enabled) {
        lines.push('- get_weather：仅在用户明确问天气且能给出地点时使用；参数 location、days（默认 ' + (webSearchConfig.spice?.weatherDays ?? 3) + '）。');
        lines.push('- convert_currency：仅在需要汇率或金额换算时使用；参数 from、to、amount。');
    }
    lines.push(
        '- 检索无结果或失败时，简短说明这次没查到，不要编造链接或依据。',
        `- 限制：默认最多 ${webSearchConfig.maxResults} 条结果，单次搜索超时 ${webSearchConfig.timeoutMs}ms，单条摘要最长 ${webSearchConfig.maxSnippetLength} 字。`
    );
    return lines.join('\n');
}

/** 主动 @ 段：仅在启用主动 @ 工具时生成 */
export function buildMentionToolHint(config = {}) {
    const sendMentionConfig = config.ai?.tools?.sendMention || {};
    if (sendMentionConfig.enabled !== true) {
        return '';
    }
    return [
        '【功能：主动 @ 群成员】',
        '可用组件：send_group_mention。',
        '- 使用时机：用户要求你转告、提醒、通知、叫某人，或明确让你 @ 某人；自己发起闲聊式 @ 不在范围内。',
        '- 参数：prompt（必填，写清要传达的要求或意图，最终正文由你按角色风格生成）、targetUserId（要 @ 的 QQ 号，上下文明确可省略）、groupId（当前群可省略）。',
        '- 硬限制：禁止 @all；仅群聊可用；同一轮不要重复 @ 同一个人。',
        '- 发送失败或权限不足时如实说明，不要假装已经通知到。'
    ].join('\n');
}

/** 外部 MCP 段：清单由已连接服务器的工具定义自动生成 */
export function buildMcpToolHint(definitions = []) {
    if (!Array.isArray(definitions) || definitions.length === 0) {
        return '';
    }
    const byServer = new Map();
    for (const item of definitions) {
        const serverName = String(item?.serverName || 'mcp');
        if (!byServer.has(serverName)) {
            byServer.set(serverName, []);
        }
        byServer.get(serverName).push(String(item?.toolName || item?.name || ''));
    }
    const lines = [
        '【功能：外部 MCP 工具】',
        `已连接服务器（共 ${definitions.length} 个工具，名称以 mcp__ 开头）：`
    ];
    for (const [serverName, toolNames] of byServer.entries()) {
        lines.push(`- ${serverName}（${toolNames.length}）：${toolNames.filter(Boolean).join('、')}`);
    }
    lines.push(
        '- 使用时机：用户明确需要这些能力（文件、数据库、浏览器、外部服务等）时调用；不确定时先说明你的能力范围。',
        '- 只能调用上面列出的工具名；调用失败、超时或被拒绝时如实说明，不要编造结果或假装成功。',
        '- 参数按工具定义传，不要臆造参数名。'
    );
    return lines.join('\n');
}

function buildToolHints(config = {}) {
    return [buildWebToolHint(config), buildMentionToolHint(config)].filter(Boolean);
}

// 消息头解析：与 buildStructuredMessage 的头部格式一致（群聊/私聊|QQ|昵称|群号|群名）
const TOOL_PHASE_HEADER_PATTERN = /\[(群聊|私聊)\|QQ:([^|\]]*)\|昵称:([^|\]]*)\|群号:([^|\]]*)\|群名:([^|\]]*)/;

// 取单条消息的纯文本（兼容多模态分段）
function toolPhaseMessageText(message) {
    const content = message?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => (typeof part === 'string' ? part : (part?.text || '')))
            .filter(Boolean)
            .join('\n');
    }
    return '';
}

/**
 * 两阶段链路：构造工具阶段的轻量场景卡。
 * 只从现有消息头提取角色名/会话/发言人/近期发言人名单，解决“只给聊天记录不给背景”导致的指代与 @ 找人发懵；
 * 不加载人设、世界书、记忆正文，保持工具阶段轻量。
 */
export function buildToolPhaseScene(fullMessages, characterName = '', maxParticipants = 10) {
    const order = [];
    const names = new Map();
    const groupNames = new Map();
    let sessionLabel = '';
    let currentSpeaker = '';
    let lastGroupId = '';
    for (const message of Array.isArray(fullMessages) ? fullMessages : []) {
        const match = toolPhaseMessageText(message).match(TOOL_PHASE_HEADER_PATTERN);
        if (!match) {
            continue;
        }
        const [, chatLabel, qq, nickname, groupId, groupName] = match;
        if (!qq) {
            continue;
        }
        const existing = order.indexOf(qq);
        if (existing >= 0) {
            order.splice(existing, 1);
        }
        order.push(qq);
        names.set(qq, nickname || `QQ ${qq}`);
        if (chatLabel === '群聊' && groupId && groupId !== 'N/A') {
            lastGroupId = groupId;
            // 当前事件头可能没有群名（群名:N/A），优先保留历史里出现过的真名
            if (groupName && groupName !== 'N/A') {
                groupNames.set(groupId, groupName);
            }
        } else if (chatLabel === '私聊') {
            sessionLabel = `私聊 QQ:${qq}`;
        }
        if (message.role === 'user') {
            currentSpeaker = `${nickname || `QQ ${qq}`}(${qq})`;
        }
    }
    if (lastGroupId) {
        sessionLabel = `群聊「${groupNames.get(lastGroupId) || `群 ${lastGroupId}`}」(${lastGroupId})`;
    }

    const lines = ['【当前场景】'];
    if (characterName) {
        lines.push(`- 你正在以角色「${characterName}」参与这次对话；本次只做工具决策，不需要扮演或输出人设内容。`);
    }
    if (sessionLabel) {
        lines.push(`- 当前会话: ${sessionLabel}`);
    }
    if (currentSpeaker) {
        lines.push(`- 当前发言人: ${currentSpeaker}`);
    }
    const recent = order.slice(-Math.max(1, maxParticipants)).map((qq) => `${names.get(qq)}(${qq})`);
    if (recent.length >= 2) {
        lines.push(`- 近期发言人: ${recent.join('、')}`);
    }
    if (lines.length === 1) {
        return '';
    }
    return lines.join('\n');
}

/**
 * 两阶段链路：构造工具阶段消息。
 * 保留轻量场景卡 + 功能内置提示词（工具说明）与轻量对话上下文，
 * 不带人设/预设/世界书/记忆等重提示词，也不带 assistant 预填充。
 */
export function buildToolPhaseMessages(fullMessages, toolHints, options = {}) {
    const messages = [];
    const scene = buildToolPhaseScene(fullMessages, options.characterName || '');
    if (scene) {
        messages.push({ role: 'system', content: scene, meta: { source: 'tool_scene' } });
    }
    if (Array.isArray(toolHints) && toolHints.length > 0) {
        messages.push({
            role: 'system',
            content: `【工具使用说明】\n${toolHints.join('\n\n')}`,
            meta: { source: 'tool_hints' }
        });
    }
    for (const message of Array.isArray(fullMessages) ? fullMessages : []) {
        if (!message || message.role === 'system') {
            continue;
        }
        // 预填充只服务于正式回复的语气与格式
        if (message.meta?.source === 'assistant_prefill') {
            continue;
        }
        messages.push({ ...message });
    }
    return messages;
}

/** 两阶段链路：把工具阶段的结果整理成注入正式回复阶段的系统段 */
export function buildToolPhaseResultMessage(transcript = [], options = {}) {
    const entries = Array.isArray(transcript) ? transcript.filter((entry) => entry && entry.name) : [];
    if (entries.length === 0) {
        return '';
    }

    const maxChars = clampInteger(options.maxChars, 200, 50000, 4000);
    const lines = [
        '【本轮工具执行结果】',
        '这些是刚刚真实执行工具得到的最新结果，回复时以它们为准；不要编造工具没有返回的信息。'
    ];
    entries.forEach((entry, index) => {
        const status = entry.ok === false ? '失败' : '完成';
        lines.push(`${index + 1}. ${sanitizeText(entry.name)}｜参数: ${summarizeToolArguments(entry.arguments)}｜状态: ${status}`);
        const resultText = stringifyToolResult(entry.result);
        if (resultText) {
            lines.push(truncateText(resultText, maxChars));
        }
    });
    return lines.join('\n');
}

/** 工具参数摘要：只保留键值预览，避免把长参数原样带进正式回复 */
function summarizeToolArguments(args = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
        const text = sanitizeText(args);
        return text ? truncateText(text, 160) : '无';
    }
    const parts = [];
    for (const [key, value] of Object.entries(args)) {
        const valueText = typeof value === 'string' ? value : JSON.stringify(value);
        parts.push(`${key}=${truncateText(sanitizeText(valueText), 80)}`);
    }
    return parts.length > 0 ? truncateText(parts.join(', '), 200) : '无';
}

/** 工具结果序列化：字符串直出，其余序列化后交给截断处理 */
function stringifyToolResult(result) {
    if (result === undefined || result === null) {
        return '';
    }
    if (typeof result === 'string') {
        return sanitizeText(result);
    }
    try {
        return JSON.stringify(result, null, 1);
    } catch {
        return sanitizeText(String(result));
    }
}

// ==================== 工具上下文 ====================

/** MCP 搜索兜底：本地 provider 全挂时，自动改用一个 MCP 搜索引擎工具（可配置关闭/指定服务器） */
const MCP_SEARCH_TOOL_PREFERENCE = ['search', 'fast_search', 'any_search', 'mega_search'];

function pickMcpSearchCandidates(definitions = [], target = 'auto') {
    const wanted = String(target || 'auto').trim();
    return definitions
        .filter((item) => {
            if (wanted === 'off') return false;
            if (wanted !== 'auto' && wanted !== '1') {
                const matchesServer = String(item?.serverName || '') === wanted || String(item?.serverId || '') === wanted;
                if (!matchesServer) return false;
            }
            return /search/i.test(String(item?.toolName || item?.name || ''));
        })
        .sort((left, right) => {
            const rank = (item) => {
                const index = MCP_SEARCH_TOOL_PREFERENCE.indexOf(String(item?.toolName || ''));
                return index >= 0 ? index : MCP_SEARCH_TOOL_PREFERENCE.length;
            };
            return rank(left) - rank(right);
        });
}

async function tryMcpSearchFallback({ query, target, mcpClient, logger, maxChars = 4000 }) {
    if (!mcpClient || typeof mcpClient.getToolDefinitions !== 'function' || typeof mcpClient.callTool !== 'function') {
        return null;
    }
    const candidates = pickMcpSearchCandidates(mcpClient.getToolDefinitions(), target).slice(0, 2);
    for (const candidate of candidates) {
        const startedAt = Date.now();
        try {
            logger?.info?.('[工具] web_search 本地链路失败，改用 MCP 搜索兜底', {
                server: candidate.serverName,
                tool: candidate.toolName,
                query: summarizeText(query)
            });
            const result = await mcpClient.callTool({
                serverId: candidate.serverId,
                tool: candidate.toolName,
                arguments: { text: query }
            });
            if (result?.ok) {
                const text = String(result.text || '').slice(0, maxChars);
                logger?.info?.('[工具] MCP 搜索兜底成功', {
                    server: candidate.serverName,
                    tool: candidate.toolName,
                    durationMs: Date.now() - startedAt,
                    chars: text.length
                });
                return {
                    ok: true,
                    provider: 'mcp',
                    source: `mcp:${candidate.serverName}:${candidate.toolName}`,
                    query,
                    resultCount: 0,
                    results: [],
                    text,
                    note: '本地搜索链路失败，以下为 MCP 搜索工具返回的原始文本'
                };
            }
            logger?.warn?.('[工具] MCP 搜索兜底失败', {
                server: candidate.serverName,
                tool: candidate.toolName,
                durationMs: Date.now() - startedAt,
                error: result?.error || '未知错误'
            });
        } catch (error) {
            logger?.warn?.('[工具] MCP 搜索兜底异常', {
                server: candidate.serverName,
                tool: candidate.toolName,
                error: error?.message || String(error)
            });
        }
    }
    return null;
}

export function buildAIToolContext({
    config = {},
    aiClient,
    bot,
    logger,
    defaultGroupId = null,
    defaultTargetUserId = null,
    defaultTargetName = null,
    allowSendMention = true,
    mentionGenerator = null,
    mentionOutputProcessor = null,
    mcpClient = null
} = {}) {
    const webSearchConfig = normalizeWebSearchConfig(config.ai?.tools?.webSearch || {});
    const tools = buildAIToolDefinitions(config, { allowSendMention });
    const toolHints = buildToolHints(config);
    const handlers = {};

    function buildSearchRunConfig() {
        return { ai: { tools: { webSearch: config.ai?.tools?.webSearch || {} } } };
    }

    if (webSearchConfig.enabled) {
        handlers.web_search = async (argumentsPayload = {}) => {
            const query = sanitizeText(argumentsPayload.query);
            if (!query) {
                return { ok: false, error: '搜索词不能为空', query: '', results: [] };
            }
            const limit = argumentsPayload.limit ? clampInteger(argumentsPayload.limit, 1, 10, webSearchConfig.maxResults) : null;
            const topic = String(argumentsPayload.topic || 'web').toLowerCase() === 'news' ? 'news' : 'web';
            const timeRange = sanitizeText(argumentsPayload.timeRange);
            const site = sanitizeText(argumentsPayload.site);
            const startedAt = Date.now();

            try {
                logger?.info?.('[工具] 执行 web_search', {
                    provider: webSearchConfig.provider,
                    topic,
                    query: summarizeText(query),
                    limit,
                    timeRange: timeRange || null,
                    site: site || null
                });
                const result = await runSearch({
                    config: buildSearchRunConfig(),
                    query,
                    limit,
                    topic,
                    timeRange,
                    site,
                    logger
                });
                logger?.info?.('[工具] web_search 完成', {
                    query: summarizeText(query),
                    provider: result.provider,
                    source: result.source,
                    resultCount: result.resultCount,
                    durationMs: Date.now() - startedAt,
                    results: result.results.map((item) => ({ title: item.title, url: item.url }))
                });
                return {
                    ok: true,
                    provider: result.provider,
                    source: result.source,
                    query: result.query,
                    topic: result.topic,
                    resultCount: result.resultCount,
                    results: result.results,
                    attempts: result.attempts
                };
            } catch (error) {
                logger?.warn?.('[工具] web_search 失败', {
                    query: summarizeText(query),
                    provider: webSearchConfig.provider,
                    durationMs: Date.now() - startedAt,
                    error: error.message,
                    attempts: error.attempts || []
                });
                // 本地 provider 全挂时，按配置改用 MCP 搜索工具兜底
                const mcpFallbackResult = await tryMcpSearchFallback({
                    query,
                    target: webSearchConfig.mcpFallback,
                    mcpClient,
                    logger,
                    maxChars: webSearchConfig.mcpFallbackMaxChars
                });
                if (mcpFallbackResult) {
                    return { ...mcpFallbackResult, attempts: error.attempts || [] };
                }
                return {
                    ok: false,
                    error: error.code === 'SEARCH_EMPTY' ? '未找到合适的搜索结果' : `搜索失败: ${error.message}`,
                    query,
                    attempts: error.attempts || [],
                    results: []
                };
            }
        };

        if (webSearchConfig.fetch.enabled) {
            handlers.web_fetch = async (argumentsPayload = {}) => {
                const url = sanitizeText(argumentsPayload.url);
                if (!url) {
                    return { ok: false, error: 'URL 不能为空' };
                }
                const maxChars = argumentsPayload.maxChars
                    ? clampInteger(argumentsPayload.maxChars, 500, 50000, webSearchConfig.fetch.maxChars)
                    : webSearchConfig.fetch.maxChars;
                const startedAt = Date.now();
                try {
                    logger?.info?.('[工具] 执行 web_fetch', { url: url.slice(0, 200), maxChars });
                    const result = await fetchPageContent({
                        url,
                        maxChars,
                        timeoutMs: webSearchConfig.fetch.timeoutMs,
                        logger
                    });
                    logger?.info?.('[工具] web_fetch 完成', {
                        url: result.url.slice(0, 200),
                        quality: result.quality,
                        chars: result.chars,
                        durationMs: Date.now() - startedAt
                    });
                    return result;
                } catch (error) {
                    logger?.warn?.('[工具] web_fetch 失败', { url: url.slice(0, 200), error: error.message });
                    return { ok: false, error: `读取页面失败: ${error.message}` };
                }
            };
        }

        if (webSearchConfig.spice.enabled) {
            handlers.get_weather = async (argumentsPayload = {}) => {
                const location = sanitizeText(argumentsPayload.location);
                if (!location) {
                    return { ok: false, error: '地点不能为空' };
                }
                const days = clampInteger(argumentsPayload.days, 1, 7, webSearchConfig.spice.weatherDays);
                try {
                    logger?.info?.('[工具] 执行 get_weather', { location: location.slice(0, 60), days });
                    const result = await fetchWeather({ location, days, locale: webSearchConfig.locale, timeoutMs: webSearchConfig.timeoutMs });
                    logger?.info?.('[工具] get_weather 完成', {
                        location: result.location || location,
                        ok: result.ok
                    });
                    return result;
                } catch (error) {
                    logger?.warn?.('[工具] get_weather 失败', { location: location.slice(0, 60), error: error.message });
                    return { ok: false, error: `天气查询失败: ${error.message}` };
                }
            };

            handlers.convert_currency = async (argumentsPayload = {}) => {
                const from = sanitizeText(argumentsPayload.from);
                const to = sanitizeText(argumentsPayload.to);
                const amount = Number.isFinite(Number(argumentsPayload.amount)) && Number(argumentsPayload.amount) > 0
                    ? Number(argumentsPayload.amount)
                    : 1;
                if (!from || !to) {
                    return { ok: false, error: '需要提供 from 和 to 两个货币代码' };
                }
                try {
                    logger?.info?.('[工具] 执行 convert_currency', { from, to, amount });
                    const result = await fetchCurrency({ from, to, amount, timeoutMs: webSearchConfig.timeoutMs });
                    logger?.info?.('[工具] convert_currency 完成', { from, to, amount, ok: result.ok });
                    return result;
                } catch (error) {
                    logger?.warn?.('[工具] convert_currency 失败', { from, to, error: error.message });
                    return { ok: false, error: `汇率查询失败: ${error.message}` };
                }
            };
        }
    }

    if (config.ai?.tools?.sendMention?.enabled && allowSendMention) {
        handlers.send_group_mention = async (argumentsPayload = {}) => {
            const groupId = toComparableId(argumentsPayload.groupId) || toComparableId(defaultGroupId);
            const targetUserId = toComparableId(argumentsPayload.targetUserId) || toComparableId(defaultTargetUserId);
            const prompt = sanitizeText(argumentsPayload.prompt);
            const startedAt = Date.now();

            if (!groupId) {
                return { ok: false, error: '缺少群号，无法主动 @', groupId: '', targetUserId: targetUserId || '' };
            }
            if (!targetUserId || targetUserId === 'all') {
                return { ok: false, error: '目标成员不能为空，且不能是 @all', groupId, targetUserId: targetUserId || '' };
            }
            if (!prompt) {
                return { ok: false, error: '主动 @ 的要求不能为空', groupId, targetUserId };
            }

            logger?.info?.('[工具] 开始执行 send_group_mention', {
                groupId,
                targetUserId,
                targetName: defaultTargetName || '',
                prompt: summarizeText(prompt)
            });

            try {
                const sent = mentionGenerator
                    ? await mentionGenerator({
                        groupId,
                        targetUserId,
                        targetName: defaultTargetName,
                        promptText: prompt
                    })
                    : await sendGroupMentionFromPrompt({
                        aiClient,
                        bot,
                        groupId,
                        targetUserId,
                        targetName: defaultTargetName,
                        promptText: prompt,
                        outputProcessor: mentionOutputProcessor
                    });

                logger?.info?.('[工具] send_group_mention 完成', {
                    groupId: sent.groupId,
                    targetUserId: sent.targetUserId,
                    targetName: defaultTargetName || '',
                    usedPromptBuilder: !!sent.usedPromptBuilder,
                    finalMessageCount: sent.finalMessageCount || 0,
                    durationMs: sent.durationMs || Date.now() - startedAt,
                    prompt: sent.prompt || summarizeText(prompt),
                    generatedMessage: summarizeText(sent.generatedMessage)
                });

                return {
                    ok: true,
                    groupId: sent.groupId,
                    targetUserId: sent.targetUserId,
                    generatedMessage: sent.generatedMessage
                };
            } catch (error) {
                logger?.error?.('[工具] send_group_mention 失败', {
                    groupId,
                    targetUserId,
                    targetName: defaultTargetName || '',
                    durationMs: Date.now() - startedAt,
                    prompt: summarizeText(prompt),
                    error: error.message
                });
                return { ok: false, error: error.message, groupId, targetUserId };
            }
        };
    }

    // 并入外部 MCP 服务器工具（由 McpClientManager 提供定义与执行）
    const mcpDefinitions = mcpClient && typeof mcpClient.getToolDefinitions === 'function'
        ? mcpClient.getToolDefinitions()
        : [];
    for (const mcpDefinition of mcpDefinitions) {
        tools.push(mcpDefinition.definition);
        handlers[mcpDefinition.name] = async (argumentsPayload = {}) => {
            const result = await mcpClient.callTool({
                serverId: mcpDefinition.serverId,
                tool: mcpDefinition.toolName,
                arguments: argumentsPayload || {}
            });
            return result;
        };
    }
    if (mcpDefinitions.length > 0) {
        toolHints.push(buildMcpToolHint(mcpDefinitions));
    }
    // 总则放在最前，只在确实有可调用工具时下发
    if (toolHints.length > 0) {
        toolHints.unshift(buildToolHintRules());
    }


    return {
        tools,
        toolHints,
        handlers
    };
}
