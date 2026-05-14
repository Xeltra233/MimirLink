# MimirLink

QQ / OneBot 场景的 Tavern 运行时。兼容 SillyTavern 角色卡，提供长期记忆、Web 面板、变量桥接和 MCP 接口。

**当前状态**：纯文字角色卡可用，ST 前端卡（输出 HTML）需自行适配正则。变量桥接和预设管理已打通。

---

## 快速部署

### Docker
```bash
git clone https://github.com/Xeltra233/MimirLink.git
cd MimirLink
# 放入 config.json 和角色卡到 data/characters/
docker compose up -d
```
支持 `linux/amd64` `linux/arm64`。

**目录挂载**：
| 宿主机 | 容器 | 说明 |
|--------|------|------|
| `./config.json` 或 `./config/config.json` | `/app/config.json` 或 `/app/config/config.json` | 配置文件，代码优先读 `config/config.json` |
| `./data` | `/app/data` | 角色卡、世界书、聊天记录、记忆库 |
| `./logs` | `/app/logs` | 运行日志 |
| `./audio` | `/app/audio` | TTS 语音 |

`config/config.json` 目录挂载适用于只能挂载目录的部署平台。两种方式等效。

### 最小配置
其余字段有默认值，只需填这 5 项即可跑起来：

```json
{
  "onebot": {
    "url": "ws://127.0.0.1:3001",
    "accessToken": "你的token"
  },
  "ai": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "sk-xxx",
    "model": "deepseek-chat"
  },
  "chat": {
    "defaultCharacter": "你的角色名"
  },
  "auth": {
    "enabled": true,
    "username": "admin",
    "password": "改掉这个密码",
    "sessionSecret": "随便打一串乱码"
  }
}
```

| 字段 | 说明 |
|------|------|
| `onebot.url` | OneBot 地址，不用 QQ 可留空 |
| `ai.baseUrl` / `ai.apiKey` / `ai.model` | AI 供应商，兼容 OpenAI/DeepSeek 等 |
| `chat.defaultCharacter` | 默认角色名（要和 `data/characters/xxx.png` 一致） |
| `auth.password` / `auth.sessionSecret` | Web 面板登录密码和会话密钥 |

完整配置参考 `config.example.json`。

### Linux / Windows
```bash
npm install
cp config.example.json config.json
npm start
# 面板: http://localhost:8001
```
Node.js >= 22.5.0（`node:sqlite` 内置模块）。

---

## 功能

### 角色卡
- 上传 PNG 角色卡，自动提取内嵌世界书、预设字段、正则
- 自动扫描 `{{setvar}}` `{{getvar}}` `{{get_message_variable}}` 并初始化变量
- 选角色自动切换世界书绑定
- **已知限制**：ST 前端卡（带 `<details>` `<maintext>` 等 HTML）输出需手动适配正则

### 变量桥接
- `{{setvar}}` 静态初始化、`{{getvar}}`/`{{get_message_variable}}` 宏解析
- AI 输出 `<UpdateVariable>` JSONPatch 自动写回
- 按 userId 隔离，跨群跨私聊变量一致

### HTML / ST 标签清洗
- 剥离 `draft_notes` `thinking` `details` `style` 等标签
- 保留 `<UpdateVariable>` 不误伤
- 带属性的标签和纯文本卡片已覆盖，复杂前端卡需自行扩展

### 人物档案
- 两种模式：`仅bot对话（省token）` / `全量消息`
- 支持已有画像增量或纯新消息总结
- 黑名单过滤、闲时/定时触发

### 长期记忆
- SQLite 持久化，四种作用域

### Web 面板
- 仪表盘、角色/世界书/预设/变量/知识管理
- 靶场：消息测试、ELO 评分、Agent 优化
- 配置：模型供应商、聊天参数、搜索、备份恢复、MCP

### MCP 接口
`POST /mcp`（默认路径，可在配置页修改）—— Claude Code 等外部工具远程调用，JSON-RPC 2.0 协议。

Config 中启用：
```json
{"mcp": {"enabled": true, "path": "/mcp"}}
```

Claude Code 挂载（`.claude/settings.json`）：
```json
{"mcpServers":{"mimirlink-range":{"url":"http://localhost:8001/mcp"}}}
```

**27 个工具：**

| 工具 | 描述 |
|---|---|
| **靶场测试** | |
| `range_test` | 发送测试消息，支持 `fakeHistory` 伪造记忆 |
| `range_analyze` | 评分回复质量，检测八股/冗余/角色偏离 |
| `range_batch_test` | 批量发送测试消息 |
| `range_get_prefs` | 读取靶场偏好（角色/世界书/预设/模型） |
| **角色卡** | |
| `range_list_characters` | 列出所有可用角色 |
| `range_get_character_card` | 获取角色卡完整内容（system_prompt、first_mes 等） |
| `range_validate_character` | 校验角色卡：必要字段、八股词、HTML标签、ST兼容性 |
| `range_update_character` | 修改角色卡字段，直接写入 PNG tEXt 块 |
| **世界书** | |
| `range_get_worldbook_entries` | 获取世界书所有条目完整内容，支持 `search` 过滤 |
| `range_load_worldbook` | 加载指定角色的世界书为当前活跃 |
| `range_validate_worldbook` | 校验世界书 ST 格式兼容性 |
| `range_fix_worldbook_format` | 自动修复非标字段（uid→id, order→insertion_order 等） |
| `range_update_worldbook_entry` | 添加/修改/删除/合并世界书条目 |
| **预设** | |
| `range_get_preset_status` | 列出所有预设 prompt 及启用状态，支持 `includeContent` 返回完整内容 |
| `range_set_preset_prompt` | 启用/禁用/修改指定预设 prompt |
| `range_batch_set_prompts` | 批量启用/禁用预设 prompt（关键词匹配） |
| `range_validate_preset` | 校验预设格式完整性 |
| **变量** | |
| `range_list_variables` | 列出变量，支持 scope/角色/搜索过滤 |
| `range_set_variable` | 创建或更新变量 |
| `range_delete_variable` | 删除变量 |
| **知识库 & 档案** | |
| `range_list_knowledge` | 列出知识库条目 |
| `range_set_knowledge` | 创建知识库条目 |
| `range_list_profiles` | 列出人物档案 |
| **数据注入** | |
| `range_seed_test_data` | 注入假数据用于全链路测试（变量/知识/档案） |
| `range_clear_test_data` | 清除指定 scope 的假测试数据 |
| **来源追踪** | |
| `range_trace_output` | 分析 AI 输出文本来源：匹配预设 prompt、世界书条目 |
| `range_list_models` | 列出可用 AI 模型（含 provider 信息） |

### 反注入
- 14 条规则，high 风险直接拦截 + QQ 回复警告
- 管理员 QQ 白名单绕过
- 角色劫持/越狱/权限伪装/上下文污染全覆盖

### 备份恢复
- 配置页分类勾选导出 tar.gz（配置/角色/世界书/记忆/预设/语料/知识/正则）
- 安全模式（脱敏）和完整模式（含 Key）
- 恢复支持同分类过滤，升级角色卡不勾记忆库即可保留数据
- 恢复前自动备份当前状态

### 表情回应与戳一戳
- 收到消息自动加 QQ 表情回应（`set_msg_emoji_like`），表示已读
- 支持戳一戳通知，注入对话流让角色自然感知
- 配置开关：`chat.emojiReaction` / `chat.pokeReaction`

### 靶场伪造记忆
- 工具面板粘贴对话历史，模拟继承记忆测试
- MCP `range_test` 支持 `fakeHistory` 参数
- 携带元数据格式：`[群聊|QQ:号码|昵称:XXX|...]`

---

## 已知问题

- **`node:sqlite` 需要 Node.js >= 22.5.0**：Zeabur 等平台默认 Node 20 会崩溃 `No such built-in module: node:sqlite`，需在 Dockerfile 或平台设置中指定 Node 22+
- **HTML 前端卡**：ST 的 `<details>` `<maintext>` `<div class="...">` 等复杂标签未完全覆盖，纯文字卡正常
- **变量初始化**：仅扫描 `setvar` 宏，不含脚本执行
- **预设需手动调**：导入的 ST 预设默认大量 prompt 启用，需在 MCP 或配置页关闭不需要的

---

## 角色卡调教指南

酒馆导入的角色卡不会开箱即用，需要手动调整。

### 预设元数据会牵着角色走

ST 角色卡通常捆绑大量预设 prompt —— COT 思维链、格式检查、文风指导、变量更新校验等。这些元数据注入 system prompt 后优先级高于角色人设，AI 会优先服从"系统指令"而非"角色性格"。

**最容易被牵着走的元数据类型：**

- **角色卡 description 与预设内容高度重叠**：角色卡自带的 system_prompt 和预设里的 COT/文风规则重复注入，导致 LLM 收到冗余指令
- **COT 思维链标签**：`<draft_notes>` `</draft_notes>` `{{setvar::xxx}}` 等模板宏可能被 LLM 输出到对话中而非静默执行
- **格式检查器**："防全知""防不读世界书""审视剧情"等——消耗 token 做内部审查，减少角色表达空间
- **创建时间戳、文件名**：`createdAt`、`sourceFilename` 等元数据字段只存在于 config.json 中，不会注入 LLM context，但占用配置体积

**导入后第一件事：**

用 MCP 审查全部启用预设：
```
range_get_preset_status → 看哪些 enabled=true
range_get_preset_status { includeContent: true } → 看具体内容
```

**常见需要关闭的：**
- 行动选项（A/B/C/D 多选）——QQ 群聊不需要
- NPC 内心独白、咪咪吐槽——拖慢回复、泄漏元信息
- 平行事件、显示时间地点——打破沉浸感
- 话痨/抢话相关——群聊频道不适合
- 摘要自动输出——LLM 会在回复末尾附摘要
- 瑟瑟/NSFW 相关——QQ 群聊不需要
- 格式检查器、格式稳定器——会让 AI 过度关注格式

操作：`range_batch_set_prompts { disablePatterns: ["行动选项","防抢话","格式检查","平行事件"] }`

**进阶：把角色规则从预设搬到世界书**

预设是整个角色卡共享的，世界书可以按需注入。把关键行为规则写进世界书条目（设高 `insertion_order`），比放预设里更精准可控。

### 单人场景 → 多人 QQ 群适配
酒馆卡设计给 1v1 私聊，变量体系也是单用户视角。放到 QQ 群需要：
- 变量按 userId 隔离（本系统已做）
- 角色需要对多人说话，不能每次只回一个人
- `system_prompt` 里加群聊语境说明（"你正在QQ群里跟群友聊天"）
- `post_history_instructions` 限制输出长度，群聊不适合长文

### 变量卡适配
酒馆的 MVU 变量卡依赖 ST 前端插件执行，MimirLink 不支持脚本运行时。只兼容：
- `{{setvar}}` / `{{getvar}}` / `{{get_message_variable}}` 静态宏
- AI 输出的 `<UpdateVariable>` JSONPatch

不兼容：`type: "script"`、JS_CODE 真执行、完整 MVU 生命周期。

---

## 目录结构

```
MimirLink/
├── src/                     # 后端
│   ├── index.js             # 主入口
│   ├── routes.js            # API 路由
│   ├── session.js           # 记忆/变量/档案
│   ├── variable-bridge.js   # 变量桥接 & 标签清洗
│   ├── ai.js / prompt.js    # AI 调用 & prompt 构建
│   ├── character.js         # 角色卡管理
│   ├── worldbook.js         # 世界书管理
│   ├── onebot.js            # OneBot 客户端（消息/表情/戳一戳）
│   ├── mcp.js               # MCP 端点（Streamable HTTP）
│   ├── security.js          # 反注入
│   └── runtime/             # 运行时工具
├── public/index.html        # Web 面板 SPA
├── data/                    # 运行数据 (gitignore)
├── Dockerfile / docker-compose.yml
└── package.json
```

---

## License

MIT
