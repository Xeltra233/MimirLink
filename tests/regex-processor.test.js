import test from 'node:test';
import assert from 'node:assert/strict';

import { RegexProcessor } from '../src/regex.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

test('regex processor strips leaked current-message-focus metadata after a visible reply', () => {
    const processor = new RegexProcessor({
        enabled: true,
        usePresetRules: false,
        rules: []
    }, silentLogger);

    const text = [
        '@炸天帮-轰地舵-Even（直接气笑了）没有，滚粗！',
        '事件: message / group',
        '发言人: 炸天帮-轰地舵-Even(1611022927)',
        '意图: chat',
        '回复目标: reply_to_mentioned_bot_request',
        '触发: yes / at',
        '低信息: no | 表情: no | 换话题: no | 释放旧话题: no',
        '最新输入: [@bot] 哪里有无限美国豆包系统',
        '策略: read_header_first, answer_latest_user_text, keep_one_to_three_short_sentences'
    ].join('\n');

    const result = processor.processOutput(text);

    assert.equal(result, '@炸天帮-轰地舵-Even（直接气笑了）没有，滚粗！');
});
test('regex processor strips leaked current-message-focus metadata before a visible reply', () => {
    const processor = new RegexProcessor({
        enabled: true,
        usePresetRules: false,
        rules: []
    }, silentLogger);

    const text = [
        '事件: message / group',
        '发言人: Even(1611022927)',
        '意图: chat',
        '回复目标: reply_to_mentioned_bot_request',
        '触发: yes / at',
        '低信息: no | 表情: no | 换话题: no | 释放旧话题: no',
        '最新输入: [@bot] 哪里有无限美国豆包系统',
        '策略: read_header_first, answer_latest_user_text',
        '没有，滚粗！'
    ].join('\n');

    const result = processor.processOutput(text);

    assert.equal(result, '没有，滚粗！');
});
