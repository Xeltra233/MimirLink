# SillyTavern Research Notes

Date: `2026-04-12`

## Scope

These notes summarize the SillyTavern architecture areas already traced in source and docs:

- Chat Completion Presets
- Prompt Manager
- World Info / Character Book
- Persona
- Character Card structure
- Character-card prompt overrides

The goal is to avoid implementing a fake ST-style UI without the underlying ST data model.

## Core Mental Model

SillyTavern is not built around a single "preset editor" concept. The relevant layers are:

1. Chat Completion Preset layer
2. Prompt Manager layer
3. Runtime source layer
4. ChatCompletion message-tree layer
5. Inspector / token accounting layer

These layers are separate and must not be collapsed.

## Chat Completion Presets

Primary source:

- `public/scripts/openai.js`

Key function:

- `getChatCompletionPreset(settings = oai_settings)`

Meaning:

- a chat completion preset is the full settings snapshot derived from `settingsToUpdate`
- it is not only prompt content
- it includes model/source, sampling, prompt templates, behavior flags, and Prompt Manager state

Important fields included in chat completion presets:

- connection/model fields
- sampling fields
- behavior flags
- formatting templates
- `prompts`
- `prompt_order`

Preset lifecycle functions:

- `loadOpenAISettings(...)`
- `saveOpenAIPreset(...)`
- `onSettingsPresetChange(...)`
- import/export/new/update/delete handlers in `openai.js`

Important conclusion:

- Prompt Manager is only one subsystem inside a chat completion preset.

## Bind To Connection

Field:

- `bind_preset_to_connection`

Meaning:

- chat completion presets can include connection-specific fields
- but applying a preset can skip those fields when the binding toggle is off

Important source behavior:

- `onSettingsPresetChange(...)` skips connection fields when `bind_preset_to_connection === false`

Important conclusion:

- ST preset switching is field-delta application, not blind full-object replacement.

## Prompt Manager Data Model

Primary source:

- `public/scripts/PromptManager.js`

Default prompt definition object:

- `chatCompletionDefaultPrompts`

Default order:

- `promptManagerDefaultPromptOrder`

Important fact:

- the prompt list is mixed
- some items are editable prompt bodies
- some items are markers / source slots

Default editable prompt-like items:

- `main`
- `nsfw`
- `jailbreak`
- `enhanceDefinitions`

Default marker/source-slot items:

- `dialogueExamples`
- `chatHistory`
- `worldInfoAfter`
- `worldInfoBefore`
- `charDescription`
- `charPersonality`
- `scenario`
- `personaDescription`

Important conclusion:

- ST Prompt Manager is not a plain list of `prompt.content` rows.

## Prompt Manager Frontend

Primary sources:

- `public/scripts/templates/promptManagerHeader.html`
- `public/scripts/templates/promptManagerFooter.html`
- `public/scripts/templates/promptManagerListHeader.html`
- `public/css/promptmanager.css`
- `public/scripts/PromptManager.js`

Frontend structure:

- list-based manager, not a card-grid dashboard
- popup-based inspect/edit forms, not a permanently split-pane editor by default
- real drag-and-drop via jQuery UI sortable

List row semantics include:

- marker icon
- global prompt icon
- preset prompt icon
- in-chat injection icon
- role icon for user/assistant
- overridden-from-character-card icon
- token count sourced from runtime ChatCompletion state

Important conclusion:

- ST front-end appearance is tightly coupled to runtime prompt/message state.

## Prompt Manager Runtime Role

Important functions:

- `preparePrompt(...)`
- `renderPromptManagerListItems()`
- `setChatCompletion(chatCompletion)`

What Prompt Manager does:

- manages prompt definitions and prompt order
- renders prompt list UI
- exposes inspect/edit/toggle/detach/new/import/export/reset
- consumes `ChatCompletion` output for token counts and inspect state

What Prompt Manager does not do:

- it does not itself assemble final world info content
- it does not itself expand chat history into final messages
- it does not itself own preset CRUD for the full chat completion preset layer

## Runtime Prompt Assembly

Primary source:

- `public/scripts/openai.js`

Key functions:

- `preparePromptsForChatCompletion(...)`
- `populateChatCompletion(...)`
- `populateChatHistory(...)`
- `populateDialogueExamples(...)`
- `prepareOpenAIMessages(...)`

Important flow:

1. Prompt Manager provides ordered prompt definitions and markers.
2. `preparePromptsForChatCompletion(...)` replaces marker slots with runtime prompt sources.
3. `populateChatCompletion(...)` converts prompt sources into `MessageCollection`s.
4. chat history and dialogue examples are expanded separately, not treated as normal text prompts.
5. `ChatCompletion` is passed back into Prompt Manager for inspect/token display.

Important conclusion:

- marker rows are placeholders/anchors, not normal editable prompt bodies.

## ChatCompletion and Inspect

Primary source:

- `public/scripts/openai.js`

Important classes:

- `Message`
- `MessageCollection`
- `ChatCompletion`

Meaning:

- Prompt Manager inspect works on the final runtime message tree
- not on static prompt bodies

Marker inspect meaning:

- inspect shows the collection of final messages associated with the marker
- if no messages landed there, inspect says the marker contains no prompts

Important conclusion:

- if a UI treats marker rows as normal `content` rows, it is fundamentally wrong.

## World Info / Character Book

Primary source:

- `public/scripts/world-info.js`

Important output from world info pipeline:

- `worldInfoString`
- `worldInfoBefore`
- `worldInfoAfter`
- `worldInfoExamples`
- `worldInfoDepth`
- `anBefore`
- `anAfter`
- `outletEntries`

Important conclusion:

- world info is not a single blob
- ST splits it by location and injection semantics

Additional important fact:

- WI scanning can depend on persona description, character description, character personality, character depth prompt, scenario, creator notes

Meaning:

- role card fields are not just display text; they participate in runtime WI activation.

## Persona

Primary doc source:

- Personas docs on `docs.sillytavern.app`

Important concepts:

- persona is the user-side identity object
- persona description is separate from character description
- persona description has multiple injection modes
- one supported mode is direct Prompt Manager / story string injection
- persona also participates in world-info scan conditions

Important conclusion:

- persona is not equivalent to the legacy user name/avatar only.

## Character Card Structure

Primary sources:

- `src/endpoints/characters.js`
- `src/validator/TavernCardValidator.js`
- `src/character-card-parser.js`

ST supports:

- V1
- V2
- V3

But the practical structure of interest is V2/V3 with `data` payload.

Important V2 required fields under `data`:

- `name`
- `description`
- `personality`
- `scenario`
- `first_mes`
- `mes_example`
- `creator_notes`
- `system_prompt`
- `post_history_instructions`
- `alternate_greetings`
- `tags`
- `creator`
- `character_version`
- `extensions`

Important extensions:

- `data.extensions.world`
- `data.extensions.depth_prompt.prompt`
- `data.extensions.depth_prompt.depth`
- `data.extensions.depth_prompt.role`
- `data.extensions.talkativeness`
- `data.extensions.fav`

Important conclusion:

- character cards in ST are prompt-generation inputs, not just profile cards.

## Character Book Embedding

Primary source:

- `characters.js` conversion flow

Important behavior:

- if a character references `world`, ST can import or convert that world info into `data.character_book`

Meaning:

- character cards can carry embedded knowledge-book content
- they are not limited to a simple `world` filename reference

## Character Card Prompt Overrides

Primary sources:

- `PromptManager.js`
- `openai.js`

Overridable prompts in Prompt Manager:

- `main`
- `jailbreak`

Override source values in chat completion preparation:

- `systemPromptOverride`
- `jailbreakPromptOverride`

Application rules:

- only applied if override text exists
- skipped if the prompt is disabled
- skipped if `forbid_overrides === true`

Important conclusion:

- character cards can override chat completion preset content for `main` and `jailbreak`
- this is separate from marker/source-slot population

## Overridden Prompt UI Marker

Frontend effect:

- Prompt Manager renders an address-card icon with title `Pulled from a character card`

Source chain:

1. `prompts.override(...)` records the overridden identifier.
2. `ChatCompletion.setOverriddenPrompts(...)` stores the list.
3. `PromptManager.setChatCompletion(...)` restores it to UI state.
4. list rendering checks `this.overriddenPrompts.includes(prompt.identifier)`.

Meaning:

- this icon does not mean the row is a generic external source row
- it specifically marks prompt rows whose content was replaced by character-card override logic

## Forbid Overrides

Meaning:

- prevents character-card override from replacing the prompt

Practical effect:

- if `main.forbid_overrides === true`, character card `system_prompt` will not replace `main`
- if `jailbreak.forbid_overrides === true`, character card `post_history_instructions` will not replace `jailbreak`

Important conclusion:

- ST distinguishes ordinary system prompts from important non-overridable system prompts.

## Why A Fake ST UI Fails

The following simplifications are incorrect:

- treating every row as `preset.prompts[index].content`
- treating marker rows as editable prompt bodies
- treating token counts as static estimates from row text
- treating the prompt list as independent from runtime message assembly
- treating chat completion presets as only prompt content

## Next Research Targets

Still worth tracing in additional detail:

- character-card editing UI and the exact front-end field map
- persona front-end field map
- full extension prompt / in-chat injection behavior and ordering
- character-card override sourcing path from selected character object into `prepareOpenAIMessages(...)`
- itemized prompt snapshots vs Prompt Manager inspector relationship
