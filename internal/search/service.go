package search

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Defaults 与 Node 版 WEB_SEARCH_DEFAULTS 保持一致。
var Defaults = Config{
	Provider:            "duckduckgo",
	Region:              "cn-zh",
	Locale:              "zh-cn",
	SafeSearch:          "moderate",
	TimeRange:           "all",
	MaxResults:          5,
	TimeoutMs:           10000,
	MaxSnippetLength:    800,
	Fetch:               FetchConfig{Enabled: true, TimeoutMs: 15000, MaxChars: 8000},
	MCPFallback:         "auto",
	Spice:               SpiceConfig{WeatherDays: 3},
	MCPFallbackMaxChars: 4000,
}

// FetchConfig 是抓页配置。
type FetchConfig struct {
	Enabled   bool `json:"enabled"`
	TimeoutMs int  `json:"timeoutMs"`
	MaxChars  int  `json:"maxChars"`
}

// Config 是 webSearch 配置（键名与 Node 版一致，直接来自 ai.tools.webSearch）。
type Config struct {
	Enabled             bool              `json:"enabled"`
	Provider            string            `json:"provider"`
	FallbackProviders   []string          `json:"fallbackProviders"`
	APIKeys             map[string]string `json:"apiKeys"`
	SearxngBaseURL      string            `json:"searxngBaseUrl"`
	SearxngEngines      string            `json:"searxngEngines"`
	Region              string            `json:"region"`
	Locale              string            `json:"locale"`
	SafeSearch          string            `json:"safeSearch"`
	TimeRange           string            `json:"timeRange"`
	MaxResults          int               `json:"maxResults"`
	TimeoutMs           int               `json:"timeoutMs"`
	MaxSnippetLength    int               `json:"maxSnippetLength"`
	AllowedDomains      []string          `json:"allowedDomains"`
	BlockedDomains      []string          `json:"blockedDomains"`
	Fetch               FetchConfig       `json:"fetch"`
	MCPFallback         string            `json:"mcpFallback"`
	Spice               SpiceConfig       `json:"spice"`
	MCPFallbackMaxChars int               `json:"mcpFallbackMaxChars"`
}

// SpiceConfig 是 DuckDuckGo Spice 即时数据配置（get_weather/convert_currency）。
type SpiceConfig struct {
	Enabled     bool `json:"enabled"`
	WeatherDays int  `json:"weatherDays"`
}

// Service 是搜索服务。
type Service struct {
	client    *Client
	config    Config
	logger    *log.Logger
	mu        sync.Mutex
	failures  map[string]int
	breakerTl map[string]time.Time
}

// New 创建搜索服务。
func New(config Config, logger *log.Logger) *Service {
	if logger == nil {
		logger = log.Default()
	}
	return &Service{
		client:    NewClient(),
		config:    config,
		logger:    logger,
		failures:  map[string]int{},
		breakerTl: map[string]time.Time{},
	}
}

// Config 返回当前配置。
func (s *Service) Config() Config { return s.config }

// ProviderLabels 返回可用于工具描述的 provider 标签。
func (s *Service) Enabled() bool { return s.config.Enabled }

// Search 按配置的回退链执行搜索，全部失败时返回聚合错误。
func (s *Service) Search(ctx context.Context, query string, options Request) ([]Result, []string, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil, fmt.Errorf("搜索关键词不能为空")
	}
	request := options
	request.Query = query
	request.Config = s.config

	chain := []string{s.config.Provider}
	chain = append(chain, s.config.FallbackProviders...)
	attempted := []string{}
	var lastError error

	for _, providerID := range chain {
		if s.breakerOpen(providerID) {
			s.logger.Printf("[搜索] %s 处于熔断冷却，跳过", providerID)
			attempted = append(attempted, providerID+"(熔断跳过)")
			continue
		}
		implementation := findProvider(providerID)
		if implementation == nil {
			continue
		}
		attempted = append(attempted, providerID)
		results, err := implementation.Search(ctx, s.client, request)
		if err != nil {
			s.recordFailure(providerID)
			lastError = err
			s.logger.Printf("[搜索] %s 失败: %v", providerID, err)
			continue
		}
		s.recordSuccess(providerID)
		normalized := s.normalize(results, request)
		if len(normalized) == 0 {
			lastError = fmt.Errorf("%s 返回结果被过滤为空", providerID)
			continue
		}
		s.logger.Printf("[搜索] %s 返回 %d 条: %s", providerID, len(normalized), query)
		return normalized, attempted, nil
	}

	if lastError == nil {
		lastError = fmt.Errorf("没有可用的搜索引擎")
	}
	return nil, attempted, lastError
}

// FetchPage 抓取网页正文。
func (s *Service) FetchPage(ctx context.Context, rawURL string, maxChars int) (*Page, error) {
	config := s.config.Fetch
	if !config.Enabled {
		return nil, fmt.Errorf("网页抓取已在配置中关闭")
	}
	if maxChars <= 0 {
		maxChars = config.MaxChars
	}
	return Fetch(ctx, s.client, rawURL, maxChars, time.Duration(config.TimeoutMs)*time.Millisecond)
}

func (s *Service) normalize(results []Result, request Request) []Result {
	limit := request.Limit
	if limit <= 0 {
		limit = s.config.MaxResults
	}
	output := []Result{}
	seen := map[string]bool{}
	for _, item := range results {
		title := strings.TrimSpace(StripHTML(item.Title))
		link := strings.TrimSpace(item.URL)
		if title == "" || link == "" || !strings.HasPrefix(link, "http") {
			continue
		}
		domain := domainOf(link)
		if !domainAllowed(domain, s.config.AllowedDomains, s.config.BlockedDomains) {
			continue
		}
		key := strings.ToLower(link)
		if seen[key] {
			continue
		}
		seen[key] = true
		snippet := strings.TrimSpace(StripHTML(item.Snippet))
		if s.config.MaxSnippetLength > 0 && len([]rune(snippet)) > s.config.MaxSnippetLength {
			runes := []rune(snippet)
			snippet = string(runes[:s.config.MaxSnippetLength]) + "…"
		}
		output = append(output, Result{Title: title, URL: link, Snippet: snippet, Source: item.Source})
		if len(output) >= limit {
			break
		}
	}
	return output
}

func domainOf(rawURL string) string {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	return strings.ToLower(strings.TrimPrefix(parsed.Hostname(), "www."))
}

func domainAllowed(domain string, allowed []string, blocked []string) bool {
	for _, item := range blocked {
		if item != "" && (domain == item || strings.HasSuffix(domain, "."+item)) {
			return false
		}
	}
	if len(allowed) == 0 {
		return true
	}
	for _, item := range allowed {
		if item != "" && (domain == item || strings.HasSuffix(domain, "."+item)) {
			return true
		}
	}
	return false
}

func findProvider(id string) provider {
	normalized := normalizeProviderID(id)
	for _, item := range Providers() {
		if item.ID() == normalized {
			return item
		}
	}
	return nil
}

func normalizeProviderID(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "google", "bing":
		return "duckduckgo"
	case "duckduckgo", "searxng", "tavily", "brave", "serpapi":
		return normalized
	default:
		return "duckduckgo"
	}
}

const (
	breakerThreshold = 3
	breakerCooldown  = 90 * time.Second
)

func (s *Service) recordFailure(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[id]++
	if s.failures[id] >= breakerThreshold {
		s.breakerTl[id] = time.Now().Add(breakerCooldown)
		s.logger.Printf("[搜索] %s 连续失败 %d 次，进入 %s 冷却", id, s.failures[id], breakerCooldown)
	}
}

func (s *Service) recordSuccess(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failures[id] = 0
	delete(s.breakerTl, id)
}

func (s *Service) breakerOpen(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	until, ok := s.breakerTl[id]
	if !ok {
		return false
	}
	if time.Now().After(until) {
		delete(s.breakerTl, id)
		s.failures[id] = 0
		return false
	}
	return true
}
