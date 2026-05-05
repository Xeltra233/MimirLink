import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptBuilder } from '../src/prompt.js';

test('normalizePreset keeps prompt list when prompts already exist', () => {
    const normalized = PromptBuilder.normalizePreset({
        enabled: true,
        name: 'ST preset',
        prompts: [
            {
                identifier: 'main',
                name: 'Main Prompt',
                role: 'system',
                content: 'main content',
                enabled: true,
                injection_position: 0,
                injection_depth: 0,
                forbid_overrides: false,
                marker: false,
                system_prompt: true
            }
        ]
    });

    assert.equal(normalized.name, 'ST preset');
    assert.equal(normalized.prompts.length, 1);
    assert.equal(normalized.prompts[0].identifier, 'main');
    assert.equal(normalized.prompts[0].content, 'main content');
});

test('normalizePreset migrates legacy flattened fields into prompt items', () => {
    const normalized = PromptBuilder.normalizePreset({
        enabled: true,
        name: 'legacy',
        systemPrompt: 'sys',
        postHistoryInstructions: 'post',
        jailbreak: 'jb',
        assistantPrefill: 'prefill'
    });

    assert.equal(normalized.prompts.length, 4);
    assert.deepEqual(
        normalized.prompts.map((item) => item.identifier),
        ['main', 'post-history', 'jailbreak', 'assistant-prefill']
    );
});

test('normalizePreset keeps regex rules and root metadata during migration', () => {
    const normalized = PromptBuilder.normalizePreset({
        enabled: true,
        name: 'legacy with regex',
        systemPrompt: 'sys',
        regexRules: [{ id: 'r1', name: 'rule 1' }]
    });

    assert.equal(normalized.enabled, true);
    assert.equal(normalized.regexRules.length, 1);
    assert.equal(normalized.regexRules[0].id, 'r1');
});

test('build uses normalized prompt items for system, post-history, and assistant prefill', async () => {
    const builder = new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '角色A',
                    description: '角色描述',
                    personality: '',
                    scenario: '',
                    system_prompt: '',
                    first_mes: '开场白'
                };
            }
        },
        {
            currentWorldBook: null,
            readWorldBook() {
                return null;
            },
            matchEntries() {
                return [];
            }
        },
        {
            preset: {
                enabled: true,
                name: 'preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '系统主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'post-history', name: 'Post-History Instructions', role: 'system', content: '历史后提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                ]
            }
        }
    );

    const result = await builder.build('角色A', '用户新消息', { recentMessages: [{ role: 'user', content: '历史用户消息' }], summaries: [] }, new Set(), {});

    assert.equal(result.messages[0].role, 'system');
    assert.match(result.messages[0].content, /系统主提示/);
    assert.equal(result.messages.at(-2).content, '用户新消息');
    assert.equal(result.messages.at(-3).content, '历史后提示');
    assert.equal(result.messages.at(-1).content, '助手预填充');
});

test('build keeps runtime-owned fragments when prompt items are enabled', async () => {
    const builder = new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '角色A',
                    description: '角色描述',
                    personality: '冷静',
                    scenario: '测试场景',
                    system_prompt: '角色系统提示',
                    first_mes: ''
                };
            }
        },
        {
            currentWorldBook: null,
            readWorldBook() {
                return null;
            },
            matchEntries() {
                return [];
            }
        },
        {
            preset: {
                enabled: true,
                name: 'preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '系统主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                ]
            },
            context: { enabled: true, includeSessionFacts: true, includeParticipants: false, includeReplyReference: false, includeRecentUserIntent: false }
        }
    );

    const result = await builder.build('角色A', '用户消息', { recentMessages: [], summaries: [{ content: '摘要A' }] }, new Set(), { sessionId: 's1' });

    assert.match(result.messages[0].content, /系统主提示/);
    assert.match(result.messages[0].content, /摘要A/);
    assert.match(result.messages[0].content, /角色描述/);
    assert.match(result.messages[0].content, /角色系统提示/);
});

test('importPreset preserves prompt items when ST prompts are present', () => {
    const preset = PromptBuilder.importPreset({
        name: 'ST preset',
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
        ]
    });

    assert.equal(preset.prompts.length, 1);
    assert.equal(preset.prompts[0].identifier, 'main');
});

test('exportPreset returns ST-style prompts payload for sillytavern format', () => {
    const payload = PromptBuilder.exportPreset({
        enabled: true,
        name: 'Export preset',
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main content', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
        ]
    }, 'sillytavern');

    assert.equal(payload.name, 'Export preset');
    assert.equal(payload.prompts.length, 1);
    assert.equal(payload.prompts[0].identifier, 'main');
});

test('normalizePreset provides a default prompt set for empty preset payloads', () => {
    const normalized = PromptBuilder.normalizePreset({ enabled: true, name: 'empty preset' });

    assert.deepEqual(
        normalized.prompts.map((item) => item.identifier),
        ['main', 'jailbreak', 'post-history', 'assistant-prefill']
    );
});
