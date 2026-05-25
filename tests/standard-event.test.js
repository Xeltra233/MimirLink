import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStandardEvent, formatStandardEventHeader, updateStandardEventRouting } from '../src/standard-event.js';

test('standard event keeps QQ group identity, at-bot and dynamic emoji readable', () => {
    const event = {
        post_type: 'message',
        message_type: 'group',
        message_id: 9001,
        group_id: 818554756,
        group_name: '贩子死妈公益站群',
        user_id: 10001,
        sender: {
            card: '莫某（爱妻）',
            nickname: '莫某'
        },
        raw_message: '今晚水群 [mface]'
    };

    const standardEvent = buildStandardEvent({
        event,
        contentText: '今晚水群 @bot [QQ动态表情:乐]',
        rawText: event.raw_message,
        isAtBot: true,
        messageSegments: [
            { type: 'text', text: '今晚水群 ' },
            { type: 'at', qq: '1605992934', isBot: true },
            { type: 'mface', id: 'm-1', summary: '乐' }
        ],
        botSelfId: '1605992934'
    });

    assert.equal(standardEvent.version, 1);
    assert.equal(standardEvent.messageType, 'group');
    assert.equal(standardEvent.group.id, '818554756');
    assert.equal(standardEvent.group.name, '贩子死妈公益站群');
    assert.equal(standardEvent.sender.id, '10001');
    assert.equal(standardEvent.sender.name, '莫某（爱妻）');
    assert.equal(standardEvent.bot.isAtBot, true);
    assert.equal(standardEvent.segments[2].readableText, 'QQ动态表情:乐|id=m-1');
    assert.match(standardEvent.inputHeader, /群号:818554756/);
    assert.match(standardEvent.inputHeader, /群名:贩子死妈公益站群/);
    assert.match(standardEvent.inputHeader, /QQ:10001/);
    assert.match(standardEvent.inputHeader, /昵称:莫某（爱妻）/);
    assert.match(standardEvent.inputHeader, /isAtBot:true/);
    assert.match(standardEvent.inputHeader, /QQ动态表情:乐/);
    assert.ok(standardEvent.inputText.endsWith('今晚水群 @bot [QQ动态表情:乐]'));
});

test('standard event records quote-to-bot without requiring an at mention', () => {
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'message',
            message_type: 'group',
            message_id: 9002,
            group_id: 818554756,
            group_name: '贩子死妈公益站群',
            user_id: 10002,
            sender: { nickname: '路人甲' }
        },
        contentText: '[回复上文|发送者:徐缺|QQ:1605992934|内容:刚才那句别复读] 别一直懂？',
        isAtBot: false,
        replyToMessageId: '7788',
        replyInfo: {
            toBot: true,
            senderId: '1605992934',
            senderName: '徐缺',
            quotedText: '刚才那句别复读',
            fetchStatus: 'resolved'
        },
        messageSegments: [
            { type: 'reply', id: '7788' },
            { type: 'text', text: '别一直懂？' }
        ],
        botSelfId: '1605992934',
        routingDecision: {
            shouldRespond: true,
            triggerReason: 'reply_to_bot',
            skipReason: ''
        }
    });

    assert.equal(standardEvent.bot.isAtBot, false);
    assert.equal(standardEvent.reply.toBot, true);
    assert.equal(standardEvent.reply.messageId, '7788');
    assert.equal(standardEvent.reply.quotedText, '刚才那句别复读');
    assert.match(standardEvent.inputHeader, /replyToBot:true/);
    assert.match(standardEvent.inputHeader, /replyMessageId:7788/);
    assert.match(standardEvent.inputHeader, /replyQuotedText:刚才那句别复读/);
    assert.match(standardEvent.inputHeader, /replyFetch:resolved/);
    assert.match(standardEvent.inputHeader, /triggerReason:reply_to_bot/);
    assert.match(standardEvent.inputHeader, /引用消息:7788/);
});

test('standard event represents poke notice as a group event', () => {
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'notice',
            message_type: 'group',
            group_id: 818554756,
            group_name: '贩子死妈公益站群',
            user_id: 10003,
            sender: { nickname: '戳戳党' }
        },
        contentText: '（戳了戳你）',
        rawText: '（戳了戳你）',
        eventType: 'poke',
        isAtBot: false,
        replyInfo: { toBot: false },
        messageSegments: [{ type: 'poke', userId: '10003', targetId: '1605992934' }],
        botSelfId: '1605992934',
        routingDecision: {
            shouldRespond: true,
            triggerReason: 'poke',
            skipReason: ''
        }
    });

    assert.equal(standardEvent.eventType, 'poke');
    assert.equal(standardEvent.contentText, '（戳了戳你）');
    assert.equal(standardEvent.segments[0].readableText, '戳一戳:10003->1605992934');
    assert.match(standardEvent.inputHeader, /eventType:poke/);
    assert.match(standardEvent.inputHeader, /triggerReason:poke/);
    assert.match(standardEvent.inputHeader, /戳一戳:10003->1605992934/);
});

test('standard event can expose routing skip reasons for observers', () => {
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'message',
            message_type: 'group',
            group_id: 818554756,
            user_id: 10005,
            sender: { nickname: '路人乙' }
        },
        contentText: '路过一下',
        messageSegments: [{ type: 'text', text: '路过一下' }],
        routingDecision: {
            shouldRespond: false,
            triggerReason: '',
            skipReason: 'group_requires_at_prefix_keyword_or_reply_to_bot'
        }
    });

    assert.equal(standardEvent.routing.shouldRespond, false);
    assert.equal(standardEvent.routing.skipReason, 'group_requires_at_prefix_keyword_or_reply_to_bot');
    assert.match(standardEvent.inputHeader, /skipReason:group_requires_at_prefix_keyword_or_reply_to_bot/);
});

test('standard event refreshes input header when routing is decided later', () => {
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'message',
            message_type: 'group',
            group_id: 818554756,
            user_id: 10006,
            sender: { nickname: '后置路由用户' }
        },
        contentText: '徐缺出来一下',
        messageSegments: [{ type: 'text', text: '徐缺出来一下' }]
    });

    assert.doesNotMatch(standardEvent.inputHeader, /triggerReason:/);

    updateStandardEventRouting(standardEvent, {
        shouldRespond: true,
        triggerReason: 'keyword',
        skipReason: ''
    });

    assert.equal(standardEvent.routing.shouldRespond, true);
    assert.match(standardEvent.inputHeader, /triggerReason:keyword/);
    assert.ok(standardEvent.inputText.startsWith(standardEvent.inputHeader));
    assert.ok(standardEvent.inputText.endsWith('徐缺出来一下'));
});

test('standard event header can be formatted from a stored event object', () => {
    const standardEvent = buildStandardEvent({
        event: {
            post_type: 'message',
            message_type: 'private',
            user_id: 10004,
            sender: { nickname: '私聊用户' }
        },
        contentText: '你好',
        messageSegments: [{ type: 'text', text: '你好' }]
    });

    assert.equal(formatStandardEventHeader(standardEvent), standardEvent.inputHeader);
    assert.match(standardEvent.inputHeader, /私聊/);
    assert.match(standardEvent.inputHeader, /群号:N\/A/);
});
