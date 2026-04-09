# TTS Cache Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add scheduled automatic cleanup for cached TTS audio files while preserving the current immediate post-synthesis cleanup behavior.

**Architecture:** Keep cleanup logic inside `TTSManager` and reuse one shared cleanup method for both immediate and scheduled cleanup. Add a background timer that enforces age-based and count-based file retention on `tts_` files only, then document the new behavior in the README.

**Tech Stack:** Node.js, local filesystem, existing `src/tts.js` runtime, project README.

---

## File Map

- Modify: `src/tts.js`
  - add cleanup timer lifecycle
  - add age-based cleanup
  - keep count-based cleanup
- Modify: `README.md`
  - document scheduled TTS cache cleanup behavior
- Optional checkpoint note: `SESSION_HANDOFF.txt`
  - update when implementation and verification complete

### Task 1: Add Scheduled Cleanup Lifecycle To TTSManager

**Files:**
- Modify: `src/tts.js:203-220`
- Modify: `src/tts.js:456-478`

- [ ] **Step 1: Add cleanup policy constants near the TTS module constants**

```js
const TTS_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const TTS_MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1000;
const TTS_MAX_CACHE_FILES = 50;
```

- [ ] **Step 2: Start the cleanup timer in `TTSManager` constructor**

```js
constructor() {
    this.config = normalizeTTSConfig();

    if (!fs.existsSync(AUDIO_DIR)) {
        fs.mkdirSync(AUDIO_DIR, { recursive: true });
    }

    this.startCleanupTimer();
}
```

- [ ] **Step 3: Add timer start helper**

```js
startCleanupTimer() {
    if (this.cleanupTimer) {
        clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(() => {
        try {
            this.cleanupAudio();
        } catch (error) {
            console.warn(`[TTS] 定时清理失败: ${error.message}`);
        }
    }, TTS_CLEANUP_INTERVAL_MS);
}
```

- [ ] **Step 4: Upgrade `cleanupAudio()` to apply both age and count rules**

```js
cleanupAudio() {
    if (!fs.existsSync(AUDIO_DIR)) return;

    const now = Date.now();
    const files = fs.readdirSync(AUDIO_DIR)
        .filter((f) => f.startsWith('tts_'))
        .map((f) => {
            const filePath = path.join(AUDIO_DIR, f);
            const stat = fs.statSync(filePath);
            return {
                name: f,
                path: filePath,
                time: stat.mtime.getTime()
            };
        })
        .sort((a, b) => b.time - a.time);

    for (const file of files) {
        if (now - file.time > TTS_MAX_CACHE_AGE_MS) {
            fs.unlinkSync(file.path);
            console.log('[TTS] 清理过期音频:', file.name);
        }
    }

    const remainingFiles = fs.readdirSync(AUDIO_DIR)
        .filter((f) => f.startsWith('tts_'))
        .map((f) => ({
            name: f,
            path: path.join(AUDIO_DIR, f),
            time: fs.statSync(path.join(AUDIO_DIR, f)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time);

    if (remainingFiles.length > TTS_MAX_CACHE_FILES) {
        remainingFiles.slice(TTS_MAX_CACHE_FILES).forEach((file) => {
            fs.unlinkSync(file.path);
            console.log('[TTS] 清理超量音频:', file.name);
        });
    }
}
```

- [ ] **Step 5: Run syntax verification for `src/tts.js`**

Run: `node --check "src/tts.js"`

Expected: no syntax errors.

### Task 2: Document The Cleanup Behavior

**Files:**
- Modify: `README.md:18-22`
- Modify: `README.md:81-92`

- [ ] **Step 1: Add scheduled TTS cleanup to the feature overview**

Add one concise bullet under the existing TTS support line.

```md
- TTS support with automatic cache cleanup for generated audio files
```

- [ ] **Step 2: Add a configuration/behavior note describing the cleanup policy**

Add a short note in the configuration section.

```md
- TTS audio cache is cleaned automatically:
  - scheduled sweep every 10 minutes
  - files older than 24 hours are removed
  - only the newest 50 `tts_` files are kept
```

- [ ] **Step 3: Re-read README section for duplication or contradictions**

Confirm:

- the new TTS cleanup note does not contradict the current TTS description
- the cleanup policy is explained once, not repeated awkwardly

### Task 3: Verify Runtime Behavior And Prepare Feature Checkpoint

**Files:**
- Verify only: `src/tts.js`
- Modify: `SESSION_HANDOFF.txt`

- [ ] **Step 1: Run backend syntax verification again**

Run: `node --check "src/tts.js" && node --check "src/routes.js" && node --check "src/index.js"`

Expected: all commands complete without syntax errors.

- [ ] **Step 2: Restart the app and confirm it still boots**

Run: `node src/index.js`

Expected:

- app starts without TTS-related errors
- homepage remains reachable

- [ ] **Step 3: Manually verify cleanup behavior minimally**

Check:

- new TTS synthesis still produces files normally
- no unrelated audio files are touched
- the manager starts without crashing when cleanup timer is active

- [ ] **Step 4: Update `SESSION_HANDOFF.txt` with the completed checkpoint**

Record:

- scheduled cleanup added
- retention policy values
- syntax verification status
- restart status

- [ ] **Step 5: Commit, update README, and push because this is a major feature checkpoint**

Run:

```bash
git add src/tts.js README.md SESSION_HANDOFF.txt docs/superpowers/specs/2026-04-09-tts-cache-cleanup-design.md docs/superpowers/plans/2026-04-09-tts-cache-cleanup.md
git commit -m "feat: add scheduled TTS cache cleanup"
git push
```

Expected: one feature checkpoint committed and pushed after verification.

## Self-Review

Spec coverage check:

- scheduled cleanup: Task 1
- age + count cleanup: Task 1
- README update: Task 2
- verification + checkpoint handling: Task 3

Placeholder scan:

- no placeholder implementation steps remain
- file paths are explicit
- verification commands are explicit

Type consistency check:

- constant names remain `TTS_CLEANUP_INTERVAL_MS`, `TTS_MAX_CACHE_AGE_MS`, `TTS_MAX_CACHE_FILES`
- cleanup function name remains `cleanupAudio()`
