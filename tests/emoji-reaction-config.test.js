import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('emoji reaction requires explicit config true and uses a shared sender', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const participantStart = source.indexOf('async function handleParticipantProfileManualCommand');
    const participantEnd = source.indexOf('async function handleAdminMentionCommand');
    const mentionEnd = source.indexOf('async function processBatch');
    const handleMessageStart = source.indexOf('async function handleMessage');
    const handleMessageEnd = source.indexOf("bot.on('message'");
    assert.notEqual(participantStart, -1);
    assert.notEqual(participantEnd, -1);
    assert.notEqual(mentionEnd, -1);
    assert.notEqual(handleMessageStart, -1);
    assert.notEqual(handleMessageEnd, -1);

    const participantHandler = source.slice(participantStart, participantEnd);
    const mentionHandler = source.slice(participantEnd, mentionEnd);
    const handleMessage = source.slice(handleMessageStart, handleMessageEnd);

    assert.ok(source.includes('config.chat.emojiReaction = config.chat.emojiReaction === true;'));
    assert.ok(source.includes('config.chat.emojiReactionId = normalizeEmojiReactionId'));
    assert.ok(source.includes('function shouldSendEmojiReaction(config) {'));
    assert.ok(source.includes('return config.chat?.emojiReaction === true;'));
    assert.ok(source.includes('function sendEmojiReactionForEvent(event) {'));
    assert.ok(source.includes('const emojiId = resolveEmojiReactionId(config);'));
    assert.ok(source.includes('bot.setMsgEmojiLike(event.message_id, emojiId)'));
    assert.ok(participantHandler.includes('sendEmojiReactionForEvent(event);'));
    assert.ok(mentionHandler.includes('sendEmojiReactionForEvent(event);'));
    assert.ok(handleMessage.includes("plainText.trim() === '/llm'"));
    assert.ok(handleMessage.includes('sendEmojiReactionForEvent(event);'));
    assert.ok(handleMessage.includes('if (routingDecision.shouldRespond) {'));
});

test('admin config UI exposes and persists emoji reaction switch', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-chat-emoji-reaction"'));
    assert.ok(html.includes('id="config-chat-emoji-reaction-id"'));
    assert.ok(html.includes("currentConfig.chat?.emojiReaction === true"));
    assert.ok(html.includes("currentConfig.chat?.emojiReactionId || '289'"));
    assert.ok(html.includes("emojiReaction: document.getElementById('config-chat-emoji-reaction').checked"));
    assert.ok(html.includes("emojiReactionId: document.getElementById('config-chat-emoji-reaction-id').value.trim() || '289'"));
    assert.ok(html.includes('set_msg_emoji_like'));
});

test('example config keeps emoji reaction off unless enabled', () => {
    const config = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
    assert.equal(config.chat.emojiReaction, false);
    assert.equal(config.chat.emojiReactionId, '289');
});
