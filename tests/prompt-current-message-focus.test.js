import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptBuilder } from '../src/prompt.js';

function createBuilder() {
    return new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '徐缺',
                    description: '角色描述',
                    personality: '',
                    scenario: '',
                    system_prompt: '',
                    first_mes: ''
                };
            }
        },
        {
            currentWorldBook: null,
            readWorldBook() {
                return null;
            },
            matchEntries() {
                return [];
            }
        },
        {
            chat: {
                humanChatControlPrompt: '<human_chat_control>配置里的群聊控制</human_chat_control>'
            },
            preset: {
                enabled: true,
                name: '测试预设',
                prompts: [
                    {
                        identifier: 'main',
                        name: 'Main Prompt',
                        role: 'system',
                        content: '系统主提示',
                        enabled: true,
                        injection_position: 0,
                        injection_depth: 0,
                        system_prompt: true
                    },
                    {
                        identifier: 'post-history',
                        name: 'Post History',
                        role: 'system',
                        content: '历史后提示',
                        enabled: true,
                        injection_position: 1,
                        injection_depth: 0,
                        system_prompt: true
                    },
                    {
                        identifier: 'assistant-prefill',
                        name: 'Assistant Prefill',
                        role: 'assistant',
                        content: '<thinking>',
                        enabled: true,
                        injection_position: 1,
                        injection_depth: 0
                    }
                ]
            }
        }
    );
}

test('prompt build inserts current-message-focus between post-history and latest user input', async () => {
    const builder = createBuilder();
    const built = await builder.build(
        '徐缺',
        '？',
        { recentMessages: [{ role: 'user', content: '上一句：灵石怎么算' }], summaries: [] },
        new Set(),
        {
            primaryStandardEvent: {
                eventType: 'message',
                messageType: 'group',
                sender: { id: '10001', name: '莫某（爱妻）' },
                group: { id: '818554756', name: '贩子死妈公益站群' },
                contentText: '？',
                rawText: '？',
                segments: [{ type: 'text', text: '？' }],
                reply: { toBot: false }
            },
            routingDecisions: [{ shouldRespond: true, triggerReason: 'at' }],
            triggerReason: 'at'
        }
    );

    const focusIndex = built.messages.findIndex((message) => message.meta?.source === 'current_message_focus');
    const postHistoryIndex = built.messages.findIndex((message) => message.meta?.source === 'post_history');
    const userInputIndex = built.messages.findIndex((message) => message.meta?.source === 'user_input');
    const assistantPrefillIndex = built.messages.findIndex((message) => message.meta?.source === 'assistant_prefill');

    assert.ok(focusIndex > postHistoryIndex);
    assert.ok(focusIndex < userInputIndex);
    assert.ok(userInputIndex < assistantPrefillIndex);
    assert.match(built.messages[focusIndex].content, /<current-message-focus>/);
    assert.match(built.messages[focusIndex].content, /意图: low_information/);
    assert.match(built.messages[focusIndex].content, /发言人: 莫某（爱妻）\(10001\)/);

    const focusSource = built.runtimeSources.find((source) => source.id === 'current-message-focus');
    assert.equal(focusSource?.kind, 'current_message_focus');
    assert.equal(focusSource?.sourceSlot, 'current_message_focus');
    assert.equal(focusSource?.stage, 'runtime');

    const focusTrace = built.messageTrace[focusIndex];
    assert.deepEqual(focusTrace.sourceIds, ['current-message-focus']);
    assert.deepEqual(focusTrace.sourceSlots, ['current_message_focus']);
});

test('prompt build uses current user message as focus fallback when standard event is absent', async () => {
    const builder = createBuilder();
    const built = await builder.build(
        '徐缺',
        '换话题，别聊灵石了',
        { recentMessages: [], summaries: [] },
        new Set(),
        {}
    );

    const focusMessage = built.messages.find((message) => message.meta?.source === 'current_message_focus');

    assert.match(focusMessage?.content || '', /最新输入: 换话题，别聊灵石了/);
    assert.match(focusMessage?.content || '', /释放旧话题: yes/);
});

test('human chat control is loaded from migratable config instead of hardcoded prompt text', async () => {
    const builder = createBuilder();
    const built = await builder.build(
        '徐缺',
        '你好',
        { recentMessages: [], summaries: [] },
        new Set(),
        {}
    );
    const control = built.runtimeSources.find((source) => source.kind === 'human_chat_control')?.content || '';

    assert.equal(control, '<human_chat_control>配置里的群聊控制</human_chat_control>');
});
