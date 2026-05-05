---
title: MimirLink Chat Backend Runtime Design
slug: chat-backend-runtime
doc_type: feature_design
status: migrated
created_at: 2026-04-12
updated_at: 2026-04-20
source_documents:
  - docs/mimirlink-chat-backend-implementation-plan-2026-04-12.md
---

# MimirLink Chat Backend Runtime Design

## 1. 背景

本设计文档由既有实现计划迁移而来，目标是把 MimirLink 当前影响聊天语义的提示词编排逻辑逐步收敛到后端，同时保持前端主要承担配置、管理与检查职责。

原始来源：`docs/mimirlink-chat-backend-implementation-plan-2026-04-12.md`

## 2. 目标

- 将聊天关键提示词编排迁移到后端
- 围绕现有 `PromptBuilder`、`WorldBookManager`、`CharacterManager` 和 bindings 模型构建运行时管线
- 第一阶段交付结构化运行时提示词解析、后端预览/检查接口和显式来源追踪
- 不要求一开始就达到完整的 SillyTavern 行为对齐

## 3. 当前边界

当前阶段包含：

- effective preset resolution
- effective worldbook resolution
- effective character runtime fields
- structured prompt source registry
- backend preview of final messages
- source tracing for inspection

当前阶段不包含：

- full PromptManager marker parity
- swipe/regenerate runtime branches
- reasoning/tool-calling/media parity
- persona runtime layer
- true ST-style absolute injection/depth ordering

## 4. 文件与模块落点

既有核心文件：

- `src/index.js`
- `src/routes.js`
- `src/prompt.js`
- `src/worldbook.js`
- `src/character.js`
- `config.json`

建议新增的第一阶段文件：

- `src/runtime/prompt-registry.js`
- `src/runtime/source-resolver.js`
- `src/runtime/chat-preview.js`
- `tests/chat-runtime-preview.test.js`

## 5. 推进步骤

### 5.1 定义后端运行时 source 结构

目标：让后端运行时层返回结构化 source 列表，而不只是原始 message 字符串。

建议最小能力：

- `createRuntimeSource(...)`
- `compactRuntimeSources(...)`

建议先写失败测试，再补最小实现。

### 5.2 抽出 source resolver

目标：围绕当前 config/binding 规则统一计算 effective runtime inputs。

建议职责：

- 解析 effective binding
- 读取当前角色
- 读取当前 worldbook
- 归一化 preset
- 返回结构化运行时输入对象

### 5.3 构建后端 chat preview

目标：让后端提供可以被前端检查的 preview payload，包括 source 列表、最终 messages 和 effective binding。

## 6. 测试设计

建议优先覆盖：

- `buildChatRuntimePreview` 返回结构化 source 记录
- `buildChatRuntimePreview` 暴露 effective preset/worldbook binding
- 运行时 source 压缩与过滤逻辑
- preview payload 结构稳定性

## 7. 迁移说明

本文件是从旧实现计划归档而来，当前保留原文主旨，但已改写为 easysdd feature design 入口格式。原文件继续保留在原位，不做删除或移动。
