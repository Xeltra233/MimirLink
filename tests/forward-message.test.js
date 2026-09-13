import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findForwardSegments,
    normalizeForwardNodes,
    renderCqString,
    renderForwardNodeContent,
    fetchForwardTranscript,
    fetchForwardTranscripts
} from '../src/forward-message.js';
import { buildStandardEvent } from '../src/standard-event.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const napCatPayload = {
    messages: [
        {
            message_id: 1,
            user_id: '10001',
            nickname: '小明',
            message: [{ type: 'text', data: { text: '今晚吃什么' } }]
        },
        {
            message_id: 2,
            user_id: '10002',
            nickname: '小红',
            message: [
                { type: 'text', data: { text: '火锅' } },
                { type: 'image', data: { file: 'a.jpg' } }
            ]
        }
    ]
};

function renderSegment(segment) {
    if (segment?.type === 'text') {
        return { promptText: String(segment.data?.text || '') };
    }
    if (segment?.type === 'image') {
        return { promptText: '[图片]' };
    }
    return { promptText: `[消息段:${segment?.type || 'unknown'}]` };
}

test('findForwardSegments 只挑出 forward 段并返回原始下标', () => {
    const segments = [
        { type: 'text', data: { text: 'hi' } },
        { type: 'forward', data: { id: 'fwd-1' } },
        { type: 'at', data: { qq: '10001' } },
        { type: 'forward', data: { message_id: 'fwd-2' } },
        { type: 'forward', data: {} }
    ];
    assert.deepEqual(findForwardSegments(segments), [
        { index: 1, id: 'fwd-1' },
        { index: 3, id: 'fwd-2' }
    ]);
    assert.deepEqual(findForwardSegments('not-array'), []);
});

test('normalizeForwardNodes 兼容多种返回结构', () => {
    const fromMessages = normalizeForwardNodes(napCatPayload);
    assert.equal(fromMessages.length, 2);
    assert.equal(fromMessages[0].name, '小明');
    assert.equal(fromMessages[1].name, '小红');

    const fromData = normalizeForwardNodes({ data: { messages: napCatPayload.messages } });
    assert.equal(fromData.length, 2);

    const fromArray = normalizeForwardNodes([{ sender: { card: '群名片', user_id: '7' }, content: [{ type: 'text', data: { text: 'x' } }] }]);
    assert.equal(fromArray[0].name, '群名片');

    assert.deepEqual(normalizeForwardNodes(null), []);
});

test('renderCqString 与节点内容渲染', () => {
    assert.equal(
        renderCqString('[CQ:at,qq=123] 你好[CQ:image,file=x.jpg][CQ:face,id=1]'),
        '@123 你好[图片][QQ表情]'
    );
    assert.equal(
        renderForwardNodeContent([{ type: 'text', data: { text: '火锅' } }, { type: 'image', data: {} }], renderSegment),
        '火锅[图片]'
    );
    assert.equal(
        renderForwardNodeContent([{ type: 'forward', data: { id: 'nested' } }], renderSegment),
        '[嵌套合并转发聊天记录]'
    );
});

test('fetchForwardTranscript 拉取并渲染聊天记录，兼容 id / message_id 两种参数', async () => {
    const calls = [];
    const bot = {
        logger: silentLogger,
        async _call(action, params) {
            calls.push({ action, params });
            if (params.id) {
                throw new Error('unknown param id');
            }
            return napCatPayload;
        }
    };

    const result = await fetchForwardTranscript({ bot, forwardId: 'fwd-1', renderSegment, logger: silentLogger });
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.deepEqual(calls, [
        { action: 'get_forward_msg', params: { id: 'fwd-1' } },
        { action: 'get_forward_msg', params: { message_id: 'fwd-1' } }
    ]);
    assert.match(result.transcript, /合并转发聊天记录\|共2条/);
    assert.match(result.transcript, /1\. 小明: 今晚吃什么/);
    assert.match(result.transcript, /2\. 小红: 火锅\[图片\]/);
});

test('fetchForwardTranscript 处理缺失 id、接口失败与空内容', async () => {
    const noId = await fetchForwardTranscript({ bot: { _call: async () => napCatPayload }, forwardId: '', logger: silentLogger });
    assert.equal(noId.ok, false);
    assert.match(noId.error, /缺少合并转发 id/);

    const noBot = await fetchForwardTranscript({ bot: {}, forwardId: 'fwd', logger: silentLogger });
    assert.equal(noBot.ok, false);
    assert.match(noBot.error, /OneBot 客户端不可用/);

    const failing = await fetchForwardTranscript({
        bot: { logger: silentLogger, _call: async () => { throw new Error('ws closed'); } },
        forwardId: 'fwd',
        logger: silentLogger
    });
    assert.equal(failing.ok, false);
    assert.match(failing.error, /ws closed/);

    const empty = await fetchForwardTranscript({
        bot: { logger: silentLogger, _call: async () => ({ messages: [] }) },
        forwardId: 'fwd',
        logger: silentLogger
    });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /内容为空/);
});

test('fetchForwardTranscript 按 maxNodes / maxChars 截断', async () => {
    const manyNodes = {
        messages: Array.from({ length: 10 }, (_, index) => ({
            user_id: String(index),
            nickname: `用户${index}`,
            message: [{ type: 'text', data: { text: '很长的内容'.repeat(20) } }]
        }))
    };
    const bot = { logger: silentLogger, _call: async () => manyNodes };
    const result = await fetchForwardTranscript({ bot, forwardId: 'fwd', renderSegment, maxNodes: 3, maxChars: 300, logger: silentLogger });
    assert.equal(result.ok, true);
    assert.equal(result.count, 10);
    const lines = result.transcript.split('\n');
    assert.ok(lines.length <= 5, `lines: ${lines.length}`);
    assert.match(result.transcript, /已截断/);

    const transcripts = await fetchForwardTranscripts({ bot, forwardIds: ['a', 'b', 'c'], renderSegment, maxTranscripts: 2, logger: silentLogger });
    assert.equal(transcripts.length, 2);
});

test('standard-event 将 forward 段标记为合并转发聊天记录', () => {
    const forwardSegment = { type: 'forward', data: { id: 'fwd-1' } };
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'message',
            message_type: 'group',
            group_id: '123',
            user_id: '10001',
            sender: { nickname: '小明' }
        },
        contentText: '[合并转发聊天记录]',
        rawText: '[合并转发聊天记录]',
        eventType: 'message',
        isAtBot: true,
        replyToMessageId: null,
        replyInfo: {},
        messageSegments: [forwardSegment],
        botSelfId: '9999'
    });
    assert.equal(standardEvent.segments?.[0]?.readableText, '合并转发聊天记录');
    assert.match(standardEvent.inputHeader, /segments:合并转发聊天记录/);
});
