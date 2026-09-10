import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// 源文件在工作区是 CRLF，统一成 LF 再断言，避免行尾差异导致误报
const source = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

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

test('provider model actions reuse the saved server-side key when the input stays blank', () => {
    assert.ok(source.includes('function buildAIProviderRequestPayload(draft = {})'));
    assert.ok(source.includes("if (!payload.apiKey || payload.apiKey === '******')"));
    assert.ok(source.includes('delete payload.apiKey;'));
    assert.ok(source.includes('providerId: entry.id'));
    assert.ok(source.includes('JSON.stringify(buildAIProviderRequestPayload({'));
    // 拉取模型这一处（原「测图」按钮已移除，不再有第二处调用）
    assert.equal((source.match(/const draft = buildAIProviderRequestPayload\(buildResolvedAIConfig\(getAIConfigDraft\(\)\)\);/g) || []).length, 1);
    assert.ok(source.includes('已拉取 ${(data.models || []).length} 个模型，请手动启用需要使用的模型'));
    assert.ok(source.includes('hasSavedApiKey,'));
    assert.ok(source.includes("syncActiveAIProviderFromInputs({ apiKeyEdited: true })"));
    assert.ok(source.includes("if (apiKeyInput) apiKeyInput.value = entry.apiKey || '';"));
    assert.ok(source.includes('hasSavedApiKey: false,\n                hasApiKey: false,'));
});

test('provider key input can clear a transient key back to saved-key semantics', () => {
    const start = source.indexOf('function syncActiveAIProviderFromInputs(options = {})');
    const end = source.indexOf('function selectAIProviderEntry(providerId)', start);
    assert.ok(start >= 0);
    assert.ok(end > start);

    const fields = {
        'config-ai-apikey': { value: '' },
        'config-ai-provider-name': { value: '测试供应商' },
        'config-ai-provider': { value: 'openai-compatible' },
        'config-ai-baseurl': { value: 'https://provider.example/v1' }
    };
    let activeEntry = {
        name: '测试供应商',
        provider: 'openai-compatible',
        baseUrl: 'https://provider.example/v1',
        apiKey: '',
        hasSavedApiKey: true,
        hasApiKey: true,
        models: []
    };
    const context = {
        document: { getElementById: (id) => fields[id] || null },
        getActiveAIProviderEntry: () => activeEntry,
        normalizeAIProvider: (value) => value,
        normalizeAIModelEntries: (value) => value
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);

    fields['config-ai-apikey'].value = 'draft-key';
    context.syncActiveAIProviderFromInputs({ apiKeyEdited: true });
    assert.equal(activeEntry.apiKey, 'draft-key');
    assert.equal(activeEntry.hasApiKey, true);

    fields['config-ai-apikey'].value = '';
    context.syncActiveAIProviderFromInputs({ apiKeyEdited: true });
    assert.equal(activeEntry.apiKey, '');
    assert.equal(activeEntry.hasApiKey, true);

    fields['config-ai-apikey'].value = 'transient-key';
    context.syncActiveAIProviderFromInputs({ apiKeyEdited: true });
    fields['config-ai-apikey'].value = '';
    context.syncActiveAIProviderFromInputs();
    assert.equal(activeEntry.apiKey, 'transient-key');

    activeEntry = {
        ...activeEntry,
        apiKey: '',
        hasSavedApiKey: false,
        hasApiKey: false
    };
    fields['config-ai-apikey'].value = 'new-provider-key';
    context.syncActiveAIProviderFromInputs({ apiKeyEdited: true });
    fields['config-ai-apikey'].value = '';
    context.syncActiveAIProviderFromInputs({ apiKeyEdited: true });
    assert.equal(activeEntry.apiKey, '');
    assert.equal(activeEntry.hasApiKey, false);
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

test('saving an imported preset writes it back to the active runtime binding', () => {
    const syncStart = source.indexOf('function syncActivePresetDraftIntoRuntimeBinding(newConfig)');
    const syncEnd = source.indexOf('function buildPresetSavePayload()', syncStart);
    assert.ok(syncStart >= 0);
    assert.ok(syncEnd > syncStart);
    const syncBody = source.slice(syncStart, syncEnd);
    assert.equal(syncBody.includes('if (selectedPresetImportRecordId)'), false);
    assert.ok(source.includes('function buildPresetSavePayload()'));
    assert.ok(source.includes('const selectedRecord = getSelectedPresetImportRecord();'));
    assert.ok(source.includes('const sourcePreset = selectedRecord?.importedPreset || activeSource.preset || currentConfig?.preset || {};'));
    assert.ok(source.includes('preset: buildPresetSavePayload(),'));
});

test('拉取模型过渡：不换文案不加骨架，只做柔化 + 逐条淡入', () => {
    // 按钮有稳定 id，便于切换忙碌态
    assert.ok(source.includes('id="config-ai-provider-fetch-btn" onclick="fetchAIModels()"'));
    const loader = source.slice(source.indexOf('function setModelListLoading'), source.indexOf('async function fetchAIModels'));
    assert.ok(loader.length > 0);
    assert.ok(loader.includes('button.disabled = modelListLoading;'));
    assert.ok(loader.includes('btn-spinner'));
    // 不加文字加载提示、不插骨架屏（保持体感顺滑而不是跳文案）
    assert.equal(source.includes('正在拉取模型列表'), false);
    assert.equal(source.includes('model-skeleton'), false);
    assert.ok(loader.includes("container.classList.toggle('is-loading', modelListLoading);"));
    assert.ok(source.includes('.model-quick-list.is-loading {'));
    assert.ok(source.includes('transition: opacity 0.22s ease, filter 0.22s ease;'));
    assert.ok(source.includes('const MODEL_LIST_MIN_LOADING_MS = 420;'));
    // 完成/失败都会退出加载态并回填列表，不会卡在过渡态
    assert.equal((source.match(/setModelListLoading\(false\);/g) || []).length, 2);
    assert.equal((source.match(/renderModelQuickList\(availableAIModels\);/g) || []).length >= 2, true);
    // 结果逐条淡入：整批变化才重播动画，点单个按钮不闪
    assert.ok(source.includes('const animateEnter = signature !== lastModelListSignature;'));
    assert.ok(source.includes('animation-delay:${Math.min(index, 9) * 26}ms'));
    assert.ok(source.includes('.model-quick-list.is-entering .model-chip'));
    assert.ok(source.includes('@media (prefers-reduced-motion: reduce)'));
});

test('config UI 内联脚本可以正常解析（防止模板字符串改坏整个页面）', () => {
    const blocks = [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 3, `内联脚本块数量异常: ${blocks.length}`);
    blocks.forEach((code, index) => {
        assert.doesNotThrow(() => new Function(code), `第 ${index + 1} 个内联脚本块存在语法错误`);
    });
});
