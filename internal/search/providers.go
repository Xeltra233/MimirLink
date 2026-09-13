package search

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Request 是一次搜索请求。
type Request struct {
	Query     string
	Limit     int
	Topic     string
	TimeRange string
	Site      string
	Config    Config
}

// provider 是搜索源。
type provider interface {
	ID() string
	Label() string
	Search(ctx context.Context, client *Client, request Request) ([]Result, error)
}

// Providers 返回全部 provider（顺序即默认回退顺序）。
func Providers() []provider {
	return []provider{duckDuckGoProvider{}, searxngProvider{}, tavilyProvider{}, braveProvider{}, serpapiProvider{}}
}

// ProviderLabels 返回 provider 中文标签（用于工具描述）。
func ProviderLabels() []string {
	labels := []string{}
	for _, item := range Providers() {
		labels = append(labels, item.Label())
	}
	return labels
}

// ---------------- DuckDuckGo ----------------

type duckDuckGoProvider struct{}

func (duckDuckGoProvider) ID() string { return "duckduckgo" }

func (duckDuckGoProvider) Label() string { return "DuckDuckGo（免费，无需密钥）" }

var (
	timeRangeMap = map[string]string{"day": "d", "week": "w", "month": "m", "year": "y"}
	vqdRegex     = regexp.MustCompile(`vqd=['"](\d+-\d+(?:-\d+)?)['"]`)
	vqdCache     = struct {
		sync.Mutex
		items map[string]struct {
			vqd       string
			expiresAt time.Time
		}
	}{items: map[string]struct {
		vqd       string
		expiresAt time.Time
	}{}}
)

func buildQuery(request Request) string {
	query := strings.TrimSpace(request.Query)
	site := strings.TrimSpace(request.Site)
	if site == "" {
		return query
	}
	return "site:" + site + " " + query
}

func resolveTimeRange(value string) string {
	return timeRangeMap[strings.ToLower(strings.TrimSpace(value))]
}

func (duckDuckGoProvider) Search(ctx context.Context, client *Client, request Request) ([]Result, error) {
	if strings.EqualFold(request.Topic, "news") {
		return duckDuckGoNews(ctx, client, request)
	}

	query := buildQuery(request)
	region := request.Config.Region
	if region == "" {
		region = "cn-zh"
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	timeout := time.Duration(request.Config.TimeoutMs) * time.Millisecond

	params := url.Values{}
	params.Set("q", query)
	params.Set("l", region)
	if rangeValue := resolveTimeRange(request.TimeRange); rangeValue != "" {
		params.Set("df", rangeValue)
	}
	response, err := client.RequestText(ctx, "https://html.duckduckgo.com/html/?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "text/html,application/xhtml+xml"},
		Timeout: timeout,
	})
	if err == nil && response.OK && !IsChallengePage(response.Body) {
		if results := ExtractDuckDuckGoHTMLResults(response.Body, limit); len(results) > 0 {
			for index := range results {
				results[index].Source = "duckduckgo_html"
			}
			return results, nil
		}
	}

	// lite 端点兜底
	liteParams := url.Values{}
	liteParams.Set("q", query)
	liteParams.Set("kl", region)
	if rangeValue := resolveTimeRange(request.TimeRange); rangeValue != "" {
		liteParams.Set("df", rangeValue)
	}
	liteResponse, liteErr := client.RequestText(ctx, "https://lite.duckduckgo.com/lite/?"+liteParams.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "text/html,application/xhtml+xml"},
		Timeout: timeout,
	})
	if liteErr != nil {
		if err != nil {
			return nil, fmt.Errorf("html 端点失败(%v)，lite 端点失败(%v)", err, liteErr)
		}
		return nil, fmt.Errorf("lite 端点失败: %w", liteErr)
	}
	if !liteResponse.OK {
		return nil, fmt.Errorf("lite 端点 HTTP %d", liteResponse.Status)
	}
	if IsChallengePage(liteResponse.Body) {
		return nil, fmt.Errorf("DuckDuckGo 触发反爬验证（html 与 lite 端点均被拦截）")
	}
	results := ExtractDuckDuckGoLiteResults(liteResponse.Body, limit)
	for index := range results {
		results[index].Source = "duckduckgo_lite"
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("DuckDuckGo 未返回结果")
	}
	return results, nil
}

func duckDuckGoNews(ctx context.Context, client *Client, request Request) ([]Result, error) {
	query := buildQuery(request)
	timeout := time.Duration(request.Config.TimeoutMs) * time.Millisecond
	vqd, err := resolveVQD(ctx, client, query, timeout)
	if err != nil {
		return nil, err
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	params := url.Values{}
	params.Set("q", query)
	params.Set("vqd", vqd)
	params.Set("kl", "cn-zh")
	if rangeValue := resolveTimeRange(request.TimeRange); rangeValue != "" {
		params.Set("df", rangeValue)
	}
	var payload struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Excerpt string `json:"excerpt"`
			Image   string `json:"image"`
		} `json:"results"`
	}
	if err := client.RequestJSON(ctx, "https://duckduckgo.com/news.js?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "application/json"},
		Timeout: timeout,
	}, &payload); err != nil {
		return nil, fmt.Errorf("新闻接口请求失败: %w", err)
	}
	results := []Result{}
	for _, item := range payload.Results {
		if item.URL == "" {
			continue
		}
		results = append(results, Result{Title: StripHTML(item.Title), URL: item.URL, Snippet: StripHTML(item.Excerpt), Source: "duckduckgo_news"})
		if len(results) >= limit {
			break
		}
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("新闻接口未返回结果")
	}
	return results, nil
}

func resolveVQD(ctx context.Context, client *Client, query string, timeout time.Duration) (string, error) {
	vqdCache.Lock()
	if cached, ok := vqdCache.items[query]; ok && cached.expiresAt.After(time.Now()) {
		vqdCache.Unlock()
		return cached.vqd, nil
	}
	vqdCache.Unlock()

	params := url.Values{}
	params.Set("q", query)
	params.Set("ia", "web")
	response, err := client.RequestText(ctx, "https://duckduckgo.com/?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "text/html,application/xhtml+xml"},
		Timeout: timeout,
	})
	if err != nil {
		return "", fmt.Errorf("获取 DuckDuckGo vqd 失败: %w", err)
	}
	match := vqdRegex.FindStringSubmatch(response.Body)
	if match == nil {
		return "", fmt.Errorf("获取 DuckDuckGo vqd 失败：页面未返回令牌（可能被反爬拦截）")
	}
	vqdCache.Lock()
	vqdCache.items[query] = struct {
		vqd       string
		expiresAt time.Time
	}{vqd: match[1], expiresAt: time.Now().Add(5 * time.Minute)}
	vqdCache.Unlock()
	return match[1], nil
}

// ---------------- SearXNG ----------------

type searxngProvider struct{}

func (searxngProvider) ID() string { return "searxng" }

func (searxngProvider) Label() string { return "SearXNG（自建实例）" }

func (searxngProvider) Search(ctx context.Context, client *Client, request Request) ([]Result, error) {
	base := normalizeSearxngBaseURL(request.Config.SearxngBaseURL)
	if base == "" {
		return nil, fmt.Errorf("未配置 SearXNG 实例地址")
	}
	category := "general"
	if strings.EqualFold(request.Topic, "news") {
		category = "news"
	}
	params := url.Values{}
	params.Set("q", buildQuery(request))
	params.Set("format", "json")
	params.Set("categories", category)
	if request.Config.Locale != "" {
		params.Set("language", request.Config.Locale)
	}
	if engines := strings.TrimSpace(request.Config.SearxngEngines); engines != "" {
		params.Set("engines", engines)
	}
	if value := request.Config.SafeSearch; value == "strict" || value == "off" {
		params.Set("safesearch", value)
	}
	if rangeValue := resolveTimeRange(request.TimeRange); rangeValue != "" {
		params.Set("time_range", map[string]string{"d": "day", "w": "week", "m": "month", "y": "year"}[rangeValue])
	}
	var payload struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := client.RequestJSON(ctx, base+"/search?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "application/json"},
		Timeout: time.Duration(request.Config.TimeoutMs) * time.Millisecond,
	}, &payload); err != nil {
		return nil, fmt.Errorf("SearXNG 请求失败: %w", err)
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	results := []Result{}
	for _, item := range payload.Results {
		if item.URL == "" {
			continue
		}
		results = append(results, Result{Title: StripHTML(item.Title), URL: item.URL, Snippet: StripHTML(item.Content), Source: "searxng"})
		if len(results) >= limit {
			break
		}
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("SearXNG 未返回结果")
	}
	return results, nil
}

func normalizeSearxngBaseURL(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ""
	}
	if !strings.HasPrefix(value, "http://") && !strings.HasPrefix(value, "https://") {
		value = "http://" + value
	}
	return strings.TrimRight(value, "/")
}

// ---------------- Tavily ----------------

type tavilyProvider struct{}

func (tavilyProvider) ID() string { return "tavily" }

func (tavilyProvider) Label() string { return "Tavily（需 API Key）" }

func (tavilyProvider) Search(ctx context.Context, client *Client, request Request) ([]Result, error) {
	apiKey := strings.TrimSpace(request.Config.APIKeys["tavily"])
	if apiKey == "" {
		return nil, fmt.Errorf("未配置 Tavily API Key")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	body, _ := json.Marshal(map[string]any{
		"api_key":        apiKey,
		"query":          buildQuery(request),
		"max_results":    limit,
		"search_depth":   "basic",
		"include_answer": false,
	})
	var payload struct {
		Results []struct {
			Title   string `json:"title"`
			URL     string `json:"url"`
			Content string `json:"content"`
		} `json:"results"`
	}
	if err := client.RequestJSON(ctx, "https://api.tavily.com/search", requestOptions{
		Method:  "POST",
		Headers: map[string]string{"Content-Type": "application/json", "Accept": "application/json"},
		Body:    string(body),
		Timeout: time.Duration(request.Config.TimeoutMs) * time.Millisecond,
	}, &payload); err != nil {
		return nil, fmt.Errorf("Tavily 请求失败: %w", err)
	}
	results := []Result{}
	for _, item := range payload.Results {
		if item.URL == "" {
			continue
		}
		results = append(results, Result{Title: StripHTML(item.Title), URL: item.URL, Snippet: StripHTML(item.Content), Source: "tavily"})
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("Tavily 未返回结果")
	}
	return results, nil
}

// ---------------- Brave ----------------

type braveProvider struct{}

func (braveProvider) ID() string { return "brave" }

func (braveProvider) Label() string { return "Brave Search（需 API Key）" }

func (braveProvider) Search(ctx context.Context, client *Client, request Request) ([]Result, error) {
	apiKey := strings.TrimSpace(request.Config.APIKeys["brave"])
	if apiKey == "" {
		return nil, fmt.Errorf("未配置 Brave API Key")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	params := url.Values{}
	params.Set("q", buildQuery(request))
	params.Set("count", strconv.Itoa(limit))
	if request.Config.Locale != "" {
		params.Set("search_lang", strings.Split(request.Config.Locale, "-")[0])
	}
	if value := request.Config.SafeSearch; value == "strict" || value == "off" {
		params.Set("safesearch", value)
	}
	var payload struct {
		Web struct {
			Results []struct {
				Title       string `json:"title"`
				URL         string `json:"url"`
				Description string `json:"description"`
			} `json:"results"`
		} `json:"web"`
	}
	if err := client.RequestJSON(ctx, "https://api.search.brave.com/res/v1/web/search?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "application/json", "X-Subscription-Token": apiKey},
		Timeout: time.Duration(request.Config.TimeoutMs) * time.Millisecond,
	}, &payload); err != nil {
		return nil, fmt.Errorf("Brave 请求失败: %w", err)
	}
	results := []Result{}
	for _, item := range payload.Web.Results {
		if item.URL == "" {
			continue
		}
		results = append(results, Result{Title: StripHTML(item.Title), URL: item.URL, Snippet: StripHTML(item.Description), Source: "brave"})
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("Brave 未返回结果")
	}
	return results, nil
}

// ---------------- SerpAPI ----------------

type serpapiProvider struct{}

func (serpapiProvider) ID() string { return "serpapi" }

func (serpapiProvider) Label() string { return "SerpAPI（需 API Key）" }

func (serpapiProvider) Search(ctx context.Context, client *Client, request Request) ([]Result, error) {
	apiKey := strings.TrimSpace(request.Config.APIKeys["serpapi"])
	if apiKey == "" {
		return nil, fmt.Errorf("未配置 SerpAPI Key")
	}
	limit := request.Limit
	if limit <= 0 {
		limit = request.Config.MaxResults
	}
	params := url.Values{}
	params.Set("engine", "google")
	params.Set("q", buildQuery(request))
	params.Set("api_key", apiKey)
	params.Set("num", strconv.Itoa(limit))
	if request.Config.Locale != "" {
		params.Set("hl", request.Config.Locale)
	}
	if value := request.Config.SafeSearch; value == "strict" || value == "off" {
		params.Set("safe", value)
	}
	var payload struct {
		OrganicResults []struct {
			Title   string `json:"title"`
			Link    string `json:"link"`
			Snippet string `json:"snippet"`
		} `json:"organic_results"`
	}
	if err := client.RequestJSON(ctx, "https://serpapi.com/search.json?"+params.Encode(), requestOptions{
		Headers: map[string]string{"Accept": "application/json"},
		Timeout: time.Duration(request.Config.TimeoutMs) * time.Millisecond,
	}, &payload); err != nil {
		return nil, fmt.Errorf("SerpAPI 请求失败: %w", err)
	}
	results := []Result{}
	for _, item := range payload.OrganicResults {
		if item.Link == "" {
			continue
		}
		results = append(results, Result{Title: StripHTML(item.Title), URL: item.Link, Snippet: StripHTML(item.Snippet), Source: "serpapi"})
		if len(results) >= limit {
			break
		}
	}
	if len(results) == 0 {
		return nil, fmt.Errorf("SerpAPI 未返回结果")
	}
	return results, nil
}
