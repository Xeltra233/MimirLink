import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptBuilder } from '../src/prompt.js';

test('createMessageTrace maps assistant history separately from assistant prefill', () => {
    const messages = [
        {
            role: 'assistant',
            content: '历史回复',
            meta: { source: 'history', sourceId: 'history-0' }
        },
        {
            role: 'user',
            content: '当前用户输入',
            meta: { source: 'user_input' }
        },
        {
            role: 'assistant',
            content: '<thinking>',
            meta: { source: 'assistant_prefill', sourceIds: ['prefill'] }
        }
    ];
    const runtimeSources = [
        {
            id: 'history-0',
            kind: 'history_message',
            stage: 'history',
            sourceSlot: 'history',
            meta: { placement: 'history' }
        },
        {
            id: 'user-input',
            kind: 'user_input',
            stage: 'input',
            sourceSlot: 'user_input',
            meta: { placement: 'user_input' }
        },
        {
            id: 'prefill',
            kind: 'preset_assistant',
            stage: 'preset',
            sourceSlot: 'assistant_prefill',
            meta: { placement: 'assistant_prefill' }
        }
    ];

    const trace = PromptBuilder.createMessageTrace(messages, runtimeSources);

    assert.deepEqual(trace[0].sourceSlots, ['history']);
    assert.deepEqual(trace[0].sourceIds, ['history-0']);
    assert.deepEqual(trace[1].sourceSlots, ['user_input']);
    assert.deepEqual(trace[2].sourceSlots, ['assistant_prefill']);
    assert.deepEqual(trace[2].sourceIds, ['prefill']);
});

test('createMessageTrace maps current-message-focus as its own source slot', () => {
    const messages = [
        {
            role: 'system',
            content: '<current-message-focus>\n意图: low_information\n</current-message-focus>',
            meta: { source: 'current_message_focus', sourceId: 'current-message-focus' }
        },
        {
            role: 'user',
            content: '？',
            meta: { source: 'user_input' }
        }
    ];
    const runtimeSources = [
        {
            id: 'current-message-focus',
            kind: 'current_message_focus',
            stage: 'runtime',
            sourceSlot: 'current_message_focus',
            meta: { placement: 'current_message_focus' }
        },
        {
            id: 'user-input',
            kind: 'user_input',
            stage: 'input',
            sourceSlot: 'user_input',
            meta: { placement: 'user_input' }
        }
    ];

    const trace = PromptBuilder.createMessageTrace(messages, runtimeSources);

    assert.deepEqual(trace[0].sourceSlots, ['current_message_focus']);
    assert.deepEqual(trace[0].sourceIds, ['current-message-focus']);
    assert.deepEqual(trace[1].sourceSlots, ['user_input']);
});
