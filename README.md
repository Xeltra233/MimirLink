# MimirLink

MimirLink is a QQ Tavern runtime focused on long-term memory, character lifecycle management, and operational visibility.

It connects QQ via OneBot, supports SillyTavern-compatible character cards and world books, and stores memory in SQLite so sessions, summaries, and character-bound databases survive restarts.

## What It Does

- Persistent SQLite memory instead of throwaway in-memory context
- Multiple memory scope modes:
  - `user_persistent`: one user keeps memory across groups and private chats
  - `group_user`: each user has isolated memory inside a group
  - `group_shared`: the whole group shares one memory space
  - `global_shared`: all traffic shares one memory space
- Character-level database binding and unbinding
- Memory migration between databases
- World book support with sticky entries and summary-aware prompting
- Regex pipeline for input/output processing
- Web control panel for operations, diagnostics, and configuration
- Model discovery and metadata probing from OpenAI-compatible upstreams
- TTS support
- Scheduled cleanup for cached TTS audio files

## Core Product Model

MimirLink is built around four ideas:

1. Memory scope should be explicit
2. Character switching should include database strategy
3. Databases should be manageable, not hidden files
4. Routing and memory behavior should be observable from the panel

## Current Architecture

### Memory

- Storage: SQLite
- Summaries: retained per session
- Global limit: enforced with pruning
- Failure-safe inbound capture: user messages are persisted before AI completion

### Character Lifecycle

- Import character cards from PNG
- Optionally import world book, preset, and regex-compatible metadata
- Bind a dedicated database per character
- Bind a custom database path
- Unbind back to the default database
- Delete character with database retention or migration choices

### Operations

- Dashboard shows:
  - active character
  - active world book
  - active memory database
  - access control mode
  - memory scope description
- Database inventory shows:
  - path
  - file size
  - update time
  - binding relations
  - sessions/messages/summaries count
- Memory migration panel supports:
  - source database
  - target database
  - session IDs
  - session prefix
  - user ID
  - replace mode

## Install

```bash
npm install
npm start
```

Open the panel at `http://localhost:8001` by default.

## Configuration Notes

Important runtime areas:

- `onebot`: QQ connection
- `ai`: model, API endpoint, timeout, tokens
- `chat.sessionMode`: memory scope strategy
- `chat.accessControlMode`: `allowlist`, `blocklist`, or `disabled`
- `memory.storage.path`: default memory database path
- `bindings.global.memoryDbPath`: global default database override
- `bindings.characters.*.memoryDbPath`: per-character memory database
- TTS audio cache cleanup runs automatically:
  - scheduled sweep every 10 minutes
  - files older than 24 hours are removed
  - only the newest 50 `tts_` files are kept

## Recommended Defaults

For most deployments:

- `sessionMode = user_persistent`
- `accessControlMode = allowlist`
- keep a global default database
- create dedicated databases only for characters that need isolated long-term memory

## Current Focus

The project is currently optimized around:

- durable memory
- database lifecycle
- role/character operations
- observability from the admin panel

## Compatibility

- OneBot / NapCat style QQ integration
- SillyTavern character cards
- SillyTavern-compatible world books
- OpenAI-compatible model endpoints

## Status

MimirLink is no longer just a Tavern-Link variant with extra memory.

It is now a memory-and-lifecycle-oriented runtime with:

- scoped persistent memory
- per-character database strategy
- migration workflows
- operational visibility
