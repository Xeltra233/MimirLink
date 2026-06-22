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

test('config UI disables cooldown input when group repeat is off', () => {
    assert.ok(source.includes('function updateGroupRepeatFields()'));
    assert.ok(source.includes("setConfigInputDisabledState('config-chat-group-repeat-cooldown-minutes', !enabled);"));
    assert.ok(source.includes("groupRepeatToggle?.addEventListener('change', updateGroupRepeatFields);"));
    assert.ok(source.includes('updateGroupRepeatFields();'));
});
