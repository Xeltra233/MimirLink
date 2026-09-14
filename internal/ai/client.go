// Package ai 实现 OpenAI 兼容的对话补全客户端（与 Node 版 src/ai.js 的请求形状一致）。
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"mimirlink/internal/config"
)

// Message 是一条对话消息（tool_calls / tool_call_id 用于工具调用循环）。
type Message struct {
	Role       string     `json:"role"`
	Content    any        `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	Name       string     `json:"name,omitempty"`
}

// ToolCall 是模型请求的工具调用。
type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Index    int    `json:"index,omitempty"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

// ToolDefinition 是暴露给模型的工具定义。
type ToolDefinition struct {
	Type     string `json:"type"`
	Function struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		Parameters  map[string]any `json:"parameters"`
	} `json:"function"`
}

// Provider 是解析后的供应商配置。
type Provider struct {
	ID      string
	BaseURL string
	APIKey  string
	Model   string
	Timeout time.Duration
}

// Client 是对话客户端。
type Client struct {
	provider Provider
	client   *http.Client
}

// ChatResult 是一次补全结果。
type ChatResult struct {
	Content          string
	ReasoningContent string
	FinishReason     string
	ToolCalls        []ToolCall
	Raw              map[string]any
}

// ResolveProvider 从配置解析聊天供应商（chat.modelProviderId → ai.providers[]，回退顶层 ai.*）。
func ResolveProvider(document *config.Document) (Provider, error) {
	providerID := strings.TrimSpace(document.String("chat.modelProviderId"))
	if providerID == "" {
		providerID = strings.TrimSpace(document.String("ai.activeProviderId"))
	}
	model := strings.TrimSpace(document.String("chat.model"))

	var raw map[string]any
	if err := json.Unmarshal(document.Raw(), &raw); err != nil {
		return Provider{}, fmt.Errorf("解析配置失败: %w", err)
	}
	aiSection, _ := raw["ai"].(map[string]any)
	if aiSection == nil {
		return Provider{}, fmt.Errorf("配置缺少 ai 段")
	}
	providers, _ := aiSection["providers"].([]any)
	var matched map[string]any
	for _, item := range providers {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		id := strings.TrimSpace(stringValue(entry["id"]))
		if providerID != "" && id == providerID {
			matched = entry
			break
		}
		if providerID == "" && matched == nil {
			matched = entry
		}
	}

	resolved := Provider{ID: providerID}
	if matched != nil {
		resolved.BaseURL = strings.TrimSpace(stringValue(matched["baseUrl"]))
		resolved.APIKey = strings.TrimSpace(stringValue(matched["apiKey"]))
		if resolved.Model = strings.TrimSpace(stringValue(matched["model"])); resolved.Model == "" {
			resolved.Model = strings.TrimSpace(stringValue(matched["defaultModel"]))
		}
	}
	if resolved.BaseURL == "" {
		resolved.BaseURL = strings.TrimSpace(stringValue(aiSection["baseUrl"]))
	}
	if resolved.APIKey == "" {
		resolved.APIKey = strings.TrimSpace(stringValue(aiSection["apiKey"]))
	}
	if resolved.BaseURL == "" {
		return Provider{}, fmt.Errorf("未找到可用的模型服务地址（请检查 chat.modelProviderId 与 ai.providers）")
	}
	if resolved.Model == "" {
		resolved.Model = strings.TrimSpace(stringValue(aiSection["model"]))
	}
	// chat.model 可能带渠道前缀，供应商模型为空时使用配置里的整体模型名
	if model != "" {
		resolved.Model = model
	}
	timeoutMs := document.Int("ai.timeout", 60000)
	if timeoutMs < 1000 {
		timeoutMs = 60000
	}
	resolved.Timeout = time.Duration(timeoutMs) * time.Millisecond
	return resolved, nil
}

// New 创建客户端。
func New(provider Provider) *Client {
	return &Client{provider: provider, client: &http.Client{}}
}

// Provider 返回当前供应商信息。
func (c *Client) Provider() Provider { return c.provider }

// Chat 执行一次对话补全（非流式）。
func (c *Client) Chat(ctx context.Context, messages []Message, overrides map[string]any) (*ChatResult, error) {
	endpoint := buildChatEndpoint(c.provider.BaseURL)
	payload := map[string]any{
		"model":       c.provider.Model,
		"messages":    messages,
		"stream":      false,
		"temperature": 0.7,
	}
	if tools, ok := overrides["tools"]; ok {
		payload["tools"] = tools
		if _, hasChoice := overrides["tool_choice"]; !hasChoice {
			payload["tool_choice"] = "auto"
		}
	}
	for key, value := range overrides {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}
	requestContext, cancel := context.WithTimeout(ctx, c.provider.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("构建请求失败: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if c.provider.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.provider.APIKey)
	}

	response, err := c.client.Do(request)
	if err != nil {
		if requestContext.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("AI 请求超时（%s）", c.provider.Timeout)
		}
		return nil, fmt.Errorf("AI 请求失败: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("AI API 错误: %d - %s", response.StatusCode, truncate(string(raw), 400))
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}
	choices, _ := decoded["choices"].([]any)
	if len(choices) == 0 {
		return nil, fmt.Errorf("AI 响应没有 choices")
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	result := &ChatResult{
		Raw:              decoded,
		FinishReason:     stringValue(choice["finish_reason"]),
		Content:          extractContent(message["content"]),
		ReasoningContent: stringValue(message["reasoning_content"]),
		ToolCalls:        extractToolCalls(message["tool_calls"]),
	}
	if result.Content == "" && result.ReasoningContent == "" && len(result.ToolCalls) == 0 {
		// 对齐 Node extractChatContentWithPrefillFallback：
		// 空回复且尾部是 assistant prefill → 去掉后重试；仍空 → 流式兜底
		if hasTrailingAssistantPrefill(messages) {
			fallbackMessages := messages[:len(messages)-1]
			result, retryErr := c.doChatRequest(ctx, fallbackMessages, overrides)
			if retryErr == nil && (result.Content != "" || result.ReasoningContent != "" || len(result.ToolCalls) > 0) {
				return result, nil
			}
		}
		streamResult, streamErr := c.chatStreaming(ctx, messages, overrides)
		if streamErr != nil {
			return nil, fmt.Errorf("AI 返回了空回复（非流式与流式兜底均失败: %v）", streamErr)
		}
		return streamResult, nil
	}
	return result, nil

}

// hasTrailingAssistantPrefill 判断末条是否为 assistant 预填（对齐 Node hasTrailingAssistantPrefill，
// Go 侧用 ToolCallID 之外的字段缺失，改为按 Role+空 Name 且为最后一条判定）。
func hasTrailingAssistantPrefill(messages []Message) bool {
	if len(messages) == 0 {
		return false
	}
	last := messages[len(messages)-1]
	return last.Role == "assistant"
}

// doChatRequest 是原非流式请求体（Chat 拆出以便回退链复用）。
func (c *Client) doChatRequest(ctx context.Context, messages []Message, overrides map[string]any) (*ChatResult, error) {
	endpoint := buildChatEndpoint(c.provider.BaseURL)
	payload := map[string]any{
		"model":       c.provider.Model,
		"messages":    messages,
		"stream":      false,
		"temperature": 0.7,
	}
	for key, value := range overrides {
		if key == "tools" {
			continue
		}
		payload[key] = value
	}
	if tools, ok := overrides["tools"]; ok {
		payload["tools"] = tools
		if _, hasChoice := overrides["tool_choice"]; !hasChoice {
			payload["tool_choice"] = "auto"
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}
	decoded, err := c.postJSON(ctx, endpoint, body)
	if err != nil {
		return nil, err
	}
	choices, _ := decoded["choices"].([]any)
	if len(choices) == 0 {
		return nil, fmt.Errorf("AI 响应没有 choices")
	}
	choice, _ := choices[0].(map[string]any)
	message, _ := choice["message"].(map[string]any)
	result := &ChatResult{
		Raw:              decoded,
		FinishReason:     stringValue(choice["finish_reason"]),
		Content:          extractContent(message["content"]),
		ReasoningContent: stringValue(message["reasoning_content"]),
		ToolCalls:        extractToolCalls(message["tool_calls"]),
	}
	return result, nil
}

// postJSON 发送 POST 并解析 JSON 响应（带超时与错误透传）。
func (c *Client) postJSON(ctx context.Context, endpoint string, body []byte) (map[string]any, error) {
	requestContext, cancel := context.WithTimeout(ctx, c.provider.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("构建请求失败: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if c.provider.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.provider.APIKey)
	}
	response, err := c.client.Do(request)
	if err != nil {
		if requestContext.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("AI 请求超时（%s）", c.provider.Timeout)
		}
		return nil, fmt.Errorf("AI 请求失败: %w", err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024))
	if err != nil {
		return nil, fmt.Errorf("读取响应失败: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("AI API 错误: %d - %s", response.StatusCode, truncate(string(raw), 400))
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}
	return decoded, nil
}

// chatStreaming 对齐 Node sendStreamingChatRequest：SSE 解析 delta.content / reasoning。
func (c *Client) chatStreaming(ctx context.Context, messages []Message, overrides map[string]any) (*ChatResult, error) {
	endpoint := buildChatEndpoint(c.provider.BaseURL)
	payload := map[string]any{
		"model":       c.provider.Model,
		"messages":    messages,
		"stream":      true,
		"temperature": 0.7,
	}
	for key, value := range overrides {
		payload[key] = value
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化请求失败: %w", err)
	}
	requestContext, cancel := context.WithTimeout(ctx, c.provider.Timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("构建请求失败: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if c.provider.APIKey != "" {
		request.Header.Set("Authorization", "Bearer "+c.provider.APIKey)
	}
	response, err := c.client.Do(request)
	if err != nil {
		if requestContext.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("AI 流式请求超时（%s）", c.provider.Timeout)
		}
		return nil, fmt.Errorf("AI 流式请求失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		raw, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, fmt.Errorf("AI API 错误: %d - %s", response.StatusCode, truncate(string(raw), 400))
	}

	content := strings.Builder{}
	reasoning := strings.Builder{}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "" || data == "[DONE]" {
			continue
		}
		var chunk map[string]any
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		choices, _ := chunk["choices"].([]any)
		if len(choices) == 0 {
			continue
		}
		choice, _ := choices[0].(map[string]any)
		delta, _ := choice["delta"].(map[string]any)
		if delta == nil {
			continue
		}
		if value, ok := delta["reasoning_content"].(string); ok {
			reasoning.WriteString(value)
		}
		if value, ok := delta["reasoning"].(string); ok {
			reasoning.WriteString(value)
		}
		if value, ok := delta["content"].(string); ok {
			content.WriteString(value)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("流式读取失败: %w", err)
	}
	if content.Len() == 0 && reasoning.Len() == 0 {
		return nil, fmt.Errorf("流式响应无内容")
	}
	return &ChatResult{
		Content:          content.String(),
		ReasoningContent: reasoning.String(),
	}, nil
}

// extractToolCalls 解析响应里的工具调用。
func extractToolCalls(value any) []ToolCall {
	items, _ := value.([]any)
	calls := make([]ToolCall, 0, len(items))
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		call := ToolCall{
			ID:   stringValue(entry["id"]),
			Type: stringValue(entry["type"]),
		}
		if call.Type == "" {
			call.Type = "function"
		}
		if function, ok := entry["function"].(map[string]any); ok {
			call.Function.Name = stringValue(function["name"])
			call.Function.Arguments = stringValue(function["arguments"])
		}
		if call.Function.Name == "" {
			continue
		}
		calls = append(calls, call)
	}
	return calls
}

// BuildChatEndpoint 对齐 Node resolveApiUrl：baseUrl 已含 /v1 时直接拼接，否则补 /v1。
func buildChatEndpoint(baseURL string) string {
	normalized := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if normalized == "" {
		return "/v1/chat/completions"
	}
	if strings.HasSuffix(normalized, "/v1") {
		return normalized + "/chat/completions"
	}
	return normalized + "/v1/chat/completions"
}

// extractContent 兼容字符串与分段数组两种 content 形态。
func extractContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var builder strings.Builder
		for _, item := range typed {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			if text := stringValue(entry["text"]); text != "" {
				builder.WriteString(text)
			}
		}
		return builder.String()
	default:
		return ""
	}
}

func stringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case nil:
		return ""
	default:
		return fmt.Sprintf("%v", typed)
	}
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…"
}
