package ai

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newTestClient 构造指向桩服务的客户端。
func newTestClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client := New(Provider{
		ID:      "test",
		BaseURL: server.URL,
		Model:   "test-model",
		Timeout: 5 * time.Second,
	})
	return client
}

// TestChatPrefillFallbackChain：非流式空回复 → 去 prefill 重试成功。
func TestChatPrefillFallback(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount += 1
		w.Header().Set("Content-Type", "application/json")
		if requestCount == 1 {
			// 首次：content 为空 → 触发空回复
			fmt.Fprint(w, `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`)
			return
		}
		// 重试：带 prefill 移除后的消息
		body := make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		if strings.Contains(string(body), "prefill") {
			fmt.Fprint(w, `{"choices":[{"message":{"content":"仍带prefill"},"finish_reason":"stop"}]}`)
			return
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"回退成功"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	client := newTestClient(t, server)
	messages := []Message{
		{Role: "user", Content: "你好"},
		{Role: "assistant", Content: "我预填一部分"},
	}
	result, err := client.Chat(context.Background(), messages, nil)
	if err != nil {
		t.Fatalf("回退链失败: %v", err)
	}
	if result.Content != "回退成功" {
		t.Fatalf("回退内容异常: %q", result.Content)
	}
	if requestCount != 2 {
		t.Fatalf("应恰好两次请求: %d", requestCount)
	}
}

// TestChatStreamingFallback：非流式与去 prefill 都空 → 流式 SSE 兜底。
func TestChatStreamingFallback(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount += 1
		if requestCount == 1 {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`)
			return
		}
		// 第二次：流式响应
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"流式\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"兜底成功\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	client := newTestClient(t, server)
	messages := []Message{{Role: "user", Content: "你好"}}
	result, err := client.Chat(context.Background(), messages, nil)
	if err != nil {
		t.Fatalf("流式兜底失败: %v", err)
	}
	if result.Content != "流式兜底成功" {
		t.Fatalf("流式内容异常: %q", result.Content)
	}
	if requestCount != 2 {
		t.Fatalf("应恰好两次请求（非流式+流式兜底）: %d", requestCount)
	}
}

// TestChatStreamingReasoningOnly：流式仅返回 reasoning_content 时回退使用。
func TestChatStreamingReasoningOnly(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount += 1
		if requestCount == 1 {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"思考内容\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer server.Close()

	client := newTestClient(t, server)
	result, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "hi"}}, nil)
	if err != nil {
		t.Fatalf("流式兜底失败: %v", err)
	}
	if result.ReasoningContent != "思考内容" {
		t.Fatalf("reasoning 异常: %q", result.ReasoningContent)
	}
	if result.Content != "思考内容" {
		t.Fatalf("content 应回退使用 reasoning: %q", result.Content)
	}
}

// TestChatNonStreamingReasoningOnly：非流式仅返回 reasoning_content 时回退使用。
func TestChatNonStreamingReasoningOnly(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"","reasoning_content":"非流式思考内容"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	client := newTestClient(t, server)
	result, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "你好"}}, nil)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	if result.Content != "非流式思考内容" {
		t.Fatalf("content 应回退使用 reasoning: %q", result.Content)
	}
}

// TestChatNormalPath：正常非流式响应一次成功。
func TestChatNormalPath(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount += 1
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":"正常回复"},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	client := newTestClient(t, server)
	result, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "你好"}}, nil)
	if err != nil {
		t.Fatalf("正常路径失败: %v", err)
	}
	if result.Content != "正常回复" || requestCount != 1 {
		t.Fatalf("内容/请求数异常: %q %d", result.Content, requestCount)
	}
}

// TestChatAllPathsEmpty：全部兜底都空时返回组合错误。
func TestChatAllPathsEmpty(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`)
	}))
	defer server.Close()

	client := newTestClient(t, server)
	_, err := client.Chat(context.Background(), []Message{{Role: "user", Content: "你好"}}, nil)
	if err == nil || !strings.Contains(err.Error(), "空回复") {
		t.Fatalf("应返回空回复组合错误: %v", err)
	}
}

// TestChatPrefillFallbackToStreamingWithoutPrefill 预填重试仍空时，流式兜底不带尾部预填。
func TestChatPrefillFallbackToStreamingWithoutPrefill(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount += 1
		if requestCount <= 2 {
			// 1: 首次（带 prefill）空回复；2: 重试（去 prefill）仍空回复
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"choices":[{"message":{"content":""},"finish_reason":"stop"}]}`)
			return
		}
		// 3: 流式兜底
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"流式兜底成功\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer server.Close()

	client := newTestClient(t, server)
	messages := []Message{
		{Role: "user", Content: "你好"},
		{Role: "assistant", Content: "预填内容"},
	}
	result, err := client.Chat(context.Background(), messages, nil)
	if err != nil {
		t.Fatalf("流式兜底失败: %v", err)
	}
	if result.Content != "流式兜底成功" {
		t.Fatalf("流式兜底内容异常: %q", result.Content)
	}
	if requestCount != 3 {
		t.Fatalf("应依次进行3次请求（首次、非流式重试、流式兜底），实际: %d", requestCount)
	}
}
