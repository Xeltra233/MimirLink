# MimirLink

中文 | [English](#english)

## 中文

MimirLink 是一个面向 QQ / OneBot 场景的 Tavern 运行时，目标不是做一个“只会接 API 回复一句话”的 QQ 机器人，而是做一个：

- 能长期记住上下文
- 能绑定角色、世界书、预设、正则等运行时资产
- 能通过 Web 面板持续运维
- 能在本地、Linux 和 Docker 环境中稳定运行

它兼容 SillyTavern 常见角色资产形态，但运行时是独立的。你可以把它理解成：

> 一个偏工程化、偏长期运行、偏可运维的 QQ Tavern Runtime。

---

## 适合谁用

MimirLink 适合下面几类使用者：

1. 想把 QQ 群 / 私聊接入 Tavern 角色的人
2. 想让角色拥有长期记忆，而不是每次只靠短上下文的人
3. 想把角色、世界书、预设、正则、数据库等运行时资产统一管理的人
4. 想在服务器上长期挂着跑，而不是只在本机临时点开玩的人

---

## 功能概览

### 1. 长期记忆

- 使用 SQLite 持久化记忆
- 会话、摘要、人物档案、知识数据在重启后仍可保留
- 支持多种记忆作用域：
  - `user_persistent`
  - `group_user`
  - `group_shared`
  - `global_shared`

### 2. 角色运行时

- 导入并管理角色卡
- 绑定角色级数据库
- 按角色切换世界书 / 预设 / 正则
- 支持人物档案和知识增强

### 3. Web 控制面板

- 查看 OneBot 状态
- 查看当前角色 / 世界书 / 会话 / Token 消耗
- 管理角色、世界书、规则、知识、变量、TTS、日志
- 靶场测试 prompt、角色回复和优化链路

### 4. Prompt / 运行时资产管理

- 预设提示词管理
- 世界书管理
- 输入输出正则管理
- Prompt 运行时预览
- Prompt 靶场与优化师工作流

### 5. 工程化运行

- Windows 本地启动
- Linux 本地启动
- Docker 构建与运行
- Docker Compose 启动
- 配置文件驱动

---

## 目录结构

```text
MimirLink/
├─ public/                  # 前端面板
├─ src/                     # 后端源码
├─ data/                    # 数据目录（数据库、角色资产等）
├─ audio/                   # TTS 缓存音频
├─ logs/                    # 运行日志
├─ tests/                   # 测试
├─ config.example.json      # 示例配置
├─ package.json             # Node 项目定义
├─ start.bat                # Windows 启动脚本
├─ start.sh                 # Linux 启动脚本
├─ Dockerfile               # Docker 构建文件
└─ docker-compose.yml       # Docker Compose 运行文件
```

---

## 环境要求

### 本地运行

- Node.js 18 或更高版本
- npm 8 或更高版本
- 可访问的 OneBot / NapCat WebSocket 服务（如果你要接 QQ）
- 可访问的 OpenAI 兼容模型接口

### Docker 运行

- Docker Desktop / Docker Engine
- Docker Compose（Docker Desktop 自带即可）

---

## Windows 启动

### 方式 1：直接用脚本

双击：

```text
start.bat
```

脚本会做这些事：

- 检查 Node.js 是否存在
- 如果缺依赖则自动执行 `npm install`
- 如果没有 `config.json`，会从 `config.example.json` 复制一份
- 启动服务

### 方式 2：命令行启动

```bash
npm install
npm run start
```

---

## Linux 启动

先给脚本执行权限：

```bash
chmod +x start.sh
```

然后启动：

```bash
./start.sh
```

脚本会做这些事：

- 检查 Node.js
- 如果缺依赖则执行 `npm install`
- 如果缺 `config.json` 则复制示例配置
- 创建必要目录
- 启动服务

也可以直接手动启动：

```bash
npm install
npm run start
```

---

## Docker 构建

在项目根目录执行：

```bash
docker build -t mimirlink:latest .
```

说明：

- 基础镜像：`node:20-bookworm-slim`
- 容器内工作目录：`/app`
- 默认执行：`npm run start`

---

## Docker 运行

### 直接运行

```bash
docker run -d \
  --name mimirlink \
  -p 18001:18001 \
  -v $(pwd)/config.json:/app/config.json \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/logs:/app/logs \
  -v $(pwd)/audio:/app/audio \
  mimirlink:latest
```

如果你习惯面板默认走 8001，也可以把配置里的端口改成 8001，再映射成：

```bash
-p 8001:8001
```

---

## Docker Compose 启动

项目里已经提供：

```text
docker-compose.yml
```

启动：

```bash
docker compose up -d --build
```

停止：

```bash
docker compose down
```

查看日志：

```bash
docker compose logs -f
```

---

## 首次启动流程

第一次运行建议按这个顺序走：

1. 复制配置文件
2. 配好 OneBot 连接
3. 配好模型 API
4. 启动服务
5. 打开后台面板
6. 登录（如果开启认证）
7. 导入角色卡 / 世界书 / 预设 / 正则
8. 在靶场测试

如果本地没有 `config.json`，可以这样做：

```bash
cp config.example.json config.json
```

Windows 下也可以直接复制文件。

---

## 面板访问地址

实际访问地址取决于 `config.json`：

```json
"server": {
  "host": "0.0.0.0",
  "port": 18001
}
```

例如上面这种配置，面板地址就是：

```text
http://127.0.0.1:18001
```

如果部署在局域网服务器上，也可以通过：

```text
http://<服务器IP>:18001
```

访问。

---

## 配置文件说明

配置文件主入口：

```text
config.json
```

示例模板：

```text
config.example.json
```

下面是最关键的配置项。

### 1. 认证

```json
"auth": {
  "enabled": true,
  "username": "admin",
  "password": "your-password-here",
  "sessionSecret": "change-this",
  "sessionDays": 30,
  "shortSessionHours": 12,
  "sessionStorePath": "./data/sessions"
}
```

说明：

- `enabled`：是否启用登录验证
- `username` / `password`：后台登录账号密码
- `sessionSecret`：会话签名密钥，部署前必须改
- `sessionStorePath`：登录 session 文件存储目录

### 2. 服务监听

```json
"server": {
  "host": "0.0.0.0",
  "port": 18001,
  "healthLogIntervalMs": 60000,
  "trustProxy": true
}
```

说明：

- `host = 0.0.0.0`：允许所有网卡访问
- `port`：后台面板和 API 监听端口
- `trustProxy`：有反代时建议开启

### 3. OneBot

```json
"onebot": {
  "url": "ws://127.0.0.1:3001",
  "accessToken": "",
  "tokenMode": "header"
}
```

说明：

- `url`：NapCat / OneBot WebSocket 地址
- `accessToken`：鉴权 token
- `tokenMode`：通常是 `header`

### 4. AI 模型

```json
"ai": {
  "provider": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKey": "your-api-key-here",
  "model": "your-model-name",
  "maxTokens": 65535,
  "temperature": 1,
  "timeout": 60000
}
```

说明：

- `baseUrl`：OpenAI 兼容接口地址
- `apiKey`：模型密钥
- `model`：默认模型名
- `maxTokens`：最大输出长度
- `temperature`：采样温度
- `timeout`：请求超时（毫秒）

### 5. 聊天行为

```json
"chat": {
  "sessionMode": "user_persistent",
  "triggerMode": "auto",
  "requireAtInGroup": true,
  "historyLimit": 100,
  "splitMessage": true,
  "defaultCharacter": "你的角色名"
}
```

说明：

- `sessionMode`：记忆作用域
- `triggerMode`：触发模式
- `requireAtInGroup`：群里是否必须 @ 才响应
- `historyLimit`：保留多少条历史消息
- `splitMessage`：是否分段发送
- `defaultCharacter`：默认角色

### 6. 记忆

```json
"memory": {
  "storage": {
    "type": "sqlite",
    "path": "./data/chats/memory-store.sqlite"
  }
}
```

说明：

- 目前默认长期记忆存储是 SQLite
- `path` 决定默认数据库位置

### 7. TTS

```json
"tts": {
  "enabled": false,
  "provider": "doubao",
  "baseUrl": "",
  "apiKey": "your-api-key",
  "voiceId": "zh_female_xxx",
  "cacheDir": "./audio"
}
```

说明：

- `enabled`：是否启用语音
- `cacheDir`：缓存音频目录

---

## 记忆作用域说明

MimirLink 支持几种常用记忆模式。

### `user_persistent`

同一个用户在不同群和私聊里共享一份长期记忆。

适合：
- 想让角色长期记住某个用户

### `group_user`

同一个群里，每个用户有自己的独立记忆。

适合：
- 群聊里希望用户之间记忆隔离

### `group_shared`

整个群共用一份记忆。

适合：
- 群扮演 / 群长期剧情

### `global_shared`

所有来源共用一份记忆。

适合：
- 全局大一统测试环境

---

## 数据目录说明

### `data/`

主要运行数据目录。

常见内容：

- `data/chats/`：记忆数据库
- `data/characters/`：角色卡相关数据
- `data/worlds/`：世界书
- `data/sessions/`：认证 session

### `logs/`

运行日志目录。

### `audio/`

TTS 缓存目录。

---

## 角色 / 世界书 / 预设 / 正则

这些运行时资产通过后台导入和管理。

常见路径对应关系：

- 角色：角色面板
- 世界书：世界书面板
- 预设：预设面板
- 正则：规则编辑面板

如果你是从 SillyTavern 迁移：

- 角色卡可以直接导入
- 世界书可以导入兼容格式
- 预设可以导入 prompts 格式
- 正则可以导入兼容 JSON

---

## 靶场

靶场用于做 prompt 和角色回复测试。

支持：

- 切换模型
- 切换角色 / 世界书 / 预设
- 保存会话
- 自动记住上次使用的模型与配置
- 优化师工作流
- Prompt 分段预览

如果你主要在调角色卡、提示词或回复风格，建议直接在靶场完成。

---

## 常见问题

### 1. 页面能开，但 OneBot 显示未连接

检查：

- NapCat / OneBot 服务是否真的启动
- `config.json` 的 `onebot.url` 是否正确
- token 是否一致
- tokenMode 是否匹配

### 2. 页面打不开

检查：

- 进程是否启动成功
- 监听端口是否正确
- `server.host` / `server.port` 是否符合预期
- 防火墙是否放行

### 3. 登录不上

检查：

- `auth.enabled` 是否为 `true`
- 用户名密码是否正确
- `sessionSecret` 是否异常
- 浏览器 Cookie 是否被禁用

### 4. Docker 起不来

检查：

- Docker Desktop 是否正常启动
- Linux engine 是否可用
- 端口是否被占用
- `config.json` 是否挂载成功

### 5. 模型调用失败

检查：

- `ai.baseUrl`
- `ai.apiKey`
- `ai.model`
- 超时是否过短
- 上游接口是否真兼容 OpenAI 格式

---

## 推荐部署方式

### 本机测试

推荐：

```bash
npm install
npm run start
```

### Linux 常驻

推荐：

- `./start.sh`
- 或 systemd / pm2 托管

### Docker 部署

推荐：

```bash
docker compose up -d --build
```

---

## 安全建议

部署前至少做这几件事：

1. 改掉默认登录密码
2. 改掉 `sessionSecret`
3. 不要把真实 API Key 提交进 Git
4. 不要把本地聊天数据库、日志、缓存文件直接发出去
5. 如果开放公网，建议反向代理并加 HTTPS

---

## English

MimirLink is a QQ / OneBot-oriented Tavern runtime focused on persistent memory, role lifecycle management, and operational visibility.

It is designed for people who want a long-running, manageable runtime instead of a temporary chat bot process.

### Highlights

- Persistent SQLite-based memory
- Multiple memory scope modes
- Character / worldbook / preset / regex runtime management
- Admin web panel
- Linux startup support
- Docker and Docker Compose support
- OpenAI-compatible model integration

### Quick Start

```bash
npm install
npm run start
```

Linux:

```bash
chmod +x start.sh
./start.sh
```

Docker:

```bash
docker build -t mimirlink:latest .
docker run -d --name mimirlink -p 18001:18001 -v $(pwd)/config.json:/app/config.json -v $(pwd)/data:/app/data -v $(pwd)/logs:/app/logs -v $(pwd)/audio:/app/audio mimirlink:latest
```

Docker Compose:

```bash
docker compose up -d --build
```

### Main Config Areas

- `auth`: panel authentication
- `server`: host / port / proxy settings
- `onebot`: QQ bridge settings
- `ai`: model endpoint / key / timeout / token config
- `chat`: runtime chat behavior
- `memory`: persistent memory settings
- `tts`: speech synthesis settings

### Common Troubleshooting

- If the panel does not open, check host / port and firewall.
- If OneBot is disconnected, check the WebSocket endpoint and token.
- If login fails, verify `auth.enabled`, username, password, and cookies.
- If Docker fails, check Docker Desktop / Engine status and port conflicts.
- If model calls fail, verify endpoint compatibility and credentials.
