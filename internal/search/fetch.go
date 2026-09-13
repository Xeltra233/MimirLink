package search

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Page 是抓取到的网页正文。
type Page struct {
	URL       string `json:"url"`
	Title     string `json:"title"`
	Text      string `json:"text"`
	Truncated bool   `json:"truncated"`
	Chars     int    `json:"chars"`
}

var (
	bodyBlockRe   = regexp.MustCompile(`(?is)<(?:main|article|div[^>]*\b(?:id|class)\s*=\s*["'][^"']*(?:content|article|post|entry|markdown)[^"']*["'])[^>]*>([\s\S]*?)</(?:main|article|div)>`)
	paragraphRe   = regexp.MustCompile(`(?is)<(?:p|br|div|li|h[1-6]|tr|section)[^>]*>`)
	multiLineRe   = regexp.MustCompile(`\n{3,}`)
	spaceLineRe   = regexp.MustCompile(`[ \t]{2,}`)
	metaDescRe    = regexp.MustCompile(`(?is)<meta[^>]+name\s*=\s*["']description["'][^>]+content\s*=\s*["']([^"']*)["']`)
	dangerousHost = regexp.MustCompile(`^(?:localhost|.*\.local|.*\.internal)$`)
)

// Fetch 抓取网页并提取正文。
func Fetch(ctx context.Context, client *Client, rawURL string, maxChars int, timeout time.Duration) (*Page, error) {
	target := strings.TrimSpace(rawURL)
	if target == "" {
		return nil, fmt.Errorf("网页地址不能为空")
	}
	if !strings.HasPrefix(target, "http://") && !strings.HasPrefix(target, "https://") {
		target = "https://" + target
	}
	parsed, err := url.Parse(target)
	if err != nil || parsed.Host == "" {
		return nil, fmt.Errorf("无效的网页地址: %s", rawURL)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("只支持 http/https 公开地址")
	}
	if dangerousHost.MatchString(strings.ToLower(parsed.Hostname())) {
		return nil, fmt.Errorf("拒绝访问内网地址")
	}
	if ip := net.ParseIP(parsed.Hostname()); ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()) {
		return nil, fmt.Errorf("拒绝访问内网地址")
	}

	response, err := client.RequestText(ctx, target, requestOptions{
		Headers: map[string]string{"Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"},
		Timeout: timeout,
	})
	if err != nil {
		return nil, fmt.Errorf("网页请求失败: %w", err)
	}
	if !response.OK {
		return nil, fmt.Errorf("网页返回 HTTP %d", response.Status)
	}

	contentType := "text/html"
	title := PageTitle(response.Body)
	text := ""
	if strings.Contains(contentType, "json") || strings.HasPrefix(strings.TrimSpace(response.Body), "{") {
		text = response.Body
	} else {
		text = extractReadableText(response.Body)
	}
	if description := metaDescRe.FindStringSubmatch(response.Body); title == "" && description != nil {
		title = StripHTML(description[1])
	}
	if strings.TrimSpace(text) == "" {
		return nil, fmt.Errorf("网页正文为空（可能由 JavaScript 渲染）")
	}

	truncated := false
	runes := []rune(text)
	if maxChars > 0 && len(runes) > maxChars {
		text = string(runes[:maxChars])
		truncated = true
	}
	return &Page{URL: target, Title: title, Text: text, Truncated: truncated, Chars: len([]rune(text))}, nil
}

// extractReadableText 粗提取正文：优先正文块，否则整页去标签。
func extractReadableText(body string) string {
	candidate := body
	if match := bodyBlockRe.FindStringSubmatch(body); match != nil && len([]rune(match[1])) > 200 {
		candidate = match[1]
	}
	candidate = scriptRegex.ReplaceAllString(candidate, " ")
	candidate = styleRegex.ReplaceAllString(candidate, " ")
	candidate = paragraphRe.ReplaceAllString(candidate, "\n")
	text := StripHTML(candidate)
	// StripHTML 已压缩空白，这里恢复段落换行
	text = strings.ReplaceAll(text, "。 ", "。\n")
	text = strings.ReplaceAll(text, "！ ", "！\n")
	text = strings.ReplaceAll(text, "？ ", "？\n")
	text = multiLineRe.ReplaceAllString(text, "\n\n")
	text = spaceLineRe.ReplaceAllString(text, " ")
	return strings.TrimSpace(text)
}
