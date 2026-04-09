# MimirLink

中文 | [English](#english)

## 中文

MimirLink 是一个面向 QQ 场景的 Tavern 运行时，重点放在长期记忆、角色生命周期管理和后台可观测性上。

它通过 OneBot 接入 QQ，支持兼容 SillyTavern 的角色卡与世界书，并使用 SQLite 持久化记忆，让会话、摘要和角色绑定数据库在重启后仍能保留。

### 功能概览

- 使用 SQLite 持久化长期记忆，而不是一次性内存上下文
- 支持多种记忆作用域模式：
  - `user_persistent`：同一用户跨群与私聊共享长期记忆
  - `group_user`：群内每个用户独立记忆
  - `group_shared`：整个群共享同一份记忆
  - `global_shared`：所有流量共享同一份记忆
- 角色级数据库绑定与解绑
- 数据库迁移工具
- 世界书支持，包含 sticky 条目与摘要感知提示词
- 输入/输出正则处理流水线
- 运维与诊断 Web 控制面板
- OpenAI 兼容上游的模型探测与元数据查看
- TTS 语音支持
- TTS 语音缓存自动定时清理

### 核心产品模型

MimirLink 围绕四个核心理念构建：

1. 记忆作用域必须显式可控
2. 角色切换必须带上数据库策略
3. 数据库必须可管理，而不是隐藏文件
4. 路由与记忆行为必须能在后台面板里观察到

### 当前架构

#### 记忆

- 存储：SQLite
- 摘要：按会话保留
- 全局上限：带裁剪策略
- 失败安全：用户入站消息会先持久化，再进入 AI 生成流程

#### 角色生命周期

- 从 PNG 导入角色卡
- 可选导入世界书、预设和兼容正则元数据
- 为角色绑定独立数据库
- 支持绑定自定义数据库路径
- 可解绑回默认数据库
- 删除角色时支持保留数据库或迁移数据库

#### 运维能力

- 仪表盘可查看：
  - 当前角色
  - 当前世界书
  - 当前记忆数据库
  - 访问控制模式
  - 记忆作用域说明
- 数据库清单可查看：
  - 路径
  - 文件大小
  - 更新时间
  - 绑定关系
  - 会话 / 消息 / 摘要数量
- 记忆迁移面板支持：
  - 源数据库
  - 目标数据库
  - Session ID
  - Session 前缀
  - 用户 ID
  - 覆盖模式

### 安装

```bash
npm install
npm start
```

默认后台地址：`http://localhost:8001`

### 配置说明

关键运行配置包括：

- `onebot`：QQ 连接配置
- `ai`：模型、API 地址、超时、token 配置
- `chat.sessionMode`：记忆作用域策略
- `chat.accessControlMode`：`allowlist`、`blocklist` 或 `disabled`
- `memory.storage.path`：默认记忆数据库路径
- `bindings.global.memoryDbPath`：全局默认数据库覆盖路径
- `bindings.characters.*.memoryDbPath`：角色级数据库路径
- TTS 音频缓存会自动清理：
  - 每 10 分钟巡检一次
  - 删除超过 24 小时的缓存
  - 最多保留最新 50 个 `tts_` 文件

### 推荐默认值

大多数部署场景建议：

- `sessionMode = user_persistent`
- `accessControlMode = allowlist`
- 保留一个全局默认数据库
- 只为确实需要隔离长期记忆的角色建立独立数据库

### 当前重点

当前项目重点优化方向：

- 持久化记忆
- 数据库生命周期管理
- 角色 / 设定运行时管理
- 后台面板可观测性

### 兼容性

- OneBot / NapCat 风格 QQ 接入
- SillyTavern 角色卡
- SillyTavern 兼容世界书
- OpenAI 兼容模型接口

### 当前状态

MimirLink 已经不再只是 Tavern-Link 的记忆增强变体。

它目前正在收敛成一个更偏向“记忆 + 生命周期 + 运维”的 QQ 角色运行时，重点包括：

- 作用域化的持久记忆
- 角色级数据库策略
- 数据库迁移流程
- 面板级可观测性

---

## English

MimirLink is a QQ Tavern runtime focused on long-term memory, character lifecycle management, and operational visibility.

It connects QQ via OneBot, supports SillyTavern-compatible character cards and world books, and stores memory in SQLite so sessions, summaries, and character-bound databases survive restarts.

### What It Does

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

### Core Product Model

MimirLink is built around four ideas:

1. Memory scope should be explicit
2. Character switching should include database strategy
3. Databases should be manageable, not hidden files
4. Routing and memory behavior should be observable from the panel

### Current Architecture

#### Memory

- Storage: SQLite
- Summaries: retained per session
- Global limit: enforced with pruning
- Failure-safe inbound capture: user messages are persisted before AI completion

#### Character Lifecycle

- Import character cards from PNG
- Optionally import world book, preset, and regex-compatible metadata
- Bind a dedicated database per character
- Bind a custom database path
- Unbind back to the default database
- Delete character with database retention or migration choices

#### Operations

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

### Install

```bash
npm install
npm start
```

Open the panel at `http://localhost:8001` by default.

### Configuration Notes

Important runtime areas:

- `onebot`: QQ connection
- `ai`: model, API endpoint, timeout, tokens
- `chat.sessionMode`: memory scope strategy
- `chat.accessControlMode`: `allowlist`, `blocklist`, or `disabled`
- `memory.storage.path`: default memory database path
- `bindings.global.memoryDbPath`: global default database override
- `bindings.characters.*.memoryDbPath`: per-character memory database
- TTS audio cache is cleaned automatically:
  - scheduled sweep every 10 minutes
  - files older than 24 hours are removed
  - only the newest 50 `tts_` files are kept

### Recommended Defaults

For most deployments:

- `sessionMode = user_persistent`
- `accessControlMode = allowlist`
- keep a global default database
- create dedicated databases only for characters that need isolated long-term memory

### Current Focus

The project is currently optimized around:

- durable memory
- database lifecycle
- role/character operations
- observability from the admin panel

### Compatibility

- OneBot / NapCat style QQ integration
- SillyTavern character cards
- SillyTavern-compatible world books
- OpenAI-compatible model endpoints
