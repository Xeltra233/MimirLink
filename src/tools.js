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

function buildToolHints(config = {}) {
    const webSearchConfig = normalizeWebSearchConfig(config.ai?.tools?.webSearch || {});
    const hints = [];

    if (webSearchConfig.enabled) {
        const available = ['web_search'];
        if (webSearchConfig.fetch.enabled) {
            available.push('web_fetch');
        }
        if (webSearchConfig.spice.enabled) {
            available.push('get_weather', 'convert_currency');
        }
        const fallback = webSearchConfig.fallbackProviders.length > 0
            ? webSearchConfig.fallbackProviders.join(', ')
            : '无';
        hints.push([
            `你当前可用联网工具: ${available.join(' / ')}（provider=${webSearchConfig.provider}，回退=${fallback}）。`,
            '判断规则: chat=普通群聊/角色扮演/情绪接话/水群/表情/戳一戳，不调用工具；browse=最新信息/新闻/外部事实/资料核验/用户明确让你查，调用 web_search；agent=代办动作，按可用工具执行。',
            'web_search 适合天气、新闻、实时动态、价格、政策、版本、链接/项目/库等需要网页事实核验的问题；需要页面正文细节时再用 web_fetch 打开候选链接。',
            'get_weather 只在用户明确询问天气且能给出地点时使用；convert_currency 只在需要汇率换算时使用。',
            `工具限制: 默认最多 ${webSearchConfig.maxResults} 条结果，单次请求超时 ${webSearchConfig.timeoutMs}ms，单条摘要最长 ${webSearchConfig.maxSnippetLength} 字。`,
            '搜索结果只作为依据，最终回复用自然语言总结；不要泄露工具 JSON、参数、工具名，也不要说“我准备搜索”。',
            '如果搜索失败或无结果，明确告诉用户这次检索失败/没查到，不要编造实时结果。'
        ].join('\n'));
    }

    return hints;
}

// ==================== 工具上下文 ====================

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
        toolHints.push([
            `你还可以调用外部 MCP 服务器提供的工具（共 ${mcpDefinitions.length} 个，名称以 mcp__ 开头）。`,
            '仅在用户明确需要对应能力时调用；调用失败时如实说明，不要编造结果。'
        ].join('\n'));
    }


    return {
        tools,
        toolHints,
        handlers
    };
}
