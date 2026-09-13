// Package panel 实现与 Node 版一致的配置读写视图（脱敏下发 + 哨兵值合并）。
package panel

import (
	"encoding/json"
	"fmt"
	"strings"

	"mimirlink/internal/config"
)

const maskValue = "******"

// DefaultImageCaptionPrompt 与 Node 版 src/image-input.js 保持一致。
const DefaultImageCaptionPrompt = "用中文描述这些图片的内容。"

func asMap(value any) map[string]any {
	if mapped, ok := value.(map[string]any); ok {
		return mapped
	}
	return map[string]any{}
}

func asList(value any) []any {
	if items, ok := value.([]any); ok {
		return items
	}
	return []any{}
}

func asString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func nonEmpty(value any) bool {
	return asString(value) != ""
}

// BuildSafeConfig 生成下发给前端的配置视图：密钥只保留"是否已配置"。
func BuildSafeConfig(document *config.Document) (map[string]any, error) {
	var raw map[string]any
	if err := json.Unmarshal(document.Raw(), &raw); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}

	if auth := asMap(raw["auth"]); auth != nil {
		passwordSet := nonEmpty(auth["password"])
		sessionSecretSet := nonEmpty(auth["sessionSecret"])
		delete(auth, "password")
		delete(auth, "sessionSecret")
		auth["passwordSet"] = passwordSet
		auth["sessionSecretSet"] = sessionSecretSet
		raw["auth"] = auth
	}

	if onebot := asMap(raw["onebot"]); onebot != nil {
		hasAccessToken := nonEmpty(onebot["accessToken"])
		delete(onebot, "accessToken")
		onebot["hasAccessToken"] = hasAccessToken
		raw["onebot"] = onebot
	}

	if mcp := asMap(raw["mcp"]); mcp != nil {
		hasToken := nonEmpty(mcp["token"])
		if hasToken {
			mcp["token"] = maskValue
		} else {
			mcp["token"] = ""
		}
		mcp["hasToken"] = hasToken
		if client := asMap(mcp["client"]); client != nil {
			servers := asList(client["servers"])
			safeServers := make([]any, 0, len(servers))
			for _, item := range servers {
				safeServers = append(safeServers, maskServer(asMap(item)))
			}
			client["servers"] = safeServers
			mcp["client"] = client
		}
		raw["mcp"] = mcp
	}

	if chat := asMap(raw["chat"]); chat != nil {
		if music := asMap(chat["music"]); music != nil {
			hasApiKey := nonEmpty(music["apiKey"])
			delete(music, "apiKey")
			music["hasApiKey"] = hasApiKey
			chat["music"] = music
		}
		chat["imageCaptionPromptDefault"] = DefaultImageCaptionPrompt
		raw["chat"] = chat
	}

	if imports := asMap(raw["imports"]); imports != nil {
		presetFiles := asList(imports["presetFiles"])
		summarizedPresets := make([]any, 0, len(presetFiles))
		for _, item := range presetFiles {
			summarizedPresets = append(summarizedPresets, summarizePresetRecord(asMap(item)))
		}
		imports["presetFiles"] = summarizedPresets
		regexFiles := asList(imports["regexFiles"])
		summarizedRegex := make([]any, 0, len(regexFiles))
		for _, item := range regexFiles {
			summarizedRegex = append(summarizedRegex, summarizeRegexRecord(asMap(item)))
		}
		imports["regexFiles"] = summarizedRegex
		raw["imports"] = imports
	}

	if ai := asMap(raw["ai"]); ai != nil {
		hasApiKey := nonEmpty(ai["apiKey"])
		delete(ai, "apiKey")
		ai["hasApiKey"] = hasApiKey
		providers := asList(ai["providers"])
		safeProviders := make([]any, 0, len(providers))
		for _, item := range providers {
			provider := asMap(item)
			hasProviderKey := nonEmpty(provider["apiKey"])
			delete(provider, "apiKey")
			provider["hasApiKey"] = hasProviderKey
			safeProviders = append(safeProviders, provider)
		}
		ai["providers"] = safeProviders
		tools := asMap(ai["tools"])
		webSearch := asMap(tools["webSearch"])
		legacyKey := nonEmpty(webSearch["apiKey"])
		delete(webSearch, "apiKey")
		apiKeys := asMap(webSearch["apiKeys"])
		anyKey := legacyKey
		safeKeys := map[string]any{}
		for _, provider := range []string{"tavily", "brave", "serpapi"} {
			value := asString(apiKeys[provider])
			if value != "" {
				safeKeys[provider] = maskValue
				anyKey = true
			} else {
				safeKeys[provider] = ""
			}
		}
		webSearch["apiKeys"] = safeKeys
		webSearch["hasApiKey"] = anyKey
		tools["webSearch"] = webSearch
		ai["tools"] = tools
		raw["ai"] = ai
	}

	if tts := asMap(raw["tts"]); tts != nil {
		hasApiKey := nonEmpty(tts["apiKey"])
		delete(tts, "apiKey")
		tts["hasApiKey"] = hasApiKey
		raw["tts"] = tts
	}

	if memory := asMap(raw["memory"]); memory != nil {
		if profile := asMap(memory["participantProfile"]); profile != nil {
			delete(profile, "apiKey")
			delete(profile, "baseUrl")
			profile["hasApiKey"] = false
			memory["participantProfile"] = profile
		}
		raw["memory"] = memory
	}

	return raw, nil
}

func maskServer(server map[string]any) map[string]any {
	maskedEnv := maskStringMap(asMap(server["env"]))
	maskedHeaders := maskStringMap(asMap(server["headers"]))
	server["env"] = maskedEnv
	server["headers"] = maskedHeaders
	server["hasEnv"] = hasAnyValue(maskedEnv)
	server["hasHeaders"] = hasAnyValue(maskedHeaders)
	return server
}

func maskStringMap(source map[string]any) map[string]any {
	masked := map[string]any{}
	for key, value := range source {
		if nonEmpty(value) {
			masked[key] = maskValue
		} else {
			masked[key] = ""
		}
	}
	return masked
}

func hasAnyValue(source map[string]any) bool {
	for _, value := range source {
		if nonEmpty(value) {
			return true
		}
	}
	return false
}

func summarizePresetRecord(record map[string]any) map[string]any {
	importedRegex := asList(record["importedRegexRules"])
	return map[string]any{
		"id":                  record["id"],
		"filename":            record["filename"],
		"presetName":          valueOrNil(record["presetName"]),
		"createdAt":           record["createdAt"],
		"importedFields":      asList(record["importedFields"]),
		"importedPreset":      valueOrEmpty(record["importedPreset"]),
		"importedRegexCount":  len(importedRegex),
		"linkedRegexImportId": valueOrNil(record["linkedRegexImportId"]),
	}
}

func summarizeRegexRecord(record map[string]any) map[string]any {
	importedRules := asList(record["importedRules"])
	return map[string]any{
		"id":             record["id"],
		"filename":       record["filename"],
		"createdAt":      record["createdAt"],
		"targetLayer":    valueOr(record["targetLayer"], "global"),
		"sourceType":     valueOr(record["sourceType"], "regex"),
		"presetImportId": valueOrNil(record["presetImportId"]),
		"importedRules":  importedRules,
		"importedCount":  len(importedRules),
	}
}

func valueOrNil(value any) any {
	if text := asString(value); text == "" {
		return nil
	}
	return value
}

func valueOrEmpty(value any) any {
	if value == nil {
		return map[string]any{}
	}
	return value
}

func valueOr(value any, fallback string) any {
	if text := asString(value); text == "" {
		return fallback
	}
	return value
}

// StripClientOnlyFlags 移除前端专用字段（保存前调用）。
func StripClientOnlyFlags(value any) {
	switch typed := value.(type) {
	case map[string]any:
		for _, key := range []string{"hasApiKey", "hasSavedApiKey", "hasAccessToken", "passwordSet", "sessionSecretSet", "imageCaptionPromptDefault"} {
			delete(typed, key)
		}
		for _, child := range typed {
			StripClientOnlyFlags(child)
		}
	case []any:
		for _, item := range typed {
			StripClientOnlyFlags(item)
		}
	}
}

// MergeIncomingConfig 把前端提交的配置合并进当前配置（哨兵值 ****** 表示沿用旧值）。
func MergeIncomingConfig(document *config.Document, incoming map[string]any) error {
	StripClientOnlyFlags(incoming)

	// onebot.accessToken
	if onebot := asMap(incoming["onebot"]); onebot != nil {
		if asString(onebot["accessToken"]) == maskValue {
			delete(onebot, "accessToken")
		}
	}
	// ai.apiKey / providers[].apiKey / webSearch.apiKeys
	if ai := asMap(incoming["ai"]); ai != nil {
		if asString(ai["apiKey"]) == maskValue {
			delete(ai, "apiKey")
		}
		if providers, ok := ai["providers"].([]any); ok {
			existing := map[string]map[string]any{}
			for _, item := range asList(documentValue(document, "ai.providers")) {
				provider := asMap(item)
				existing[asString(provider["id"])] = provider
			}
			for _, item := range providers {
				provider := asMap(item)
				if asString(provider["apiKey"]) == maskValue {
					id := asString(provider["id"])
					replacement := ""
					if current, ok := existing[id]; ok {
						replacement = asString(current["apiKey"])
					}
					provider["apiKey"] = replacement
				}
			}
		}
		if tools := asMap(ai["tools"]); tools != nil {
			if webSearch := asMap(tools["webSearch"]); webSearch != nil {
				if keys := asMap(webSearch["apiKeys"]); keys != nil {
					currentKeys := asMap(documentValue(document, "ai.tools.webSearch.apiKeys"))
					for _, provider := range []string{"tavily", "brave", "serpapi"} {
						if asString(keys[provider]) == maskValue {
							keys[provider] = asString(currentKeys[provider])
						}
					}
				}
			}
		}
	}
	// mcp.token 与 client.servers 的 env/headers（****** 沿用旧值，缺失键视为删除）
	if mcp := asMap(incoming["mcp"]); mcp != nil {
		if asString(mcp["token"]) == maskValue {
			mcp["token"] = asString(documentValue(document, "mcp.token"))
		}
		if client := asMap(mcp["client"]); client != nil {
			if servers, ok := client["servers"].([]any); ok {
				existingServers := asList(documentValue(document, "mcp.client.servers"))
				currentByName := map[string]map[string]any{}
				for _, item := range existingServers {
					server := asMap(item)
					currentByName[asString(server["name"])] = server
				}
				for _, item := range servers {
					server := asMap(item)
					current := currentByName[asString(server["name"])]
					mergeSecretMap(server, "env", current)
					mergeSecretMap(server, "headers", current)
				}
			}
		}
	}
	// MCP 客户端服务器由专用端点管理，主配置保存沿用当前 servers（与 Node 版一致）
	if mcp := asMap(incoming["mcp"]); mcp != nil {
		if client := asMap(mcp["client"]); client != nil {
			if _, exists := client["servers"]; exists {
				client["servers"] = documentValue(document, "mcp.client.servers")
			}
		}
		// 令牌留空表示不修改
		if token, ok := mcp["token"].(string); !ok || strings.TrimSpace(token) == "" {
			mcp["token"] = document.String("mcp.token")
		}
	}
	// tts.apiKey
	if tts := asMap(incoming["tts"]); tts != nil {
		if asString(tts["apiKey"]) == maskValue {
			tts["apiKey"] = asString(documentValue(document, "tts.apiKey"))
		}
	}

	// 深度合并：与 Node 版 mergeConfig 一致——对象递归合并、标量/数组直接覆盖，
	// 提交中缺失的键（例如被脱敏删掉的 ai.apiKey / auth.password）保持原值。
	return deepMergeConfig(document, "", incoming)
}

// escapeConfigKey 转义 sjson 路径中的特殊字符（键里可能带点号）。
func escapeConfigKey(key string) string {
	replacer := strings.NewReplacer("\\", "\\\\", ".", "\\.", "*", "\\*", "?", "\\?", "|", "\\|")
	return replacer.Replace(key)
}

func deepMergeConfig(document *config.Document, basePath string, incoming map[string]any) error {
	for key, value := range incoming {
		path := escapeConfigKey(key)
		if basePath != "" {
			path = basePath + "." + path
		}
		if mapped, ok := value.(map[string]any); ok {
			if err := deepMergeConfig(document, path, mapped); err != nil {
				return err
			}
			continue
		}
		if err := document.Set(path, value); err != nil {
			return err
		}
	}
	return nil
}

func mergeSecretMap(server map[string]any, field string, current map[string]any) {
	incomingMap, ok := server[field].(map[string]any)
	if !ok {
		return
	}
	currentMap := map[string]any{}
	if current != nil {
		currentMap = asMap(current[field])
	}
	merged := map[string]any{}
	for key, value := range incomingMap {
		if asString(value) == maskValue {
			merged[key] = asString(currentMap[key])
			continue
		}
		merged[key] = value
	}
	server[field] = merged
}

func documentValue(document *config.Document, path string) any {
	result := document.Get(path)
	if !result.Exists() {
		return nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(result.Raw), &decoded); err != nil {
		return nil
	}
	return decoded
}

// NormalizePath 便于日志输出（去掉多余斜杠）。
func NormalizePath(path string) string {
	return strings.TrimSpace(path)
}
