# MimirLink

QQ / OneBot 场景的 Tavern 运行时 —— 长期记忆、角色管理、Web 运维面板、变量桥接。

兼容 SillyTavern 角色卡资产，运行时独立。

---

## 快速部署

### Docker（推荐）
```bash
git clone https://github.com/Xeltra233/MimirLink.git
cd MimirLink
# 放入你的 config.json 和角色卡到 data/characters/
docker compose up -d
```
支持 `linux/amd64` `linux/arm64`。健康检查: `GET /api/status`。

### Linux / Windows
```bash
npm install
cp config.example.json config.json   # 编辑配置
npm start
# 面板: http://localhost:8001
```
要求 Node.js >= 16。

---

## 功能

### 角色卡导入即用
- 上传 PNG 角色卡 → 自动提取内嵌世界书、预设字段、正则规则
- 自动扫描 `{{setvar}}` `{{getvar}}` `{{get_message_variable}}` 并初始化变量
- 选角色自动切换世界书绑定
- 54 张 ST 角色卡全量实测兼容

### 变量桥接
- `{{setvar::key::value}}` 静态初始化
- `{{getvar::key}}` / `{{get_message_variable::key}}` 宏解析
- AI 输出 `<UpdateVariable>` JSONPatch 自动写回变量存储
- 按人隔离（userId），跨群跨私聊变量一致
- 前端变量面板：`属性名: 数值` 简洁展示

### HTML / ST 标签清洗
- 自动剥离 `draft_notes` `thinking` `details` `style` `<div class="...">` 等
- 保留 `<UpdateVariable>` 不误伤
- QQ 聊天只输出纯文本

### 人物档案自动建档
- 两种分析模式：`仅bot对话（省token）` / `全量自动爬`
- 支持已有画像增量更新或纯新消息总结
- 黑名单过滤，participantId 逗号分隔
- 触发模式：闲时 / 定时巡检 / 两者

### 长期记忆
- SQLite 持久化，重启保留
- 四种作用域：user_persistent / group_user / group_shared / global_shared

### Web 面板
- 仪表盘：OneBot 状态、Token 消耗、调用趋势
- 角色/世界书/预设/正则/变量/知识/语音 全管理
- 靶场：测试 prompt、ELO 评分、Agent 优化循环
- 配置：模型供应商、聊天参数、搜索、备份恢复

### MCP 接口
- `POST /mcp` — JSON-RPC 端点
- 工具：range_test / range_analyze / range_list_characters / range_list_models / range_update_character / range_set_preset_prompt / range_validate_worldbook / range_fix_worldbook_format
- ST 格式校验：防止世界书编辑跑偏

### 数据备份
- 配置页 → 数据 Tab → 一键备份/恢复
- 可选含 Key 或不含 Key 导出

---

## 目录结构

```
MimirLink/
├── src/           # 后端源码
│   ├── index.js           # 主入口 & 消息处理
│   ├── routes.js          # API 路由
│   ├── session.js         # 记忆/变量/档案存储
│   ├── variable-bridge.js # 变量桥接 & 标签清洗
│   ├── ai.js              # AI 调用
│   ├── prompt.js          # Prompt 构建
│   ├── character.js       # 角色卡管理
│   ├── worldbook.js       # 世界书管理
│   ├── mcp.js             # MCP 端点
│   └── runtime/           # 运行时工具
├── public/
│   └── index.html         # Web 面板 SPA
├── data/                  # 运行数据 (gitignore)
│   ├── characters/        # 角色卡 PNG
│   ├── worlds/            # 世界书 JSON
│   ├── chats/             # SQLite 记忆库
│   └── ...
├── Dockerfile
├── docker-compose.yml
└── package.json
```

---

## 配置

首次运行需 `config.json`，关键字段：

| 字段 | 说明 |
|---|---|
| `ai.providers` | 模型供应商列表(baseUrl + apiKey + models) |
| `ai.model` | 默认模型 |
| `chat.allowedGroups` | 白名单群号 |
| `chat.sessionMode` | 记忆作用域 |
| `memory.participantProfile.enabled` | 人物档案开关 |
| `memory.participantProfile.analysisMode` | `bot_only_profile`(默认) / `bot_only_messages` / `profile_plus_messages` / `messages_only` |

---

## 开发

```bash
npm run dev        # 开发模式 (--watch)
npm run check      # 语法检查
```

### 添加角色卡

1. 把 `.png` 角色卡放入 `data/characters/`
2. 面板 → 角色 → 选择 → 自动提取世界书/预设/变量
3. 靶场测试效果

---

## License

MIT
