package tools

import (
	"encoding/json"
	"strings"
	"testing"

	"mimirlink/internal/config"
	"mimirlink/internal/mcp"
)

func newDocument(t *testing.T, raw map[string]any) *config.Document {
	t.Helper()
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("序列化失败: %v", err)
	}
	document, err := config.New("config.json", encoded)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	return document
}

// TestBuildWebToolHintDisabled：未开启联网时不下发说明。
func TestBuildWebToolHintDisabled(t *testing.T) {
	document := newDocument(t, map[string]any{})
	if hint := BuildWebToolHint(document); hint != "" {
		t.Fatalf("未开启联网不应有说明: %s", hint)
	}
	if hint := BuildWebToolHint(nil); hint != "" {
		t.Fatalf("空配置不应有说明: %s", hint)
	}
}

// TestBuildWebToolHintDefaults：文案与默认值对齐 Node（5 条 / 10000ms / 800 字 / fetch+spice 默认开）。
func TestBuildWebToolHintDefaults(t *testing.T) {
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"webSearch": map[string]any{"enabled": true}}},
	})
	hint := BuildWebToolHint(document)
	for _, expected := range []string{
		"【功能：联网检索】",
		"web_search", "web_fetch", "get_weather", "convert_currency",
		"limit=条数（默认 5）",
		"单次搜索超时 10000ms",
		"单条摘要最长 800 字",
		"days（默认 3）",
	} {
		if !strings.Contains(hint, expected) {
			t.Fatalf("说明缺少 %q: %s", expected, hint)
		}
	}
}

// TestBuildWebToolHintFetchDisabled：关闭 fetch 后可用组件与条目同步收敛。
func TestBuildWebToolHintFetchDisabled(t *testing.T) {
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"webSearch": map[string]any{
			"enabled": true,
			"fetch":   map[string]any{"enabled": false},
			"spice":   map[string]any{"enabled": false},
		}}},
	})
	hint := BuildWebToolHint(document)
	if strings.Contains(hint, "web_fetch") || strings.Contains(hint, "get_weather") {
		t.Fatalf("关闭后不应出现 web_fetch/get_weather: %s", hint)
	}
	if !strings.Contains(hint, "可用组件：web_search。") {
		t.Fatalf("可用组件应只剩 web_search: %s", hint)
	}
}

// TestBuildMentionToolHint：主动 @ 说明随开关出现/消失。
func TestBuildMentionToolHint(t *testing.T) {
	if hint := BuildMentionToolHint(newDocument(t, map[string]any{})); hint != "" {
		t.Fatalf("未开启主动 @ 不应有说明: %s", hint)
	}
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"sendMention": map[string]any{"enabled": true}}},
	})
	hint := BuildMentionToolHint(document)
	if !strings.Contains(hint, "send_group_mention") || !strings.Contains(hint, "禁止 @all") {
		t.Fatalf("主动 @ 说明不完整: %s", hint)
	}
}

// TestBuildMcpToolHint：按服务器分组列出工具，并给出硬约束。
func TestBuildMcpToolHint(t *testing.T) {
	if hint := BuildMcpToolHint(nil); hint != "" {
		t.Fatalf("无工具不应有说明: %s", hint)
	}
	definitions := []mcp.ToolDefinition{
		{Name: "mcp__files__read", ServerID: "files", ServerName: "files", ToolName: "read"},
		{Name: "mcp__files__write", ServerID: "files", ServerName: "files", ToolName: "write"},
		{Name: "mcp__db__query", ServerID: "db", ServerName: "db", ToolName: "query"},
	}
	hint := BuildMcpToolHint(definitions)
	for _, expected := range []string{
		"【功能：外部 MCP 工具】",
		"已连接服务器（共 3 个工具，名称以 mcp__ 开头）：",
		"- files（2）：read、write",
		"- db（1）：query",
		"只能调用上面列出的工具名",
	} {
		if !strings.Contains(hint, expected) {
			t.Fatalf("MCP 说明缺少 %q:\n%s", expected, hint)
		}
	}
}

// TestHintsForOrdering：总则置首，未启用任何功能时不下发。
func TestHintsForOrdering(t *testing.T) {
	if hints := HintsFor(newDocument(t, map[string]any{}), nil); len(hints) != 0 {
		t.Fatalf("无工具时不应有说明: %v", hints)
	}
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{
			"webSearch":   map[string]any{"enabled": true},
			"sendMention": map[string]any{"enabled": true},
		}},
	})
	client := mcp.NewForTest(map[string]func(args map[string]any) (string, error){"read": func(args map[string]any) (string, error) { return "ok", nil }})
	hints := HintsFor(document, client)
	if len(hints) != 4 {
		t.Fatalf("应下发 4 段说明（总则/联网/主动@/MCP），实际 %d", len(hints))
	}
	if !strings.HasPrefix(hints[0], "【工具使用总则】") {
		t.Fatalf("总则应在最前: %s", hints[0])
	}
	if !strings.Contains(hints[3], "- test（1）：read") {
		t.Fatalf("MCP 段应按服务器列出工具名: %s", hints[3])
	}
}

// TestToolNamesForPreview：面板预览按配置推导工具名。
func TestToolNamesForPreview(t *testing.T) {
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{
			"webSearch":   map[string]any{"enabled": true, "fetch": map[string]any{"enabled": false}},
			"sendMention": map[string]any{"enabled": true},
		}},
	})
	names := ToolNamesForPreview(document, nil)
	expected := []string{"web_search", "get_weather", "convert_currency", "send_group_mention"}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("工具名不符: %v", names)
	}
	if names := ToolNamesForPreview(newDocument(t, map[string]any{}), nil); len(names) != 0 {
		t.Fatalf("未启用时不应有工具名: %v", names)
	}
}

// TestLoadSearchConfigSpiceDefaults spice/mcpFallbackMaxChars归一（对齐Node normalizeWebSearchConfig）。
func TestLoadSearchConfigSpiceDefaults(t *testing.T) {
	// 空配置：spice 默认启用/weatherDays=3/mcpFallbackMaxChars=4000
	loaded := LoadSearchConfig(newDocument(t, map[string]any{}))
	if !loaded.Spice.Enabled || loaded.Spice.WeatherDays != 3 {
		t.Fatalf("spice 默认应启用/3天: %+v", loaded.Spice)
	}
	if loaded.MCPFallbackMaxChars != 4000 {
		t.Fatalf("mcpFallbackMaxChars 默认 4000，实际 %d", loaded.MCPFallbackMaxChars)
	}
	// 显式关闭 spice
	loaded = LoadSearchConfig(newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"webSearch": map[string]any{
			"spice":               map[string]any{"enabled": false, "weatherDays": 7},
			"mcpFallbackMaxChars": 8000,
		}}},
	}))
	if loaded.Spice.Enabled || loaded.Spice.WeatherDays != 7 {
		t.Fatalf("显式 spice 配置未生效: %+v", loaded.Spice)
	}
	if loaded.MCPFallbackMaxChars != 8000 {
		t.Fatalf("mcpFallbackMaxChars 未生效，实际 %d", loaded.MCPFallbackMaxChars)
	}
	// 越界 clamp
	loaded = LoadSearchConfig(newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"webSearch": map[string]any{
			"spice":               map[string]any{"weatherDays": 99},
			"mcpFallbackMaxChars": 1,
		}}},
	}))
	if loaded.Spice.WeatherDays != 7 {
		t.Fatalf("weatherDays 应 clamp 到 7，实际 %d", loaded.Spice.WeatherDays)
	}
	if loaded.MCPFallbackMaxChars != 500 {
		t.Fatalf("mcpFallbackMaxChars 应 clamp 到 500，实际 %d", loaded.MCPFallbackMaxChars)
	}
}

// TestLoadSearchConfigFromMap 支持从 map 草稿解析搜索配置。
func TestLoadSearchConfigFromMap(t *testing.T) {
	draft := map[string]any{
		"enabled":  true,
		"provider": "tavily",
		"apiKeys": map[string]any{
			"tavily": "tvly-test-123",
		},
		"maxResults": 8,
	}
	cfg := LoadSearchConfigFromMap(draft)
	if !cfg.Enabled || cfg.Provider != "tavily" || cfg.APIKeys["tavily"] != "tvly-test-123" || cfg.MaxResults != 8 {
		t.Fatalf("从 map 草稿解析搜索配置异常: %+v", cfg)
	}
}
