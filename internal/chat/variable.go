package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/store"
)

// 变量桥接层（对齐 Node src/variable-bridge.js）：连接 AI 输出的
// UpdateVariable/JSONPatch 与 MimirLink 变量存储，剥离 ST 卡内部标签。

var (
	getMessageVariableRegex = regexp.MustCompile(`(?i)\{\{get_message_variable::([^}]+)\}\}`)
	getvarRegex             = regexp.MustCompile(`(?i)\{\{getvar::([^}]+)\}\}`)
	setvarRegex             = regexp.MustCompile(`(?i)\{\{setvar::([^}:]+?)::([\s\S]*?)\}\}`)
	updateVariableTagRegex  = regexp.MustCompile(`(?i)<UpdateVariable>\s*([\s\S]*?)\s*</UpdateVariable>`)
	formatMessageVarRegex   = regexp.MustCompile(`(?i)\{\{format_message_variable::([^}]+)\}\}`)
)

// extractTaggedContent 提取第一个 <tag>...</tag> 块内容（大小写不敏感，支持带属性）。
func extractTaggedContent(text string, tagName string) string {
	if strings.TrimSpace(text) == "" || strings.TrimSpace(tagName) == "" {
		return ""
	}
	escaped := regexp.QuoteMeta(tagName)
	re, err := regexp.Compile(`(?i)<` + escaped + `[^>]*>([\s\S]*?)</` + escaped + `>`)
	if err != nil {
		return ""
	}
	match := re.FindStringSubmatch(text)
	if match == nil {
		return ""
	}
	return strings.TrimSpace(match[1])
}

// extractVisibleContent 提取 <content> 块；没有该块时返回原文。
func extractVisibleContent(text string) string {
	content := extractTaggedContent(text, "content")
	if content != "" {
		return content
	}
	return text
}

// 内部标签分类（对齐 Node INTERNAL_TAGS / stripInternalTags）
var (
	stripTagOnlyList = []string{"bginfor", "maintext", "contenttext", "details", "summary", "WMM", "StatusBlock", "option"}
	deleteWithList   = []string{"thinking", "cot", "analysis", "reflection", "draft_notes", "draft", "内部分析"}
	htmlTagRegex     = regexp.MustCompile(`<[^>]+>`)
	multiBlankRegex  = regexp.MustCompile(`\n{3,}`)
	uvHolderRegex    = regexp.MustCompile(`___UV_(\d+)___`)
)

func tagBlockOpen(tag string) *regexp.Regexp {
	re, err := regexp.Compile(`(?i)<` + regexp.QuoteMeta(tag) + `[^>]*>[\s\S]*?</` + regexp.QuoteMeta(tag) + `>`)
	if err != nil {
		return nil
	}
	return re
}

func tagOpenOnly(tag string) *regexp.Regexp {
	re, err := regexp.Compile(`(?i)<` + regexp.QuoteMeta(tag) + `[^>]*>[\s\S]*$`)
	if err != nil {
		return nil
	}
	return re
}

func tagPair(tag string) (*regexp.Regexp, *regexp.Regexp) {
	open, _ := regexp.Compile(`(?i)<` + regexp.QuoteMeta(tag) + `[^>]*>`)
	close_, _ := regexp.Compile(`(?i)</` + regexp.QuoteMeta(tag) + `>`)
	return open, close_
}

// stripInternalTags 剥离 ST 卡常见内部思考标签（draft_notes/thinking/cot 等）。
// 不处理 UpdateVariable（单独保留后还原）。
func stripInternalTags(text string) string {
	if text == "" {
		return text
	}
	result := text

	// 1. 保存 UpdateVariable 块
	uvBlocks := []string{}
	result = regexp.MustCompile(`(?i)<UpdateVariable>[\s\S]*?</UpdateVariable>`).ReplaceAllStringFunc(result, func(match string) string {
		uvBlocks = append(uvBlocks, match)
		return fmt.Sprintf("___UV_%d___", len(uvBlocks)-1)
	})

	// 2. 删除 style 块与 XML 注释
	if re := tagBlockOpen("style"); re != nil {
		result = re.ReplaceAllString(result, "")
	}
	result = regexp.MustCompile(`<!--[\s\S]*?-->`).ReplaceAllString(result, "")

	// 3a. 完全删除的标签（连内容一起删；含未闭合尾部）
	for _, tag := range deleteWithList {
		if re := tagBlockOpen(tag); re != nil {
			result = re.ReplaceAllString(result, "")
		}
		if re := tagOpenOnly(tag); re != nil {
			result = re.ReplaceAllString(result, "")
		}
	}
	// 3b. 只去标签保内容
	for _, tag := range stripTagOnlyList {
		open, close_ := tagPair(tag)
		result = open.ReplaceAllString(result, "")
		result = close_.ReplaceAllString(result, "")
	}

	// 4. 残留 HTML 标签
	result = htmlTagRegex.ReplaceAllString(result, "")

	// 5. 还原 UpdateVariable
	result = uvHolderRegex.ReplaceAllStringFunc(result, func(match string) string {
		sub := uvHolderRegex.FindStringSubmatch(match)
		index, err := strconv.Atoi(sub[1])
		if err != nil || index >= len(uvBlocks) {
			return ""
		}
		return uvBlocks[index]
	})

	return strings.TrimSpace(multiBlankRegex.ReplaceAllString(result, "\n\n"))
}

// parseLiteralValue 字面量解析：true/false → bool，数字 → float64，其余原样字符串。
func parseLiteralValue(rawValue string) any {
	value := strings.TrimSpace(rawValue)
	if value == "" {
		return ""
	}
	switch strings.ToLower(value) {
	case "true":
		return true
	case "false":
		return false
	}
	if regexp.MustCompile(`^-?\d+(\.\d+)?$`).MatchString(value) {
		if number, err := strconv.ParseFloat(value, 64); err == nil {
			return number
		}
	}
	return value
}

// inferType 类型推断（对齐 Node inferType）。
func inferType(value any) string {
	switch typed := value.(type) {
	case float64, json.Number:
		return "number"
	case bool:
		return "boolean"
	case string:
		return "string"
	default:
		_ = typed
		return "json"
	}
}

// normalizePatchPath JSON Patch 路径 → 存储键（/a/b → a.b）。
func normalizePatchPath(path string) string {
	trimmed := strings.TrimLeft(strings.TrimSpace(path), "/")
	return strings.ReplaceAll(trimmed, "/", ".")
}

// normalizeLookupKey 查找键归一化：去掉 stat_data. 前缀与首层斜杠。
func normalizeLookupKey(key string) string {
	cleaned := strings.TrimSpace(key)
	cleaned = strings.TrimLeft(cleaned, "/")
	cleaned = strings.ReplaceAll(cleaned, "/", ".")
	return strings.TrimPrefix(cleaned, "stat_data.")
}

// variablePatch 是一条已应用的变量补丁记录。
type variablePatch struct {
	Op    string `json:"op"`
	Path  string `json:"path"`
	Value any    `json:"value,omitempty"`
	Key   string `json:"-"`
}

// variableExtraction 是 UpdateVariable 提取结果。
type variableExtraction struct {
	CleanedOutput   string
	Applied         []variablePatch
	ProtocolPresent bool
	BlockCount      int
}

// parseUpdateVariableBlocks 解析全部 UpdateVariable 块为补丁列表（JSON 解析失败跳过该块）。
func parseUpdateVariableBlocks(text string) (patches []variablePatch, protocolPresent bool, blockCount int) {
	matches := updateVariableTagRegex.FindAllStringSubmatch(text, -1)
	for _, match := range matches {
		blockCount++
		content := strings.TrimSpace(match[1])
		var decoded []map[string]any
		if err := json.Unmarshal([]byte(content), &decoded); err != nil {
			continue
		}
		protocolPresent = true
		for _, item := range decoded {
			patch := variablePatch{}
			if op, ok := item["op"].(string); ok {
				patch.Op = op
			}
			if path, ok := item["path"].(string); ok {
				patch.Path = path
			}
			patch.Value = item["value"]
			patch.Key = normalizePatchPath(patch.Path)
			patches = append(patches, patch)
		}
	}
	return patches, protocolPresent, blockCount
}

// stripUpdateVariableBlocks 移除文本中的 UpdateVariable 块。
func stripUpdateVariableBlocks(text string) string {
	cleaned := updateVariableTagRegex.ReplaceAllString(text, "")
	return strings.TrimSpace(multiBlankRegex.ReplaceAllString(cleaned, "\n\n"))
}

// variableMapEntry 是变量快照的一个键值对。
type variableMapEntry struct {
	Key   string
	Value string
}

// buildVariableMap 读取作用域变量并构建查找表（含 stat_data. 前缀别名）。
// 实际 scope 没变量时回退 default scope（对齐 Node）。
func (r *Runtime) buildVariableMap(scope store.NamespaceOptions) map[string]string {
	allVars, err := r.memory.ListVariables(store.VariableFilters{
		ScopeType: scope.ScopeType, ScopeKey: scope.ScopeKey,
		CharacterName: scope.CharacterName, PresetName: scope.PresetName, Limit: 500,
	})
	if err != nil {
		r.logger.Printf("[变量] 读取变量失败: %v", err)
		return map[string]string{}
	}
	if len(allVars) == 0 && scope.ScopeKey != "default" {
		fallback := scope
		fallback.ScopeKey = "default"
		if allVars, err = r.memory.ListVariables(store.VariableFilters{
			ScopeType: fallback.ScopeType, ScopeKey: fallback.ScopeKey,
			CharacterName: fallback.CharacterName, PresetName: fallback.PresetName, Limit: 500,
		}); err != nil {
			return map[string]string{}
		}
	}
	varMap := map[string]string{}
	for _, variable := range allVars {
		key := normalizeLookupKey(variable.Key)
		if key == "" {
			key = normalizeLookupKey(variable.Title)
		}
		if key == "" {
			continue
		}
		varMap[key] = variable.RawValue
		varMap["stat_data."+key] = variable.RawValue
	}
	return varMap
}

// buildVariableStatusBlock 构建变量状态快照（<status_current_variable> 段）。
// 过滤内部宏变量（COT-/gs-/mvuvar/supernsfw 前缀）。
func (r *Runtime) buildVariableStatusBlock(scope store.NamespaceOptions) string {
	allVars, err := r.memory.ListVariables(store.VariableFilters{
		ScopeType: scope.ScopeType, ScopeKey: scope.ScopeKey,
		CharacterName: scope.CharacterName, PresetName: scope.PresetName, Limit: 500,
	})
	if err != nil {
		return ""
	}
	if len(allVars) == 0 && scope.ScopeKey != "default" {
		fallback := scope
		fallback.ScopeKey = "default"
		if allVars, err = r.memory.ListVariables(store.VariableFilters{
			ScopeType: fallback.ScopeType, ScopeKey: fallback.ScopeKey,
			CharacterName: fallback.CharacterName, PresetName: fallback.PresetName, Limit: 500,
		}); err != nil || len(allVars) == 0 {
			return ""
		}
	}
	systemPrefixes := []string{"COT-", "gs-", "mvuvar", "supernsfw"}
	entries := []string{}
	for _, variable := range allVars {
		key := variable.Key
		if key == "" {
			key = variable.Title
		}
		skip := false
		for _, prefix := range systemPrefixes {
			if strings.HasPrefix(key, prefix) {
				skip = true
				break
			}
		}
		if skip || key == "" {
			continue
		}
		entries = append(entries, fmt.Sprintf("%s: %s", key, variable.RawValue))
	}
	if len(entries) == 0 {
		return ""
	}
	return "\n<status_current_variable>\n" + strings.Join(entries, "\n") + "\n</status_current_variable>\n"
}

// resolveVariableMacros 解析 {{get_message_variable::}} / {{getvar::}} /
// {{format_message_variable::}} 宏。
func (r *Runtime) resolveVariableMacros(text string, scope store.NamespaceOptions) string {
	if text == "" {
		return text
	}
	varMap := r.buildVariableMap(scope)
	if len(varMap) == 0 {
		return text
	}
	lookup := func(key string) (string, bool) {
		cleanKey := normalizeLookupKey(key)
		if value, ok := varMap[cleanKey]; ok {
			return value, true
		}
		if value, ok := varMap["stat_data."+cleanKey]; ok {
			return value, true
		}
		// 后缀/前缀模糊匹配（对齐 Node 遍历）
		for mapKey, value := range varMap {
			if strings.HasSuffix(mapKey, cleanKey) || strings.HasSuffix(cleanKey, mapKey) {
				return value, true
			}
		}
		return "", false
	}
	result := getMessageVariableRegex.ReplaceAllStringFunc(text, func(match string) string {
		sub := getMessageVariableRegex.FindStringSubmatch(match)
		if value, ok := lookup(sub[1]); ok {
			return value
		}
		return match
	})
	result = getvarRegex.ReplaceAllStringFunc(result, func(match string) string {
		sub := getvarRegex.FindStringSubmatch(match)
		if value, ok := lookup(sub[1]); ok {
			return value
		}
		return match
	})
	result = formatMessageVarRegex.ReplaceAllStringFunc(result, func(match string) string {
		lines := []string{}
		for key, value := range varMap {
			if strings.HasPrefix(key, "stat_data.") {
				continue
			}
			lines = append(lines, fmt.Sprintf("%s: %s", key, value))
		}
		if len(lines) == 0 {
			return match
		}
		return strings.Join(lines, "\n")
	})
	return result
}

// applyStaticSetvarsFromText 执行文本中的 {{setvar::key::value}} 静态初始化。
// keepMacros=false 时从文本中移除宏。
func (r *Runtime) applyStaticSetvarsFromText(text string, scope store.NamespaceOptions, keepMacros bool) (string, []variablePatch) {
	if text == "" {
		return text, nil
	}
	applied := []variablePatch{}
	cleaned := text
	for _, match := range setvarRegex.FindAllStringSubmatch(text, -1) {
		rawKey := strings.TrimSpace(match[1])
		if rawKey == "" {
			continue
		}
		rawValue := strings.TrimSpace(match[2])
		parsed := parseLiteralValue(rawValue)
		key := normalizeLookupKey(rawKey)
		encoded, _ := json.Marshal(parsed)
		if _, _, err := r.memory.UpsertVariable(scope, store.Variable{
			Key: key, RawValue: string(encoded), ValueType: inferType(parsed),
			Tags: []string{"system"}, Metadata: map[string]any{"source": "imported-card"},
		}); err != nil {
			r.logger.Printf("[变量] setvar 写入失败 %s: %v", key, err)
			continue
		}
		applied = append(applied, variablePatch{Op: "setvar", Key: key, Path: rawKey, Value: parsed})
		if !keepMacros {
			cleaned = strings.ReplaceAll(cleaned, match[0], "")
		}
	}
	if !keepMacros {
		cleaned = strings.TrimSpace(multiBlankRegex.ReplaceAllString(cleaned, "\n\n"))
	}
	return cleaned, applied
}

// extractAndApplyVariables 从 AI 输出提取 <UpdateVariable> 块并写入变量存储。
// 返回清洗后的输出与已应用补丁；protocolPresent 表示主回复给出了有效协议
// 输出（空数组也算，用于抑制额外模型解析）。
func (r *Runtime) extractAndApplyVariables(rawOutput string, scope store.NamespaceOptions) variableExtraction {
	if rawOutput == "" {
		return variableExtraction{CleanedOutput: rawOutput}
	}
	patches, protocolPresent, blockCount := parseUpdateVariableBlocks(rawOutput)
	applied := []variablePatch{}
	for _, patch := range patches {
		if patch.Op == "" || patch.Path == "" {
			continue
		}
		switch patch.Op {
		case "replace", "add":
			encoded, _ := json.Marshal(patch.Value)
			if _, _, err := r.memory.UpsertVariable(scope, store.Variable{
				Key: patch.Key, RawValue: string(encoded), ValueType: inferType(patch.Value),
				Metadata: map[string]any{"source": "ai"},
			}); err != nil {
				r.logger.Printf("[变量] 补丁写入失败 %s: %v", patch.Key, err)
				continue
			}
			applied = append(applied, patch)
		case "remove":
			if _, err := r.memory.DeleteVariableByName(scope, patch.Key); err != nil {
				r.logger.Printf("[变量] 补丁删除失败 %s: %v", patch.Key, err)
				continue
			}
			applied = append(applied, patch)
		}
	}
	return variableExtraction{
		CleanedOutput:   stripUpdateVariableBlocks(rawOutput),
		Applied:         applied,
		ProtocolPresent: protocolPresent,
		BlockCount:      blockCount,
	}
}

// variableScope 计算变量作用域：按用户隔离（user:<id>），不按群隔离（对齐 Node）。
func (r *Runtime) variableScope(sessionKey string, userID string) store.NamespaceOptions {
	scopeKey := sessionKey
	if userID != "" {
		scopeKey = "user:" + userID
	}
	return store.NamespaceOptions{
		ScopeType:     "user_persistent",
		ScopeKey:      scopeKey,
		CharacterName: r.characterName(),
		PresetName:    r.document.String("bindings.global.preset"),
	}
}

// applyVariableBridgeToMessages 对构建好的 messages 应用变量桥接（对齐 Node index.js
// 3393 段）：静态 setvar 初始化 → 新用户变量初始化（角色卡 variable_defaults）→
// 宏解析 → <status_current_variable> 状态块注入第一条 system 消息。
func (r *Runtime) applyVariableBridgeToMessages(messages *[]ai.Message, sessionKey string, userID string) {
	scope := r.variableScope(sessionKey, userID)
	// 第一步：静态 setvar（从全部 string 内容提取）
	for index := range *messages {
		if text, ok := (*messages)[index].Content.(string); ok && text != "" {
			cleaned, applied := r.applyStaticSetvarsFromText(text, scope, false)
			if len(applied) > 0 {
				(*messages)[index].Content = cleaned
			}
		}
	}
	// 1.5 步：新用户变量初始化（scope 下只有系统变量时，从角色卡 variable_defaults 初始化）
	r.initVariableDefaults(scope)
	// 第二步：解析宏
	for index := range *messages {
		if text, ok := (*messages)[index].Content.(string); ok && text != "" {
			(*messages)[index].Content = r.resolveVariableMacros(text, scope)
		}
	}
	// 注入变量状态块
	if statusBlock := r.buildVariableStatusBlock(scope); statusBlock != "" {
		inserted := false
		for index := range *messages {
			if (*messages)[index].Role == "system" {
				if text, ok := (*messages)[index].Content.(string); ok {
					(*messages)[index].Content = text + "\n" + statusBlock
					inserted = true
				}
				break
			}
		}
		if !inserted {
			*messages = append([]ai.Message{{Role: "system", Content: statusBlock}}, *messages...)
		}
	}
}

// initVariableDefaults 新用户变量初始化：scope 下存在非 system 标签变量时跳过；
// 否则从角色卡 variable_defaults 写入初始值。
func (r *Runtime) initVariableDefaults(scope store.NamespaceOptions) {
	allVars, err := r.memory.ListVariables(store.VariableFilters{
		ScopeType: scope.ScopeType, ScopeKey: scope.ScopeKey,
		CharacterName: scope.CharacterName, PresetName: scope.PresetName, Limit: 500,
	})
	if err != nil {
		return
	}
	for _, variable := range allVars {
		systemTagged := false
		for _, tag := range variable.Tags {
			if tag == "system" {
				systemTagged = true
				break
			}
		}
		if !systemTagged {
			return // 存在用户变量，跳过初始化
		}
	}
	character, err := characters.Read(r.rootDir, scope.CharacterName)
	if err != nil || character == nil {
		return
	}
	defaults, ok := character["variable_defaults"].(map[string]any)
	if !ok || len(defaults) == 0 {
		return
	}
	for key, value := range defaults {
		encoded, _ := json.Marshal(value)
		valueType := "string"
		switch value.(type) {
		case float64:
			valueType = "number"
		case bool:
			valueType = "boolean"
		}
		if _, _, err := r.memory.UpsertVariable(scope, store.Variable{
			Key: key, RawValue: string(encoded), ValueType: valueType,
			Metadata: map[string]any{"source": "auto-init"},
		}); err != nil {
			r.logger.Printf("[变量] 初始化失败 %s: %v", key, err)
		}
	}
	r.logger.Printf("[变量] 新用户初始化 %d 个变量（scope=%s）", len(defaults), scope.ScopeKey)
}

// maybeParseVariablesAsync 额外模型变量解析（对齐 Node index.js 3580 段）：
// 仅当配置了 chat.varparseModel 或 ai.variableParsing.model 时异步调用一次。
func (r *Runtime) maybeParseVariablesAsync(sessionKey string, scope store.NamespaceOptions, userInput string, assistantReply string) {
	if r.document.Bool("ai.variableParsing.enabled") == false && r.document.Exists("ai.variableParsing.enabled") {
		return
	}
	varparseModel := strings.TrimSpace(r.document.String("chat.varparseModel"))
	if varparseModel == "" {
		varparseModel = strings.TrimSpace(r.document.String("ai.variableParsing.model"))
	}
	if varparseModel == "" {
		return // 未配置变量解析模型则跳过
	}
	varparseProviderID := strings.TrimSpace(r.document.String("chat.varparseModelProviderId"))
	if varparseProviderID == "" {
		varparseProviderID = strings.TrimSpace(r.document.String("ai.variableParsing.providerId"))
	}
	if varparseProviderID == "" {
		varparseProviderID = strings.TrimSpace(r.document.String("ai.activeProviderId"))
	}
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				r.logger.Printf("[变量-额外解析] panic: %v", recovered)
			}
		}()
		varStatus := r.buildVariableStatusBlock(scope)
		prompt := fmt.Sprintf(`你是变量更新解析器。根据对话分析变量变化，输出 JSON Patch。

当前变量：
%s

用户：%s
角色：%s

请输出变量更新（无变化输出空数组）：
<UpdateVariable>
[{"op":"replace","path":"/变量名","value":新值}]
</UpdateVariable>`, orEmpty(varStatus), userInput, assistantReply)
		overrides := r.variableParseOverrides(varparseModel, varparseProviderID)
		if overrides == nil {
			r.logger.Printf("[变量-额外解析] 无法解析解析模型供应商（provider=%s）", varparseProviderID)
			return
		}
		client := r.ai
		provider := ai.Provider{Model: stringOr(overrides["model"], ""), Timeout: time.Duration(r.document.Int("ai.timeout", 60000)) * time.Millisecond}
		if value, ok := overrides["baseUrl"].(string); ok {
			provider.BaseURL = value
		}
		if value, ok := overrides["apiKey"].(string); ok {
			provider.APIKey = value
		}
		if provider.Timeout < time.Second {
			provider.Timeout = 60 * time.Second
		}
		if provider.BaseURL != "" {
			if _, isReal := client.(*ai.Client); isReal {
				client = ai.New(provider)
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		result, err := client.Chat(ctx, []ai.Message{{Role: "user", Content: prompt}}, map[string]any{
			"model": varparseModel, "maxTokens": 1024, "temperature": 0.1,
		})
		if err != nil {
			r.logger.Printf("[变量-额外解析] 调用失败: %v", err)
			return
		}
		text := result.Content
		if text != "" && strings.Contains(text, "<UpdateVariable>") {
			extraction := r.extractAndApplyVariables(text, scope)
			if len(extraction.Applied) > 0 {
				r.logger.Printf("[变量-额外解析] 已应用 %d 个补丁", len(extraction.Applied))
			}
		}
	}()
}

// orEmpty 空串占位。
func orEmpty(value string) string {
	if strings.TrimSpace(value) == "" {
		return "(无)"
	}
	return value
}

// variableParseOverrides 解析变量解析模型的供应商覆盖（chat.varparseModel +
// chat.varparseModelProviderId，回退 ai.variableParsing.*，再回退当前主供应商）。
func (r *Runtime) variableParseOverrides(model string, providerID string) map[string]any {
	raw := map[string]any{}
	if err := json.Unmarshal(r.document.Raw(), &raw); err != nil {
		return nil
	}
	aiSection, _ := raw["ai"].(map[string]any)
	if aiSection == nil {
		return nil
	}
	providers, _ := aiSection["providers"].([]any)
	var matched map[string]any
	for _, item := range providers {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		if stringOr(entry["id"], "") == providerID {
			matched = entry
			break
		}
	}
	baseURL := ""
	apiKey := ""
	if matched != nil {
		baseURL = stringOr(matched["baseUrl"], "")
		apiKey = stringOr(matched["apiKey"], "")
	} else {
		baseURL = stringOr(aiSection["baseUrl"], "")
		apiKey = stringOr(aiSection["apiKey"], "")
	}
	if strings.TrimSpace(baseURL) == "" {
		return nil
	}
	return map[string]any{"model": model, "baseUrl": baseURL, "apiKey": apiKey}
}
