package chat

import (
	"encoding/json"
	"regexp"
	"strings"
)

// 本文件移植 Node src/prompt.js 的 partitionPromptItems（四段提示注入）
// 与 src/regex.js 的 RegexProcessor（输入/输出正则管线）。

// promptItem 是归一化后的预设提示词条目（对齐 Node createPromptItem 默认值）。
type promptItem struct {
	Identifier        string
	Name              string
	Role              string
	Content           string
	Enabled           bool
	InjectionPosition int
	InjectionDepth    int
	Marker            bool
}

// promptPartition 是四段切分结果（对齐 Node partitionPromptItems）。
type promptPartition struct {
	PreSystem        []promptItem // injection_position != 1 且 depth <= 0
	HistoryInjection []promptItem // injection_position != 1 且 depth > 0
	PostHistory      []promptItem // injection_position == 1
	AssistantPrefill []promptItem // role == assistant
}

// normalizePromptItem 对齐 Node createPromptItem 的默认值与类型宽容。
func normalizePromptItem(raw map[string]any) promptItem {
	item := promptItem{
		Identifier:        strings.TrimSpace(stringOf(raw["identifier"])),
		Name:              strings.TrimSpace(stringOf(raw["name"])),
		Role:              strings.TrimSpace(stringOr(raw["role"], "system")),
		Content:           stringOf(raw["content"]),
		Enabled:           boolOr(raw["enabled"], true),
		InjectionPosition: intOr(raw["injection_position"], 0),
		InjectionDepth:    intOr(raw["injection_depth"], 0),
		Marker:            boolOr(raw["marker"], false),
	}
	if item.Role != "system" && item.Role != "user" && item.Role != "assistant" {
		item.Role = "system"
	}
	return item
}

// partitionPromptItems 对齐 Node PromptBuilder.partitionPromptItems。
func partitionPromptItems(preset map[string]any) promptPartition {
	partition := promptPartition{}
	if preset == nil {
		return partition
	}
	enabled := preset["enabled"] == true
	rawItems, _ := preset["prompts"].([]any)
	if !enabled || len(rawItems) == 0 {
		return partition
	}
	for _, raw := range rawItems {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			continue
		}
		item := normalizePromptItem(entry)
		if !item.Enabled || strings.TrimSpace(item.Content) == "" {
			continue
		}
		switch {
		case item.Role == "assistant":
			partition.AssistantPrefill = append(partition.AssistantPrefill, item)
		case item.InjectionPosition == 1:
			partition.PostHistory = append(partition.PostHistory, item)
		case item.InjectionDepth > 0:
			partition.HistoryInjection = append(partition.HistoryInjection, item)
		default:
			partition.PreSystem = append(partition.PreSystem, item)
		}
	}
	return partition
}

// parsePreset 从 config 文档原始字节解析 preset 对象。
func parsePreset(rawJSON []byte) map[string]any {
	var document map[string]any
	if err := json.Unmarshal(rawJSON, &document); err != nil {
		return nil
	}
	preset, _ := document["preset"].(map[string]any)
	return preset
}

// ---------------- 正则管线（移植 src/regex.js） ----------------

// regexRule 是归一化后的正则规则。
type regexRule struct {
	Name         string `json:"name"`
	Pattern      string `json:"pattern"`
	Flags        string `json:"flags"`
	Replacement  string `json:"replacement"`
	Enabled      bool   `json:"enabled"`
	Stage        string `json:"stage"` // input | output
	Description  string `json:"description,omitempty"`
	MarkdownOnly bool   `json:"markdownOnly"`
	PromptOnly   bool   `json:"promptOnly"`
	MinDepth     *int   `json:"minDepth"`
	MaxDepth     *int   `json:"maxDepth"`
	builtin      bool
	compiled     *regexp.Regexp
	compileErr   error
}

// builtinPresetRules 对齐 Node regex.js 的 presetRules 内置规则（保持 enabled 默认）。
func builtinPresetRules() []regexRule {
	disabled := false
	return []regexRule{
		{Name: "移除思考标签", Pattern: `<thinking>[\s\S]*?</thinking>`, Flags: "gi", Stage: "output", Enabled: true, Replacement: "", Description: "移除 AI 回复中的思考过程标签"},
		{Name: "移除 OC 标记", Pattern: `\(OOC:.*?\)`, Flags: "gi", Stage: "output", Enabled: disabled, Description: "移除 Out of Character 标记"},
		{Name: "移除角色名前缀", Pattern: `^[^:：]+[:：]\s*`, Flags: "m", Stage: "output", Enabled: disabled, Description: "移除回复开头的角色名前缀"},
		{Name: "移除多余空行", Pattern: `\n{3,}`, Flags: "g", Stage: "output", Enabled: true, Replacement: "\n\n", Description: "将连续多个空行压缩为两个"},
		{Name: "移除首尾空白", Pattern: `^\s+|\s+$`, Flags: "g", Stage: "output", Enabled: true, Description: "移除文本首尾的空白字符"},
	}
}

// builtinOutputRules 对齐 Node updateConfig 里追加的两条内置输出规则。
func builtinOutputRules() []regexRule {
	return []regexRule{
		{Name: "【内置】移除当前消息焦点泄漏", builtin: true, Pattern: `^[ \t]*事件:\s*[^\r\n]*(?:\r?\n[ \t]*(?:发言人|意图|回复目标|触发|低信息|最新输入|策略):[^\r\n]*){1,7}(?:\r?\n)?|\r?\n[ \t]*事件:\s*[^\r\n]*(?:\r?\n[ \t]*(?:发言人|意图|回复目标|触发|低信息|最新输入|策略):[^\r\n]*){1,7}`, Flags: "g", Replacement: "", Stage: "output", Enabled: true},
		{Name: "【内置】去除思考链标签", builtin: true, Pattern: `<thinking>[\s\S]*?</thinking>`, Flags: "g", Replacement: "", Stage: "output", Enabled: true},
	}
}

// delimitedRegexPattern 匹配 /pattern/flags 形式。
var delimitedRegexPattern = regexp.MustCompile(`^/(.*)/([a-z]*)$`)

// normalizeRuleStage 对齐 Node RegexProcessor.normalizeRuleStage。
func normalizeRuleStage(stage string, promptOnly bool) string {
	if promptOnly {
		return "input"
	}
	normalized := strings.ToLower(strings.TrimSpace(stage))
	switch normalized {
	case "input", "prompt", "user_input", "before_prompt", "before_generation":
		return "input"
	default:
		return "output"
	}
}

// parseJSFlags 把 JS 正则 flags 转成 Go regexp 内联 flags。
func parseJSFlags(flags string) string {
	builder := strings.Builder{}
	for _, flag := range flags {
		switch flag {
		case 'i':
			builder.WriteByte('i')
		case 's':
			builder.WriteByte('s')
		case 'm':
			builder.WriteByte('m')
		}
	}
	if builder.Len() == 0 {
		return ""
	}
	return "(?" + builder.String() + ")"
}

// convertJSReplacement 把 JS 替换串的 $& 转为 Go 的 ${0}（$1/$$ 两边语义一致）。
func convertJSReplacement(replacement string) string {
	return strings.ReplaceAll(replacement, "$&", "${0}")
}

// parseRuleList 把 config 里的规则数组转成 regexRule 并预编译。
func parseRuleList(raw any) []regexRule {
	items, _ := raw.([]any)
	rules := make([]regexRule, 0, len(items))
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		rule := regexRule{
			Name:         stringOr(entry["name"], ""),
			Pattern:      stringOr(entry["pattern"], ""),
			Flags:        stringOr(entry["flags"], "g"),
			Replacement:  rawString(entry["replacement"]),
			Enabled:      boolOr(entry["enabled"], true),
			Stage:        normalizeRuleStage(stringOr(entry["stage"], ""), boolOr(entry["promptOnly"], false)),
			MarkdownOnly: boolOr(entry["markdownOnly"], false),
			PromptOnly:   boolOr(entry["promptOnly"], false),
		}
		if rule.Pattern == "" {
			continue
		}
		rule.compile()
		rules = append(rules, rule)
	}
	return rules
}

func (r *regexRule) compile() {
	pattern := parseJSFlags(r.Flags) + r.Pattern
	compiled, err := regexp.Compile(pattern)
	if err != nil {
		r.compileErr = err
		return
	}
	r.compiled = compiled
}

// regexProcessor 对齐 Node RegexProcessor 的规则合并顺序与执行语义。
type regexProcessor struct {
	enabled bool
	rules   []regexRule
}

// newRegexProcessor 对齐 Node updateConfig 的合并顺序：
// usePresetRules ? [presetRules, globalRules, presetBound, characterRules] : [globalRules, characterRules]，
// 末尾追加两条内置输出规则。
func newRegexProcessor(rawJSON []byte) *regexProcessor {
	var document map[string]any
	_ = json.Unmarshal(rawJSON, &document)
	regexConfig, _ := document["regex"].(map[string]any)

	globalRules := parseRuleList(orValue(orValue(orValue(regexConfig["globalRules"], regexConfig["rules"]), nil), nil))
	presetBound := parseRuleList(regexConfig["presetRules"])
	characterRules := parseRuleList(regexConfig["characterRules"])

	// 角色绑定层：bindings.<character>.regexRules 与 bindings.global.regexRules
	bindings, _ := document["bindings"].(map[string]any)
	if globalBinding, ok := bindings["global"].(map[string]any); ok {
		if len(globalRules) == 0 {
			globalRules = parseRuleList(globalBinding["regexRules"])
		}
	}
	if len(characterRules) == 0 {
		characterName := ""
		if document != nil {
			if chat, ok := document["chat"].(map[string]any); ok {
				characterName = stringOr(chat["defaultCharacter"], "")
			}
		}
		if characterName != "" {
			if binding, ok := bindings[characterName].(map[string]any); ok {
				characterRules = parseRuleList(binding["regexRules"])
			}
		}
	}

	usePreset := boolOr(regexConfig["usePresetRules"], true)
	enabled := boolOr(regexConfig["enabled"], true)
	var merged []regexRule
	if usePreset {
		merged = append(merged, builtinPresetRules()...)
		merged = append(merged, globalRules...)
		merged = append(merged, presetBound...)
		merged = append(merged, characterRules...)
	} else {
		merged = append(merged, globalRules...)
		merged = append(merged, characterRules...)
	}
	merged = append(merged, builtinOutputRules()...)
	// 内置规则是字面量构造，统一补编译（parseRuleList 里的规则已编译）
	for index := range merged {
		if merged[index].compiled == nil && merged[index].compileErr == nil {
			merged[index].compile()
		}
	}
	return &regexProcessor{enabled: enabled, rules: merged}
}

// process 对齐 Node RegexProcessor.process：按阶段应用启用的规则。
func (p *regexProcessor) process(text string, stage string, depth int) string {
	normalizedStage := normalizeRuleStage(stage, false)
	if !p.enabled || text == "" || len(p.rules) == 0 {
		return text
	}
	result := text
	for _, rule := range p.rules {
		if !rule.Enabled || rule.compiled == nil {
			continue
		}
		if rule.MarkdownOnly && normalizedStage == "input" {
			continue
		}
		if rule.PromptOnly && normalizedStage == "output" {
			continue
		}
		if rule.MinDepth != nil && depth < *rule.MinDepth {
			continue
		}
		if rule.MaxDepth != nil && depth > *rule.MaxDepth {
			continue
		}
		if normalizeRuleStage(rule.Stage, rule.PromptOnly) != normalizedStage {
			continue
		}
		result = rule.compiled.ReplaceAllString(result, convertJSReplacement(rule.Replacement))
	}
	return result
}

func intOr(value any, fallback int) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	}
	return fallback
}

func boolOr(value any, fallback bool) bool {
	if value == nil {
		return fallback
	}
	if typed, ok := value.(bool); ok {
		return typed
	}
	return fallback
}

// rawString 取原始字符串（不裁剪，保留空格等合法替换内容）。
func rawString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func stringOr(value any, fallback string) string {
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	return fallback
}
