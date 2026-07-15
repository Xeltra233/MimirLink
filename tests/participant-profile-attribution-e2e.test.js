import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SessionManager } from '../src/session.js';
import { buildParticipantProfilePrompt } from '../src/participant-profile-runtime.js';

function createTempManager() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-profile-e2e-'));
    const manager = new SessionManager(tempDir, {
        chat: { historyLimit: 80, maxGlobalMessages: 2000, sessionMode: 'group_shared' },
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
        // ignore
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
}

const namespace = {
    scopeType: 'group_shared',
    scopeKey: 'group:10086',
    characterName: '角色A',
    presetName: null
};

const targetId = '2661097662';
const targetName = 'NewJanZ';
const thirdId = '10002';
const thirdName = '第三者群友';

function seedMixedConversation(manager) {
    const botSession = 'group:10086';
    const pureGroupSession = 'group:20001';

    // session A: 目标人物与 Bot 有交互，并夹杂第三者
    manager.addMessage(botSession, 'user', '你们觉得今晚去哪吃？', {
        userId: thirdId,
        participantName: thirdName,
        groupId: '10086',
        messageType: 'group'
    });
    manager.addMessage(botSession, 'user', '我请，去吃火锅', {
        userId: targetId,
        participantName: targetName,
        groupId: '10086',
        messageType: 'group'
    });
    manager.addMessage(botSession, 'assistant', '好啊，我帮你订位置', {
        replyTo: targetId,
        groupId: '10086',
        messageType: 'group'
    });
    manager.addMessage(botSession, 'user', [
        `[群聊|QQ:${targetId}|昵称:${targetName}|群号:10086|replyQuotedText:我今天加班到很晚]`,
        `[回复上文|发送者:${thirdName}|QQ:${thirdId}|内容:我今天加班到很晚] 辛苦了，我请你喝奶茶`
    ].join(' '), {
        userId: targetId,
        participantName: targetName,
        groupId: '10086',
        messageType: 'group'
    });
    manager.addMessage(botSession, 'user', '那我带饮料', {
        userId: thirdId,
        participantName: thirdName,
        groupId: '10086',
        messageType: 'group'
    });

    // session B: 只有群友互聊，没有 Bot
    manager.addMessage(pureGroupSession, 'user', '周末一起爬山吗', {
        userId: thirdId,
        participantName: thirdName,
        groupId: '20001',
        messageType: 'group'
    });
    manager.addMessage(pureGroupSession, 'user', '可以，我带零食', {
        userId: targetId,
        participantName: targetName,
        groupId: '20001',
        messageType: 'group'
    });

    // 模拟 batch 脏文本挂到 primary userId
    manager.addMessage(botSession, 'user', [
        `[群聊|QQ:${thirdId}|昵称:${thirdName}] 我讨厌加班`,
        `[群聊|QQ:${targetId}|昵称:${targetName}] 我还好，比较能熬`
    ].join('\n'), {
        userId: targetId,
        participantName: targetName,
        groupId: '10086',
        messageType: 'group',
        mergedCount: 2,
        participants: [`${thirdName}(${thirdId})`, `${targetName}(${targetId})`]
    });
}

function sourceFilterForMode(analysisMode) {
    return (analysisMode === 'bot_only_messages' || analysisMode === 'bot_only_profile')
        ? 'bot_only'
        : 'all';
}

function collectAndBuildPrompt(manager, analysisMode, existing = null) {
    if (existing) {
        manager.upsertParticipantProfile(namespace, {
            participantId: targetId,
            title: targetName,
            content: existing,
            tags: ['profile'],
            metadata: {
                participantId: targetId,
                participantName: targetName,
                source: 'participant_profile'
            }
        });
    }

    const source = manager.collectParticipantProfileSource(targetId, namespace, {
        threshold: 1,
        limit: 50,
        sourceFilter: sourceFilterForMode(analysisMode)
    });
    // 复现 index.js 的调用约定
    const prompt = buildParticipantProfilePrompt(source, analysisMode, {
        participantId: targetId,
        participantName: targetName
    });
    return { source, prompt };
}

function assertSpeakerIntegrity(source, prompt) {
    assert.ok(source.messages.length > 0, '应有源消息');
    assert.ok(source.targetMessageCount >= 1, '应有目标人物本人发言');
    assert.ok(source.messages.every((item) => item.speakerType), '每条消息都应有 speakerType');
    assert.ok(source.messages.every((item) => item.speakerType !== 'target' || item.isTargetSpeaker === true));
    assert.ok(source.messages.every((item) => item.speakerType !== 'bot' || item.isTargetSpeaker === false));
    assert.ok(source.messages.every((item) => item.speakerType !== 'third_party' || item.isTargetSpeaker === false));

    // Bot 回复正文若出现，必须标 bot
    const botMsgs = source.messages.filter((item) => String(item.content || '').includes('我帮你订位置'));
    for (const msg of botMsgs) {
        assert.equal(msg.speakerType, 'bot');
        assert.equal(msg.isTargetSpeaker, false);
    }

    // 引用内容不得进入目标本人 content
    const quotedTarget = source.messages.find((item) => item.speakerType === 'target' && item.hasQuote);
    if (quotedTarget) {
        assert.equal(quotedTarget.content, '辛苦了，我请你喝奶茶');
        assert.equal(quotedTarget.quote?.content, '我今天加班到很晚');
        assert.doesNotMatch(quotedTarget.content, /我今天加班到很晚/);
    }

    // batch 脏文本必须拆开
    const targetOwn = source.messages.find((item) => item.speakerType === 'target' && item.content.includes('比较能熬'));
    const thirdHate = source.messages.find((item) => item.speakerType === 'third_party' && item.content.includes('我讨厌加班'));
    if (targetOwn || thirdHate) {
        assert.ok(targetOwn, 'batch 脏文本应拆出目标人物');
        assert.ok(thirdHate, 'batch 脏文本应拆出第三者');
        assert.doesNotMatch(targetOwn.content, /我讨厌加班/);
    }

    assert.match(prompt, /目标人物：NewJanZ（QQ:2661097662）/);
    assert.match(prompt, /不得把 Bot 或第三者的话写成目标人物说的/);
    assert.match(prompt, /只能依据“说话人=目标人物”的本人发言归纳/);
    assert.match(prompt, /\[说话人:目标人物\|/);
    assert.doesNotMatch(prompt, /\[说话人:目标人物\|[^\]]*\] 我讨厌加班/);
    assert.doesNotMatch(prompt, /\[说话人:目标人物\|[^\]]*\] 好啊，我帮你订位置/);
}

test('全模式 e2e: messages_only 保留上下文并按说话人拆开，不含旧档案', () => {
    const { manager, tempDir } = createTempManager();
    try {
        seedMixedConversation(manager);
        const { source, prompt } = collectAndBuildPrompt(manager, 'messages_only');
        assertSpeakerIntegrity(source, prompt);

        // all 模式应能覆盖无 bot 会话里的目标发言
        assert.ok(source.messages.some((item) => item.content.includes('可以，我带零食') && item.speakerType === 'target'));
        assert.ok(source.messages.some((item) => item.speakerType === 'bot'));
        assert.ok(source.messages.some((item) => item.speakerType === 'third_party'));

        assert.match(prompt, /仅允许依据这些新增消息总结/);
        assert.doesNotMatch(prompt, /已有档案如下/);
        assert.match(prompt, /\[说话人:Bot\]/);
        assert.match(prompt, /\[说话人:第三者\|/);
        assert.match(prompt, /引用原文\(仅背景，不是本人发言/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('全模式 e2e: profile_plus_messages 合并旧档案，且不把 Bot/第三者写成目标人物', () => {
    const { manager, tempDir } = createTempManager();
    try {
        seedMixedConversation(manager);
        const { source, prompt } = collectAndBuildPrompt(
            manager,
            'profile_plus_messages',
            '稳定画像: 旧档案-喜欢请朋友吃饭'
        );
        assertSpeakerIntegrity(source, prompt);

        assert.match(prompt, /增量更新人物档案/);
        assert.match(prompt, /已有档案如下：\n稳定画像: 旧档案-喜欢请朋友吃饭/);
        assert.match(prompt, /\[说话人:目标人物\|NewJanZ\|QQ:2661097662\] 我请，去吃火锅/);
        assert.match(prompt, /\[说话人:Bot\] 好啊，我帮你订位置/);
        assert.match(prompt, /\[说话人:第三者\|第三者群友\|QQ:10002\]/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('全模式 e2e: bot_only_messages 只保留有 Bot 交互的上下文，并排除纯群聊会话', () => {
    const { manager, tempDir } = createTempManager();
    try {
        seedMixedConversation(manager);
        const { source, prompt } = collectAndBuildPrompt(manager, 'bot_only_messages');
        assertSpeakerIntegrity(source, prompt);

        // 有 Bot 的上下文应保留
        assert.ok(source.messages.some((item) => item.content.includes('我请，去吃火锅') && item.speakerType === 'target'));
        assert.ok(source.messages.some((item) => item.speakerType === 'bot'));

        // 无 Bot 的纯群聊会话应被过滤
        assert.equal(
            source.messages.some((item) => item.content.includes('可以，我带零食')),
            false,
            'bot_only 不应收录无 Bot 会话的目标发言'
        );

        assert.match(prompt, /与 Bot 的交互上下文/);
        assert.match(prompt, /仅允许依据这些新增消息总结/);
        assert.doesNotMatch(prompt, /已有档案如下/);
        assert.match(prompt, /\[说话人:Bot\]/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('全模式 e2e: bot_only_profile 保留 Bot 交互上下文并带旧档案，归因仍然清晰', () => {
    const { manager, tempDir } = createTempManager();
    try {
        seedMixedConversation(manager);
        const { source, prompt } = collectAndBuildPrompt(
            manager,
            'bot_only_profile',
            '稳定画像: 旧档案-工作日会请奶茶'
        );
        assertSpeakerIntegrity(source, prompt);

        assert.ok(source.botMessageCount >= 1);
        assert.ok(source.targetMessageCount >= 1);
        assert.equal(
            source.messages.some((item) => item.content.includes('可以，我带零食')),
            false
        );

        assert.match(prompt, /增量更新人物档案/);
        assert.match(prompt, /已有档案如下：\n稳定画像: 旧档案-工作日会请奶茶/);
        assert.match(prompt, /与 Bot 的交互上下文/);
        assert.match(prompt, /\[说话人:目标人物\|NewJanZ\|QQ:2661097662\] 辛苦了，我请你喝奶茶/);
        assert.match(prompt, /引用原文\(仅背景，不是本人发言/);
        assert.match(prompt, /\[说话人:Bot\] 好啊，我帮你订位置/);
        assert.doesNotMatch(prompt, /\[说话人:目标人物\|[^\]]*\] 我讨厌加班/);
    } finally {
        cleanup(manager, tempDir);
    }
});

test('全模式 e2e: analysisMode 到 sourceFilter 映射与 index.js 一致', () => {
    assert.equal(sourceFilterForMode('messages_only'), 'all');
    assert.equal(sourceFilterForMode('profile_plus_messages'), 'all');
    assert.equal(sourceFilterForMode('bot_only_messages'), 'bot_only');
    assert.equal(sourceFilterForMode('bot_only_profile'), 'bot_only');
});
