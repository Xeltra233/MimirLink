import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptBuilder } from '../src/prompt.js';
import { WorldBookManager } from '../src/worldbook.js';

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

test('normalizePreset coerces Tavern-style string prompt flags and positions into runtime fields', () => {
    const normalized = PromptBuilder.normalizePreset({
        enabled: true,
        name: 'ST preset',
        prompts: [
            {
                identifier: 'depth-2',
                name: 'Depth Prompt',
                role: 'system',
                content: 'history inject',
                enabled: '1',
                injection_position: '0',
                injection_depth: '2',
                forbid_overrides: 'true',
                marker: '1',
                system_prompt: 'true'
            },
            {
                identifier: 'disabled',
                name: 'Disabled Prompt',
                role: 'system',
                content: 'should be disabled',
                enabled: 'false',
                injection_position: '1',
                injection_depth: '0',
                forbid_overrides: 'false',
                marker: '0',
                system_prompt: 'false'
            }
        ]
    });

    assert.equal(normalized.prompts[0].enabled, true);
    assert.equal(normalized.prompts[0].injection_position, 0);
    assert.equal(normalized.prompts[0].injection_depth, 2);
    assert.equal(normalized.prompts[0].forbid_overrides, true);
    assert.equal(normalized.prompts[0].marker, true);
    assert.equal(normalized.prompts[0].system_prompt, true);
    assert.equal(normalized.prompts[1].enabled, false);
    assert.equal(normalized.prompts[1].injection_position, 1);
    assert.equal(normalized.prompts[1].injection_depth, 0);
    assert.equal(normalized.prompts[1].forbid_overrides, false);
    assert.equal(normalized.prompts[1].marker, false);
    assert.equal(normalized.prompts[1].system_prompt, false);
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

test('build merges multiple assistant prefills into one tail assistant message', async () => {
    const builder = new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '角色A',
                    description: '',
                    personality: '',
                    scenario: '',
                    system_prompt: '',
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
                    { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '第一段预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false },
                    { identifier: 'assistant-prefill-extra', name: 'Assistant Prefill Extra', role: 'assistant', content: '第二段预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                ]
            }
        }
    );

    const result = await builder.build('角色A', '用户新消息', { recentMessages: [], summaries: [] }, new Set(), {});
    const assistantPrefillMessages = result.messages.filter((message) => message.meta?.source === 'assistant_prefill');

    assert.equal(assistantPrefillMessages.length, 1);
    assert.equal(assistantPrefillMessages[0].role, 'assistant');
    assert.equal(assistantPrefillMessages[0].content, '第一段预填充\n\n第二段预填充');
    assert.deepEqual(assistantPrefillMessages[0].meta.sourceIds, ['assistant-prefill', 'assistant-prefill-extra']);
    assert.equal(result.messages.at(-1), assistantPrefillMessages[0]);
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

test('partitionPromptItems separates history injection prompts by injection_depth', () => {
    const partitioned = PromptBuilder.partitionPromptItems({
        enabled: true,
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: '主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
            { identifier: 'depth-2', name: 'Depth Prompt', role: 'system', content: '历史中插入', enabled: true, injection_position: 0, injection_depth: 2, forbid_overrides: true, marker: true, system_prompt: true },
            { identifier: 'post-history', name: 'Post-History', role: 'system', content: '历史后提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
            { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手补全', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
        ]
    });

    assert.deepEqual(partitioned.preSystem.map((item) => item.identifier), ['main']);
    assert.deepEqual(partitioned.historyInjection.map((item) => item.identifier), ['depth-2']);
    assert.deepEqual(partitioned.postHistory.map((item) => item.identifier), ['post-history']);
    assert.deepEqual(partitioned.assistantPrefill.map((item) => item.identifier), ['assistant-prefill']);
});

test('build inserts history injection prompts after the requested history depth and keeps marker metadata', async () => {
    const builder = new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '角色A',
                    description: '',
                    personality: '',
                    scenario: '',
                    system_prompt: '',
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
            context: { enabled: false },
            preset: {
                enabled: true,
                name: 'preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '系统主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'depth-2', name: 'Depth Prompt', role: 'system', content: '第二条历史后插入', enabled: true, injection_position: 0, injection_depth: 2, forbid_overrides: true, marker: true, system_prompt: true },
                    { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: '助手预填充', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                ]
            }
        }
    );

    const result = await builder.build('角色A', '用户新消息', {
        recentMessages: [
            { role: 'user', content: '历史1' },
            { role: 'assistant', content: '历史2' },
            { role: 'user', content: '历史3' }
        ],
        summaries: []
    }, new Set(), {});

    assert.equal(result.messages[0].role, 'system');
    assert.match(result.messages[0].content, /系统主提示/);
    assert.equal(result.messages[1].role, 'user');
    assert.equal(result.messages[1].content, '历史1');
    assert.equal(result.messages[2].role, 'assistant');
    assert.equal(result.messages[2].content, '历史2');
    assert.equal(result.messages[3].role, 'system');
    assert.equal(result.messages[3].content, '第二条历史后插入');
    assert.equal(result.messages[4].role, 'user');
    assert.equal(result.messages[4].content, '历史3');
    assert.equal(result.messages[5].role, 'user');
    assert.equal(result.messages[5].content, '用户新消息');
    assert.equal(result.messages[6].role, 'assistant');
    assert.equal(result.messages[6].content, '助手预填充');
    assert.equal(result.runtimeComposition.historyInjectionSegments.length, 1);
    assert.equal(result.runtimeComposition.historyInjectionSegments[0].kind, 'preset_marker');
    assert.equal(result.runtimeComposition.historyInjectionSegments[0].meta.marker, true);
    assert.equal(result.runtimeComposition.historyInjectionSegments[0].meta.forbid_overrides, true);
    assert.equal(result.runtimeComposition.historyInjectionSegments[0].meta.insertionIndex, 2);
    assert.equal(result.messageTrace[3].sourceIds.includes('depth-2'), true);
});

test('build includes Tavern-style constant worldbook entries and skips string-disabled ones', async () => {
    const builder = new PromptBuilder(
        {
            readFromPng() {
                return {
                    name: '角色A',
                    description: '',
                    personality: '',
                    scenario: '',
                    system_prompt: '',
                    first_mes: ''
                };
            }
        },
        {
            currentWorldBook: null,
            readWorldBook() {
                return {
                    entries: [
                        { id: 'constant-entry', key: 'alpha', content: '常驻世界书', constant: 'true', position: 1, order: 20 },
                        { id: 'disabled-entry', key: 'alpha', content: '不应出现', enabled: 'false', position: 0, order: 30 },
                        { id: 'normal-entry', key: 'alpha', content: '普通世界书', enabled: '1', position: 0, order: 10 }
                    ]
                };
            },
            matchEntries(worldBook, inputText, maxEntries, stickyKeys) {
                return new WorldBookManager('D:/project/test/QQ-Tavern/MimirLink/data').matchEntries(worldBook, inputText, maxEntries, stickyKeys);
            }
        },
        {
            context: { enabled: false },
            preset: {
                enabled: true,
                name: 'preset',
                prompts: [
                    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '系统主提示', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                    { identifier: 'post-history', name: 'Post-History', role: 'system', content: '历史后提示', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                ]
            }
        }
    );

    const result = await builder.build('角色A', 'alpha', { recentMessages: [], summaries: [] }, new Set(), {});

    assert.match(result.messages[0].content, /普通世界书/);
    assert.doesNotMatch(result.messages[0].content, /不应出现/);
    assert.equal(result.messages[1].role, 'system');
    assert.match(result.messages[1].content, /常驻世界书/);
    assert.equal(result.runtimeComposition.systemSegments.some((segment) => segment.content.includes('普通世界书')), true);
    assert.equal(result.runtimeComposition.systemSegments.some((segment) => segment.content.includes('不应出现')), false);
    assert.equal(result.runtimeComposition.postHistorySegments.some((segment) => segment.content.includes('常驻世界书')), true);
});

test('getPresetResolution merges preset layers and keeps locked items from lower layers', () => {
    const resolution = PromptBuilder.getPresetResolution({
        preset: {
            enabled: true,
            name: 'Legacy Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'legacy main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: true, marker: false, system_prompt: true },
                { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'legacy post', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [{ id: 'legacy-rule' }]
        },
        bindings: {
            global: {
                preset: {
                    enabled: true,
                    name: 'Global Preset',
                    prompts: [
                        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'global main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                        { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'global post', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                    ],
                    regexRules: [{ id: 'global-rule' }]
                },
                regexRules: [],
                memoryDbPath: null,
                worldbook: null
            },
            characters: {
                '角色A': {
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'character main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                            { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'character post', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                            { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: 'character prefill', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                        ],
                        regexRules: [{ id: 'character-rule' }]
                    },
                    importedFromCard: {
                        preset: null,
                        worldbook: null,
                        regexRules: []
                    },
                    regexRules: null,
                    worldbook: null,
                    memoryDbPath: null
                }
            }
        }
    }, '角色A');

    assert.equal(resolution.source, 'merged');
    assert.deepEqual(resolution.layers, ['legacy', 'global', 'character_binding']);
    assert.deepEqual(resolution.lockedIdentifiers, ['main']);
    assert.equal(resolution.itemSources['identifier:main'], 'legacy');
    assert.equal(resolution.itemSources['identifier:post-history'], 'character_binding');
    assert.equal(resolution.itemSources['identifier:assistant-prefill'], 'character_binding');
    assert.equal(resolution.preset.name, 'Character Preset');
    assert.equal(resolution.preset.regexRules[0].id, 'character-rule');
    assert.equal(resolution.preset.prompts.find((item) => item.identifier === 'main')?.content, 'legacy main');
    assert.equal(resolution.preset.prompts.find((item) => item.identifier === 'post-history')?.content, 'character post');
    assert.equal(resolution.preset.prompts.find((item) => item.identifier === 'assistant-prefill')?.content, 'character prefill');
});

test('getRegexResolution separates character, preset, and global regex layers', () => {
    const resolution = PromptBuilder.getRegexResolution({
        regex: {
            rules: [{ id: 'legacy-global-rule' }]
        },
        preset: {
            enabled: true,
            name: 'Legacy Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'legacy main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [{ id: 'legacy-preset-rule' }]
        },
        bindings: {
            global: {
                preset: {
                    enabled: true,
                    name: 'Global Preset',
                    prompts: [
                        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'global main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                    ],
                    regexRules: [{ id: 'global-preset-rule' }]
                },
                regexRules: [{ id: 'global-rule' }],
                memoryDbPath: null,
                worldbook: null
            },
            characters: {
                '角色A': {
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'character main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
                        ],
                        regexRules: [{ id: 'character-preset-rule' }]
                    },
                    importedFromCard: {
                        preset: null,
                        worldbook: null,
                        regexRules: [{ id: 'card-rule' }]
                    },
                    regexRules: null,
                    worldbook: null,
                    memoryDbPath: null
                }
            }
        }
    }, '角色A');

    assert.equal(resolution.regexRules.source, 'imported_from_card');
    assert.equal(resolution.regexRules.count, 1);
    assert.deepEqual(resolution.regexRules.value, [{ id: 'card-rule' }]);
    assert.equal(resolution.presetRegexRules.source, 'character_binding');
    assert.deepEqual(resolution.presetRegexRules.layers, ['legacy', 'global', 'character_binding']);
    assert.equal(resolution.presetRegexRules.count, 1);
    assert.deepEqual(resolution.presetRegexRules.value, [{ id: 'character-preset-rule' }]);
    assert.equal(resolution.globalRegexRules.source, 'global');
    assert.equal(resolution.globalRegexRules.count, 1);
    assert.deepEqual(resolution.globalRegexRules.value, [{ id: 'global-rule' }]);
});

test('getEffectiveBinding uses merged preset resolution', () => {
    const effectiveBinding = PromptBuilder.getEffectiveBinding({
        preset: {
            enabled: true,
            name: 'Legacy Preset',
            prompts: [
                { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'legacy main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
            ],
            regexRules: [{ id: 'legacy-rule' }]
        },
        bindings: {
            global: {
                preset: {
                    enabled: true,
                    name: 'Global Preset',
                    prompts: [
                        { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'global main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: true, marker: false, system_prompt: true }
                    ],
                    regexRules: [{ id: 'global-rule' }]
                },
                regexRules: [],
                memoryDbPath: null,
                worldbook: 'global-world.json'
            },
            characters: {
                '角色A': {
                    worldbook: null,
                    preset: {
                        enabled: true,
                        name: 'Character Preset',
                        prompts: [
                            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'character main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
                            { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: 'character prefill', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
                        ],
                        regexRules: [{ id: 'character-rule' }]
                    },
                    importedFromCard: {
                        worldbook: 'card-world.json',
                        preset: null,
                        regexRules: []
                    },
                    regexRules: null,
                    memoryDbPath: null
                }
            }
        }
    }, '角色A');

    assert.equal(effectiveBinding.worldbook, 'card-world.json');
    assert.equal(effectiveBinding.preset?.name, 'Character Preset');
    assert.equal(effectiveBinding.preset?.prompts.find((item) => item.identifier === 'main')?.content, 'global main');
    assert.equal(effectiveBinding.preset?.prompts.find((item) => item.identifier === 'assistant-prefill')?.content, 'character prefill');
    assert.deepEqual(effectiveBinding.presetRegexRules, [{ id: 'character-rule' }]);
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

test('diagnosePresetImport only warns for still-unsupported preset semantics', () => {
    const diagnosis = PromptBuilder.diagnosePresetImport({
        name: 'ST preset',
        prompts: [
            { identifier: 'main', name: 'Main Prompt', role: 'system', content: 'main', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
            { identifier: 'depth-1', name: 'Depth Prompt', role: 'system', content: 'history inject', enabled: true, injection_position: 0, injection_depth: 1, forbid_overrides: true, marker: true, system_prompt: true },
            { identifier: 'post-history', name: 'Post-History', role: 'system', content: 'post', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true },
            { identifier: 'assistant-prefill', name: 'Assistant Prefill', role: 'assistant', content: 'prefill', enabled: true, injection_position: 1, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false }
        ]
    });

    assert.equal(diagnosis.detectedFormat, 'sillytavern-prompts');
    assert.equal(diagnosis.postHistoryPrompts, 2);
    assert.equal(diagnosis.historyInjectionPrompts, 1);
    assert.equal(diagnosis.markerPrompts, 1);
    assert.equal(diagnosis.assistantRolePrompts, 1);
    assert.equal(diagnosis.unsupportedPlacements, 0);
    assert.equal(diagnosis.unsupportedRoles, 0);
    assert.deepEqual(diagnosis.warnings, []);
});

test('diagnosePresetImport warns when prompt roles or placements exceed backend support', () => {
    const diagnosis = PromptBuilder.diagnosePresetImport({
        name: 'ST preset',
        prompts: [
            { identifier: 'comment', name: 'Comment Prompt', role: 'comment', content: 'commentary', enabled: true, injection_position: 0, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: false },
            { identifier: 'weird-placement', name: 'Weird Placement', role: 'system', content: 'strange', enabled: true, injection_position: 3, injection_depth: 0, forbid_overrides: false, marker: false, system_prompt: true }
        ]
    });

    assert.equal(diagnosis.unsupportedPlacements, 1);
    assert.equal(diagnosis.unsupportedRoles, 1);
    assert.equal(diagnosis.warnings.length, 2);
    assert.match(diagnosis.warnings[0], /injection_position/);
    assert.match(diagnosis.warnings[1], /role prompt/);
});

test('normalizePreset creates default prompt items for empty presets', () => {
    const normalized = PromptBuilder.normalizePreset({ enabled: true, name: 'empty preset' });

    assert.deepEqual(
        normalized.prompts.map((item) => item.identifier),
        ['main', 'jailbreak', 'post-history', 'assistant-prefill']
    );
});
