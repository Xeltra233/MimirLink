import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import express from 'express';

import {
    GroupRepeatDetector,
    getDefaultGroupRepeatConfig,
    getRepeatableMessageText,
    normalizeGroupRepeatConfig,
    normalizeRepeatText,
    shouldObserveGroupRepeatMessage
} from '../src/group-repeat.js';
import { setupRoutes } from '../src/routes.js';

let testPortOffset = 0;

async function listenTestApp(app) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const port = 24080 + (testPortOffset++ % 2000);
        const server = await new Promise((resolve, reject) => {
            const candidate = app.listen(port, '127.0.0.1', () => resolve(candidate));
            candidate.once('error', reject);
        }).catch((error) => {
            if (error?.code === 'EADDRINUSE') return null;
            throw error;
        });
        if (server) return server;
    }
    throw new Error('No available test port');
}

function createManagers(config) {
    return {
        characterManager: { getCurrentCharacter: () => null },
        worldBookManager: { getCurrentWorldBook: () => null },
        sessionManager: {
            getDbPath: () => './data/chats/memory-store.sqlite',
            listSessions: () => [],
            getStats: () => ({}),
            setConfig() {}
        },
        regexProcessor: {
            updateConfig() {},
            getRules: () => []
        },
        aiClient: { updateConfig() {} },
        promptBuilder: { updateConfig() {} },
        logger: {
            info() {},
            warn() {},
            error() {},
            debug() {}
        },
        bot: null,
        ttsManager: { updateConfig() {} },
        VOICE_TYPES: {},
        runtime: {
            updateConfig() {},
            getStats: () => ({})
        },
        getLastRoutingSnapshot: () => null,
        formatSessionLabel: () => '',
        getLastInjectionObservation: () => null,
        getRecentInjectionObservations: () => [],
        getLastRecallSnapshot: () => null,
        clearParticipantProfileTimers: () => {}
    };
}

test('group repeat config defaults to disabled with two-message trigger and three-minute cooldown', () => {
    assert.deepEqual(normalizeGroupRepeatConfig(), {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
    assert.deepEqual(getDefaultGroupRepeatConfig(), {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
});

test('group repeat config clamps invalid saved values without breaking old config', () => {
    assert.deepEqual(normalizeGroupRepeatConfig({
        enabled: true,
        triggerCount: 1,
        cooldownMs: 999999999
    }), {
        enabled: true,
        triggerCount: 2,
        cooldownMs: 3600000
    });

    assert.deepEqual(normalizeGroupRepeatConfig({
        enabled: 'true',
        triggerCount: '4',
        cooldownMs: '60000'
    }), {
        enabled: false,
        triggerCount: 4,
        cooldownMs: 60000
    });
});

test('example config exposes group repeat settings under chat config', async () => {
    const raw = await readFile(new URL('../config.example.json', import.meta.url), 'utf8');
    const config = JSON.parse(raw);

    assert.deepEqual(config.chat.groupRepeat, {
        enabled: false,
        triggerCount: 2,
        cooldownMs: 180000
    });
});

test('/api/config reads and saves group repeat settings', async () => {
    const app = express();
    app.use(express.json());

    const config = {
        auth: { enabled: false },
        onebot: {},
        ai: { providers: [], tools: { webSearch: {} } },
        chat: {
            accessControlMode: 'disabled',
            groupRepeat: {
                enabled: false,
                triggerCount: 2,
                cooldownMs: 180000
            }
        },
        memory: { participantProfile: {} },
        regex: { rules: [] },
        preset: { regexRules: [] },
        bindings: { global: { regexRules: [] }, characters: {} },
        imports: { presetFiles: [], regexFiles: [] },
        server: {},
        tts: {}
    };
    let savedConfig = null;

    setupRoutes(app, config, (nextConfig) => {
        savedConfig = structuredClone(nextConfig);
    }, createManagers(config));

    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const beforeResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
        const beforeBody = await beforeResponse.json();
        assert.equal(beforeResponse.status, 200, JSON.stringify(beforeBody));
        assert.deepEqual(beforeBody.chat.groupRepeat, {
            enabled: false,
            triggerCount: 2,
            cooldownMs: 180000
        });

        const saveResponse = await fetch(`http://127.0.0.1:${port}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat: {
                    groupRepeat: {
                        enabled: true,
                        triggerCount: 2,
                        cooldownMs: 60000
                    }
                }
            })
        });
        const saveBody = await saveResponse.json();
        assert.equal(saveResponse.status, 200, JSON.stringify(saveBody));
        assert.equal(saveBody.success, true);
        assert.deepEqual(savedConfig.chat.groupRepeat, {
            enabled: true,
            triggerCount: 2,
            cooldownMs: 60000
        });

        const afterResponse = await fetch(`http://127.0.0.1:${port}/api/config`);
        const afterBody = await afterResponse.json();
        assert.equal(afterResponse.status, 200, JSON.stringify(afterBody));
        assert.deepEqual(afterBody.chat.groupRepeat, savedConfig.chat.groupRepeat);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});

test('group repeat detector triggers on two consecutive same group messages', () => {
    const detector = new GroupRepeatDetector();
    const config = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 180000 } } };
    const first = detector.observeMessage({
        config,
        event: { message_type: 'group', group_id: 10001, user_id: 20001 },
        text: '  复读   一下  ',
        botSelfId: '99999'
    });
    const second = detector.observeMessage({
        config,
        event: { message_type: 'group', group_id: 10001, user_id: 20002 },
        text: '复读 一下',
        botSelfId: '99999'
    });

    assert.equal(first.shouldRepeat, false);
    assert.equal(first.count, 1);
    assert.equal(second.shouldRepeat, true);
    assert.equal(second.repeatText, '复读 一下');
    assert.equal(second.groupId, '10001');
});

test('group repeat detector ignores private messages, empty text, disabled config and bot self messages', () => {
    const detector = new GroupRepeatDetector();
    const enabledConfig = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 180000 } } };
    const disabledConfig = { chat: { groupRepeat: { enabled: false, triggerCount: 2, cooldownMs: 180000 } } };

    assert.equal(normalizeRepeatText('  a \n\t b  '), 'a b');
    assert.equal(shouldObserveGroupRepeatMessage({
        config: enabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 99999 },
        text: '复读',
        botSelfId: '99999'
    }), false);
    assert.equal(shouldObserveGroupRepeatMessage({
        config: enabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 99999, self_id: 99999 },
        text: '复读'
    }), false);
    assert.equal(shouldObserveGroupRepeatMessage({
        config: enabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 20001 },
        text: '复读',
        routingDecision: { checks: { allowed: false } },
        botSelfId: '99999'
    }), false);
    assert.equal(detector.observeMessage({
        config: disabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 20001 },
        text: '复读'
    }).shouldRepeat, false);
    assert.equal(detector.observeMessage({
        config: enabledConfig,
        event: { message_type: 'private', user_id: 20001 },
        text: '复读'
    }).shouldRepeat, false);
    assert.equal(detector.observeMessage({
        config: enabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 20001 },
        text: '   '
    }).shouldRepeat, false);
    assert.equal(detector.observeMessage({
        config: enabledConfig,
        event: { message_type: 'group', group_id: 10001, user_id: 99999 },
        text: '复读',
        botSelfId: '99999'
    }).shouldRepeat, false);
});

test('group repeat detector only observes pure text messages', () => {
    const detector = new GroupRepeatDetector();
    const config = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 180000 } } };
    const baseEvent = { message_type: 'group', group_id: 10001 };

    assert.equal(getRepeatableMessageText({
        ...baseEvent,
        user_id: 20001,
        message: [{ type: 'text', data: { text: ' repeat ' } }]
    }, '[image]'), 'repeat');
    assert.equal(getRepeatableMessageText({
        ...baseEvent,
        user_id: 20001,
        message: [{ type: 'image', data: { summary: 'animation' } }]
    }, '[image:animation]'), '');
    assert.equal(getRepeatableMessageText({
        ...baseEvent,
        user_id: 20001,
        raw_message: '[CQ:image,file=a.png]'
    }, '[image]'), '');

    const imageOne = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20001,
            message: [{ type: 'image', data: { file: 'a.png' } }]
        },
        text: '[image]'
    });
    const imageTwo = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20002,
            message: [{ type: 'image', data: { file: 'b.png' } }]
        },
        text: '[image]'
    });
    const face = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20003,
            message: [{ type: 'mface', data: { summary: 'animation' } }]
        },
        text: '[image:[animation face]]'
    });
    const mixedTextAndImage = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20004,
            message: [
                { type: 'text', data: { text: 'repeat' } },
                { type: 'image', data: { file: 'a.png' } }
            ]
        },
        text: 'repeat[image]'
    });

    assert.equal(imageOne.shouldRepeat, false);
    assert.equal(imageOne.reason, 'not_observable');
    assert.equal(imageTwo.shouldRepeat, false);
    assert.equal(imageTwo.reason, 'not_observable');
    assert.equal(face.shouldRepeat, false);
    assert.equal(face.reason, 'not_observable');
    assert.equal(mixedTextAndImage.shouldRepeat, false);
    assert.equal(mixedTextAndImage.reason, 'not_observable');

    const textOne = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20005,
            message: [{ type: 'text', data: { text: 'repeat' } }]
        },
        text: 'repeat'
    });
    const textTwo = detector.observeMessage({
        config,
        event: {
            ...baseEvent,
            user_id: 20006,
            message: [{ type: 'text', data: { text: 'repeat' } }]
        },
        text: 'repeat'
    });

    assert.equal(textOne.shouldRepeat, false);
    assert.equal(textOne.count, 1);
    assert.equal(textTwo.shouldRepeat, true);
    assert.equal(textTwo.repeatText, 'repeat');
});

test('group repeat detector observes buffered batches in order', () => {
    const detector = new GroupRepeatDetector();
    const config = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 180000 } } };
    const result = detector.observeBatch({
        config,
        botSelfId: '99999',
        items: [
            { plainText: '第一句', event: { message_type: 'group', group_id: 10001, user_id: 20001 } },
            { plainText: '复读', event: { message_type: 'group', group_id: 10001, user_id: 20002 } },
            { plainText: '复读', event: { message_type: 'group', group_id: 10001, user_id: 20003 } }
        ]
    });

    assert.equal(result.shouldRepeat, true);
    assert.equal(result.repeatText, '复读');
    assert.equal(result.event.user_id, 20003);
});

test('group repeat detector suppresses same text during cooldown and restores after expiry', () => {
    const detector = new GroupRepeatDetector();
    const config = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 1000 } } };
    const baseEvent = { message_type: 'group', group_id: 10001 };

    assert.equal(detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20001 },
        text: '别复读了',
        now: 1000
    }).shouldRepeat, false);
    const firstTrigger = detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20002 },
        text: '别复读了',
        now: 1001
    });
    assert.equal(firstTrigger.shouldRepeat, true);
    assert.equal(firstTrigger.cooldownExpiresAt, 2001);

    const suppressedOne = detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20003 },
        text: '别复读了',
        now: 1500
    });
    const suppressedTwo = detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20004 },
        text: '别复读了',
        now: 1501
    });
    assert.equal(suppressedOne.shouldRepeat, false);
    assert.equal(suppressedOne.reason, 'cooldown');
    assert.equal(suppressedTwo.shouldRepeat, false);
    assert.equal(suppressedTwo.reason, 'cooldown');

    const afterCooldownOne = detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20005 },
        text: '别复读了',
        now: 2002
    });
    const afterCooldownTwo = detector.observeMessage({
        config,
        event: { ...baseEvent, user_id: 20006 },
        text: '别复读了',
        now: 2003
    });
    assert.equal(afterCooldownOne.shouldRepeat, false);
    assert.equal(afterCooldownOne.count, 1);
    assert.equal(afterCooldownTwo.shouldRepeat, true);
    assert.equal(afterCooldownTwo.cooldownExpiresAt, 3003);
});

test('group repeat cooldown is scoped per group', () => {
    const detector = new GroupRepeatDetector();
    const config = { chat: { groupRepeat: { enabled: true, triggerCount: 2, cooldownMs: 1000 } } };

    assert.equal(detector.observeBatch({
        config,
        now: 1000,
        items: [
            { plainText: '同一句', event: { message_type: 'group', group_id: 10001, user_id: 20001 } },
            { plainText: '同一句', event: { message_type: 'group', group_id: 10001, user_id: 20002 } }
        ]
    }).shouldRepeat, true);
    assert.equal(detector.observeBatch({
        config,
        now: 1001,
        items: [
            { plainText: '同一句', event: { message_type: 'group', group_id: 10002, user_id: 30001 } },
            { plainText: '同一句', event: { message_type: 'group', group_id: 10002, user_id: 30002 } }
        ]
    }).shouldRepeat, true);
    const suppressedInFirstGroup = detector.observeBatch({
        config,
        now: 1002,
        items: [
            { plainText: '同一句', event: { message_type: 'group', group_id: 10001, user_id: 20003 } },
            { plainText: '同一句', event: { message_type: 'group', group_id: 10001, user_id: 20004 } }
        ]
    });
    assert.equal(suppressedInFirstGroup.shouldRepeat, false);
    assert.equal(suppressedInFirstGroup.reason, 'cooldown');
});

test('real chat path stores group repeat input before direct send and skips LLM', async () => {
    const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
    const addMessageIndex = source.indexOf("const userRecord = sessionManager.addMessage(sessionId, 'user', processedInput");
    const repeatIndex = source.indexOf('const groupRepeatResult = groupRepeatDetector.observeBatch');
    const promptIndex = source.indexOf('const { messages, worldBookCount, worldBookEntries } = await promptBuilder.build', repeatIndex);
    const repeatObservableIndex = source.indexOf('const hasGroupRepeatObservable = batch.items.some');
    const guardedSummaryIndex = source.indexOf('if (shouldRunLlm && !hasGroupRepeatObservable)');

    assert.ok(repeatObservableIndex > 0);
    assert.ok(guardedSummaryIndex > repeatObservableIndex);
    assert.ok(addMessageIndex > 0);
    assert.ok(repeatIndex > addMessageIndex);
    assert.ok(promptIndex > repeatIndex);
    assert.ok(source.includes('await bot.sendGroupMessage(groupRepeatEvent.group_id, groupRepeatResult.repeatText);'));
    assert.ok(source.includes("logger.info('[复读] 群聊复读已直发，跳过 LLM'"));
    assert.ok(source.includes('if (!shouldRunLlm)'));
    assert.ok(source.includes("if (shouldRunLlm && injectionRisk.level === 'high')"));
    assert.ok(source.includes("'group_repeat_watch'"));
});
