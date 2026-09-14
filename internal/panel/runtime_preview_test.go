package panel

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"mimirlink/internal/store"
)

func decodeJSON(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	payload := map[string]any{}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("解析响应失败: %v（原文 %.200s）", err, raw)
	}
	return payload
}

// TestPromptPreviewRichShape 守护「运行时预览」不再是空壳：
// 必须返回与 Node buildChatRuntimePreview 同构的 sources/runtimeComposition/
// messageTrace/messages，前端才能渲染来源槽位与阶段。
func TestPromptPreviewRichShape(t *testing.T) {
	server, _ := newTestServer(t)
	preset := map[string]any{
		"enabled": true,
		"name":    "测试预设",
		"prompts": []any{
			map[string]any{"identifier": "main", "name": "主提示", "role": "system", "content": "你是测试角色", "enabled": true},
			map[string]any{"identifier": "post", "name": "后置", "role": "system", "content": "后置指令", "enabled": true, "injection_position": 1},
			map[string]any{"identifier": "ctx", "name": "上下文", "role": "system", "content": "上下文注入内容", "enabled": true, "injection_depth": 1},
		},
	}
	if err := server.document.Set("preset", preset); err != nil {
		t.Fatalf("写预设失败: %v", err)
	}
	t.Logf("document preset exists=%v", server.document.Get("preset").Exists())
	t.Logf("characterName=%q", server.document.String("chat.defaultCharacter"))
	t.Logf("raw=%.800s", string(server.document.Raw()))
	body := `{
		"userMessage": "当前这句",
		"characterName": "测试角色",
		"context": {"recentMessages": [
			{"role": "user", "content": "第一句", "userName": "小明"},
			{"role": "assistant", "content": "第二句", "userName": "测试角色"}
		]}
	}`
	recorder := doRequest(server, "POST", "/api/runtime/prompt-preview", body)
	if recorder.Code != 200 {
		t.Fatalf("状态码应为 200，实际 %d", recorder.Code)
	}
	payload := decodeJSON(t, recorder.Body.Bytes())
	if payload["success"] != true {
		t.Fatalf("success 应为 true: %+v", payload)
	}
	messages, _ := payload["messages"].([]any)
	if len(messages) < 3 {
		t.Fatalf("应返回完整消息链（系统段+历史+当前输入），实际 %d 条", len(messages))
	}
	sources, _ := payload["sources"].([]any)
	for _, item := range sources {
		segment, _ := item.(map[string]any)
		t.Logf("source: slot=%v stage=%v label=%v", segment["sourceSlot"], segment["stage"], segment["label"])
	}
	if len(sources) == 0 {
		t.Fatal("sources 不应为空")
	}
	composition, _ := payload["runtimeComposition"].(map[string]any)
	if composition == nil {
		t.Fatal("runtimeComposition 不应为空")
	}
	systemSegments, _ := composition["systemSegments"].([]any)
	if len(systemSegments) == 0 {
		t.Fatal("runtimeComposition.systemSegments 不应为空")
	}
	postHistory, _ := composition["postHistorySegments"].([]any)
	if len(postHistory) == 0 {
		t.Fatal("postHistory 预设应归入 runtimeComposition.postHistorySegments")
	}
	trace, _ := payload["messageTrace"].([]any)
	if len(trace) != len(messages) {
		t.Fatalf("messageTrace 应与 messages 一一对应: %d vs %d", len(trace), len(messages))
	}
	entry, _ := trace[len(trace)-1].(map[string]any)
	if slots, _ := entry["sourceSlots"].([]any); len(slots) == 0 {
		t.Fatalf("messageTrace 应带来源槽位: %+v", entry)
	}
	contextConfig, _ := payload["contextConfig"].(map[string]any)
	if contextConfig == nil || contextConfig["includeRecentUserIntent"] != true {
		t.Fatalf("contextConfig 应回传开关现状: %+v", payload["contextConfig"])
	}
}

// TestRangeTestInjectsContextAndRecall 守护靶场「上下文注入」开关真正生效：
// 开启时出现会话上下文段，关闭 includeRecentUserIntent 后用户意图段消失；
// 开启数据库召回后出现【数据库召回】段。
func TestRangeTestInjectsContextAndRecall(t *testing.T) {
	server, dataDir := newTestServer(t)
	memoryPath := filepath.Join(dataDir, "chats", "memory.sqlite")
	database, err := store.Open(memoryPath)
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := database.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := database.UpsertKnowledgeEntry(store.NamespaceOptions{
		ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: "测试角色",
	}, store.KnowledgeEntry{
		Title: "项目约定", Content: "所有回复都要用中文", KnowledgeType: "fixed",
	}); err != nil {
		t.Fatalf("写入知识失败: %v", err)
	}
	_ = database.Close()
	if err := server.document.Set("chat.sessionMode", "global_shared"); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}

	body := `{
		"userMessage": "项目约定是什么",
		"includeAIResponse": false,
		"characterName": "测试角色",
		"messageType": "group",
		"userId": "2001",
		"userName": "小明",
		"context": {"recentMessages": [
			{"role": "user", "content": "我想问个问题", "userName": "小明"},
			{"role": "assistant", "content": "请讲", "userName": "测试角色"}
		]}
	}`
	recorder := doRequest(server, "POST", "/api/prompt-range/test", body)
	if recorder.Code != 200 {
		t.Fatalf("状态码应为 200，实际 %d，响应 %.300s", recorder.Code, recorder.Body.String())
	}
	payload := decodeJSON(t, recorder.Body.Bytes())
	segments, _ := payload["segments"].([]any)
	stages := map[string]int{}
	contents := ""
	for _, item := range segments {
		segment, _ := item.(map[string]any)
		if segment == nil {
			continue
		}
		stages[textOf(segment["stage"])]++
		contents += textOf(segment["content"]) + "\n"
	}
	if stages["context"] == 0 {
		t.Fatalf("应注入会话上下文段，实际阶段分布: %+v", stages)
	}
	if stages["recall"] == 0 || !containsText(contents, "【数据库召回】") {
		t.Fatalf("应注入数据库召回段，实际阶段分布: %+v", stages)
	}
	stats, _ := payload["stats"].(map[string]any)
	if stats["memoryRecallCount"] == float64(0) {
		t.Fatalf("stats.memoryRecallCount 应反映召回情况: %+v", stats)
	}

	// 关闭「用户意图」注入后，该段应消失
	if err := server.document.Set("context.includeRecentUserIntent", false); err != nil {
		t.Fatalf("写开关失败: %v", err)
	}
	recorder = doRequest(server, "POST", "/api/prompt-range/test", body)
	payload = decodeJSON(t, recorder.Body.Bytes())
	segments, _ = payload["segments"].([]any)
	for _, item := range segments {
		segment, _ := item.(map[string]any)
		if segment != nil && containsText(textOf(segment["content"]), "【用户意图】") {
			t.Fatal("关闭 includeRecentUserIntent 后不应再注入用户意图段")
		}
	}

	// 整体关闭上下文注入
	if err := server.document.Set("context.enabled", false); err != nil {
		t.Fatalf("写开关失败: %v", err)
	}
	recorder = doRequest(server, "POST", "/api/prompt-range/test", body)
	payload = decodeJSON(t, recorder.Body.Bytes())
	segments, _ = payload["segments"].([]any)
	for _, item := range segments {
		segment, _ := item.(map[string]any)
		if segment != nil && textOf(segment["stage"]) == "context" {
			t.Fatal("context.enabled=false 时不应注入会话上下文段")
		}
	}
}

func containsText(haystack string, needle string) bool {
	return len(haystack) > 0 && len(needle) > 0 && (func() bool {
		for index := 0; index+len(needle) <= len(haystack); index++ {
			if haystack[index:index+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// TestRangeContextConfigOverrides 守护前端靶场「上下文注入」4 个开关真正生效：
// 请求体 contextConfig 必须覆盖 config.context.*（旧实现完全忽略）。
func TestRangeContextConfigOverrides(t *testing.T) {
	server, dataDir := newTestServer(t)
	database, err := store.Open(filepath.Join(dataDir, "chats", "memory.sqlite"))
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	if err := database.EnsureSchema(); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if _, err := database.SaveParticipantProfile(store.NamespaceOptions{
		ScopeType: "user_persistent", ScopeKey: "user_persistent:user_2001", CharacterName: "测试角色",
	}, "", "2001", "小明", "小明喜欢简短的回复", nil, nil, ""); err != nil {
		t.Fatalf("写入档案失败: %v", err)
	}
	_ = database.Close()
	if err := server.document.Set("chat.sessionMode", "user_persistent"); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}

	bodyWith := func(extra string) string {
		return `{
			"userMessage": "帮我看看",
			"characterName": "测试角色",
			"includeAIResponse": false,
			"userId": "2001",
			"userName": "小明",
			"sessionKey": "user_persistent:user_2001",
			"context": {"recentMessages": [
				{"role": "user", "content": "我更喜欢简短", "userName": "小明"}
			]}` + extra + `}`
	}

	// 全部开关打开：会话感知 + 参与者 + 画像 + 最近用户意图
	payload := decodeJSON(t, doRequest(server, "POST", "/api/prompt-range/test",
		bodyWith(`,"contextConfig":{"enabled":true,"includeSessionFacts":true,"includeParticipants":true,"includeRecentUserIntent":true},"injectProfiles":true`)).Body.Bytes())
	joined := ""
	for _, item := range payload["segments"].([]any) {
		segment, _ := item.(map[string]any)
		joined += textOf(segment["content"])
	}
	for _, expected := range []string{"【会话感知】", "【参与者】", "【当前发言人画像】", "【最近用户意图】"} {
		if !containsText(joined, expected) {
			t.Fatalf("缺少上下文段落 %s，实际内容: %.300s", expected, joined)
		}
	}
	if !containsText(joined, "小明喜欢简短的回复") {
		t.Fatalf("injectProfiles 应注入发言人画像内容")
	}

	// 全部关闭（单次覆盖）：不应出现任何上下文段落
	payload = decodeJSON(t, doRequest(server, "POST", "/api/prompt-range/test",
		bodyWith(`,"contextConfig":{"enabled":true,"includeSessionFacts":false,"includeParticipants":false,"includeRecentUserIntent":false},"injectProfiles":false`)).Body.Bytes())
	joined = ""
	for _, item := range payload["segments"].([]any) {
		segment, _ := item.(map[string]any)
		if textOf(segment["stage"]) == "context" {
			joined += textOf(segment["content"])
		}
	}
	if joined != "" {
		t.Fatalf("开关全关时不应注入上下文段落: %.200s", joined)
	}
}

// TestBotControlOfflineGuidance 守护「bot 未运行时返回可读错误」，
// 避免面板对必须由 bot 执行的动作返回假成功（goal-37 控制通道）。
func TestBotControlOfflineGuidance(t *testing.T) {
	server, _ := newTestServer(t)
	cases := []struct {
		path string
		body string
	}{
		{"/api/test/mention", `{"groupId":"99001","targetUserId":"20002","message":"hi"}`},
		{"/api/status/onebot/reconnect", `{}`},
		{"/api/participant-profiles-analyze", `{"participantId":"20002"}`},
		{"/api/participant-profiles/entry-x/analyze", `{}`},
		{"/api/participant-profiles/entry-x/refresh-name", `{}`},
	}
	for _, item := range cases {
		recorder := doRequest(server, "POST", item.path, item.body)
		payload := decodeJSON(t, recorder.Body.Bytes())
		if payload["success"] == true {
			t.Fatalf("%s 在 bot 未运行时应返回失败: %+v", item.path, payload)
		}
		message := textOf(payload["error"])
		if message == "" {
			t.Fatalf("%s 缺少可读错误信息: %+v", item.path, payload)
		}
		if !strings.Contains(message, "Bot") && !strings.Contains(message, "控制") && !strings.Contains(message, "档案") {
			t.Fatalf("%s 错误信息应说明 Bot 未运行: %s", item.path, message)
		}
	}
}
