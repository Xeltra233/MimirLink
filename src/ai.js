/**
 * AI API 客户端模块
 */

export class AIClient {
    constructor(config, logger = console) {
        this.config = config;
        this.logger = logger;
        this.tokenStats = {
            totalInputTokens: 0,
            totalOutputTokens: 0,
            cacheHitTokens: 0,
            cacheMissTokens: 0,
            totalRequests: 0
        };
    }

    recordUsage(usage = {}) {
        if (!usage) return;
        this.tokenStats.totalInputTokens += usage.prompt_tokens || 0;
        this.tokenStats.totalOutputTokens += usage.completion_tokens || 0;
        this.tokenStats.cacheHitTokens += usage.prompt_cache_hit_tokens || usage.cached_tokens || usage.prompt_tokens_details?.cached_tokens || 0;
        this.tokenStats.cacheMissTokens += usage.prompt_cache_miss_tokens || (usage.prompt_tokens_details?.cached_tokens ? (usage.prompt_tokens || 0) - (usage.prompt_tokens_details?.cached_tokens || 0) : 0);
        this.tokenStats.totalRequests += 1;
    }

    getTokenStats() {
        const hit = this.tokenStats.cacheHitTokens;
        const miss = this.tokenStats.cacheMissTokens;
        const total = hit + miss;
        return {
            totalInputTokens: this.tokenStats.totalInputTokens,
            totalOutputTokens: this.tokenStats.totalOutputTokens,
            cacheHitTokens: hit,
            cacheMissTokens: miss,
            cacheHitRate: total > 0 ? (hit / total * 100).toFixed(1) + '%' : '0%',
            totalRequests: this.tokenStats.totalRequests
        };
    }

    summarizeMessages(messages = []) {
        return (Array.isArray(messages) ? messages : []).map((message, index) => ({
            index,
            role: message?.role || 'unknown',
            contentLength: typeof message?.content === 'string' ? message.content.length : 0,
            contentPreview: typeof message?.content === 'string' ? message.content.slice(0, 120) : null,
            source: message?.meta?.source || null,
            sourceId: message?.meta?.sourceId || null
        }));
    }

    buildPayloadPreview(payload = {}) {
        return {
            model: payload?.model || null,
            messageCount: Array.isArray(payload?.messages) ? payload.messages.length : 0,
            maxTokens: payload?.max_tokens ?? null,
            temperature: payload?.temperature ?? null,
            stream: payload?.stream ?? null,
            hasTools: Array.isArray(payload?.tools) ? payload.tools.length > 0 : payload?.tools !== undefined,
            toolChoice: payload?.tool_choice ?? null,
            hasFunctions: Array.isArray(payload?.functions) ? payload.functions.length > 0 : payload?.functions !== undefined,
            functionCall: payload?.function_call ?? null,
            messageTrace: this.summarizeMessages(payload?.messages || [])
        };
    }

    logPipelineStage(stage, details = {}) {
        this.logger.info?.(`[AI执行] ${stage}`, details);
    }

    extractTextContent(content) {
        if (typeof content === 'string') {
            return content;
        }

        if (Array.isArray(content)) {
            return content
                .map((item) => {
                    if (typeof item === 'string') {
                        return item;
                    }
                    if (item && typeof item.text === 'string') {
                        return item.text;
                    }
                    if (item && typeof item.content === 'string') {
                        return item.content;
                    }
                    if (item && typeof item.reasoning_content === 'string') {
                        return item.reasoning_content;
                    }
                    if (item && typeof item.reasoning === 'string') {
                        return item.reasoning;
                    }
                    if (item && item.type === 'text' && typeof item.text === 'string') {
                        return item.text;
                    }
                    if (item && Array.isArray(item.parts)) {
                        return this.extractTextContent(item.parts) || '';
                    }
                    return '';
                })
                .join('');
        }

        if (content && typeof content === 'object') {
            // OpenAI 标准格式
            if (typeof content.text === 'string') {
                return content.text;
            }
            if (typeof content.content === 'string') {
                return content.content;
            }
            // Gemini 格式
            if (Array.isArray(content.parts)) {
                const partsText = this.extractTextContent(content.parts);
                if (partsText !== null) {
                    return partsText;
                }
            }
            if (Array.isArray(content.candidates)) {
                const firstCandidate = content.candidates[0];
                if (firstCandidate?.content) {
                    return this.extractTextContent(firstCandidate.content);
                }
            }
            // 其他可能的格式
            if (typeof content.output_text === 'string') {
                return content.output_text;
            }
            if (typeof content.reasoning_content === 'string') {
                return content.reasoning_content;
            }
            if (typeof content.reasoning === 'string') {
                return content.reasoning;
            }
            if (typeof content.summary === 'string') {
                return content.summary;
            }
            if (Array.isArray(content.summary)) {
                const summaryText = this.extractTextContent(content.summary);
                if (summaryText !== null) {
                    return summaryText;
                }
            }
            if (Array.isArray(content.items)) {
                const itemsText = this.extractTextContent(content.items);
                if (itemsText !== null) {
                    return itemsText;
                }
            }
            // Claude 格式
            if (typeof content.type === 'string' && content.type === 'text' && typeof content.text === 'string') {
                return content.text;
            }
        }

        return null;
    }

    buildContentPreview(content) {
        if (Array.isArray(content)) {
            return content.slice(0, 3).map((item) => ({
                type: item?.type || typeof item,
                text: typeof item === 'string'
                    ? item.slice(0, 120)
                    : typeof item?.text === 'string'
                        ? item.text.slice(0, 120)
                        : typeof item?.content === 'string'
                            ? item.content.slice(0, 120)
                            : null
            }));
        }

        if (typeof content === 'string') {
            return content.slice(0, 200);
        }

        if (content && typeof content === 'object') {
            return {
                keys: Object.keys(content).slice(0, 10),
                text: this.extractTextContent(content)?.slice(0, 200) || null
            };
        }

        return null;
    }

    buildChatDiagnostic(data = {}) {
        const choice = data?.choices?.[0] || {};
        const message = choice?.message || {};
        const content = message?.content;
        const reasoningContent = message?.reasoning_content;

        // Gemini 格式检测
        const isGeminiFormat = data?.candidates && Array.isArray(data.candidates);
        const geminiCandidate = isGeminiFormat ? data.candidates[0] : null;
        const geminiContent = geminiCandidate?.content;

        return {
            choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
            requestedModel: this.config.model || null,
            responseModel: data?.model || null,
            finishReason: choice?.finish_reason || geminiCandidate?.finishReason || null,
            messageKeys: Object.keys(message),
            contentType: Array.isArray(content) ? 'array' : typeof content,
            contentPreview: this.buildContentPreview(content),
            reasoningContentType: Array.isArray(reasoningContent) ? 'array' : typeof reasoningContent,
            reasoningContentPreview: this.buildContentPreview(reasoningContent),
            hasToolCalls: Array.isArray(message?.tool_calls) && message.tool_calls.length > 0,
            refusal: typeof message?.refusal === 'string' ? message.refusal.slice(0, 200) : null,
            // Gemini 格式诊断
            isGeminiFormat,
            geminiCandidateCount: isGeminiFormat ? data.candidates.length : 0,
            geminiContentType: geminiContent ? (Array.isArray(geminiContent) ? 'array' : typeof geminiContent) : null,
            geminiContentPreview: geminiContent ? this.buildContentPreview(geminiContent) : null,
            // 原始数据
            rawContent: content,
            rawReasoningContent: reasoningContent,
            rawGeminiContent: geminiContent,
            rawMessage: message,
            rawChoice: choice,
            rawGeminiCandidate: geminiCandidate,
            rawResponseKeys: Object.keys(data)
        };
    }

    buildChatExtractionResult(data) {
        const message = data?.choices?.[0]?.message || {};

        // Gemini 格式兼容：检查是否是 Gemini 原生响应
        const isGeminiFormat = data?.candidates && Array.isArray(data.candidates);
        const geminiCandidate = isGeminiFormat ? data.candidates[0] : null;
        const geminiContent = geminiCandidate?.content;

        this.logPipelineStage('开始提取回复内容', {
            responseModel: data?.model || null,
            isGeminiFormat,
            messageKeys: Object.keys(message),
            contentType: Array.isArray(message.content) ? 'array' : typeof message.content,
            reasoningContentType: Array.isArray(message.reasoning_content) ? 'array' : typeof message.reasoning_content,
            toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
            geminiContentType: geminiContent ? (Array.isArray(geminiContent) ? 'array' : typeof geminiContent) : null
        });

        // 优先尝试 Gemini 格式
        if (isGeminiFormat && geminiContent) {
            const geminiText = this.extractTextContent(geminiContent);
            if (geminiText !== null) {
                this.logPipelineStage('Gemini 格式内容提取成功', {
                    contentLength: geminiText.length,
                    contentPreview: geminiText.slice(0, 200)
                });
                return {
                    content: geminiText,
                    reasoningContent: null,
                    rawReasoningContent: null,
                    rawContent: geminiContent,
                    rawMessage: geminiCandidate
                };
            }
        }

        // OpenAI 标准格式
        const content = this.extractTextContent(message.content);
        const reasoningContent = this.extractTextContent(
            message.reasoning_content
            ?? message.reasoningContent
            ?? message.reasoning
            ?? data?.choices?.[0]?.delta?.reasoning_content
            ?? data?.choices?.[0]?.delta?.reasoningContent
        );

        if (content !== null) {
            this.logPipelineStage('标准 content 提取成功', {
                contentLength: content.length,
                contentPreview: content.slice(0, 200)
            });
        }

        if (reasoningContent !== null) {
            this.logPipelineStage('reasoning_content 提取成功', {
                contentLength: reasoningContent.length,
                contentPreview: reasoningContent.slice(0, 200),
                rawReasoningType: typeof (message.reasoning_content ?? message.reasoningContent ?? message.reasoning),
                rawReasoningLength: typeof (message.reasoning_content ?? message.reasoningContent ?? message.reasoning) === 'string'
                    ? (message.reasoning_content ?? message.reasoningContent ?? message.reasoning).length
                    : Array.isArray(message.reasoning_content ?? message.reasoningContent ?? message.reasoning)
                        ? (message.reasoning_content ?? message.reasoningContent ?? message.reasoning).length
                        : null
            });
        }

        if (content === null && reasoningContent === null) {
            const error = new Error('AI API 返回了空消息内容');
            error.diagnostic = this.buildChatDiagnostic(data);
            this.logPipelineStage('回复内容提取失败', error.diagnostic);
            throw error;
        }

        return {
            content,
            reasoningContent,
            rawReasoningContent: message.reasoning_content ?? message.reasoningContent ?? message.reasoning ?? null,
            rawContent: message.content ?? null,
            rawMessage: message
        };
    }

    extractChatMessageContent(data) {
        const extraction = this.buildChatExtractionResult(data);
        if (extraction.content !== null) {
            return extraction.content;
        }

        if (extraction.reasoningContent !== null) {
            this.logger.warn?.('[AI] 标准 content 为空，已回退使用 reasoning_content');
            return extraction.reasoningContent;
        }

        const error = new Error('AI API 返回了空消息内容');
        error.diagnostic = this.buildChatDiagnostic(data);
        throw error;
    }

    formatChatResponseResult(data, extracted = null) {
        const extraction = extracted || this.buildChatExtractionResult(data);
        return {
            content: extraction.content ?? extraction.reasoningContent ?? '',
            reasoningContent: extraction.reasoningContent ?? null,
            rawReasoningContent: extraction.rawReasoningContent ?? null,
            rawContent: extraction.rawContent ?? null,
            rawMessage: extraction.rawMessage ?? null
        };
    }

    getVisibleResponseContent(result) {
        if (typeof result === 'string') {
            return result;
        }

        if (result && typeof result.content === 'string') {
            return result.content;
        }

        return '';
    }


    buildHeaders(apiKey = this.config.apiKey) {
        const headers = {
            'Content-Type': 'application/json'
        };

        if (apiKey) {
            headers.Authorization = `Bearer ${apiKey}`;
        }

        return headers;
    }

    normalizeBaseUrl(baseUrl = this.config.baseUrl) {
        if (!baseUrl) {
            return '';
        }

        return String(baseUrl).replace(/\/+$/, '');
    }

    resolveApiUrl(path, baseUrl = this.config.baseUrl) {
        const normalizedBaseUrl = this.normalizeBaseUrl(baseUrl);
        if (!normalizedBaseUrl) {
            return this.config.apiUrl;
        }

        // 如果 baseUrl 已经包含 /v1，直接拼接 path；否则添加 /v1 前缀
        if (normalizedBaseUrl.endsWith('/v1')) {
            return `${normalizedBaseUrl}${path}`;
        }

        const normalizedPath = path.startsWith('/v1') ? path : `/v1${path}`;
        return `${normalizedBaseUrl}${normalizedPath}`;
    }

    describeNetworkError(error) {
        const cause = error?.cause || {};
        const code = cause.code || error?.code || '';
        const address = cause.address || '';
        const port = cause.port || '';
        if (code || address || port) {
            const target = [address, port].filter(Boolean).join(':');
            return `连接 AI 服务失败 (${[code, target].filter(Boolean).join(' ')}): ${error.message}`;
        }
        return error?.message || '连接 AI 服务失败';
    }

    resolveChatOptions(overrides = {}) {
        return {
            model: overrides.model || this.config.model,
            baseUrl: overrides.baseUrl || this.config.baseUrl,
            apiKey: overrides.apiKey || this.config.apiKey,
            maxTokens: overrides.maxTokens ?? this.config.maxTokens,
            temperature: overrides.temperature ?? this.config.temperature
        };
    }

    buildChatPayload(messages, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        return {
            model: options.model,
            messages,
            max_tokens: options.maxTokens,
            temperature: options.temperature,
            stream: false
        };
    }

    buildToolsChatPayload(messages, tools, overrides = {}) {
        return {
            ...this.buildChatPayload(messages, overrides),
            tools,
            tool_choice: 'auto',
            parallel_tool_calls: false
        };
    }

    buildNoToolsChatPayload(messages, overrides = {}) {
        return {
            ...this.buildChatPayload(messages, overrides),
            tools: [],
            tool_choice: 'none',
            parallel_tool_calls: false
        };
    }

    buildLegacyNoFunctionsChatPayload(messages, overrides = {}) {
        return {
            ...this.buildChatPayload(messages, overrides),
            functions: [],
            function_call: 'none'
        };
    }

    buildStrictNoToolsChatPayload(messages, overrides = {}) {
        return {
            ...this.buildChatPayload(messages, overrides),
            tools: [],
            tool_choice: 'none',
            parallel_tool_calls: false,
            functions: [],
            function_call: 'none'
        };
    }

    isDegradedFunctionError(errorText = '') {
        const normalized = String(errorText || '').toLowerCase();
        return normalized.includes('degraded function cannot be invoked');
    }

    isEmptyMessageContentError(error) {
        return error?.message === 'AI API 返回了空消息内容';
    }

    hasTrailingAssistantPrefill(messages = []) {
        const lastMessage = Array.isArray(messages) ? messages.at(-1) : null;
        return lastMessage?.role === 'assistant' && lastMessage?.meta?.source === 'assistant_prefill';
    }

    removeTrailingAssistantPrefill(messages = []) {
        if (!this.hasTrailingAssistantPrefill(messages)) {
            return messages;
        }

        return messages.slice(0, -1);
    }

    async extractChatContentWithPrefillFallback(data, messages, overrides = {}) {
        try {
            return this.formatChatResponseResult(data);
        } catch (error) {
            if (!this.isEmptyMessageContentError(error) || !this.hasTrailingAssistantPrefill(messages)) {
                throw error;
            }

            const fallbackMessages = this.removeTrailingAssistantPrefill(messages);
            this.logPipelineStage('检测到 assistant_prefill 触发空回复，移除尾部预填充后重试', {
                originalMessageCount: Array.isArray(messages) ? messages.length : 0,
                fallbackMessageCount: fallbackMessages.length,
                removedMessagePreview: this.summarizeMessages(messages).at(-1) || null,
                diagnostic: error.diagnostic || null
            });

            const fallbackPayload = this.buildChatPayload(fallbackMessages, overrides);
            this.logPipelineStage('尝试无 assistant_prefill 重试 payload', this.buildPayloadPreview(fallbackPayload));
            const fallbackResult = await this.sendChatRequest(fallbackPayload, overrides);
            if (!fallbackResult.ok) {
                this.logPipelineStage('无 assistant_prefill 重试失败', {
                    status: fallbackResult.status,
                    errorText: String(fallbackResult.errorText || '').slice(0, 500)
                });
                throw new Error(`AI API 错误: ${fallbackResult.status} - ${fallbackResult.errorText}`);
            }

            this.logPipelineStage('无 assistant_prefill 重试成功，准备提取内容', {
                responseModel: fallbackResult.data?.model || null
            });

            let fallbackExtractedError = null;
            try {
                return this.formatChatResponseResult(fallbackResult.data);
            } catch (retryError) {
                fallbackExtractedError = retryError;
            }

            if (!this.isEmptyMessageContentError(fallbackExtractedError)) {
                throw fallbackExtractedError;
            }

            this.logPipelineStage('无 assistant_prefill 重试仍为空，尝试流式提取兜底', {
                diagnostic: fallbackExtractedError?.diagnostic || null
            });

            const fallbackStreamingResult = await this.sendStreamingChatRequest(fallbackPayload, overrides);
            if (!fallbackStreamingResult.ok) {
                throw new Error(`AI API 错误: ${fallbackStreamingResult.status} - ${fallbackStreamingResult.errorText}`);
            }

            return this.formatChatResponseResult(fallbackStreamingResult.data);
        }
    }

    async sendStreamingChatRequest(payload, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        const headers = this.buildHeaders(options.apiKey);
        const apiUrl = this.resolveApiUrl('/chat/completions', options.baseUrl);
        const payloadPreview = this.buildPayloadPreview(payload);

        this.logPipelineStage('准备发送流式 chat/completions', {
            apiUrl,
            payload: payloadPreview
        });

        if (!apiUrl) {
            throw new Error('未配置 AI API URL (baseUrl 或 apiUrl)');
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                ...payload,
                stream: true
            })
        });

        this.logPipelineStage('收到流式 chat/completions 响应', {
            status: response.status,
            ok: response.ok,
            statusText: response.statusText || null,
            model: payloadPreview.model,
            messageCount: payloadPreview.messageCount
        });

        if (!response.ok) {
            const errorText = await response.text();
            this.logPipelineStage('流式 chat/completions 返回错误', {
                status: response.status,
                errorText: String(errorText || '').slice(0, 1000)
            });
            return {
                ok: false,
                errorText,
                status: response.status
            };
        }

        const reader = response.body?.getReader?.();
        if (!reader) {
            throw new Error('流式响应不可读');
        }

        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        let reasoningContent = '';
        let lastChunk = null;

        const processEvent = (rawEvent) => {
            const lines = rawEvent
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);

            for (const line of lines) {
                if (!line.startsWith('data:')) {
                    continue;
                }

                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') {
                    continue;
                }

                let parsed;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    continue;
                }

                lastChunk = parsed;

                // OpenAI 标准格式
                const delta = parsed?.choices?.[0]?.delta || {};
                if (typeof delta.reasoning_content === 'string') {
                    reasoningContent += delta.reasoning_content;
                }
                if (typeof delta.reasoning === 'string') {
                    reasoningContent += delta.reasoning;
                }
                if (typeof delta.content === 'string') {
                    content += delta.content;
                }

                // Gemini 格式
                const geminiCandidate = parsed?.candidates?.[0];
                if (geminiCandidate?.content) {
                    const geminiText = this.extractTextContent(geminiCandidate.content);
                    if (geminiText) {
                        content += geminiText;
                    }
                }

                // Claude 格式（content 数组）
                if (Array.isArray(delta.content)) {
                    const deltaText = this.extractTextContent(delta.content);
                    if (deltaText) {
                        content += deltaText;
                    }
                }
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const eventText of events) {
                processEvent(eventText);
            }
        }

        buffer += decoder.decode();
        if (buffer.trim()) {
            const events = buffer.split('\n\n');
            for (const eventText of events) {
                processEvent(eventText);
            }
        }

        const synthesizedData = {
            model: lastChunk?.model || payload?.model || null,
            choices: [{
                finish_reason: lastChunk?.choices?.[0]?.finish_reason || 'stop',
                message: {
                    role: 'assistant',
                    content: content || null,
                    reasoning_content: reasoningContent || null,
                    tool_calls: null
                }
            }]
        };

        this.logPipelineStage('已组装流式 chat/completions 响应体', {
            responseModel: synthesizedData?.model || null,
            contentLength: content.length,
            reasoningContentLength: reasoningContent.length,
            finishReason: synthesizedData?.choices?.[0]?.finish_reason || null
        });

        return {
            ok: true,
            data: synthesizedData
        };
    }

    async sendChatRequest(payload, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        const headers = this.buildHeaders(options.apiKey);
        const apiUrl = this.resolveApiUrl('/chat/completions', options.baseUrl);
        const payloadPreview = this.buildPayloadPreview(payload);

        this.logPipelineStage('准备发送 chat/completions', {
            apiUrl,
            payload: payloadPreview
        });

        if (!apiUrl) {
            throw new Error('未配置 AI API URL (baseUrl 或 apiUrl)');
        }

        let response;
        try {
            response = await fetch(apiUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            });
        } catch (error) {
            throw new Error(this.describeNetworkError(error));
        }

        this.logPipelineStage('收到 chat/completions 响应', {
            status: response.status,
            ok: response.ok,
            statusText: response.statusText || null,
            model: payloadPreview.model,
            messageCount: payloadPreview.messageCount
        });

        if (!response.ok) {
            const errorText = await response.text();
            this.logPipelineStage('chat/completions 返回错误', {
                status: response.status,
                errorText: String(errorText || '').slice(0, 1000)
            });
            return {
                ok: false,
                errorText,
                status: response.status
            };
        }

        const rawText = await response.text();
        this.lastChatRawText = rawText;

        let data;
        try {
            data = JSON.parse(rawText);
        } catch (error) {
            this.logPipelineStage('chat/completions 响应 JSON 解析失败', {
                rawTextPreview: String(rawText || '').slice(0, 2000)
            });
            throw new Error('AI API 返回了非 JSON 响应');
        }
        this.lastChatRawResponse = data;
        if (data.usage) this.recordUsage(data.usage);
        this.logPipelineStage('已解析 chat/completions 响应体', {
            responseModel: data?.model || null,
            choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
            finishReason: data?.choices?.[0]?.finish_reason || null,
            messageKeys: Object.keys(data?.choices?.[0]?.message || {})
        });
        return {
            ok: true,
            data
        };
    }

    extractModelTokenInfo(model = {}) {
        const pickNumber = (...values) => {
            for (const value of values) {
                if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
                    return value;
                }
                if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
                    const parsed = Number(value);
                    if (parsed > 0) {
                        return parsed;
                    }
                }
            }
            return null;
        };

        const inputTokens = pickNumber(
            model.context_window,
            model.input_token_limit,
            model.max_input_tokens,
            model.capabilities?.input_token_limit,
            model.capabilities?.max_input_tokens,
            model.limits?.input,
            model.limits?.context
        );

        const outputTokens = pickNumber(
            model.max_output_tokens,
            model.output_token_limit,
            model.max_completion_tokens,
            model.capabilities?.output_token_limit,
            model.capabilities?.max_output_tokens,
            model.limits?.output,
            model.completion_tokens
        );

        const recommendedMaxTokens = outputTokens || pickNumber(model.default_max_tokens, model.defaultMaxTokens);

        return {
            contextWindow: inputTokens,
            maxOutputTokens: outputTokens,
            recommendedMaxTokens
        };
    }

    extractAssistantMessage(data = {}) {
        return data?.choices?.[0]?.message || {};
    }

    parseToolArguments(rawArguments) {
        if (rawArguments == null) {
            return {};
        }

        if (typeof rawArguments === 'object') {
            return rawArguments;
        }

        const normalized = String(rawArguments).trim();
        if (!normalized) {
            return {};
        }

        try {
            return JSON.parse(normalized);
        } catch {
            throw new Error('工具参数不是合法 JSON');
        }
    }

    normalizeToolCall(rawToolCall = {}) {
        const functionPayload = rawToolCall.function || {};
        return {
            id: rawToolCall.id || `tool-call-${Date.now()}`,
            type: rawToolCall.type || 'function',
            name: functionPayload.name || rawToolCall.name || '',
            arguments: this.parseToolArguments(functionPayload.arguments ?? rawToolCall.arguments),
            rawArguments: functionPayload.arguments ?? rawToolCall.arguments ?? ''
        };
    }

    buildToolMessages(toolCall, toolResult) {
        return [
            {
                role: 'assistant',
                content: null,
                tool_calls: [
                    {
                        id: toolCall.id,
                        type: toolCall.type,
                        function: {
                            name: toolCall.name,
                            arguments: toolCall.rawArguments || JSON.stringify(toolCall.arguments || {})
                        }
                    }
                ]
            },
            {
                role: 'tool',
                tool_call_id: toolCall.id,
                content: JSON.stringify(toolResult)
            }
        ];
    }

    buildTextToolFallbackMessages(messages, instruction) {
        const normalizedMessages = Array.isArray(messages)
            ? messages.map((message) => ({ ...message }))
            : [];
        const normalizedInstruction = String(instruction || '').trim();
        if (!normalizedInstruction) {
            return normalizedMessages;
        }

        return [
            {
                role: 'system',
                content: normalizedInstruction,
                meta: { source: 'text_tool_fallback' }
            },
            ...normalizedMessages
        ];
    }

    extractJsonObjectCandidates(text = '') {
        const source = String(text || '');
        const candidates = [];
        const pushCandidate = (value) => {
            const normalized = String(value || '').trim();
            if (normalized && !candidates.includes(normalized)) {
                candidates.push(normalized);
            }
        };

        pushCandidate(source);
        const codeBlockMatches = source.match(/```(?:json)?\s*([\s\S]*?)```/ig) || [];
        for (const block of codeBlockMatches) {
            const cleaned = block.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
            pushCandidate(cleaned);
        }

        const firstBrace = source.indexOf('{');
        const lastBrace = source.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            pushCandidate(source.slice(firstBrace, lastBrace + 1));
        }

        return candidates;
    }

    parseTextToolFallbackResponse(rawText = '') {
        const candidates = this.extractJsonObjectCandidates(rawText);
        for (const candidate of candidates) {
            try {
                const parsed = JSON.parse(candidate);
                if (parsed && typeof parsed === 'object') {
                    return parsed;
                }
            } catch {
                continue;
            }
        }
        throw new Error('文本工具兜底解析失败：模型未返回合法 JSON');
    }

    normalizeTextToolFallbackCalls(payload = {}) {
        const rawCalls = Array.isArray(payload?.tool_calls)
            ? payload.tool_calls
            : payload?.tool_call && typeof payload.tool_call === 'object'
                ? [payload.tool_call]
                : [];

        return rawCalls.map((call, index) => ({
            id: call?.id || `text-tool-call-${Date.now()}-${index + 1}`,
            type: 'function',
            name: String(call?.name || '').trim(),
            arguments: call?.arguments && typeof call.arguments === 'object' ? call.arguments : {},
            rawArguments: JSON.stringify(call?.arguments && typeof call.arguments === 'object' ? call.arguments : {})
        })).filter((call) => call.name);
    }

    buildTextToolResultMessage(toolCall, toolResult) {
        return {
            role: 'user',
            content: JSON.stringify({
                action: 'tool_result',
                tool_name: toolCall.name,
                tool_call_id: toolCall.id,
                result: toolResult
            }, null, 2),
            meta: { source: 'text_tool_result' }
        };
    }

    async runTextToolFallback(messages, toolContext = {}, overrides = {}) {
        const fallbackConfig = toolContext?.textToolFallback || {};
        const instruction = String(fallbackConfig.instruction || '').trim();
        const maxRounds = Number(fallbackConfig.maxRounds) || 3;
        if (!instruction) {
            throw new Error('文本工具兜底未提供协议说明');
        }

        let conversation = this.buildTextToolFallbackMessages(messages, instruction);
        for (let round = 0; round < maxRounds; round += 1) {
            const payload = this.buildChatPayload(conversation, overrides);
            this.logPipelineStage('文本工具兜底请求开始', {
                round: round + 1,
                maxRounds,
                messageCount: conversation.length,
                payload: this.buildPayloadPreview(payload)
            });

            const result = await this.sendChatRequest(payload, overrides);
            if (!result.ok) {
                throw new Error(`AI API 错误: ${result.status} - ${result.errorText}`);
            }

            const extracted = await this.extractChatContentWithPrefillFallback(result.data, conversation, overrides);
            const rawReply = this.getVisibleResponseContent(extracted);
            const parsed = this.parseTextToolFallbackResponse(rawReply);
            const action = String(parsed?.action || '').trim().toLowerCase();

            if (action === 'final') {
                const finalContent = typeof parsed.content === 'string' ? parsed.content.trim() : '';
                if (!finalContent) {
                    throw new Error('文本工具兜底解析失败：final 缺少 content');
                }
                return {
                    ...extracted,
                    content: finalContent
                };
            }

            if (action !== 'tool_calls') {
                throw new Error('文本工具兜底解析失败：未知 action');
            }

            const toolCalls = this.normalizeTextToolFallbackCalls(parsed);
            if (toolCalls.length === 0) {
                throw new Error('文本工具兜底解析失败：tool_calls 为空');
            }

            conversation.push({
                role: 'assistant',
                content: rawReply,
                meta: { source: 'text_tool_fallback_reply' }
            });

            for (const toolCall of toolCalls) {
                const toolResult = await this.executeSingleToolCall(toolCall, toolContext);
                conversation.push(this.buildTextToolResultMessage(toolCall, toolResult));
            }
        }

        throw new Error('文本工具兜底轮次过多，已停止继续请求');
    }
    async chatWithTools(messages, toolContext = {}, overrides = {}) {
        const tools = Array.isArray(toolContext?.tools) ? toolContext.tools : [];
        const handlers = toolContext?.handlers || {};
        const textToolFallbackEnabled = toolContext?.textToolFallback?.enabled === true;

        if (tools.length === 0) {
            return this.chat(messages, overrides);
        }

        let conversation = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];

        for (let round = 0; round < 4; round += 1) {
            const payload = this.buildToolsChatPayload(conversation, tools, overrides);
            this.logPipelineStage('开始执行 chatWithTools', {
                round: round + 1,
                toolCount: tools.length,
                messageCount: conversation.length,
                toolNames: tools.map((tool) => tool?.function?.name).filter(Boolean),
                textToolFallbackEnabled
            });

            const result = await this.sendChatRequest(payload, overrides);
            if (!result.ok) {
                if (textToolFallbackEnabled && this.isDegradedFunctionError(result.errorText)) {
                    this.logPipelineStage('原生工具调用失败，切换文本工具兜底', {
                        round: round + 1,
                        status: result.status,
                        errorText: String(result.errorText || '').slice(0, 500)
                    });
                    return this.runTextToolFallback(messages, toolContext, overrides);
                }
                throw new Error(`AI API 错误: ${result.status} - ${result.errorText}`);
            }

            const assistantMessage = result.data?.choices?.[0]?.message || {};
            const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
            const assistantContent = this.extractTextContent(assistantMessage.content);

            if (toolCalls.length === 0) {
                let extractedError = null;
                try {
                    return await this.extractChatContentWithPrefillFallback(result.data, conversation, overrides);
                } catch (error) {
                    extractedError = error;
                }

                if (!this.isEmptyMessageContentError(extractedError)) {
                    throw extractedError;
                }

                this.logPipelineStage('chatWithTools 检测到非流式空回复，尝试流式提取兜底', {
                    round: round + 1,
                    diagnostic: extractedError?.diagnostic || null
                });

                const streamingResult = await this.sendStreamingChatRequest(payload, overrides);
                if (!streamingResult.ok) {
                    throw new Error(`AI API 错误: ${streamingResult.status} - ${streamingResult.errorText}`);
                }

                return await this.extractChatContentWithPrefillFallback(streamingResult.data, conversation, overrides);
            }

            conversation.push({
                role: 'assistant',
                content: assistantContent || '',
                tool_calls: toolCalls
            });

            for (const toolCall of toolCalls) {
                const toolName = toolCall?.function?.name || '';
                const handler = handlers[toolName];
                let toolResult;

                if (typeof handler !== 'function') {
                    toolResult = { ok: false, error: `未找到工具处理器: ${toolName}` };
                } else {
                    let parsedArgs = {};
                    try {
                        parsedArgs = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
                    } catch {
                        parsedArgs = {};
                    }
                    toolResult = await handler(parsedArgs);
                }

                conversation.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult, null, 2)
                });
            }
        }

        throw new Error('工具调用轮次过多，已停止继续请求');
    }

    normalizeModel(model = {}) {
        const tokenInfo = this.extractModelTokenInfo(model);
        return {
            id: model.id || model.name || model.model || 'unknown-model',
            name: model.name || model.id || model.model || 'unknown-model',
            ownedBy: model.owned_by || model.provider || model.organization || '',
            contextWindow: tokenInfo.contextWindow,
            maxOutputTokens: tokenInfo.maxOutputTokens,
            recommendedMaxTokens: tokenInfo.recommendedMaxTokens,
            raw: model
        };
    }

    async listModels(options = {}) {
        const baseUrl = options.baseUrl || this.config.baseUrl;
        const apiKey = options.apiKey || this.config.apiKey;
        const apiUrl = this.resolveApiUrl('/models', baseUrl);

        if (!apiUrl) {
            throw new Error('未配置 AI API URL (baseUrl 或 apiUrl)');
        }

        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: this.buildHeaders(apiKey)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`模型列表拉取失败: ${response.status} - ${errorText}`);
        }

        const payload = await response.json();
        const models = Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload?.models)
                ? payload.models
                : Array.isArray(payload)
                    ? payload
                    : [];

        return models.map((model) => this.normalizeModel(model));
    }

    async probeModel(modelId, options = {}) {
        const resolvedModelId = String(modelId || '').trim();
        if (!resolvedModelId) {
            throw new Error('\u672a\u6307\u5b9a\u8981\u63a2\u6d4b\u7684\u6a21\u578b');
        }

        const probeOverrides = {
            ...options,
            model: resolvedModelId,
            maxTokens: 1,
            temperature: 0
        };
        const payload = this.buildChatPayload([
            { role: 'system', content: 'You are a connectivity probe. Reply with OK only.' },
            { role: 'user', content: 'ping' }
        ], probeOverrides);

        const result = await this.sendChatRequest(payload, probeOverrides);
        if (!result.ok) {
            throw new Error(`\u6a21\u578b\u63a2\u6d4b\u5931\u8d25: ${result.status} - ${result.errorText}`);
        }

        const responseModel = result.data?.model || resolvedModelId;
        const normalized = this.normalizeModel({
            id: responseModel,
            name: responseModel,
            raw: {
                usage: result.data?.usage || null,
                finishReason: result.data?.choices?.[0]?.finish_reason || null
            }
        });

        return {
            model: normalized,
            probeResponse: {
                id: result.data?.id || null,
                usage: result.data?.usage || null,
                finishReason: result.data?.choices?.[0]?.finish_reason || null
            }
        };
    }

    /**
     * 调用 AI API
     * @param {Array} messages - 消息数组
     */
    async chat(messages, overrides = {}) {
        const options = this.resolveChatOptions(overrides);
        this.logPipelineStage('开始执行 chat', {
            model: options.model || null,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            messageTrace: this.summarizeMessages(messages)
        });

        const primaryPayload = this.buildChatPayload(messages, overrides);
        this.logPipelineStage('已构建主请求 payload', this.buildPayloadPreview(primaryPayload));

        const primaryResult = await this.sendChatRequest(primaryPayload, overrides);
        if (primaryResult.ok) {
            this.logPipelineStage('主请求成功，准备提取内容', {
                responseModel: primaryResult.data?.model || null
            });

            let extractedError = null;
            try {
                return await this.extractChatContentWithPrefillFallback(primaryResult.data, messages, overrides);
            } catch (error) {
                extractedError = error;
            }

            if (!this.isEmptyMessageContentError(extractedError)) {
                throw extractedError;
            }

            this.logPipelineStage('检测到非流式响应为空，尝试流式提取兜底', {
                diagnostic: extractedError?.diagnostic || null
            });

            const streamingResult = await this.sendStreamingChatRequest(primaryPayload, overrides);
            if (!streamingResult.ok) {
                throw new Error(`AI API 错误: ${streamingResult.status} - ${streamingResult.errorText}`);
            }

            return this.extractChatContentWithPrefillFallback(streamingResult.data, messages, overrides);
        }

        if (this.isDegradedFunctionError(primaryResult.errorText)) {
            this.logPipelineStage('检测到 degraded function 错误，开始降级重试', {
                status: primaryResult.status,
                errorText: String(primaryResult.errorText || '').slice(0, 500)
            });

            const fallbackPayloads = [
                this.buildNoToolsChatPayload(messages, overrides),
                this.buildLegacyNoFunctionsChatPayload(messages, overrides),
                this.buildStrictNoToolsChatPayload(messages, overrides)
            ];

            let lastFallbackResult = primaryResult;
            for (const payload of fallbackPayloads) {
                this.logPipelineStage('尝试降级 payload', this.buildPayloadPreview(payload));
                const fallbackResult = await this.sendChatRequest(payload, overrides);
                if (fallbackResult.ok) {
                    this.logPipelineStage('降级请求成功，准备提取内容', {
                        responseModel: fallbackResult.data?.model || null
                    });
                    return this.formatChatResponseResult(fallbackResult.data);
                }
                lastFallbackResult = fallbackResult;
                this.logPipelineStage('降级请求失败', {
                    status: fallbackResult.status,
                    errorText: String(fallbackResult.errorText || '').slice(0, 500)
                });
                if (!this.isDegradedFunctionError(fallbackResult.errorText)) {
                    break;
                }
            }

            // 备用模型切换
            const backupModel = this.config.chat?.backupModel;
            const backupProviderId = this.config.chat?.backupModelProviderId;
            if (backupModel && backupProviderId) {
                const backupProvider = (this.config.ai?.providers || []).find(p => p.id === backupProviderId);
                if (backupProvider) {
                    this.logPipelineStage('降级全失败，尝试切换到备用模型', { provider: backupProviderId, model: backupModel });
                    const backupOverrides = {
                        ...overrides,
                        model: backupModel,
                        baseUrl: backupProvider.baseUrl || overrides.baseUrl,
                        apiKey: backupProvider.apiKey || overrides.apiKey
                    };
                    const backupPayload = this.buildChatPayload(messages, backupOverrides);
                    const backupResult = await this.sendChatRequest(backupPayload, backupOverrides);
                    if (backupResult.ok) {
                        this.logPipelineStage('备用模型请求成功', { responseModel: backupResult.data?.model || null });
                        return this.extractChatContentWithPrefillFallback(backupResult.data, messages, backupOverrides);
                    }
                    this.logPipelineStage('备用模型请求也失败', {
                        status: backupResult.status,
                        errorText: String(backupResult.errorText || '').slice(0, 200)
                    });
                }
            }

            throw new Error(`AI API 错误: ${lastFallbackResult.status} - ${lastFallbackResult.errorText}`);
        }

        this.logPipelineStage('主请求失败且不满足降级条件', {
            status: primaryResult.status,
            errorText: String(primaryResult.errorText || '').slice(0, 500)
        });

        // 备用模型切换
        const backupModel = this.config.chat?.backupModel;
        const backupProviderId = this.config.chat?.backupModelProviderId;
        if (backupModel && backupProviderId) {
            const backupProvider = (this.config.ai?.providers || []).find(p => p.id === backupProviderId);
            if (backupProvider) {
                this.logPipelineStage('尝试切换到备用模型', { provider: backupProviderId, model: backupModel });
                const backupOverrides = {
                    ...overrides,
                    model: backupModel,
                    baseUrl: backupProvider.baseUrl || overrides.baseUrl,
                    apiKey: backupProvider.apiKey || overrides.apiKey
                };
                const backupPayload = this.buildChatPayload(messages, backupOverrides);
                const backupResult = await this.sendChatRequest(backupPayload, backupOverrides);
                if (backupResult.ok) {
                    this.logPipelineStage('备用模型请求成功', { responseModel: backupResult.data?.model || null });
                    return this.extractChatContentWithPrefillFallback(backupResult.data, messages, backupOverrides);
                }
                this.logPipelineStage('备用模型请求也失败', {
                    status: backupResult.status,
                    errorText: String(backupResult.errorText || '').slice(0, 200)
                });
            }
        }

        throw new Error(`AI API 错误: ${primaryResult.status} - ${primaryResult.errorText}`);
    }

    async summarize(messages, sessionId = 'default', modelOverride = null) {
        const summaryPrompt = [
            {
                role: 'system',
                content: '请将以下对话压缩成简洁的长期记忆摘要。保留人物关系、关键事实、未完成事项、情绪变化和设定，不要编造。输出简体中文纯文本。'
            },
            {
                role: 'user',
                content: `会话ID: ${sessionId}\n\n对话内容:\n${messages.map((message) => `[${message.role}] ${message.content}`).join('\n')}`
            }
        ];
        const overrides = modelOverride ? { model: modelOverride } : {};
        return this.chat(summaryPrompt, overrides);
    }

    async chatWithTools(messages, toolContext = {}, overrides = {}) {
        const tools = Array.isArray(toolContext?.tools) ? toolContext.tools : [];
        const handlers = toolContext?.handlers || {};

        if (tools.length === 0) {
            return this.chat(messages, overrides);
        }

        let conversation = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];

        for (let round = 0; round < 4; round += 1) {
            const payload = this.buildToolsChatPayload(conversation, tools, overrides);
            this.logPipelineStage('开始执行 chatWithTools', {
                round: round + 1,
                toolCount: tools.length,
                messageCount: conversation.length,
                toolNames: tools.map((tool) => tool?.function?.name).filter(Boolean)
            });

            let result = await this.sendChatRequest(payload, overrides);
            if (!result.ok) {
                // 备用模型切换
                const backupModel2 = this.config.chat?.backupModel;
                const backupProviderId2 = this.config.chat?.backupModelProviderId;
                if (backupModel2 && backupProviderId2) {
                    const backupProvider2 = (this.config.ai?.providers || []).find(p => p.id === backupProviderId2);
                    if (backupProvider2) {
                        this.logPipelineStage('chatWithTools 主模型失败，尝试备用模型');
                        const backupOv = { ...overrides, model: backupModel2, baseUrl: backupProvider2.baseUrl || overrides.baseUrl, apiKey: backupProvider2.apiKey || overrides.apiKey };
                        const backupPayload = this.buildToolsChatPayload(conversation, tools, backupOv);
                        const backupResult = await this.sendChatRequest(backupPayload, backupOv);
                        if (backupResult.ok) {
                            result = backupResult;
                            this.logPipelineStage('备用模型请求成功');
                        } else {
                            this.logPipelineStage('备用模型也失败');
                        }
                    }
                }
                if (!result.ok) {
                    throw new Error(`AI API 错误: ${result.status} - ${result.errorText}`);
                }
            }

            const assistantMessage = result.data?.choices?.[0]?.message || {};
            const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
            const assistantContent = this.extractTextContent(assistantMessage.content);

            if (toolCalls.length === 0) {
                let extractedError = null;
                try {
                    return await this.extractChatContentWithPrefillFallback(result.data, conversation, overrides);
                } catch (error) {
                    extractedError = error;
                }

                if (!this.isEmptyMessageContentError(extractedError)) {
                    throw extractedError;
                }

                this.logPipelineStage('chatWithTools 检测到非流式空回复，尝试流式提取兜底', {
                    round: round + 1,
                    diagnostic: extractedError?.diagnostic || null
                });

                const streamingResult = await this.sendStreamingChatRequest(payload, overrides);
                if (!streamingResult.ok) {
                    throw new Error(`AI API 错误: ${streamingResult.status} - ${streamingResult.errorText}`);
                }

                return await this.extractChatContentWithPrefillFallback(streamingResult.data, conversation, overrides);
            }

            conversation.push({
                role: 'assistant',
                content: assistantContent || '',
                tool_calls: toolCalls
            });

            for (const toolCall of toolCalls) {
                const toolName = toolCall?.function?.name || '';
                const handler = handlers[toolName];
                let toolResult;

                if (typeof handler !== 'function') {
                    toolResult = { ok: false, error: `未找到工具处理器: ${toolName}` };
                } else {
                    let parsedArgs = {};
                    try {
                        parsedArgs = toolCall?.function?.arguments ? JSON.parse(toolCall.function.arguments) : {};
                    } catch {
                        parsedArgs = {};
                    }
                    toolResult = await handler(parsedArgs);
                }

                conversation.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolResult, null, 2)
                });
            }
        }

        throw new Error('工具调用轮次过多，已停止继续请求');
    }

    getLastChatRawText() {
        return this.lastChatRawText || '';
    }

    getLastChatRawResponse() {
        return this.lastChatRawResponse || null;
    }

    async debugChat(messages, overrides = {}) {
        const payload = this.buildChatPayload(messages, overrides);
        const result = await this.sendChatRequest(payload, overrides);
        if (!result.ok) {
            throw new Error(`AI API 错误: ${result.status} - ${result.errorText}`);
        }

        const extraction = this.buildChatExtractionResult(result.data);
        return {
            payload,
            rawResponse: result.data,
            extraction,
            formatted: this.formatChatResponseResult(result.data, extraction)
        };
    }

    /**
     * 更新配置
     */
    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
    }
}
