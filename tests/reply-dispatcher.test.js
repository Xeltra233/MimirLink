import test from 'node:test';
import assert from 'node:assert/strict';

import { dispatchReply } from '../src/reply-dispatcher.js';

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
        { type: 'reply', data: { id: '30003' } },
        { type: 'at', data: { qq: '20002' } }
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
