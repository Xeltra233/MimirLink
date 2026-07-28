import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMediaPrefixSegments, dispatchReply } from '../src/reply-dispatcher.js';
import fs from 'node:fs';

function createBaseConfig(overrides = {}) {
    return {
        chat: {
            splitMessage: true,
            segmentDelayMs: 0,
            proactiveMessageIntervalMs: 0,
            quoteReplyEnabled: true,
            mentionSenderOnReply: true,
            ...(overrides.chat || {})
        },
        ...(overrides || {})
    };
}

function createLogger() {
    return {
        info() {},
        warn() {},
        error() {},
        debug() {}
    };
}

test('dispatchReply sends normal AI reply as group voice when TTS is enabled', async () => {
    const calls = [];
    const metrics = [];
    const bot = {
        async sendGroupMessage(groupId, message) {
            calls.push({ type: 'group-text', groupId, message });
        },
        async sendGroupReply(groupId, messageId, message) {
            calls.push({ type: 'group-reply', groupId, messageId, message });
        },
        async sendGroupRecord(groupId, audioPath, prefixSegments) {
            calls.push({ type: 'group-record', groupId, audioPath, prefixSegments });
        }
    };
    const synthesizeCalls = [];
    const ttsManager = {
        getConfig() {
            return { enabled: true };
        },
        async synthesize(text) {
            synthesizeCalls.push(text);
            return 'C:/tmp/reply.mp3';
        }
    };

    await dispatchReply(
        {
            message_type: 'group',
            group_id: 10001,
            user_id: 20002,
            message_id: 30003
        },
        '这是完整 AI 回复，不应该再作为文本发送。',
        {},
        {
            config: createBaseConfig(),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric(type) {
                metrics.push(type);
            },
            sleep: async () => {}
        }
    );

    assert.deepEqual(synthesizeCalls, ['这是完整 AI 回复，不应该再作为文本发送。']);
    assert.deepEqual(metrics, ['tts']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'group-record');
    assert.equal(calls[0].groupId, 10001);
    assert.equal(calls[0].audioPath, 'C:/tmp/reply.mp3');
    assert.deepEqual(calls[0].prefixSegments, [
        { type: 'reply', data: { id: '30003' } }
    ]);
});
test('dispatchReply falls back to visible text when TTS synthesis fails', async () => {
    const calls = [];
    const bot = {
        async sendPrivateReply(userId, messageId, message) {
            calls.push({ type: 'private-reply', userId, messageId, message });
        },
        async sendPrivateMessage(userId, message) {
            calls.push({ type: 'private-text', userId, message });
        },
        async sendPrivateRecord(userId, audioPath, prefixSegments) {
            calls.push({ type: 'private-record', userId, audioPath, prefixSegments });
        }
    };
    const warnings = [];
    const ttsManager = {
        getConfig() {
            return { enabled: true };
        },
        async synthesize() {
            throw new Error('mock synthesis failed');
        }
    };

    await dispatchReply(
        {
            message_type: 'private',
            user_id: 20002,
            message_id: 30003
        },
        '这条回复语音失败后需要可见文本。',
        {},
        {
            config: createBaseConfig(),
            bot,
            ttsManager,
            logger: { ...createLogger(), warn(message) { warnings.push(message); } },
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'private-reply');
    assert.match(calls[0].message, /^语音合成失败，先发送文本回复：/);
    assert.match(calls[0].message, /这条回复语音失败后需要可见文本。/);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /mock synthesis failed/);
});

test('dispatchReply keeps text behavior when TTS is disabled', async () => {
    const calls = [];
    const bot = {
        async sendGroupMessage(groupId, message) {
            calls.push({ type: 'group-text', groupId, message });
        },
        async sendGroupReply(groupId, messageId, message) {
            calls.push({ type: 'group-reply', groupId, messageId, message });
        }
    };
    const ttsManager = {
        getConfig() {
            return { enabled: false };
        },
        async synthesize() {
            throw new Error('should not synthesize');
        }
    };

    await dispatchReply(
        {
            message_type: 'group',
            group_id: 10001,
            user_id: 20002,
            message_id: 30003
        },
        '第一段\n\n第二段',
        {},
        {
            config: createBaseConfig(),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, 'group-text');
    assert.equal(calls[0].message[0].type, 'reply');
    assert.equal(calls[0].message[1].type, 'at');
    assert.equal(calls[0].message[2].data.text, '第一段');
    assert.deepEqual(calls[1], {
        type: 'group-reply',
        groupId: 10001,
        messageId: 30003,
        message: '第二段'
    });
});

test('buildMediaPrefixSegments 让点歌与 TTS 可独立决定是否 at', () => {
    const event = {
        message_type: 'group',
        group_id: 10001,
        user_id: 20002,
        message_id: 30003
    };

    // 点歌口径：可 at
    assert.deepEqual(
        buildMediaPrefixSegments(event, { quoteReplyEnabled: true, mentionSender: true }),
        [
            { type: 'reply', data: { id: '30003' } },
            { type: 'at', data: { qq: '20002' } }
        ]
    );

    // TTS 口径：不要 at，但仍可 quote
    assert.deepEqual(
        buildMediaPrefixSegments(event, { quoteReplyEnabled: true, mentionSender: false }),
        [
            { type: 'reply', data: { id: '30003' } }
        ]
    );

    // 已发过主消息后，前缀清空（避免每段重复 at/reply）
    assert.deepEqual(
        buildMediaPrefixSegments(event, { quoteReplyEnabled: true, mentionSender: true, hasSentPrimary: true }),
        []
    );
});

test('dispatchReply TTS 语音不带 at，即使 mentionSenderOnReply 开启', async () => {
    const calls = [];
    const bot = {
        async sendGroupMessage() { throw new Error('should not send text'); },
        async sendGroupReply() { throw new Error('should not send reply text'); },
        async sendGroupRecord(groupId, audioPath, prefixSegments) {
            calls.push({ type: 'group-record', groupId, audioPath, prefixSegments });
        }
    };
    const ttsManager = {
        getConfig() { return { enabled: true }; },
        async synthesize() { return 'C:/tmp/no-at.mp3'; }
    };

    await dispatchReply(
        { message_type: 'group', group_id: 1, user_id: 2, message_id: 3 },
        '普通整段语音',
        {},
        {
            config: createBaseConfig({ chat: { mentionSenderOnReply: true } }),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].prefixSegments, [
        { type: 'reply', data: { id: '3' } }
    ]);
    assert.ok(!calls[0].prefixSegments.some((s) => s.type === 'at'), 'TTS 语音不得带 at');
});

test('dispatchReply 文字内 [voice]：正文发文本，voice 发 record', async () => {
    const calls = [];
    const synthesizeCalls = [];
    const bot = {
        async sendGroupMessage(groupId, message) {
            calls.push({ type: 'group-text', groupId, message });
        },
        async sendGroupReply(groupId, messageId, message) {
            calls.push({ type: 'group-reply', groupId, messageId, message });
        },
        async sendGroupRecord(groupId, audioPath, prefixSegments) {
            calls.push({ type: 'group-record', groupId, audioPath, prefixSegments });
        }
    };
    const ttsManager = {
        getConfig() { return { enabled: true }; },
        async synthesize(text) {
            synthesizeCalls.push(text);
            return `C:/tmp/${synthesizeCalls.length}.mp3`;
        }
    };

    await dispatchReply(
        { message_type: 'group', group_id: 10001, user_id: 20002, message_id: 30003 },
        '先看文字说明。[voice: 这段才是语音] 后面还有补充。',
        {},
        {
            config: createBaseConfig(),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    assert.deepEqual(synthesizeCalls, ['这段才是语音']);
    assert.equal(calls.length, 3, '文本 + 语音 + 文本');
    assert.equal(calls[0].type, 'group-text');
    assert.equal(calls[0].message[2].data.text, '先看文字说明。');
    assert.equal(calls[1].type, 'group-record');
    assert.deepEqual(calls[1].prefixSegments, [], '非首条媒体消息不再带 reply/at');
    assert.equal(calls[2].type, 'group-reply');
    assert.equal(calls[2].message, '后面还有补充。');
});

test('dispatchReply TTS 关闭时 [voice] 给出明确文本回退而不是静默', async () => {
    const calls = [];
    const bot = {
        async sendGroupMessage(groupId, message) {
            calls.push({ type: 'group-text', groupId, message });
        },
        async sendGroupReply(groupId, messageId, message) {
            calls.push({ type: 'group-reply', groupId, messageId, message });
        }
    };
    const ttsManager = {
        getConfig() { return { enabled: false }; },
        async synthesize() { throw new Error('should not synthesize'); }
    };

    await dispatchReply(
        { message_type: 'group', group_id: 1, user_id: 2, message_id: 3 },
        '说明[voice:你好]',
        {},
        {
            config: createBaseConfig(),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    assert.equal(calls.length, 2);
    assert.equal(calls[0].type, 'group-text');
    assert.match(String(calls[1].message || ''), /未启用 TTS|无法发送语音/);
});

test('回归：普通聊天开启 TTS 时只出站一次语音，不附带相同文本/@', async () => {
    const calls = [];
    const bot = {
        async sendGroupMessage(groupId, message) {
            calls.push({ type: 'group-text', groupId, message });
        },
        async sendGroupReply(groupId, messageId, message) {
            calls.push({ type: 'group-reply', groupId, messageId, message });
        },
        async sendGroupRecord(groupId, audioPath, prefixSegments) {
            calls.push({ type: 'group-record', groupId, audioPath, prefixSegments });
        }
    };
    const ttsManager = {
        getConfig() { return { enabled: true }; },
        async synthesize(text) {
            assert.equal(text, '你好，这是同一条回复');
            return 'C:/tmp/once.mp3';
        }
    };

    await dispatchReply(
        {
            message_type: 'group',
            group_id: 10001,
            user_id: 20002,
            message_id: 30003
        },
        '你好，这是同一条回复',
        {},
        {
            config: createBaseConfig({
                chat: {
                    mentionSenderOnReply: true,
                    quoteReplyEnabled: true,
                    splitMessage: true
                }
            }),
            bot,
            ttsManager,
            logger: createLogger(),
            recordDashboardMetric() {},
            sleep: async () => {}
        }
    );

    // 根因修复后：不应再出现「文本/@ 一条 + 语音一条」的双出站
    assert.equal(calls.length, 1, `期望仅 1 次出站，实际 ${calls.length}: ${JSON.stringify(calls)}`);
    assert.equal(calls[0].type, 'group-record');
    assert.equal(calls[0].audioPath, 'C:/tmp/once.mp3');
    assert.deepEqual(calls[0].prefixSegments, [
        { type: 'reply', data: { id: '30003' } }
    ]);
    assert.ok(!calls.some((c) => c.type === 'group-text' || c.type === 'group-reply'), '不得再发相同内容文本');
    assert.ok(!calls[0].prefixSegments.some((s) => s.type === 'at'), 'TTS 不得带 at');
});

test('回归：index 成功主路径对同一回复只调用一次 dispatchReply', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const processStart = source.indexOf('async function processBatch(batch)');
    assert.notEqual(processStart, -1);
    // processBatch 一直到 runtime 创建前
    const processEnd = source.indexOf('const runtime = new MessageRuntime', processStart);
    assert.notEqual(processEnd, -1);
    const processBatch = source.slice(processStart, processEnd);

    const successDispatchMatches = processBatch.match(/await dispatchReply\(event, replyToSend/g) || [];
    assert.equal(successDispatchMatches.length, 1, '成功主路径只能 dispatch 一次 replyToSend');

    // 注入拦截 / 失败提示等其它分支可以有 dispatch，但不该对同一 replyToSend 再发
    assert.ok(!processBatch.includes('await dispatchReply(event, processedReply)'), '不得对 processedReply 再 dispatch 一次');
    assert.ok(!processBatch.includes('await dispatchReply(event, reply)'), '不得对原始 reply 再 dispatch 一次');
});
