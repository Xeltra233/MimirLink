package mcp

import (
	"context"
	"encoding/json"
)

// NewForTest 创建带本地工具回调的客户端（仅供测试注入 mock 传输层）。
func NewForTest(handlers map[string]func(args map[string]any) (string, error)) *Client {
	client := New(ClientConfig{Enabled: true, MaxResultChars: 4000}, nil)
	tools := []Tool{}
	for name := range handlers {
		tools = append(tools, Tool{Name: name, Description: name})
	}
	client.servers["test"] = &serverEntry{
		config:    ServerConfig{ID: "test", Name: "test", Enabled: true, Transport: "stdio", TimeoutMs: 5000},
		transport: &mockTransport{handlers: handlers},
		tools:     tools,
	}
	return client
}

// mockTransport 实现 transport 接口，把 tools/call 路由到本地回调。
type mockTransport struct {
	handlers map[string]func(args map[string]any) (string, error)
}

func (t *mockTransport) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if method != "tools/call" {
		return nil, context.Canceled
	}
	payload, _ := params.(map[string]any)
	name, _ := payload["name"].(string)
	arguments, _ := payload["arguments"].(map[string]any)
	handler, ok := t.handlers[name]
	if !ok {
		return nil, context.Canceled
	}
	text, err := handler(arguments)
	if err != nil {
		return nil, err
	}
	return json.RawMessage(`{"content":[{"type":"text","text":` + jsonString(text) + `}],"isError":false}`), nil
}

func (t *mockTransport) Close() error { return nil }

// jsonString 转义为 JSON 字符串字面量。
func jsonString(text string) string {
	encoded, err := json.Marshal(text)
	if err != nil {
		return `""`
	}
	return string(encoded)
}
