package chat

import (
	"strings"

	"mimirlink/internal/config"
)

// 本文件为面板提供正则规则的展示/导出视图（对齐 Node RegexProcessor.getRules 与 exportRules）。

// PanelRules 返回合并后的规则列表（含预设默认规则与各绑定层规则），并剔除两条内置输出规则。
// Node 的 getRules() 会过滤掉 source === 'built-in' 的规则，导出即基于该结果。
func PanelRules(document *config.Document) []map[string]any {
	if document == nil {
		return []map[string]any{}
	}
	processor := newRegexProcessor(document.Raw())
	rules := []map[string]any{}
	for _, rule := range processor.rules {
		if rule.builtin {
			continue
		}
		rules = append(rules, map[string]any{
			"name":         rule.Name,
			"pattern":      rule.Pattern,
			"flags":        rule.Flags,
			"replacement":  rule.Replacement,
			"enabled":      rule.Enabled,
			"description":  rule.Description,
			"stage":        normalizeRuleStage(rule.Stage, rule.PromptOnly),
			"source":       "custom",
			"markdownOnly": rule.MarkdownOnly,
			"promptOnly":   rule.PromptOnly,
			"minDepth":     rule.MinDepth,
			"maxDepth":     rule.MaxDepth,
		})
	}
	return rules
}

// ExportRules 生成导出载荷（对齐 Node RegexProcessor.exportRules）。
func ExportRules(document *config.Document, format string) map[string]any {
	rules := PanelRules(document)
	if strings.EqualFold(format, "sillytavern") {
		exported := []map[string]any{}
		for _, rule := range rules {
			placement := 2
			if normalizeRuleStage(stringOf(rule["stage"]), rule["promptOnly"] == true) == "input" {
				placement = 1
			}
			exported = append(exported, map[string]any{
				"scriptName":    rule["name"],
				"findRegex":     rule["pattern"],
				"replaceString": rule["replacement"],
				"trimStrings":   []any{},
				"placement":     placement,
				"disabled":      rule["enabled"] == false,
				"markdownOnly":  rule["markdownOnly"] == true,
				"promptOnly":    rule["promptOnly"] == true || placement == 1,
				"runOnEdit":     false,
				"minDepth":      rule["minDepth"],
				"maxDepth":      rule["maxDepth"],
			})
		}
		return map[string]any{"version": 1, "type": "regex", "rules": exported}
	}
	return map[string]any{"version": 1, "type": "regex", "rules": rules}
}

// NormalizeImportedRules 归一化导入规则（对齐 Node RegexProcessor.normalizeImportedRule）。
// 支持原生格式 {name,pattern,replacement} 与 SillyTavern 格式 {scriptName,findRegex,replaceString,placement}。
func NormalizeImportedRules(payload map[string]any) []map[string]any {
	items := []any{}
	switch {
	case payload == nil:
		return []map[string]any{}
	case isArray(payload["rules"]):
		items, _ = payload["rules"].([]any)
	case isArray(payload["regex"]):
		items, _ = payload["regex"].([]any)
	case isArray(payload["regex_scripts"]):
		items, _ = payload["regex_scripts"].([]any)
	default:
		if extensions, ok := payload["extensions"].(map[string]any); ok {
			if isArray(extensions["regex_scripts"]) {
				items, _ = extensions["regex_scripts"].([]any)
			}
		}
	}
	result := []map[string]any{}
	for index, raw := range items {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			continue
		}
		pattern := firstNonEmptyString(stringOf(entry["pattern"]), stringOf(entry["findRegex"]), stringOf(entry["match"]))
		if strings.TrimSpace(pattern) == "" {
			continue
		}
		flags := stringOr(entry["flags"], "g")
		if delimited := delimitedRegexPattern.FindStringSubmatch(pattern); delimited != nil {
			pattern = delimited[1]
			if delimited[2] != "" {
				flags = delimited[2]
			}
		}
		promptOnly := entry["promptOnly"] == true
		stage := stringOf(entry["stage"])
		switch placement := entry["placement"].(type) {
		case float64:
			if placement == 2 {
				stage = "output"
			} else if placement == 1 {
				stage = "input"
			}
		case string:
			stage = placement
		}
		name := firstNonEmptyString(stringOf(entry["name"]), stringOf(entry["scriptName"]))
		if name == "" {
			name = "Imported Rule " + itoa(index+1)
		}
		result = append(result, map[string]any{
			"name":         name,
			"pattern":      pattern,
			"flags":        flags,
			"replacement":  firstNonEmptyString(stringOf(entry["replacement"]), stringOf(entry["replaceString"])),
			"enabled":      entry["enabled"] != false && entry["disabled"] != true,
			"description":  firstNonEmptyString(stringOf(entry["description"]), stringOf(entry["comment"])),
			"stage":        normalizeRuleStage(stage, promptOnly),
			"source":       orDefaultRule(stringOf(entry["source"]), "imported"),
			"markdownOnly": entry["markdownOnly"] == true,
			"promptOnly":   promptOnly,
			"minDepth":     entry["minDepth"],
			"maxDepth":     entry["maxDepth"],
		})
	}
	return result
}

func isArray(value any) bool {
	_, ok := value.([]any)
	return ok
}

func orDefaultRule(value string, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
