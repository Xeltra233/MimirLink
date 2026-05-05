# MimirLink Chat Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move MimirLink's chat-critical prompt orchestration into the backend, while keeping the frontend as a configuration and inspection UI only.

**Architecture:** Build a backend runtime pipeline around the existing `PromptBuilder`, `WorldBookManager`, `CharacterManager`, and bindings model instead of copying SillyTavern UI semantics. The first delivery adds structured runtime prompt resolution, backend preview/inspect endpoints, and explicit source tracing without requiring full ST feature parity.

**Tech Stack:** Node.js, Express, current `src/` services, JSON config/worldbook storage, existing frontend `public/index.html`

---

## File Structure

Existing files that should remain central:

- `src/index.js`
  - application wiring and manager composition
- `src/routes.js`
  - backend configuration APIs and future runtime preview APIs
- `src/prompt.js`
  - current prompt building logic; should be slimmed into a runtime coordinator or split gradually
- `src/worldbook.js`
  - existing lorebook loading/matching logic; should be extended, not bypassed
- `src/character.js`
  - existing role card loading and metadata access
- `config.json`
  - existing preset/bindings/context/regex/global runtime config

Recommended new files for phase 1:

- `src/runtime/prompt-registry.js`
  - defines prompt source records, ordering, and normalized prompt items
- `src/runtime/source-resolver.js`
  - resolves effective character/preset/worldbook/regex/context inputs for one generation
- `src/runtime/chat-preview.js`
  - builds a structured preview payload for frontend inspection
- `tests/chat-runtime-preview.test.js`
  - regression tests for runtime preview/source resolution

Optional later phase files:

- `src/runtime/token-accounting.js`
- `src/runtime/world-info-engine.js`
- `src/runtime/inspector.js`

## Phase 1 Scope

This plan intentionally excludes full ST parity. It only covers the minimum backend-first chat runtime slice:

- effective preset resolution
- effective worldbook resolution
- effective character runtime fields
- structured prompt source registry
- backend preview of final messages
- source tracing for inspection

This phase does **not** include:

- full PromptManager marker parity
- swipe/regenerate runtime branches
- reasoning/tool-calling/media parity
- persona runtime layer
- true ST-style absolute injection/depth ordering

## Task 1: Define Backend Runtime Shapes

**Files:**
- Create: `src/runtime/prompt-registry.js`
- Test: `tests/chat-runtime-preview.test.js`

- [ ] **Step 1: Write the failing test**

Create a focused test that asserts the backend runtime layer can return a structured source list instead of only raw message strings.

```js
test('buildChatRuntimePreview returns structured source records', async () => {
    const preview = await buildChatRuntimePreview({
        characterName: 'Alice',
        userMessage: 'hello',
        context: { recentMessages: [], summaries: [] },
        runtimeContext: {},
    }, {
        characterManager,
        worldBookManager,
        config,
    });

    assert.equal(Array.isArray(preview.sources), true);
    assert.equal(Array.isArray(preview.messages), true);
    assert.equal(typeof preview.effectiveBinding, 'object');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: FAIL because `buildChatRuntimePreview` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/prompt-registry.js` with two minimal helpers:

```js
export function createRuntimeSource({
    id,
    kind,
    label,
    content = '',
    enabled = true,
    meta = {},
} = {}) {
    return {
        id: String(id || '').trim(),
        kind: String(kind || 'unknown').trim(),
        label: String(label || '').trim(),
        content: typeof content === 'string' ? content : '',
        enabled: enabled !== false,
        meta: meta && typeof meta === 'object' ? meta : {},
    };
}

export function compactRuntimeSources(sources = []) {
    return sources.filter((item) => item && item.enabled !== false && String(item.content || '').trim());
}
```

- [ ] **Step 4: Run test to verify the helper file loads**

Run: `node --check src/runtime/prompt-registry.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/prompt-registry.js tests/chat-runtime-preview.test.js
git commit -m "feat: add chat runtime source primitives"
```

## Task 2: Add Source Resolver Around Existing Bindings

**Files:**
- Create: `src/runtime/source-resolver.js`
- Modify: `src/index.js`
- Modify: `src/prompt.js`
- Test: `tests/chat-runtime-preview.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that proves backend runtime preview exposes effective binding resolution from existing config/binding rules.

```js
test('buildChatRuntimePreview exposes effective preset and worldbook binding', async () => {
    const preview = await buildChatRuntimePreview({
        characterName: 'Alice',
        userMessage: 'hello',
        context: { recentMessages: [], summaries: [] },
        runtimeContext: {},
    }, {
        characterManager,
        worldBookManager,
        config,
    });

    assert.equal(preview.effectiveBinding.preset?.name, 'Test Preset');
    assert.equal(preview.effectiveBinding.worldbook, 'alice-world.json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: FAIL because no resolver populates `effectiveBinding`.

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/source-resolver.js` that centralizes effective runtime inputs using the current config shape:

```js
import { PromptBuilder } from '../prompt.js';

export function resolveChatRuntimeInputs({ characterName, config, characterManager, worldBookManager }) {
    const binding = PromptBuilder.getEffectiveBinding(config, characterName);
    const character = characterManager.readFromPng(characterName);
    const worldBook = binding.worldbook
        ? worldBookManager.readWorldBook(binding.worldbook)
        : (worldBookManager.currentWorldBook || null);
    const preset = PromptBuilder.normalizePreset(binding.preset || config.preset || {});

    return {
        effectiveBinding: binding,
        character,
        worldBook,
        preset,
    };
}
```

Add a static helper to `src/prompt.js` if needed so `getEffectiveBinding` can be reused without reaching into `index.js` internals.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/source-resolver.js src/prompt.js src/index.js tests/chat-runtime-preview.test.js
git commit -m "feat: resolve effective chat runtime inputs"
```

## Task 3: Build Backend Chat Preview Payload

**Files:**
- Create: `src/runtime/chat-preview.js`
- Modify: `src/prompt.js`
- Test: `tests/chat-runtime-preview.test.js`

- [ ] **Step 1: Write the failing test**

Add a test that requires the backend to return both final messages and a source trace.

```js
test('buildChatRuntimePreview returns final messages with source trace', async () => {
    const preview = await buildChatRuntimePreview({
        characterName: 'Alice',
        userMessage: 'hello',
        context: { recentMessages: [], summaries: [] },
        runtimeContext: {},
    }, {
        characterManager,
        worldBookManager,
        config,
    });

    assert.equal(preview.messages[0].role, 'system');
    assert.equal(preview.sources.some((source) => source.kind === 'character_description'), true);
    assert.equal(preview.sources.some((source) => source.kind === 'preset_pre_system'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: FAIL because source classification does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create `src/runtime/chat-preview.js` that wraps the current `PromptBuilder.build(...)` behavior but also emits source records.

Minimum shape:

```js
import { createRuntimeSource, compactRuntimeSources } from './prompt-registry.js';
import { resolveChatRuntimeInputs } from './source-resolver.js';

export async function buildChatRuntimePreview(input, services) {
    const { config, characterManager, worldBookManager } = services;
    const resolved = resolveChatRuntimeInputs({
        characterName: input.characterName,
        config,
        characterManager,
        worldBookManager,
    });

    const builder = services.promptBuilder;
    const built = await builder.build(
        input.characterName,
        input.userMessage,
        input.context,
        input.stickyKeys,
        input.runtimeContext,
        resolved.preset,
        resolved.worldBook,
    );

    const sources = compactRuntimeSources([
        createRuntimeSource({ id: 'character-description', kind: 'character_description', label: '角色描述', content: resolved.character.description }),
        createRuntimeSource({ id: 'character-personality', kind: 'character_personality', label: '角色性格', content: resolved.character.personality }),
        createRuntimeSource({ id: 'scenario', kind: 'scenario', label: '场景', content: resolved.character.scenario }),
        ...resolved.preset.prompts.filter((item) => item.enabled !== false).map((item) => createRuntimeSource({
            id: item.identifier,
            kind: item.role === 'assistant' ? 'preset_assistant' : (item.injection_position === 1 ? 'preset_post_history' : 'preset_pre_system'),
            label: item.name || item.identifier,
            content: item.content,
            meta: { role: item.role, injection_position: item.injection_position },
        })),
    ]);

    return {
        effectiveBinding: resolved.effectiveBinding,
        character: {
            name: resolved.character.name,
        },
        worldBook: resolved.worldBook ? { name: resolved.worldBook.name || null } : null,
        sources,
        messages: built.messages,
    };
}
```

This task may require a small, reviewable extension to `PromptBuilder.build(...)` so it can accept optional effective preset/worldbook overrides instead of always reading from instance state only.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/chat-preview.js src/prompt.js tests/chat-runtime-preview.test.js
git commit -m "feat: add backend chat runtime preview"
```

## Task 4: Expose Preview API For Frontend Management UI

**Files:**
- Modify: `src/routes.js`
- Test: `tests/preset-routes.test.js`

- [ ] **Step 1: Write the failing test**

Add a route test for a backend preview endpoint such as `/api/runtime/prompt-preview`.

```js
test('prompt preview api returns structured backend preview', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/runtime/prompt-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            characterName: 'Alice',
            userMessage: 'hello',
            context: { recentMessages: [], summaries: [] },
        }),
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(Array.isArray(body.sources), true);
    assert.equal(Array.isArray(body.messages), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/preset-routes.test.js`

Expected: FAIL because the route does not exist.

- [ ] **Step 3: Write minimal implementation**

In `src/routes.js`, add:

```js
app.post('/api/runtime/prompt-preview', requireAuth, async (req, res) => {
    try {
        const preview = await buildChatRuntimePreview({
            characterName: req.body.characterName,
            userMessage: req.body.userMessage || '',
            context: req.body.context || { recentMessages: [], summaries: [] },
            stickyKeys: new Set(req.body.stickyKeys || []),
            runtimeContext: req.body.runtimeContext || {},
        }, {
            config,
            characterManager,
            worldBookManager,
            promptBuilder,
        });

        res.json(preview);
    } catch (error) {
        logger.error('构建运行时预览失败', error);
        res.status(500).json({ error: '构建运行时预览失败' });
    }
});
```

Inject `buildChatRuntimePreview` from the runtime module.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/preset-routes.test.js tests/chat-runtime-preview.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes.js tests/preset-routes.test.js tests/chat-runtime-preview.test.js
git commit -m "feat: expose backend prompt preview api"
```

## Task 5: Convert Frontend Preset UI To Backend Preview Consumer

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Write the failing test**

No automated frontend test exists in this repository for this screen.

Instead, define the manual failure condition clearly:

- current frontend computes prompt-related presentation locally
- desired behavior is for frontend to request backend preview data and render the result

- [ ] **Step 2: Verify current behavior is frontend-local**

Inspect and confirm:

- preset editing UI reads local draft state only
- no backend preview request exists yet

Expected: confirmed by code inspection in `public/index.html`

- [ ] **Step 3: Write minimal implementation**

Add a backend-preview consumer panel in `public/index.html`:

- button: `预览后端运行时 Prompt`
- request target: `/api/runtime/prompt-preview`
- render:
  - effective binding summary
  - source list
  - final messages

Do **not** move prompt runtime logic into the frontend.

Suggested payload:

```js
{
  characterName: currentCharacterName,
  userMessage: previewInput,
  context: {
    recentMessages: [],
    summaries: [],
  },
  runtimeContext: {},
}
```

Suggested rendering target:

- a simple read-only inspector block beside or below the management UI

- [ ] **Step 4: Run verification**

Run:

- `node --test tests/preset-routes.test.js tests/chat-runtime-preview.test.js`
- `node --check src/routes.js`

Manual verification:

1. Open the management page.
2. Edit preset/character/world settings.
3. Trigger backend preview.
4. Confirm that source list and final messages come from backend JSON, not local reconstruction.

- [ ] **Step 5: Commit**

```bash
git add public/index.html src/routes.js tests/preset-routes.test.js tests/chat-runtime-preview.test.js
git commit -m "feat: render backend chat runtime preview in admin ui"
```

## Task 6: Add Source Trace For Character and Worldbook Imports

**Files:**
- Modify: `src/runtime/source-resolver.js`
- Modify: `src/routes.js`
- Test: `tests/chat-runtime-preview.test.js`

- [ ] **Step 1: Write the failing test**

Add a test asserting that the preview reveals whether preset/worldbook came from:

- global binding
- character binding
- imported-from-card binding

```js
test('runtime preview reports binding provenance', async () => {
    const preview = await buildChatRuntimePreview(...);

    assert.equal(preview.bindingTrace.worldbook.source, 'imported_from_card');
    assert.equal(preview.bindingTrace.preset.source, 'character_binding');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: FAIL because provenance is not exposed yet.

- [ ] **Step 3: Write minimal implementation**

Extend the resolver output with a compact binding provenance structure using the same precedence rules already present in current backend code.

Suggested shape:

```js
bindingTrace: {
  worldbook: { source: 'character_binding', value: 'alice-world.json' },
  preset: { source: 'imported_from_card', value: 'Alice Preset' },
  regexRules: { source: 'global', count: 3 },
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/chat-runtime-preview.test.js`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/source-resolver.js src/routes.js tests/chat-runtime-preview.test.js
git commit -m "feat: expose runtime binding provenance"
```

## Completion Criteria

This phase is complete when all of the following are true:

- backend can resolve effective chat runtime inputs for one generation
- backend can build final message preview without frontend reconstruction
- frontend can render backend preview data
- source provenance for preset/worldbook/runtime prompt inputs is visible
- tests exist for runtime preview and route behavior
- no chat-critical prompt logic remains frontend-only for the implemented slice
