// Package mcp 实现 MCP（Model Context Protocol）客户端：stdio 与 http 传输、工具清单与调用。
//
// 与 Node 版 src/mcp-client.js 对齐：工具名 mcp__<server>__<tool>、参数 schema 归一化、
// 结果文本化与 maxResultChars 截断、toolFilter include/exclude、超时配置。
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

const protocolVersion = "2024-11-05"

// ServerConfig 是单个 MCP 服务器配置（键名与 Node 一致）。
type ServerConfig struct {
	ID         string            `json:"id"`
	Name       string            `json:"name"`
	Enabled    bool              `json:"enabled"`
	Transport  string            `json:"transport"`
	Command    string            `json:"command"`
	Args       []string          `json:"args"`
	Env        map[string]string `json:"env"`
	Cwd        string            `json:"cwd"`
	URL        string            `json:"url"`
	Headers    map[string]string `json:"headers"`
	TimeoutMs  int               `json:"timeoutMs"`
	ToolFilter struct {
		Include []string `json:"include"`
		Exclude []string `json:"exclude"`
	} `json:"toolFilter"`
}

// ClientConfig 是 mcp.client 配置。
type ClientConfig struct {
	Enabled        bool           `json:"enabled"`
	MaxResultChars int            `json:"maxResultChars"`
	Servers        []ServerConfig `json:"servers"`
}

// Tool 是一个 MCP 工具。
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

// ToolDefinition 是暴露给模型的工具定义（含归属信息）。
type ToolDefinition struct {
	Name       string
	ServerID   string
	ServerName string
	ToolName   string
	Definition map[string]any
}

type transport interface {
	Call(ctx context.Context, method string, params any) (json.RawMessage, error)
	Close() error
}

type serverEntry struct {
	config    ServerConfig
	transport transport
	tools     []Tool
	lastError string
}

// Client 管理多个 MCP 服务器。
type Client struct {
	config  ClientConfig
	logger  Logger
	mu      sync.Mutex
	servers map[string]*serverEntry
}

// Logger 是最小日志接口。
type Logger interface {
	Printf(format string, args ...any)
}

// NormalizeServerConfig 归一化单个服务器配置（对齐 Node normalizeMcpServerConfig）。
func NormalizeServerConfig(raw map[string]any) (ServerConfig, bool) {
	name := strings.TrimSpace(stringOf(raw["name"]))
	if name == "" {
		return ServerConfig{}, false
	}
	id := strings.TrimSpace(stringOf(raw["id"]))
	if id == "" {
		id = sanitizeIdentifier(name) + "-" + shortHash(name+time.Now().Format("150405.000000000"))
	}
	config := ServerConfig{
		ID:        id,
		Name:      name,
		Enabled:   raw["enabled"] != false,
		Transport: "stdio",
		TimeoutMs: clampInt(intOf(raw["timeoutMs"]), 1000, 600000, 60000),
	}
	switch strings.ToLower(strings.TrimSpace(stringOf(raw["transport"]))) {
	case "http":
		config.Transport = "http"
	case "sse":
		config.Transport = "sse"
	case "stdio", "":
		config.Transport = "stdio"
	}
	config.Command = strings.TrimSpace(stringOf(raw["command"]))
	config.Cwd = strings.TrimSpace(stringOf(raw["cwd"]))
	config.URL = strings.TrimSpace(stringOf(raw["url"]))
	config.Env = stringMapOf(raw["env"])
	config.Headers = stringMapOf(raw["headers"])
	if items, ok := raw["args"].([]any); ok {
		for _, item := range items {
			config.Args = append(config.Args, stringOf(item))
		}
	}
	if filter, ok := raw["toolFilter"].(map[string]any); ok {
		config.ToolFilter.Include = stringListOf(filter["include"])
		config.ToolFilter.Exclude = stringListOf(filter["exclude"])
	}
	return config, true
}

// LoadConfig 读取 mcp.client 段。
func LoadConfig(raw map[string]any) ClientConfig {
	config := ClientConfig{MaxResultChars: 4000}
	source, _ := raw["client"].(map[string]any)
	if source == nil {
		return config
	}
	config.Enabled = source["enabled"] == true
	config.MaxResultChars = clampInt(intOf(source["maxResultChars"]), 500, 50000, 4000)
	if servers, ok := source["servers"].([]any); ok {
		for _, item := range servers {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			server, ok := NormalizeServerConfig(entry)
			if !ok {
				continue
			}
			config.Servers = append(config.Servers, server)
		}
	}
	return config
}

// New 创建客户端。
func New(config ClientConfig, logger Logger) *Client {
	if logger == nil {
		logger = log.Default()
	}
	return &Client{config: config, logger: logger, servers: map[string]*serverEntry{}}
}

// Enabled 返回是否启用。
func (c *Client) Enabled() bool { return c.config.Enabled }

// ConnectAll 连接所有启用的服务器（单个失败不影响其它）。
func (c *Client) ConnectAll(ctx context.Context) {
	if !c.config.Enabled {
		return
	}
	for _, server := range c.config.Servers {
		if !server.Enabled {
			continue
		}
		entry, err := c.connect(ctx, server)
		c.mu.Lock()
		if err != nil {
			c.servers[server.ID] = &serverEntry{config: server, lastError: err.Error()}
			c.logger.Printf("[MCP] %s 连接失败: %v", server.Name, err)
		} else {
			c.servers[server.ID] = entry
			c.logger.Printf("[MCP] %s 已连接（%s，%d 个工具）", server.Name, server.Transport, len(entry.tools))
		}
		c.mu.Unlock()
	}
}

func (c *Client) connect(ctx context.Context, server ServerConfig) (*serverEntry, error) {
	var active transport
	var err error
	switch server.Transport {
	case "stdio":
		active, err = newStdioTransport(server)
	case "http":
		active, err = newHTTPTransport(server)
	case "sse":
		return nil, fmt.Errorf("Go 版暂不支持 sse 传输（请改用 stdio 或 http）")
	default:
		return nil, fmt.Errorf("未知传输类型: %s", server.Transport)
	}
	if err != nil {
		return nil, err
	}

	timeout := time.Duration(server.TimeoutMs) * time.Millisecond
	initCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	_, err = active.Call(initCtx, "initialize", map[string]any{
		"protocolVersion": protocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "mimir-go", "version": "0.1.0"},
	})
	if err != nil {
		_ = active.Close()
		return nil, fmt.Errorf("initialize 失败: %w", err)
	}
	// notifications/initialized 是通知（无 id），失败可忽略
	_ = notify(active, "notifications/initialized", map[string]any{})

	listCtx, listCancel := context.WithTimeout(ctx, timeout)
	defer listCancel()
	raw, err := active.Call(listCtx, "tools/list", map[string]any{})
	if err != nil {
		_ = active.Close()
		return nil, fmt.Errorf("tools/list 失败: %w", err)
	}
	var payload struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		_ = active.Close()
		return nil, fmt.Errorf("工具清单解析失败: %w", err)
	}
	return &serverEntry{config: server, transport: active, tools: payload.Tools}, nil
}

// notify 发送 JSON-RPC 通知（无响应）。
func notify(active transport, method string, params any) error {
	type notifier interface {
		Notify(method string, params any) error
	}
	if implementation, ok := active.(notifier); ok {
		return implementation.Notify(method, params)
	}
	return nil
}

// Definitions 返回全部可用工具定义（含 include/exclude 过滤与重名处理）。
func (c *Client) Definitions() []ToolDefinition {
	c.mu.Lock()
	defer c.mu.Unlock()
	definitions := []ToolDefinition{}
	used := map[string]bool{}
	for _, entry := range c.servers {
		if entry.transport == nil || !entry.config.Enabled {
			continue
		}
		include := entry.config.ToolFilter.Include
		exclude := entry.config.ToolFilter.Exclude
		for _, tool := range entry.tools {
			if len(include) > 0 && !containsString(include, tool.Name) {
				continue
			}
			if containsString(exclude, tool.Name) {
				continue
			}
			name := BuildFunctionName(entry.config.Name, tool.Name)
			if used[name] {
				name = fmt.Sprintf("%s_%s", truncate(name, 50), shortHash(fmt.Sprintf("%s:%s", entry.config.ID, tool.Name)))
			}
			used[name] = true
			description := strings.TrimSpace(tool.Description)
			if description == "" {
				description = tool.Name
			}
			description = "[MCP:" + entry.config.Name + "] " + description
			if len([]rune(description)) > 1024 {
				description = string([]rune(description)[:1024])
			}
			definitions = append(definitions, ToolDefinition{
				Name:       name,
				ServerID:   entry.config.ID,
				ServerName: entry.config.Name,
				ToolName:   tool.Name,
				Definition: map[string]any{
					"type": "function",
					"function": map[string]any{
						"name":        name,
						"description": description,
						"parameters":  normalizeInputSchema(tool.InputSchema),
					},
				},
			})
		}
	}
	return definitions
}

// Lookup 按暴露给模型的函数名查找工具归属。
func (c *Client) Lookup(functionName string) (ToolDefinition, bool) {
	for _, definition := range c.Definitions() {
		if definition.Name == functionName {
			return definition, true
		}
	}
	return ToolDefinition{}, false
}

// CallTool 调用指定工具，返回文本结果（失败返回 ok=false 与错误说明）。
func (c *Client) CallTool(ctx context.Context, serverID string, toolName string, arguments map[string]any) (string, error) {
	c.mu.Lock()
	entry, exists := c.servers[serverID]
	c.mu.Unlock()
	if !exists || entry.transport == nil {
		return "", fmt.Errorf("MCP 服务器不可用")
	}
	timeout := time.Duration(entry.config.TimeoutMs) * time.Millisecond
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	raw, err := entry.transport.Call(callCtx, "tools/call", map[string]any{
		"name":      toolName,
		"arguments": arguments,
	})
	if err != nil {
		return "", fmt.Errorf("MCP 工具调用失败: %w", err)
	}
	text, isError, err := normalizeCallResult(raw, c.config.MaxResultChars)
	if err != nil {
		return "", err
	}
	if isError {
		return "", fmt.Errorf("%s", text)
	}
	return text, nil
}

// Close 关闭全部连接。
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, entry := range c.servers {
		if entry.transport != nil {
			_ = entry.transport.Close()
		}
	}
}

// normalizeCallResult 把 MCP 结果转成文本（对齐 Node normalizeCallResult）。
func normalizeCallResult(raw json.RawMessage, maxChars int) (string, bool, error) {
	var payload struct {
		Content []map[string]any `json:"content"`
		IsError bool             `json:"isError"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		// 不是标准结构时直接返回原文
		return truncateText(string(raw), maxChars), false, nil
	}
	parts := []string{}
	for _, item := range payload.Content {
		switch strings.TrimSpace(stringOf(item["type"])) {
		case "text":
			parts = append(parts, stringOf(item["text"]))
		case "resource":
			if resource, ok := item["resource"].(map[string]any); ok {
				if text := stringOf(resource["text"]); text != "" {
					parts = append(parts, text)
					continue
				}
			}
			encoded, _ := json.Marshal(item)
			parts = append(parts, string(encoded))
		default:
			encoded, _ := json.Marshal(item)
			parts = append(parts, string(encoded))
		}
	}
	text := strings.TrimSpace(strings.Join(parts, "\n"))
	return truncateText(text, maxChars), payload.IsError, nil
}

func truncateText(text string, maxChars int) string {
	if maxChars <= 0 {
		return text
	}
	runes := []rune(text)
	if len(runes) <= maxChars {
		return text
	}
	return string(runes[:maxChars]) + "…（已截断）"
}

// normalizeInputSchema 保证是合法 JSON Schema 对象。
func normalizeInputSchema(schema map[string]any) map[string]any {
	if schema == nil || len(schema) == 0 {
		return map[string]any{"type": "object", "properties": map[string]any{}}
	}
	if _, ok := schema["type"]; !ok {
		schema["type"] = "object"
	}
	if _, ok := schema["properties"]; !ok {
		schema["properties"] = map[string]any{}
	}
	return schema
}

var (
	identifierRegex = regexp.MustCompile(`[^a-zA-Z0-9_]+`)
	maxNameLength   = 64
)

// BuildFunctionName 复刻 Node buildFunctionName：mcp__<server>__<tool>，超长时用哈希压缩。
func BuildFunctionName(serverName string, toolName string) string {
	serverSlug := sanitizeIdentifier(serverName)
	toolSlug := sanitizeIdentifier(toolName)
	prefix := "mcp__" + serverSlug + "__"
	available := maxNameLength - len(prefix)
	if len(toolSlug) <= available {
		return prefix + toolSlug
	}
	hash := shortHash(serverName + ":" + toolName)
	compactPrefix := "mcp__" + truncate(serverSlug, 10) + "__"
	if len(compactPrefix)+len(hash)+1 <= maxNameLength {
		return compactPrefix + hash
	}
	return truncate(prefix, maxNameLength-len(hash)-1) + "_" + hash
}

func sanitizeIdentifier(value string) string {
	cleaned := identifierRegex.ReplaceAllString(strings.TrimSpace(value), "_")
	cleaned = strings.Trim(cleaned, "_")
	if cleaned == "" {
		cleaned = "server"
	}
	return cleaned
}

func shortHash(value string) string {
	var hash uint32 = 2166136261
	for index := 0; index < len(value); index += 1 {
		hash ^= uint32(value[index])
		hash *= 16777619
	}
	return fmt.Sprintf("%06x", hash&0xffffff)
}

func truncate(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

// ---------------- stdio 传输 ----------------

type stdioTransport struct {
	server  ServerConfig
	command *exec.Cmd
	stdin   io.WriteCloser
	writer  *bufio.Writer
	pending map[int64]chan json.RawMessage
	nextID  int64
	mu      sync.Mutex
	closed  bool
}

func newStdioTransport(server ServerConfig) (transport, error) {
	if strings.TrimSpace(server.Command) == "" {
		return nil, fmt.Errorf("stdio 传输缺少 command")
	}
	command := exec.Command(server.Command, server.Args...)
	if server.Cwd != "" {
		command.Dir = server.Cwd
	}
	command.Env = os.Environ()
	for key, value := range server.Env {
		command.Env = append(command.Env, key+"="+value)
	}
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, err
	}
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("启动 MCP 进程失败: %w", err)
	}
	active := &stdioTransport{
		server:  server,
		command: command,
		stdin:   stdin,
		writer:  bufio.NewWriter(stdin),
		pending: map[int64]chan json.RawMessage{},
	}
	go active.readLoop(stdout)
	return active, nil
}

func (t *stdioTransport) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var envelope struct {
			ID     json.Number     `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(line, &envelope); err != nil {
			continue
		}
		if envelope.ID == "" {
			continue // 通知类消息
		}
		id, err := envelope.ID.Int64()
		if err != nil {
			continue
		}
		t.mu.Lock()
		channel, ok := t.pending[id]
		delete(t.pending, id)
		t.mu.Unlock()
		if !ok {
			continue
		}
		if envelope.Error != nil {
			channel <- json.RawMessage(fmt.Sprintf(`{"__error":%q}`, envelope.Error.Message))
			continue
		}
		channel <- envelope.Result
	}
	// 进程退出：结束所有等待
	t.mu.Lock()
	for id, channel := range t.pending {
		channel <- json.RawMessage(`{"__error":"MCP 进程已退出"}`)
		delete(t.pending, id)
	}
	t.closed = true
	t.mu.Unlock()
}

func (t *stdioTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	if t.closed {
		t.mu.Unlock()
		return nil, fmt.Errorf("MCP 进程已退出")
	}
	t.nextID += 1
	id := t.nextID
	channel := make(chan json.RawMessage, 1)
	t.pending[id] = channel
	t.mu.Unlock()

	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, err
	}
	t.mu.Lock()
	if t.closed {
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, fmt.Errorf("MCP 进程已退出")
	}
	if _, err := t.writer.Write(append(payload, '\n')); err != nil {
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, fmt.Errorf("写入 MCP 请求失败: %w", err)
	}
	if err := t.writer.Flush(); err != nil {
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, fmt.Errorf("发送 MCP 请求失败: %w", err)
	}
	t.mu.Unlock()

	select {
	case <-ctx.Done():
		t.mu.Lock()
		delete(t.pending, id)
		t.mu.Unlock()
		return nil, fmt.Errorf("MCP 调用超时")
	case raw := <-channel:
		if bytes.HasPrefix(bytes.TrimSpace(raw), []byte(`{"__error"`)) {
			var failure struct {
				Error string `json:"__error"`
			}
			_ = json.Unmarshal(raw, &failure)
			return nil, fmt.Errorf("%s", failure.Error)
		}
		return raw, nil
	}
}

func (t *stdioTransport) Notify(method string, params any) error {
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
	if err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return fmt.Errorf("MCP 进程已退出")
	}
	if _, err := t.writer.Write(append(payload, '\n')); err != nil {
		return err
	}
	return t.writer.Flush()
}

func (t *stdioTransport) Close() error {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	_ = t.stdin.Close()
	if t.command != nil && t.command.Process != nil {
		_ = t.command.Process.Kill()
		_, _ = t.command.Process.Wait()
	}
	return nil
}

// ---------------- http 传输（Streamable HTTP） ----------------

type httpTransport struct {
	server  ServerConfig
	client  *http.Client
	session string
	nextID  int64
	mu      sync.Mutex
}

func newHTTPTransport(server ServerConfig) (transport, error) {
	if strings.TrimSpace(server.URL) == "" {
		return nil, fmt.Errorf("http 传输缺少 url")
	}
	timeout := server.TimeoutMs
	if timeout <= 0 {
		timeout = 60000
	}
	return &httpTransport{
		server: server,
		client: &http.Client{Timeout: time.Duration(timeout) * time.Millisecond},
	}, nil
}
func (t *httpTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	t.mu.Lock()
	t.nextID += 1
	id := t.nextID
	t.mu.Unlock()

	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, t.server.URL, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json, text/event-stream")
	for key, value := range t.server.Headers {
		request.Header.Set(key, value)
	}
	t.mu.Lock()
	if t.session != "" {
		request.Header.Set("Mcp-Session-Id", t.session)
	}
	t.mu.Unlock()

	response, err := t.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("MCP HTTP 请求失败: %w", err)
	}
	defer response.Body.Close()
	if session := response.Header.Get("Mcp-Session-Id"); session != "" {
		t.mu.Lock()
		t.session = session
		t.mu.Unlock()
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("读取 MCP 响应失败: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("MCP HTTP %d: %s", response.StatusCode, truncateText(string(body), 200))
	}
	contentType := response.Header.Get("Content-Type")
	if strings.Contains(contentType, "text/event-stream") {
		return parseSSEForID(string(body), id)
	}
	var envelope struct {
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, fmt.Errorf("MCP 响应解析失败: %w", err)
	}
	if envelope.Error != nil {
		return nil, fmt.Errorf("%s", envelope.Error.Message)
	}
	return envelope.Result, nil
}

// parseSSEForID 从 SSE 响应中取出指定 id 的 result。
func parseSSEForID(body string, id int64) (json.RawMessage, error) {
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
		if payload == "" {
			continue
		}
		var envelope struct {
			ID     json.Number     `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal([]byte(payload), &envelope); err != nil {
			continue
		}
		if envelope.ID != "" {
			if parsed, err := envelope.ID.Int64(); err == nil && parsed != id {
				continue
			}
		}
		if envelope.Error != nil {
			return nil, fmt.Errorf("%s", envelope.Error.Message)
		}
		return envelope.Result, nil
	}
	return nil, fmt.Errorf("SSE 响应中未找到结果")
}

func (t *httpTransport) Close() error { return nil }

// ---------------- 字段工具 ----------------

func stringOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func intOf(value any) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := typed.Int64()
		return int(parsed)
	case string:
		var parsed int
		if _, err := fmt.Sscanf(strings.TrimSpace(typed), "%d", &parsed); err == nil {
			return parsed
		}
	}
	return 0
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

func stringMapOf(value any) map[string]string {
	result := map[string]string{}
	source, _ := value.(map[string]any)
	for key, item := range source {
		text := stringOf(item)
		if strings.TrimSpace(text) == "" {
			continue
		}
		result[key] = text
	}
	return result
}

func stringListOf(value any) []string {
	result := []string{}
	seen := map[string]bool{}
	appendItem := func(text string) {
		trimmed := strings.TrimSpace(text)
		if trimmed == "" || seen[trimmed] {
			return
		}
		seen[trimmed] = true
		result = append(result, trimmed)
	}
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			appendItem(stringOf(item))
		}
	case []string:
		for _, item := range typed {
			appendItem(item)
		}
	case string:
		// 兼容逗号/空白分隔的字符串写法
		for _, item := range strings.FieldsFunc(typed, func(r rune) bool { return r == ',' || r == '，' || r == ' ' || r == '\n' || r == '\t' }) {
			appendItem(item)
		}
	}
	return result
}

func containsString(items []string, target string) bool {
	for _, item := range items {
		if item == target {
			return true
		}
	}
	return false
}

// ServerStatus 是单个服务器的运行状态（面板展示用）。
type ServerStatus struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// State 对齐 Node：connected / connecting / error / disabled
	State      string         `json:"state"`
	Transport  string         `json:"transport"`
	Command    string         `json:"command,omitempty"`
	URL        string         `json:"url,omitempty"`
	Connected  bool           `json:"connected"`
	RetryCount int            `json:"retryCount"`
	ToolCount  int            `json:"toolCount"`
	LastError  string         `json:"lastError,omitempty"`
	Tools      []ToolSummary  `json:"tools"`
	Config     map[string]any `json:"config,omitempty"`
}

// ToolSummary 是面板展示的工具摘要（对齐 Node getStatus 的 tools 形状）。
type ToolSummary struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Required    []string `json:"required"`
}

// MaskedServerConfig 是掩码后的服务器配置（密钥字段替换为 '******'）。
func MaskedServerConfig(server ServerConfig) map[string]any {
	encoded, _ := json.Marshal(server)
	var payload map[string]any
	_ = json.Unmarshal(encoded, &payload)
	payload["env"] = maskedSecretMap(server.Env)
	payload["headers"] = maskedSecretMap(server.Headers)
	payload["hasEnv"] = hasNonEmptySecret(server.Env)
	payload["hasHeaders"] = hasNonEmptySecret(server.Headers)
	return payload
}

func maskedSecretMap(values map[string]string) map[string]string {
	masked := map[string]string{}
	for key, value := range values {
		if strings.TrimSpace(value) != "" {
			masked[key] = "******"
		} else {
			masked[key] = ""
		}
	}
	return masked
}

func hasNonEmptySecret(values map[string]string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return true
		}
	}
	return false
}

// Status 返回全部服务器的运行状态（含已配置但未连接的）。
func (c *Client) Status() []ServerStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	statuses := make([]ServerStatus, 0, len(c.config.Servers))
	for _, server := range c.config.Servers {
		status := ServerStatus{
			ID:        server.ID,
			Name:      server.Name,
			Enabled:   server.Enabled,
			Transport: server.Transport,
			Command:   server.Command,
			URL:       server.URL,
			Tools:     []ToolSummary{},
			Config:    MaskedServerConfig(server),
		}
		// 状态映射对齐 Node getStatus：客户端/服务器停用 → disabled；已连接 → connected；有错误 → error；其余 → connecting
		state := "disabled"
		if c.config.Enabled && server.Enabled {
			state = "connecting"
		}
		if entry, ok := c.servers[server.ID]; ok {
			status.LastError = entry.lastError
			if entry.transport != nil {
				status.Connected = true
				state = "connected"
				status.ToolCount = len(entry.tools)
				for _, tool := range entry.tools {
					summary := ToolSummary{Name: tool.Name, Description: tool.Description, Required: []string{}}
					if required, ok := tool.InputSchema["required"].([]any); ok {
						for _, item := range required {
							if text, ok := item.(string); ok {
								summary.Required = append(summary.Required, text)
							}
						}
					}
					status.Tools = append(status.Tools, summary)
				}
			} else if entry.lastError != "" && c.config.Enabled && server.Enabled {
				state = "error"
			}
		}
		status.State = state
		statuses = append(statuses, status)
	}
	return statuses
}

// StatusPayload 返回与 Node getMcpClientStatus 对齐的客户端状态对象。
// 面板前端依赖 { enabled, maxResultChars, servers } 结构（旧版直接返回服务器数组，导致导入后列表不渲染）。
func (c *Client) StatusPayload() map[string]any {
	return map[string]any{
		"enabled":        c.config.Enabled,
		"maxResultChars": c.config.MaxResultChars,
		"servers":        c.Status(),
	}
}

// Reconnect 重连单个服务器（断开旧连接后按当前配置重新握手）。
func (c *Client) Reconnect(serverID string) error {
	c.mu.Lock()
	var serverConfig ServerConfig
	entry, exists := c.servers[serverID]
	if exists {
		serverConfig = entry.config
		if entry.transport != nil {
			_ = entry.transport.Close()
			entry.transport = nil
		}
		delete(c.servers, serverID)
	}
	c.mu.Unlock()
	if !exists {
		return fmt.Errorf("服务器不存在: %s", serverID)
	}
	newEntry, err := c.connect(context.Background(), serverConfig)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err != nil {
		c.servers[serverID] = &serverEntry{config: serverConfig, lastError: err.Error()}
		return err
	}
	c.servers[serverID] = newEntry
	return nil
}

// Reload 用新配置热重载：关闭全部连接、替换配置并重连启用的服务器。
func (c *Client) Reload(config ClientConfig) []ServerStatus {
	c.Close()
	c.mu.Lock()
	c.config = config
	c.mu.Unlock()
	c.ConnectAll(context.Background())
	return c.Status()
}

// ReloadPayload 按新配置重载客户端并返回面板状态对象（结构对齐 Node）。
func (c *Client) ReloadPayload(config ClientConfig) map[string]any {
	servers := c.Reload(config)
	return map[string]any{
		"enabled":        config.Enabled,
		"maxResultChars": config.MaxResultChars,
		"servers":        servers,
	}
}

// ConfigSnapshot 返回当前客户端配置（深拷贝 servers 切片）。
func (c *Client) ConfigSnapshot() ClientConfig {
	c.mu.Lock()
	defer c.mu.Unlock()
	servers := make([]ServerConfig, len(c.config.Servers))
	copy(servers, c.config.Servers)
	return ClientConfig{Enabled: c.config.Enabled, MaxResultChars: c.config.MaxResultChars, Servers: servers}
}
