// Package onebot 实现 OneBot v11 客户端（WebSocket 正/反向兼容、HTTP 模式、API 调用与重连）。
//
// 行为对齐 Node 版 src/onebot.js：
//   - token 支持 header（Authorization: Bearer xxx）/ query / 裸值三种模式
//   - API 调用用 echo 关联响应，未连接时直接报错
//   - 断线重连：base * 2^(n-1)，上限 60s
package onebot

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Options 是 OneBot 客户端配置。
type Options struct {
	URL            string
	AccessToken    string
	TokenMode      string // header | query | ""
	Mode           string // ws | http
	Logger         *log.Logger
	HTTPListenAddr string // http 模式的事件上报监听地址（POST /onebot/event）
}

// EventHandler 处理收到的 OneBot 事件。
type EventHandler func(event map[string]any)

// Client 是 OneBot 客户端。
type Client struct {
	options Options
	logger  *log.Logger

	mu            sync.Mutex
	connection    *websocket.Conn
	connected     bool
	callID        int64
	pending       map[int64]chan apiResponse
	selfID        string
	nickname      string
	handler       EventHandler
	stopCh        chan struct{}
	reconnectWait time.Duration
}

type apiResponse struct {
	Status  string          `json:"status"`
	RetCode int             `json:"retcode"`
	Data    json.RawMessage `json:"data"`
	Msg     string          `json:"msg"`
	Wording string          `json:"wording"`
	Echo    json.RawMessage `json:"echo"`
}

// New 创建客户端。
func New(options Options) *Client {
	logger := options.Logger
	if logger == nil {
		logger = log.New(os.Stdout, "[onebot] ", log.LstdFlags)
	}
	if options.Mode == "" {
		options.Mode = "ws"
	}
	return &Client{
		options:       options,
		logger:        logger,
		pending:       map[int64]chan apiResponse{},
		stopCh:        make(chan struct{}),
		reconnectWait: 5 * time.Second,
	}
}

// SelfID 返回登录账号。
func (c *Client) SelfID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selfID
}

// Nickname 返回登录昵称。
func (c *Client) Nickname() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nickname
}

// Connected 返回连接状态。
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// SetHandler 注册事件处理函数（在读取循环中同步调用）。
func (c *Client) SetHandler(handler EventHandler) {
	c.mu.Lock()
	c.handler = handler
	c.mu.Unlock()
}

// buildConnectionURL 按 tokenMode=query 把令牌附加到查询串。
func (c *Client) buildConnectionURL() string {
	raw := strings.TrimSpace(c.options.URL)
	if c.options.TokenMode != "query" || c.options.AccessToken == "" {
		return raw
	}
	separator := "?"
	if strings.Contains(raw, "?") {
		separator = "&"
	}
	return raw + separator + "access_token=" + url.QueryEscape(c.options.AccessToken)
}

func (c *Client) buildHeaders() http.Header {
	headers := http.Header{}
	if c.options.AccessToken == "" || c.options.TokenMode == "query" {
		return headers
	}
	if c.options.TokenMode == "header" {
		headers.Set("Authorization", "Bearer "+c.options.AccessToken)
		return headers
	}
	headers.Set("Authorization", c.options.AccessToken)
	return headers
}

// Run 建立连接并在断开后自动重连，直到 context 结束。
func (c *Client) Run(ctx context.Context) error {
	for {
		if err := c.connectOnce(ctx); err != nil {
			c.logger.Printf("OneBot 连接结束: %v", err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-c.stopCh:
			return nil
		case <-time.After(c.nextReconnectDelay()):
		}
	}
}

func (c *Client) nextReconnectDelay() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	delay := c.reconnectWait
	// 逐步退避，上限 60s（与 Node 版一致）
	next := delay * 2
	if next > 60*time.Second {
		next = 60 * time.Second
	}
	c.reconnectWait = next
	return delay
}

func (c *Client) resetReconnectDelay() {
	c.mu.Lock()
	c.reconnectWait = 5 * time.Second
	c.mu.Unlock()
}

func (c *Client) connectOnce(ctx context.Context) error {
	if c.options.Mode == "http" {
		// HTTP 模式有两种形态：主动调 API（runHTTP）+ 接收上报事件（ServeHTTPReceiver）
		if c.options.HTTPListenAddr != "" {
			go func() {
				if err := c.ServeHTTPReceiver(ctx, c.options.HTTPListenAddr, func(event map[string]any) {
					c.mu.Lock()
					handler := c.handler
					c.mu.Unlock()
					if handler != nil {
						handler(event)
					}
				}); err != nil {
					c.logger.Printf("[OneBot] HTTP 上报接收失败: %v", err)
				}
			}()
		}
		return c.runHTTP(ctx)
	}
	target := c.buildConnectionURL()
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	c.logger.Printf("正在连接 OneBot (WS): %s", target)
	connection, response, err := dialer.DialContext(ctx, target, c.buildHeaders())
	if err != nil {
		if response != nil {
			return fmt.Errorf("连接失败: %w (HTTP %d)", err, response.StatusCode)
		}
		return fmt.Errorf("连接失败: %w", err)
	}
	c.mu.Lock()
	c.connection = connection
	c.connected = true
	c.mu.Unlock()
	c.resetReconnectDelay()
	c.logger.Printf("OneBot 已连接")

	defer func() {
		c.mu.Lock()
		c.connected = false
		c.connection = nil
		c.mu.Unlock()
		_ = connection.Close()
		c.failPending("连接已断开")
	}()

	go c.pingLoop(ctx, connection)

	// 读取循环必须立刻开始，否则 API 响应无人接收（Call 会一直等到超时）
	go func() {
		info, err := c.GetLoginInfo()
		if err != nil {
			c.logger.Printf("获取登录信息失败: %v", err)
			return
		}
		c.mu.Lock()
		c.selfID = info.UserID
		c.nickname = info.Nickname
		c.mu.Unlock()
		c.logger.Printf("登录账号: %s (%s)", info.Nickname, info.UserID)
	}()

	for {
		_, payload, err := connection.ReadMessage()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return fmt.Errorf("读取失败: %w", err)
			}
		}
		c.handlePayload(payload)
	}
}

func (c *Client) pingLoop(ctx context.Context, connection *websocket.Conn) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.mu.Lock()
			alive := c.connected
			c.mu.Unlock()
			if !alive {
				return
			}
			_ = connection.WriteControl(websocket.PingMessage, []byte("ping"), time.Now().Add(10*time.Second))
		}
	}
}

func (c *Client) handlePayload(payload []byte) {
	var envelope map[string]any
	if err := json.Unmarshal(payload, &envelope); err != nil {
		c.logger.Printf("解析消息失败: %v", err)
		return
	}
	if echo, ok := envelope["echo"]; ok {
		if id, ok := toInt64(echo); ok {
			c.mu.Lock()
			channel := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if channel != nil {
				var response apiResponse
				_ = json.Unmarshal(payload, &response)
				channel <- response
				return
			}
		}
	}
	if _, isResponse := envelope["status"]; isResponse {
		if _, hasPostType := envelope["post_type"]; !hasPostType {
			return
		}
	}
	c.mu.Lock()
	handler := c.handler
	c.mu.Unlock()
	if handler != nil {
		handler(envelope)
	}
}

func (c *Client) failPending(reason string) {
	c.mu.Lock()
	pending := c.pending
	c.pending = map[int64]chan apiResponse{}
	c.mu.Unlock()
	for _, channel := range pending {
		channel <- apiResponse{Status: "failed", Msg: reason}
	}
}

// Call 调用 OneBot API（WS 模式）。
func (c *Client) Call(action string, params map[string]any) (json.RawMessage, error) {
	if c.options.Mode == "http" {
		return c.callHTTP(action, params)
	}
	c.mu.Lock()
	connection := c.connection
	if connection == nil || !c.connected {
		c.mu.Unlock()
		return nil, fmt.Errorf("未连接到 OneBot")
	}
	c.callID += 1
	echo := c.callID
	channel := make(chan apiResponse, 1)
	c.pending[echo] = channel
	c.mu.Unlock()

	request := map[string]any{"action": action, "params": params, "echo": echo}
	payload, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if err := connection.WriteMessage(websocket.TextMessage, payload); err != nil {
		c.mu.Lock()
		delete(c.pending, echo)
		c.mu.Unlock()
		return nil, fmt.Errorf("发送失败: %w", err)
	}

	select {
	case response := <-channel:
		if response.Status == "ok" || response.RetCode == 0 {
			return response.Data, nil
		}
		message := response.Msg
		if message == "" {
			message = response.Wording
		}
		if message == "" {
			message = "API 调用失败"
		}
		return nil, fmt.Errorf("%s: %s", action, message)
	case <-time.After(15 * time.Second):
		c.mu.Lock()
		delete(c.pending, echo)
		c.mu.Unlock()
		return nil, fmt.Errorf("%s: 调用超时", action)
	}
}

// ---------------- HTTP 模式 ----------------

func (c *Client) runHTTP(ctx context.Context) error {
	base := strings.TrimRight(c.options.URL, "/")
	c.mu.Lock()
	c.connected = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.connected = false
		c.mu.Unlock()
	}()
	if info, err := c.GetLoginInfo(); err == nil {
		c.mu.Lock()
		c.selfID = info.UserID
		c.nickname = info.Nickname
		c.mu.Unlock()
		c.logger.Printf("登录账号: %s (%s) [HTTP 模式]", info.Nickname, info.UserID)
	}
	c.logger.Printf("OneBot HTTP 模式已就绪: %s", base)
	<-ctx.Done()
	return nil
}

func (c *Client) callHTTP(action string, params map[string]any) (json.RawMessage, error) {
	base := strings.TrimRight(c.options.URL, "/")
	body, err := json.Marshal(params)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, base+"/"+action, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	for key, values := range c.buildHeaders() {
		for _, value := range values {
			request.Header.Add(key, value)
		}
	}
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", action, err)
	}
	defer response.Body.Close()
	var envelope apiResponse
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		return nil, fmt.Errorf("%s: 解析响应失败: %w", action, err)
	}
	if envelope.Status == "ok" || envelope.RetCode == 0 {
		return envelope.Data, nil
	}
	message := envelope.Msg
	if message == "" {
		message = envelope.Wording
	}
	return nil, fmt.Errorf("%s: %s", action, message)
}

// ---------------- 常用接口 ----------------

// LoginInfo 是登录账号信息。
type LoginInfo struct {
	UserID   string `json:"user_id"`
	Nickname string `json:"nickname"`
}

// GetLoginInfo 获取登录信息。
func (c *Client) GetLoginInfo() (*LoginInfo, error) {
	data, err := c.Call("get_login_info", nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		UserID   any    `json:"user_id"`
		Nickname string `json:"nickname"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return &LoginInfo{UserID: stringifyID(payload.UserID), Nickname: payload.Nickname}, nil
}

// SendGroupMessage 发送群消息。
func (c *Client) SendGroupMessage(groupID string, message any) error {
	_, err := c.Call("send_group_msg", map[string]any{"group_id": toNumericIfPossible(groupID), "message": message})
	return err
}

// SendPrivateMessage 发送私聊消息。
func (c *Client) SendPrivateMessage(userID string, message any) error {
	_, err := c.Call("send_private_msg", map[string]any{"user_id": toNumericIfPossible(userID), "message": message})
	return err
}

// GetMsg 获取消息详情（引用消息解析用）。
func (c *Client) GetMsg(messageID string) (map[string]any, error) {
	data, err := c.Call("get_msg", map[string]any{"message_id": toNumericIfPossible(messageID)})
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// GetForwardMsg 获取合并转发内容。
func (c *Client) GetForwardMsg(id string) (any, error) {
	data, err := c.Call("get_forward_msg", map[string]any{"id": id})
	if err != nil {
		return nil, err
	}
	var payload any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// GetImage 获取图片（返回本地文件路径等）。
func (c *Client) GetImage(file string) (map[string]any, error) {
	data, err := c.Call("get_image", map[string]any{"file": file})
	if err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// Close 停止客户端。
func (c *Client) Close() {
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}
	c.mu.Lock()
	connection := c.connection
	c.mu.Unlock()
	if connection != nil {
		_ = connection.Close()
	}
}

// ---------------- 工具 ----------------

func toInt64(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		return int64(typed), true
	case int64:
		return typed, true
	case int:
		return int64(typed), true
	case string:
		var parsed int64
		if _, err := fmt.Sscanf(typed, "%d", &parsed); err == nil {
			return parsed, true
		}
	}
	return 0, false
}

func stringifyID(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		return fmt.Sprintf("%.0f", typed)
	case int64:
		return fmt.Sprintf("%d", typed)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// toNumericIfPossible 数字 ID 转 number，非数字保持字符串（兼容 OneBot 两种实现）。
func toNumericIfPossible(value string) any {
	var parsed int64
	if _, err := fmt.Sscanf(value, "%d", &parsed); err == nil {
		return parsed
	}
	return value
}

// ServeHTTPReceiver 启动 HTTP 事件接收服务（对齐 Node POST /onebot/event：
// OneBot 实现以 HTTP POST 上报事件）。阻塞直到 ctx 取消。
func (c *Client) ServeHTTPReceiver(ctx context.Context, listenAddr string, eventHandler func(map[string]any)) error {
	mux := http.NewServeMux()
	mux.HandleFunc("/onebot/event", func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writer.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var event map[string]any
		if err := json.NewDecoder(request.Body).Decode(&event); err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		c.mu.Lock()
		if c.selfID == "" {
			c.selfID = fmt.Sprintf("%v", event["self_id"])
		}
		c.mu.Unlock()
		if eventHandler != nil {
			eventHandler(event)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	})
	server := &http.Server{Addr: listenAddr, Handler: mux, ReadTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	c.logger.Printf("OneBot HTTP 上报接收已就绪: %s（POST /onebot/event）", listenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}
