import test from 'node:test';
import assert from 'node:assert/strict';

import { MessageRuntime } from '../src/runtime.js';
import { PromptBuilder } from '../src/prompt.js';
import { buildChatRuntimePreview } from '../src/runtime/chat-preview.js';
import { WorldBookManager } from '../src/worldbook.js';
import { AIClient } from '../src/ai.js';
import {
    buildParticipantProfilePrompt,
    buildParticipantProfileAIOverrides,
    shouldUseIdleParticipantProfileTrigger,
    shouldUseIntervalParticipantProfileTrigger,
    getParticipantProfileTimerKey,
    buildParticipantProfileMergePrompt
} from '../src/participant-profile-runtime.js';
import {
    appendMentionTaskToPromptMessages,
    buildAIToolContext,
    buildVoicePrefaceText,
    generateMentionTextFromPrompt
} from '../src/tools.js';

function jsonResponse(payload, init = {}) {
    return new Response(JSON.stringify(payload), {
        status: init.status || 200,
        statusText: init.statusText || 'OK',
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
}

function createServices(config = {}) {
    const characterManager = {
        readFromPng(name) {
            return {
                name,
                description: '角色描述',
                personality: '冷静',
                scenario: '测试场景',
                system_prompt: '角色系统提示',
                first_mes: '开场白'
            };
        }
    };

    const worldBookManager = {
        currentWorldBook: null,
        readWorldBook(name) {
            if (!name) {
                return null;
            }

            return {
                name,
                entries: [
                    { content: '世界书条目A' }
                ]
            };
        },
        matchEntries(worldBook) {
            return worldBook?.entries || [];
        }
    };

    const promptBuilder = new PromptBuilder(characterManager, worldBookManager, config);

    return {
        config,
        characterManager,
        worldBookManager,
        promptBuilder
    };
}

test('message runtime forwards batch memoryScope to processor', async () => {
    const calls = [];
    const runtime = new MessageRuntime({
        chat: {
            bufferWindowMs: 5,
            replyDelayMs: 0,
            dedupeWindowMs: 1000,
            maxConcurrentSessions: 1
        }
    }, {
        debug() {},
        error() {}
    }, async (batch) => {
        calls.push(batch);
    });

    try {
        runtime.enqueue({
            sessionKey: 'global_shared_memory',
            memoryScope: {
                sessionKey: 'global_shared_memory',
                scopeType: 'global_shared',
                scopeLabel: '全局共享记忆'
            },
            dedupeKey: 'global_shared_memory:1',
            event: { message_id: 1 },
            plainText: '1',
            structuredText: '[群聊] 1',
            triggerReason: 'keyword'
        });

        await new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const timer = setInterval(() => {
                if (calls.length > 0) {
                    clearInterval(timer);
                    resolve();
                    return;
                }
                if (Date.now() - startedAt > 1000) {
                    clearInterval(timer);
                    reject(new Error('runtime batch was not processed'));
                }
            }, 5);
        });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].sessionKey, 'global_shared_memory');
        assert.deepEqual(calls[0].memoryScope, {
            sessionKey: 'global_shared_memory',
            scopeType: 'global_shared',
            scopeLabel: '全局共享记忆'
        });
    } finally {
        runtime.destroy();
    }
});

test('participant profile prompt uses only new messages in messages_only mode', () => {
    const prompt = buildParticipantProfilePrompt({
        existing: {
            content: '旧画像不应出现'
        },
        messages: [
            { sessionId: 's1', role: 'user', content: '第一句' },
            { sessionId: 's2', role: 'assistant', content: '第二句' }
        ]
    }, 'messages_only');

    assert.match(prompt, /仅允许依据这些新增消息总结/);
    assert.match(prompt, /\[s1\] user: 第一句/);
    assert.match(prompt, /\[s2\] assistant: 第二句/);
    assert.doesNotMatch(prompt, /旧画像不应出现/);
    assert.doesNotMatch(prompt, /已有档案如下/);
});

test('participant profile prompt includes prior profile in profile_plus_messages mode', () => {
    const prompt = buildParticipantProfilePrompt({
        existing: {
            content: '稳定画像: 旧档案'
        },
        messages: [
            { sessionId: 's3', role: 'user', content: '第三句' }
        ]
    }, 'profile_plus_messages');

    assert.match(prompt, /已有档案如下：\n稳定画像: 旧档案/);
    assert.match(prompt, /\[s3\] user: 第三句/);
    assert.match(prompt, /增量更新人物档案/);
});

test('participant profile merge prompt keeps one profile and prefers new version on conflicts', () => {
    const prompt = buildParticipantProfileMergePrompt({
        participantId: '2661097662',
        participantName: 'NewJanZ',
        oldProfile: '旧档案: 稳定画像 A',
        newProfile: '新版本: 当前状态 B'
    });

    assert.match(prompt, /2661097662/);
    assert.match(prompt, /NewJanZ/);
    assert.match(prompt, /旧档案: 稳定画像 A/);
    assert.match(prompt, /新版本: 当前状态 B/);
    assert.match(prompt, /只保留一个最终档案/);
    assert.match(prompt, /新版本 > 旧档案/);
});

test('participant profile AI overrides only include configured fields', () => {
    assert.deepEqual(buildParticipantProfileAIOverrides({
        model: 'profile-model',
        baseUrl: '',
        apiKey: 'profile-key',
        providerId: 'cloud-main'
    }), {
        model: 'profile-model',
        apiKey: 'profile-key'
    });

    assert.deepEqual(buildParticipantProfileAIOverrides({
        model: '',
        baseUrl: '',
        apiKey: ''
    }), {});
});

test('participant profile trigger helpers match trigger mode', () => {
    assert.equal(shouldUseIdleParticipantProfileTrigger({ triggerMode: 'idle' }), true);
    assert.equal(shouldUseIdleParticipantProfileTrigger({ triggerMode: 'both' }), true);
    assert.equal(shouldUseIdleParticipantProfileTrigger({ triggerMode: 'interval' }), false);

    assert.equal(shouldUseIntervalParticipantProfileTrigger({ triggerMode: 'interval' }), true);
    assert.equal(shouldUseIntervalParticipantProfileTrigger({ triggerMode: 'both' }), true);
    assert.equal(shouldUseIntervalParticipantProfileTrigger({ triggerMode: 'idle' }), false);
});

test('buildVoicePrefaceText returns a direct voice notice with preview', () => {
    assert.equal(buildVoicePrefaceText(''), '我给你发了一条语音，请听一下。');
    assert.equal(buildVoicePrefaceText('  你好呀  '), '我给你发了一条语音：你好呀');
    assert.match(buildVoicePrefaceText('a'.repeat(60)), /^我给你发了一条语音：a+…$/);
});

test('appendMentionTaskToPromptMessages appends mention instructions to the last user message', () => {
    const result = appendMentionTaskToPromptMessages({
        messages: [
            { role: 'system', content: '角色系统提示' },
            { role: 'user', content: '原始输入' }
        ],
        groupId: '123',
        targetUserId: '456',
        targetName: '犬皇',
        promptText: '问问他是谁'
    });

    assert.equal(result.length, 2);
    assert.equal(result[0].content, '角色系统提示');
    assert.match(result[1].content, /原始输入/);
    assert.match(result[1].content, /当前任务不是继续普通对话/);
    assert.match(result[1].content, /目标群号: 123/);
    assert.match(result[1].content, /目标成员: 犬皇 \(456\)/);
    assert.match(result[1].content, /管理员要求: 问问他是谁/);
    assert.match(result[1].content, /必须保持当前角色卡、世界书、设定与语气/);
});

test('generateMentionTextFromPrompt uses injected prompt messages and preserves ai options', async () => {
    const calls = [];
    const aiClient = {
        async chat(messages, aiOptions) {
            calls.push({ messages, aiOptions });
            return '  角色化的主动@回复  ';
        },
        getVisibleResponseContent(result) {
            return typeof result === 'string' ? result : (result?.content || '');
        }
    };

    const result = await generateMentionTextFromPrompt({
        aiClient,
        groupId: '123',
        targetUserId: '456',
        targetName: '犬皇',
        promptText: '问问他是谁',
        aiOptions: { model: 'mention-model' },
        buildPromptMessages({ groupId, targetUserId, targetName, promptText }) {
            return appendMentionTaskToPromptMessages({
                messages: [
                    { role: 'system', content: '角色系统提示' },
                    { role: 'user', content: '群聊历史上下文' }
                ],
                groupId,
                targetUserId,
                targetName,
                promptText
            });
        }
    });

    assert.equal(result.generatedMessage, '角色化的主动@回复');
    assert.equal(result.groupId, '123');
    assert.equal(result.targetUserId, '456');
    assert.equal(result.usedPromptBuilder, true);
    assert.equal(result.finalMessageCount, 2);
    assert.deepEqual(result.prompt, {
        length: 5,
        preview: '问问他是谁'
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].aiOptions.model, 'mention-model');
    assert.equal(calls[0].messages[0].content, '角色系统提示');
    assert.match(calls[0].messages[1].content, /群聊历史上下文/);
    assert.match(calls[0].messages[1].content, /当前任务不是继续普通对话/);
    assert.match(calls[0].messages[1].content, /管理员要求: 问问他是谁/);
});

test('buildAIToolContext send_group_mention uses unified mentionGenerator when provided', async () => {
    const mentionCalls = [];
    const toolContext = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    sendMention: { enabled: true }
                }
            }
        },
        defaultGroupId: '123',
        defaultTargetUserId: '456',
        defaultTargetName: '犬皇',
        mentionGenerator: async (payload) => {
            mentionCalls.push(payload);
            return {
                ok: true,
                groupId: payload.groupId,
                targetUserId: payload.targetUserId,
                generatedMessage: '统一链路生成的回复'
            };
        }
    });

    const result = await toolContext.handlers.send_group_mention({
        prompt: '问问他是谁'
    });

    assert.equal(toolContext.tools.some((tool) => tool.function?.name === 'send_group_mention'), true);
    assert.deepEqual(mentionCalls, [{
        groupId: '123',
        targetUserId: '456',
        targetName: '犬皇',
        promptText: '问问他是谁'
    }]);
    assert.deepEqual(result, {
        ok: true,
        groupId: '123',
        targetUserId: '456',
        generatedMessage: '统一链路生成的回复'
    });
});

test('buildAIToolContext send_group_mention still rejects @all and empty prompt', async () => {
    const toolContext = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    sendMention: { enabled: true }
                }
            }
        },
        defaultGroupId: '123'
    });

    const rejectAll = await toolContext.handlers.send_group_mention({
        targetUserId: 'all',
        prompt: '提醒一下'
    });
    assert.equal(rejectAll.ok, false);
    assert.match(rejectAll.error, /不能是 @all/);

    const rejectEmptyPrompt = await toolContext.handlers.send_group_mention({
        targetUserId: '456',
        prompt: '   '
    });
    assert.equal(rejectEmptyPrompt.ok, false);
    assert.match(rejectEmptyPrompt.error, /不能为空/);
});

test('buildAIToolContext exposes mode-gated search and text tool instructions', () => {
    const toolContext = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    webSearch: {
                        enabled: true,
                        provider: 'bing',
                        maxResults: 5,
                        timeoutMs: 10000,
                        maxSnippetLength: 800
                    },
                    textToolFallback: {
                        enabled: true,
                        maxRounds: 3
                    }
                }
            }
        }
    });

    const hint = toolContext.toolHints.join('\n');
    assert.match(hint, /chat=普通群聊\/角色扮演\/情绪接话，不搜/);
    assert.match(hint, /browse=最新信息\/外部事实\/资料核验/);
    assert.match(hint, /水群、玩梗、低信息、QQ表情、戳一戳/);
    assert.match(hint, /不要泄露工具 JSON、参数、工具名/);

    assert.equal(toolContext.textToolFallback.enabled, true);
    assert.match(toolContext.textToolFallback.instruction, /chat=普通群聊闲聊，不调用工具/);
    assert.match(toolContext.textToolFallback.instruction, /browse=最新\/外部事实\/资料核验，调用 web_search/);
    assert.match(toolContext.textToolFallback.instruction, /final 只写给用户看的正文/);
});

test('AI client applies per-call participant profile overrides to payload and headers', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({
            url,
            headers: options.headers,
            body: JSON.parse(options.body)
        });
        return jsonResponse({
                choices: [{
                    message: {
                        content: 'override ok'
                    }
                }]
            });
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'global-key',
        model: 'global-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    const result = await client.chat(
        [{ role: 'user', content: '为人物建档' }],
        {
            baseUrl: 'https://profile.example.com/v1',
            apiKey: 'profile-key',
            model: 'profile-model',
            maxTokens: 2048,
            temperature: 0.2
        }
    );

    assert.equal(result.content, 'override ok');
    assert.equal(result.rawContent, 'override ok');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://profile.example.com/v1/chat/completions');
    assert.equal(requests[0].headers.Authorization, 'Bearer profile-key');
    assert.equal(requests[0].body.model, 'profile-model');
    assert.equal(requests[0].body.max_tokens, 2048);
    assert.equal(requests[0].body.temperature, 0.2);
});

test('AI client backup provider does not reuse primary provider api key', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({
            url: String(url),
            headers: options.headers,
            body: JSON.parse(options.body)
        });
        if (String(url) === 'https://primary.example/v1/chat/completions') {
            return jsonResponse({ error: { message: 'primary failed' } }, { status: 500 });
        }
        return jsonResponse({
            choices: [{
                message: {
                    content: 'backup ok'
                }
            }]
        });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://primary.example/v1',
            apiKey: 'primary-key',
            model: 'primary-model',
            maxTokens: 1024,
            temperature: 0.7,
            providers: [{
                id: 'backup-provider',
                baseUrl: 'https://backup.example/v1',
                apiKey: '',
                model: 'backup-model'
            }],
            chat: {
                backupModelProviderId: 'backup-provider',
                backupModel: 'backup-model'
            }
        });

        const result = await client.chat([{ role: 'user', content: 'try backup' }]);

        assert.equal(result.content, 'backup ok');
        assert.equal(requests.length, 2);
        assert.equal(requests[0].url, 'https://primary.example/v1/chat/completions');
        assert.equal(requests[0].headers.Authorization, 'Bearer primary-key');
        assert.equal(requests[1].url, 'https://backup.example/v1/chat/completions');
        assert.equal(requests[1].headers.Authorization, undefined);
        assert.equal(requests[1].body.model, 'backup-model');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('AI client chatWithTools keeps backup provider for tool follow-up', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const request = {
            url: String(url),
            headers: options.headers,
            body: JSON.parse(options.body)
        };
        requests.push(request);

        if (request.url === 'https://primary.example/v1/chat/completions') {
            return jsonResponse({ error: { message: 'primary failed' } }, { status: 500 });
        }

        const backupCount = requests.filter((item) => item.url === 'https://backup.example/v1/chat/completions').length;
        if (backupCount === 1) {
            return jsonResponse({
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'tool-1',
                            type: 'function',
                            function: {
                                name: 'web_search',
                                arguments: '{"query":"backup search","limit":1}'
                            }
                        }]
                    }
                }]
            });
        }

        return jsonResponse({
            choices: [{
                message: {
                    content: 'backup tool final'
                }
            }]
        });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://primary.example/v1',
            apiKey: 'primary-key',
            model: 'primary-model',
            maxTokens: 1024,
            temperature: 0.7,
            providers: [{
                id: 'backup-provider',
                baseUrl: 'https://backup.example/v1',
                apiKey: 'backup-key',
                model: 'backup-model'
            }],
            chat: {
                backupModelProviderId: 'backup-provider',
                backupModel: 'backup-model'
            }
        });

        const toolCalls = [];
        const result = await client.chatWithTools(
            [{ role: 'user', content: 'use backup and tool' }],
            {
                tools: [{
                    type: 'function',
                    function: {
                        name: 'web_search',
                        description: 'search web',
                        parameters: { type: 'object' }
                    }
                }],
                handlers: {
                    async web_search(args) {
                        toolCalls.push(args);
                        return { ok: true, results: [{ title: 'result' }] };
                    }
                }
            }
        );

        assert.equal(result.content, 'backup tool final');
        assert.equal(requests.length, 3);
        assert.deepEqual(requests.map((request) => request.url), [
            'https://primary.example/v1/chat/completions',
            'https://backup.example/v1/chat/completions',
            'https://backup.example/v1/chat/completions'
        ]);
        assert.equal(requests[0].headers.Authorization, 'Bearer primary-key');
        assert.equal(requests[1].headers.Authorization, 'Bearer backup-key');
        assert.equal(requests[2].headers.Authorization, 'Bearer backup-key');
        assert.equal(requests[0].body.model, 'primary-model');
        assert.equal(requests[1].body.model, 'backup-model');
        assert.equal(requests[2].body.model, 'backup-model');
        assert.equal(requests[2].body.messages.at(-2).tool_calls[0].function.name, 'web_search');
        assert.equal(requests[2].body.messages.at(-1).role, 'tool');
        assert.deepEqual(toolCalls, [{ query: 'backup search', limit: 1 }]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('AI client chatWithTools uses text fallback on degraded function error', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const request = {
            url: String(url),
            headers: options.headers,
            body: JSON.parse(options.body)
        };
        requests.push(request);

        if (Array.isArray(request.body.tools)) {
            return jsonResponse({
                error: { message: 'degraded function cannot be invoked in this model' }
            }, { status: 400 });
        }

        return jsonResponse({
            choices: [{
                message: {
                    content: '{"action":"final","content":"fallback final"}'
                }
            }]
        });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'global-key',
            model: 'global-model',
            maxTokens: 1024,
            temperature: 0.7
        });

        const result = await client.chatWithTools(
            [{ role: 'user', content: 'search with fallback' }],
            {
                tools: [{
                    type: 'function',
                    function: {
                        name: 'web_search',
                        description: 'search web',
                        parameters: { type: 'object' }
                    }
                }],
                handlers: {},
                textToolFallback: {
                    enabled: true,
                    maxRounds: 2,
                    instruction: 'Return JSON with action final or tool_calls.'
                }
            }
        );

        assert.equal(result.content, 'fallback final');
        assert.equal(requests.length, 2);
        assert.equal(Array.isArray(requests[0].body.tools), true);
        assert.equal(Array.isArray(requests[1].body.tools), false);
        assert.equal(requests[1].body.messages[0].content, 'Return JSON with action final or tool_calls.');
        assert.equal(requests[1].body.model, 'global-model');
        assert.equal(requests[1].headers.Authorization, 'Bearer global-key');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('AI client listModels honors explicit empty api key override', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), headers: options.headers });
        return jsonResponse({ data: [{ id: 'model-a' }] });
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://global.example/v1',
            apiKey: 'global-key',
            model: 'global-model'
        });

        const models = await client.listModels({
            baseUrl: 'https://provider.example/v1',
            apiKey: ''
        });

        assert.equal(models[0].id, 'model-a');
        assert.equal(requests[0].url, 'https://provider.example/v1/models');
        assert.equal(requests[0].headers.Authorization, undefined);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('AI client chatWithTools executes one tool call and follows up with tool result', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (requests.length === 1) {
            const payload = {
                choices: [{
                    message: {
                        content: null,
                        tool_calls: [{
                            id: 'tool-1',
                            type: 'function',
                            function: {
                                name: 'web_search',
                                arguments: '{"query":"最新 AI 新闻","limit":2}'
                            }
                        }]
                    }
                }]
            };
            return {
                ok: true,
                text: async () => JSON.stringify(payload)
            };
        }

        const payload = {
            choices: [{
                message: {
                    content: '这是整合后的最终回复'
                }
            }]
        };
        return {
            ok: true,
            text: async () => JSON.stringify(payload)
        };
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'global-key',
        model: 'global-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    const toolCalls = [];
    const result = await client.chatWithTools(
        [{ role: 'user', content: '帮我搜索最新 AI 新闻' }],
        {
            tools: [{
                type: 'function',
                function: {
                    name: 'web_search',
                    description: '搜索网页',
                    parameters: { type: 'object' }
                }
            }],
            handlers: {
                async web_search(args) {
                    toolCalls.push(args);
                    return {
                        ok: true,
                        results: [{ title: '新闻A', url: 'https://example.com/a', snippet: '摘要A' }]
                    };
                }
            }
        }
    );

    assert.equal(result.content, '这是整合后的最终回复');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.tools[0].function.name, 'web_search');
    assert.equal(requests[1].body.messages.at(-2).role, 'assistant');
    assert.equal(requests[1].body.messages.at(-2).tool_calls[0].function.name, 'web_search');
    assert.equal(requests[1].body.messages.at(-1).role, 'tool');
    assert.deepEqual(JSON.parse(requests[1].body.messages.at(-1).content), {
        ok: true,
        results: [{ title: '新闻A', url: 'https://example.com/a', snippet: '摘要A' }]
    });
    assert.deepEqual(toolCalls, [{ query: '最新 AI 新闻', limit: 2 }]);
});

test('AI client chatWithTools falls back to chat when no tools are exposed', async () => {
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return jsonResponse({
                choices: [{
                    message: {
                        content: '普通回复'
                    }
                }]
            });
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'global-key',
        model: 'global-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    const result = await client.chatWithTools([
        { role: 'user', content: '你好' }
    ], {
        tools: [],
        handlers: {}
    });

    assert.equal(result.content, '普通回复');
    assert.equal(requests.length, 1);
    assert.equal(Array.isArray(requests[0].body.tools), false);
    assert.equal(requests[0].body.model, 'global-model');
    assert.equal(requests[0].body.max_tokens, 1024);
    assert.equal(requests[0].body.temperature, 0.7);
});

test('AI client falls back to reasoning_content when content is null', async () => {
    globalThis.fetch = async () => jsonResponse({
            choices: [{
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content: null,
                    reasoning_content: '基于上下文的正常回复',
                    tool_calls: []
                }
            }]
    });

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    const result = await client.chat([{ role: 'user', content: '你好' }]);
    assert.equal(result.content, '基于上下文的正常回复');
    assert.equal(result.reasoningContent, '基于上下文的正常回复');
    assert.equal(result.rawReasoningContent, '基于上下文的正常回复');
});

test('AI client falls back to retry without trailing assistant prefill on empty response', async () => {
    const requests = [];
    const responses = [
        {
            response: jsonResponse({
                model: 'prefill-sensitive-model',
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: null,
                        reasoning_content: null,
                        tool_calls: null
                    }
                }]
            })
        },
        {
            response: jsonResponse({
                model: 'prefill-sensitive-model',
                choices: [{
                    finish_reason: 'stop',
                    message: {
                        role: 'assistant',
                        content: '移除 prefill 后恢复正常'
                    }
                }]
            })
        }
    ];

    const infoLogs = [];
    globalThis.fetch = async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return responses.shift().response;
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    }, {
        info(message, details) {
            infoLogs.push({ message, details });
        }
    });

    const result = await client.chat([
        { role: 'system', content: '系统提示', meta: { source: 'runtime_composition' } },
        { role: 'user', content: '你好', meta: { source: 'user_input' } },
        { role: 'assistant', content: '助手预填充', meta: { source: 'assistant_prefill', sourceId: 'assistant-prefill' } }
    ]);

    assert.equal(result.content, '移除 prefill 后恢复正常');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].messages.length, 3);
    assert.equal(requests[0].messages.at(-1).role, 'assistant');
    assert.equal(requests[1].messages.length, 2);
    assert.equal(requests[1].messages.at(-1).role, 'user');
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 检测到 assistant_prefill 触发空回复，移除尾部预填充后重试'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 尝试无 assistant_prefill 重试 payload'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 无 assistant_prefill 重试成功，准备提取内容'));
});

test('AI client throws when response message content is null', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
            return jsonResponse({
                    choices: [{
                        finish_reason: 'stop',
                        message: {
                            role: 'assistant',
                            content: null,
                            refusal: 'blocked'
                        }
                    }]
                });
        }

        return {
            ok: true,
            body: {
                getReader() {
                    return {
                        async read() {
                            return { done: true, value: undefined };
                        }
                    };
                }
            }
        };
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    await assert.rejects(
        async () => {
            try {
                await client.chat([{ role: 'user', content: '你好' }]);
            } catch (error) {
                assert.equal(error.diagnostic.choiceCount, 1);
                assert.equal(error.diagnostic.requestedModel, 'test-model');
                assert.equal(error.diagnostic.responseModel, 'test-model');
                assert.equal(error.diagnostic.finishReason, 'stop');
                assert.deepEqual(error.diagnostic.messageKeys, ['role', 'content', 'reasoning_content', 'tool_calls']);
                assert.equal(error.diagnostic.contentType, 'object');
                assert.equal(error.diagnostic.contentPreview, null);
                assert.equal(error.diagnostic.reasoningContentType, 'object');
                assert.equal(error.diagnostic.reasoningContentPreview, null);
                assert.equal(error.diagnostic.hasToolCalls, false);
                assert.equal(error.diagnostic.refusal, null);
                assert.equal(error.diagnostic.rawContent, null);
                assert.equal(error.diagnostic.rawReasoningContent, null);
                assert.deepEqual(error.diagnostic.rawMessage, {
                    role: 'assistant',
                    content: null,
                    reasoning_content: null,
                    tool_calls: null
                });
                throw error;
            }
        },
        /AI API 返回了空消息内容/
    );
});

test('AI client diagnostic includes requested and response model names', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
            return jsonResponse({
                    model: 'mapped-response-model',
                    choices: [{
                        finish_reason: 'stop',
                        message: {
                            role: 'assistant',
                            content: null,
                            reasoning_content: null,
                            tool_calls: null
                        }
                    }]
                });
        }

        return {
            ok: true,
            body: {
                getReader() {
                    return {
                        async read() {
                            return { done: true, value: undefined };
                        }
                    };
                }
            }
        };
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'requested-model',
        maxTokens: 1024,
        temperature: 0.7
    });

    await assert.rejects(
        async () => {
            try {
                await client.chat([{ role: 'user', content: '你好' }]);
            } catch (error) {
                assert.equal(error.diagnostic.requestedModel, 'requested-model');
                assert.equal(error.diagnostic.responseModel, 'requested-model');
                throw error;
            }
        },
        /AI API 返回了空消息内容/
    );
});

test('AI client emits execution stage logs during chat', async () => {
    const infoLogs = [];
    globalThis.fetch = async () => jsonResponse({
            model: 'logged-model',
            choices: [{
                finish_reason: 'stop',
                message: {
                    role: 'assistant',
                    content: '正常回复',
                    tool_calls: []
                }
            }]
    });

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    }, {
        info(message, details) {
            infoLogs.push({ message, details });
        }
    });

    const result = await client.chat([
        { role: 'system', content: '系统提示', meta: { source: 'runtime_composition' } },
        { role: 'user', content: '你好', meta: { source: 'user_input' } },
        { role: 'assistant', content: '', meta: { source: 'assistant_prefill', sourceId: 'assistant-prefill' } }
    ]);

    assert.equal(result.content, '正常回复');
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 开始执行 chat'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 已构建主请求 payload'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 准备发送 chat/completions'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 收到 chat/completions 响应'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 已解析 chat/completions 响应体'));
    assert.ok(infoLogs.some((entry) => entry.message === '[AI执行] 开始提取回复内容'));
    const startChatLog = infoLogs.find((entry) => entry.message === '[AI执行] 开始执行 chat');
    assert.equal(startChatLog.details.messageTrace.at(-1).role, 'assistant');
    assert.equal(startChatLog.details.messageTrace.at(-1).source, 'assistant_prefill');
});

test('buildChatRuntimePreview returns structured sources, messages, and effective binding', async () => {
    const config = {
        preset: {
            enabled: true,
            name: 'Global Default',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '全局主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'post-history', name: 'Post-History', role: 'system', content: '历史后提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
            ]
        },
        regex: {
            rules: [{ id: 'legacy-global-rule' }]
        },
        bindings: {
            global: {
                worldbook: 'global-world.json',
                preset: null,
                regexRules: [{ id: 'global-rule' }],
                memoryDbPath: null
            },
            characters: {
                '角色A': {
                    worldbook: null,
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: '角色主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                            { identifier: 'post-history', name: 'Post-History', role: 'system', content: '角色历史后提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                            { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '角色助手预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                        ],
                        regexRules: [{ id: 'character-preset-rule' }]
                    },
                    regexRules: null,
                    importedFromCard: {
                        worldbook: 'card-world.json',
                        preset: null,
                        regexRules: [{ id: 'card-rule' }]
                    }
                }
            }
        },
        context: {
            enabled: true,
            includeSessionFacts: true,
            includeParticipants: true,
            includeReplyReference: true,
            includeRecentUserIntent: true
        }
    };

    const preview = await buildChatRuntimePreview({
        characterName: '角色A',
        userMessage: '你好',
        context: {
            recentMessages: [
                { role: 'user', content: '历史用户消息' }
            ],
            summaries: [
                { content: '摘要A' }
            ]
        },
        runtimeContext: {}
    }, createServices(config));

    assert.equal(Array.isArray(preview.sources), true);
    assert.equal(Array.isArray(preview.messages), true);
    assert.equal(preview.effectiveBinding.worldbook, 'card-world.json');
    assert.equal(preview.effectiveBinding.preset.name, 'Character Preset');
    assert.equal(preview.bindingTrace.worldbook.source, 'imported_from_card');
    assert.equal(preview.bindingTrace.preset.source, 'character_binding');
    assert.deepEqual(preview.bindingTrace.preset.layers, ['character_binding']);
    assert.equal(preview.bindingTrace.preset.itemSources['identifier:main'], 'character_binding');
    assert.equal(preview.bindingTrace.preset.itemSources['identifier:post-history'], 'character_binding');
    assert.equal(preview.bindingTrace.preset.itemSources['identifier:assistant-prefill'], 'character_binding');
    assert.deepEqual(preview.bindingTrace.preset.lockedIdentifiers, []);
    assert.equal(preview.bindingTrace.regexRules.source, 'imported_from_card');
    assert.equal(preview.bindingTrace.regexRules.count, 1);
    assert.equal(preview.bindingTrace.presetRegexRules.source, 'character_binding');
    assert.deepEqual(preview.bindingTrace.presetRegexRules.layers, ['character_binding']);
    assert.equal(preview.bindingTrace.presetRegexRules.count, 1);
    assert.equal(preview.bindingTrace.globalRegexRules.source, 'global');
    assert.equal(preview.bindingTrace.globalRegexRules.count, 1);
    assert.equal(preview.effectiveBinding.regexRules[0].id, 'card-rule');
    assert.equal(preview.effectiveBinding.presetRegexRules[0].id, 'character-preset-rule');
    assert.equal(preview.effectiveBinding.globalRegexRules[0].id, 'global-rule');
    assert.equal(preview.sources.some((source) => source.kind === 'character_description'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'character_system_prompt'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'summary'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'preset_pre_system'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'preset_post_history'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'preset_assistant'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'worldbook_entry'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'history_message'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'user_input'), true);
    assert.equal(preview.sources.find((source) => source.kind === 'user_input')?.stage, 'input');
    assert.equal(preview.sources.find((source) => source.kind === 'summary')?.stage, 'memory');
    assert.equal(preview.sources.find((source) => source.kind === 'preset_pre_system')?.stage, 'preset');
    assert.equal(preview.sources.find((source) => source.kind === 'preset_pre_system')?.sourceSlot, 'system');
    assert.equal(preview.sources.find((source) => source.kind === 'preset_post_history')?.sourceSlot, 'post_history');
    assert.equal(preview.sources.find((source) => source.kind === 'current_message_focus')?.sourceSlot, 'current_message_focus');
    assert.equal(preview.sources.find((source) => source.kind === 'preset_assistant')?.sourceSlot, 'assistant_prefill');
    assert.equal(preview.sources.find((source) => source.kind === 'history_message')?.sourceSlot, 'history');
    assert.equal(preview.sources.find((source) => source.kind === 'user_input')?.sourceSlot, 'user_input');
    assert.equal(Array.isArray(preview.messageTrace), true);
    assert.equal(preview.messageTrace[0].role, 'system');
    assert.equal(preview.messageTrace[0].sourceStages.includes('preset'), true);
    assert.equal(preview.messageTrace[0].sourceStages.includes('character'), true);
    assert.equal(preview.messageTrace[0].sourceStages.includes('worldbook'), true);
    assert.equal(preview.messageTrace[0].sourceIds.includes('main'), true);
    assert.equal(preview.messageTrace[0].sourceIds.includes('character-description'), true);
    assert.equal(preview.messageTrace[0].sourceIds.includes('worldbook-0'), true);
    assert.equal(preview.messageTrace[0].sourceSlots.includes('system'), true);
    assert.equal(preview.messages[0].role, 'system');
    assert.match(preview.messages[0].content, /角色主提示/);
    assert.doesNotMatch(preview.messages[0].content, /角色历史后提示/);
    assert.equal(preview.messages[1].role, 'user');
    assert.equal(preview.messages[1].content, '历史用户消息');
    assert.equal(preview.messages[2].role, 'system');
    assert.equal(preview.messages[2].content, '角色历史后提示');
    assert.equal(preview.messages[3].role, 'system');
    assert.equal(preview.messages[3].meta?.source, 'current_message_focus');
    assert.equal(preview.messages[4].role, 'user');
    assert.equal(preview.messages[4].content, '你好');
    assert.equal(preview.messages[5].role, 'assistant');
    assert.equal(preview.messages[5].content, '角色助手预填充');
    assert.equal(preview.runtimeComposition.systemSegments.some((segment) => segment.kind === 'preset_pre_system'), true);
    assert.equal(preview.runtimeComposition.postHistorySegments.some((segment) => segment.kind === 'preset_post_history'), true);
    assert.equal(preview.runtimeComposition.assistantPrefillSegments.some((segment) => segment.kind === 'preset_assistant'), true);
});


test('buildChatRuntimePreview exposes history injection segments and marker metadata', async () => {
    const config = {
        preset: {
            enabled: true,
            name: 'Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'depth-1', name: 'Depth Prompt', role: 'system', content: '插入历史后', enabled: true, injection_position: 0, injection_depth: 1, forbid_overrides: true, marker: true, system_prompt: true },
                { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手补全', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
            ]
        },
        context: {
            enabled: false
        }
    };

    const preview = await buildChatRuntimePreview({
        characterName: '角色A',
        userMessage: '你好',
        context: {
            recentMessages: [
                { role: 'user', content: '历史消息1' },
                { role: 'assistant', content: '历史消息2' }
            ],
            summaries: []
        },
        runtimeContext: {}
    }, createServices(config));

    assert.equal(preview.sources.some((source) => source.kind === 'preset_marker'), true);
    assert.equal(preview.runtimeComposition.historyInjectionSegments.length, 1);
    assert.equal(preview.runtimeComposition.historyInjectionSegments[0].id, 'depth-1');
    assert.equal(preview.runtimeComposition.historyInjectionSegments[0].meta.marker, true);
    assert.equal(preview.runtimeComposition.historyInjectionSegments[0].meta.forbid_overrides, true);
    assert.equal(preview.runtimeComposition.historyInjectionSegments[0].meta.insertionIndex, 1);
    assert.equal(preview.sources.find((source) => source.id === 'depth-1')?.sourceSlot, 'in_chat');
    assert.equal(preview.messageTrace[2].sourceSlots.includes('in_chat'), true);
    assert.equal(preview.messages[2].role, 'system');
    assert.equal(preview.messages[2].content, '插入历史后');
    assert.equal(preview.messageTrace[2].sourceIds.includes('depth-1'), true);
});

test('buildChatRuntimePreview places worldbook entries into explicit runtime slots', async () => {
    const config = {
        preset: {
            enabled: true,
            name: 'Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'post-history', name: 'Post-History', role: 'system', content: '后历史提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ]
        },
        bindings: {
            global: {
                worldbook: 'global-world.json',
                preset: null,
                regexRules: [],
                memoryDbPath: null
            },
            characters: {}
        },
        context: {
            enabled: false
        }
    };

    const services = createServices(config);
    services.worldBookManager.readWorldBook = (name) => ({
        name,
        entries: [
            { key: 'system-entry', content: '系统位世界书', position: 0 },
            { key: 'post-history-entry', content: '历史后世界书', position: 1 }
        ]
    });
    services.worldBookManager.matchEntries = (worldBook) => worldBook?.entries || [];

    const preview = await buildChatRuntimePreview({
        characterName: '角色A',
        userMessage: '你好',
        context: {
            recentMessages: [{ role: 'user', content: '历史用户消息' }],
            summaries: []
        },
        runtimeContext: {}
    }, services);

    const systemWorldbook = preview.sources.find((source) => source.id === 'worldbook-0');
    const postHistoryWorldbook = preview.sources.find((source) => source.id === 'worldbook-1');

    assert.equal(systemWorldbook?.sourceSlot, 'system');
    assert.equal(systemWorldbook?.meta?.position, 0);
    assert.equal(postHistoryWorldbook?.sourceSlot, 'post_history');
    assert.equal(postHistoryWorldbook?.meta?.position, 1);
    assert.equal(preview.runtimeComposition.systemSegments.some((segment) => segment.id === 'worldbook-0'), true);
    assert.equal(preview.runtimeComposition.postHistorySegments.some((segment) => segment.id === 'worldbook-1'), true);
    assert.equal(preview.messageTrace[0].sourceIds.includes('worldbook-0'), true);
    assert.equal(preview.messageTrace[2].sourceIds.includes('worldbook-1'), true);
    assert.match(preview.messages[2].content, /历史后世界书/);
});

test('buildChatRuntimePreview respects Tavern-style string worldbook positions', async () => {
    const config = {
        preset: {
            enabled: true,
            name: 'Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'post-history', name: 'Post-History', role: 'system', content: '后历史提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ]
        },
        bindings: {
            global: {
                worldbook: 'global-world.json',
                preset: null,
                regexRules: [],
                memoryDbPath: null
            },
            characters: {}
        },
        context: {
            enabled: false
        }
    };

    const services = createServices(config);
    services.worldBookManager.readWorldBook = (name) => ({
        name,
        entries: [
            { key: 'system-entry', content: '系统位世界书', position: 'before_char' },
            { key: 'post-history-entry', content: '历史后世界书', position: 'after_char' }
        ]
    });
    services.worldBookManager.matchEntries = (worldBook) => worldBook?.entries || [];

    const preview = await buildChatRuntimePreview({
        characterName: '角色A',
        userMessage: '你好',
        context: {
            recentMessages: [{ role: 'user', content: '历史用户消息' }],
            summaries: []
        },
        runtimeContext: {}
    }, services);

    const systemWorldbook = preview.sources.find((source) => source.id === 'worldbook-0');
    const postHistoryWorldbook = preview.sources.find((source) => source.id === 'worldbook-1');

    assert.equal(systemWorldbook?.sourceSlot, 'system');
    assert.equal(systemWorldbook?.meta?.position, 0);
    assert.equal(postHistoryWorldbook?.sourceSlot, 'post_history');
    assert.equal(postHistoryWorldbook?.meta?.position, 1);
    assert.equal(preview.runtimeComposition.systemSegments.some((segment) => segment.id === 'worldbook-0'), true);
    assert.equal(preview.runtimeComposition.postHistorySegments.some((segment) => segment.id === 'worldbook-1'), true);
});

test('worldbook matcher supports string keys and string secondary keys from tavern payloads', () => {
    const manager = new WorldBookManager(process.env.TMPDIR || process.env.TEMP || process.env.TMP || process.cwd());
    const matched = manager.matchEntries({
        entries: [
            {
                id: 'entry-1',
                key: 'alpha',
                secondary_keys: 'beta',
                selectiveLogic: 3,
                content: '命中条目',
                order: 10,
                position: 1
            },
            {
                id: 'entry-2',
                key: 'gamma',
                secondary_keys: 'delta',
                selectiveLogic: 3,
                content: '不命中条目',
                order: 5,
                position: 0
            }
        ]
    }, 'alpha beta', 10, new Set());

    assert.equal(matched.length, 1);
    assert.equal(matched[0].key, 'entry-1');
    assert.equal(matched[0].position, 1);
    assert.equal(matched[0].triggeredByKeyword, true);
});

test('worldbook matcher treats Tavern-style string and numeric flags as runtime booleans', () => {
    const manager = new WorldBookManager(process.env.TMPDIR || process.env.TEMP || process.env.TMP || process.cwd());
    const matched = manager.matchEntries({
        entries: [
            {
                id: 'entry-constant',
                key: 'alpha',
                content: '常驻条目',
                constant: 'true',
                order: 30,
                position: 1
            },
            {
                id: 'entry-disabled',
                key: 'beta',
                content: '禁用条目',
                enabled: 'false',
                order: 20,
                position: 0
            },
            {
                id: 'entry-disable-flag',
                key: 'gamma',
                content: '被 disable 条目',
                disable: 1,
                order: 10,
                position: 0
            },
            {
                id: 'entry-normal',
                key: 'alpha',
                content: '普通命中条目',
                enabled: '1',
                order: 25,
                position: 0
            }
        ]
    }, 'alpha', 10, new Set());

    assert.equal(matched.length, 2);
    assert.equal(matched[0].key, 'entry-constant');
    assert.equal(matched[0].isConstant, true);
    assert.equal(matched[0].position, 1);
    assert.equal(matched[1].key, 'entry-normal');
    assert.equal(matched[1].isConstant, false);
    assert.equal(matched.some((entry) => entry.key === 'entry-disabled'), false);
    assert.equal(matched.some((entry) => entry.key === 'entry-disable-flag'), false);
});

test('worldbook matcher normalizes Tavern-style string positions and numeric fields', () => {
    const manager = new WorldBookManager(process.env.TMPDIR || process.env.TEMP || process.env.TMP || process.cwd());
    const matched = manager.matchEntries({
        entries: [
            {
                id: 'entry-post',
                key: 'alpha',
                content: '历史后条目',
                order: '40',
                sticky: '3',
                position: 'after_char'
            },
            {
                id: 'entry-system',
                key: 'alpha',
                content: '系统条目',
                order: '20',
                sticky: '0',
                position: 'before_char'
            }
        ]
    }, 'alpha', 10, new Set());

    assert.equal(matched.length, 2);
    assert.equal(matched[0].key, 'entry-post');
    assert.equal(matched[0].order, 40);
    assert.equal(matched[0].sticky, 3);
    assert.equal(matched[0].position, 1);
    assert.equal(matched[1].key, 'entry-system');
    assert.equal(matched[1].order, 20);
    assert.equal(matched[1].sticky, 0);
    assert.equal(matched[1].position, 0);
});

test('build exposes runtime sources and message trace for backend-composed prompt', async () => {
    const promptBuilder = createServices({
        preset: {
            enabled: true,
            name: 'Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'post-history', name: 'Post-History', role: 'system', content: '后历史提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手补全', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
            ]
        },
        context: {
            enabled: false
        }
    }).promptBuilder;

    const built = await promptBuilder.build(
        '角色B',
        '当前输入',
        {
            recentMessages: [{ role: 'user', content: '旧消息' }],
            summaries: [{ content: '旧摘要' }]
        },
        new Set(),
        {
            recalledEntries: [
                { title: '固定设定', content: '固定召回内容', recallReason: 'fixed_knowledge', sourceKind: 'knowledge_fixed' },
                { title: '动态观察', content: '动态召回内容', recallReason: 'dynamic_knowledge_match', sourceKind: 'knowledge_dynamic' },
                { title: '记忆', content: '普通召回内容', recallReason: 'recent', sourceKind: 'memory_entry' }
            ]
        }
    );

    assert.equal(Array.isArray(built.runtimeSources), true);
    assert.equal(Array.isArray(built.messageTrace), true);
    assert.equal(Array.isArray(built.runtimeComposition.systemSegments), true);
    assert.equal(Array.isArray(built.runtimeComposition.postHistorySegments), true);
    assert.equal(Array.isArray(built.runtimeComposition.assistantPrefillSegments), true);
    assert.equal(built.runtimeSources.some((source) => source.kind === 'database_recall'), true);
    assert.equal(built.runtimeSources.find((source) => source.kind === 'summary')?.sourceSlot, 'system');
    assert.equal(built.runtimeSources.find((source) => source.kind === 'history_message')?.sourceSlot, 'history');
    assert.equal(built.runtimeSources.find((source) => source.kind === 'preset_post_history')?.sourceSlot, 'post_history');
    assert.equal(built.runtimeSources.find((source) => source.kind === 'current_message_focus')?.sourceSlot, 'current_message_focus');
    assert.equal(built.runtimeSources.find((source) => source.kind === 'preset_assistant')?.sourceSlot, 'assistant_prefill');
    assert.equal(built.messageTrace[0].sourceSlots.includes('system'), true);
    assert.equal(built.messageTrace[1].sourceSlots.includes('history'), true);
    assert.equal(built.messageTrace[2].sourceSlots.includes('post_history'), true);
    assert.equal(built.messageTrace[3].sourceSlots.includes('current_message_focus'), true);
    assert.equal(built.messageTrace[4].sourceSlots.includes('user_input'), true);
    assert.equal(built.messageTrace[5].sourceSlots.includes('assistant_prefill'), true);
    assert.equal(built.messageTrace[0].sourceIds.includes('post-history'), false);
    assert.equal(built.messageTrace[2].sourceIds.includes('post-history'), true);
    assert.equal(built.messageTrace[3].sourceIds.includes('current-message-focus'), true);
    assert.equal(built.messageTrace[5].sourceIds.includes('assistant-prefill'), true);
    assert.equal(built.messages[0].content.includes('【固定知识】'), true);
    assert.equal(built.messages[0].content.includes('固定设定: 固定召回内容 [fixed_knowledge]'), true);
    assert.equal(built.messages[0].content.includes('【动态知识】'), true);
    assert.equal(built.messages[0].content.includes('动态观察: 动态召回内容 [dynamic_knowledge_match]'), true);
    assert.equal(built.messages[0].content.includes('【其他召回】'), true);
    assert.equal(built.messages[0].content.includes('记忆: 普通召回内容 [recent]'), true);
});
