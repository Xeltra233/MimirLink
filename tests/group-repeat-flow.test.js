import test from 'node:test';
import assert from 'node:assert/strict';

import { GroupRepeatDetector } from '../src/group-repeat.js';

function createHarness() {
    const config = {
        chat: {
            groupRepeat: {
                enabled: true,
                triggerCount: 2,
                cooldownMs: 1000
            }
        }
    };
    const detector = new GroupRepeatDetector();
    const records = {
        messages: [],
        memories: [],
        sends: []
    };
    let llmCalls = 0;
    let nextMessageId = 1;

    const sessionManager = {
        addMessage(sessionId, role, content, metadata = {}) {
            const record = {
                id: `msg-${nextMessageId++}`,
                sessionId,
                role,
                content,
                metadata
            };
            records.messages.push(record);
            return record;
        },
        upsertConversationMemory(namespace, entry) {
            records.memories.push({ namespace, entry });
        }
    };

    const bot = {
        selfId: '99999',
        async sendGroupMessage(groupId, message) {
            records.sends.push({ groupId, message });
        }
    };

    async function processRepeatWatchBatch(items, { now = Date.now(), sessionId = 'group:10001' } = {}) {
        const responseItem = [...items].reverse().find((item) => item.routingDecision?.shouldRespond) || null;
        const primary = responseItem || items[items.length - 1];
        const shouldRunLlm = Boolean(responseItem);
        const processedInput = items
            .map((item) => item.structuredText || item.plainText || '')
            .filter(Boolean)
            .join('\n')
            .trim();

        if (!processedInput) {
            return { action: 'empty' };
        }

        const userRecord = sessionManager.addMessage(sessionId, 'user', processedInput, {
            messageType: primary.event.message_type,
            userId: primary.event.user_id,
            groupId: primary.event.group_id,
            mergedCount: items.length,
            triggerReason: primary.triggerReason,
            inboundMessageIds: items.map((item) => item.event.message_id).filter(Boolean)
        });
        sessionManager.upsertConversationMemory({ scopeType: 'group_shared', scopeKey: sessionId }, {
            userMessage: processedInput,
            sourceSessionId: sessionId,
            sourceMessageId: userRecord.id
        });

        const groupRepeatResult = detector.observeBatch({
            config,
            items,
            botSelfId: bot.selfId,
            now
        });
        if (groupRepeatResult.shouldRepeat) {
            const event = groupRepeatResult.event || primary.event;
            sessionManager.addMessage(sessionId, 'assistant', groupRepeatResult.repeatText, {
                replyTo: event.user_id,
                messageType: event.message_type,
                groupId: event.group_id,
                generatedBy: 'group_repeat'
            });
            sessionManager.upsertConversationMemory({ scopeType: 'group_shared', scopeKey: sessionId }, {
                userMessage: processedInput,
                assistantMessage: groupRepeatResult.repeatText,
                sourceSessionId: sessionId,
                sourceMessageId: userRecord.id
            });
            await bot.sendGroupMessage(event.group_id, groupRepeatResult.repeatText);
            return { action: 'repeat', result: groupRepeatResult };
        }

        if (!shouldRunLlm) {
            return { action: groupRepeatResult.reason || 'skip_llm', result: groupRepeatResult };
        }

        llmCalls += 1;
        throw new Error('LLM should not run for group repeat watch messages');
    }

    return {
        config,
        detector,
        records,
        processRepeatWatchBatch,
        get llmCalls() {
            return llmCalls;
        }
    };
}

function makeRepeatItem(messageId, userId, text = 'repeat me') {
    return {
        plainText: text,
        structuredText: text,
        triggerReason: 'group_repeat_watch',
        routingDecision: { shouldRespond: false, checks: { allowed: true } },
        event: {
            message_type: 'group',
            group_id: 10001,
            user_id: userId,
            message_id: messageId,
            raw_message: text
        }
    };
}

test('group repeat simulated chain stores input, skips LLM and sends direct repeat', async () => {
    const harness = createHarness();

    const result = await harness.processRepeatWatchBatch([
        makeRepeatItem('m-1', 20001),
        makeRepeatItem('m-2', 20002)
    ], { now: 1000 });

    assert.equal(result.action, 'repeat');
    assert.equal(result.result.repeatText, 'repeat me');
    assert.deepEqual(harness.records.sends, [{ groupId: 10001, message: 'repeat me' }]);
    assert.equal(harness.llmCalls, 0);

    assert.equal(harness.records.messages.length, 2);
    assert.equal(harness.records.messages[0].role, 'user');
    assert.equal(harness.records.messages[0].content, 'repeat me\nrepeat me');
    assert.deepEqual(harness.records.messages[0].metadata.inboundMessageIds, ['m-1', 'm-2']);
    assert.equal(harness.records.messages[0].metadata.mergedCount, 2);
    assert.equal(harness.records.messages[1].role, 'assistant');
    assert.equal(harness.records.messages[1].content, 'repeat me');
    assert.equal(harness.records.messages[1].metadata.generatedBy, 'group_repeat');

    assert.equal(harness.records.memories.length, 2);
    assert.equal(harness.records.memories[0].entry.userMessage, 'repeat me\nrepeat me');
    assert.equal(harness.records.memories[1].entry.userMessage, 'repeat me\nrepeat me');
    assert.equal(harness.records.memories[1].entry.assistantMessage, 'repeat me');
});

test('group repeat simulated chain stores cooldown messages without another send or LLM call', async () => {
    const harness = createHarness();

    await harness.processRepeatWatchBatch([
        makeRepeatItem('m-1', 20001, 'cooldown line'),
        makeRepeatItem('m-2', 20002, 'cooldown line')
    ], { now: 1000 });

    const suppressed = await harness.processRepeatWatchBatch([
        makeRepeatItem('m-3', 20003, 'cooldown line'),
        makeRepeatItem('m-4', 20004, 'cooldown line')
    ], { now: 1500 });

    assert.equal(suppressed.action, 'cooldown');
    assert.equal(harness.records.sends.length, 1);
    assert.equal(harness.records.sends[0].message, 'cooldown line');
    assert.equal(harness.llmCalls, 0);
    assert.equal(harness.records.messages.filter((message) => message.role === 'user').length, 2);
    assert.equal(harness.records.messages.filter((message) => message.role === 'assistant').length, 1);
    assert.equal(harness.records.messages[2].content, 'cooldown line\ncooldown line');
    assert.deepEqual(harness.records.messages[2].metadata.inboundMessageIds, ['m-3', 'm-4']);
    assert.equal(harness.records.memories.length, 3);
    assert.equal(harness.records.memories[2].entry.userMessage, 'cooldown line\ncooldown line');
    assert.equal(harness.records.memories[2].entry.assistantMessage, undefined);

    const afterCooldown = await harness.processRepeatWatchBatch([
        makeRepeatItem('m-5', 20005, 'cooldown line'),
        makeRepeatItem('m-6', 20006, 'cooldown line')
    ], { now: 2101 });

    assert.equal(afterCooldown.action, 'repeat');
    assert.equal(harness.records.sends.length, 2);
    assert.equal(harness.records.sends[1].message, 'cooldown line');
    assert.equal(harness.llmCalls, 0);
});
