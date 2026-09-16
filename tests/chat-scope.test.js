import test from 'node:test';
import assert from 'node:assert/strict';

import { chatScopeKey, messageChatScope, filterMessagesForChat, chatScopePullLimit, isPrivateChatScope, headerChatScope } from '../src/chat-scope.js';

test('chatScopeKey 生成群聊/私聊范围键', () => {
    assert.equal(chatScopeKey({ messageType: 'group', groupId: '818554756', userId: '2356350440' }), 'group:818554756');
    assert.equal(chatScopeKey({ messageType: 'private', groupId: '', userId: '2356350440' }), 'private:2356350440');
    assert.equal(chatScopeKey({ messageType: 'group', groupId: '', userId: '' }), '');
    assert.equal(isPrivateChatScope('private:1'), true);
    assert.equal(isPrivateChatScope('group:1'), false);
});

test('messageChatScope 元数据优先，回退消息头', () => {
    assert.equal(messageChatScope({ role: 'user', content: 'x', metadata: { groupId: '99001' } }), 'group:99001');
    assert.equal(messageChatScope({ role: 'user', content: '[群聊|QQ:1|昵称:a|群号:99001|群名:x|时间:t] 你好' }), 'group:99001');
    assert.equal(messageChatScope({ role: 'user', content: '[私聊|QQ:333|昵称:a|群号:N/A|群名:N/A|时间:t] 你好' }), 'private:333');
    assert.equal(messageChatScope({ role: 'assistant', content: '普通回复' }), '');
    assert.equal(headerChatScope('[私聊|QQ:7|昵称:a|群号:N/A|群名:N/A|时间:t] hi'), 'private:7');
});

test('filterMessagesForChat 只留当前群聊，assistant 继承上一条用户消息', () => {
    const messages = [
        { role: 'user', content: '[群聊|QQ:1|昵称:a|群号:A|群名:x|时间:t] A1', metadata: {} },
        { role: 'assistant', content: 'A 的回复', metadata: {} },
        { role: 'user', content: '[群聊|QQ:2|昵称:b|群号:B|群名:y|时间:t] B1', metadata: {} },
        { role: 'assistant', content: 'B 的回复', metadata: {} },
        { role: 'user', content: '[群聊|QQ:1|昵称:a|群号:A|群名:x|时间:t] A2', metadata: {} },
        { role: 'assistant', content: '无范围回复', metadata: {} }
    ];
    const filtered = filterMessagesForChat(messages, 'group:A');
    assert.deepEqual(filtered.map((item) => item.content), [
        '[群聊|QQ:1|昵称:a|群号:A|群名:x|时间:t] A1',
        'A 的回复',
        '[群聊|QQ:1|昵称:a|群号:A|群名:x|时间:t] A2',
        '无范围回复'
    ]);
    assert.equal(filterMessagesForChat(messages, '').length, messages.length);
});

test('chatScopePullLimit 放大窗口并设上限', () => {
    assert.equal(chatScopePullLimit(30), 120);
    assert.equal(chatScopePullLimit(5), 50);
    assert.equal(chatScopePullLimit(500), 400);
});
