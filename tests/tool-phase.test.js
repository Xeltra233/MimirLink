import test from 'node:test';
import assert from 'node:assert/strict';

import { AIClient } from '../src/ai.js';
import { buildToolPhaseMessages, buildToolPhaseResultMessage, buildToolPhaseScene } from '../src/tools.js';

function jsonResponse(payload, init = {}) {
    return new Response(JSON.stringify(payload), {
        status: init.status || 200,
        statusText: init.statusText || 'OK',
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
}

function toolCallResponse(name, args, id = 'call-1') {
    return jsonResponse({
        choices: [{
            message: {
                content: '',
                tool_calls: [{
                    id,
                    type: 'function',
                    function: { name, arguments: JSON.stringify(args) }
                }]
            }
        }]
    });
}

function textResponse(text) {
    return jsonResponse({
        choices: [{ message: { content: text } }]
    });
}

test('chatToolPhase 执行工具调用并返回转写，不产正式回复', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    const executed = [];

    globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        if (requests.length === 1) {
            return toolCallResponse('web_search', { query: '最新政策', limit: 3 });
        }
        return textResponse('已拿到资料');
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'm',
            maxTokens: 1024,
            temperature: 0.7
        });

        const outcome = await client.chatToolPhase(
            [
                { role: 'system', content: '【工具使用说明】...' },
                { role: 'user', content: '帮我查下最新政策' }
            ],
            {
                tools: [{
                    type: 'function',
                    function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }
                }],
                handlers: {
                    web_search: async (args) => {
                        executed.push(args);
                        return { ok: true, resultCount: 1, results: [{ title: 'T', url: 'https://t.example' }] };
                    }
                }
            },
            {}
        );

        assert.equal(outcome.skipped, false);
        assert.equal(outcome.reachedLimit, false);
        assert.equal(outcome.rounds, 2);
        assert.equal(outcome.toolCallCount, 1);
        assert.equal(outcome.content, '已拿到资料');

        assert.equal(requests.length, 2);
        assert.equal(requests[0].body.tools.length, 1);
        assert.equal(requests[0].body.tools[0].function.name, 'web_search');

        assert.deepEqual(executed, [{ query: '最新政策', limit: 3 }]);
        assert.equal(outcome.transcript.length, 1);
        const entry = outcome.transcript[0];
        assert.equal(entry.name, 'web_search');
        assert.deepEqual(entry.arguments, { query: '最新政策', limit: 3 });
        assert.equal(entry.ok, true);
        assert.equal(entry.result.resultCount, 1);

        // 第二轮请求里带上了工具结果消息
        const secondMessages = requests[1].body.messages;
        assert.equal(secondMessages.at(-1).role, 'tool');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('chatToolPhase 未找到处理器时转写标记失败但不中断', async () => {
    const originalFetch = globalThis.fetch;
    const requests = [];
    globalThis.fetch = async (url, options) => {
        requests.push({ url: String(url), body: JSON.parse(options.body) });
        if (requests.length === 1) {
            return toolCallResponse('ghost_tool', { a: 1 });
        }
        return textResponse('ok');
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'm',
            maxTokens: 1024,
            temperature: 0.7
        });

        const outcome = await client.chatToolPhase(
            [{ role: 'user', content: '调用不存在的工具' }],
            {
                tools: [{
                    type: 'function',
                    function: { name: 'ghost_tool', description: 'ghost', parameters: { type: 'object', properties: {} } }
                }],
                handlers: {}
            },
            {}
        );

        assert.equal(outcome.transcript.length, 1);
        assert.equal(outcome.transcript[0].ok, false);
        assert.match(String(outcome.transcript[0].result.error), /未找到工具处理器/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('chatToolPhase 达到配置轮次上限后按已有结果收束', async () => {
    const originalFetch = globalThis.fetch;
    let requestCount = 0;
    globalThis.fetch = async () => {
        requestCount += 1;
        return toolCallResponse('web_search', { query: `第${requestCount}次` }, `call-${requestCount}`);
    };

    try {
        const client = new AIClient({
            baseUrl: 'https://api.example.com/v1',
            apiKey: 'k',
            model: 'm',
            maxTokens: 1024,
            temperature: 0.7,
            chat: { maxToolRounds: 2 }
        });

        const outcome = await client.chatToolPhase(
            [{ role: 'user', content: '一直调用工具' }],
            {
                tools: [{
                    type: 'function',
                    function: { name: 'web_search', description: 'search', parameters: { type: 'object', properties: {} } }
                }],
                handlers: { web_search: async () => ({ ok: true }) }
            },
            {}
        );

        assert.equal(outcome.reachedLimit, true);
        assert.equal(outcome.rounds, 2);
        assert.equal(outcome.toolCallCount, 2);
        assert.equal(requestCount, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('buildToolPhaseResultMessage 生成可读的工具结果段并截断', () => {
    const message = buildToolPhaseResultMessage([
        {
            name: 'web_search',
            arguments: { query: '政策', limit: 3 },
            ok: true,
            result: { ok: true, results: [{ title: 'A', url: 'https://a.example' }] }
        },
        {
            name: 'get_weather',
            arguments: { location: '北京' },
            ok: false,
            result: { ok: false, error: '超时' }
        }
    ], { maxChars: 120 });

    assert.match(message, /【本轮工具执行结果】/);
    assert.match(message, /1\. web_search/);
    assert.match(message, /状态: 完成/);
    assert.match(message, /2\. get_weather/);
    assert.match(message, /状态: 失败/);
    assert.match(message, /超时/);
    // 结果体被截断到上限附近
    const bodyLine = message.split('\n').find((line) => line.includes('https://a.example'));
    assert.ok(bodyLine.length <= 122, `结果行应被截断，实际长度 ${bodyLine.length}`);
});

test('buildToolPhaseResultMessage 空转写返回空字符串', () => {
    assert.equal(buildToolPhaseResultMessage([], {}), '');
    assert.equal(buildToolPhaseResultMessage(null, {}), '');
});

test('buildToolPhaseMessages 只保留工具说明与轻上下文', () => {
    const fullMessages = [
        { role: 'system', content: '人设卡+预设+世界书+记忆（重提示词）', meta: { source: 'runtime_composition' } },
        { role: 'assistant', content: '开场白', meta: { source: 'first_message' } },
        { role: 'user', content: '历史消息1', meta: { source: 'history' } },
        { role: 'assistant', content: '历史回复1', meta: { source: 'history' } },
        { role: 'system', content: '变量状态', meta: { source: 'variables' } },
        { role: 'user', content: '当前消息', meta: { source: 'user_input' } },
        { role: 'assistant', content: '预填充', meta: { source: 'assistant_prefill' } }
    ];

    const toolPhaseMessages = buildToolPhaseMessages(fullMessages, ['【工具使用总则】...', '【功能：联网检索】...']);

    assert.equal(toolPhaseMessages[0].role, 'system');
    assert.match(toolPhaseMessages[0].content, /【工具使用说明】/);
    assert.match(toolPhaseMessages[0].content, /【功能：联网检索】/);
    assert.equal(toolPhaseMessages[0].meta.source, 'tool_hints');

    // 所有人设/变量 system 段与预填充都不进入工具阶段
    assert.equal(toolPhaseMessages.filter((m) => m.role === 'system').length, 1);
    assert.equal(toolPhaseMessages.some((m) => m.meta?.source === 'assistant_prefill'), false);

    const contents = toolPhaseMessages.map((m) => m.content);
    assert.deepEqual(contents.slice(1), ['开场白', '历史消息1', '历史回复1', '当前消息']);
});

test('buildToolPhaseMessages 无工具说明时仅保留轻上下文', () => {
    const toolPhaseMessages = buildToolPhaseMessages([
        { role: 'system', content: '重提示词' },
        { role: 'user', content: '你好' }
    ], []);

    assert.equal(toolPhaseMessages.length, 1);
    assert.equal(toolPhaseMessages[0].role, 'user');
});

// ---- 阶段一轻场景卡（goal-39：解决“只给聊天记录不给背景”的指代与 @ 找人问题） ----

test('buildToolPhaseScene 只提取轻量场景信息', () => {
    const scene = buildToolPhaseScene([
        { role: 'system', content: '人设卡+世界书+记忆（重提示词）', meta: { source: 'runtime_composition' } },
        { role: 'user', content: '[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:2026/9/16 17:20:24|eventType:message|isAtBot:false] 早上好' },
        { role: 'assistant', content: '早' },
        { role: 'user', content: '[群聊|QQ:222|昵称:阿乙|群号:99001|群名:测试群|时间:2026/9/16 17:21:24|eventType:message|isAtBot:false] 犬皇在吗' },
        { role: 'user', content: '[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:2026/9/16 17:22:24|eventType:message|isAtBot:true] 帮我@一下' }
    ], '测试角色');

    assert.match(scene, /【当前场景】/);
    assert.match(scene, /你正在以角色「测试角色」参与这次对话/);
    assert.match(scene, /当前会话: 群聊「测试群」\(99001\)/);
    assert.match(scene, /当前发言人: 阿甲\(111\)/);
    assert.match(scene, /近期发言人: 阿乙\(222\)、阿甲\(111\)/);
    assert.doesNotMatch(scene, /人设卡/);
});

test('buildToolPhaseScene 私聊场景与空场景', () => {
    const scene = buildToolPhaseScene([
        { role: 'user', content: '[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 你好' }
    ], '');
    assert.match(scene, /当前会话: 私聊 QQ:333/);
    assert.match(scene, /当前发言人: 阿丙\(333\)/);
    assert.equal(buildToolPhaseScene([{ role: 'user', content: '你好' }], ''), '');
    assert.equal(buildToolPhaseScene([], ''), '');
});

test('buildToolPhaseMessages 场景卡排在工具说明之前', () => {
    const messages = buildToolPhaseMessages([
        { role: 'system', content: '人设卡' },
        { role: 'user', content: '[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:x] 帮我@一下' }
    ], ['【工具使用总则】...'], { characterName: '测试角色' });

    assert.equal(messages[0].meta.source, 'tool_scene');
    assert.equal(messages[1].meta.source, 'tool_hints');
    assert.equal(messages.filter((m) => m.role === 'system').length, 2);
    assert.equal(messages.filter((m) => m.role === 'user').length, 1);
});

test('buildToolPhaseScene 群名优先取历史里的真名', () => {
    const scene = buildToolPhaseScene([
        { role: 'user', content: '[群聊|QQ:111|昵称:阿甲|群号:99001|群名:真名群|时间:x] 早上好' },
        { role: 'user', content: '[群聊|QQ:222|昵称:阿乙|群号:99001|群名:N/A|时间:x] 在吗' }
    ], '');
    assert.match(scene, /当前会话: 群聊「真名群」\(99001\)/);
});

test('buildToolPhaseScene 私聊不出近期发言人', () => {
    const scene = buildToolPhaseScene([
        { role: 'user', content: '[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 早上好' },
        { role: 'user', content: '[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 在吗' }
    ], '', 'private:333');
    assert.doesNotMatch(scene, /近期发言人/);
    assert.match(scene, /当前发言人: 阿丙\(333\)/);
});

test('buildToolPhaseScene 按当前聊天范围过滤其他群/私聊', () => {
    const scene = buildToolPhaseScene([
        { role: 'user', content: '[群聊|QQ:111|昵称:甲|群号:99001|群名:本群|时间:x] 你好' },
        { role: 'user', content: '[群聊|QQ:222|昵称:乙|群号:88888|群名:别群|时间:x] 路过' },
        { role: 'user', content: '[私聊|QQ:333|昵称:丙|群号:N/A|群名:N/A|时间:x] 私聊消息' },
        { role: 'user', content: '[群聊|QQ:444|昵称:丁|群号:99001|群名:本群|时间:x] 在吗' }
    ], '', 'group:99001');
    assert.doesNotMatch(scene, /乙|丙/);
    assert.match(scene, /甲\(111\)/);
    assert.match(scene, /丁\(444\)/);
});
