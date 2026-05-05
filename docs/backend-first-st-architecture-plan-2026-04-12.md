# Backend-First SillyTavern Architecture Plan

Date: `2026-04-12`

## Goal

Build a SillyTavern-inspired backend-first chat runtime where all chat-critical orchestration runs in the backend, while the frontend is reduced to configuration, management, and inspection UI.

Important scope constraint:

- do not copy all of SillyTavern
- only migrate the parts that directly affect chat runtime behavior
- non-chat subsystems may remain lightweight or project-specific

This document is not an implementation checklist yet. It is an architectural planning note derived from ST source analysis.

## In Scope

The following ST-inspired capabilities are in scope because they directly affect what is sent to the model or how a chat session behaves:

- chat completion preset application
- prompt ordering and prompt source resolution
- character card runtime fields
- persona injection
- world info / lorebook scanning and injection
- author note behavior
- extension prompt application
- regex/macro processing that affects runtime prompt text
- group chat aggregation rules
- continue / swipe / regenerate generation semantics
- character-card prompt overrides
- reasoning / tool-calling / media/file handling when they affect request payloads or chat history
- runtime token accounting and prompt inspection data
- itemized prompt snapshots if used for chat debugging or replay

## Out Of Scope

The following ST areas do not need full parity unless a later requirement explicitly demands them:

- complete frontend parity with ST layout and styling
- full extension marketplace / plugin ecosystem parity
- non-chat API parity where not needed by this project
- unrelated UI modules and dashboard conveniences
- every ST management surface and every auxiliary editor

The guiding rule is simple:

- if it changes chat runtime semantics, backendize it
- if it only manages configuration or displays state, keep it lightweight

## Core Decision

The target architecture is:

- Backend owns runtime semantics.
- Frontend owns configuration editing and inspection only.
- No generation-critical logic should live exclusively in the browser.

That means the backend must become the source of truth for:

- prompt ordering
- prompt source resolution
- world info scanning
- character override behavior
- persona injection
- extension prompt application
- token accounting
- runtime message tree construction
- itemized prompt snapshots

The frontend should not be responsible for reconstructing the final prompt.

## What Must Be Backendized

### 1. Prompt Runtime Kernel

The backend needs a first-class prompt runtime kernel that replaces the ST front-end PromptManager + OpenAI runtime assembly combination.

Required capabilities:

- ordered prompt source registry
- marker/source-slot semantics
- prompt trigger filtering by generation type
- relative vs absolute injection handling
- depth/order-based in-chat injection
- role-aware injection (`system` / `user` / `assistant`)
- prompt override tracking
- runtime message tree generation
- token accounting by final runtime tree

Suggested backend modules:

- `prompt-runtime/registry`
- `prompt-runtime/collection`
- `prompt-runtime/injection`
- `prompt-runtime/tokenizer`
- `prompt-runtime/inspector`

### 2. Source Resolution Layer

The backend must assemble prompt inputs from multiple upstream sources before final prompt construction.

Required source types:

- character card fields
- persona fields
- world info outputs
- author’s note
- extension prompts
- chat history
- dialogue examples
- tool metadata
- reasoning metadata
- media/file augmentation

The backend should expose a single source-resolution pipeline such as:

1. load chat state
2. load character state
3. load persona state
4. load world/lore state
5. resolve extension prompts
6. resolve runtime prompt sources
7. build final prompt tree

### 3. World Info Engine

The current ST design keeps most WI logic in the browser. For this project, WI must move to the backend.

Backend WI engine requirements:

- lorebook loading by identifier
- support for main world, aux books, embedded/character books, persona-bound books
- scanning against:
  - chat history
  - persona description
  - character description
  - character personality
  - character depth prompt
  - scenario
  - creator notes
- support for positions:
  - before
  - after
  - AN top/bottom
  - examples top/bottom
  - at depth
  - outlet
- support for group rules, probability, sticky/cooldown/delay, recursion prevention
- deterministic output structure:
  - `worldInfoBefore`
  - `worldInfoAfter`
  - `worldInfoExamples`
  - `worldInfoDepth`
  - `outletEntries`

### 4. Character Runtime Layer

The backend must treat character cards as runtime prompt inputs, not just static metadata.

Must support:

- TavernCard-compatible structure
- description/personality/scenario/example extraction
- `system_prompt` override
- `post_history_instructions` override
- `alternate_greetings`
- `creator_notes`
- `extensions.world`
- `extensions.depth_prompt`
- `character_book`

The backend should explicitly own:

- character-card override evaluation
- `forbid_overrides` enforcement
- group character aggregation rules

### 5. Persona Runtime Layer

Persona must be backend-visible and not frontend-only.

Must support:

- default persona
- persona per chat lock
- persona description injection mode
- persona depth/role settings
- persona lorebook binding

### 6. Preset Application Layer

Chat completion presets should be applied in the backend as complete runtime configuration snapshots.

Must support:

- chat completion preset loading
- binding/non-binding of connection fields
- prompt/runtime settings embedded in presets
- template-level preset fields
- API-specific settings subsets

Important boundary:

- Prompt manager state belongs to the preset/runtime layer, not to transient UI state.

### 7. Message Lifecycle Engine

The backend should own lifecycle semantics for:

- normal generation
- continue
- swipe
- regenerate
- quiet generation
- impersonate

That includes:

- generation type aware prompt selection
- continue prefill behavior
- swipe-compatible snapshot management
- history-aware reasoning/tool continuity

### 8. Tool Calling and Reasoning

These must be backend runtime concerns.

Tool calling backend duties:

- schema registration
- request payload embedding
- response parsing
- history writeback
- optional follow-up generation

Reasoning backend duties:

- request parameter support
- response extraction
- signature continuity
- reasoning block persistence

### 9. Media and File Attachment Processing

The backend should decide whether media/files are embedded into the model request.

Must support:

- image/audio/video inline capability checks
- provider/model capability resolution
- image quality/token-cost policy
- file extraction to text-prefix behavior
- message content part construction

### 10. Snapshot and Inspection Layer

A backend-first design should still preserve two observability modes inspired by ST:

- runtime prompt inspector
- per-message itemized prompt snapshots

Recommended backend outputs:

- `runtimePromptTree`
- `runtimeTokenBreakdown`
- `itemizedPromptSnapshot`
- `overriddenPrompts`
- `sourceTrace`

The frontend should render these, but the backend should generate them.

## What Should Stay Frontend-Only

Frontend should remain responsible for:

- editing forms
- lists and tables
- import/export buttons
- sortable UI for ordering configuration
- inspection viewers
- preview panes
- validation hints
- toggle controls

Frontend should not be responsible for:

- computing final prompt text/messages
- WI scanning
- role-card override application
- token accounting of final runtime prompt
- deciding whether prompt sources are active for a generation type
- history-aware absolute injection

## Required State Layers

The ST source strongly suggests keeping state split across multiple layers.

Recommended state boundaries for this project:

### A. Global Settings

Use for:

- account-wide defaults
- API credentials/config
- extension global settings
- preset library metadata
- default persona selection

### B. Chat Metadata

Use for:

- current chat persona lock
- current chat lorebook binding
- local variables
- per-chat runtime flags
- narrator/special chat mode state

### C. Character Card Store

Use for:

- character definitions
- character extensions
- character book/world linkage
- depth prompt
- creator notes
- prompt override fields

### D. Lorebook Store

Use for:

- world info entities
- auxiliary books
- embedded/imported character books converted into backend-native lorebooks

### E. Preset Store

Use for:

- API-specific presets
- chat completion presets
- prompt/runtime ordering presets
- context/instruct/reasoning/sysprompt templates where applicable

### F. Local Client Cache

Use only for:

- optional debug cache
- optional prompt snapshot mirror
- ephemeral local UX state

Do not require local cache for runtime correctness.

## Recommended Backend Layering

### Layer 1: Storage Adapters

Responsibilities:

- load/save settings
- load/save chats
- load/save characters
- load/save lorebooks
- load/save presets
- optional import/export compatibility

### Layer 2: Domain Models

Models should exist for:

- `CharacterProfile`
- `PersonaProfile`
- `Lorebook`
- `PromptPreset`
- `ChatSession`
- `PromptSource`
- `PromptNode`
- `MessageNode`
- `RuntimePromptTree`

### Layer 3: Runtime Services

Services should include:

- `CharacterResolver`
- `PersonaResolver`
- `LoreResolver`
- `PromptPresetResolver`
- `PromptRuntimeBuilder`
- `WorldInfoScanner`
- `TokenAccountingService`
- `ReasoningService`
- `ToolCallingService`
- `MediaInliningService`
- `SnapshotService`

### Layer 4: API Facade

The frontend should call backend endpoints like:

- `GET/POST /api/runtime/presets`
- `GET/POST /api/runtime/personas`
- `GET/POST /api/runtime/characters`
- `GET/POST /api/runtime/lorebooks`
- `POST /api/runtime/prompt-preview`
- `POST /api/runtime/generate`
- `GET /api/runtime/itemized/:messageId`
- `GET /api/runtime/inspect/current`

## Compatibility Targets

If ST compatibility matters, the backend should ideally support:

- TavernCard import/export compatibility
- world info JSON import/export compatibility
- chat completion preset import/export compatibility where practical
- stable mapping for:
  - `system_prompt`
  - `post_history_instructions`
  - `prompts`
  - `prompt_order`
  - `extensions.world`
  - `extensions.depth_prompt`

## What Not To Do

Avoid these mistakes:

- putting runtime prompt assembly in the frontend
- storing PromptManager state only in the browser
- treating every prompt row as a static text row
- collapsing chat metadata into global settings
- collapsing character prompt fields into chat metadata
- making itemized prompt snapshots mandatory for runtime correctness
- making WI scanning depend on client-only caches

## Recommended Migration Order

### Phase 1: Runtime Skeleton

Implement backend-only:

- chat completion preset application
- prompt source registry
- prompt ordering and trigger filtering
- runtime preview endpoint

Frontend at this stage:

- manage presets
- manage prompt rows
- view generated preview from backend

### Phase 2: Character + Persona + Lore Integration

Implement backend:

- character field resolution
- persona injection
- lorebook scanning
- before/after/depth outputs

Frontend:

- manage characters/personas/lorebooks only
- inspect backend-resolved source trace

### Phase 3: Full Runtime Orchestration

Implement backend:

- absolute injection
- continue/swipe/regenerate types
- token accounting
- overrides
- snapshot generation

Frontend:

- prompt inspector
- itemized prompt viewer

### Phase 4: Advanced Runtime

Implement backend:

- reasoning
- tool calling
- media inlining
- optional extension prompt API

Frontend:

- advanced toggles
- result/debug views

## Minimal Viable Backend-First Slice

If building incrementally, the smallest viable slice is:

1. character card storage
2. lorebook storage
3. chat completion preset storage
4. backend prompt preview endpoint
5. backend prompt ordering and runtime source resolution
6. frontend management panel that edits config and previews backend output

## Recommended First Delivery Scope

To stay aligned with the narrowed requirement, the first delivery should cover only chat-related backend runtime behavior:

1. character + persona + lorebook loading
2. prompt preset loading and application
3. backend prompt source resolution
4. backend runtime preview / inspect endpoint
5. backend final request assembly for the active chat API
6. frontend management UI for editing and inspecting the above

Do not block this first delivery on:

- complete ST-style frontend parity
- full extension platform parity
- cross-API parity beyond the active chat path needed by this project

This gets the architecture moving in the correct direction without faking ST behavior in the browser.

## Final Guideline

When a feature changes what is actually sent to the model, it belongs in the backend.

When a feature only helps configure, inspect, or manage that behavior, it may live in the frontend.
