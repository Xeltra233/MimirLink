package mcp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 一个最小的 MCP stdio 服务器（Node 实现，覆盖 initialize / tools/list / tools/call / 错误）。
const echoServerSource = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const tools = [
    { name: 'echo', description: '回显输入', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'secret', description: '会被过滤掉的工具', inputSchema: { type: 'object' } }
];
rl.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return; // 通知
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
    const fail = (text) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: text } }) + '\n');
    switch (message.method) {
        case 'initialize':
            return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '0.0.1' } });
        case 'tools/list':
            return reply({ tools });
        case 'tools/call': {
            const name = message.params?.name;
            if (name === 'echo') {
                return reply({ content: [{ type: 'text', text: 'echo:' + (message.params?.arguments?.text ?? '') }] });
            }
            if (name === 'fail') {
                return reply({ content: [{ type: 'text', text: '业务失败' }], isError: true });
            }
            return fail('未知工具: ' + name);
        }
        default:
            return fail('未知方法: ' + message.method);
    }
});
`

func writeEchoServer(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, "echo-mcp.js")
	if err := os.WriteFile(path, []byte(echoServerSource), 0o644); err != nil {
		t.Fatalf("写入测试服务器失败: %v", err)
	}
	return path
}

func newTestClient(t *testing.T, servers []ServerConfig) *Client {
	t.Helper()
	client := New(ClientConfig{Enabled: true, MaxResultChars: 4000, Servers: servers}, testLogger{t})
	client.ConnectAll(context.Background())
	t.Cleanup(client.Close)
	return client
}

type testLogger struct{ t *testing.T }

func (l testLogger) Printf(format string, args ...any) { l.t.Logf(format, args...) }

func TestStdioTransportConnectsAndListsTools(t *testing.T) {
	script := writeEchoServer(t)
	client := newTestClient(t, []ServerConfig{{
		ID: "echo-1", Name: "echo-server", Enabled: true, Transport: "stdio",
		Command: "node", Args: []string{script}, TimeoutMs: 20000,
	}})

	definitions := client.Definitions()
	names := []string{}
	for _, definition := range definitions {
		names = append(names, definition.Name)
	}
	if len(definitions) != 2 {
		t.Fatalf("应发现 2 个工具，实际 %d（%v）", len(definitions), names)
	}
	if !containsString(names, "mcp__echo_server__echo") {
		t.Fatalf("工具名规则不符: %v", names)
	}
	for _, definition := range definitions {
		if definition.ToolName != "echo" {
			continue
		}
		description := definition.Definition["function"].(map[string]any)["description"].(string)
		if !strings.HasPrefix(description, "[MCP:echo-server] ") {
			t.Fatalf("工具描述未带服务器前缀: %s", description)
		}
		parameters := definition.Definition["function"].(map[string]any)["parameters"].(map[string]any)
		if parameters["type"] != "object" {
			t.Fatalf("参数 schema 未归一化: %v", parameters)
		}
	}
}

func TestStdioToolCallAndError(t *testing.T) {
	script := writeEchoServer(t)
	client := newTestClient(t, []ServerConfig{{
		ID: "echo-1", Name: "echo-server", Enabled: true, Transport: "stdio",
		Command: "node", Args: []string{script}, TimeoutMs: 20000,
	}})

	lookup, ok := client.Lookup("mcp__echo_server__echo")
	if !ok {
		t.Fatalf("未找到 echo 工具定义")
	}
	text, err := client.CallTool(context.Background(), lookup.ServerID, lookup.ToolName, map[string]any{"text": "你好"})
	if err != nil {
		t.Fatalf("工具调用失败: %v", err)
	}
	if text != "echo:你好" {
		t.Fatalf("工具返回不符: %s", text)
	}

	// isError=true 的结果应作为错误返回文本
	if _, err := client.CallTool(context.Background(), lookup.ServerID, "fail", nil); err == nil {
		t.Fatalf("isError 结果应返回错误")
	} else if !strings.Contains(err.Error(), "业务失败") {
		t.Fatalf("错误信息不符: %v", err)
	}

	// JSON-RPC 错误（未知工具）
	if _, err := client.CallTool(context.Background(), lookup.ServerID, "not-exist", nil); err == nil {
		t.Fatalf("未知工具应报错")
	}
}

func TestToolFilterAndDisabledServer(t *testing.T) {
	script := writeEchoServer(t)
	include := ServerConfig{
		ID: "echo-1", Name: "echo", Enabled: true, Transport: "stdio",
		Command: "node", Args: []string{script}, TimeoutMs: 20000,
	}
	include.ToolFilter.Include = []string{"echo"}
	exclude := include
	exclude.ID = "echo-2"
	exclude.Name = "echo2"
	exclude.ToolFilter = struct {
		Include []string `json:"include"`
		Exclude []string `json:"exclude"`
	}{Exclude: []string{"secret"}}

	client := newTestClient(t, []ServerConfig{include, exclude})
	names := map[string]bool{}
	for _, definition := range client.Definitions() {
		names[definition.ServerName+"|"+definition.ToolName] = true
	}
	if !names["echo|echo"] {
		t.Fatalf("include 过滤后应保留 echo: %v", names)
	}
	if names["echo|secret"] {
		t.Fatalf("include 过滤后不应保留 secret: %v", names)
	}
	if !names["echo2|echo"] || names["echo2|secret"] {
		t.Fatalf("exclude 过滤不符: %v", names)
	}
}

func TestHTTPTransportCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		if err := json.NewDecoder(request.Body).Decode(&message); err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		if request.Header.Get("X-API-KEY") != "test-key" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		result := map[string]any{}
		switch message.Method {
		case "initialize":
			result = map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{}}
		case "tools/list":
			result = map[string]any{"tools": []any{map[string]any{"name": "search", "description": "HTTP 搜索", "inputSchema": map[string]any{"type": "object"}}}}
		case "tools/call":
			result = map[string]any{"content": []any{map[string]any{"type": "text", "text": "http:" + stringOf(message.Params.Arguments["q"])}}}
		default:
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.Header().Set("Mcp-Session-Id", "session-1")
		_ = json.NewEncoder(writer).Encode(map[string]any{"jsonrpc": "2.0", "id": message.ID, "result": result})
	}))
	defer server.Close()

	client := newTestClient(t, []ServerConfig{{
		ID: "http-1", Name: "http-server", Enabled: true, Transport: "http",
		URL: server.URL, Headers: map[string]string{"X-API-KEY": "test-key"}, TimeoutMs: 10000,
	}})

	definitions := client.Definitions()
	if len(definitions) != 1 || definitions[0].ToolName != "search" {
		t.Fatalf("HTTP 工具清单不符: %+v", definitions)
	}
	lookup, _ := client.Lookup(definitions[0].Name)
	text, err := client.CallTool(context.Background(), lookup.ServerID, "search", map[string]any{"q": "徐缺"})
	if err != nil {
		t.Fatalf("HTTP 工具调用失败: %v", err)
	}
	if text != "http:徐缺" {
		t.Fatalf("HTTP 工具返回不符: %s", text)
	}
}

func TestSSETransportNotSupportedInGo(t *testing.T) {
	client := newTestClient(t, []ServerConfig{{
		ID: "sse-1", Name: "sse-server", Enabled: true, Transport: "sse", URL: "http://127.0.0.1:1",
	}})
	if definitions := client.Definitions(); len(definitions) != 0 {
		t.Fatalf("sse 传输不应产生工具定义: %+v", definitions)
	}
}

func TestNormalizeServerConfigAndToolName(t *testing.T) {
	config, ok := NormalizeServerConfig(map[string]any{
		"name": "fathom-search", "transport": "stdio", "command": "npx", "args": []any{"-y", "fathom-mcp"},
		"timeoutMs": 123, "toolFilter": map[string]any{"include": []any{"web_search"}},
	})
	if !ok {
		t.Fatalf("归一化失败")
	}
	if config.Transport != "stdio" || len(config.Args) != 2 {
		t.Fatalf("配置归一化不符: %+v", config)
	}
	if config.TimeoutMs != 1000 {
		t.Fatalf("超时下限未生效: %d", config.TimeoutMs)
	}
	if len(config.ToolFilter.Include) != 1 || config.ToolFilter.Include[0] != "web_search" {
		t.Fatalf("工具过滤解析不符: %+v", config.ToolFilter)
	}

	long := strings.Repeat("very-long-tool-name-", 6)
	name := BuildFunctionName("some-server", long)
	if len(name) > 64 {
		t.Fatalf("工具名超长未压缩: %d", len(name))
	}
	if !strings.HasPrefix(name, "mcp__some_server__") && !strings.HasPrefix(name, "mcp__some_serve__") {
		t.Fatalf("工具名前缀不符: %s", name)
	}
}

func TestLoadConfigFromRawMap(t *testing.T) {
	config := LoadConfig(map[string]any{
		"client": map[string]any{
			"enabled":        true,
			"maxResultChars": 100,
			"servers": []any{
				map[string]any{"name": "a", "transport": "stdio", "command": "node"},
				map[string]any{"name": "", "command": "node"},
				map[string]any{"name": "b", "transport": "http", "url": "https://example.com/mcp", "enabled": false},
			},
		},
	})
	if !config.Enabled || config.MaxResultChars != 500 {
		t.Fatalf("客户端配置归一化不符: %+v", config)
	}
	if len(config.Servers) != 2 {
		t.Fatalf("应保留 2 个有效服务器，实际 %d", len(config.Servers))
	}
	if config.Servers[1].Enabled {
		t.Fatalf("enabled=false 未生效: %+v", config.Servers[1])
	}
}

func TestCallToolTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var message struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(request.Body).Decode(&message)
		if message.Method == "tools/call" {
			time.Sleep(400 * time.Millisecond)
		}
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]any{
			"jsonrpc": "2.0", "id": message.ID,
			"result": map[string]any{"tools": []any{map[string]any{"name": "slow"}}},
		})
	}))
	defer server.Close()

	client := New(ClientConfig{Enabled: true, MaxResultChars: 1000, Servers: []ServerConfig{{
		ID: "slow", Name: "slow", Enabled: true, Transport: "http", URL: server.URL, TimeoutMs: 1000,
	}}}, testLogger{t})
	client.ConnectAll(context.Background())
	defer client.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := client.CallTool(ctx, "slow", "slow", nil); err == nil {
		t.Fatalf("超时应返回错误")
	}
}

// 回归：toolFilter 为空数组时不得产生 "[]" 这类伪工具名（曾导致所有 MCP 工具被静默过滤）。
func TestToolFilterEmptyArraysDoNotFilterEverything(t *testing.T) {
	config, ok := NormalizeServerConfig(map[string]any{
		"name": "echo", "transport": "stdio", "command": "node",
		"toolFilter": map[string]any{"include": []any{}, "exclude": []any{}},
	})
	if !ok {
		t.Fatalf("归一化失败")
	}
	if len(config.ToolFilter.Include) != 0 || len(config.ToolFilter.Exclude) != 0 {
		t.Fatalf("空数组应解析为空过滤: include=%v exclude=%v", config.ToolFilter.Include, config.ToolFilter.Exclude)
	}

	script := writeEchoServer(t)
	server := config
	server.ID = "echo-empty-filter"
	server.Command = "node"
	server.Args = []string{script}
	server.TimeoutMs = 20000
	client := newTestClient(t, []ServerConfig{server})
	if definitions := client.Definitions(); len(definitions) != 2 {
		t.Fatalf("空 toolFilter 下应保留全部 2 个工具，实际 %d", len(definitions))
	}
}

// 回归：字符串形式的 include 也要正确切分。
func TestToolFilterStringForm(t *testing.T) {
	config, _ := NormalizeServerConfig(map[string]any{
		"name": "echo", "toolFilter": map[string]any{"include": "echo, add"},
	})
	if len(config.ToolFilter.Include) != 2 || config.ToolFilter.Include[0] != "echo" || config.ToolFilter.Include[1] != "add" {
		t.Fatalf("字符串过滤解析不符: %v", config.ToolFilter.Include)
	}
}
