# Trust-Layer Security Panel Design

## Goal

Close the current trust-layer work into a frontend-visible checkpoint without restarting the service.

The existing code already separates normal user input and admin QQ input inside the observation envelope. This design extends that work into a lightweight runtime history panel so the dashboard can show both the latest state and a short recent sequence of security observations.

This is intentionally not a full audit subsystem. The scope is runtime observability only.

## Current State

The project already has the core pieces of the trust split in place.

- `src/security.js`
  - `buildObservationEnvelope()` returns:
    - `trusted_context`
    - `runtime_stats`
    - `untrusted_user_inputs`
    - `trusted_admin_inputs`
    - `system_generated_memory`
- `src/index.js`
  - normal user input is written to `untrusted_user_inputs`
  - admin QQ input is written to `trusted_admin_inputs`
  - `lastInjectionObservation` is updated per processed message
- `src/routes.js`
  - `/api/status` already exposes `lastInjectionObservation`
- `public/index.html`
  - the dashboard already has a security panel block
  - admin QQ config is already editable from the frontend

The missing piece is continuity. The dashboard can currently show only the last observation, which is enough for a quick snapshot but not enough to understand recent risk changes or recent admin activity.

## Scope

This design adds a lightweight in-memory recent history to the existing trust-layer observation flow.

Included:

- keep the current observation envelope as-is
- wrap observations in display-friendly event metadata
- retain a fixed-length in-memory buffer of recent observation events
- expose recent observations through `/api/status`
- expand the dashboard security panel to show both summary and recent entries

Excluded:

- database persistence for security observations
- a dedicated audit log system
- new admin control commands
- access-control bypass for admins
- a separate security dashboard page

## Design Choice

Three approaches were considered.

1. Minimal enhancement
   - Keep only one latest observation and improve labels.
2. Lightweight history panel
   - Keep the current observation envelope and add a recent in-memory event buffer.
3. Full security subsystem
   - Build a separate runtime store with counters, audit records, and extension points.

The selected approach is option 2.

It adds the missing continuity without introducing new persistence, new route families, or a larger subsystem before the current line of work is closed.

## Data Model

The existing observation envelope remains the canonical trust-layer payload.

```js
{
  trusted_context: {},
  runtime_stats: {},
  untrusted_user_inputs: [],
  trusted_admin_inputs: [],
  system_generated_memory: []
}
```

Each observation will be wrapped into a runtime event object.

```js
{
  id,
  timestamp,
  actorType,
  summary,
  observation
}
```

### Event Fields

- `id`
  - unique runtime identifier for frontend list rendering and stable ordering
- `timestamp`
  - epoch milliseconds when the observation was created
- `actorType`
  - `user` or `admin`
- `summary`
  - compact display data derived from the observation for the dashboard
- `observation`
  - the unchanged full observation envelope

### Summary Shape

The summary should carry only the fields that the panel needs to render quickly.

```js
{
  sessionId,
  messageType,
  triggerReason,
  riskLevel,
  matchedRules,
  contentPreview
}
```

This keeps the frontend simple while preserving the full raw structure for future expansion.

## Runtime State

The runtime should keep two related variables.

- `lastInjectionObservation`
  - remains available for compatibility with the existing panel logic
- `recentInjectionObservations`
  - new fixed-length array of recent event objects

### Write Strategy

For every processed input message:

1. Build the existing observation envelope.
2. Derive `actorType` from the admin detection result.
3. Build the event wrapper with timestamp and summary.
4. Update `lastInjectionObservation` to the raw observation envelope.
5. Insert the event at the front of `recentInjectionObservations`.
6. Truncate the array to a fixed length.

Recommended initial buffer size: `20`.

This size is large enough to show short recent history but small enough to keep `/api/status` lightweight.

## Input Separation Rules

The current trust split must remain strict.

- Normal user input goes only to `untrusted_user_inputs`.
- Admin QQ input goes only to `trusted_admin_inputs`.
- The same message must never be written to both channels.
- Admin input may still produce a `risk` object, but it remains trusted and must be visually distinct from normal-user risk.

This preserves the purpose of the trust layer: separating source trust from text pattern matching.

## API Changes

No new endpoint will be introduced in this checkpoint.

`/api/status` will be extended with:

```json
{
  "lastInjectionObservation": { "...": "existing payload" },
  "recentInjectionObservations": [ { "...": "event object" } ]
}
```

This keeps authentication, routing, and frontend fetch flow unchanged.

If the recent security panel later grows beyond this checkpoint, a dedicated security endpoint can be introduced without changing the event structure.

## Frontend Design

The existing homepage security panel will be expanded into two sections.

### 1. Summary Section

This section should answer the question: what is the current trust-layer state right now?

Display:

- trusted sources
- admin QQ list
- latest normal-user risk level
- latest admin input preview or timestamp
- current recent-observation count

This preserves the current dashboard role as a fast operational overview.

### 2. Recent Observations Section

This section should answer the question: what has happened recently?

Each recent row should show:

- timestamp
- actor type: `普通用户` or `管理员`
- risk level: `none`, `low`, `medium`, `high`
- matched rules or `无命中规则`
- content preview
- sessionId

Rows should be sorted newest first.

### Visual Labels

Suggested styling:

- `high`: red
- `medium`: orange
- `low`: yellow
- `none`: gray or green
- actor label for admin: `trusted-admin`
- actor label for normal user: `untrusted-user`

The panel should remain compact and readable on the existing homepage rather than turning into a full-page security console.

## Empty and Error States

The panel should handle incomplete runtime state cleanly.

- No observations yet
  - render `暂无安全层观察`
- Empty matched rules
  - render `无命中规则`
- Empty content preview
  - allow blank preview without treating it as an error
- No admin users configured
  - render `-`
- Missing recent buffer
  - fall back to rendering only the existing latest observation block

The frontend should degrade gracefully if the backend is updated in stages.

## Testing Strategy

Verification for this checkpoint should focus on behavior rather than broad refactoring.

Manual checks:

1. Send a normal user message.
   - observation enters `untrusted_user_inputs`
   - recent list shows actor type `普通用户`
2. Send an admin QQ message.
   - observation enters `trusted_admin_inputs`
   - recent list shows actor type `管理员`
3. Send a risky normal-user message.
   - latest risk label and matched rules update correctly
4. Refresh the panel.
   - recent observations still exist during runtime
5. Exceed the buffer size.
   - oldest entries are dropped and newest-first ordering remains correct

This checkpoint does not require persistence across restart because persistence is explicitly out of scope.

## Risks and Constraints

- The recent history exists only in memory, so restart clears it.
- `/api/status` payload size grows slightly, but the fixed-length buffer bounds the increase.
- The old `lastInjectionObservation` shape should not be broken while the frontend is being upgraded.

These tradeoffs are acceptable for the current goal, which is to close the trust-layer visibility line without overbuilding.

## Implementation Outline

1. Add a recent observation buffer in `src/index.js`.
2. Build an event wrapper around each generated observation.
3. Expose `recentInjectionObservations` through `/api/status` in `src/routes.js`.
4. Expand the security panel rendering in `public/index.html`.
5. Keep existing `lastInjectionObservation` behavior intact while the new list is added.

## Success Criteria

This checkpoint is complete when all of the following are true:

- admin and normal-user inputs remain strictly separated in the observation envelope
- the backend retains a recent in-memory observation history
- the dashboard shows both current trust-layer summary and recent observation rows
- the service does not require a restart just to finish this line of work
- the result improves observability without introducing a new persistence or audit subsystem
