# Goal 2 任务拆分

## 执行规则
- 每个会话开始必须全量读取 `goal-2/input.md`、`goal-2/plan.md`、`goal-2/tasks.md`。
- 每轮只执行第一个未完成 task。
- 每完成三个 task，执行一次大型全面检查-debug循环，并把结果写入本文档。
- 每个 task 完成时必须记录：完成内容、验证结果、剩余风险、下一步。
- 修改代码后需要提交代码；若当前环境无法提交，需要记录阻塞原因。
- 结束 task 前必须基于实际检查、测试、diff、日志、类型检查、构建结果或截图证据确认质量。

## Tasks

### Task 1：全量分析聊天记录场景并建立人类思维验证基线
状态：已完成
目标：基于 xlsx 全量分析大场景和小场景，覆盖严肃技术讨论、群聊玩梗、喊 bot、emoji/低信息量、话题结束、冲突、资源/图片上下文、多用户快聊、bot 连续追击、戳一戳事件、引用 bot 但不 @ 等，并沉淀为后续提示词“人类思维适配”的验证基线。
独立验证：生成 `goal-2/chat-scene-analysis.md`，列出场景分类、代表样本、失败模式、期望的人类化行为，以及至少 8 个带消息头的可复用验证脚本。
完成内容：已用 OpenXML 只读解析 `D:\project\test\QQ-Tavern\fix523\group_贩子死妈公益站群_818554756_20260523_015734.xlsx` 的 `聊天记录` 工作表，统计 3409 条消息、130 个发送者、bot 300 条消息；生成 `goal-2/chat-scene-analysis.md`。文档覆盖严肃技术讨论、群聊玩梗、话题结束、低信息量/emoji、单独喊 bot、戳一戳/提醒、引用 bot 不 @、图片/语音资源、多用户快聊、LLM 关闭/队列滞后等场景，并沉淀 12 个必须带消息头的验证脚本。
验证结果：`goal-2/chat-scene-analysis.md` 已落盘，大小 13820 字节；`Select-String '^### Case '` 统计到 12 个验证脚本，超过独立验证要求的至少 8 个；解析统计显示引用消息 710 条、媒体/表情上下文 726 条、戳/拍/提醒文本 26 条、bot 高峰 2026-05-22 19 点 185 条，支撑后续提示词和触发链路修复。
剩余风险：xlsx 中只能看到“戳了三下”等文本讨论，未看到明确 OneBot poke 原始事件字段；这更可能是事件监听/导出/触发链路问题，需要后续代码定位确认。`goal-2` 当前为未跟踪目录，且工作区已有上一轮业务文件变更，本轮未提交，避免混入无关改动。
下一步：执行 Task 2，定位真实生效提示词链路，并把 `chat-scene-analysis.md` 中的消息头、引用、戳一戳、话题生命周期要求映射到实际 prompt builder 和触发逻辑。

### Task 2：定位真实生效提示词链路
状态：已完成
目标：找出徐缺当前运行时 prompt 的来源，包括角色卡、预设、绑定、override、prompt builder 拼装、护栏开关候选位置和前端 runtime preview；同时定位消息头、引用 bot 不 @、戳一戳、QQ 独有/动态 emoji 等上下文进入 prompt 前的链路；用 Task 1 的场景基线确认后续应该改哪里。
独立验证：列出真实生效文件/配置路径、关键字段、运行时预览入口、护栏开关现状、触发/消息段解析入口，确认后续应该改哪里。
完成内容：新增 `goal-2/prompt-chain-analysis.md`，定位真实聊天、runtime preview、prompt-range 靶场三条链路。确认最终 prompt 拼装点为 `src/prompt.js:870` `PromptBuilder.build()`；真实聊天入口为 `src/onebot.js` -> `src/index.js` -> `MessageRuntime` -> `processBatch()`；运行时预览入口为 `/api/runtime/prompt-preview`；靶场入口为 `runRangePromptTest()` 和 `/api/prompt-range/test`。同时定位到护栏硬注入、WS notice/poke 不上抛、引用 bot 不 @ 未作为触发、QQ face/mface/marketface 等消息段被丢弃等断点。
验证结果：`goal-2/prompt-chain-analysis.md` 已落盘，大小 10043 字节；关键项检索覆盖 `PromptBuilder.build`、`护栏`、`戳一戳`、`引用 bot`、`动态 emoji`、`runRangePromptTest`、`_handleMessage`。配置快照确认默认角色 `炸天帮徐缺（QQbot）`，有效 preset 层为 `legacy > imported_from_card`，绑定世界书为 `炸天帮徐缺（QQbot）_V5.json`，`attachMetadata=true`，context 全开。
剩余风险：本轮未改业务代码。`goal-2` 仍为未跟踪目录，且工作区已有上一轮 `public/index.html`、`src/mcp.js`、`src/routes.js` 变更；为避免混入无关改动未提交。后续实现时要注意 `src/routes.js` 已有未提交修改，修改前需重新读取相关片段并保留既有变更。
下一步：执行 Task 3，基于已定位的有效 preset 和 prompt builder，落地人味化提示词规则，同时把当前硬注入的输入护栏改为可配置开关，并补充测试覆盖。

### Task 3：设计并落地人味化提示词规则
状态：已完成
目标：从提示词入手，加入话题生命周期、停止条件、人类化判断、群聊短回复、梗降频、低信息量输入处理规则；提示词护栏只作为开关控制的附加注入，不强制常开。
独立验证：runtime preview 能看到人味化规则进入最终 prompt；护栏关闭时不注入护栏段，开启时才注入；不破坏角色基本人设。
完成内容：已在本地运行配置 `config.json` 的 legacy preset 中新增 `human-chat-control / 🧭人味化对话控制`，规则覆盖先读当前意图、同一梗降频、连续两轮后收束/换话题、睡觉/别回/换话题等停止条件、低信息量/emoji/QQ 动态表情短反应、严肃技术问题先答问题、引用消息只作上下文、群聊默认 1-3 句等。已在 `src/prompt.js` 中把原本硬注入的 `input_guardrail` 改成 `security.inputGuardrailEnabled === true` 才注入；`config.example.json` 新增默认关闭的 `security.inputGuardrailEnabled`。已在 `tests/prompt-preset.test.js` 增加护栏开关单测。
验证结果：`node --check .\src\prompt.js` 通过；`npm run check` 通过；`node --test .\tests\prompt-preset.test.js` 18/18 通过；结构化 runtime 验证显示 `hasHuman=true`、`hasTopicRule=true`、`humanSource=🧭人味化对话控制`、`hasGuardrail=false`，证明人味化规则进入最终 system prompt，且默认不注入输入护栏。`config.json` 和 `config.example.json` 均可 JSON.parse。
剩余风险：`config.json` 被 `.gitignore` 忽略且包含本地密钥类配置，不能提交；因此人味化 preset 当前是本机运行配置变更，不会随 git commit 分发。真实模型输出质量还未跑端到端，因为 Task 8 才安排靶场/MCP 联动测试；本轮只能确认 prompt 已进入最终构建链路。前端还没有开关按钮，当前只完成后端配置开关，UI 开关会在后续前端任务中补。
下一步：执行 Task 4，修改靶场前端显示输入全文与输出全文，方便后续用截图和 MCP/靶场联动验证 prompt 改动效果。

### 大型检查-debug循环 1（Task 1-3 后）
状态：已完成
检查项：需求是否偏离、提示词是否真实生效、是否过度削弱角色味、是否仍存在复读风险、是否需要调整测试脚本。
检查结果：需求未偏离：Task 1 已建立聊天记录场景基线，Task 2 已定位真实 prompt/触发链路，Task 3 只改提示词与护栏开关，没有处理用户明确说“3 不用管”的安全内容。提示词真实生效：runtime 构建检测到 `human-chat-control` 出现在最终 system prompt。角色味没有被直接删除：新增规则明确保留“徐缺可以自恋嘴欠”，只是限制被灵石/宝典/催债等旧梗绑架。复读风险仍需真实模型验证：目前规则能约束 prompt，但无法证明 deepseek-v4-pro 输出一定改善，需 Task 8 使用带消息头脚本复跑。测试脚本需要后续继续扩展到消息头、引用、戳一戳、QQ 动态表情；Task 3 仅覆盖护栏开关的单元行为。
修复记录：修复了 `input_guardrail` 原先无条件注入的问题，改成 `security.inputGuardrailEnabled` 控制；第一次测试失败暴露测试传入的 injectionRisk 结构不符合 `buildInputGuardrail()` 预期，已改为 `{ level, matchedRules }`；第二次测试失败暴露断言匹配 UI 标签而非实际正文，已改为匹配 `用户输入安全边界`，最终单测通过。
剩余风险：前端尚无安全护栏开关按钮；`config.json` 忽略导致本地人味化 preset 不在 git 差异里；端到端模型质量、UI 可观察性、备份/还原正则、戳一戳、引用 bot 不 @、QQ 动态表情仍在后续 task 覆盖。

### Task 4：靶场前端显示输入全文与输出全文
状态：未完成
目标：修改 `public/index.html`，让 observer card 和右侧 inspector 能清楚看到本轮输入和输出内容，支持长文本不撑爆布局。
独立验证：MCP 同步或单测后，截图里能看到输入、输出、错误输出；长文本可滚动/展开。
完成内容：
验证结果：
剩余风险：
下一步：

### Task 5：补充前端 trace/detail 的可诊断信息
状态：未完成
目标：让 trace/detail 中的步骤能展示输入摘要、输出摘要、模型/provider、错误信息，并避免只显示空摘要。
独立验证：MCP 失败和普通测试都能在右侧看到足够诊断信息。
完成内容：
验证结果：
剩余风险：
下一步：

### Task 6：定位备份/还原正则链路与复现问题
状态：未完成
目标：定位备份导出、恢复 inspect、恢复执行的后端代码和正则数据结构，复现或确认正则丢失/字段损坏问题。
独立验证：列出相关 API/函数/数据字段，给出最小复现路径或静态证据。
完成内容：
验证结果：
剩余风险：
下一步：

### 大型检查-debug循环 2（Task 4-6 后）
状态：未完成
检查项：前端是否展示清楚、脚本语法是否通过、MCP/单测/批测是否回归、备份/还原正则问题是否已定位、是否存在数据覆盖风险。
检查结果：
修复记录：
剩余风险：

### Task 7：修复备份/还原正则问题并验证
状态：未完成
目标：修复正则导出/恢复链路，保证关键字段和层级不丢失，优先用临时包或 inspect/dry-run 验证。
独立验证：导出前后/恢复前后正则数量与关键字段一致；不覆盖用户现有数据。
完成内容：
验证结果：
剩余风险：
下一步：

### Task 8：运行提示词与前端联动测试
状态：未完成
目标：跑至少 3 组测试用例，验证话题能释放、回复更像人类、前端可观察输入输出。
独立验证：记录请求、响应、截图路径、是否达到预期。
完成内容：
验证结果：
剩余风险：
下一步：

### Task 9：根据测试结果二次微调提示词
状态：未完成
目标：针对测试中仍然复读、太机械、太没徐缺味或太长的问题，做第二轮提示词修正。
独立验证：同一测试脚本复跑后有改善。
完成内容：
验证结果：
剩余风险：
下一步：

### Task 10：分析 ChatLuna 可吸收设计
状态：未完成
目标：分析 `https://github.com/ChatLunaLab/chatluna` 中可吸收的架构、消息抽象、上下文管理、平台适配、工具/插件、记忆或提示词组织方式，筛选能改善本项目 QQ 群聊人味化、事件感知、前端靶场和备份恢复的做法。
独立验证：输出分析记录，列出可吸收点、适配成本、风险、是否建议落地；只做分析，不直接引入依赖或复制代码。
完成内容：
验证结果：
剩余风险：
下一步：

### 大型检查-debug循环 3（最终）
状态：未完成
检查项：完成全部编号 Task 后，全面检查 C 端体验、提示词质量、安全边界、数据一致性、MCP/前端同步、备份/还原正则、测试闭环、回滚方案，并记录最终验证命令、截图路径、备份/还原验证结果、剩余风险。
检查结果：
修复记录：
剩余风险：

## Goal 完成记录
状态：未完成
最终总结：
最终验证：
最终剩余风险：
