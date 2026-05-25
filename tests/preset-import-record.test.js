import test from 'node:test';
import assert from 'node:assert/strict';

import { PromptBuilder } from '../src/prompt.js';

test('importPreset accepts internal preset import records', () => {
    const preset = PromptBuilder.importPreset({
        id: 'preset-record',
        type: 'preset',
        importedPreset: {
            enabled: true,
            name: '记录里的预设',
            prompts: [
                {
                    identifier: 'main',
                    name: 'Main Prompt',
                    role: 'system',
                    content: '记录里的主提示',
                    enabled: true,
                    injection_position: 0,
                    injection_depth: 0,
                    forbid_overrides: false,
                    marker: false,
                    system_prompt: true
                }
            ],
            regexRules: []
        }
    });

    assert.equal(preset.name, '记录里的预设');
    assert.equal(preset.prompts.length, 1);
    assert.equal(preset.prompts[0].identifier, 'main');
    assert.equal(preset.prompts[0].content, '记录里的主提示');
});

test('diagnosePresetImport reports prompts from internal preset import records', () => {
    const diagnosis = PromptBuilder.diagnosePresetImport({
        importedPreset: {
            prompts: [
                {
                    identifier: 'post-history',
                    name: 'Post-History',
                    role: 'system',
                    content: '最后检查',
                    enabled: true,
                    injection_position: 1,
                    injection_depth: 0,
                    forbid_overrides: false,
                    marker: false,
                    system_prompt: true
                }
            ]
        }
    });

    assert.equal(diagnosis.detectedFormat, 'sillytavern-prompts');
    assert.equal(diagnosis.totalPrompts, 1);
    assert.equal(diagnosis.enabledPrompts, 1);
    assert.equal(diagnosis.postHistoryPrompts, 1);
});
