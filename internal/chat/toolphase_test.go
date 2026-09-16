package chat

import (
	"context"
	"errors"
	"strings"
	"testing"

	"mimirlink/internal/ai"
	"mimirlink/internal/tools"
)

// scriptedToolModel 按请求特征回放：工具阶段 → 工具调用；提及生成/正式回复按标记词返回。
type scriptedToolModel struct {
	requests  []scriptedRequest
	toolCalls int
	failTools bool
	failedOne bool
}

type scriptedRequest struct {
	messages  []ai.Message
	overrides map[string]any
}

func (m *scriptedToolModel) Chat(ctx context.Context, messages []ai.Message, overrides map[string]any) (*ai.ChatResult, error) {
	m.requests = append(m.requests, scriptedRequest{messages: messages, overrides: overrides})
	text := flattenMessages(messages)
	hasTools := overrides != nil && overrides["tools"] != nil
	switch {
	case hasTools && m.failTools && !m.failedOne:
		m.failedOne = true
		return nil, errors.New("工具阶段模型不可用")
	case hasTools && m.toolCalls == 0:
		m.toolCalls++
		call := ai.ToolCall{ID: "call-1"}
		call.Function.Name = "send_group_mention"
		call.Function.Arguments = `{"prompt":"提醒他交作业"}`
		return &ai.ChatResult{ToolCalls: []ai.ToolCall{call}}, nil
	case hasTools:
		return &ai.ChatResult{Content: "工具阶段收尾"}, nil
	case strings.Contains(text, "当前任务不是继续普通对话"):
		return &ai.ChatResult{Content: "作业写完了吗？"}, nil
	case strings.Contains(text, "【本轮工具执行结果】"):
		return &ai.ChatResult{Content: "已提醒他交作业。"}, nil
	default:
		return &ai.ChatResult{Content: "普通回复"}, nil
	}
}

// flattenMessages 把所有消息正文拼成一段文本，供桩模型做特征判断。
func flattenMessages(messages []ai.Message) string {
	parts := []string{}
	for _, message := range messages {
		switch content := message.Content.(type) {
		case string:
			parts = append(parts, content)
		case []any:
			for _, item := range content {
				entry, _ := item.(map[string]any)
				if entry == nil {
					continue
				}
				if text, ok := entry["text"].(string); ok {
					parts = append(parts, text)
				}
			}
		}
	}
	return strings.Join(parts, "\n")
}

func containsText(messages []ai.Message, expected string) bool {
	return strings.Contains(flattenMessages(messages), expected)
}

// TestToolPhaseEnabledDefault：开关缺省为开，显式 false 才关。
func TestToolPhaseEnabledDefault(t *testing.T) {
	model := &scriptedToolModel{}
	runtime, _, _ := newRuntime(t, nil, nil)
	runtime.ai = model
	if !runtime.toolPhaseEnabled() {
		t.Fatalf("缺省应开启两阶段")
	}
	document, _ := buildDocument(t, map[string]any{
		"chat": map[string]any{"toolPhase": map[string]any{"enabled": false}},
	})
	runtime.document = document
	if runtime.toolPhaseEnabled() {
		t.Fatalf("显式 false 应关闭两阶段")
	}
}

// TestToolPhaseMaxResultChars：默认 4000，越界收敛到 200~50000。
func TestToolPhaseMaxResultChars(t *testing.T) {
	runtime, _, _ := newRuntime(t, nil, nil)
	if value := runtime.toolPhaseMaxResultChars(); value != 4000 {
		t.Fatalf("默认应为 4000，实际 %d", value)
	}
	document, _ := buildDocument(t, map[string]any{
		"chat": map[string]any{"toolPhase": map[string]any{"maxResultChars": 10}},
	})
	runtime.document = document
	if value := runtime.toolPhaseMaxResultChars(); value != 200 {
		t.Fatalf("过小应收敛到 200，实际 %d", value)
	}
}

// TestBuildToolPhaseMessages：去掉全部 system 段与末尾 assistant 预填，只留工具说明 + 对话段。
func TestBuildToolPhaseMessages(t *testing.T) {
	messages := []ai.Message{
		{Role: "system", Content: "你是测试角色"},
		{Role: "user", Content: "帮我查一下"},
		{Role: "assistant", Content: "预填开头"},
	}
	phase := BuildToolPhaseMessages(messages, []string{"【工具使用总则】\n- 规则"}, "", "")
	if len(phase) != 2 {
		t.Fatalf("应保留 2 条（说明+用户），实际 %d", len(phase))
	}
	if phase[0].Role != "system" || !strings.Contains(phase[0].Content.(string), "【工具使用说明】") {
		t.Fatalf("首条应为工具说明: %v", phase[0])
	}
	if flattenMessages(phase) != phase[0].Content.(string)+"\n帮我查一下" {
		t.Fatalf("对话段不符: %s", flattenMessages(phase))
	}
	if strings.Contains(flattenMessages(phase), "你是测试角色") || strings.Contains(flattenMessages(phase), "预填开头") {
		t.Fatalf("不应带人设或预填: %s", flattenMessages(phase))
	}
	// 无说明时只留对话段
	plain := BuildToolPhaseMessages(messages, nil, "", "")
	if len(plain) != 1 || plain[0].Role != "user" {
		t.Fatalf("无说明时应只剩用户段: %v", plain)
	}
}

// TestBuildToolPhaseResultMessage：结果段格式与截断。
func TestBuildToolPhaseResultMessage(t *testing.T) {
	if message := buildToolPhaseResultMessage(nil, 4000); message != "" {
		t.Fatalf("无调用时不应有结果段: %s", message)
	}
	transcript := []toolTranscriptEntry{
		{Name: "web_search", Arguments: `{"query":"天气"}`, OK: true, Result: strings.Repeat("结", 50), DurationMs: 12},
		{Name: "web_fetch", Arguments: "", OK: false, Result: "工具执行失败：超时", DurationMs: 30},
	}
	message := buildToolPhaseResultMessage(transcript, 20)
	if !strings.Contains(message, "【本轮工具执行结果】") || !strings.Contains(message, "1. web_search｜参数: query=天气｜状态: 完成") {
		t.Fatalf("结果段头部不符: %s", message)
	}
	if !strings.Contains(message, "2. web_fetch｜参数: 无｜状态: 失败") {
		t.Fatalf("失败条目不符: %s", message)
	}
	if !strings.Contains(message, strings.Repeat("结", 20)+"…") || strings.Contains(message, strings.Repeat("结", 21)) {
		t.Fatalf("结果应按 20 字截断: %s", message)
	}
}

// TestInsertToolPhaseResult：预填前插入，否则追加末尾。
func TestInsertToolPhaseResult(t *testing.T) {
	withPrefill := insertToolPhaseResult([]ai.Message{
		{Role: "user", Content: "hi"},
		{Role: "assistant", Content: "预填"},
	}, "结果")
	if len(withPrefill) != 3 || withPrefill[1].Role != "system" || withPrefill[2].Role != "assistant" {
		t.Fatalf("应插在预填之前: %v", withPrefill)
	}
	withoutPrefill := insertToolPhaseResult([]ai.Message{{Role: "user", Content: "hi"}}, "结果")
	if len(withoutPrefill) != 2 || withoutPrefill[1].Role != "system" {
		t.Fatalf("应追加到末尾: %v", withoutPrefill)
	}
}

func mentionRuntime(t *testing.T, model *scriptedToolModel) (*Runtime, *fakeBot) {
	t.Helper()
	runtime, bot, _ := newRuntime(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"sendMention": map[string]any{"enabled": true}}},
	}, nil)
	runtime.ai = model
	runtime.tools = tools.New(runtime.document, nil, runtime.logger)
	return runtime, bot
}

// TestGenerateReplyTwoPhase：阶段一无人设+带工具；提及生成带人设；阶段二带结果段且不下发工具。
func TestGenerateReplyTwoPhase(t *testing.T) {
	model := &scriptedToolModel{}
	runtime, bot := mentionRuntime(t, model)
	scope := runtime.toolCallScope("group_99001", "group", "帮我提醒他交作业", InjectionRisk{}, "99001", "2001", "测试员")
	messages := []ai.Message{
		{Role: "system", Content: "你是测试角色，回答要简短。"},
		{Role: "user", Content: "帮我提醒他交作业"},
	}
	reply, finalMessages, err := runtime.generateReply(context.Background(), messages, scope, "group:99001")
	if err != nil {
		t.Fatalf("两阶段执行失败: %v", err)
	}
	if strings.TrimSpace(reply) != "已提醒他交作业。" {
		t.Fatalf("正式回复不符: %q", reply)
	}
	if len(model.requests) != 4 {
		t.Fatalf("应有 4 次模型请求（工具阶段×2+提及生成+正式回复），实际 %d", len(model.requests))
	}

	phaseOne := model.requests[0]
	if phaseOne.overrides == nil || phaseOne.overrides["tools"] == nil {
		t.Fatalf("阶段一应带工具定义")
	}
	if containsText(phaseOne.messages, "你是测试角色") {
		t.Fatalf("阶段一不应带人设: %s", flattenMessages(phaseOne.messages))
	}
	if !containsText(phaseOne.messages, "【工具使用说明】") {
		t.Fatalf("阶段一应带工具说明")
	}

	// 工具执行发生在阶段一循环内：请求序为 工具调用 → 提及生成 → 工具阶段收尾 → 正式回复
	mentionRequest := model.requests[1]
	if mentionRequest.overrides != nil {
		t.Fatalf("提及生成不应带工具覆盖")
	}
	if !containsText(mentionRequest.messages, "当前任务不是继续普通对话") {
		t.Fatalf("提及生成应带任务文本: %s", flattenMessages(mentionRequest.messages))
	}
	if !containsText(mentionRequest.messages, "你是测试角色") {
		t.Fatalf("提及生成应使用完整人设: %s", flattenMessages(mentionRequest.messages))
	}

	phaseTwo := model.requests[3]
	if phaseTwo.overrides != nil {
		t.Fatalf("阶段二不应带工具覆盖")
	}
	if !containsText(phaseTwo.messages, "你是测试角色") || !containsText(phaseTwo.messages, "【本轮工具执行结果】") {
		t.Fatalf("阶段二应带人设与工具结果: %s", flattenMessages(phaseTwo.messages))
	}
	if !containsText(phaseTwo.messages, "send_group_mention") || !containsText(finalMessages, "generatedMessage") {
		t.Fatalf("结果段应含工具转写与生成正文")
	}

	if len(bot.groupSent) != 1 {
		t.Fatalf("应真实发送 1 条主动 @，实际 %d", len(bot.groupSent))
	}
	if bot.groupSent[0]["groupID"] != "99001" {
		t.Fatalf("发送群号不符: %v", bot.groupSent[0]["groupID"])
	}
	segments, ok := bot.groupSent[0]["message"].([]map[string]any)
	if !ok || len(segments) != 2 {
		t.Fatalf("主动 @ 应为 [at,text] 两段: %#v", bot.groupSent[0]["message"])
	}
	if segments[0]["type"] != "at" || segments[0]["data"].(map[string]any)["qq"] != "2001" {
		t.Fatalf("at 段不符: %#v", segments[0])
	}
	if segments[1]["data"].(map[string]any)["text"] != " 作业写完了吗？" {
		t.Fatalf("正文段不符: %#v", segments[1])
	}
}

// TestGenerateReplyFallback：工具阶段失败时回退单阶段（工具说明置顶 + 带工具）。
func TestGenerateReplyFallback(t *testing.T) {
	model := &scriptedToolModel{failTools: true}
	runtime, _ := mentionRuntime(t, model)
	scope := runtime.toolCallScope("group_99001", "group", "帮我提醒他交作业", InjectionRisk{}, "99001", "2001", "测试员")
	messages := []ai.Message{
		{Role: "system", Content: "你是测试角色，回答要简短。"},
		{Role: "user", Content: "帮我提醒他交作业"},
	}
	reply, _, err := runtime.generateReply(context.Background(), messages, scope, "group:99001")
	if err != nil {
		t.Fatalf("回退后不应报错: %v", err)
	}
	if strings.TrimSpace(reply) != "工具阶段收尾" {
		t.Fatalf("回退回复不符: %q", reply)
	}
	// 回退单阶段仍走完整工具循环：失败阶段一(1) + 工具调用(2) + 提及生成(3) + 收尾(4)
	if len(model.requests) != 4 {
		t.Fatalf("应有 4 次请求，实际 %d", len(model.requests))
	}
	fallback := model.requests[1]
	if fallback.overrides == nil || fallback.overrides["tools"] == nil {
		t.Fatalf("回退单阶段应带工具")
	}
	if len(fallback.messages) == 0 || fallback.messages[0].Role != "system" || !strings.HasPrefix(fallback.messages[0].Content.(string), "【工具使用说明】") {
		t.Fatalf("回退时应把工具说明置顶: %v", fallback.messages)
	}
	if !containsText(fallback.messages, "你是测试角色") {
		t.Fatalf("回退单阶段应保留人设")
	}
}

// TestBuildToolPhaseScene：只提取轻量场景信息（角色名/会话/发言人/近期发言人），不带重提示词。
func TestBuildToolPhaseScene(t *testing.T) {
	scene := BuildToolPhaseScene([]ai.Message{
		{Role: "system", Content: "人设卡+世界书+记忆（重提示词）"},
		{Role: "user", Content: "[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:2026/9/16 17:20:24|eventType:message|isAtBot:false] 早上好"},
		{Role: "assistant", Content: "早"},
		{Role: "user", Content: "[群聊|QQ:222|昵称:阿乙|群号:99001|群名:测试群|时间:2026/9/16 17:21:24|eventType:message|isAtBot:false] 犬皇在吗"},
		{Role: "user", Content: "[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:2026/9/16 17:22:24|eventType:message|isAtBot:true] 帮我@一下"},
	}, "测试角色", "group:99001")
	for _, expected := range []string{
		"【当前场景】",
		"你正在以角色「测试角色」参与这次对话",
		"当前会话: 群聊「测试群」(99001)",
		"当前发言人: 阿甲(111)",
		"近期发言人: 阿乙(222)、阿甲(111)",
	} {
		if !strings.Contains(scene, expected) {
			t.Fatalf("场景卡缺少 %q:\n%s", expected, scene)
		}
	}
	if strings.Contains(scene, "人设卡") {
		t.Fatalf("场景卡不应带重提示词: %s", scene)
	}
}

// TestBuildToolPhaseScenePrivateAndEmpty：私聊标签与空场景。
func TestBuildToolPhaseScenePrivateAndEmpty(t *testing.T) {
	scene := BuildToolPhaseScene([]ai.Message{
		{Role: "user", Content: "[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 你好"},
	}, "", "private:333")
	if !strings.Contains(scene, "当前会话: 私聊 QQ:333") || !strings.Contains(scene, "当前发言人: 阿丙(333)") {
		t.Fatalf("私聊场景不符: %s", scene)
	}
	if scene := BuildToolPhaseScene([]ai.Message{{Role: "user", Content: "你好"}}, "", ""); scene != "" {
		t.Fatalf("无信息时应为空: %s", scene)
	}
	if scene := BuildToolPhaseScene(nil, "", ""); scene != "" {
		t.Fatalf("空消息应为空: %s", scene)
	}
}

// TestBuildToolPhaseMessagesWithScene：场景卡排在工具说明之前，人设段不进入工具阶段。
func TestBuildToolPhaseMessagesWithScene(t *testing.T) {
	phase := BuildToolPhaseMessages([]ai.Message{
		{Role: "system", Content: "人设卡"},
		{Role: "user", Content: "[群聊|QQ:111|昵称:阿甲|群号:99001|群名:测试群|时间:x] 帮我@一下"},
	}, []string{"【工具使用总则】"}, "测试角色", "group:99001")
	if len(phase) != 3 {
		t.Fatalf("应为 场景卡+工具说明+用户 三条，实际 %d", len(phase))
	}
	if !strings.HasPrefix(phase[0].Content.(string), "【当前场景】") || !strings.HasPrefix(phase[1].Content.(string), "【工具使用说明】") {
		t.Fatalf("顺序不符: %v / %v", phase[0].Content, phase[1].Content)
	}
	if strings.Contains(flattenMessages(phase), "人设卡") {
		t.Fatalf("不应带人设")
	}
}

// TestBuildToolPhaseScenePrefersRealGroupName：当前事件头群名 N/A 时，优先用历史里的真名。
func TestBuildToolPhaseScenePrefersRealGroupName(t *testing.T) {
	scene := BuildToolPhaseScene([]ai.Message{
		{Role: "user", Content: "[群聊|QQ:111|昵称:阿甲|群号:99001|群名:真名群|时间:x] 早上好"},
		{Role: "user", Content: "[群聊|QQ:222|昵称:阿乙|群号:99001|群名:N/A|时间:x] 在吗"},
	}, "", "group:99001")
	if !strings.Contains(scene, "当前会话: 群聊「真名群」(99001)") {
		t.Fatalf("应优先使用历史真群名: %s", scene)
	}
}

// TestBuildToolPhaseScenePrivate：私聊不出“近期发言人”，只保留当前发言人。
func TestBuildToolPhaseScenePrivate(t *testing.T) {
	scene := BuildToolPhaseScene([]ai.Message{
		{Role: "user", Content: "[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 早上好"},
		{Role: "user", Content: "[私聊|QQ:333|昵称:阿丙|群号:N/A|群名:N/A|时间:x] 在吗"},
	}, "", "private:333")
	if strings.Contains(scene, "近期发言人") {
		t.Fatalf("私聊不应出现近期发言人: %s", scene)
	}
	if !strings.Contains(scene, "当前发言人: 阿丙(333)") {
		t.Fatalf("私聊应保留当前发言人: %s", scene)
	}
}

// TestBuildToolPhaseSceneFiltersOtherChats：其他群/其他人私聊的消息不进入场景卡。
func TestBuildToolPhaseSceneFiltersOtherChats(t *testing.T) {
	scene := BuildToolPhaseScene([]ai.Message{
		{Role: "user", Content: "[群聊|QQ:111|昵称:甲|群号:99001|群名:本群|时间:x] 你好"},
		{Role: "user", Content: "[群聊|QQ:222|昵称:乙|群号:88888|群名:别群|时间:x] 路过"},
		{Role: "user", Content: "[私聊|QQ:333|昵称:丙|群号:N/A|群名:N/A|时间:x] 私聊消息"},
		{Role: "user", Content: "[群聊|QQ:444|昵称:丁|群号:99001|群名:本群|时间:x] 在吗"},
	}, "", "group:99001")
	if strings.Contains(scene, "乙") || strings.Contains(scene, "丙") {
		t.Fatalf("其他聊天的人不应出现: %s", scene)
	}
	if !strings.Contains(scene, "甲(111)") || !strings.Contains(scene, "丁(444)") {
		t.Fatalf("本群成员应保留: %s", scene)
	}
}
