package chat

import (
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/config"
)

// TestLLMGateSkipsMessages 守护 LLM 总开关（对齐 Node：`if (!llmEnabled) return;`）：
// 关闭后不调用模型、不写入历史、不回复。
func TestLLMGateSkipsMessages(t *testing.T) {
	model := &fakeModel{replies: []string{"不该出现"}}
	runtime, bot, memory := newRuntime(t, map[string]any{
		"runtime": map[string]any{"llmEnabled": false},
	}, model)

	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); handled {
		t.Fatal("LLM 关闭时不应处理消息")
	}
	if len(model.requests) != 0 {
		t.Fatalf("LLM 关闭时不应调用模型，实际 %d 次", len(model.requests))
	}
	if len(bot.groupSent) != 0 {
		t.Fatalf("LLM 关闭时不应发送消息，实际 %d 条", len(bot.groupSent))
	}
	messages, err := memory.RecentMessagesThread("user_persistent:user_2001", 10)
	if err != nil {
		t.Fatalf("读取历史失败: %v", err)
	}
	if len(messages) != 0 {
		t.Fatalf("LLM 关闭时不应写入历史，实际 %d 条", len(messages))
	}
}

// TestLLMGateDefaultOn 缺省（未配置 runtime.llmEnabled）应视为开启。
func TestLLMGateDefaultOn(t *testing.T) {
	model := &fakeModel{replies: []string{"在的"}}
	runtime, bot, _ := newRuntime(t, nil, model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("缺省应视为 LLM 开启")
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("应回复一条消息，实际 %d", len(bot.groupSent))
	}
}

// TestConfigHotReloadRebuildsRegex 配置热加载后按新规则处理输入/输出，
// 旧实现正则处理器只在启动时构建一次，面板改规则必须重启 bot 才生效。
func TestConfigHotReloadRebuildsRegex(t *testing.T) {
	model := &fakeModel{replies: []string{"回复里含屏蔽词", "回复里含屏蔽词"}}
	document, dataDir := buildDocument(t, map[string]any{
		"regex": map[string]any{"enabled": true, "usePresetRules": false, "rules": []any{}},
	})
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	memory := openMemory(t, dataDir)
	runtime := New(Options{
		Document: document, Memory: memory, AI: model, Bot: bot,
		Logger: log.New(io.Discard, "", 0),
	})

	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("首条消息应触发回复")
	}
	if !strings.Contains(replyText(t, bot), "屏蔽词") {
		t.Fatalf("首条回复应保留原文本: %q", replyText(t, bot))
	}

	// 模拟面板写入新规则（输出阶段替换"屏蔽词"）并触发配置代数变化
	if err := document.Set("regex.rules", []any{
		map[string]any{"name": "屏蔽", "pattern": "屏蔽词", "flags": "g", "replacement": "[已过滤]", "stage": "output", "enabled": true},
	}); err != nil {
		t.Fatalf("写入规则失败: %v", err)
	}
	if handled := runtime.HandleEvent(buildGroupEvent("再试一次", true, "99001", "2001")); !handled {
		t.Fatal("第二条消息应触发回复")
	}
	if got := replyText(t, bot); !strings.Contains(got, "[已过滤]") || strings.Contains(got, "屏蔽词") {
		t.Fatalf("热加载后应应用新规则，实际: %q", got)
	}
}

func replyText(t *testing.T, bot *fakeBot) string {
	t.Helper()
	if len(bot.groupSent) == 0 {
		t.Fatal("没有发送任何群消息")
	}
	segments, _ := bot.groupSent[len(bot.groupSent)-1]["message"].([]map[string]any)
	for _, segment := range segments {
		if segment["type"] == "text" {
			if data, ok := segment["data"].(map[string]any); ok {
				return stringOf(data["text"])
			}
		}
	}
	return ""
}

// TestConfigHotReloadRebuildsAIClient 配置热加载后 AI 请求应打到新的 BaseURL/模型，
// 旧实现只在启动时解析 provider，面板改模型/Key 不生效。
func TestConfigHotReloadRebuildsAIClient(t *testing.T) {
	var (
		mu        sync.Mutex
		requests1 int
		requests2 int
	)
	newUpstream := func(counter *int) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			mu.Lock()
			*counter++
			mu.Unlock()
			writer.Header().Set("Content-Type", "application/json")
			_, _ = writer.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"上游回复"}}]}`))
		}))
	}
	upstream1 := newUpstream(&requests1)
	defer upstream1.Close()
	upstream2 := newUpstream(&requests2)
	defer upstream2.Close()

	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "chats"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	raw := []byte(`{
		"chat": {"sessionMode": "user_persistent", "requireAtInGroup": true, "allowedGroups": ["99001"]},
		"preset": {"enabled": true, "prompts": [{"enabled": true, "content": "系统提示", "role": "system"}]},
		"ai": {"activeProviderId": "p1", "providers": [
			{"id": "p1", "baseUrl": "` + upstream1.URL + `", "apiKey": "k1", "model": "model-1"}
		]}
	}`)
	document, err := config.New(filepath.Join(root, "config.json"), raw)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	memory := openMemory(t, dataDir)
	runtime := New(Options{
		Document: document, Memory: memory, AI: &fakeModel{replies: []string{"占位"}}, Bot: bot,
		Logger:     log.New(io.Discard, "", 0),
		AIProvider: func() (ai.Provider, error) { return ai.ResolveProvider(document) },
	})

	// 切换配置到第二个上游
	if err := document.Set("ai.providers", []any{
		map[string]any{"id": "p1", "baseUrl": upstream2.URL, "apiKey": "k2", "model": "model-2"},
	}); err != nil {
		t.Fatalf("写入供应商失败: %v", err)
	}
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("应触发回复")
	}
	mu.Lock()
	first, second := requests1, requests2
	mu.Unlock()
	if second == 0 {
		t.Fatal("热加载后请求应打到新上游")
	}
	if first != 0 {
		t.Fatalf("热加载后不应再请求旧上游，实际 %d 次", first)
	}
}

// TestReloadIfChangedFromDisk 守护基于 mtime 的热加载（bot 侧 watcher 的核心）。
func TestReloadIfChangedFromDisk(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, []byte(`{"chat":{"model":"a"}}`), 0o644); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	document, err := config.Load(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if changed, err := document.ReloadIfChanged(); err != nil || changed {
		t.Fatalf("无变更时不应重载: changed=%v err=%v", changed, err)
	}
	before := document.Generation()
	// 等一秒保证 mtime 变化（部分文件系统时间精度为秒）
	time.Sleep(1100 * time.Millisecond)
	if err := os.WriteFile(path, []byte(`{"chat":{"model":"b"}}`), 0o644); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	changed, err := document.ReloadIfChanged()
	if err != nil || !changed {
		t.Fatalf("变更后应重载: changed=%v err=%v", changed, err)
	}
	if document.String("chat.model") != "b" {
		t.Fatalf("热加载内容不正确: %q", document.String("chat.model"))
	}
	if document.Generation() <= before {
		t.Fatalf("代数应自增: %d → %d", before, document.Generation())
	}
}
