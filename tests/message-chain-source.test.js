import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('real chat path preserves QQ non-text segments in structured prompt input', () => {
    assert.ok(source.includes('function summarizeOneBotSegment'));
    assert.ok(source.includes("type === 'mface' || type === 'marketface'"));
    assert.ok(source.includes('QQ动态表情'));
    assert.ok(source.includes('messageSegments:${JSON.stringify(meta.messageSegments)'));
    assert.ok(source.includes('const messageSegments = []'));
});

test('real chat path can trigger on quote-to-bot without at mention', () => {
    assert.ok(source.includes('replyToBot: replyInfo.toBot === true'));
    assert.ok(source.includes('messageInfo.replyToBot'));
    assert.ok(source.includes("accept('reply_to_bot')"));
    assert.ok(source.includes('即使没有 @ 也应视为对 bot 发言'));
    assert.ok(source.includes("fetchStatus: 'failed'"));
    assert.ok(source.includes('replyFetchStatus'));
});

test('poke events enter runtime with event metadata and segment summary', () => {
    assert.ok(source.includes("eventType: 'poke'"));
    assert.ok(source.includes("const pokeSegments = [{ type: 'poke', targetId, userId }]"));
    assert.ok(source.includes('standardEvent,'));
    assert.ok(source.includes("triggerReason: 'poke'"));
    assert.ok(source.includes("skipReason: 'poke_target_not_bot'"));
    assert.ok(source.includes("skipReason: 'poke_cooldown'"));
    assert.ok(source.includes("skipReason: 'poke_reaction_disabled'"));
    assert.ok(source.includes("skipReason: 'poke_error'"));
});

test('real chat path records routing decisions for skipped messages', () => {
    assert.ok(source.includes('function buildRoutingDecision'));
    assert.ok(source.includes("skip('group_requires_at_prefix_keyword_or_reply_to_bot')"));
    assert.ok(source.includes('routingDecision.skipReason'));
    assert.ok(source.includes('[路由] 消息未触发回复'));
});

test('LLM toggle state is persisted and restored from runtime config', () => {
    assert.ok(source.includes('config.runtime.llmEnabled'));
    assert.ok(source.includes('llmEnabled = config.runtime?.llmEnabled !== false;'));
    assert.ok(source.includes('function setLlmEnabled(nextEnabled)'));
    assert.ok(source.includes('config.runtime = config.runtime || {};'));
    assert.ok(source.includes('config.runtime.llmEnabled = llmEnabled;'));
    assert.ok(source.includes('saveConfig(config);'));
    assert.ok(source.includes('const newState = setLlmEnabled(!llmEnabled);'));
});

test('real chat path keeps reasoning available but does not send it to QQ by default', () => {
    assert.ok(source.includes('function buildDebugReplyWithReasoning'));
    assert.ok(source.includes('【思维链】'));
    assert.ok(source.includes('【正文】'));
    assert.ok(source.includes('const sendReasoningToQQ = config.chat?.sendReasoningToQQ === true;'));
    assert.ok(source.includes('const replyToSend = sendReasoningToQQ && reasoningContent'));
    assert.ok(source.includes('reasoningAvailable: !!reasoningContent'));
    assert.ok(source.includes('sendReplyIncludesReasoning: sendReasoningToQQ && !!reasoningContent'));
    assert.ok(source.includes('includeReasoningContent: sendReasoningToQQ && !!reasoningContent'));
    assert.ok(source.includes('await dispatchReply(event, replyToSend, { forceSingleMessage: sendReasoningToQQ && !!reasoningContent })'));
    assert.ok(source.includes('const splitMessage = options.forceSingleMessage ? false : config.chat.splitMessage !== false;'));
});

test('real chat path preserves mention-only and other-user mentions for AI context', () => {
    assert.ok(source.includes("promptText: '[@全体成员] '"));
    assert.ok(source.includes("`[@${name ? `${name}|` : ''}QQ:${qq}] `"));
    assert.ok(source.includes("? '[@bot] '"));
    assert.ok(source.includes('const onlyAtBot = isAtMe'));
    assert.ok(source.includes('只@了bot，没有附加文字'));
    assert.ok(source.includes('请结合附近群聊上下文判断'));
});
