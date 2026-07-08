import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('config UI exposes group repeat controls', () => {
    assert.ok(source.includes('id="config-chat-group-repeat-enabled"'));
    assert.ok(source.includes('id="config-chat-group-repeat-cooldown-minutes"'));
    assert.ok(source.includes('placeholder="3" min="1" max="60"'));
});

test('config UI restores and saves group repeat settings', () => {
    assert.ok(source.includes("currentConfig.chat?.groupRepeat?.enabled === true"));
    assert.ok(source.includes("currentConfig.chat?.groupRepeat?.cooldownMs ?? 180000"));
    assert.match(source, /groupRepeat:\s*\{\s*enabled:\s*document\.getElementById\('config-chat-group-repeat-enabled'\)\.checked,\s*triggerCount:\s*2,\s*cooldownMs:\s*\(parseInt\(document\.getElementById\('config-chat-group-repeat-cooldown-minutes'\)\.value\) \|\| 3\) \* 60000\s*\}/);
});

test('config UI restores and saves memory summary model provider selection', () => {
    assert.ok(source.includes("const summaryLegacySelection = parseAIModelRef(currentConfig.memory?.summary?.model || '');"));
    assert.ok(source.includes("const summaryModelSelection = getSelectedAIModelRef('config-memory-summary-model');"));
    assert.ok(source.includes('modelProviderId: summaryModelSelection.providerId'));
    assert.ok(source.includes('model: summaryModelSelection.model'));
});

test('config UI disables cooldown input when group repeat is off', () => {
    assert.ok(source.includes('function updateGroupRepeatFields()'));
    assert.ok(source.includes("setConfigInputDisabledState('config-chat-group-repeat-cooldown-minutes', !enabled);"));
    assert.ok(source.includes("groupRepeatToggle?.addEventListener('change', updateGroupRepeatFields);"));
    assert.ok(source.includes('updateGroupRepeatFields();'));
});

test('preset selector defaults to active runtime preset instead of restored import records', () => {
    assert.ok(source.includes("const ACTIVE_PRESET_SELECT_VALUE = 'active';"));
    assert.ok(source.includes('function getActiveRuntimePresetSource()'));
    assert.ok(source.includes('function syncActivePresetDraftIntoRuntimeBinding(newConfig)'));
    assert.ok(source.includes('select.value = ACTIVE_PRESET_SELECT_VALUE;'));
    assert.ok(source.includes('<option value="${ACTIVE_PRESET_SELECT_VALUE}">'));
    assert.equal(source.includes('const firstId = records[0].id;'), false);
    assert.equal(source.includes('select.value = `import:${firstId}`;'), false);
});

test('config UI uses batch delete endpoints for preset imports and worldbooks', () => {
    assert.ok(source.includes("fetchJsonSafe('/api/preset/imports/batch-delete'"));
    assert.ok(source.includes("fetchJsonSafe('/api/worldbooks/batch-delete'"));
    assert.equal(source.includes('await deletePresetImportFile(id, true);'), false);
    assert.equal(source.includes("fetch(`/api/worldbooks/${encodeURIComponent(filename)}`, { method: 'DELETE' });\n                    const data = await res.json();\n                    if (data.success) success++;"), false);
});
