package chat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mimirlink/internal/ai"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

type fakeBot struct {
	selfID       string
	groupSent    []map[string]any
	privateSent  []map[string]any
	forwards     map[string]any
	messagesByID map[string]map[string]any
}

func (b *fakeBot) SelfID() string { return b.selfID }

func (b *fakeBot) SendGroupMessage(groupID string, message any) error {
	b.groupSent = append(b.groupSent, map[string]any{"groupID": groupID, "message": message})
	return nil
}

func (b *fakeBot) SendPrivateMessage(userID string, message any) error {
	b.privateSent = append(b.privateSent, map[string]any{"userID": userID, "message": message})
	return nil
}

func (b *fakeBot) GetForwardMsg(id string) (any, error) {
	if payload, ok := b.forwards[id]; ok {
		return payload, nil
	}
	return nil, os.ErrNotExist
}

func (b *fakeBot) GetMsg(messageID string) (map[string]any, error) {
	if payload, ok := b.messagesByID[messageID]; ok {
		return payload, nil
	}
	return nil, os.ErrNotExist
}

type fakeModel struct {
	replies      []string
	profileReply string // 命中档案分析提示词时返回
	failAlways   bool   // 始终返回错误（模拟 vision 模型不可用）
	requests     [][]ai.Message
	provider     ai.Provider
}

func (m *fakeModel) Chat(ctx context.Context, messages []ai.Message, overrides map[string]any) (*ai.ChatResult, error) {
	m.requests = append(m.requests, messages)
	if m.failAlways {
		return nil, errors.New("模型不可用")
	}
	// 档案分析提示词按特征返回专用回复，避免异步 goroutine 抢占普通回复
	for _, message := range messages {
		if text, ok := message.Content.(string); ok && strings.Contains(text, "人物档案分析器") && m.profileReply != "" {
			return &ai.ChatResult{Content: m.profileReply}, nil
		}
	}
	reply := "空"
	if len(m.replies) > 0 {
		reply = m.replies[0]
		m.replies = m.replies[1:]
	}
	return &ai.ChatResult{Content: reply}, nil
}

func buildDocument(t *testing.T, overrides map[string]any) (*config.Document, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataDir, "chats"), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	base := map[string]any{
		"chat": map[string]any{
			"sessionMode":      "user_persistent",
			"requireAtInGroup": true,
			"allowedGroups":    []any{"99001"},
			"model":            "test-model",
			// 单测默认关闭连发聚合与回复延迟，保证断言同步可预期
			"bufferWindowMs": 0,
			"replyDelayMs":   0,
		},
		"preset": map[string]any{
			"enabled": true,
			"name":    "测试预设",
			"prompts": []any{map[string]any{"enabled": true, "content": "你是测试角色，回答要简短。", "role": "system"}},
		},
		"ai": map[string]any{
			"providers": []any{map[string]any{"id": "p1", "baseUrl": "http://127.0.0.1:1/v1", "apiKey": "k", "model": "test-model"}},
		},
	}
	for key, value := range overrides {
		base[key] = value
	}
	encoded, err := json.Marshal(base)
	if err != nil {
		t.Fatalf("序列化配置失败: %v", err)
	}
	document, err := config.New(filepath.Join(root, "config.json"), encoded)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	return document, dataDir
}

func openMemory(t *testing.T, dataDir string) *store.DB {
	t.Helper()
	path := filepath.Join(dataDir, "chats", "memory-store.sqlite")
	db, err := store.Open(path)
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := db.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

var testEventSeq int64

func buildGroupEvent(text string, atBot bool, groupID string, userID string) map[string]any {
	testEventSeq++
	segments := []any{}
	if atBot {
		segments = append(segments, map[string]any{"type": "at", "data": map[string]any{"qq": "1000"}})
	}
	segments = append(segments, map[string]any{"type": "text", "data": map[string]any{"text": text}})
	return map[string]any{
		"post_type":    "message",
		"message_type": "group",
		"group_id":     groupID,
		"user_id":      userID,
		"message_id":   fmt.Sprintf("m-%d", testEventSeq),
		"message":      segments,
		"sender":       map[string]any{"nickname": "测试员"},
		"time":         float64(1789311808),
	}
}

func newRuntime(t *testing.T, overrides map[string]any, model *fakeModel) (*Runtime, *fakeBot, *store.DB) {
	t.Helper()
	document, dataDir := buildDocument(t, overrides)
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	memory := openMemory(t, dataDir)
	runtime := New(Options{
		Document: document,
		Memory:   memory,
		AI:       model,
		Bot:      bot,
		Logger:   log.New(os.Stdout, "[test] ", 0),
	})
	return runtime, bot, memory
}

func TestGroupMessageRequiresAtBot(t *testing.T) {
	model := &fakeModel{replies: []string{"在的"}}
	runtime, bot, _ := newRuntime(t, nil, model)

	if handled := runtime.HandleEvent(buildGroupEvent("你好", false, "99001", "2001")); handled {
		t.Fatalf("未 @bot 的群消息不应触发回复")
	}
	if len(model.requests) != 0 {
		t.Fatalf("未 @bot 时不应调用模型")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatalf("@bot 的群消息应触发回复")
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("应发送一条群消息，实际 %d", len(bot.groupSent))
	}
	segments, _ := bot.groupSent[0]["message"].([]map[string]any)
	if len(segments) != 3 || segments[0]["type"] != "reply" || segments[1]["type"] != "at" || segments[2]["type"] != "text" {
		t.Fatalf("回复段结构不符: %+v", segments)
	}
	if segments[2]["data"].(map[string]any)["text"] != "在的" {
		t.Fatalf("回复内容不符: %+v", segments[2])
	}
}

func TestGroupAllowlistFiltersOtherGroups(t *testing.T) {
	model := &fakeModel{replies: []string{"不该出现"}}
	runtime, bot, _ := newRuntime(t, nil, model)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "88888", "2001")); handled {
		t.Fatalf("非白名单群不应触发")
	}
	if len(bot.groupSent) != 0 || len(model.requests) != 0 {
		t.Fatalf("非白名单群不应产生任何调用")
	}
}

func TestPrivateMessageAlwaysTriggers(t *testing.T) {
	model := &fakeModel{replies: []string{"私聊回复"}}
	runtime, bot, _ := newRuntime(t, nil, model)
	event := map[string]any{
		"post_type":    "message",
		"message_type": "private",
		"user_id":      "2002",
		"message_id":   "m-2",
		"message":      []any{map[string]any{"type": "text", "data": map[string]any{"text": "在吗"}}},
		"sender":       map[string]any{"nickname": "路人"},
	}
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatalf("私聊应触发回复")
	}
	if len(bot.privateSent) != 1 {
		t.Fatalf("应发送一条私聊消息")
	}
}

func TestPromptIncludesPresetAndHistoryAndStoresMessages(t *testing.T) {
	model := &fakeModel{replies: []string{"第一次回复", "第二次回复"}}
	runtime, _, memory := newRuntime(t, nil, model)

	runtime.HandleEvent(buildGroupEvent("第一句", true, "99001", "2001"))
	runtime.HandleEvent(buildGroupEvent("第二句", true, "99001", "2001"))

	if len(model.requests) != 2 {
		t.Fatalf("应有两次模型调用，实际 %d", len(model.requests))
	}
	first := model.requests[0]
	// 对齐 Node 顺序：当前时间 → 会话感知(context) → 决策段(current-message-focus, order 129)
	// → 预设 preSystem → 角色卡 → 召回 → 用户消息
	if len(first) < 5 || !strings.Contains(first[0].Content.(string), "【当前时间】") {
		t.Fatalf("首条应为当前时间系统段: %+v", first[0])
	}
	if !strings.Contains(first[1].Content.(string), "【会话感知】") {
		t.Fatalf("第二段应为会话上下文: %+v", first[1])
	}
	if first[2].Role != "system" || !strings.Contains(first[2].Content.(string), "测试角色") {
		t.Fatalf("第三段应为预设 preSystem: %+v", first[2])
	}
	if !strings.Contains(first[3].Content.(string), "<current-message-focus>") {
		t.Fatalf("第四段应为当前消息决策段（preSystem 之后，对齐 order 129）: %+v", first[3])
	}
	if !strings.Contains(first[4].Content.(string), "第一句") || !strings.Contains(first[4].Content.(string), "isAtBot:true") {
		t.Fatalf("用户消息缺少结构化头或正文: %v", first[4].Content)
	}
	second := model.requests[1]
	if len(second) < 3 {
		t.Fatalf("第二轮应带上历史消息，实际 %d 条", len(second))
	}
	foundHistory := false
	duplicated := false
	for _, message := range second {
		if text, ok := message.Content.(string); ok && strings.Contains(text, "第一句") {
			foundHistory = true
		}
	}
	for _, message := range second[1:] {
		if text, ok := message.Content.(string); ok && strings.Contains(text, "第二句") {
			duplicated = true
		}
	}
	if !foundHistory {
		t.Fatalf("历史消息未进入第二轮上下文")
	}
	if !duplicated {
		t.Fatalf("当前消息应出现在上下文中")
	}

	counts, err := memory.Counts()
	if err != nil {
		t.Fatalf("统计失败: %v", err)
	}
	if counts.Sessions != 1 || counts.Messages != 4 {
		t.Fatalf("消息落库不符（2 入 2 出应为 4 条）: %+v", counts)
	}
	sessions, err := memory.ListSessions(5)
	if err != nil || len(sessions) != 1 {
		t.Fatalf("会话记录缺失: %v %+v", err, sessions)
	}
	if sessions[0].ID != "user:2001" {
		t.Fatalf("会话键不符（user_persistent 模式）: %s", sessions[0].ID)
	}
}

func TestSessionKeysPerMode(t *testing.T) {
	cases := []struct {
		mode     string
		expected map[string]string
	}{
		{"user_persistent", map[string]string{"group": "user:2001", "private": "user:2001"}},
		{"group_shared", map[string]string{"group": "group:99001", "private": "private:2001"}},
		{"group_user", map[string]string{"group": "group_user:99001:2001", "private": "private:2001"}},
		{"global_shared", map[string]string{"group": "global_shared_memory", "private": "global_shared_memory"}},
	}
	for _, item := range cases {
		model := &fakeModel{replies: []string{"ok"}}
		runtime, _, _ := newRuntime(t, map[string]any{
			"chat": map[string]any{"sessionMode": item.mode, "requireAtInGroup": true, "allowedGroups": []any{"99001"}, "model": "m"},
		}, model)
		groupKey := runtime.sessionKey("group", "99001", "2001")
		privateKey := runtime.sessionKey("private", "", "2001")
		if groupKey != item.expected["group"] || privateKey != item.expected["private"] {
			t.Fatalf("%s 会话键不符: group=%s private=%s", item.mode, groupKey, privateKey)
		}
	}
}

func TestForwardRenderingIncludesTranscriptAndImages(t *testing.T) {
	model := &fakeModel{replies: []string{"读到了"}}
	runtime, bot, _ := newRuntime(t, nil, model)
	bot.forwards["fwd-1"] = map[string]any{
		"messages": []any{
			map[string]any{"sender": map[string]any{"nickname": "小明", "user_id": "3001"}, "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "看这张"}}, map[string]any{"type": "image", "data": map[string]any{"file": "a.png"}}}},
			map[string]any{"sender": map[string]any{"nickname": "小红", "user_id": "3002"}, "message": []any{map[string]any{"type": "image", "data": map[string]any{"file": "b.png"}}}},
		},
	}
	event := buildGroupEvent("看看", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "forward", "data": map[string]any{"id": "fwd-1"}})

	if handled := runtime.HandleEvent(event); !handled {
		t.Fatalf("含合并转发的消息应触发")
	}
	request := model.requests[0]
	last := request[len(request)-1].Content.(string)
	if !strings.Contains(last, "[合并转发聊天记录|共2条|含图片2张]") {
		t.Fatalf("转发转写头部不符: %s", last)
	}
	if !strings.Contains(last, "1. 小明") || !strings.Contains(last, "2. 小红") {
		t.Fatalf("转发内容缺少成员与顺序: %s", last)
	}
}

// 召回段与角色段需进入系统提示（对齐 Node prompt.js 的 database_recall / character_description）。
func TestPromptIncludesRecallAndCharacterSegments(t *testing.T) {
	model := &fakeModel{replies: []string{"好"}}
	runtime, _, memory := newRuntime(t, nil, model)

	// 预置记忆：固定知识 + 日常记忆
	namespace := store.NamespaceOptions{
		ScopeType:     "user_persistent",
		ScopeKey:      "user:2001",
		CharacterName: "",
	}
	if _, err := memory.AddMemoryEntry(namespace, store.MemoryEntry{
		ID: "k1", EntryType: "knowledge_fixed", Title: "门派规则", Content: "徐缺是炸天帮掌门",
	}); err != nil {
		t.Fatalf("写入固定知识失败: %v", err)
	}
	if _, err := memory.AddMemoryEntry(namespace, store.MemoryEntry{
		ID: "m1", EntryType: "conversation", Title: "旧对话", Content: "用户: 徐缺你还记得吗",
	}); err != nil {
		t.Fatalf("写入记忆失败: %v", err)
	}

	runtime.HandleEvent(buildGroupEvent("徐缺你还记得吗", true, "99001", "2001"))
	if len(model.requests) == 0 {
		t.Fatalf("未触发模型调用")
	}
	joined := ""
	for _, message := range model.requests[0] {
		if text, ok := message.Content.(string); ok {
			joined += text + "\n"
		}
	}
	if !strings.Contains(joined, "【数据库召回】") {
		t.Fatalf("系统提示缺少数据库召回段:\n%s", joined)
	}
	if !strings.Contains(joined, "【固定知识】") || !strings.Contains(joined, "徐缺是炸天帮掌门") {
		t.Fatalf("召回段缺少固定知识内容:\n%s", joined)
	}
	if !strings.Contains(joined, "[fixed_knowledge]") {
		t.Fatalf("召回段缺少召回原因标记:\n%s", joined)
	}
}
