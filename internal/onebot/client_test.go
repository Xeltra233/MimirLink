package onebot

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// 模拟 OneBot WS 服务端：响应 API 调用（echo 关联）并可主动推送事件。
type fakeServer struct {
	server   *httptest.Server
	upgrader websocket.Upgrader
	events   chan map[string]any
	received chan map[string]any
	authSeen chan string
	active   chan *websocket.Conn
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	fake := &fakeServer{
		upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		events:   make(chan map[string]any, 16),
		received: make(chan map[string]any, 32),
		authSeen: make(chan string, 4),
		active:   make(chan *websocket.Conn, 4),
	}
	fake.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case fake.authSeen <- request.Header.Get("Authorization"):
		default:
		}
		connection, err := fake.upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		defer connection.Close()
		select {
		case fake.active <- connection:
		default:
		}
		var writeMu sync.Mutex
		writeJSON := func(v any) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return connection.WriteJSON(v)
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				_, payload, err := connection.ReadMessage()
				if err != nil {
					return
				}
				var envelope map[string]any
				if err := json.Unmarshal(payload, &envelope); err != nil {
					continue
				}
				select {
				case fake.received <- envelope:
				default:
				}
				action, _ := envelope["action"].(string)
				echo := envelope["echo"]
				var data any = map[string]any{}
				switch action {
				case "get_login_info":
					data = map[string]any{"user_id": 1000, "nickname": "Go测试Bot"}
				case "send_group_msg":
					data = map[string]any{"message_id": 42}
				case "get_forward_msg":
					data = map[string]any{"messages": []any{
						map[string]any{"sender": map[string]any{"nickname": "甲", "user_id": "1"}, "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "转发内容"}}}},
					}}
				case "fail_action":
					_ = writeJSON(map[string]any{"status": "failed", "retcode": 1, "msg": "模拟失败", "echo": echo})
					continue
				}
				_ = writeJSON(map[string]any{"status": "ok", "retcode": 0, "data": data, "echo": echo})
			}
		}()
		for {
			select {
			case event := <-fake.events:
				if err := writeJSON(event); err != nil {
					return
				}
			case <-done:
				return
			}
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeServer) disconnect(t *testing.T) {
	t.Helper()
	select {
	case connection := <-f.active:
		_ = connection.Close()
	case <-time.After(2 * time.Second):
		t.Fatalf("没有可断开的连接")
	}
}

func (f *fakeServer) wsURL() string {
	return "ws" + strings.TrimPrefix(f.server.URL, "http")
}

func newTestClient(t *testing.T, url string, token string, tokenMode string) *Client {
	t.Helper()
	return New(Options{
		URL:         url,
		AccessToken: token,
		TokenMode:   tokenMode,
		Logger:      log.New(os.Stdout, "[test-onebot] ", 0),
	})
}

func waitFor(t *testing.T, timeout time.Duration, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func TestCallCorrelatesEchoAndReturnsData(t *testing.T) {
	fake := newFakeServer(t)
	client := newTestClient(t, fake.wsURL(), "secret-token", "header")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	if !waitFor(t, 5*time.Second, client.Connected) {
		t.Fatalf("客户端未连接")
	}
	select {
	case auth := <-fake.authSeen:
		if auth != "Bearer secret-token" {
			t.Fatalf("鉴权头不符: %q", auth)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("未收到握手请求")
	}

	info, err := client.GetLoginInfo()
	if err != nil {
		t.Fatalf("获取登录信息失败: %v", err)
	}
	if info.UserID != "1000" || info.Nickname != "Go测试Bot" {
		t.Fatalf("登录信息不符: %+v", info)
	}
	if client.SelfID() != "1000" {
		t.Fatalf("SelfID 未更新: %s", client.SelfID())
	}

	if err := client.SendGroupMessage("99001", []map[string]any{{"type": "text", "data": map[string]any{"text": "hello"}}}); err != nil {
		t.Fatalf("发送群消息失败: %v", err)
	}
	// 连接后客户端会异步拉取登录信息，这里跳过其它调用，等 send_group_msg
	deadline := time.After(3 * time.Second)
	found := false
	for !found {
		select {
		case envelope := <-fake.received:
			if envelope["action"] != "send_group_msg" {
				continue
			}
			params, _ := envelope["params"].(map[string]any)
			if params["group_id"] != float64(99001) {
				t.Fatalf("group_id 未转数字: %#v", params["group_id"])
			}
			found = true
		case <-deadline:
			t.Fatalf("服务端未收到 send_group_msg 调用")
		}
	}

	if _, err := client.Call("fail_action", nil); err == nil {
		t.Fatalf("失败响应应返回错误")
	} else if !strings.Contains(err.Error(), "模拟失败") {
		t.Fatalf("错误信息不符: %v", err)
	}

	payload, err := client.GetForwardMsg("fwd-1")
	if err != nil {
		t.Fatalf("获取合并转发失败: %v", err)
	}
	if _, ok := payload.(map[string]any); !ok {
		t.Fatalf("合并转发返回结构不符: %T", payload)
	}
}

func TestEventsReachHandler(t *testing.T) {
	fake := newFakeServer(t)
	client := newTestClient(t, fake.wsURL(), "", "")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()

	events := make(chan map[string]any, 4)
	client.SetHandler(func(event map[string]any) {
		events <- event
	})
	if !waitFor(t, 5*time.Second, client.Connected) {
		t.Fatalf("客户端未连接")
	}
	fake.events <- map[string]any{
		"post_type":    "message",
		"message_type": "group",
		"group_id":     99001,
		"user_id":      2001,
		"message":      []any{map[string]any{"type": "text", "data": map[string]any{"text": "事件测试"}}},
	}
	select {
	case event := <-events:
		if event["post_type"] != "message" || event["group_id"] != float64(99001) {
			t.Fatalf("事件内容不符: %+v", event)
		}
	case <-time.After(3 * time.Second):
		t.Fatalf("未收到事件")
	}
}

func TestCallWithoutConnectionFails(t *testing.T) {
	client := newTestClient(t, "ws://127.0.0.1:1", "", "")
	if _, err := client.Call("get_login_info", nil); err == nil {
		t.Fatalf("未连接时应报错")
	}
}

func TestReconnectAfterServerRestart(t *testing.T) {
	fake := newFakeServer(t)
	client := newTestClient(t, fake.wsURL(), "", "")
	client.reconnectWait = 100 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = client.Run(ctx) }()
	if !waitFor(t, 5*time.Second, client.Connected) {
		t.Fatalf("首次连接失败")
	}

	// 服务端主动断开连接，客户端应自动重连（同一地址）
	fake.disconnect(t)
	if !waitFor(t, 5*time.Second, func() bool { return !client.Connected() }) {
		t.Fatalf("断线后状态未更新")
	}
	if !waitFor(t, 10*time.Second, client.Connected) {
		t.Fatalf("未自动重连")
	}
	select {
	case <-fake.active:
	default:
	}

	if _, err := client.GetLoginInfo(); err != nil {
		t.Fatalf("重连后调用失败: %v", err)
	}
}
