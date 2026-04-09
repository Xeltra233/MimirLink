# Participant Profile Incremental Memory Design

## Goal

Add an incremental participant-profile system to the main roadmap.

The feature should automatically build and update profiles for real users based on private-chat and group-chat history, trigger during idle time plus sufficient accumulated information, avoid re-summarizing already summarized messages, and inject the current speaker's profile into prompt construction as part of the existing situational-context layer.

## Critical Clarification

This feature is **not** about role cards or character-card metadata.

It is about participant profiles for real chat users.

- source material:
  - private chat history
  - group chat history
- not source material:
  - role card fields
  - worldbook entries
  - preset assets

## Current State

The project already has useful memory and context primitives.

- `src/session.js`
  - `memory_entries`
  - `summary_index_entries`
  - `recallMemory(...)`
  - conversation-memory upsert helpers
  - summary-index upsert helpers
- `src/index.js`
  - builds `runtimeContext`
  - records `participants`
  - stores `recalledEntries`
- `src/prompt.js`
  - already has `buildSituationalContext(...)`
  - already injects session facts, participants, reply context, and recent user intent

The missing layer is a durable participant profile that evolves incrementally and is injected as context for the current speaking user.

## Scope

Included:

- introduce participant-profile memory entries
- update profiles incrementally instead of full-history rebuilds
- trigger profile updates only when:
  - enough new information has accumulated
  - the session/runtime is idle enough to process it
- inject the current speaker's profile summary into prompt context
- use existing profile state as reference for later updates

Excluded:

- role-card generation
- profile editing UI in this checkpoint
- relationship graph across all participants
- large social-scene modeling beyond current speaker focus

## Design Choice

Profiles should be implemented as a specialized memory layer integrated into the existing contextual prompt path, not as a separate bulky prompt block.

Selected direction:

- build participant profiles as durable incremental memory
- inject them through the existing situational-context system
- keep prompt injection lightweight and speaker-focused

This avoids creating a second unrelated prompt system.

## Data Model

Use a dedicated memory-entry type for participant profiles.

### New Entry Type

- `entry_type = participant_profile`

Suggested stored shape in `memory_entries`:

- `title`
  - participant identifier, e.g. display name or QQ-based label
- `content`
  - compact profile text for prompt use
- `tags_json`
  - profile keywords
- `metadata_json`
  - structured profile metadata such as:
    - `participantId`
    - `participantName`
    - `source`
    - `lastProcessedMessageAt`
    - `stableTraits`
    - `currentState`

This keeps the storage aligned with the current memory system while allowing profile-specific metadata.

## Profile Shape

The prompt-facing profile should be split into two layers.

### Stable Profile

Longer-lived traits such as:

- speaking style
- recurring interests
- stable attitude patterns
- relationship tendency with the bot

### Current State

Shorter-lived dynamic state such as:

- recent mood
- recent focus
- recent stance
- current tension / trust / closeness indicators

The feature should maintain both, because only one of them would make context feel either too static or too noisy.

## Incremental Update Strategy

The profile builder must not keep summarizing the same messages repeatedly.

### Required Rule

Track how far the profile builder has already consumed source messages.

Suggested metadata field:

- `lastProcessedMessageAt`
  - timestamp of the latest message already incorporated into the current profile

### Update Flow

1. Read the existing participant profile if present.
2. Fetch only messages newer than `lastProcessedMessageAt` for that participant.
3. If the new-message count is below threshold, do nothing.
4. If threshold is met and the runtime is idle enough, build an incremental update prompt using:
   - existing profile
   - new messages only
5. Replace the stored `participant_profile` with the updated profile.
6. Advance `lastProcessedMessageAt`.

This is the core mechanism that prevents repeated summarization.

## Trigger Conditions

Profiles should update only when two conditions are both true.

### 1. Enough New Information

Suggested default threshold:

- at least `8` new participant messages since the last processed position

### 2. Idle Window

Suggested default idle rule:

- no new message in that session for at least `2` minutes

This makes the feature opportunistic instead of blocking the main reply path.

## Trigger Placement

The profile update should be checked outside the immediate reply-generation critical path whenever possible.

Suggested placement:

- use runtime or post-batch hooks after a batch is processed
- if the session has been quiet long enough, schedule profile work
- avoid blocking reply delivery waiting for profile generation

## Message Sources

Profile building should merge both private and group context for the same participant where relevant.

Suggested participant key:

- QQ user ID as the primary stable identifier

Suggested source merge:

- private sessions from the same QQ user
- group messages from the same QQ user

This allows a user's profile to accumulate across contexts rather than being fragmented by session type.

## Prompt Injection Design

Do not inject a large standalone profile block.

Instead, extend `buildSituationalContext(...)` with a compact section for the current speaking user.

Suggested section:

```text
【当前发言人画像】
稳定画像: ...
当前状态: ...
```

### Injection Rule

- inject only the current speaker's profile by default
- do not inject all participant profiles in the group

This keeps the prompt small and aligned with the existing context-perception style.

## Recall Integration

Participant profiles should also be first-class recall candidates.

Suggested behavior:

- when recalling memory for a current speaker, include that participant's profile entry with high priority
- profile recall should rank above ordinary conversation memory
- system trusted assets still outrank participant profiles where appropriate

This allows the same profile to serve both:

- situational prompt injection
- structured recall context

## Verification Strategy

Manual verification:

1. Send enough private or group messages from the same QQ user.
2. Wait until the idle threshold passes.
3. Confirm a `participant_profile` entry is created.
4. Send additional new messages from the same user.
5. Confirm the next update uses only new messages and updates the existing profile instead of duplicating old content.
6. In a group chat, confirm only the current speaker's profile is injected into prompt context.

## Success Criteria

- participant profiles are built from private and group history
- updates are incremental rather than full-history rebuilds
- already summarized messages are not repeatedly reprocessed
- existing profiles are used as reference context for later updates
- the current speaker's profile is injected through situational context rather than a separate bulky prompt block
