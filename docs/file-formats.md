# MimirLink / SillyTavern 文件格式规范

## 一、世界书 (World Book / Lorebook)

### ST 酒馆导入格式 (V1)
对外导入用这个。`entries` 是**对象**，key 是字符串 ID。

```json
{
  "name": "世界书名",
  "description": "描述",
  "entries": {
    "0": {
      "uid": 0,
      "key": "触发词, 逗号分隔",
      "secondary_keys": [],
      "comment": "条目备注",
      "content": "条目正文",
      "constant": false,
      "selective": true,
      "order": 100,
      "enabled": true,
      "position": 0,
      "use_regex": true,
      "extensions": {
        "position": 0,
        "exclude_recursion": false,
        "display_index": 0,
        "probability": 100,
        "useProbability": true,
        "depth": 4,
        "selectiveLogic": 0,
        "group_weight": 100,
        "role": 0,
        "sticky": 0,
        "cooldown": 0,
        "delay": 0
      }
    }
  }
}
```

**必须字段**: `uid`, `key`, `content`, `constant`, `order`, `enabled`, `position`, `use_regex`, `extensions`

### MimirLink 运行时格式 (V2)
MimirLink 内部使用。`entries` 是**数组**。

```json
{
  "name": "世界书名",
  "description": "描述",
  "entries": [
    {
      "id": 0,
      "keys": ["触发词1", "触发词2"],
      "secondary_keys": [],
      "comment": "条目备注",
      "content": "条目正文",
      "constant": false,
      "selective": true,
      "insertion_order": 100,
      "enabled": true,
      "position": "before_char",
      "use_regex": true,
      "extensions": { ... }
    }
  ]
}
```

**必须字段**: `id`, `keys`(数组), `content`, `constant`, `insertion_order`, `enabled`, `position`(字符串), `use_regex`, `extensions`

### V1↔V2 字段对照

| V1 (ST) | V2 (MimirLink) |
|---------|----------------|
| `uid` (int) | `id` (int) |
| `key` (string, 逗号分隔) | `keys` (string[]) |
| `order` (int) | `insertion_order` (int) |
| `position` (int: 0=before_char) | `position` (string: "before_char") |

**注意**: ST 导入时 `extensions` 和 `use_regex` 缺一不可，否则条目显示为空。

---

## 二、预设 (Preset)

### ST 预设格式 (导入/导出通用)
```json
{
  "temperature": 1,
  "max_context_unlocked": true,
  "prompts": [
    {
      "name": "条目名",
      "enabled": true,
      "role": "system",
      "injection_position": 0,
      "injection_depth": 4,
      "content": "提示词内容",
      "system_prompt": false,
      "marker": false,
      "forbid_overrides": false
    }
  ],
  "prompt_order": [
    { "name": "条目名", "enabled": true, "order": 0 }
  ]
}
```

**注**: `extensions` 字段（SPreset/tavern_helper/regex_scripts）MimirLink 不认，导入后会被清空。

### MimirLink 预设存储
- 运行时: `config.preset.prompts[]`
- 磁盘: `data/presets/{recordId}.json` → 存的是导入记录 `{id, type, filename, presetName, importedPreset:{prompts:[...]}}`
- 同步: 启动时 `syncPresetFiles()` 双向同步磁盘 ↔ config

---

## 三、角色卡 (Character Card)

PNG 文件，tEXt 块存储。MimirLink 读 `chara` 或 `ccv3` 块（优先 ccv3）。

```json
{
  "name": "角色名",
  "description": "描述",
  "personality": "性格",
  "scenario": "场景",
  "first_mes": "开场白",
  "mes_example": "对话示例",
  "system_prompt": "系统提示",
  "post_history_instructions": "后置指令",
  "variable_defaults": {"好感度": 0, "装逼值": 500},
  "character_book": { "entries": [...] }
}
```

**`variable_defaults`**: MimirLink 扩展字段。新用户首次互动时自动创建变量。
**`character_book`**: ST 嵌套世界书。

---

## 四、变量 (Variable)

### 存储
SQLite `memory_entries` 表，按 namespace 隔离（scopeType + scopeKey + characterName）。

### 变量操作宏 (MimirLink 支持)
| 宏 | 说明 |
|----|------|
| `{{setvar::name::value}}` | 写入变量（预设初始化） |
| `{{getvar::name}}` | 读取变量（COT注入） |
| `{{get_message_variable::path}}` | 读取消息变量 |

**不支持**: `{{addvar}}`, `{{addglobalvar}}`（ST 专属）

### AI 输出变量更新
```xml
<UpdateVariable>
[{"op":"replace","path":"/好感度","value":75}]
</UpdateVariable>
```

解析规则: `/变量名` → key，`replace`/`delta`/`add`/`remove` 操作。

---

## 五、备份

### 导出
`GET /api/config/backup` → `mimirlink-backup-{date}-safe.tar.gz`

分类: `config|characters|worldbooks|memory|presets|corpus|regex|knowledge`

### 恢复
上传 tar.gz → 自动检测分类 → 勾选 → `POST /api/config/restore`

预设恢复后自动调用 `syncPresetFiles()` 同步磁盘到 config。
