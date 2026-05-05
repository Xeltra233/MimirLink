---
title: SillyTavern Runtime Notes
slug: sillytavern-runtime-notes
doc_type: explore
status: migrated
created_at: 2026-04-12
updated_at: 2026-04-20
source_documents:
  - docs/sillytavern-research-notes-2026-04-12.md
---

# SillyTavern Runtime Notes

## 1. 调研范围

本探索文档由既有研究笔记迁移而来，聚焦以下主题：

- Chat Completion Presets
- Prompt Manager
- World Info / Character Book
- Persona
- Character Card structure
- Character-card prompt overrides

原始来源：`docs/sillytavern-research-notes-2026-04-12.md`

## 2. 核心结论

- SillyTavern 不是围绕单一“preset editor”概念构建的
- 相关层次至少应区分：Preset layer、Prompt Manager layer、Runtime source layer、Message-tree layer、Inspector / token accounting layer
- 这些层次不能被粗暴压扁成单一 UI 或单一配置对象
- Prompt Manager 不是普通的 prompt.content 列表，它混合了可编辑 prompt 项与 marker/source-slot 项
- inspect 与 token display 依赖最终运行时 message tree，而不是静态 prompt 文本

## 3. 对 MimirLink 的启发

- 不应只做一个“长得像 ST”的前端界面，而忽略底层数据模型与运行时装配逻辑
- 如果目标是后端优先聊天运行时，提示词来源解析、消息树生成和检查能力必须在后端具备对应模型
- world info、角色卡覆盖、preset 应用与 prompt source 替换应被视为运行时语义问题，而不是纯 UI 编辑问题

## 4. 主要证据点

原笔记中已记录的关键证据包括：

- `public/scripts/openai.js`
- `public/scripts/PromptManager.js`
- `public/scripts/templates/promptManagerHeader.html`
- `public/scripts/templates/promptManagerFooter.html`
- `public/scripts/templates/promptManagerListHeader.html`
- `public/css/promptmanager.css`

## 5. 后续用途

该文档可作为：

- `easysdd/architecture/DESIGN.md` 的研究来源材料
- 后续 feature design 阶段关于 ST 兼容/借鉴边界的证据输入
- 后续 architecture/check 阶段校验术语和运行时模型的一手背景材料

## 6. 迁移说明

本文件是从旧研究笔记归档而来，原文件继续保留在原位，不做删除或移动。
