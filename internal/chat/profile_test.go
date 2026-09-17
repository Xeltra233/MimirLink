package chat

import (
	"strings"
	"testing"
	"time"

	"mimirlink/internal/store"
)

// TestProfileSettingsNormalize 校验配置解析默认值与枚举归一（对齐 Node getParticipantProfileConfig）。
func TestProfileSettingsNormalize(t *testing.T) {
	runtime, _, _ := newRuntime(t, map[string]any{
		"memory": map[string]any{
			"participantProfile": map[string]any{
				"enabled":                 true,
				"triggerMessages":         0,
				"maxSourceMessages":       -3,
				"idleMs":                  0,
				"intervalMs":              0,
				"triggerMode":             "BOTH",
				"analysisMode":            "MESSAGES_ONLY",
				"retryOnError":            false,
				"blacklistParticipantIds": []any{"111", " 111 ", "222"},
			},
		},
	}, &fakeModel{})

	settings := runtime.profileSettings()
	if !settings.Enabled {
		t.Fatal("enabled 应为 true")
	}
	if settings.Threshold != 8 {
		t.Fatalf("triggerMessages 默认应为 8，实际 %d", settings.Threshold)
	}
	if settings.SourceLimit != 50 {
		t.Fatalf("maxSourceMessages 默认应为 50，实际 %d", settings.SourceLimit)
	}
	if settings.IdleMs != 120000 || settings.IntervalMs != 300000 {
		t.Fatalf("idleMs/intervalMs 默认值异常: %d/%d", settings.IdleMs, settings.IntervalMs)
	}
	if settings.TriggerMode != "both" {
		t.Fatalf("triggerMode 归一失败: %s", settings.TriggerMode)
	}
	if settings.AnalysisMode != "messages_only" {
		t.Fatalf("analysisMode 归一失败: %s", settings.AnalysisMode)
	}
	if settings.RetryOnError {
		t.Fatal("retryOnError 显式 false 应生效")
	}
	if !settings.Blacklist["111"] || !settings.Blacklist["222"] {
		t.Fatalf("黑名单解析失败: %+v", settings.Blacklist)
	}
}

// TestProfileSettingsDefaults 校验未配置时的默认：默认 idle、bot_only_profile。
func TestProfileSettingsDefaults(t *testing.T) {
	runtime, _, _ := newRuntime(t, map[string]any{}, &fakeModel{})
	settings := runtime.profileSettings()
	if settings.TriggerMode != "idle" {
		t.Fatalf("默认 triggerMode 应为 idle，实际 %s", settings.TriggerMode)
	}
	if settings.AnalysisMode != "bot_only_profile" {
		t.Fatalf("默认 analysisMode 应为 bot_only_profile，实际 %s", settings.AnalysisMode)
	}
	if !settings.RetryOnError {
		t.Fatal("默认 retryOnError 应为 true")
	}
}

// TestBuildProfilePromptModes 校验 4 种分析模式的提示词形状（对齐 Node buildParticipantProfilePrompt）。
func TestBuildProfilePromptModes(t *testing.T) {
	source := &store.ProfileSource{
		Messages: []store.Message{
			{SessionID: "s1", Role: "user", Content: "今天好累", MetadataJSON: `{"userId":"2001"}`},
			{SessionID: "s1", Role: "assistant", Content: "要不要休息一下"},
			{SessionID: "s1", Role: "user", Content: "路人发言", MetadataJSON: `{"userId":"2002"}`},
		},
		Existing:         &store.MemoryEntry{ID: "e1", Content: "旧档案内容"},
		HasEnoughNewInfo: true,
	}
	identity := profileIdentity{ParticipantID: "2001", ParticipantName: "张三"}

	botOnly := buildProfilePrompt(source, "bot_only_profile", identity)
	if !strings.Contains(botOnly, "增量更新人物档案") {
		t.Fatalf("bot_only_profile 应为增量更新: %s", botOnly)
	}
	if !strings.Contains(botOnly, "已有档案如下：") || !strings.Contains(botOnly, "旧档案内容") {
		t.Fatalf("非 messages_only 模式应包含旧档案: %s", botOnly)
	}
	if !strings.Contains(botOnly, "目标人物|张三|QQ:2001") {
		t.Fatalf("目标人物标签缺失: %s", botOnly)
	}
	if !strings.Contains(botOnly, "说话人:Bot") {
		t.Fatalf("Bot 标签缺失: %s", botOnly)
	}
	if !strings.Contains(botOnly, "其他用户|2002|QQ:2002") {
		t.Fatalf("第三者标签缺失: %s", botOnly)
	}
	if !strings.Contains(botOnly, "输出格式：") {
		t.Fatalf("输出格式段缺失: %s", botOnly)
	}

	messagesOnly := buildProfilePrompt(source, "messages_only", identity)
	if !strings.Contains(messagesOnly, "更新人物档案") || strings.Contains(messagesOnly, "增量更新") {
		t.Fatalf("messages_only 应为更新（无“增量”）: %s", messagesOnly)
	}
	if strings.Contains(messagesOnly, "已有档案如下：") {
		t.Fatalf("messages_only 不应包含旧档案段: %s", messagesOnly)
	}

	merge := buildProfileMergePrompt(profileMergeRequest{
		ParticipantID: "2001", ParticipantName: "张三", OldProfile: "旧", NewProfile: "新",
	})
	if !strings.Contains(merge, "请合并同一个 QQ 用户的人物档案") || !strings.Contains(merge, "旧档案：") || !strings.Contains(merge, "新版本：") {
		t.Fatalf("合并提示词形状异常: %s", merge)
	}
}

// TestProviderErrorLikeReply 校验上游错误识别（对齐 Node isProviderErrorLikeReply）。
func TestProviderErrorLikeReply(t *testing.T) {
	cases := []struct {
		text string
		want bool
	}{
		{"[Upstream Error] something", true},
		{"Rate limited, please retry", true},
		{"too many requests", true},
		{"please try again in a minute", true},
		{"quota exceeded", true},
		{"正常档案内容：张三喜欢聊天气", false},
		{"", false},
	}
	for _, item := range cases {
		if got := isProviderErrorLikeReply(item.text); got != item.want {
			t.Fatalf("isProviderErrorLikeReply(%q) = %v, want %v", item.text, got, item.want)
		}
	}
}

// TestScheduleIdleProfileBuild 校验 idle 定时触发（对齐 Node scheduleParticipantProfileUpdate）。
func TestScheduleIdleProfileBuild(t *testing.T) {
	model := &fakeModel{replies: []string{"回复1"}, profileReply: "档案正文：张三"}
	runtime, _, memory := newRuntime(t, map[string]any{
		"memory": map[string]any{
			"participantProfile": map[string]any{"enabled": true, "triggerMessages": 1, "idleMs": 80},
		},
	}, model)
	runtime.HandleEvent(buildGroupEvent("第一句", true, "99001", "2001"))

	deadline := time.Now().Add(5 * time.Second)
	var entry *store.MemoryEntry
	for time.Now().Before(deadline) {
		result, err := memory.GetParticipantProfileEntry(runtime.namespaceOptions(runtime.sessionKey("group", "99001", "2001")), "2001")
		if err == nil && result != nil {
			entry = result
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if entry == nil {
		t.Fatalf("idle 触发未落库；进度=%+v", runtime.ProfileProgressSnapshot())
	}
	if !strings.Contains(entry.Content, "档案正文") {
		t.Fatalf("档案内容异常: %q", entry.Content)
	}
	if entry.Metadata["triggeredBy"] != "idle" {
		t.Fatalf("triggeredBy 应为 idle: %+v", entry.Metadata["triggeredBy"])
	}
	if entry.Metadata["analysisMode"] != "bot_only_profile" {
		t.Fatalf("analysisMode 应为 bot_only_profile: %+v", entry.Metadata["analysisMode"])
	}
	progress := runtime.ProfileProgressSnapshot()
	if progress["stage"] != "completed" {
		t.Fatalf("进度阶段应为 completed: %+v", progress["stage"])
	}
	if tasks, ok := progress["tasks"].([]any); !ok || len(tasks) == 0 {
		t.Fatalf("任务列表应存在: %+v", progress["tasks"])
	}
}

// TestProfileIntervalTrigger 校验 interval 触发（对齐 Node participantProfileIntervalTimer）。
func TestProfileIntervalTrigger(t *testing.T) {
	model := &fakeModel{replies: []string{"回复1"}, profileReply: "档案正文：定时"}
	runtime, _, memory := newRuntime(t, map[string]any{
		"memory": map[string]any{
			"participantProfile": map[string]any{
				"enabled": true, "triggerMessages": 1, "triggerMode": "interval", "intervalMs": 60,
			},
		},
	}, model)
	// interval 模式不建 idle 定时器：HandleEvent 只登记目标
	runtime.HandleEvent(buildGroupEvent("第一句", true, "99001", "2001"))
	// 通过巡检通道触发一次
	runtime.runProfileIntervalPass()

	deadline := time.Now().Add(5 * time.Second)
	var entry *store.MemoryEntry
	for time.Now().Before(deadline) {
		result, err := memory.GetParticipantProfileEntry(runtime.namespaceOptions(runtime.sessionKey("group", "99001", "2001")), "2001")
		if err == nil && result != nil {
			entry = result
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if entry == nil {
		t.Fatalf("interval 触发未落库；进度=%+v", runtime.ProfileProgressSnapshot())
	}
	if entry.Metadata["triggeredBy"] != "interval" {
		t.Fatalf("triggeredBy 应为 interval: %+v", entry.Metadata["triggeredBy"])
	}
}

// TestThinkingNotify 校验思考超时提示（对齐 Node chat.thinkingNotify）。
func TestThinkingNotify(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"thinkingNotify": map[string]any{"enabled": true, "delaySec": 1, "message": "还在想"},
		},
	}, &fakeModel{})
	event := buildGroupEvent("在吗", true, "99001", "2001")
	timer := runtime.startThinkingNotify(event, "group", "99001", "2001")
	if timer == nil {
		t.Fatal("启用时定时器不应为 nil")
	}
	timer.Stop()

	// 直接触发发送逻辑
	runtime.sendQuotedStatus(event, "group", "99001", "2001", "还在想")
	if len(bot.groupSent) == 0 {
		t.Fatal("状态提示未发送")
	}
	last := bot.groupSent[len(bot.groupSent)-1]
	if last["groupID"] != "99001" {
		t.Fatalf("应发送到目标群: %+v", last)
	}
	segments, _ := last["message"].([]map[string]any)
	if len(segments) < 2 || segments[0]["type"] != "reply" {
		t.Fatalf("状态提示应包含引用段: %+v", segments)
	}

	// 关闭开关后不启动
	runtime2, _, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{"thinkingNotify": map[string]any{"enabled": false}},
	}, &fakeModel{})
	if got := runtime2.startThinkingNotify(buildGroupEvent("在吗", true, "99001", "2001"), "group", "99001", "2001"); got != nil {
		t.Fatal("关闭时不应启动定时器")
	}
}

// TestObservationSnapshots 校验 lastRecall 与注入观测快照（对齐 Node lastRecallSnapshot / observation）。
func TestObservationSnapshots(t *testing.T) {
	runtime, _, memory := newRuntime(t, map[string]any{}, &fakeModel{})
	if _, err := memory.AddMemoryEntry(runtime.namespaceOptions(runtime.sessionKey("group", "99001", "2001")), store.MemoryEntry{
		EntryType: "knowledge_fixed", Title: "门派规则", Content: "徐缺是炸天帮掌门", Tags: []string{"门派"},
	}); err != nil {
		t.Fatalf("写入知识失败: %v", err)
	}
	event := buildGroupEvent("徐缺你还记得吗", true, "99001", "2001")
	runtime.HandleEvent(event)

	recall := runtime.LastRecallSnapshot()
	if recall == nil {
		t.Fatal("lastRecall 快照缺失")
	}
	if hits, ok := recall["hits"].([]map[string]any); !ok || len(hits) == 0 {
		t.Fatalf("lastRecall 命中应为非空: %+v", recall)
	}
	observation := runtime.LastInjectionObservation()
	if observation == nil {
		t.Fatal("注入观测缺失")
	}
	if _, ok := observation["trusted_context"]; !ok {
		t.Fatalf("观测缺少 trusted_context: %+v", observation)
	}
	if _, ok := observation["untrusted_user_inputs"]; !ok {
		t.Fatalf("观测缺少 untrusted_user_inputs: %+v", observation)
	}
	recent := runtime.RecentInjectionObservations()
	if len(recent) == 0 {
		t.Fatal("最近观测事件缺失")
	}
	summary, _ := recent[0]["summary"].(map[string]any)
	if summary == nil || summary["sessionId"] == "" {
		t.Fatalf("观测事件形状异常: %+v", recent[0])
	}

	control := runtime.ControlStatus()
	if control["participantProfileProgress"] == nil {
		t.Fatal("ControlStatus 应包含 participantProfileProgress")
	}
	if control["dashboardMetrics"] == nil {
		t.Fatal("ControlStatus 应包含 dashboardMetrics")
	}
	if control["lastRecall"] == nil || control["lastInjectionObservation"] == nil {
		t.Fatal("ControlStatus 应包含 lastRecall 与 lastInjectionObservation")
	}
}

// TestBackfillParticipantProfilesFromHistory 校验启动补建（对齐 Node backfillParticipantProfilesFromHistory）：
// 历史消息达到阈值且无档案的参与者被强制建档，已有档案的跳过。
func TestBackfillParticipantProfilesFromHistory(t *testing.T) {
	model := &fakeModel{profileReply: "稳定画像: 补建成功\n当前状态: 正常"}
	runtime, _, memory := newRuntime(t, map[string]any{
		"chat": map[string]any{"defaultCharacter": "测试角色", "sessionMode": "global_shared"},
		"memory": map[string]any{
			"participantProfile": map[string]any{"enabled": true, "triggerMessages": 2, "retryOnError": false},
		},
	}, model)
	// 写入 3 条来自 3001 的历史消息 + bot 回复（默认 bot_only_profile 需要 bot 上下文）
	for index := 0; index < 3; index += 1 {
		if err := memory.AppendMessage(store.Message{
			ID:           "m" + itoa(index),
			SessionID:    "global_shared_memory",
			Role:         "user",
			Content:      "历史消息",
			MetadataJSON: `{"userId":"3001","groupId":"99001"}`,
			Timestamp:    int64(1000 + index*2),
			DateISO:      "2026-01-01",
		}); err != nil {
			t.Fatalf("写入历史消息失败: %v", err)
		}
		if err := memory.AppendMessage(store.Message{
			ID:        "r" + itoa(index),
			SessionID: "global_shared_memory",
			Role:      "assistant",
			Content:   "bot 回复",
			Timestamp: int64(1001 + index*2),
			DateISO:   "2026-01-01",
		}); err != nil {
			t.Fatalf("写入 bot 回复失败: %v", err)
		}
	}
	// 另一参与者只有 1 条（低于阈值）不应补建
	if err := memory.AppendMessage(store.Message{
		ID: "m9", SessionID: "global_shared_memory", Role: "user", Content: "少量",
		MetadataJSON: `{"userId":"3002"}`, Timestamp: 2000, DateISO: "2026-01-01",
	}); err != nil {
		t.Fatalf("写入历史消息失败: %v", err)
	}

	runtime.BackfillParticipantProfilesFromHistory()

	namespace := store.NamespaceOptions{ScopeType: "global_shared", ScopeKey: "global_shared_memory", CharacterName: "测试角色"}
	entry, err := memory.GetParticipantProfileEntry(namespace, "3001")
	if err != nil || entry == nil {
		t.Fatalf("达标参与者未补建档案: %v", err)
	}
	if !strings.Contains(entry.Content, "补建成功") {
		t.Fatalf("补建档案内容异常: %q", entry.Content)
	}
	if entry.Metadata["triggeredBy"] != "backfill" {
		t.Fatalf("triggeredBy 应为 backfill: %+v", entry.Metadata["triggeredBy"])
	}
	if low, _ := memory.GetParticipantProfileEntry(namespace, "3002"); low != nil {
		t.Fatal("低于阈值的参与者不应补建")
	}

	// 再跑一次：已有档案不重复补建（模型请求数不增加）
	before := len(model.requests)
	runtime.BackfillParticipantProfilesFromHistory()
	if len(model.requests) != before {
		t.Fatalf("已有档案时不应重复补建（requests %d → %d）", before, len(model.requests))
	}
}
