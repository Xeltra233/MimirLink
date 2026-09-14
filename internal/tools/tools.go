// Package tools 实现暴露给模型的工具（与 Node 版 src/tools.js 的工具名和参数一致）。
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/config"
	"mimirlink/internal/mcp"
	"mimirlink/internal/search"
)

// Registry 持有工具实现。
type Registry struct {
	search *search.Service
	mcp    *mcp.Client
	logger *log.Logger
}

// New 创建工具注册表（搜索服务为空时只提供非搜索工具）。
func New(service *search.Service, logger *log.Logger) *Registry {
	if logger == nil {
		logger = log.Default()
	}
	return &Registry{search: service, logger: logger}
}

// AttachMCP 挂载 MCP 客户端（其工具会一并暴露给模型）。
func (r *Registry) AttachMCP(client *mcp.Client) { r.mcp = client }

// Definitions 返回当前可用工具定义。
func (r *Registry) Definitions() []ai.ToolDefinition {
	definitions := []ai.ToolDefinition{}
	if r.search != nil && r.search.Enabled() {
		definitions = append(definitions, buildSearchToolDefinition(), buildFetchToolDefinition())
		if r.search.Config().Spice.Enabled {
			definitions = append(definitions, buildWeatherToolDefinition(), buildCurrencyToolDefinition())
		}
	}
	if r.mcp != nil {
		for _, item := range r.mcp.Definitions() {
			definitions = append(definitions, convertMCPDefinition(item))
		}
	}
	return definitions
}

// convertMCPDefinition 把 MCP 工具定义转成 ai.ToolDefinition。
func convertMCPDefinition(item mcp.ToolDefinition) ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = item.Name
	if function, ok := item.Definition["function"].(map[string]any); ok {
		definition.Function.Description = fmt.Sprintf("%v", function["description"])
		if parameters, ok := function["parameters"].(map[string]any); ok {
			definition.Function.Parameters = parameters
		}
	}
	if definition.Function.Parameters == nil {
		definition.Function.Parameters = map[string]any{"type": "object", "properties": map[string]any{}}
	}
	return definition
}

// Names 返回工具名列表（用于日志）。
func (r *Registry) Names() []string {
	names := []string{}
	for _, item := range r.Definitions() {
		names = append(names, item.Function.Name)
	}
	return names
}

// Execute 执行一次工具调用，返回给模型的文本结果。
func (r *Registry) Execute(ctx context.Context, call ai.ToolCall) string {
	startedAt := time.Now()
	output, err := r.dispatch(ctx, call.Function.Name, call.Function.Arguments)
	if err != nil {
		r.logger.Printf("[工具] %s 失败(%dms): %v", call.Function.Name, time.Since(startedAt).Milliseconds(), err)
		return fmt.Sprintf("工具执行失败：%s", err.Error())
	}
	r.logger.Printf("[工具] %s 成功(%dms, %d 字)", call.Function.Name, time.Since(startedAt).Milliseconds(), len([]rune(output)))
	return output
}

func (r *Registry) dispatch(ctx context.Context, name string, rawArguments string) (string, error) {
	arguments := map[string]any{}
	if strings.TrimSpace(rawArguments) != "" {
		if err := json.Unmarshal([]byte(rawArguments), &arguments); err != nil {
			return "", fmt.Errorf("参数不是合法 JSON: %w", err)
		}
	}
	switch name {
	case "web_search":
		return r.webSearch(ctx, arguments)
	case "web_fetch":
		return r.webFetch(ctx, arguments)
	case "get_weather":
		return r.getWeather(ctx, arguments)
	case "convert_currency":
		return r.convertCurrency(ctx, arguments)
	default:
		if strings.HasPrefix(name, "mcp__") {
			return r.callMCP(ctx, name, arguments)
		}
		return "", fmt.Errorf("未知工具: %s", name)
	}
}

// callMCP 调用 MCP 工具（按暴露给模型的函数名反查归属）。
func (r *Registry) callMCP(ctx context.Context, functionName string, arguments map[string]any) (string, error) {
	if r.mcp == nil {
		return "", fmt.Errorf("MCP 未启用")
	}
	definition, ok := r.mcp.Lookup(functionName)
	if !ok {
		return "", fmt.Errorf("未找到 MCP 工具: %s", functionName)
	}
	text, err := r.mcp.CallTool(ctx, definition.ServerID, definition.ToolName, arguments)
	if err != nil {
		return "", fmt.Errorf("[MCP:%s] %s", definition.ServerName, err.Error())
	}
	return text, nil
}

func (r *Registry) webSearch(ctx context.Context, arguments map[string]any) (string, error) {
	if r.search == nil {
		return "", fmt.Errorf("搜索服务未启用")
	}
	query := strings.TrimSpace(stringArg(arguments, "query"))
	if query == "" {
		return "", fmt.Errorf("query 不能为空")
	}
	limit := clampInt(intArg(arguments, "limit"), 1, 10, 0)
	topic := stringArg(arguments, "topic")
	if topic == "" {
		topic = "web"
	}
	timeRange := stringArg(arguments, "timeRange")
	site := stringArg(arguments, "site")

	startedAt := time.Now()
	results, attempted, err := r.search.Search(ctx, query, search.Request{
		Limit:     limit,
		Topic:     topic,
		TimeRange: timeRange,
		Site:      site,
	})
	if err != nil {
		// MCP 搜索兜底（对齐 Node tryMcpSearchFallback：本地链路失败时改用 MCP 搜索工具）
		if fallback := r.tryMCPSearchFallback(ctx, query); fallback != "" {
			return fallback, nil
		}
		return "", fmt.Errorf("搜索失败（已尝试 %s）: %w", strings.Join(attempted, " → "), err)
	}
	payload := map[string]any{
		"query":       query,
		"topic":       topic,
		"providers":   attempted,
		"elapsedMs":   time.Since(startedAt).Milliseconds(),
		"resultCount": len(results),
		"results":     results,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// mcpSearchPreference 对齐 Node MCP_SEARCH_TOOL_PREFERENCE。
var mcpSearchPreference = []string{"search", "fast_search", "any_search", "mega_search"}

// tryMCPSearchFallback 对齐 Node tryMcpSearchFallback：按名称含 search 挑候选（最多 2 个），
// 以 {text: query} 调用，返回原始文本。
func (r *Registry) tryMCPSearchFallback(ctx context.Context, query string) string {
	if r.mcp == nil || !r.mcp.Enabled() {
		return ""
	}
	target := r.search.Config().MCPFallback
	maxChars := r.search.Config().MCPFallbackMaxChars
	if maxChars <= 0 {
		maxChars = 4000
	}
	type candidate struct {
		definition mcp.ToolDefinition
		rank       int
	}
	candidates := []candidate{}
	for _, item := range r.mcp.Definitions() {
		if target == "off" {
			break
		}
		if target != "auto" && item.ServerName != target && item.ServerID != target {
			continue
		}
		name := item.ToolName
		if name == "" {
			name = item.Name
		}
		if !strings.Contains(strings.ToLower(name), "search") {
			continue
		}
		rank := len(mcpSearchPreference)
		for index, preferred := range mcpSearchPreference {
			if name == preferred {
				rank = index
				break
			}
		}
		candidates = append(candidates, candidate{definition: item, rank: rank})
	}
	// 稳定排序：偏好序
	for i := 0; i < len(candidates); i++ {
		for j := i + 1; j < len(candidates); j++ {
			if candidates[j].rank < candidates[i].rank {
				candidates[i], candidates[j] = candidates[j], candidates[i]
			}
		}
	}
	for index, item := range candidates {
		if index >= 2 {
			break
		}
		text, err := r.mcp.CallTool(ctx, item.definition.ServerID, item.definition.ToolName, map[string]any{"text": query})
		if err != nil {
			r.logger.Printf("[工具] MCP 搜索兜底异常 [%s:%s]: %v", item.definition.ServerName, item.definition.ToolName, err)
			continue
		}
		runes := []rune(text)
		if len(runes) > maxChars {
			text = string(runes[:maxChars])
		}
		r.logger.Printf("[工具] MCP 搜索兜底成功 [%s:%s]", item.definition.ServerName, item.definition.ToolName)
		payload := map[string]any{
			"ok":          true,
			"provider":    "mcp",
			"source":      fmt.Sprintf("mcp:%s:%s", item.definition.ServerName, item.definition.ToolName),
			"query":       query,
			"resultCount": 0,
			"results":     []any{},
			"text":        text,
			"note":        "本地搜索链路失败，以下为 MCP 搜索工具返回的原始文本",
		}
		encoded, marshalErr := json.Marshal(payload)
		if marshalErr != nil {
			continue
		}
		return string(encoded)
	}
	return ""
}

// getWeather 执行天气查询（DuckDuckGo Spice）。
func (r *Registry) getWeather(ctx context.Context, arguments map[string]any) (string, error) {
	if r.search == nil || !r.search.Enabled() || !r.search.Config().Spice.Enabled {
		return "", fmt.Errorf("天气工具未启用")
	}
	location := strings.TrimSpace(stringArg(arguments, "location"))
	if location == "" {
		return "", fmt.Errorf("地点不能为空")
	}
	days := clampInt(intArg(arguments, "days"), 1, 7, r.search.Config().Spice.WeatherDays)
	result, err := r.search.FetchWeather(ctx, location, days, r.search.Config().Locale, r.search.Config().TimeoutMs)
	if err != nil {
		return "", fmt.Errorf("天气查询失败: %w", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// convertCurrency 执行汇率换算（DuckDuckGo Spice / xe.com 中间价）。
func (r *Registry) convertCurrency(ctx context.Context, arguments map[string]any) (string, error) {
	if r.search == nil || !r.search.Enabled() || !r.search.Config().Spice.Enabled {
		return "", fmt.Errorf("汇率工具未启用")
	}
	from := strings.TrimSpace(stringArg(arguments, "from"))
	to := strings.TrimSpace(stringArg(arguments, "to"))
	amount := floatArg(arguments, "amount")
	if amount <= 0 {
		amount = 1
	}
	if from == "" || to == "" {
		return "", fmt.Errorf("需要提供 from 和 to 两个货币代码")
	}
	result, err := r.search.FetchCurrency(ctx, from, to, amount, r.search.Config().TimeoutMs)
	if err != nil {
		return "", fmt.Errorf("汇率查询失败: %w", err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

// buildWeatherToolDefinition 对齐 Node buildWeatherToolDefinition。
func buildWeatherToolDefinition() ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = "get_weather"
	definition.Function.Description = "查询指定城市/地点的当前天气与未来几天预报（气温、体感、湿度、风速、降水概率）。"
	definition.Function.Parameters = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"location": map[string]any{"type": "string", "description": "明确的地点名称，例如「北京」「上海」「Tokyo」。"},
			"days":     map[string]any{"type": "integer", "description": "预报天数（1-7，默认 3）。"},
		},
		"required": []string{"location"},
	}
	return definition
}

// buildCurrencyToolDefinition 对齐 Node buildCurrencyToolDefinition。
func buildCurrencyToolDefinition() ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = "convert_currency"
	definition.Function.Description = "按实时中间价换算货币，例如 USD→CNY。"
	definition.Function.Parameters = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"from":   map[string]any{"type": "string", "description": "源货币代码，例如 USD。"},
			"to":     map[string]any{"type": "string", "description": "目标货币代码，例如 CNY。"},
			"amount": map[string]any{"type": "number", "description": "金额，默认 1。"},
		},
		"required": []string{"from", "to"},
	}
	return definition
}

func (r *Registry) webFetch(ctx context.Context, arguments map[string]any) (string, error) {
	if r.search == nil {
		return "", fmt.Errorf("搜索服务未启用")
	}
	rawURL := strings.TrimSpace(stringArg(arguments, "url"))
	if rawURL == "" {
		return "", fmt.Errorf("url 不能为空")
	}
	maxChars := clampInt(intArg(arguments, "maxChars"), 500, 50000, 0)
	page, err := r.search.FetchPage(ctx, rawURL, maxChars)
	if err != nil {
		return "", err
	}
	payload := map[string]any{
		"url":       page.URL,
		"title":     page.Title,
		"chars":     page.Chars,
		"truncated": page.Truncated,
		"text":      page.Text,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}

func buildSearchToolDefinition() ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = "web_search"
	definition.Function.Description = fmt.Sprintf(
		"搜索公开网页或新闻，返回标题、链接和摘要。适合查询最新信息、新闻、外部事实或需要资料核验的问题。可用 provider：%s。",
		strings.Join(search.ProviderLabels(), " / "))
	definition.Function.Parameters = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": map[string]any{"type": "string", "description": "要搜索的关键词或问题。"},
			"limit": map[string]any{"type": "integer", "description": "期望返回的结果条数（1-10）。"},
			"topic": map[string]any{
				"type":        "string",
				"enum":        []string{"web", "news"},
				"description": "web=网页搜索（默认）；news=新闻搜索。",
			},
			"timeRange": map[string]any{
				"type":        "string",
				"enum":        []string{"day", "week", "month", "year"},
				"description": "限制结果时间范围，可选。",
			},
			"site": map[string]any{"type": "string", "description": "限定站点域名，例如 github.com，可选。"},
		},
		"required": []string{"query"},
	}
	return definition
}

func buildFetchToolDefinition() ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = "web_fetch"
	definition.Function.Description = "打开一个公开网页并提取正文内容，适合在搜索结果基础上深入阅读。只支持 http/https 公开地址。"
	definition.Function.Parameters = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"url":      map[string]any{"type": "string", "description": "要读取的网页地址。"},
			"maxChars": map[string]any{"type": "integer", "description": "正文最大字符数（默认使用服务端配置）。"},
		},
		"required": []string{"url"},
	}
	return definition
}

// LoadSearchConfig 从配置读取 ai.tools.webSearch 并归一化（兼容旧字段）。
func LoadSearchConfig(document *config.Document) search.Config {
	configValue := search.Defaults
	configValue.APIKeys = map[string]string{"tavily": "", "brave": "", "serpapi": ""}

	if !document.Exists("ai.tools.webSearch") {
		return configValue
	}
	raw := document.Get("ai.tools.webSearch").Raw
	var source map[string]any
	if err := json.Unmarshal([]byte(raw), &source); err != nil || source == nil {
		return configValue
	}

	configValue.Enabled = boolArg(source, "enabled", false)
	configValue.Provider = normalizeProvider(stringArg(source, "provider"))
	configValue.SearxngBaseURL = strings.TrimSpace(stringArg(source, "searxngBaseUrl"))
	configValue.SearxngEngines = strings.TrimSpace(stringArg(source, "searxngEngines"))
	if value := strings.TrimSpace(stringArg(source, "region")); value != "" {
		configValue.Region = value
	}
	if value := strings.TrimSpace(stringArg(source, "locale")); value != "" {
		configValue.Locale = value
	}
	if value := strings.ToLower(strings.TrimSpace(stringArg(source, "safeSearch"))); value == "off" || value == "moderate" || value == "strict" {
		configValue.SafeSearch = value
	}
	if value := strings.ToLower(strings.TrimSpace(stringArg(source, "timeRange"))); value == "all" || value == "day" || value == "week" || value == "month" || value == "year" {
		configValue.TimeRange = value
	}
	configValue.MaxResults = clampInt(intArg(source, "maxResults"), 1, 10, search.Defaults.MaxResults)
	configValue.TimeoutMs = clampInt(intArg(source, "timeoutMs"), 1000, 30000, search.Defaults.TimeoutMs)
	configValue.MaxSnippetLength = clampInt(intArg(source, "maxSnippetLength"), 100, 4000, search.Defaults.MaxSnippetLength)
	configValue.AllowedDomains = stringList(source["allowedDomains"])
	configValue.BlockedDomains = stringList(source["blockedDomains"])

	if keys, ok := source["apiKeys"].(map[string]any); ok {
		for _, id := range []string{"tavily", "brave", "serpapi"} {
			if value, ok := keys[id].(string); ok {
				configValue.APIKeys[id] = strings.TrimSpace(value)
			}
		}
	}
	if legacy := strings.TrimSpace(stringArg(source, "apiKey")); legacy != "" && configValue.APIKeys[configValue.Provider] == "" {
		if _, known := configValue.APIKeys[configValue.Provider]; known {
			configValue.APIKeys[configValue.Provider] = legacy
		}
	}

	fallbacks := []string{}
	for _, item := range stringList(source["fallbackProviders"]) {
		candidate := normalizeProvider(item)
		if candidate == configValue.Provider {
			continue
		}
		duplicated := false
		for _, existing := range fallbacks {
			if existing == candidate {
				duplicated = true
				break
			}
		}
		if !duplicated {
			fallbacks = append(fallbacks, candidate)
		}
	}
	configValue.FallbackProviders = fallbacks

	if fetch, ok := source["fetch"].(map[string]any); ok {
		configValue.Fetch.Enabled = boolArg(fetch, "enabled", true)
		configValue.Fetch.TimeoutMs = clampInt(intArg(fetch, "timeoutMs"), 3000, 60000, search.Defaults.Fetch.TimeoutMs)
		configValue.Fetch.MaxChars = clampInt(intArg(fetch, "maxChars"), 500, 50000, search.Defaults.Fetch.MaxChars)
	}
	if fallback := strings.TrimSpace(stringArg(source, "mcpFallback")); fallback != "" {
		configValue.MCPFallback = fallback
	}
	return configValue
}

func normalizeProvider(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "searxng", "tavily", "brave", "serpapi":
		return strings.ToLower(strings.TrimSpace(value))
	case "google", "bing", "duckduckgo":
		return "duckduckgo"
	default:
		return search.Defaults.Provider
	}
}

func stringList(value any) []string {
	source := []string{}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			source = append(source, fmt.Sprintf("%v", item))
		}
	case string:
		source = strings.FieldsFunc(typed, func(r rune) bool { return r == ',' || r == '，' || r == ' ' })
	}
	seen := map[string]bool{}
	output := []string{}
	for _, item := range source {
		text := strings.ToLower(strings.TrimSpace(item))
		if text == "" || seen[text] {
			continue
		}
		seen[text] = true
		output = append(output, text)
	}
	return output
}

func stringArg(arguments map[string]any, key string) string {
	value, ok := arguments[key]
	if !ok || value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		return fmt.Sprintf("%v", typed)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func intArg(arguments map[string]any, key string) int {
	value, ok := arguments[key]
	if !ok || value == nil {
		return 0
	}
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case string:
		var parsed int
		if _, err := fmt.Sscanf(strings.TrimSpace(typed), "%d", &parsed); err == nil {
			return parsed
		}
	}
	return 0
}

func boolArg(arguments map[string]any, key string, fallback bool) bool {
	value, ok := arguments[key]
	if !ok {
		return fallback
	}
	if typed, ok := value.(bool); ok {
		return typed
	}
	return fallback
}

func clampInt(value int, minValue int, maxValue int, fallback int) int {
	if value == 0 {
		return fallback
	}
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}

// RandomIdentifier 生成工具调用兜底 id（部分模型不返回 id）。
func RandomIdentifier() string {
	return fmt.Sprintf("call_%d_%d", time.Now().UnixMilli(), rand.Intn(100000))
}

// floatArg 取浮点参数。
func floatArg(arguments map[string]any, key string) float64 {
	if number, ok := arguments[key].(float64); ok {
		return number
	}
	return 0
}
