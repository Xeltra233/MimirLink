# goal-5 tasks

## 执行规则

- 每轮只执行第一个未完成任务。
- 完成任务后在对应条目下记录：完成内容、验证结果、剩余风险、下一步。
- 每三个任务后执行一次大型全面检查-debug 循环。
- 涉及代码修改且仓库状态允许时，完成后提交代码；如 git safe.directory 或环境限制阻塞，需要记录原因。

## 任务列表

### [x] Task 1 - 审计现有群聊消息链路

目标：定位 OneBot 事件进入系统、processedInput 构造、引用/@/戳一戳/emoji 处理、session 写入、prompt build 的完整路径。

验证：输出涉及文件和关键函数清单，明确当前缺口。

记录：
- 完成内容：
  - 审计了 OneBot 入站到 prompt build 的主链路：
    - `src/onebot.js`：`handleHttpEvent()` / `_handleMessage()` 将 `message`、`notice`、`request` 统一 emit 到 `message` 事件；`getMessage()` 通过 OneBot `get_msg` 获取引用原消息。
    - `src/index.js`：`extractMessageInfo()` 解析文本、@、reply、face、mface、marketface、image、record、video、file、json、xml 等消息段，并生成 `plainText`、`structuredText`、`messageSegments`、`replyToBot`。
    - `src/index.js`：`buildStructuredMessage()` 已把群聊/私聊、QQ、昵称、群号、群名、时间、eventType、isAtBot、replyToBot、replyQuotedText、messageSegments 写入模型输入头。
    - `src/index.js`：`shouldRespond()` 和 `getTriggerReason()` 已支持 `replyToBot` 在群聊中不 @ 也触发，触发原因标记为 `reply_to_bot`。
    - `src/index.js`：`handlePokeEvent()` 已把戳一戳转换成结构化群聊输入 `（戳了戳你）`，并通过 `runtime.enqueue()` 进入同一批处理链路。
    - `src/runtime.js`：`MessageRuntime` 负责去重、短窗口聚合、按会话串行和全局并发限制。
    - `src/index.js`：`processBatch()` 合并 structuredText，经过正则输入处理、注入检测、session user 写入、memory recall、`promptBuilder.build()`、AI 调用、正则输出处理、变量桥接、assistant 写入和最终下发。
    - `src/prompt.js`：`buildSituationalContext()` 已注入会话事实、参与者、当前发言人画像、引用上下文、最近用户意图；`buildHumanChatControl()` 已存在通用群聊质量控制提示，并包含读取消息头、低信息量、戳一戳、表情、引用、话题释放等规则。
  - 关键缺口判断：
    - 现在是“结构化字符串 + 零散 runtimeContext 字段”，还没有统一的一等标准事件对象，后续难以稳定做 current-message-focus、前端观察和长上下文回归。
    - `replyToBot` 依赖 `get_msg` 成功获取被引用消息并判断 senderId 是否等于 bot selfId；获取失败时会退化为普通 reply，可能解释“引用 bot 但不 @ 偶发不回应”。
    - 戳一戳已进入 runtime，但只有 `eventType:poke` 和 `messageSegments`，缺少更完整的标准事件记录、冷却原因、触发/未触发观测，不利于前端判断“bot 是否感知到了”。
    - QQ emoji/动态 emoji 已转成 `[QQ表情]`、`[QQ动态表情]`、`[QQ大表情]`，但语义只来自 OneBot 段字段的 `name/summary/id`；如果上游没有 summary，只能给占位，不能真正理解动图含义。
    - `participants` 只有 `昵称(QQ)` 列表，结构化输入头有群号/群名，但 runtimeContext 里没有稳定的群身份对象；后续测试要求的“莫某（爱妻）qq号，群名字，群号”需要收敛为统一契约。
    - 已有 `human_chat_control_v2` 很宽泛且不提徐缺，适合保留为通用运行时控制；真正缺的是每轮根据最新输入生成的 current-message-focus 决策块，以及 prompt-range 对该决策块和 raw/clean/final 的观察。
- 验证结果：
  - 运行 `node --test tests/message-chain-source.test.js` 通过：3/3。
  - 该测试确认源码中已有非文本段保留、引用 bot 触发、戳一戳入 runtime 的保护。
  - 本任务未修改业务代码。
- 剩余风险：
  - 本轮是源码审计和源码级测试，没有启动 OneBot 或真实群聊端到端验证；`get_msg` 在实际 NapCat/OneBot 中的返回结构仍可能和代码假设有差异。
  - `message-chain-source.test.js` 偏源码字符串断言，不能证明运行时输入头、prompt 和最终回复一定符合预期。
  - 当前 git 状态显示父目录下有大量未跟踪目录，不能据此判断本任务产生的业务 diff；本轮只更新 goal 记录。
- 下一步：
  - Task 2 审计靶场与 MCP 同步观察链路，确认 `/api/prompt-range/test`、MCP `range_test`、sync-latest 和前端卡片到底能不能展示本轮链路中的输入头、messageTrace、reasoning、raw、clean、final。

### [x] Task 2 - 审计现有靶场与 MCP 同步观察链路

目标：定位 `/api/prompt-range/test`、MCP `range_test`、sync-latest、前端 range-test-chat 展示方式、messageTrace/reasoningContent/raw/clean/final 当前可用字段。

验证：输出接口字段矩阵和前端展示缺口。

记录：
- 完成内容：
  - 审计了靶场单测接口、MCP `range_test`、sync-latest 持久回填和前端观察板。
  - 后端 `/api/prompt-range/test`：
    - 入口：`src/routes.js` 的 `runRangePromptTest()`，接收 `userMessage`、`characterName`、`messageType`、`groupId`、`userId`、`modelProviderId`、`model`、`worldbookName`、`presetId`、`context.recentMessages`、`contextConfig`、`injectVariables`、`injectProfiles`。
    - 模型配置：`resolveRangeModelSelection()` 默认走配置页 `chat.modelProviderId/chat.model` 和 `ai.providers[].baseUrl/apiKey`，缺 Base URL 或 Key 会在 `assertRangeAIReady()` fail-fast。
    - 返回字段：`success`、`character`、`worldBook`、`segments`、`stats`、`bindingTrace`、`aiResponse`、`promptConfigSnapshot`、`contextConfig`、`trace`。
    - `aiResponse` 已包含 `text`、`reasoningContent`、`rawReasoningContent`、`rawContent`、`rawMessage`、`rawResponse`、`rawResponseText`、`usage`、`segments`、`segmentCount`、`splitConfig`。
    - `trace.steps` 已覆盖 `input`、`memory-recall`、`prompt-build`、`variable-inject`、`profile-inject`、`ai-request`、`ai-response`、`qq-split`，每步有 `summary/details/status/durationMs`。
  - MCP `range_test`：
    - 入口：`src/mcp.js` 的 `range_test.handler()`，支持 `message`、`characterName`、`modelProviderId`、`model`、`fakeHistory`、`scopeKey`、`presetFilePath`、`disableAssistantPrefill`。
    - 模型配置：`resolveMcpRangeModelOverrides()` 也走配置页 provider 和 key，不应硬编码 key。
    - 返回给 MCP 调用方：JSON 文本，含 `reply`、`tokenUsage`、`fakeHistoryCount`、`variablesApplied`、`replyAttempts`、`presetOverride`、`promptMessageCount`、`reasoningContent`、`disableAssistantPrefill`、`messageTrace`。
    - 同步给前端：`publishRangeSyncPayload()` 写入 `config.__rangeSyncLatest` 和磁盘 `range-sync-history.json`，payload 含 `userMessage`、`characterName`、`modelProviderId`、`model`、`reply`、`reasoningContent`、`fakeHistoryCount`、`variablesApplied`、`tokenUsage`、`replyAttempts`、`presetOverride`、`disableAssistantPrefill`、`messageTrace`、`trace`、`messages`。
  - sync-latest：
    - `GET /api/prompt-range/sync-latest?limit=N` 从内存和 `range-sync-history.json` 合并历史，返回 `latest` 与 `history`，上限 50。
    - 这能支持“调用 MCP 中途/之后打开靶场仍能回填”，不是只靠页面实时状态。
  - 前端 `public/index.html`：
    - `loadLatestRangeSyncSnapshot()` 会请求 `/api/prompt-range/sync-latest?limit=20` 并逐条 `applyRangeSyncPayload()`。
    - `applyRangeSyncPayload()` 会向 `range-test-chat` 追加用户气泡和 bot 气泡，并写入 `rangeSyncResults` 与 `rangeIterState.lastResult`。
    - `renderRangeObserverBoard()` 已有观察板，单测、MCP 同步、批测都会生成卡片；MCP 链路在“MCP 上下文链” lane 中按接收顺序追加。
    - `renderRangeTraceDetail()` 能显示选中节点的输入/输出全文、诊断项和 `step.details`。
  - 字段矩阵与缺口：
    - 输入头：后端单测只把 `userMessage` 原样作为 `normalizedMessage`；如果用户手动输入没有群名/群号/昵称/QQ，靶场不会自动补标准事件头。
    - fakeHistory：单测可通过 `context.recentMessages` 参与 prompt；MCP 可通过 `fakeHistory` 参与 prompt；但前端观察卡只显示当前输入/输出，不把 fakeHistory 独立成“上下文轮次卡片”。
    - messageTrace：MCP 同步 payload 有 `messageTrace`；单测接口的主返回没有顶层 `messageTrace`，只通过 `segments` 和 `trace.details` 间接观察 prompt 组成，无法逐条查看最终 `built.messages` 的来源和内容。
    - reasoningContent：单测 `aiResponse.reasoningContent` 和 MCP payload 都有；聊天气泡以折叠 `<details>` 展示，观察板详情只显示推理长度/preview，不展示完整 reasoning 分栏。
    - rawReply / cleanedReply / finalReply：单测有 `rawContent/rawMessage/rawResponse/rawResponseText` 和 `aiResponse.text`，但字段没有命名成 raw/clean/final 三段；MCP 同步只有清洗后的 `reply`，没有 rawReply/cleanedReply/finalReply 分层。
    - regex trace：单测和 MCP 目前没有正则处理 trace；MCP `sanitizeMcpRangeReply()` 只做内部标签剥离，未记录剥离前后差异；单测 `stripInternalTags()` 也没有形成可视化 regex/clean trace。
    - 最终发群内容：单测有 `aiResponse.segments[].qqText` 和 `splitConfig`，能看 QQ 分段和 @ 前缀；MCP payload 只有 `reply`，没有等价的 final QQ segment 预览。
    - 前端可观察性：已从“单张长卡”进化为观察板卡片，但详情区仍主要是 input/output + step details；缺少固定 Tabs/分栏：输入头、fakeHistory、Prompt Messages、Reasoning、Raw、Clean、Final、Regex。
- 验证结果：
  - 运行 `node --test tests/preset-routes.test.js --test-name-pattern "prompt range"` 通过：31/31。
  - 测试覆盖了配置页 provider/baseUrl/apiKey 调用、provider 请求失败 trace、缺 Key fail-fast、agent-chat provider 解析、models 不泄露 key、sync-latest 内存和磁盘回填。
  - 本任务未修改业务代码，只更新 goal 记录。
- 剩余风险：
  - 本轮没有启动浏览器截图，因为 Task 2 是审计任务，前端截图验证留到 Task 9/14。
  - 没有真实调用外部模型；测试用 mock fetch 证明字段和配置链路，不能评估真实 reasoning 输出完整性。
  - 单测接口直接 fetch OpenAI-compatible `/chat/completions`，而 MCP 走 `aiClient.chat()`；两者字段处理存在差异，后续增强字段时需要统一契约。
- 下一步：
  - Task 3 审计备份/还原正则链路，定位正则配置、绑定层、导出和恢复之间的缺口；完成后进入 CHECK 1。

### [x] Task 3 - 审计备份/还原正则链路

目标：定位正则配置存储、导出、恢复、绑定关系，确认用户报告的正则备份/还原问题可能发生在哪。

验证：输出最小复现计划和待修文件清单，不修改代码。

记录：
- 完成内容：
  - 审计了正则运行时来源、导入/导出、备份/检测/恢复、前端备份恢复选择链路。
  - 正则运行时来源：
    - `src/regex.js` 的 `RegexProcessor.updateConfig(config, bindingRules, presetBindingRules, globalBindingRules)` 合并顺序为：内置 presetRules、全局层、预设层、角色层，最后追加内置 `<thinking>` 清理规则。
    - `src/prompt.js` 的 `PromptBuilder.getRegexResolution()` 分三类解析：`globalRegexRules`、`presetRegexRules`、`regexRules`。角色显式绑定优先于角色卡导入，预设层由 legacy/global/imported_from_card/character_binding 合并。
    - `src/routes.js` 的 `applyRuntimeConfig()` 会取当前角色 `PromptBuilder.getEffectiveBinding()`，再把三层规则传给 `regexProcessor.updateConfig()`，恢复或导入后应即时生效。
  - 正则导入/导出：
    - `POST /api/regex/import` 通过 `RegexProcessor.importRules()` 兼容 `rules`、`regex`、`regex_scripts`、`extensions.regex_scripts`、`extensions.SPreset.RegexBinding.regexes` 等格式。
    - 导入目标层由 `targetLayer` 决定：`global` 写 `config.bindings.global.regexRules`，`preset` 写 `config.preset.regexRules`，`character` 写当前默认角色 binding 的 `regexRules`。
    - 导入记录写入 `config.imports.regexFiles`，包含 `id/filename/targetLayer/importedRules`，用于删除导入记录时成组移除。
    - `GET /api/regex/export` 从当前 `regexProcessor.getRules()` 导出，保留 `stage/promptOnly/markdownOnly/minDepth/maxDepth` 等运行元数据；但这是“当前有效规则”的导出，不等同完整分层备份。
  - 正则备份：
    - `GET /api/config/backup?categories=regex` 会写入 `data/_regex_rules_snapshot.json`，快照由 `buildRegexBackupSnapshot()` 生成。
    - 快照包含：legacy `config.regex`、`config.preset.regexRules`、`bindings.global.regexRules`、`bindings.global.preset.regexRules`、每个角色的 `regexRules`、`preset.regexRules`、`importedFromCard.regexRules`、以及 `imports.regexFiles`。
    - 同时会把 `config.imports.regexFiles` 中的导入记录写到 `data/_regex_imports/` 和 `_manifest.json`。
  - 正则恢复：
    - `POST /api/config/restore?categories=regex` 优先读取 `_regex_rules_snapshot.json` 并调用 `applyRegexBackupSnapshot()`，这是最完整路径。
    - 如果没有快照但选择了 `config`，会从备份中的 `config.json` 重新构造快照。
    - 如果只有 `_regex_imports` 且没有快照，会尝试把导入记录的 `importedRules` 合并回目标层；角色层导入记录缺少 `characterName` 时会跳过，避免误恢复到当前角色。
    - 恢复后会 `saveConfig(config)` 和 `applyRuntimeConfig()`，理论上无需重启。
  - 前端链路：
    - 备份弹窗 `BACKUP_CATS` 包含 `regex`，默认勾选；恢复前 `inspectRestoreFile()` 调 `/api/config/backup/inspect`，检测到 `_regex_rules_snapshot.json`、`_regex_imports` 或 config 内正则数据时会展示“正则规则”复选项。
    - 恢复前会提示自动备份当前状态到 `data/restore-backups/`。
  - 最小复现计划：
    - 构造一个含 legacy/global/global preset/character/character preset/card imported regex 的配置。
    - 导出 `categories=regex`。
    - 手动污染各层规则，并改动 worldbook/memoryDbPath 等非正则绑定。
    - 恢复 `categories=regex`。
    - 断言所有正则层恢复，非正则绑定不被覆盖，`imports.regexFiles` 恢复，`PromptBuilder.getEffectiveBinding()` 与 `regexProcessor.updateConfig()` 能看到恢复后的三层规则。
  - 待修文件清单：
    - `src/routes.js`：Task 13 若继续修复，应重点补旧格式/导入记录恢复兼容、角色层导入记录目标角色信息、恢复变更报告更细化。
    - `src/regex.js`：若要做 regex trace，需要让 `process()` 返回应用规则列表或新增 trace 版本，供靶场 raw/clean/final 观察。
    - `public/index.html`：恢复 UI 后续可显示正则快照摘要和每层数量，降低用户误选风险。
    - `tests/preset-routes.test.js`：已有核心测试，后续可补“旧备份无快照仅有导入记录”和“角色层导入记录带 characterName 恢复”。
- 验证结果：
  - 运行 `node --test tests/preset-routes.test.js --test-name-pattern "regex|backup"` 通过：31/31。
  - 现有测试已覆盖正则导入层级不覆盖角色规则、导入诊断、导入记录删除、promptOnly/markdownOnly/depth 行为、导出元数据、regex-only 备份恢复所有运行时正则层且不覆盖无关绑定。
  - 本任务未修改业务代码，只更新 goal 记录。
- 剩余风险：
  - 当前“regex-only backup”测试覆盖新格式快照；旧备份如果没有 `_regex_rules_snapshot.json`，只能从 `config.json` 或 `_regex_imports` 尽量恢复，完整性低于新快照。
  - `_regex_imports` fallback 对 `targetLayer=character` 且缺 `characterName` 的导入记录会跳过，这是安全选择，但用户会感觉“角色层正则没恢复”。
  - `applyRegexBackupSnapshot()` 只遍历快照内出现的角色，不会删除当前配置中快照外角色的正则；这是避免误删用户新数据，但“完全回滚到备份状态”语义不成立。
  - 备份恢复链路仍缺浏览器级验证，留到 Task 14。
- 下一步：
  - CHECK 1：对 Task 1-3 做大型全面检查-debug 循环，确认审计是否偏离需求、是否需要调整后续实现任务。

### [x] CHECK 1 - 大型全面检查-debug 循环

检查范围：需求是否偏离、链路审计是否完整、是否存在高风险误判、是否需要调整后续任务。

记录：
- 检查内容：
  - 复核 Task 1-3 是否仍对齐 goal-5 主目标：群聊事件标准化、current-message-focus、靶场可观察性、正则备份/恢复。
  - 复核已有链路是否足够进入 Task 4-6：OneBot 入站、structuredText、replyToBot、poke、emoji 占位、prompt-range/MCP 字段、regex 运行时分层。
  - 复核测试证据是否覆盖关键风险：事件转发、消息链路源码保护、prompt-range provider/key、sync-latest、regex backup/restore。
  - 静态检查核心入口文件语法：`src/index.js`、`src/routes.js`、`src/mcp.js`。
- 发现问题：
  - Task 1-3 没有偏离需求；审计结论一致指向同一个结构性缺口：目前数据以“结构化字符串 + 零散字段 + 前端局部展示”存在，缺统一标准事件契约。
  - 后续 Task 4 必须先定义标准事件对象，不能只继续扩 `buildStructuredMessage()` 字符串，否则 Task 6 的 current-message-focus 和 Task 8/9 的观察字段会继续重复解析字符串。
  - Task 5 的“引用 bot/戳一戳”不能只看是否触发，还要记录未触发原因，例如 `get_msg` 失败、poke 冷却、目标不是 bot、空 plainText 被跳过。
  - Task 8/9 需要同时统一 `/api/prompt-range/test` 与 MCP `range_test` 的字段命名；否则前端需要两套解析逻辑，容易继续出现“我中途打开靶场是空的/看不懂上下文”。
  - 正则备份/恢复当前新格式基本可用，Task 13 不应大改现有备份策略，应集中补旧格式兼容、角色层导入记录目标角色、恢复报告和 regex trace。
  - 测试选择问题：`chat-runtime-preview.test.js` 使用 `--test-name-pattern` 仍跑到了多项 AI client 用例并超时；这次不能作为当前审计失败证据，只记录为后续测试命令需要更精确拆分。
- 修正动作：
  - 不改代码；本轮只调整后续实现约束：
    - Task 4 实现标准事件对象时必须保留原 `processedInput/structuredText` 兼容路径。
    - Task 4/5 测试要从源码字符串断言升级为行为测试，覆盖文本、@、引用、replyToBot、face/mface/marketface、poke。
    - Task 6 的 current-message-focus 应基于标准事件对象构造，而不是二次正则解析 prompt 字符串。
    - Task 8/9 的字段契约要固定为输入头、fakeHistory、prompt messages/messageTrace、reasoning、raw、clean、final、regex trace。
- 验证结果：
  - `node --test tests/onebot-events.test.js tests/message-chain-source.test.js` 通过：5/5。
  - `node --test tests/preset-routes.test.js --test-name-pattern "prompt range|regex|backup|human chat control"` 通过：31/31。
  - `node --check src/index.js` 通过。
  - `node --check src/routes.js` 通过。
  - `node --check src/mcp.js` 通过。
  - `node --test tests/chat-runtime-preview.test.js --test-name-pattern ...` 两次均超时且跑到非目标 AI client 用例；已记录为测试选择问题，不作为本轮回归失败。

### [x] Task 4 - 实现 QQ 群聊事件标准化结构

目标：新增或扩展事件标准化函数，生成可读输入头，覆盖群名/群号/昵称/QQ/@/引用/戳一戳/emoji/动态 emoji 占位。

验证：新增行为测试，确保原文本消息兼容。

记录：
- 完成内容：
  - 新增 `src/standard-event.js`，提供 `buildStandardEvent()` 与 `formatStandardEventHeader()`，形成一等化 QQ/OneBot 标准事件对象：
    - `version/eventType/messageType/messageId/time`
    - `group.id/group.name`
    - `sender.id/sender.name/sender.card/sender.nickname`
    - `bot.selfId/bot.isAtBot`
    - `reply.messageId/reply.toBot/reply.senderId/reply.senderName/reply.quotedText`
    - `segments[].readableText`
    - `rawText/contentText/inputHeader/inputText`
  - 标准事件可读输入头覆盖：群聊/私聊、QQ、昵称、群号、群名、eventType、isAtBot、replyToBot、replyMessageId、replyQuotedText、消息段摘要。
  - 消息段摘要覆盖文本、@bot/@某人、引用、QQ 表情、QQ 动态表情 `mface`、QQ 大表情 `marketface`、图片、语音、视频、文件、JSON/XML、戳一戳。
  - 在 `src/index.js` 的 `extractMessageInfo()` 中生成并返回 `standardEvent`，同时保留现有 `structuredText` 兼容路径；`config.chat.attachMetadata === false` 仍只使用原 promptText，不强制启用新头。
  - 在 `handlePokeEvent()` 中为戳一戳 notice 构造 `pokeEvent` 和 `standardEvent`，并随 runtime item 入队。
  - 在 `processBatch()` 的 `runtimeContext` 与 user message metadata 中记录 `standardEvents` 和 `primaryStandardEvent`，供后续 current-message-focus、靶场观察和长上下文报告直接消费，不再反解析字符串。
  - 更新 `tests/message-chain-source.test.js` 的 poke 源码保护断言，使其检查 `pokeSegments` 复用和 `standardEvent` 入队。
  - 新增 `tests/standard-event.test.js` 行为测试，覆盖群名/群号/昵称/QQ/@bot/动态表情、引用 bot 但不 @、戳一戳、私聊头格式。
- 验证结果：
  - `node --test tests\onebot-events.test.js tests\message-chain-source.test.js tests\standard-event.test.js` 通过：9/9。
  - `node --test tests\standard-event.test.js` 通过：4/4。
  - `node --check src\index.js` 通过。
  - `node --check src\standard-event.js` 通过。
  - `git status --short` 已检查：工作区存在大量此前未提交/未跟踪文件，包含 `AGENTS.md`、`public/index.html`、`src/ai.js`、`src/index.js`、`src/mcp.js`、`src/onebot.js`、`src/prompt.js`、`src/routes.js`、多个 goal 目录和测试文件。本轮没有执行 git commit，避免把非 Task 4 改动混入提交。
- 剩余风险：
  - 标准事件对象已进入 runtimeContext 和 session metadata，但模型实际输入仍主要使用旧 `structuredText`；这是有意的兼容策略，真正基于标准事件的决策块留给 Task 6。
  - `src/index.js` 中存在前序任务产生但未提交的修改，本轮只在其上追加标准事件接入；后续提交前需要按任务边界拆分或统一整理。
  - QQ 动态表情仍依赖 OneBot/NapCat 上游提供 `summary/name/text/display_name/id`；若上游只给不可读 id，只能稳定展示占位，不能视觉识别动图语义。
  - 本轮没有真实 OneBot 端到端测试；验证范围是行为单测、源码保护测试和语法检查。
- 下一步：
  - Task 5 接入引用 bot 与戳一戳触发策略：在现有 `replyToBot`/poke 基础上补触发观测和失败原因，重点检查 `get_msg` 失败、目标不是 bot、poke 冷却、普通引用不误触发。

### [x] Task 5 - 定位徐缺当前生效提示词链路

目标：找出徐缺当前实际吃到的角色卡、世界书、预设、运行时群聊控制、正则层和靶场/真实聊天之间的关系，判断最该改哪一层。

验证：输出链路清单、关键文件位置、影响聊天质量的高风险提示词片段、优先修复点；不修改业务代码。

记录：
- 完成内容：
  - 按最新优先级重排了 Task 5 之后的任务：先徐缺提示词链路定位、小样本基线、提示词调整和聊天质量检查，再回到引用/戳一戳、current-message-focus、靶场观察、10x20 长上下文、正则备份恢复。
  - 读取并确认当前徐缺生效配置：
    - 默认角色：`炸天帮徐缺（QQbot）`
    - 当前聊天模型走配置页 provider/model，不硬编码 key。
    - `humanChatControlEnabled=true`，`attachMetadata=true`，`historyLimit=100`。
    - 绑定世界书：`data/worlds/炸天帮徐缺（QQbot）_V5.json`。
    - 显式角色 preset 为 `null`，但角色卡导入 preset 存在 2 条；全局 `config.preset.prompts` 存在 33 条并主导生效。
  - 确认 preset 合并顺序来自 `PromptBuilder.getPresetResolution()`：`config.preset` -> `bindings.global.preset` -> `imported_from_card` -> `character_binding`。当前实际为 `legacy:config.preset -> imported_from_card`。
  - 确认 prompt 拼装顺序：运行时 `human_chat_control_v2` 在前，随后是 preset、角色卡字段、世界书、历史、当前输入、assistant prefill；因此运行时规则会被后续徐缺世界书和 preset 强风格素材稀释。
  - 定位当前质量矛盾：
    - `human_chat_control_v2` 已经包含正确方向：先接住人、释放旧梗、低信息短反应、限制“懂？”和“灵石/收费”等旧梗。
    - 但世界书和部分 preset 仍反复强调“每条必须徐缺味”“留钩子”“语料库”“灵石/收费/入帮费/懂？”等素材，容易压过人类聊天质量。
    - COT/输出格式条目仍给模型“先分析/写作/变量更新”的压力，可能让群聊回复不够自然。
  - 新增分析文档：`goal-5/xuque-prompt-chain-analysis.md`，记录生效链路、冲突点、优先修复层和 Task 6/7 建议。
- 验证结果：
  - 通过 PowerShell 读取 `config.json`、`data/worlds/炸天帮徐缺（QQbot）_V5.json`、`src/prompt.js`、`src/index.js`，确认配置、绑定、合并顺序和 prompt 拼装顺序。
  - 通过 `rg` 搜索 `getEffectiveBinding/getPresetResolution/buildRuntimeComposition/human_chat_control_v2` 等入口，确认关键代码路径。
  - 本任务没有修改业务代码，只更新 goal 文档和任务顺序。
- 剩余风险：
  - 本任务是链路定位，没有调用模型重测，不能证明改动后的聊天质量提升。
  - `config.json` 含大量用户配置，后续 Task 7 修改必须精确 patch，不能格式化整文件、不能碰 key、不能改模型/端口等生产配置。
  - 世界书强风格素材很多，单改 preset 未必完全压住旧梗，需要 Task 6 小样本基线和 Task 7 复测验证。
  - 当前工作区已有大量历史未提交改动，本轮未 commit，避免混入非本任务内容。
- 下一步：
  - Task 6 建立徐缺小样本水群基线：用 8-12 条真实 QQ 群聊风格输入测试当前回复，记录输入、回复、问题标签和评分，为 Task 7 精准改提示词提供证据。

### [x] Task 6 - 建立徐缺小样本水群基线

目标：构建 8-12 条真实群聊风格测试输入，覆盖“懂？”复读、灵石旧梗黏连、低信息、emoji、喊 bot 出群聊、被用户打断、换话题、人类正反馈。

验证：调用现有靶场/本地接口生成 JSON 报告，包含输入、回复、问题标签、评分和初步结论；不使用专业问答语料。

记录：
- 完成内容：
  - 新增并执行 `goal-5/run-xuque-small-baseline.mjs`，通过本地 MCP `range_test` 调用当前配置页 provider/model，不硬编码 key。
  - 构建 10 条 QQ 群聊风格样本，全部带群名、群号、昵称、QQ、eventType、isAtBot/replyToBot 等输入头。
  - 覆盖场景：
    - 下班疲惫需要正反馈。
    - 用户明确要求停止灵石旧梗。
    - 用户点名不要“懂？”式收尾。
    - 单问号低信息。
    - QQ 动态表情低信息。
    - 只喊“徐缺，出来一下”。
    - 用户小成果需要具体正反馈。
    - 从收费旧梗切到奶茶/懒得下楼。
    - 引用 bot 但不 @。
    - 用户反馈“别开演，像正常群友一样给反馈”。
  - runner 对每轮记录 `index/scenarioId/input/fakeHistory/reply/score/problemTags/analysisNotes/promptMessageCount/replyAttempts/reasoningContent/durationMs`，并增量写入报告，避免中途失败丢数据。
- 验证结果：
  - 启动本地 `node src/index.js` 后执行 `node goal-5\run-xuque-small-baseline.mjs` 成功。
  - 10/10 轮拿到回复，失败 0，空回复 0。
  - 汇总分数：平均 95，最低 82，最高 100。
  - 自动问题标签：`missed_current_signal` 2 次，`question_as_crutch` 2 次，`good_reply` 6 次。
  - `node --check goal-5\run-xuque-small-baseline.mjs` 通过。
  - 服务执行后已停止，`8001` 只剩 `TIME_WAIT`，未留下后台进程。
  - 人工复核结论：
    - 灵石/收费旧梗在本批样本中释放明显改善，用户要求停止时能收住。
    - “懂？”没有继续复读，但“以后少用这个字”没有明确接住“偷懒感”，属于承接不足。
    - 低信息问号仍倾向反问顶回去：“让本帮主帮你想话题？”，容易显得不提供正反馈。
    - 只喊名字场景能回应，但“大半夜的叫魂呢？”仍偏攻击式反问。
    - 换话题到奶茶时没有接住“想喝奶茶但懒得下楼”，滑到“御剑术送外卖”的修仙梗，说明旧角色表达仍会压过当前话题。
    - 用户要求正常反馈时能明显降角色表演，说明当前模型和基础链路不是完全不可救，Task 7 应做更精确的提示词压制和接话策略。
- 报告路径：
  - `goal-5/xuque-small-baseline.json`
- 剩余风险：
  - 这是 10 条小样本，不等同 10x20 长上下文轮回；不能证明长上下文中“懂？”、灵石、收费不会复燃。
  - 自动评分规则偏乐观，只能作为筛选信号；Task 7/13 仍需要人工质量维度和更长上下文验证。
  - MCP `range_test` 与真实 QQ 群聊入口仍有差异，尤其真实群聊的历史、聚合窗口、回复触发和正则后处理可能改变最终体验。
  - 本轮新增的是 goal 脚本和报告，不改业务代码；当前工作区已有大量历史未跟踪/未提交文件，本轮未执行 git commit，避免混入非 Task 6 内容。
- 下一步：
  - Task 7 基于 Task 5/6 证据调整徐缺最直接生效的提示词或预设：重点压低反问偷懒、攻击式接话、修仙梗抢话题；保留当前已经有效的旧梗释放和正常反馈能力。

### [x] Task 7 - 调整徐缺群聊提示词或生效预设

目标：在 Task 5/6 证据基础上改最直接生效的一层，减少固定口癖复读、释放旧话题、增强人类正反馈、短句群聊节奏、自然接话点。

验证：prompt 预览和小样本对比；确认不是只更像同人，而是聊天质量变好。

记录：
- 完成内容：
  - 定点修改 `config.json -> preset.prompts` 中当前全局生效的徐缺群聊 preset，没有改 provider/key/model/port/绑定世界书。
  - 修改条目：
    - `✅ 炸天帮徐缺 QQBot`：新增“先像群友一样接住当前这句话，再轻带徐缺味”。
    - `🧠人格引擎`：把“每一句话必须有人设烙印”收敛为“先是群里接话的人，人设是调味”，并禁止把用户新话题硬拐成修仙、灵石、收费或装逼值。
    - `🧭人味化对话控制`：新增明确优先级“当前用户的新信息 > 正反馈/接话 > 现实回应 > 轻量徐缺味 > 旧梗”；补充低信息、召唤类、换话题、昵称误读规则。
    - `♻️防打断`：限制“猜你心思”等反问偷懒，要求用户停旧梗时下一句不要复述旧词，召唤类消息用“在/说吧/啥事”自然接住。
    - `⬇️尾部规则`：新增召唤类消息不要旧梗抢话、用户要求停旧梗时不复述、旧梗只能在主动点到且未要求停止时使用。
  - 中途复测发现两次问题并做小范围修正：
    - 第一次复测：`switch-topic` 仍复述“收费”，低信息/召唤仍反问。
    - 第二次复测：`call-bot-out-of-group` 被昵称“爱妻”和旧素材带到“仙子/灵石”。
    - 最终补了召唤类硬规则和昵称误读规则，没有扩大到世界书或模型配置。
- 验证结果：
  - `node -e "JSON.parse(...config.json...)"` 通过，确认配置 JSON 可解析。
  - 抽查 `config.preset.prompts[0/4/8/14/31]` 内容，确认目标规则已写入。
  - `node --check goal-5\run-xuque-small-baseline.mjs` 通过。
  - 使用同一批 Task 6 的 10 条小样本跑最终复测：10/10 成功，失败 0，空回复 0，平均分从 95 提升到 98，最低分 82。
  - 最终复测报告：`goal-5/xuque-small-baseline-after-task7-final.json`。
  - 前后对比报告：`goal-5/xuque-small-baseline-task7-comparison.json`。
  - 关键人工复核：
    - 下班疲惫：从“脑子放空聊啥都行”变为“辛苦了，歇着聊吧”，正反馈更像人。
    - “别再懂？”：从“以后少用这个字”变为“这词以后少用”，更直接承接用户反馈。
    - 召唤类：从“大半夜的叫魂呢？”最终变为“在，说吧，啥事。”，修掉攻击式反问和旧梗抢话。
    - 换话题奶茶：从“御剑术送外卖”变为直接接“奶茶/懒得动”，没有再提收费和灵石。
    - 引用 bot 不 @：仍能聚焦用户新问题，给出“先改数据结构”这类明确建议。
  - 服务复测后已停止，`8001` 仅剩 `TIME_WAIT` 连接，无后台进程遗留。
  - `config.json` 被 `.gitignore` 忽略且不是 git 跟踪文件，无法用 git diff/status 记录该文件变更；已用 JSON 解析、内容抽查和模型复测作为证据。
- 剩余风险：
  - 单问号低信息仍有反问残留，最终回复是“想请本帮主讲两句？”，比原先“让本帮主帮你想话题？”轻一些，但仍不是最理想的自然接话。
  - 本轮是 10 条小样本，不能证明 10x20 长上下文里旧梗不会复燃；需要后续长上下文测试继续验证。
  - 世界书仍包含强徐缺味和旧梗素材，单靠 preset 压制有概率在长历史或高温下被冲淡。
  - 由于 `config.json` 不在 git 跟踪内，本任务没有代码提交；需要依赖本地配置文件实际内容。
- 下一步：
  - CHECK 2 对徐缺聊天质量做大型检查-debug 循环：重点确认是否只是小样本过拟合、是否仍有反问偷懒、旧梗黏连、过度规则化，以及是否需要再把通用规则抽到运行时 current-message-focus。

### [x] CHECK 2 - 徐缺聊天质量大型检查-debug 循环

检查范围：聊天质量是否实际改变、是否只是更贴同人而牺牲聊天质量、是否仍有旧梗黏连、是否出现过度规则化、是否需要回滚提示词。

记录：
- 检查内容：
  - 对比 Task 6 原始基线与 Task 7 最终复测，确认徐缺聊天质量是否真实改善。
  - 检查范围覆盖：旧梗黏连、`懂？` 复读、低信息反问、召唤类、换话题、引用 bot 不 @、正反馈、人设压过当前话题、过度规则化。
  - 检查配置风险：确认 `config.json` 仍走当前配置页 provider/model，`humanChatControlEnabled=true`，默认角色仍是 `炸天帮徐缺（QQbot）`，世界书绑定仍是 `炸天帮徐缺（QQbot）_V5.json`。
  - 新增审查报告：`goal-5/check2-xuque-quality-review.md`。
- 发现问题：
  - 真实改善成立，不只是更贴同人：下班疲惫、召唤类、换话题和 `懂？` 停止场景均比原始基线更接当前人和事。
  - 最终复测 10 条中没有旧灵石/收费/御剑/仙子/爱妻昵称误读进入最终回复，旧梗黏连明显下降。
  - 单问号低信息仍有反问残留，最终回复仍以“想请本帮主讲两句？”收尾，尚未达到最自然群友接话。
  - 引用 bot 不 @ 场景虽然能给具体建议，但回复仍偏长，说明字数控制和 COT 影响仍需后续长上下文验证。
  - `config.json` 被 `.gitignore` 忽略且不是 git 跟踪文件，无法用 git diff 长期审计配置变更。
- 修正动作：
  - 本轮不继续修改 prompt，不回滚 Task 7。
  - 原因：Task 7 已修掉关键用户痛点；继续在 preset 堆单点规则会过拟合小样本。剩余“单问号/长度/旧话题释放”更适合 Task 9 的 current-message-focus 靠近最新输入处理。
  - 将后续约束写入报告：Task 8 不再改徐缺 prompt；Task 9 必须覆盖单问号、只喊名字、emoji、突然换话题、旧话题释放、昵称不当事实读取；Task 13 复查长上下文旧梗复燃和反问偷懒。
- 验证结果：
  - 原始基线：`goal-5/xuque-small-baseline-before-task7.json`，10/10 成功，平均分 95，`good_reply=6`。
  - 最终复测：`goal-5/xuque-small-baseline-after-task7-final.json`，10/10 成功，平均分 98，`good_reply=8`。
  - 对比报告：`goal-5/xuque-small-baseline-task7-comparison.json`。
  - `node --check src\prompt.js` 通过。
  - `node --check src\index.js` 通过。
  - `node --check goal-5\run-xuque-small-baseline.mjs` 通过。
  - `config.json` JSON 解析通过；目标 prompt 条目存在且启用。
  - `node --test tests\onebot-events.test.js tests\message-chain-source.test.js tests\standard-event.test.js tests\prompt-preset.test.js tests\preset-routes.test.js` 通过：59/59。

### [x] Task 8 - 接入引用 bot 与戳一戳触发策略

目标：引用 bot 消息但不 @ 时可触发回应；戳一戳事件进入统一事件输入头和调度链路，并记录未触发原因。

验证：用测试覆盖引用和 poke 事件，确认不误伤普通消息。

记录：
- 完成内容：
  - 在 `src/index.js` 增加 `buildRoutingDecision()`，把消息触发判断收敛为结构化结果：`shouldRespond`、`triggerReason`、`skipReason`、`checks`。
  - 保留既有行为：群聊引用 bot 消息即使不 @ 仍走 `reply_to_bot` 触发；普通群聊消息仍按 at/prefix/keyword/triggerMode 判断。
  - `buildReplyInfo()` 增加 `fetchStatus/fetchReason`，区分 `resolved`、`resolved_empty`、`failed`、`unavailable`、`none`，方便判断引用 bot 失败是不是 `get_msg` 获取失败。
  - 未触发消息现在写入 `lastRoutingSnapshot`，包含 `skipReason`、`routingDecision`、`replyFetchStatus`、`replyFetchReason`，并输出 `[路由] 消息未触发回复` debug 日志。
  - 戳一戳处理补齐跳过原因：`poke_reaction_disabled`、`poke_target_not_bot`、`poke_cooldown`、`poke_missing_default_character`、`poke_missing_group_id`、`poke_duplicate`、`poke_error`。
  - 戳一戳成功入队时把 `routingDecision`、`standardEvent`、`triggerReason: 'poke'` 一起进入 runtime 调度链路。
  - `src/standard-event.js` 扩展标准事件：`reply.fetchStatus/fetchReason` 与 `routing`，并在输入头中输出 `replyFetch`、`replyFetchReason`、`triggerReason`、`skipReason`。
  - `processBatch()` 将 `routingDecisions` 放入 `runtimeContext`，为 Task 9 的 current-message-focus 提供结构化输入。
- 验证结果：
  - `node --check src\index.js` 通过。
  - `node --check src\standard-event.js` 通过。
  - `node --test tests\message-chain-source.test.js tests\standard-event.test.js tests\onebot-events.test.js tests\prompt-preset.test.js tests\preset-routes.test.js` 通过：61/61。
  - 新增/更新测试覆盖：引用 bot 不 @ 的触发路径、引用消息获取状态、poke 成功触发、poke 未触发原因、普通未触发消息的 `skipReason`。
- 剩余风险：
  - 本轮验证是单元/源码保护测试，没有真实 NapCat/OneBot 端到端戳一戳和引用消息 `get_msg` 实测。
  - `lastRoutingSnapshot` 只能保留最近一次路由状态；后续靶场/前端观察需要 Task 11/12 做历史列表和刷新回填。
  - `config.json` 仍被 `.gitignore` 忽略；本任务没有修改配置，但当前整体工作区有大量前序未跟踪文件，未做 commit。
- 下一步：
  - Task 9 实现 `current-message-focus` 决策块构造器，直接消费 `standardEvents` 和 `routingDecisions`，重点覆盖低信息、emoji、引用、戳一戳、多人插话和换话题。

### [x] Task 9 - 实现 current-message-focus 决策块构造器

目标：根据标准化事件和上下文生成通用决策块：事件类型、低信息、换话题、引用、回复目标、旧话题释放、回复策略。

验证：单元测试覆盖低信息、emoji、引用、戳一戳、多人插话、换话题。

记录：
- 完成内容：
  - 新增 `src/current-message-focus.js`，提供 `buildCurrentMessageFocus(runtimeContext)` 与 `formatCurrentMessageFocus(focus)`。
  - 构造器直接消费 Task 4/8 已进入 runtime 的 `primaryStandardEvent`、`standardEvents`、`routingDecisions`、`triggerReason`。
  - 输出结构包含：`eventType`、`messageType`、发言人、群信息、`intent`、`replyTarget`、`shouldRespond`、`triggerReason`、`skipReason`、低信息/表情/换话题/释放旧话题标记、引用状态、最新输入摘要、消息段类型、策略、警告。
  - 覆盖意图：`reply_to_bot`、`poke`、`call_out`、`emoji_reaction`、`topic_shift`、`low_information`、`question`、`chat`。
  - 策略会显式标出：引用只当上下文、引用 bot 视作对 bot 发言、戳一戳短回应、表情承接、低信息短接住且避免反问偷懒、释放旧话题、不触发时不要回复、1-3 句短回复。
  - `formatCurrentMessageFocus()` 生成稳定的 `<current-message-focus>` 文本块，供 Task 10 接入 prompt 时复用。
- 验证结果：
  - 新增 `tests/current-message-focus.test.js`。
  - 单测覆盖：引用 bot 不 @、戳一戳、单问号低信息、QQ 动态表情、显式换话题/释放旧梗、普通未触发消息 `skipReason`、多消息聚合取 primary、格式化输出。
  - `node --check src\current-message-focus.js` 通过。
  - `node --check src\index.js` 通过。
  - `node --check src\standard-event.js` 通过。
  - `node --test tests\current-message-focus.test.js tests\message-chain-source.test.js tests\standard-event.test.js tests\onebot-events.test.js tests\prompt-preset.test.js tests\preset-routes.test.js` 通过：69/69。
- 剩余风险：
  - 本轮只实现构造器，尚未注入 prompt；模型实际回复还不会受 `current-message-focus` 影响，接入留给 Task 10。
  - 低信息、换话题、旧话题释放目前是规则启发式，长上下文中仍需 Task 13 验证并可能调整。
  - 构造器依赖 Task 8 的标准事件与 routingDecision；真实 OneBot 上游缺失表情摘要时，只能按段类型识别为表情，不能理解动图视觉含义。
- 下一步：
  - Task 10 将 `current-message-focus` 接入 `PromptBuilder.buildRuntimeComposition()`，放到靠近最新用户输入的位置，并让 messageTrace 标注来源，不破坏现有角色卡/世界书/预设顺序。

### [x] Task 10 - 将 current-message-focus 接入 prompt build

目标：把决策块放到靠近最新用户输入的位置，确保 messageTrace 能标注来源，不破坏现有角色卡/世界书/预设顺序。

验证：messageTrace 测试和 prompt-runtime 预览测试。

记录：
- 完成内容：
  - 在 `src/prompt.js` 中接入 `buildCurrentMessageFocus()` / `formatCurrentMessageFocus()`。
  - 每次 prompt build 都生成独立 `current-message-focus` runtime segment，插入顺序为：system composition → first/history/history-injection → post-history → current-message-focus → 最新 user input → assistant prefill。
  - `messageTrace` 增加 `current_message_focus` 精确匹配，避免该 system 消息被误归到普通 system 或 post-history。
  - `src/runtime/prompt-registry.js` 增加 `current_message_focus` sourceSlot，便于后续靶场前端独立展示。
  - 当没有 OneBot standardEvent 时，focus 使用 `userMessage` 作为 fallback，保证靶场/预览场景也能看到最新输入和话题释放判断。
  - 新增 `tests/prompt-current-message-focus.test.js`，并调整 prompt/messageTrace 相关测试的固定索引断言。
- 验证结果：
  - `node --check src\current-message-focus.js` 通过。
  - `node --check src\prompt.js` 通过。
  - `node --check src\runtime\prompt-registry.js` 通过。
  - `node --check tests\prompt-preset.test.js` 通过。
  - `node --check tests\chat-runtime-preview.test.js` 通过。
  - `node --test tests\current-message-focus.test.js tests\message-trace.test.js tests\prompt-current-message-focus.test.js tests\prompt-preset.test.js tests\message-chain-source.test.js tests\standard-event.test.js tests\onebot-events.test.js tests\preset-routes.test.js` 通过：73/73。
  - `node --test --test-name-pattern "buildChatRuntimePreview returns structured sources|build exposes runtime sources" tests\chat-runtime-preview.test.js` 通过：2/2。
- 剩余风险：
  - 本轮是 prompt build 层测试，没有调用真实模型；focus 对实际回复质量的提升需要 Task 13 长上下文测试继续验证。
  - 完整 `chat-runtime-preview.test.js` 曾在全量运行时超过 120 秒并输出与 AI client 相关的既有失败/超时，本轮只对 Task 10 影响到的 preview 用例做了聚焦验证。
  - `current-message-focus` 目前是规则启发式，QQ 动态表情缺少上游 summary 时仍只能按表情事件处理，无法理解视觉内容。
- 下一步：
  - CHECK 3 执行软件链路大型检查-debug 循环，重点检查事件数据完整性、prompt 注入顺序、sourceSlot/messageTrace 兼容性、安全性和日志可追踪性。

### [ ] CHECK 3 - 软件链路大型检查-debug 循环

检查范围：事件数据完整性、prompt 注入顺序、安全性、日志可追踪性、兼容性。

记录：
- 检查内容：
- 发现问题：
- 修正动作：
- 验证结果：

### [ ] Task 11 - 增强靶场后端返回字段

目标：`/api/prompt-range/test` 与 MCP `range_test` 返回输入头、fakeHistory、messageTrace、reasoningContent、rawReply、cleanedReply、finalReply、regex trace。

验证：接口测试和一次本地真实调用。

记录：
- 完成内容：
- 验证结果：
- 剩余风险：
- 下一步：

### [ ] Task 12 - 改造靶场前端观察 UI

目标：轮次卡片自动追加；详情区按输入/Prompt/Reasoning/Raw/Clean/Final/Regex 分栏或折叠展示，避免长上下文塞进单张长卡。

验证：真实浏览器打开靶场，跑多轮测试，截图保存到 `goal-5/screenshots/`。

记录：
- 完成内容：
- 验证结果：
- 截图路径：
- 剩余风险：
- 下一步：

### [ ] CHECK 4 - 前端观察大型检查-debug 循环

检查范围：前端布局、截图证据、接口字段一致性、刷新后回填、MCP 同步中途打开靶场是否更新。

记录：
- 检查内容：
- 发现问题：
- 修正动作：
- 验证结果：

### [ ] Task 13 - 构建 10x20 长上下文测试集与 runner

目标：生成覆盖水群、正常聊天、低信息、emoji、戳一戳、引用、不 @、多人插话、突然换话题、旧梗释放的测试集和运行脚本。

验证：输出 JSON 报告，包含轮数、输入、回复、reasoning 摘要、问题、评分。

记录：
- 完成内容：
- 验证结果：
- 报告路径：
- 剩余风险：
- 下一步：

### [ ] Task 14 - 修复备份/还原正则

目标：确保备份导出包含正则配置与绑定信息，恢复时可预览并正确还原，不误覆盖记忆库。

验证：fixture 测试导出/恢复正则，覆盖旧格式兼容。

记录：
- 完成内容：
- 验证结果：
- 剩余风险：
- 下一步：

### [ ] Task 15 - 全量测试、构建、浏览器验证与最终 review

目标：运行项目测试/构建；浏览器验证靶场多轮观察、MCP 同步、刷新回填、备份/恢复 UI 或接口；从 C 端体验、代码、安全、数据一致性、权限、错误处理、测试、构建、文档、回滚角度做最终 review。

验证：最终报告、截图路径、无未处理高风险问题、goal 标记完成。

记录：
- 完成内容：
- 验证结果：
- 截图路径：
- 剩余风险：
- 下一步：
