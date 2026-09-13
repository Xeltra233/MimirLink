package search

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

var userAgents = []string{
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
	"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
}

// Client 是带重试与超时的 HTTP 客户端。
type Client struct {
	httpClient *http.Client
}

// NewClient 创建 HTTP 客户端。
func NewClient() *Client {
	return &Client{httpClient: &http.Client{Timeout: 20 * time.Second}}
}

type requestOptions struct {
	Method   string
	Headers  map[string]string
	Body     string
	Timeout  time.Duration
	Attempts int
}

// TextResponse 是文本响应。
type TextResponse struct {
	Status int
	Body   string
	OK     bool
}

// RequestText 发起文本请求（默认 GET，自动重试 5xx/网络错误）。
func (c *Client) RequestText(ctx context.Context, rawURL string, options requestOptions) (*TextResponse, error) {
	attempts := options.Attempts
	if attempts <= 0 {
		attempts = 3
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}

	var lastError error
	for attempt := 0; attempt < attempts; attempt++ {
		if attempt > 0 {
			wait := time.Duration(400*(1<<uint(attempt-1))) * time.Millisecond
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(wait):
			}
		}
		requestCtx, cancel := context.WithTimeout(ctx, timeout)
		method := options.Method
		if method == "" {
			method = http.MethodGet
		}
		var bodyReader io.Reader
		if options.Body != "" {
			bodyReader = strings.NewReader(options.Body)
		}
		request, err := http.NewRequestWithContext(requestCtx, method, rawURL, bodyReader)
		if err != nil {
			cancel()
			return nil, err
		}
		request.Header.Set("User-Agent", userAgents[rand.Intn(len(userAgents))])
		request.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
		for key, value := range options.Headers {
			request.Header.Set(key, value)
		}
		response, err := c.httpClient.Do(request)
		if err != nil {
			cancel()
			lastError = err
			continue
		}
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
		response.Body.Close()
		cancel()
		if readErr != nil {
			lastError = readErr
			continue
		}
		result := &TextResponse{Status: response.StatusCode, Body: string(payload), OK: response.StatusCode >= 200 && response.StatusCode < 300}
		if result.OK || response.StatusCode < 500 {
			return result, nil
		}
		lastError = fmt.Errorf("HTTP %d", response.StatusCode)
	}
	if lastError == nil {
		lastError = errors.New("请求失败")
	}
	return nil, lastError
}

// RequestJSON 发起 JSON 请求并解码。
func (c *Client) RequestJSON(ctx context.Context, rawURL string, options requestOptions, target any) error {
	response, err := c.RequestText(ctx, rawURL, options)
	if err != nil {
		return err
	}
	if !response.OK {
		return fmt.Errorf("HTTP %d", response.Status)
	}
	if err := json.Unmarshal([]byte(response.Body), target); err != nil {
		return fmt.Errorf("响应解析失败: %w", err)
	}
	return nil
}
