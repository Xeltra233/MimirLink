// Package search 提供服务端搜索与网页抓取能力。
//
// 移植自 Node 版 src/search/（ddgs / duck-duck-scrape 思路），保持相同的结果结构与配置键
// （ai.tools.webSearch），便于新旧版本共用同一份 config.json。
package search

import (
	"html"
	"net/url"
	"regexp"
	"strings"
)

var (
	scriptRegex   = regexp.MustCompile(`(?is)<script[\s\S]*?</script>`)
	styleRegex    = regexp.MustCompile(`(?is)<style[\s\S]*?</style>`)
	tagRegex      = regexp.MustCompile(`(?s)<[^>]*>`)
	whitespaceRe  = regexp.MustCompile(`\s+`)
	challengeRe   = regexp.MustCompile(`(?i)anomalyDetectionBlock|anomaly-modal|DDG\.deep\.is506|jsa_hash|challenge-form|Sorry, you have been blocked`)
	anchorRegex   = regexp.MustCompile(`(?is)<a\b([^>]*)>([\s\S]*?)</a>`)
	snippetHTMLRe = regexp.MustCompile(`(?is)<(?:a|div|span|td)[^>]*\bclass\s*=\s*"([^"]*\bresult__snippet\b[^"]*)"[^>]*>([\s\S]*?)</(?:a|div|span|td)>`)
	snippetLiteRe = regexp.MustCompile(`(?is)<td\b[^>]*\bclass\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)</td>`)
	titleTagRe    = regexp.MustCompile(`(?is)<title[^>]*>([\s\S]*?)</title>`)
)

// DecodeHTML 解码 HTML 实体。
func DecodeHTML(value string) string {
	if value == "" {
		return ""
	}
	return html.UnescapeString(value)
}

// StripHTML 去标签、脚本、样式并解码实体，压缩空白。
func StripHTML(value string) string {
	if value == "" {
		return ""
	}
	text := scriptRegex.ReplaceAllString(value, " ")
	text = styleRegex.ReplaceAllString(text, " ")
	text = tagRegex.ReplaceAllString(text, " ")
	text = DecodeHTML(text)
	return strings.TrimSpace(whitespaceRe.ReplaceAllString(text, " "))
}

func extractAttribute(attributes string, name string) string {
	pattern := regexp.MustCompile(`(?i)` + regexp.QuoteMeta(name) + `\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`)
	match := pattern.FindStringSubmatch(attributes)
	if match == nil {
		return ""
	}
	for _, candidate := range match[1:] {
		if candidate != "" {
			return candidate
		}
	}
	return ""
}

// UnwrapDuckDuckGoRedirect 解包 DDG 的 /l/?uddg= 跳转链接。
func UnwrapDuckDuckGoRedirect(href string) string {
	raw := strings.TrimSpace(href)
	if raw == "" {
		return ""
	}
	lowered := strings.ToLower(raw)
	isRedirect := strings.HasPrefix(lowered, "/l/?") ||
		regexp.MustCompile(`(?i)^(?:https?:)?//(?:www\.)?duckduckgo\.com/l/\?`).MatchString(raw)
	if isRedirect {
		normalized := raw
		if strings.HasPrefix(raw, "//") {
			normalized = "https:" + raw
		}
		parsed, err := url.Parse(normalized)
		if err != nil {
			// 相对路径形式：手动取 uddg 参数
			if index := strings.Index(normalized, "uddg="); index >= 0 {
				value := normalized[index+5:]
				if decoded, err := url.QueryUnescape(value); err == nil {
					return decoded
				}
			}
			return ""
		}
		target := parsed.Query().Get("uddg")
		if target != "" {
			return target
		}
		return ""
	}
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	return raw
}

// IsChallengePage 识别 DDG 反爬/验证码页。
func IsChallengePage(body string) bool {
	return challengeRe.MatchString(body)
}

// Result 是一条搜索结果。
type Result struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	Source  string `json:"source,omitempty"`
}

type anchor struct {
	start int
	end   int
	href  string
	title string
}

// ExtractDuckDuckGoHTMLResults 解析 html.duckduckgo.com 结果页。
func ExtractDuckDuckGoHTMLResults(body string, limit int) []Result {
	links := []anchor{}
	for _, match := range anchorRegex.FindAllStringSubmatchIndex(body, -1) {
		attributes := body[match[2]:match[3]]
		if !regexp.MustCompile(`\bresult__a\b`).MatchString(extractAttribute(attributes, "class")) {
			continue
		}
		href := extractAttribute(attributes, "href")
		title := StripHTML(body[match[4]:match[5]])
		if href == "" || title == "" {
			continue
		}
		links = append(links, anchor{start: match[0], end: match[1], href: href, title: title})
	}

	if limit < 1 {
		limit = 5
	}
	results := []Result{}
	for index, item := range links {
		nextStart := len(body)
		if index+1 < len(links) {
			nextStart = links[index+1].start
		}
		block := body[item.end:nextStart]
		snippet := ""
		if match := snippetHTMLRe.FindStringSubmatch(block); match != nil {
			snippet = StripHTML(match[2])
		}
		target := UnwrapDuckDuckGoRedirect(item.href)
		if target == "" {
			continue
		}
		results = append(results, Result{Title: item.title, URL: target, Snippet: snippet})
		if len(results) >= limit {
			break
		}
	}
	return results
}

// ExtractDuckDuckGoLiteResults 解析 lite.duckduckgo.com 结果页。
func ExtractDuckDuckGoLiteResults(body string, limit int) []Result {
	titles := []anchor{}
	for _, match := range anchorRegex.FindAllStringSubmatchIndex(body, -1) {
		attributes := body[match[2]:match[3]]
		if !regexp.MustCompile(`\bresult-link\b`).MatchString(extractAttribute(attributes, "class")) {
			continue
		}
		href := extractAttribute(attributes, "href")
		title := StripHTML(body[match[4]:match[5]])
		if href == "" || title == "" {
			continue
		}
		titles = append(titles, anchor{start: match[0], end: match[1], href: href, title: title})
	}

	snippets := []struct {
		start int
		text  string
	}{}
	for _, match := range snippetLiteRe.FindAllStringSubmatchIndex(body, -1) {
		snippets = append(snippets, struct {
			start int
			text  string
		}{start: match[0], text: StripHTML(body[match[2]:match[3]])})
	}

	if limit < 1 {
		limit = 5
	}
	results := []Result{}
	for _, item := range titles {
		target := UnwrapDuckDuckGoRedirect(item.href)
		if target == "" {
			continue
		}
		snippet := ""
		for _, entry := range snippets {
			if entry.start > item.end {
				snippet = entry.text
				break
			}
		}
		results = append(results, Result{Title: item.title, URL: target, Snippet: snippet})
		if len(results) >= limit {
			break
		}
	}
	return results
}

// PageTitle 提取 <title>。
func PageTitle(body string) string {
	if match := titleTagRe.FindStringSubmatch(body); match != nil {
		return StripHTML(match[1])
	}
	return ""
}
