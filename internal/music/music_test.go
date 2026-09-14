package music

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSplitTrailingParam(t *testing.T) {
	cases := []struct {
		argument     string
		body         string
		deliveryMode string
		format       string
	}{
		{"1 mp3", "1", "file", "mp3"},
		{"Scream Aim Fire flac", "Scream Aim Fire", "file", "flac"},
		{"song mp3 live", "song mp3 live", "voice", ""},
		{"mp3", "mp3", "voice", ""},
		{"晴天", "晴天", "voice", ""},
		{"1 mv", "1", "video", ""},
		{"1 voice", "1", "voice", ""},
		{"1 file", "1", "file", ""},
	}
	for _, testCase := range cases {
		result := SplitTrailingParam(testCase.argument)
		if result.Body != testCase.body || result.DeliveryMode != testCase.deliveryMode || result.Format != testCase.format {
			t.Fatalf("%q → body=%q mode=%q format=%q，期望 body=%q mode=%q format=%q",
				testCase.argument, result.Body, result.DeliveryMode, result.Format, testCase.body, testCase.deliveryMode, testCase.format)
		}
	}
}

func TestParseCommand(t *testing.T) {
	if parsed := ParseCommand("你好", "/music", "/music-exit", nil); parsed.Type != "none" {
		t.Fatalf("非命令应 none: %+v", parsed)
	}
	if parsed := ParseCommand("[@bot] /music", "/music", "/music-exit", nil); parsed.Type != "usage" {
		t.Fatalf("@bot 前缀 + 无参数应 usage: %+v", parsed)
	}
	if parsed := ParseCommand("/music-exit", "/music", "/music-exit", nil); parsed.Type != "exit" {
		t.Fatalf("退出指令应 exit: %+v", parsed)
	}
	if parsed := ParseCommand("/music 晴天 周杰伦", "/music", "/music-exit", nil); parsed.Type != "search" || parsed.Query != "晴天 周杰伦" {
		t.Fatalf("搜索解析异常: %+v", parsed)
	}
	session := &Session{Results: []map[string]any{
		{"index": float64(1), "display_name": "晴天 - 周杰伦"},
		{"index": float64(2), "display_name": "七里香 - 周杰伦"},
	}}
	if parsed := ParseCommand("/music 2", "/music", "/music-exit", session); parsed.Type != "select" || parsed.Index != 2 || !parsed.IndexSet {
		t.Fatalf("序号选歌异常: %+v", parsed)
	}
	if parsed := ParseCommand("/music 七里香 - 周杰伦", "/music", "/music-exit", session); parsed.Type != "select" || parsed.Name != "七里香 - 周杰伦" {
		t.Fatalf("歌名选歌异常: %+v", parsed)
	}
	// 退出指令优先：/music-exit 不会被 /music 前缀误吃
	if parsed := ParseCommand("/music-exit", "/music", "/music-exit", session); parsed.Type != "exit" {
		t.Fatalf("exit 应先判断: %+v", parsed)
	}
}

func TestResolveDownloadFormat(t *testing.T) {
	if got := ResolveDownloadFormat("voice", ""); !got.OK || got.Format != "opus" || got.DeliveryMode != "voice" {
		t.Fatalf("默认语音应 opus: %+v", got)
	}
	if got := ResolveDownloadFormat("file", ""); !got.OK || got.Format != "mp3" || got.DeliveryMode != "file" {
		t.Fatalf("file 默认应 mp3: %+v", got)
	}
	if got := ResolveDownloadFormat("file", "m4a"); !got.OK || got.Format != "m4a" {
		t.Fatalf("m4a 异常: %+v", got)
	}
	if got := ResolveDownloadFormat("file", "flac"); got.OK {
		t.Fatalf("flac 应不支持: %+v", got)
	}
	if got := ResolveDownloadFormat("video", "mv"); !got.OK || got.Format != "mp4" {
		t.Fatalf("mv 应 mp4: %+v", got)
	}
}

func TestSessionStoreLifecycle(t *testing.T) {
	store := NewSessionStore()
	store.Set("k1", &Session{BridgeSessionID: "bs", Results: []map[string]any{}}, 50*time.Millisecond)
	if store.Get("k1") == nil {
		t.Fatal("写入后应可读")
	}
	if !store.Delete("k1") {
		t.Fatal("删除应返回 true")
	}
	if store.Delete("k1") {
		t.Fatal("重复删除应返回 false")
	}
	// 过期
	store.Set("k2", &Session{}, 10*time.Millisecond)
	time.Sleep(30 * time.Millisecond)
	if store.Get("k2") != nil {
		t.Fatal("过期会话应删除")
	}
	// 下载互斥
	if !store.AcquireDownload("k3") {
		t.Fatal("首次获取应成功")
	}
	if store.AcquireDownload("k3") {
		t.Fatal("重复获取应失败")
	}
	store.ReleaseDownload("k3")
	if !store.AcquireDownload("k3") {
		t.Fatal("释放后应可重新获取")
	}
}

func TestSearchAndSelectFlow(t *testing.T) {
	searchCalls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/search":
			searchCalls += 1
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"session_id":"bs1","expires_in":600,"results":[{"index":1,"display_name":"晴天 - 周杰伦","duration":"4:29","duration_seconds":269}]}`))
		case "/download":
			if got := r.Header.Get("X-API-Key"); got != "secret" {
				w.WriteHeader(401)
				_, _ = w.Write([]byte(`{"code":"UNAUTHORIZED","message":"bad key"}`))
				return
			}
			w.Header().Set("Content-Type", "audio/mpeg")
			_, _ = w.Write([]byte("FAKE_MP3_BYTES"))
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	config := map[string]any{"enabled": true, "baseUrl": server.URL, "apiKey": "secret"}
	client := &BridgeClient{BaseURL: server.URL, APIKey: "secret"}
	handler := &Handler{Config: func() map[string]any { return config }, Client: client, AudioDir: t.TempDir()}

	sent := []string{}
	senders := Senders{
		SendText:  func(text string) error { sent = append(sent, text); return nil },
		SendVoice: func(string) error { return nil },
		SendFile:  func(string, string) error { return nil },
	}

	// 搜索
	result := handler.Handle(context.Background(), map[string]any{"message_type": "group", "group_id": "g1", "user_id": "u1"}, "/music 晴天", senders)
	if !result.Handled || !result.OK || result.Reason != "search" {
		t.Fatalf("搜索应成功: %+v", result)
	}
	if len(sent) == 0 || !strings.Contains(sent[len(sent)-1], "晴天 - 周杰伦") {
		t.Fatalf("候选列表未发送: %v", sent)
	}
	// 选歌（语音下载）
	sent = sent[:0]
	result = handler.Handle(context.Background(), map[string]any{"message_type": "group", "group_id": "g1", "user_id": "u1"}, "/music 1", senders)
	if !result.Handled || result.Reason != "sent" {
		t.Fatalf("选歌应成功: %+v", result)
	}
	// 禁用时拦截且不进 LLM
	config["enabled"] = false
	sent = sent[:0]
	result = handler.Handle(context.Background(), map[string]any{"message_type": "group", "group_id": "g1", "user_id": "u1"}, "/music 晴天", senders)
	if !result.Handled || result.OK || result.Reason != "disabled" {
		t.Fatalf("禁用应拦截: %+v", result)
	}
	if searchCalls != 1 {
		t.Fatalf("搜索应只调一次上游: %d", searchCalls)
	}
}

func TestDownloadFileTooLarge(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 声明 2MB，超过 1MB 配置上限
		w.Header().Set("Content-Length", "2097152")
		_, _ = w.Write(make([]byte, 2097152))
	}))
	defer server.Close()
	config := NormalizeConfig(map[string]any{"maxFilesizeMB": 1, "baseUrl": server.URL})
	client := &BridgeClient{BaseURL: server.URL}
	_, err := client.Download(context.Background(), "bs", 1, true, "", "", "mp3", config)
	if err == nil || !strings.Contains(err.Error(), "超过上限") {
		t.Fatalf("应报文件过大: %v", err)
	}
}

func TestBuildFileName(t *testing.T) {
	name := BuildFileName(map[string]any{"display_name": "晴天+续集: 试/听?"}, "", "mp3")
	if strings.ContainsAny(name, "\\/:*?\"<>|") || strings.Contains(name, "+") || !strings.HasSuffix(name, ".mp3") {
		t.Fatalf("文件名非法字符未清理: %q", name)
	}
}
