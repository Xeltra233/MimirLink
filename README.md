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

### Linux / Windows
```bash
npm install
cp config.example.json config.json
npm start
# 面板: http://localhost:8001
```
Node.js >= 16。

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
`POST /mcp` — Claude Code 等外部工具远程调用。挂载配置（`.claude/settings.json`）：
```json
{"mcpServers":{"mimirlink-range":{"url":"http://localhost:8001/mcp"}}}
```

| 工具 | 描述 |
|---|---|
| `range_test` | 发送测试消息，获取 AI 回复 |
| `range_analyze` | 评分回复质量 |
| `range_trace_output` | 追踪输出来源（预设/角色卡/世界书） |
| `range_validate_character` | 校验角色卡格式、八股词、HTML |
| `range_validate_worldbook` | 校验世界书 ST 格式 |
| `range_validate_preset` | 校验预设格式 |
| `range_fix_worldbook_format` | 自动修复非标字段 |
| `range_get_preset_status` | 列出预设及启用状态 |
| `range_set_preset_prompt` | 启用/禁用/修改预设 prompt |
| `range_update_character` | 修改角色卡字段 |
| `range_batch_test` | 批量测试 |

### 反注入
- 14 条规则，high 风险直接拦截 + QQ 回复警告
- 管理员 QQ 白名单绕过
- 角色劫持/越狱/权限伪装/上下文污染全覆盖

### 备份恢复
- 配置页一键导出 tar.gz（safe 脱敏 / full 含 Key）
- 含全部角色卡、世界书、数据库、会话、语料

---

## 已知问题

- **HTML 前端卡**：ST 的 `<details>` `<maintext>` `<div class="...">` 等复杂标签未完全覆盖，纯文字卡正常
- **变量初始化**：仅扫描 `setvar` 宏，不含脚本执行
- **预设需手动调**：导入的 ST 预设默认大量 prompt 启用，需在 MCP 或配置页关闭不需要的

---

## 角色卡调教指南

酒馆导入的角色卡不会开箱即用，需要手动调整：

### 预设元数据会牵着角色走
ST 角色卡通常带大量预设 prompt（COT 思维链、格式检查、文风指导等），这些元数据优先级高于角色人设，会导致角色被"系统指令"绑架。**导入后第一件事：用 MCP `range_get_preset_status` 审查全部启用预设，关掉不需要的。**

常见需要关闭的：
- 行动选项（A/B/C/D 多选）
- NPC 内心独白、咪咪点评
- 平行事件、显示时间地点
- 摘要自动输出
- 瑟瑟/NSFW 相关（QQ 群聊不需要）

操作：`range_set_preset_prompt { namePattern: "行动选项", enabled: false }`

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
│   ├── mcp.js               # MCP 端点
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
