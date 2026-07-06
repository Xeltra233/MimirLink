import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildAIToolContext, buildRealtimeGroundingMessage } from '../src/tools.js';
import {
    executeAdminPokeCommand,
    normalizeEmojiReactionId,
    resolveEmojiReactionId
} from '../src/qq-interactions.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildPokeEvent(overrides = {}) {
    return {
        post_type: 'message',
        message_type: 'group',
        group_id: '123456',
        user_id: '10001',
        message_id: 987,
        raw_message: '/戳一戳 @10002',
        message: [
            { type: 'text', data: { text: '/戳一戳 ' } },
            { type: 'at', data: { qq: '10002' } }
        ],
        ...overrides
    };
}

test('admin poke command calls OneBot group_poke five times', async () => {
    const pokeCalls = [];
    const statuses = [];
    const result = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        command: '/戳一戳',
        repeatCount: 5,
        isAdmin: true,
        bot: {
            async sendGroupPoke(groupId, userId) {
                pokeCalls.push({ groupId, userId });
            }
        },
        onCommandAccepted() {
            statuses.push('emoji');
        },
        sendStatusMessage(message) {
            statuses.push(message);
        },
        sendFailureMessage(message) {
            statuses.push(`failure:${message}`);
        },
        logger: silentLogger
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(result.targetUserId, '10002');
    assert.equal(result.repeatCount, 5);
    assert.equal(pokeCalls.length, 5);
    assert.deepEqual(new Set(pokeCalls.map((item) => `${item.groupId}:${item.userId}`)), new Set(['123456:10002']));
    assert.equal(statuses[0], 'emoji');
    assert.match(statuses.at(-1), /已戳一戳 QQ 10002 5 下/);
});

test('admin poke command reports visible failure states', async () => {
    const failures = [];
    const nonAdmin = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        isAdmin: false,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(nonAdmin.handled, true);
    assert.equal(nonAdmin.ok, false);
    assert.match(failures.at(-1), /只有管理员/);

    const missingTarget = await executeAdminPokeCommand({
        event: buildPokeEvent({ message: [{ type: 'text', data: { text: '/戳一戳' } }] }),
        plainText: '/戳一戳',
        isAdmin: true,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(missingTarget.reason, 'missing_target');
    assert.match(failures.at(-1), /@某人/);

    const notGroup = await executeAdminPokeCommand({
        event: buildPokeEvent({ message_type: 'private', group_id: null }),
        plainText: '/戳一戳',
        isAdmin: true,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(notGroup.reason, 'not_group');
    assert.match(failures.at(-1), /仅支持群聊/);

    const botFailure = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        repeatCount: 5,
        isAdmin: true,
        bot: {
            async sendGroupPoke() {
                throw new Error('OneBot refused');
            }
        },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(botFailure.reason, 'poke_failed');
    assert.match(failures.at(-1), /OneBot refused/);
});

test('QQ emoji reaction supports numeric ids and aliases while preserving switch semantics', () => {
    assert.equal(normalizeEmojiReactionId('277'), '277');
    assert.equal(normalizeEmojiReactionId('qq:277'), '277');
    assert.equal(normalizeEmojiReactionId('点赞'), '76');
    assert.equal(normalizeEmojiReactionId('doge'), '277');
    assert.equal(normalizeEmojiReactionId('未知别名'), '289');
    assert.equal(resolveEmojiReactionId({ chat: { emojiReactionId: '狗头' } }), '277');

    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('return config.chat?.emojiReaction === true;'));
    assert.ok(source.includes('const emojiId = resolveEmojiReactionId(config);'));
    assert.ok(source.includes('bot.setMsgEmojiLike(event.message_id, emojiId)'));
});

test('web_search returns grounding data for at least 100 realtime rounds instead of final replies', async () => {
    const toolContext = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    webSearch: {
                        enabled: true,
                        provider: 'duckduckgo',
                        maxResults: 1,
                        timeoutMs: 5000,
                        maxSnippetLength: 800
                    }
                }
            }
        },
        logger: silentLogger
    });

    for (let round = 0; round < 100; round += 1) {
        const result = await toolContext.handlers.web_search({
            query: '现在北京时间是几点',
            limit: 1
        });
        assert.equal(result.ok, true, `round ${round}`);
        assert.equal(result.source, 'local_beijing_time', `round ${round}`);
        assert.equal(result.resultCount, 1, `round ${round}`);
        assert.equal('reply' in result, false, `round ${round}`);
        assert.equal('response' in result, false, `round ${round}`);
        assert.match(result.results[0].snippet, /当前北京时间/, `round ${round}`);
    }

    const grounding = await buildRealtimeGroundingMessage({
        config: {
            ai: {
                tools: {
                    webSearch: { enabled: true, provider: 'duckduckgo', maxResults: 1 }
                }
            }
        },
        query: '现在北京时间是几点',
        logger: silentLogger
    });
    assert.equal('reply' in grounding, false);
    assert.match(grounding.message, /检索结果/);
});

test('runtime code no longer exposes realtime direct-answer bypass', () => {
    const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const routesSource = fs.readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
    const toolsSource = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
    const publicSource = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    for (const source of [indexSource, routesSource, toolsSource, publicSource]) {
        assert.doesNotMatch(source, /generateRealtimeAnswer/);
        assert.doesNotMatch(source, /buildDirectRealtimeResponse/);
        assert.doesNotMatch(source, /realtime_bypass/);
    }
});

test('config UI exposes poke command and QQ emoji id settings', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-chat-emoji-reaction-id"'));
    assert.ok(html.includes('currentConfig.chat?.emojiReactionId ||'));
    assert.ok(html.includes("emojiReactionId: document.getElementById('config-chat-emoji-reaction-id').value.trim() || '289'"));
    assert.ok(html.includes('id="config-chat-command-admin-poke-enabled"'));
    assert.ok(html.includes('id="config-chat-command-admin-poke-command"'));
    assert.ok(html.includes('id="config-chat-command-admin-poke-repeat"'));
    assert.ok(html.includes('adminPoke: {'));
});
