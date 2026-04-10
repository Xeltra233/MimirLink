import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SessionManager } from '../src/session.js';

function createTempManager() {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimirlink-layered-recall-'));
    const manager = new SessionManager(tempDir, {
        chat: { historyLimit: 30, maxGlobalMessages: 2000, sessionMode: 'user_persistent' },
        memory: {
            storage: { path: path.join(tempDir, 'memory.sqlite') },
            summary: { enabled: false }
        }
    }, { info() {}, warn() {}, error() {} });

    return { manager, tempDir }; 
}

function sleep(ms = 2) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

test('recallMemory prefers participant_profile, fact, and event before weaker conversation entries', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.upsertParticipantProfile(namespace, {
        participantId: 'user-a',
        title: 'Alice',
        content: '稳定画像: Alice 总会在观星前准备薄荷茶。',
        tags: ['alice', '薄荷茶', '观星'],
        metadata: { participantId: 'user-a', participantName: 'Alice', source: 'participant_profile' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Alice habit',
        content: '事实: Alice 每次观星都会先准备薄荷茶。',
        tags: ['alice', '薄荷茶', '观星'],
        metadata: { source: 'fact' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'event',
        title: 'Observatory night',
        content: '事件: 昨晚 Alice 在天文台一边观星一边喝薄荷茶。',
        tags: ['alice', '薄荷茶', '观星'],
        metadata: { source: 'event' }
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 说她在观星前会先准备薄荷茶。',
        assistantMessage: '我记得这段闲聊，但它不该压过画像、事实和事件。'
    });

    const recalled = manager.recallMemory(namespace, 'Alice 观星 薄荷茶', { limit: 6, recentLimit: 6, searchLimit: 6 });

    assert.equal(recalled[0].entryType, 'participant_profile');
    assert.equal(recalled[1].entryType, 'fact');
    assert.equal(recalled[2].entryType, 'event');
    assert.equal(recalled[3].entryType, 'conversation');
});

test('recallMemory keeps summary but suppresses low-value duplicate conversation fragments', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.addSummaryIndexEntry(namespace, {
        outline: '摘要: Alice 怕打雷，但暴雨夜里还是陪大家守在灯塔。',
        keywords: ['alice', '打雷', '暴雨', '灯塔'],
        metadata: { source: 'summary' }
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 怕打雷，但还是留在灯塔。',
        assistantMessage: '是的，她怕打雷，但还是留在灯塔。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 怕打雷，但还是留在灯塔。',
        assistantMessage: '重复片段: 她怕打雷，但还是留在灯塔。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 怕打雷，但还是留在灯塔。',
        assistantMessage: '再次重复: 她怕打雷，但还是留在灯塔。'
    });

    const recalled = manager.recallMemory(namespace, 'Alice 打雷 灯塔', { limit: 6, recentLimit: 6, searchLimit: 6, summaryLimit: 3 });
    const summaryEntries = recalled.filter((entry) => entry.sourceKind === 'summary_index');
    const conversationEntries = recalled.filter((entry) => entry.entryType === 'conversation');

    assert.equal(summaryEntries.length, 1);
    assert.equal(conversationEntries.length, 1);
});

test('recallMemory ranks fact above duplicate conversation entries for the same topic', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Lighthouse signal fact',
        content: '事实: Alice 把灯塔信号钥匙藏在观测台下方的暗格里。',
        tags: ['alice', '灯塔', '信号钥匙', '观测台'],
        metadata: { source: 'fact' }
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 把灯塔信号钥匙藏在哪里？',
        assistantMessage: '她说灯塔信号钥匙藏在观测台下方的暗格里。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 把灯塔信号钥匙藏在哪里？',
        assistantMessage: '重复闲聊: 灯塔信号钥匙还是藏在观测台下方的暗格里。'
    });

    const recalled = manager.recallMemory(namespace, 'Alice 灯塔 信号钥匙 观测台', {
        limit: 6,
        recentLimit: 6,
        searchLimit: 6
    });

    assert.equal(recalled[0].entryType, 'fact');
    assert.ok(recalled.some((entry) => entry.entryType === 'conversation'));
});

test('recallMemory collapses exact and near-duplicate conversation entries to one representative', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.upsertConversationMemory(namespace, {
        userMessage: '昨晚谁把灯塔钥匙藏进了观测台下面的暗格？',
        assistantMessage: 'Alice 把灯塔钥匙藏进了观测台下面的暗格。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: '昨晚是谁把灯塔钥匙放到观测台下方暗格里的？',
        assistantMessage: 'Alice 把灯塔钥匙放在观测台下方的暗格里。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: '昨晚谁把灯塔钥匙藏进了观测台下面的暗格？',
        assistantMessage: 'Alice 把灯塔钥匙藏进了观测台下面的暗格。'
    });

    const recalled = manager.recallMemory(namespace, 'Alice 灯塔钥匙 观测台 暗格', {
        limit: 6,
        recentLimit: 6,
        searchLimit: 6
    });
    const conversationEntries = recalled.filter((entry) => entry.entryType === 'conversation');

    assert.equal(conversationEntries.length, 1);
    assert.match(conversationEntries[0].content, /灯塔钥匙/);
    assert.match(conversationEntries[0].content, /暗格/);
});

test('recallMemory preserves distinct sourceKind for memory and summary candidates', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Signal fact',
        content: '事实: Alice 会把灯塔钥匙放在观测台抽屉里。',
        tags: ['alice', '灯塔', '钥匙'],
        metadata: { source: 'fact' }
    });
    await sleep();

    manager.addSummaryIndexEntry(namespace, {
        outline: '摘要: Alice 把灯塔钥匙留在观测台抽屉里，方便夜间巡查。',
        keywords: ['alice', '灯塔', '钥匙', '观测台'],
        metadata: { source: 'summary' }
    });

    const recalled = manager.recallMemory(namespace, 'Alice 灯塔 钥匙 观测台', {
        limit: 6,
        recentLimit: 6,
        searchLimit: 6,
        summaryLimit: 3
    });

    const memoryEntries = recalled.filter((entry) => entry.sourceKind === 'memory_entry');
    const summaryEntries = recalled.filter((entry) => entry.sourceKind === 'summary_index');

    assert.equal(memoryEntries.length, 1);
    assert.equal(summaryEntries.length, 1);
    assert.notEqual(memoryEntries[0].id, summaryEntries[0].id);
    assert.equal(memoryEntries[0].entryType, 'fact');
    assert.match(summaryEntries[0].content, /灯塔钥匙/);
});

test('participant_profile suppresses weaker stable-trait conversation fragments for the same participant', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.upsertParticipantProfile(namespace, {
        participantId: 'alice',
        title: 'Alice',
        content: '稳定画像: Alice 一贯冷静克制，偏好独处和黑咖啡。',
        tags: ['alice', '冷静', '独处', '黑咖啡'],
        metadata: { participantId: 'alice', participantName: 'Alice', source: 'participant_profile' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'conversation',
        title: 'Alice traits fragment',
        content: 'Alice 一向冷静克制，也喜欢独处和黑咖啡。',
        tags: ['alice', '冷静', '独处', '黑咖啡'],
        metadata: { participantId: 'alice', source: 'conversation' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'event',
        title: 'Rainy meeting',
        content: '事件: 暴雨夜的会面里，Alice 仍然保持冷静并继续推进合作。',
        tags: ['alice', '冷静', '暴雨', '合作'],
        metadata: { participantId: 'alice', source: 'event' }
    });

    const recalled = manager.recallMemory(namespace, 'Alice 平时性格怎么样，最近关系如何？', {
        limit: 6,
        recentLimit: 6,
        searchLimit: 6,
        summaryLimit: 2
    });

    assert.equal(recalled[0].entryType, 'participant_profile');
    assert.ok(recalled.some((entry) => entry.entryType === 'event'));
    assert.equal(
        recalled.some((entry) => entry.entryType === 'conversation' && /冷静克制.*独处.*黑咖啡|黑咖啡.*独处.*冷静克制/u.test(entry.content)),
        false
    );
});

test('recallMemory boosts entries matching currentParticipantId when provided', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Bob lighthouse route',
        content: '事实: Bob 熟悉灯塔巡逻路线，并会在暴雨前检查北侧台阶。',
        tags: ['bob', '灯塔', '暴雨', '台阶'],
        metadata: { participantId: 'bob', participantName: 'Bob', source: 'fact' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Alice lighthouse route',
        content: '事实: Alice 熟悉灯塔巡逻路线，并会在暴雨前检查北侧台阶。',
        tags: ['alice', '灯塔', '暴雨', '台阶'],
        metadata: { participantId: 'alice', participantName: 'Alice', source: 'fact' }
    });

    const baseline = manager.recallMemory(namespace, '谁更熟悉灯塔巡逻路线和暴雨前检查？', {
        limit: 4,
        recentLimit: 4,
        searchLimit: 4
    });

    const recalled = manager.recallMemory(namespace, '谁更熟悉灯塔巡逻路线和暴雨前检查？', {
        limit: 4,
        recentLimit: 4,
        searchLimit: 4,
        currentParticipantId: 'bob'
    });

    assert.equal(baseline[0].metadata?.participantId, 'alice');
    assert.equal(recalled[0].metadata?.participantId, 'bob');
    assert.equal(recalled[1].metadata?.participantId, 'alice');
});

test('per-type budgets keep conversation entries from flooding final recall results', async () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    manager.upsertParticipantProfile(namespace, {
        participantId: 'alice',
        title: 'Alice',
        content: '稳定画像: Alice 习惯在暴雨前检查灯塔电路。',
        tags: ['alice', '暴雨', '灯塔'],
        metadata: { participantId: 'alice', participantName: 'Alice', source: 'participant_profile' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'fact',
        title: 'Circuit routine',
        content: '事实: Alice 会在暴雨前检查灯塔电路并准备备用电池。',
        tags: ['alice', '暴雨', '灯塔', '电路'],
        metadata: { participantId: 'alice', source: 'fact' }
    });
    await sleep();

    manager.addMemoryEntry(namespace, {
        entryType: 'event',
        title: 'Storm watch',
        content: '事件: 昨夜暴雨来临前，Alice 提前完成了灯塔巡检。',
        tags: ['alice', '暴雨', '灯塔', '巡检'],
        metadata: { participantId: 'alice', source: 'event' }
    });
    await sleep();

    manager.addSummaryIndexEntry(namespace, {
        outline: '摘要: Alice 在暴雨夜之前完成灯塔巡检，并准备了备用电池。',
        keywords: ['alice', '暴雨', '灯塔', '巡检'],
        metadata: { source: 'summary' }
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 在暴雨前会做什么准备？',
        assistantMessage: '她会先检查灯塔电路。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 在暴雨前还会准备什么？',
        assistantMessage: '她会带上备用电池并确认灯塔巡检完成。'
    });
    await sleep();

    manager.upsertConversationMemory(namespace, {
        userMessage: 'Alice 暴雨前的准备流程是什么？',
        assistantMessage: '她会先检查电路，再确认巡检和备用电池。'
    });

    const recalled = manager.recallMemory(namespace, 'Alice 暴雨前会做什么准备？', {
        limit: 6,
        recentLimit: 8,
        searchLimit: 8,
        summaryLimit: 3
    });

    assert.equal(recalled.length >= 4, true);
    assert.equal(recalled.filter((entry) => entry.entryType === 'conversation').length <= 2, true);
    assert.equal(recalled[0].entryType, 'participant_profile');
    assert.ok(recalled.some((entry) => entry.entryType === 'fact'));
    assert.ok(recalled.some((entry) => entry.entryType === 'event'));
    assert.ok(recalled.some((entry) => entry.sourceKind === 'summary_index'));
});

test('recallMemory remains compatible with legacy note entries', () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    const note = manager.addMemoryEntry(namespace, {
        title: 'Legacy note',
        content: '旧版备注: Alice 会把应急地图藏在灯塔楼梯下。',
        tags: ['alice', '地图', '灯塔'],
        metadata: { source: 'legacy_import' }
    });

    const recalled = manager.recallMemory(namespace, 'Alice 地图 灯塔', { limit: 4, recentLimit: 4, searchLimit: 4 });

    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, note.id);
    assert.equal(recalled[0].entryType, 'note');
    assert.equal(recalled[0].sourceKind, 'memory_entry');
});

test('addMemoryEntry normalizes unsupported entry types to conversation', () => {
    const { manager } = createTempManager();
    const namespace = { scopeType: 'user', scopeKey: '10001', characterName: '角色A', presetName: '预设A' };

    const inserted = manager.addMemoryEntry(namespace, {
        entryType: 'unsupported_kind',
        title: 'Normalized write',
        content: '这条写入应当回落为 conversation。',
        tags: ['normalized'],
        metadata: { source: 'test' }
    });

    const recalled = manager.recallMemory(namespace, 'normalized conversation', { limit: 4, recentLimit: 4, searchLimit: 4 });

    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].id, inserted.id);
    assert.equal(recalled[0].entryType, 'conversation');
});
