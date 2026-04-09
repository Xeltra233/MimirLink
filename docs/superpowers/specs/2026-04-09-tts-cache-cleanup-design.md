# TTS Cache Cleanup Design

## Goal

Add automatic scheduled cleanup for cached TTS audio files so long-running deployments do not accumulate unbounded audio artifacts.

## Current State

The project already saves generated TTS files into the local audio directory and performs an opportunistic cleanup after each synthesis.

- `src/tts.js`
  - writes `tts_<timestamp>.<encoding>` files into `audio/`
  - has `cleanupAudio()`
  - current cleanup only runs after new audio is generated
  - current cleanup rule keeps the latest `50` files only

This means cache cleanup depends on new synthesis events. If the service goes idle after a burst of TTS activity, old files remain until the next synthesis.

## Scope

Included:

- add scheduled background cleanup for TTS cache files
- keep the current on-write cleanup path
- enforce both age-based and count-based cleanup
- limit cleanup to files prefixed with `tts_`

Excluded:

- generic audio asset cleanup beyond TTS cache
- UI for cache cleanup configuration in this checkpoint
- remote object storage or CDN cleanup

## Design Choice

Use a lightweight background timer inside `TTSManager`.

Selected rules:

- cleanup interval: `10` minutes
- max age: `24` hours
- max count: `50`

This keeps the implementation minimal and consistent with the current local-file design.

## Runtime Design

`TTSManager` should manage one cleanup timer.

### New Behavior

- start a cleanup interval when the manager is created
- on each interval tick, scan the TTS audio directory
- remove files that exceed the max age
- after age cleanup, enforce the max-count cap on remaining files
- keep `cleanupAudio()` as the shared implementation used by both:
  - scheduled cleanup
  - post-synthesis cleanup

### Safety Rules

- only operate on files whose names start with `tts_`
- ignore unrelated audio files
- tolerate missing files and transient stat/delete errors
- clear the interval when the process shuts down if a cleanup hook is added later

## Cleanup Policy

### Age-Based Cleanup

Delete any `tts_` file whose modification time is older than `24` hours.

### Count-Based Cleanup

After age-based cleanup completes, sort remaining `tts_` files by modification time descending and keep only the newest `50`.

This combination prevents both:

- slow buildup over time
- short-term bursts producing too many cached files

## Verification Strategy

Manual verification:

1. Generate multiple TTS files and confirm they are written to `audio/`.
2. Run the service long enough for at least one cleanup tick or trigger the shared cleanup method manually.
3. Confirm:
   - only `tts_` files are targeted
   - files older than the threshold are deleted
   - if more than `50` remain, only the newest `50` are kept
4. Confirm TTS sending still works after cleanup runs.

## Success Criteria

- cached TTS files are cleaned automatically on a schedule
- cleanup still runs immediately after synthesis as before
- both age and count limits are enforced
- unrelated files are untouched
