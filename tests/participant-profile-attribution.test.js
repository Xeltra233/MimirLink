import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SessionManager } from '../src/session.js';
import { buildParticipantProfilePrompt } from '../src/participant-profile-runtime.js';

function createTempManager() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-profile-attr-'));
    const manager = new SessionManager(tempDir, {
        chat: { historyLimit: 50, maxGlobalMessages: 2000, sessionMode: 'group_shared' },
        memory: {
            storage: { path: path.join(tempDir, 'memory.sqlite') },
            summary: { enabled: false }
        }
    }, { info() {}, warn() {}, error() {}, debug() {} });
    return { manager, tempDir };
}

function cleanup(manager, tempDir) {
    try {
        manager.close?.();
    } catch {
        // ignore close races in tests
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
}

const namespace = {
    scopeType: 'group_shared',
    scopeKey: 'group:10086',
    characterName: '角色A',
    presetName: '预设A'
};

/**
 * 正确语义：
 * - 分析时要保留对话上下文（Bot / 相关第三者），不能只喂目标本人孤立发言
 * - 必须把说话人掰开：目标人物 / Bot / 第三者
 * - 档案结论只能来自目标人物本人发言
 */

test('源收集以目标人物为锚点拉入 Bot 回复，并标注 speakerType=bot', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';
        const targetName = 'NewJanZ';

        manager.addMessage(sessionId, 'user', '我最近在学画画', {
            userId: targetId,
            participantName: targetName,
            groupId: '10086',
            messageType: 'group'
        });
        manager.addMessage(sessionId, 'assistant', '画什么题材？我可以给你参考。', {
            replyTo: targetId,
            messageType: 'group',
            groupId: '10086'
        });
        manager.addMessage(sessionId, 'user', '想画夜景城市', {
            userId: targetId,
            participantName: targetName,
            groupId: '10086',
            messageType: 'group'
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'all'
        });

        const contents = source.messages.map((item) => item.content);
        assert.ok(contents.some((text) => text.includes('我最近在学画画')));
        assert.ok(contents.some((text) => text.includes('想画夜景城市')));
        assert.ok(contents.some((text) => text.includes('画什么题材？我可以给你参考。')));

        const botMsg = source.messages.find((item) => item.content.includes('画什么题材'));
        assert.equal(botMsg.speakerType, 'bot');
        assert.equal(botMsg.isTargetSpeaker, false);

        const targetMsgs = source.messages.filter((item) => item.speakerType === 'target');
        assert.equal(targetMsgs.length, 2);
        assert.ok(targetMsgs.every((item) => item.isTargetSpeaker === true));
        assert.equal(source.botMessageCount >= 1, true);
        assert.equal(source.targetMessageCount, 2);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('源收集保留第三者群友上下文，但标注 speakerType=third_party', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';
        const thirdId = '10002';

        manager.addMessage(sessionId, 'user', '你们觉得今晚去哪吃？', {
            userId: thirdId,
            participantName: '第三者群友',
            groupId: '10086',
            messageType: 'group'
        });
        manager.addMessage(sessionId, 'user', '我请，去吃火锅', {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group'
        });
        manager.addMessage(sessionId, 'user', '那我带饮料', {
            userId: thirdId,
            participantName: '第三者群友',
            groupId: '10086',
            messageType: 'group'
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'all'
        });

        assert.ok(source.messages.length >= 3);
        const targetMsg = source.messages.find((item) => item.content.includes('我请，去吃火锅'));
        const thirdBefore = source.messages.find((item) => item.content.includes('你们觉得今晚去哪吃'));
        const thirdAfter = source.messages.find((item) => item.content.includes('那我带饮料'));

        assert.equal(targetMsg.speakerType, 'target');
        assert.equal(targetMsg.isTargetSpeaker, true);
        assert.equal(thirdBefore.speakerType, 'third_party');
        assert.equal(thirdBefore.isTargetSpeaker, false);
        assert.equal(thirdAfter.speakerType, 'third_party');
        assert.equal(thirdAfter.isTargetSpeaker, false);
        assert.equal(source.thirdPartyMessageCount >= 2, true);
        assert.equal(source.targetMessageCount, 1);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('assistant 即使误带目标 userId，也必须标注为 bot，不能当目标人物发言', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';

        manager.addMessage(sessionId, 'user', '我今天好累', {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group'
        });
        manager.addMessage(sessionId, 'assistant', '那你早点休息，别熬夜了。', {
            userId: targetId,
            replyTo: targetId,
            messageType: 'group',
            groupId: '10086'
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'all'
        });

        const botMsg = source.messages.find((item) => item.content.includes('那你早点休息'));
        assert.ok(botMsg, 'Bot 回复应作为上下文保留');
        assert.equal(botMsg.speakerType, 'bot');
        assert.equal(botMsg.isTargetSpeaker, false);
        assert.equal(botMsg.speakerId, 'bot');

        const targetMsgs = source.messages.filter((item) => item.speakerType === 'target');
        assert.equal(targetMsgs.length, 1);
        assert.match(targetMsgs[0].content, /我今天好累/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('bot_only 保留与 Bot 有交互的对话上下文，而不是滤空或把 Bot 当目标', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';

        manager.addMessage(sessionId, 'user', '帮我看看这段代码', {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group'
        });
        manager.addMessage(sessionId, 'assistant', '这段逻辑没问题，可以合并。', {
            replyTo: targetId,
            messageType: 'group',
            groupId: '10086'
        });
        manager.addMessage(sessionId, 'user', '好，我去提 PR', {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group'
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'bot_only'
        });

        assert.ok(source.messages.length >= 3);
        assert.equal(source.hasEnoughNewInfo, true);
        assert.equal(source.targetMessageCount, 2);
        assert.equal(source.botMessageCount >= 1, true);

        const botMsg = source.messages.find((item) => item.content.includes('这段逻辑没问题'));
        assert.equal(botMsg.speakerType, 'bot');
        assert.equal(botMsg.isTargetSpeaker, false);
        assert.ok(source.messages.every((item) => item.speakerType !== 'target' || item.content.includes('帮我看看') || item.content.includes('提 PR')));
    } finally {
        cleanup(manager, tempDir);
    }
});

test('prompt 必须把目标人物/Bot/第三者掰开，并禁止串话写入档案', () => {
    const prompt = buildParticipantProfilePrompt({
        existing: null,
        messages: [
            {
                sessionId: 'group:10086',
                role: 'user',
                content: '我请大家吃火锅',
                metadata: { userId: '2661097662', participantName: 'NewJanZ' },
                speakerType: 'target',
                speakerId: '2661097662',
                speakerName: 'NewJanZ',
                quote: {
                    speakerType: 'quoted',
                    speakerId: '10002',
                    speakerName: '第三者群友',
                    content: '今晚有空吗'
                }
            },
            {
                sessionId: 'group:10086',
                role: 'assistant',
                content: '好啊，我订位置',
                metadata: { replyTo: '2661097662' },
                speakerType: 'bot',
                speakerId: 'bot',
                speakerName: 'Bot'
            },
            {
                sessionId: 'group:10086',
                role: 'user',
                content: '那我带饮料',
                metadata: { userId: '10002', participantName: '第三者群友' },
                speakerType: 'third_party',
                speakerId: '10002',
                speakerName: '第三者群友'
            }
        ]
    }, 'profile_plus_messages', {
        participantId: '2661097662',
        participantName: 'NewJanZ'
    });

    assert.match(prompt, /目标人物：NewJanZ（QQ:2661097662）/);
    assert.match(prompt, /\[说话人:目标人物\|NewJanZ\|QQ:2661097662\] 我请大家吃火锅/);
    assert.match(prompt, /\[说话人:Bot\] 好啊，我订位置/);
    assert.match(prompt, /\[说话人:第三者\|第三者群友\|QQ:10002\] 那我带饮料/);
    assert.match(prompt, /引用原文\(仅背景，不是本人发言/);
    assert.match(prompt, /不得把 Bot 或第三者的话写成目标人物说的/);
    assert.match(prompt, /只能依据“说话人=目标人物”的本人发言归纳/);
    assert.doesNotMatch(prompt, /\[group:10086\] user: 我请大家吃火锅/);
    assert.doesNotMatch(prompt, /\[group:10086\] assistant: 好啊，我订位置/);
});

test('引用第三者原文会从目标消息中拆成 quote，本人新增文本单独保留', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';
        const quotedTargetMessage = [
            '[群聊|QQ:2661097662|昵称:NewJanZ|群号:10086|群名:测试群|时间:2026/7/15 12:00:00|replyQuotedText:我今天加班到很晚]',
            '[回复上文|发送者:第三者群友|QQ:10002|内容:我今天加班到很晚] 辛苦了，我请你喝奶茶'
        ].join(' ');

        manager.addMessage(sessionId, 'user', quotedTargetMessage, {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group'
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'all'
        });

        assert.equal(source.messages.length, 1);
        const targetMsg = source.messages[0];
        assert.equal(targetMsg.speakerType, 'target');
        assert.equal(targetMsg.content, '辛苦了，我请你喝奶茶');
        assert.equal(targetMsg.hasQuote, true);
        assert.ok(targetMsg.quote);
        assert.equal(targetMsg.quote.content, '我今天加班到很晚');
        assert.equal(targetMsg.quote.speakerName, '第三者群友');
        assert.equal(targetMsg.quote.speakerId, '10002');
        assert.match(targetMsg.rawContent, /我今天加班到很晚/);
        assert.doesNotMatch(targetMsg.content, /我今天加班到很晚/);
        assert.doesNotMatch(targetMsg.content, /回复上文|replyQuotedText|群聊\|QQ:/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('群 batch 多人合并脏文本会按说话人拆开，第三者不再挂到目标人物', () => {
    const { manager, tempDir } = createTempManager();
    try {
        const sessionId = 'group:10086';
        const targetId = '2661097662';

        const mergedDirtyText = [
            '[群聊|QQ:10002|昵称:第三者群友] 我讨厌加班',
            '[群聊|QQ:2661097662|昵称:NewJanZ] 我还好，比较能熬'
        ].join('\n');

        manager.addMessage(sessionId, 'user', mergedDirtyText, {
            userId: targetId,
            participantName: 'NewJanZ',
            groupId: '10086',
            messageType: 'group',
            mergedCount: 2,
            participants: ['第三者群友(10002)', 'NewJanZ(2661097662)']
        });

        const source = manager.collectParticipantProfileSource(targetId, namespace, {
            threshold: 1,
            limit: 50,
            sourceFilter: 'all'
        });

        assert.ok(source.messages.length >= 2);
        const targetMsg = source.messages.find((item) => item.speakerType === 'target');
        const thirdMsg = source.messages.find((item) => item.speakerType === 'third_party');

        assert.ok(targetMsg, '应拆出目标人物发言');
        assert.ok(thirdMsg, '应拆出第三者发言');
        assert.equal(targetMsg.content, '我还好，比较能熬');
        assert.equal(thirdMsg.content, '我讨厌加班');
        assert.equal(thirdMsg.speakerId, '10002');
        assert.equal(thirdMsg.speakerName, '第三者群友');
        assert.equal(targetMsg.isTargetSpeaker, true);
        assert.equal(thirdMsg.isTargetSpeaker, false);
        assert.doesNotMatch(targetMsg.content, /我讨厌加班/);
        assert.equal(source.targetMessageCount, 1);
        assert.equal(source.thirdPartyMessageCount >= 1, true);
        assert.equal(Array.isArray(source.messages[0].utterances), true);
    } finally {
        cleanup(manager, tempDir);
    }
});

