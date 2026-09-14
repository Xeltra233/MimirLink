package panel

// MCP 服务端/靶场（对齐 Node src/mcp.js）：/mcp JSON-RPC 端点 + 27 个 range_* 工具。
// 已知偏差（如实记录）：AI 驱动的 range_test/analyze/batch_test 使用简化 prompt 管线
// （角色卡字段 + 世界书常驻条目 + fakeHistory），不经过 Node 完整 promptBuilder 运行时。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/store"
)

type rangeTool struct {
	Description string
	Schema      map[string]any
	Handler     func(args map[string]any) any
}

// textResult 包装 MCP 文本回复。
func textResult(text string) map[string]any {
	return map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}
}

func jsonText(value any) string {
	encoded, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(encoded)
}

func textResultJSON(value any) map[string]any {
	return textResult(jsonText(value))
}

func errorResult(err error) map[string]any {
	return textResult("失败: " + err.Error())
}

// buildRangeService 构建靶场工具集。
func (s *Server) buildRangeService() map[string]rangeTool {
	tools := map[string]rangeTool{}

	register := func(name string, description string, properties map[string]any, required []string, handler func(args map[string]any) any) {
		schema := map[string]any{"type": "object", "properties": properties}
		if len(required) > 0 {
			schema["required"] = required
		}
		tools[name] = rangeTool{Description: description, Schema: schema, Handler: handler}
	}

	// ---------------- 列举/读取类 ----------------

	register("range_list_characters", "列出所有可用角色", map[string]any{}, nil, func(args map[string]any) any {
		names, err := s.listCharacterNames()
		if err != nil {
			return errorResult(err)
		}
		return textResult(strings.Join(names, "\n"))
	})

	register("range_list_models", "列出所有可用 AI 模型（含 provider 信息）", map[string]any{}, nil, func(args map[string]any) any {
		models, err := s.listRangeModels()
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(models)
	})

	register("range_get_prefs", "读取靶场当前偏好（角色/世界书/预设/模型选择）", map[string]any{}, nil, func(args map[string]any) any {
		raw, err := os.ReadFile(filepath.Join(s.dataDir, "range-prefs.json"))
		prefs := map[string]any{}
		if err == nil {
			_ = json.Unmarshal(raw, &prefs)
		}
		return textResultJSON(prefs)
	})

	register("range_get_character_card", "获取角色卡原始内容", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		card, err := s.readCharacterCard(name)
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(card)
	})

	register("range_get_worldbook_entries", "获取指定角色世界书的所有条目完整信息", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		book, fileName, err := readRangeWorldBook(s.dataDir, name)
		if err != nil {
			return errorResult(err)
		}
		if book == nil {
			return textResult("未找到世界书: " + name)
		}
		return textResultJSON(map[string]any{"file": fileName, "entries": book.Entries})
	})

	register("range_get_preset_status", "列出所有预设 prompt 及其启用状态", map[string]any{
		"presetFilePath": map[string]any{"type": "string", "description": "可选，预设文件名；默认当前激活预设"},
	}, nil, func(args map[string]any) any {
		path := textArgRange(args, "presetFilePath")
		preset, err := s.readRangePreset(path)
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(presetStatus(preset))
	})

	register("range_list_variables", "列出变量，可按 scope/角色/搜索过滤", map[string]any{
		"scopeKey":      map[string]any{"type": "string", "description": "可选，变量作用域"},
		"characterName": map[string]any{"type": "string", "description": "可选，角色名"},
		"search":        map[string]any{"type": "string", "description": "可选，搜索关键字"},
	}, nil, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		items, err := database.ListVariables(store.VariableFilters{
			ScopeKey:      textArgRange(args, "scopeKey"),
			CharacterName: textArgRange(args, "characterName"),
			Search:        textArgRange(args, "search"),
			Limit:         200,
		})
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(items)
	})

	register("range_list_knowledge", "列出知识库条目", map[string]any{
		"search": map[string]any{"type": "string", "description": "可选，搜索关键字"},
	}, nil, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		items, err := database.ListKnowledgeEntriesFiltered(store.VariableFilters{
			Search: textArgRange(args, "search"), Limit: 200,
		})
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(items)
	})

	register("range_list_profiles", "列出人物档案", map[string]any{
		"search": map[string]any{"type": "string", "description": "可选，搜索关键字"},
	}, nil, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		items, err := database.ListParticipantProfiles(100, textArgRange(args, "search"))
		if err != nil {
			return errorResult(err)
		}
		return textResultJSON(items)
	})

	// ---------------- 写工具 ----------------

	register("range_update_character", "修改角色卡字段（system_prompt/first_mes/scenario 等）", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
		"updates":       map[string]any{"type": "object", "description": "字段→新值"},
	}, []string{"characterName", "updates"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		updates, _ := args["updates"].(map[string]any)
		card, err := s.readCharacterCard(name)
		if err != nil {
			return errorResult(err)
		}
		for key, value := range updates {
			card[key] = value
		}
		if err := s.writeCharacterCard(name, card); err != nil {
			return errorResult(err)
		}
		return textResult(fmt.Sprintf("角色 %s 已更新 %d 个字段", name, len(updates)))
	})

	register("range_set_preset_prompt", "启用/禁用预设中的指定 prompt，或修改内容", map[string]any{
		"identifier":     map[string]any{"type": "string", "description": "prompt identifier"},
		"enabled":        map[string]any{"type": "boolean", "description": "可选，启用状态"},
		"content":        map[string]any{"type": "string", "description": "可选，新内容"},
		"presetFilePath": map[string]any{"type": "string", "description": "可选，预设文件名"},
	}, []string{"identifier"}, func(args map[string]any) any {
		identifier := textArgRange(args, "identifier")
		presetPath, err := s.resolveRangePresetPath(textArgRange(args, "presetFilePath"))
		if err != nil {
			return errorResult(err)
		}
		preset, err := readJSONFile(presetPath)
		if err != nil {
			return errorResult(err)
		}
		prompts, _ := preset["prompts"].([]any)
		matched := false
		for _, item := range prompts {
			entry, _ := item.(map[string]any)
			if entry == nil || entry["identifier"] != identifier {
				continue
			}
			matched = true
			if enabled, ok := args["enabled"].(bool); ok {
				entry["enabled"] = enabled
			}
			if content, ok := args["content"].(string); ok {
				entry["content"] = content
			}
		}
		if !matched {
			return textResult("未找到 prompt: " + identifier)
		}
		if err := writeJSONFile(presetPath, preset); err != nil {
			return errorResult(err)
		}
		return textResult("prompt " + identifier + " 已更新")
	})

	register("range_batch_set_prompts", "批量启用/禁用预设 prompt（patterns 数组支持通配）", map[string]any{
		"patterns": map[string]any{"type": "array", "description": "identifier 模式（支持 *）"},
		"enabled":  map[string]any{"type": "boolean", "description": "启用状态"},
	}, []string{"patterns", "enabled"}, func(args map[string]any) any {
		patterns := []string{}
		if items, ok := args["patterns"].([]any); ok {
			for _, item := range items {
				if text, ok := item.(string); ok {
					patterns = append(patterns, text)
				}
			}
		}
		enabled, _ := args["enabled"].(bool)
		presetPath, err := s.resolveRangePresetPath("")
		if err != nil {
			return errorResult(err)
		}
		preset, err := readJSONFile(presetPath)
		if err != nil {
			return errorResult(err)
		}
		changed := 0
		prompts, _ := preset["prompts"].([]any)
		for _, item := range prompts {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			identifier := fmt.Sprintf("%v", entry["identifier"])
			for _, pattern := range patterns {
				if wildcardMatch(pattern, identifier) {
					entry["enabled"] = enabled
					changed++
					break
				}
			}
		}
		if err := writeJSONFile(presetPath, preset); err != nil {
			return errorResult(err)
		}
		return textResult(fmt.Sprintf("已更新 %d 个 prompt", changed))
	})

	register("range_update_worldbook_entry", "添加/修改/删除世界书条目", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
		"operation":     map[string]any{"type": "string", "description": "add | update | delete"},
		"index":         map[string]any{"type": "integer", "description": "update/delete 用：条目下标"},
		"entry":         map[string]any{"type": "object", "description": "add/update 用：条目内容"},
	}, []string{"characterName", "operation"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		operation := textArgRange(args, "operation")
		book, fileName, err := readRangeWorldBook(s.dataDir, name)
		if err != nil || book == nil {
			return errorResult(fmt.Errorf("未找到世界书: %s", name))
		}
		index := intArgRange(args, "index")
		switch strings.ToLower(operation) {
		case "add":
			entry, _ := args["entry"].(map[string]any)
			if entry == nil {
				return textResult("缺少 entry")
			}
			book.Entries = append(book.Entries, entry)
		case "update":
			if index < 0 || index >= len(book.Entries) {
				return textResult(fmt.Sprintf("下标越界: %d（共 %d 条）", index, len(book.Entries)))
			}
			entry, _ := args["entry"].(map[string]any)
			if entry == nil {
				return textResult("缺少 entry")
			}
			book.Entries[index] = entry
		case "delete":
			if index < 0 || index >= len(book.Entries) {
				return textResult(fmt.Sprintf("下标越界: %d", index))
			}
			book.Entries = append(book.Entries[:index], book.Entries[index+1:]...)
		default:
			return textResult("operation 必须是 add/update/delete")
		}
		if err := writeJSONFile(filepath.Join(s.dataDir, "worlds", fileName), map[string]any{"entries": book.Entries}); err != nil {
			return errorResult(err)
		}
		return textResult(fmt.Sprintf("世界书 %s 已更新（%s，现 %d 条）", fileName, operation, len(book.Entries)))
	})

	register("range_set_variable", "创建或更新变量", map[string]any{
		"key":      map[string]any{"type": "string", "description": "变量名"},
		"value":    map[string]any{"description": "变量值"},
		"scopeKey": map[string]any{"type": "string", "description": "可选，作用域（默认 user:test）"},
	}, []string{"key"}, func(args map[string]any) any {
		key := textArgRange(args, "key")
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		scopeKey := orDefault(textArgRange(args, "scopeKey"), "user:test")
		value := args["value"]
		encoded, _ := json.Marshal(value)
		if _, _, err := database.UpsertVariable(store.NamespaceOptions{
			ScopeType: "user_persistent", ScopeKey: scopeKey,
		}, store.Variable{Key: key, RawValue: string(encoded), ValueType: inferRangeValueType(value)}); err != nil {
			return errorResult(err)
		}
		return textResult(fmt.Sprintf("变量 %s 已写入（scope=%s）", key, scopeKey))
	})

	register("range_delete_variable", "删除变量", map[string]any{
		"key":      map[string]any{"type": "string", "description": "变量名"},
		"scopeKey": map[string]any{"type": "string", "description": "可选，作用域"},
	}, []string{"key"}, func(args map[string]any) any {
		key := textArgRange(args, "key")
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		scopeKey := orDefault(textArgRange(args, "scopeKey"), "user:test")
		deleted, err := database.DeleteVariableByName(store.NamespaceOptions{
			ScopeType: "user_persistent", ScopeKey: scopeKey,
		}, key)
		if err != nil {
			return errorResult(err)
		}
		if !deleted {
			return textResult("变量不存在: " + key)
		}
		return textResult("变量 " + key + " 已删除")
	})

	register("range_set_knowledge", "创建知识库条目", map[string]any{
		"title":   map[string]any{"type": "string", "description": "标题"},
		"content": map[string]any{"type": "string", "description": "内容"},
	}, []string{"title", "content"}, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		id, err := database.UpsertKnowledgeEntry(store.NamespaceOptions{
			ScopeType: "global_shared", ScopeKey: "global_shared_memory",
		}, store.KnowledgeEntry{
			Title: textArgRange(args, "title"), Content: textArgRange(args, "content"),
			KnowledgeType: "dynamic",
		})
		if err != nil {
			return errorResult(err)
		}
		return textResult("知识条目已创建: " + id)
	})

	register("range_seed_test_data", "注入假数据用于全链路测试（变量/知识）", map[string]any{
		"variables": map[string]any{"type": "object", "description": "变量名→值"},
		"scopeKey":  map[string]any{"type": "string", "description": "可选，作用域（默认 user:test）"},
	}, nil, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		scopeKey := orDefault(textArgRange(args, "scopeKey"), "user:test")
		count := 0
		if variables, ok := args["variables"].(map[string]any); ok {
			for key, value := range variables {
				encoded, _ := json.Marshal(value)
				if _, _, err := database.UpsertVariable(store.NamespaceOptions{
					ScopeType: "user_persistent", ScopeKey: scopeKey,
				}, store.Variable{Key: key, RawValue: string(encoded), ValueType: inferRangeValueType(value)}); err == nil {
					count++
				}
			}
		}
		return textResult(fmt.Sprintf("已注入 %d 个测试变量（scope=%s）", count, scopeKey))
	})

	register("range_clear_test_data", "清除指定 scope 的假测试数据（变量）", map[string]any{
		"scopeKey": map[string]any{"type": "string", "description": "可选，作用域（默认 user:test）"},
	}, nil, func(args map[string]any) any {
		database, _, err := s.openActiveMemory()
		if err != nil {
			return errorResult(err)
		}
		defer database.Close()
		scopeKey := orDefault(textArgRange(args, "scopeKey"), "user:test")
		items, err := database.ListVariables(store.VariableFilters{
			ScopeType: "user_persistent", ScopeKey: scopeKey, Limit: 500,
		})
		if err != nil {
			return errorResult(err)
		}
		deleted := 0
		for _, item := range items {
			if ok, _ := database.DeleteVariable(item.ID); ok {
				deleted++
			}
		}
		return textResult(fmt.Sprintf("已清除 %d 个变量（scope=%s）", deleted, scopeKey))
	})

	register("range_load_worldbook", "加载指定角色的世界书为当前活跃", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		_, fileName, err := readRangeWorldBook(s.dataDir, name)
		if err != nil || fileName == "" {
			return errorResult(fmt.Errorf("未找到世界书: %s", name))
		}
		if err := s.document.Set("bindings.global.worldbook", fileName); err != nil {
			return errorResult(err)
		}
		if err := s.document.Save(); err != nil {
			return errorResult(err)
		}
		return textResult("已激活世界书: " + fileName)
	})

	// ---------------- 校验/修复工具 ----------------

	register("range_validate_worldbook", "校验世界书格式是否符合 SillyTavern 规范", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		book, fileName, err := readRangeWorldBook(s.dataDir, textArgRange(args, "characterName"))
		if err != nil || book == nil {
			return errorResult(fmt.Errorf("未找到世界书"))
		}
		issues := []string{}
		for index, entry := range book.Entries {
			keyList := entryKeys(entry)
			if len(keyList) == 0 {
				issues = append(issues, fmt.Sprintf("条目#%d: 缺少 key/keys", index))
			}
			if strings.TrimSpace(fmt.Sprintf("%v", entry["content"])) == "" {
				issues = append(issues, fmt.Sprintf("条目#%d: content 为空", index))
			}
		}
		if len(issues) == 0 {
			return textResult(fmt.Sprintf("世界书 %s 校验通过（%d 条）", fileName, len(book.Entries)))
		}
		return textResult(fmt.Sprintf("世界书 %s 发现 %d 个问题：\n%s", fileName, len(issues), strings.Join(issues, "\n")))
	})

	register("range_fix_worldbook_format", "自动修复世界书条目的 ST 格式问题（补 key/constant）", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		book, fileName, err := readRangeWorldBook(s.dataDir, name)
		if err != nil || book == nil {
			return errorResult(fmt.Errorf("未找到世界书"))
		}
		fixed := 0
		for index, entry := range book.Entries {
			changed := false
			if len(entryKeys(entry)) == 0 {
				entry["key"] = []any{name}
				changed = true
			}
			if strings.TrimSpace(fmt.Sprintf("%v", entry["content"])) == "" {
				entry["content"] = "(empty)"
				changed = true
			}
			if changed {
				book.Entries[index] = entry
				fixed++
			}
		}
		if fixed > 0 {
			if err := writeJSONFile(filepath.Join(s.dataDir, "worlds", fileName), map[string]any{"entries": book.Entries}); err != nil {
				return errorResult(err)
			}
		}
		return textResult(fmt.Sprintf("世界书 %s 已修复 %d 条", fileName, fixed))
	})

	register("range_validate_character", "校验角色卡格式：必要字段与长度", map[string]any{
		"characterName": map[string]any{"type": "string", "description": "角色名"},
	}, []string{"characterName"}, func(args map[string]any) any {
		name := textArgRange(args, "characterName")
		card, err := s.readCharacterCard(name)
		if err != nil {
			return errorResult(err)
		}
		issues := []string{}
		for _, field := range []string{"name", "description", "first_mes", "system_prompt"} {
			if strings.TrimSpace(fmt.Sprintf("%v", card[field])) == "" {
				issues = append(issues, "缺少字段: "+field)
			}
		}
		if len(issues) == 0 {
			return textResult("角色卡 " + name + " 校验通过")
		}
		return textResult("角色卡 " + name + " 发现问题：\n" + strings.Join(issues, "\n"))
	})

	register("range_validate_preset", "校验预设格式，检查 prompt 条目完整性", map[string]any{
		"presetFilePath": map[string]any{"type": "string", "description": "可选，预设文件名"},
	}, nil, func(args map[string]any) any {
		presetPath, err := s.resolveRangePresetPath(textArgRange(args, "presetFilePath"))
		if err != nil {
			return errorResult(err)
		}
		preset, err := readJSONFile(presetPath)
		if err != nil {
			return errorResult(err)
		}
		issues := []string{}
		prompts, _ := preset["prompts"].([]any)
		seen := map[string]bool{}
		for index, item := range prompts {
			entry, _ := item.(map[string]any)
			if entry == nil {
				issues = append(issues, fmt.Sprintf("prompt#%d 不是对象", index))
				continue
			}
			identifier := fmt.Sprintf("%v", entry["identifier"])
			if identifier == "" {
				issues = append(issues, fmt.Sprintf("prompt#%d 缺少 identifier", index))
			} else if seen[identifier] {
				issues = append(issues, "重复 identifier: "+identifier)
			}
			seen[identifier] = true
			if strings.TrimSpace(fmt.Sprintf("%v", entry["content"])) == "" {
				issues = append(issues, "prompt "+identifier+" content 为空")
			}
		}
		if len(issues) == 0 {
			return textResult(fmt.Sprintf("预设 %s 校验通过（%d 条 prompt）", filepath.Base(presetPath), len(prompts)))
		}
		return textResult(fmt.Sprintf("预设 %s 发现 %d 个问题：\n%s", filepath.Base(presetPath), len(issues), strings.Join(issues, "\n")))
	})

	// ---------------- AI 驱动工具 ----------------

	register("range_test", "发送测试消息到指定角色，获取 AI 回复（可传 fakeHistory 模拟记忆）", map[string]any{
		"message":         map[string]any{"type": "string", "description": "测试消息内容"},
		"characterName":   map[string]any{"type": "string", "description": "可选，角色名"},
		"modelProviderId": map[string]any{"type": "string", "description": "可选，模型供应商 ID"},
		"model":           map[string]any{"type": "string", "description": "可选，模型 ID"},
		"fakeHistory":     map[string]any{"type": "array", "description": "可选，伪造聊天记录 [{role,content}]"},
		"scopeKey":        map[string]any{"type": "string", "description": "可选，变量作用域（默认 user:test）"},
	}, []string{"message"}, func(args map[string]any) any {
		message := textArgRange(args, "message")
		characterName := orDefault(textArgRange(args, "characterName"), s.document.String("chat.defaultCharacter"))
		if characterName == "" {
			return textResult("请指定 characterName")
		}
		client := s.buildRangeAIClient(textArgRange(args, "modelProviderId"), textArgRange(args, "model"))
		if client == nil {
			return textResult("无法构建 AI 客户端，请检查 ai.providers 配置")
		}
		messages := s.buildRangeMessages(characterName, message, args["fakeHistory"])
		ctx, cancel := contextWithTimeout(120 * time.Second)
		defer cancel()
		result, err := client.Chat(ctx, messages, nil)
		if err != nil {
			return textResult("AI 调用失败: " + err.Error())
		}
		return textResult(result.Content)
	})

	register("range_analyze", "分析/评分角色回复质量，检测八股词等问题，返回修改建议", map[string]any{
		"goal":            map[string]any{"type": "string", "description": "优化目标描述"},
		"lastUserMessage": map[string]any{"type": "string", "description": "用户测试消息"},
		"lastAIResponse":  map[string]any{"type": "string", "description": "角色 AI 回复内容"},
		"characterName":   map[string]any{"type": "string", "description": "可选，角色名"},
	}, []string{"goal", "lastUserMessage", "lastAIResponse"}, func(args map[string]any) any {
		characterName := orDefault(textArgRange(args, "characterName"), s.document.String("chat.defaultCharacter"))
		prompt := fmt.Sprintf(`你是写卡优化专家。

## 优化目标: %s

## 测试结果
用户消息: %s
AI回复: %s

## 角色卡: %s

请分析回复质量（八股词、冗余描写、角色偏离），给出评分与下一轮测试建议。`,
			textArgRange(args, "goal"), textArgRange(args, "lastUserMessage"), textArgRange(args, "lastAIResponse"), characterName)
		client := s.buildRangeAIClient("", "")
		if client == nil {
			return textResult("无法构建 AI 客户端")
		}
		ctx, cancel := contextWithTimeout(120 * time.Second)
		defer cancel()
		result, err := client.Chat(ctx, []ai.Message{{Role: "user", Content: prompt}}, nil)
		if err != nil {
			return errorResult(err)
		}
		return textResult(result.Content)
	})

	register("range_batch_test", "批量发送测试消息，返回所有回复", map[string]any{
		"messages":      map[string]any{"type": "array", "description": "测试消息列表"},
		"characterName": map[string]any{"type": "string", "description": "可选，角色名"},
	}, []string{"messages"}, func(args map[string]any) any {
		characterName := orDefault(textArgRange(args, "characterName"), s.document.String("chat.defaultCharacter"))
		if characterName == "" {
			return textResult("请指定 characterName")
		}
		client := s.buildRangeAIClient("", "")
		if client == nil {
			return textResult("无法构建 AI 客户端")
		}
		outputs := []string{}
		if items, ok := args["messages"].([]any); ok {
			for index, item := range items {
				message := fmt.Sprintf("%v", item)
				messages := s.buildRangeMessages(characterName, message, nil)
				ctx, cancel := contextWithTimeout(120 * time.Second)
				result, err := client.Chat(ctx, messages, nil)
				cancel()
				if err != nil {
					outputs = append(outputs, fmt.Sprintf("## 测试 %d\n失败: %v", index+1, err))
					continue
				}
				outputs = append(outputs, fmt.Sprintf("## 测试 %d\n%s", index+1, result.Content))
			}
		}
		return textResult(strings.Join(outputs, "\n\n"))
	})

	return tools
}

// ---------------- 辅助函数 ----------------

func textArgRange(args map[string]any, key string) string {
	if value, ok := args[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

func intArgRange(args map[string]any, key string) int {
	if number, ok := args[key].(float64); ok {
		return int(number)
	}
	return 0
}

func inferRangeValueType(value any) string {
	switch value.(type) {
	case float64:
		return "number"
	case bool:
		return "boolean"
	case string:
		return "string"
	default:
		return "json"
	}
}

func wildcardMatch(pattern string, value string) bool {
	if pattern == "*" {
		return true
	}
	if index := strings.Index(pattern, "*"); index >= 0 {
		prefix := pattern[:index]
		suffix := pattern[index+1:]
		return strings.HasPrefix(value, prefix) && strings.HasSuffix(value, suffix)
	}
	return pattern == value
}

func entryKeys(entry map[string]any) []string {
	for _, key := range []string{"key", "keys"} {
		if items, ok := entry[key].([]any); ok {
			result := []string{}
			for _, item := range items {
				result = append(result, fmt.Sprintf("%v", item))
			}
			return result
		}
	}
	return nil
}

// listCharacterNames 列出角色目录。
func (s *Server) listCharacterNames() ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(s.dataDir, "characters"))
	if err != nil {
		return []string{}, nil
	}
	names := []string{}
	for _, entry := range entries {
		if !entry.IsDir() && (strings.HasSuffix(entry.Name(), ".png") || strings.HasSuffix(entry.Name(), ".json")) {
			names = append(names, strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
		}
	}
	sort.Strings(names)
	return names, nil
}

// readCharacterCard 读取角色卡（characters.Read）。
func (s *Server) readCharacterCard(name string) (map[string]any, error) {
	return s.characterCard(name)
}

// writeCharacterCard 写回角色卡 JSON。
func (s *Server) writeCharacterCard(name string, card map[string]any) error {
	safe, err := safeName(name)
	if err != nil {
		return err
	}
	return writeJSONFile(filepath.Join(s.dataDir, "characters", safe+".json"), card)
}

// readRangeWorldBook 读取世界书（文件名匹配链：<name>.json、worlds/<name>.json 等）。
func readRangeWorldBook(dataDir string, characterName string) (*rangeWorldBook, string, error) {
	if characterName == "" {
		return nil, "", fmt.Errorf("角色名不能为空")
	}
	candidates := []string{
		filepath.Join(dataDir, "worlds", characterName+".json"),
		filepath.Join(dataDir, "worlds", "world_"+characterName+".json"),
		filepath.Join(dataDir, "worlds", strings.TrimSuffix(characterName, ".png")+".json"),
	}
	for _, candidate := range candidates {
		raw, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		book := &rangeWorldBook{}
		if err := json.Unmarshal(raw, book); err != nil {
			return nil, "", fmt.Errorf("世界书解析失败: %w", err)
		}
		return book, filepath.Base(candidate), nil
	}
	// 兜底：worlds 目录下模糊匹配
	entries, _ := os.ReadDir(filepath.Join(dataDir, "worlds"))
	needle := strings.ToLower(strings.TrimSuffix(characterName, ".png"))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		if strings.Contains(strings.ToLower(entry.Name()), needle) {
			raw, err := os.ReadFile(filepath.Join(dataDir, "worlds", entry.Name()))
			if err != nil {
				continue
			}
			book := &rangeWorldBook{}
			if err := json.Unmarshal(raw, book); err != nil {
				continue
			}
			return book, entry.Name(), nil
		}
	}
	return nil, "", nil
}

// rangeWorldBook 是世界书结构。
type rangeWorldBook struct {
	Entries []map[string]any `json:"entries"`
}

// resolveRangePresetPath 解析预设文件路径（空 = 当前激活预设）。
func (s *Server) resolveRangePresetPath(name string) (string, error) {
	if name != "" {
		safe, err := safeName(name)
		if err != nil {
			return "", err
		}
		candidate := filepath.Join(s.dataDir, "presets", safe+".json")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
		return filepath.Join(s.dataDir, "presets", name), nil
	}
	active := s.document.String("bindings.global.preset")
	if active == "" {
		active = s.document.String("chat.defaultPreset")
	}
	entries, _ := os.ReadDir(filepath.Join(s.dataDir, "presets"))
	for _, entry := range entries {
		if strings.Contains(entry.Name(), active) {
			return filepath.Join(s.dataDir, "presets", entry.Name()), nil
		}
	}
	if len(entries) > 0 {
		return filepath.Join(s.dataDir, "presets", entries[0].Name()), nil
	}
	return "", fmt.Errorf("未找到任何预设文件")
}

// readRangePreset 读取预设 JSON。
func (s *Server) readRangePreset(name string) (map[string]any, error) {
	path, err := s.resolveRangePresetPath(name)
	if err != nil {
		return nil, err
	}
	return readJSONFile(path)
}

// presetStatus 提取 prompt 启用状态列表。
func presetStatus(preset map[string]any) []map[string]any {
	statuses := []map[string]any{}
	prompts, _ := preset["prompts"].([]any)
	for _, item := range prompts {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		enabled := entry["enabled"] != false
		statuses = append(statuses, map[string]any{
			"identifier": entry["identifier"],
			"name":       entry["name"],
			"enabled":    enabled,
		})
	}
	return statuses
}

// listRangeModels 列出供应商与模型。
func (s *Server) listRangeModels() ([]map[string]any, error) {
	raw := map[string]any{}
	if err := json.Unmarshal(s.document.Raw(), &raw); err != nil {
		return nil, err
	}
	aiSection, _ := raw["ai"].(map[string]any)
	providers, _ := aiSection["providers"].([]any)
	models := []map[string]any{}
	for _, item := range providers {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		models = append(models, map[string]any{
			"id": entry["id"], "name": entry["name"], "model": entry["model"],
			"baseUrl": entry["baseUrl"], "active": entry["id"] == aiSection["activeProviderId"],
		})
	}
	return models, nil
}

// buildRangeAIClient 按供应商构建 AI 客户端（空 = 主供应商）。
func (s *Server) buildRangeAIClient(providerID string, model string) *ai.Client {
	raw := map[string]any{}
	if err := json.Unmarshal(s.document.Raw(), &raw); err != nil {
		return nil
	}
	aiSection, _ := raw["ai"].(map[string]any)
	if aiSection == nil {
		return nil
	}
	if providerID == "" {
		providerID, _ = aiSection["activeProviderId"].(string)
	}
	providers, _ := aiSection["providers"].([]any)
	for _, item := range providers {
		entry, _ := item.(map[string]any)
		if entry == nil || fmt.Sprintf("%v", entry["id"]) != providerID {
			continue
		}
		baseURL, _ := entry["baseUrl"].(string)
		apiKey, _ := entry["apiKey"].(string)
		resolvedModel := model
		if resolvedModel == "" {
			resolvedModel, _ = entry["model"].(string)
		}
		if strings.TrimSpace(baseURL) == "" {
			return nil
		}
		timeout, _ := aiSection["timeout"].(float64)
		if timeout <= 0 {
			timeout = 120
		}
		return ai.New(ai.Provider{Model: resolvedModel, BaseURL: baseURL, APIKey: apiKey, Timeout: time.Duration(timeout) * time.Second})
	}
	return nil
}

// buildRangeMessages 构建靶场测试消息（简化管线：角色卡字段 + 世界书常驻条目 + fakeHistory）。
func (s *Server) buildRangeMessages(characterName string, message string, fakeHistory any) []ai.Message {
	messages := []ai.Message{}
	system := []string{}
	if card, err := s.readCharacterCard(characterName); err == nil && card != nil {
		for _, field := range []string{"system_prompt", "description", "personality", "scenario"} {
			if text := strings.TrimSpace(fmt.Sprintf("%v", card[field])); text != "" && text != "<nil>" {
				system = append(system, text)
			}
		}
	}
	if book, _, err := readRangeWorldBook(s.dataDir, characterName); err == nil && book != nil {
		for _, entry := range book.Entries {
			if entry["constant"] == true {
				system = append(system, fmt.Sprintf("%v", entry["content"]))
			}
		}
	}
	if len(system) > 0 {
		messages = append(messages, ai.Message{Role: "system", Content: strings.Join(system, "\n\n")})
	}
	if history, ok := fakeHistory.([]any); ok {
		for _, item := range history {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			role, _ := entry["role"].(string)
			if role != "assistant" {
				role = "user"
			}
			messages = append(messages, ai.Message{Role: role, Content: fmt.Sprintf("%v", entry["content"])})
		}
	}
	return messages
}

// readJSONFile / writeJSONFile 文件读写。
func readJSONFile(path string) (map[string]any, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("JSON 解析失败: %w", err)
	}
	return payload, nil
}

func writeJSONFile(path string, payload map[string]any) error {
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, encoded, 0o644)
}

// characterCard 读取角色卡。
func (s *Server) characterCard(name string) (map[string]any, error) {
	safe, err := safeName(name)
	if err != nil {
		return nil, err
	}
	return readJSONFile(filepath.Join(s.dataDir, "characters", safe+".json"))
}

// contextWithTimeout 包装。
func contextWithTimeout(d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), d)
}

// handleMCPRange JSON-RPC 调度（initialize/tools/list/tools/call/ping）。
func (s *Server) handleMCPRange(writer http.ResponseWriter, request *http.Request) {
	tools := s.buildRangeService()
	var rpc struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			Name      string         `json:"name"`
			Arguments map[string]any `json:"arguments"`
		} `json:"params"`
	}
	if err := json.NewDecoder(request.Body).Decode(&rpc); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"jsonrpc": "2.0", "id": nil,
			"error": map[string]any{"code": -32700, "message": "JSON 解析失败"},
		})
		return
	}
	reply := func(result any) {
		writeJSON(writer, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": rpc.ID, "result": result})
	}
	rpcError := func(code int, message string) {
		writeJSON(writer, http.StatusOK, map[string]any{
			"jsonrpc": "2.0", "id": rpc.ID,
			"error": map[string]any{"code": code, "message": message},
		})
	}
	switch rpc.Method {
	case "initialize":
		reply(map[string]any{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "mimirlink-range", "version": "1.0.0"},
		})
	case "notifications/initialized":
		writeJSON(writer, http.StatusAccepted, map[string]any{})
	case "tools/list":
		toolList := []map[string]any{}
		names := make([]string, 0, len(tools))
		for name := range tools {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			tool := tools[name]
			toolList = append(toolList, map[string]any{
				"name":        name,
				"description": tool.Description,
				"inputSchema": tool.Schema,
			})
		}
		reply(map[string]any{"tools": toolList})
	case "tools/call":
		tool, ok := tools[rpc.Params.Name]
		if !ok {
			rpcError(-32601, "Tool not found: "+rpc.Params.Name)
			return
		}
		arguments := rpc.Params.Arguments
		if arguments == nil {
			arguments = map[string]any{}
		}
		reply(tool.Handler(arguments))
	case "ping":
		reply(map[string]any{})
	default:
		rpcError(-32601, "Method not found: "+rpc.Method)
	}
}
