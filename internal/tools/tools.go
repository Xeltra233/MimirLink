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
	"mimirlink/internal/search"
)

// Registry 持有工具实现。
type Registry struct {
	search *search.Service
	logger *log.Logger
}

// New 创建工具注册表（搜索服务为空时只提供非搜索工具）。
func New(service *search.Service, logger *log.Logger) *Registry {
	if logger == nil {
		logger = log.Default()
	}
	return &Registry{search: service, logger: logger}
}

// Definitions 返回当前可用工具定义。
func (r *Registry) Definitions() []ai.ToolDefinition {
	definitions := []ai.ToolDefinition{}
	if r.search != nil && r.search.Enabled() {
		definitions = append(definitions, buildSearchToolDefinition(), buildFetchToolDefinition())
	}
	return definitions
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
	default:
		return "", fmt.Errorf("未知工具: %s", name)
	}
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
