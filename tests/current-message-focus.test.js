import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCurrentMessageFocus, formatCurrentMessageFocus } from '../src/current-message-focus.js';

function baseEvent(overrides = {}) {
    return {
        version: 1,
        eventType: 'message',
        messageType: 'group',
        group: { id: '818554756', name: '贩子死妈公益站群' },
        sender: { id: '10001', name: '莫某（爱妻）' },
        bot: { selfId: '1605992934', isAtBot: true },
        reply: { messageId: null, toBot: null, fetchStatus: 'none', fetchReason: '', quotedText: '' },
        segments: [{ type: 'text', text: '你好', readableText: '文本:你好' }],
        contentText: '你好',
        routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' },
        ...overrides
    };
}

test('focus treats quote-to-bot as addressed to bot without at mention', () => {
    const focus = buildCurrentMessageFocus({
        messageType: 'group',
        triggerReason: 'reply_to_bot',
        primaryStandardEvent: baseEvent({
            bot: { selfId: '1605992934', isAtBot: false },
            reply: {
                messageId: '7788',
                toBot: true,
                fetchStatus: 'resolved',
                fetchReason: '',
                quotedText: '刚才那句别复读'
            },
            segments: [
                { type: 'reply', id: '7788', readableText: '引用消息:7788' },
                { type: 'text', text: '别一直懂？', readableText: '文本:别一直懂？' }
            ],
            contentText: '[回复上文|发送者:徐缺|QQ:1605992934|内容:刚才那句别复读] 别一直懂？',
            routing: { shouldRespond: true, triggerReason: 'reply_to_bot', skipReason: '' }
        })
    });

    assert.equal(focus.intent, 'reply_to_bot');
    assert.equal(focus.replyTarget, 'reply_to_current_user_about_bot_quote');
    assert.equal(focus.quote.toBot, true);
    assert.ok(focus.strategies.includes('use_quote_as_context_only'));
    assert.ok(focus.strategies.includes('treat_as_addressed_to_bot_even_without_at'));
});

test('focus handles poke events as brief acknowledged interactions', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            eventType: 'poke',
            contentText: '（戳了戳你）',
            segments: [{ type: 'poke', userId: '10001', targetId: '1605992934', readableText: '戳一戳:10001->1605992934' }],
            routing: { shouldRespond: true, triggerReason: 'poke', skipReason: '' }
        })
    });

    assert.equal(focus.intent, 'poke');
    assert.equal(focus.replyTarget, 'respond_to_poke_user');
    assert.equal(focus.triggerReason, 'poke');
    assert.ok(focus.strategies.includes('acknowledge_poke_briefly'));
});

test('focus marks single question as low information and avoids question crutch', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            contentText: '?',
            segments: [{ type: 'text', text: '?', readableText: '文本:?' }],
            routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
        })
    });

    assert.equal(focus.intent, 'low_information');
    assert.equal(focus.isLowInformation, true);
    assert.ok(focus.strategies.includes('give_short_acknowledgement'));
    assert.ok(focus.strategies.includes('avoid_question_as_crutch'));
    assert.ok(focus.warnings.some((item) => item.includes('低信息输入')));
});

test('focus detects QQ emoji-only style inputs', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            contentText: '[QQ动态表情:小人倒地]',
            segments: [{ type: 'mface', id: 'm-1', summary: '小人倒地', readableText: 'QQ动态表情:小人倒地|id=m-1' }],
            routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
        })
    });

    assert.equal(focus.intent, 'emoji_reaction');
    assert.equal(focus.isEmojiOnly, true);
    assert.ok(focus.strategies.includes('describe_visible_emoji_or_mood'));
});

test('focus releases old topic on explicit topic shift', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            contentText: '不聊收费了，我突然想喝奶茶但懒得下楼',
            routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
        })
    });

    assert.equal(focus.intent, 'topic_shift');
    assert.equal(focus.isTopicShift, true);
    assert.equal(focus.shouldReleaseOldTopic, true);
    assert.ok(focus.strategies.includes('release_old_topic'));
    assert.ok(focus.strategies.includes('do_not_repeat_stopped_keyword'));
});

test('focus releases invented old gag when user asks where it came from', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            contentText: '哈，我们哪里谈到了灵石',
            routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
        })
    });

    assert.equal(focus.shouldReleaseOldTopic, true);
    assert.ok(focus.strategies.includes('release_old_topic'));
    assert.ok(focus.warnings.some((item) => item.includes('释放旧话题')));
});

test('focus preserves skip reasons for non-triggered group messages', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            bot: { selfId: '1605992934', isAtBot: false },
            contentText: '路过一下',
            routing: {
                shouldRespond: false,
                triggerReason: '',
                skipReason: 'group_requires_at_prefix_keyword_or_reply_to_bot'
            }
        }),
        routingDecisions: [{
            shouldRespond: false,
            triggerReason: '',
            skipReason: 'group_requires_at_prefix_keyword_or_reply_to_bot'
        }]
    });

    assert.equal(focus.shouldRespond, false);
    assert.equal(focus.skipReason, 'group_requires_at_prefix_keyword_or_reply_to_bot');
    assert.ok(focus.strategies.includes('do_not_reply_unless_triggered'));
});

test('focus uses the primary event from a multi-message batch', () => {
    const first = baseEvent({ contentText: '刚才那个梗算了吧' });
    const latest = baseEvent({
        sender: { id: '10002', name: '阿北' },
        contentText: '我准点吃饭了',
        routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
    });
    const focus = buildCurrentMessageFocus({
        standardEvents: [first, latest],
        primaryStandardEvent: latest,
        routingDecisions: [first.routing, latest.routing]
    });

    assert.equal(focus.sender.id, '10002');
    assert.equal(focus.latestText, '我准点吃饭了');
    assert.equal(focus.intent, 'chat');
});

test('formatCurrentMessageFocus renders stable prompt text', () => {
    const focus = buildCurrentMessageFocus({
        primaryStandardEvent: baseEvent({
            contentText: '徐缺，出来一下',
            routing: { shouldRespond: true, triggerReason: 'at', skipReason: '' }
        })
    });
    const text = formatCurrentMessageFocus(focus);

    assert.match(text, /<current-message-focus>/);
    assert.match(text, /意图: call_out/);
    assert.match(text, /策略:/);
    assert.match(text, /<\/current-message-focus>/);
});
