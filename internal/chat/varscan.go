package chat

import (
	"regexp"
	"strconv"
	"strings"
)

// 本文件移植 Node src/variable-bridge.js 的 scanVariableUsage：
// 扫描角色卡/预设/世界书文本里的变量读写用法，供面板「角色卡详情」展示变量玩法扫描结果。

var (
	varScanGetMessageRegex = regexp.MustCompile(`\{\{\s*get_message_variable::([^}]+)\}\}`)
	varScanGetvarRegex     = regexp.MustCompile(`\{\{\s*getvar::([^}:]+)(?:::[^}]*)?\}\}`)
	varScanSetvarRegex     = regexp.MustCompile(`\{\{\s*setvar::([^:}]+)::([^}]*)\}\}`)
	varScanUpdateVarRegex  = regexp.MustCompile(`<\s*UpdateVariable\s*>`)
	varScanJSONPatchRegex  = regexp.MustCompile(`(?i)JSONPatch`)
	varScanMVURegex        = regexp.MustCompile(`(?i)\bMVU\b|mvu_`)
	varScanScriptRegex     = regexp.MustCompile(`(?i)type\s*[:=]\s*["']script["']|\bJS_CODE\b`)
)

// ScanVariableUsage 扫描变量用法（与 Node scanVariableUsage 返回形状一致）。
func ScanVariableUsage(sources []map[string]string) map[string]any {
	reads := []map[string]any{}
	writes := []map[string]any{}
	unsupported := []map[string]any{}
	hasUpdateVariable := false
	hasJSONPatch := false
	hasMVU := false

	seenReads := map[string]bool{}
	seenWrites := map[string]bool{}
	seenUnsupported := map[string]bool{}

	for _, source := range sources {
		name := strings.TrimSpace(source["name"])
		text := source["content"]
		if strings.TrimSpace(text) == "" {
			continue
		}
		for _, match := range varScanGetMessageRegex.FindAllStringSubmatch(text, -1) {
			rawKey := strings.TrimSpace(match[1])
			if rawKey == "" {
				continue
			}
			key := normalizeVariableLookupKey(rawKey)
			signature := "get_message_variable::" + key + "::" + name
			if seenReads[signature] {
				continue
			}
			seenReads[signature] = true
			reads = append(reads, map[string]any{"type": "get_message_variable", "key": key, "rawKey": rawKey, "source": name})
		}
		for _, match := range varScanGetvarRegex.FindAllStringSubmatch(text, -1) {
			rawKey := strings.TrimSpace(match[1])
			if rawKey == "" {
				continue
			}
			key := normalizeVariableLookupKey(rawKey)
			signature := "getvar::" + key + "::" + name
			if seenReads[signature] {
				continue
			}
			seenReads[signature] = true
			reads = append(reads, map[string]any{"type": "getvar", "key": key, "rawKey": rawKey, "source": name})
		}
		for _, match := range varScanSetvarRegex.FindAllStringSubmatch(text, -1) {
			rawKey := strings.TrimSpace(match[1])
			rawValue := strings.TrimSpace(match[2])
			if rawKey == "" {
				continue
			}
			key := normalizeVariableLookupKey(rawKey)
			signature := key + "::" + rawValue + "::" + name
			if seenWrites[signature] {
				continue
			}
			seenWrites[signature] = true
			writes = append(writes, map[string]any{
				"type": "setvar", "key": key, "rawKey": rawKey, "rawValue": rawValue,
				"parsedValue": parseVariableLiteral(rawValue), "source": name,
			})
		}
		if varScanUpdateVarRegex.MatchString(text) {
			hasUpdateVariable = true
		}
		if varScanJSONPatchRegex.MatchString(text) {
			hasJSONPatch = true
		}
		if varScanMVURegex.MatchString(text) {
			hasMVU = true
		}
		if varScanScriptRegex.MatchString(text) {
			signature := "script_runtime::" + name
			if !seenUnsupported[signature] {
				seenUnsupported[signature] = true
				unsupported = append(unsupported, map[string]any{"type": "script_runtime", "source": name})
			}
		}
	}

	return map[string]any{
		"reads":       reads,
		"writes":      writes,
		"unsupported": unsupported,
		"updateProtocol": map[string]any{
			"hasUpdateVariable": hasUpdateVariable,
			"hasJsonPatch":      hasJSONPatch,
			"hasMVU":            hasMVU,
		},
	}
}

// normalizeVariableLookupKey 对齐 Node normalizeLookupKey。
func normalizeVariableLookupKey(key string) string {
	cleaned := strings.TrimSpace(key)
	cleaned = strings.TrimPrefix(cleaned, "/")
	return strings.ReplaceAll(cleaned, "/", ".")
}

var numericLiteralPattern = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

// parseVariableLiteral 对齐 Node parseLiteralValue（true/false、数字、其余按字符串）。
func parseVariableLiteral(raw string) any {
	value := strings.TrimSpace(raw)
	switch strings.ToLower(value) {
	case "":
		return ""
	case "true":
		return true
	case "false":
		return false
	}
	if numericLiteralPattern.MatchString(value) {
		if strings.Contains(value, ".") {
			if parsed, err := strconv.ParseFloat(value, 64); err == nil {
				return parsed
			}
			return value
		}
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil {
			return float64(parsed)
		}
	}
	return value
}
