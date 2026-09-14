package onebot

import (
	"context"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestReconnectRebuildsConnection 守护面板「OneBot 重连」按钮的真实能力：
// Reconnect 必须让读取循环结束并立即建立新连接（旧实现只能等自然断线）。
func TestReconnectRebuildsConnection(t *testing.T) {
	var connections int32
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		connection, err := upgrader.Upgrade(writer, request, nil)
		if err != nil {
			return
		}
		atomic.AddInt32(&connections, 1)
		defer func() { _ = connection.Close() }()
		for {
			_, payload, err := connection.ReadMessage()
			if err != nil {
				return
			}
			// 回应 API 调用，保证登录信息等动作能完成
			if strings.Contains(string(payload), "get_login_info") {
				echo := "null"
				if index := strings.Index(string(payload), `"echo":`); index >= 0 {
					echo = strings.TrimRight(strings.TrimSpace(string(payload)[index+len(`"echo":`):]), "}")
				}
				reply := `{"status":"ok","retcode":0,"data":{"user_id":"10001","nickname":"重连测试"},"echo":` + echo + `}`
				if err := connection.WriteMessage(websocket.TextMessage, []byte(reply)); err != nil {
					return
				}
			}
		}
	}))
	defer server.Close()

	client := New(Options{
		URL:    "ws" + strings.TrimPrefix(server.URL, "http"),
		Mode:   "ws",
		Logger: log.New(os.Stdout, "[test] ", 0),
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		_ = client.Run(ctx)
		close(done)
	}()

	// 等待首个连接
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt32(&connections) == 0 {
		time.Sleep(50 * time.Millisecond)
	}
	if atomic.LoadInt32(&connections) == 0 {
		t.Fatal("首次连接未建立")
	}
	if err := client.Reconnect(); err != nil {
		t.Fatalf("Reconnect 失败: %v", err)
	}
	deadline = time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) && atomic.LoadInt32(&connections) < 2 {
		time.Sleep(50 * time.Millisecond)
	}
	if got := atomic.LoadInt32(&connections); got < 2 {
		t.Fatalf("Reconnect 后应建立新连接，实际连接数 %d", got)
	}
	if !client.Connected() {
		t.Fatal("重连后 Connected 应为 true")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run 未在取消后退出")
	}
}
