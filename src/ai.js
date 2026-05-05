/**
 * AI API 客户端模块
 */

export class AIClient {
    constructor(config) {
        this.config = config;
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

        return `${normalizedBaseUrl}${path}`;
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
        const models = await this.listModels(options);
        const matched = models.find((model) => model.id === modelId || model.name === modelId) || null;

        return {
            model: matched,
            availableModels: models
        };
    }

    /**
     * 调用 AI API
     * @param {Array} messages - 消息数组
     */
    async chat(messages) {
        const headers = this.buildHeaders();
        const apiUrl = this.resolveApiUrl('/chat/completions');
        
        if (!apiUrl) {
            throw new Error('未配置 AI API URL (baseUrl 或 apiUrl)');
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.config.model,
                messages,
                max_tokens: this.config.maxTokens,
                temperature: this.config.temperature,
                stream: false
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`AI API 错误: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        return data.choices[0].message.content;
    }

    async summarize(messages, sessionId = 'default') {
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

        return this.chat(summaryPrompt);
    }

    /**
     * 更新配置
     */
    updateConfig(newConfig) {
        Object.assign(this.config, newConfig);
    }
}
