package chat

import (
	"fmt"
	"strings"
	"testing"
)

// TestDetectChainLeak：泄露检测（英文推理短语/代码豁免/英文请求豁免/密度阈值）。
func TestDetectChainLeak(t *testing.T) {
	// 泄露：英文推理短语
	leak := DetectChainLeak("I'm currently analyzing the user's intent and formulating a response strategy.", "", "", "你好")
	if !leak.Leaked || leak.Reason != "english-reasoning-phrase" {
		t.Fatalf("应检测到推理短语泄露: %+v", leak)
	}
	// 豁免：用户明确要求英文/代码
	if leak := DetectChainLeak("I'm analyzing your request to write English code.", "", "", "帮我用英文写 code"); leak.Leaked {
		t.Fatalf("用户要求英文/代码应豁免: %+v", leak)
	}
	// 豁免：代码型输出
	if leak := DetectChainLeak("```\nconst x = 1;\nreturn x;\n```", "", "", "写个函数"); leak.Leaked {
		t.Fatalf("代码输出应豁免: %+v", leak)
	}
	// 正常中文回复
	if leak := DetectChainLeak("今天天气不错，适合出门散步。", "", "", "天气怎么样"); leak.Leaked {
		t.Fatalf("正常中文不应报泄露: %+v", leak)
	}
	// 高英文密度 + 推理关键词
	dense := "Analyzing the context and intent of the speaker, formulating a response strategy for this conversation, evaluating the current message and the user's request carefully."
	if leak := DetectChainLeak(dense, "", "", "你好"); !leak.Leaked {
		t.Fatalf("高英文推理密度应报泄露: %+v (ratio=%.2f)", leak, englishRatio(dense))
	}
}

// TestParseVoiceTags：[voice] 标签切分（全角/半角括号、多段）。
func TestParseVoiceTags(t *testing.T) {
	parts, hasVoice := ParseVoiceTags("前置文本[voice:你好呀]中间［voice：再来一句］结尾")
	if !hasVoice || len(parts) != 5 {
		t.Fatalf("应切出 4 段: %+v", parts)
	}
	if parts[0].Type != "text" || parts[0].Content != "前置文本" {
		t.Fatalf("第一段应为文本: %+v", parts[0])
	}
	if parts[1].Type != "voice" || parts[1].Content != "你好呀" {
		t.Fatalf("第二段应为语音: %+v", parts[1])
	}
	if parts[4].Type != "text" || parts[4].Content != "结尾" {
		t.Fatalf("结尾文本异常: %+v", parts[4])
	}
	parts2, hasVoice2 := ParseVoiceTags("纯文本")
	if hasVoice2 || len(parts2) != 1 || parts2[0].Type != "text" {
		t.Fatalf("纯文本应只有一段: %+v", parts2)
	}
}

// TestBuildDebugReplyWithReasoning：思维链调试回复组装。
func TestBuildDebugReplyWithReasoning(t *testing.T) {
	if got := buildDebugReplyWithReasoning("", "正文"); got != "正文" {
		t.Fatalf("无思维链应返回正文: %q", got)
	}
	if got := buildDebugReplyWithReasoning("思考", ""); got != "【思维链】\n思考" {
		t.Fatalf("无正文应只返回思维链: %q", got)
	}
	got := buildDebugReplyWithReasoning("思考", "正文")
	if !strings.Contains(got, "【思维链】\n思考") || !strings.Contains(got, "【正文】\n正文") {
		t.Fatalf("组装异常: %q", got)
	}
}

// TestDispatchReplySplitAndPrefix：分段发送 + 首段前缀（reply+at）。
func TestDispatchReplySplitAndPrefix(t *testing.T) {
	model := &fakeModel{replies: []string{"回复"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{"segmentDelayMs": 1, "proactiveMessageIntervalMs": 1},
	}, model)
	runtime.rootDir = t.TempDir()

	event := buildGroupEvent("第一段落\n\n第二段落", true, "99001", "2001")
	config := dispatcherConfig{
		SplitMessage: true, SegmentDelayMs: 1, ProactiveIntervalMs: 1,
		QuoteReplyEnabled: true, MentionSenderOnReply: true,
	}
	if err := runtime.dispatchReply(event, "group", "99001", "2001", "第一段落\n\n第二段落", config, nil); err != nil {
		t.Fatalf("分发失败: %v", err)
	}
	if len(bot.groupSent) != 2 {
		t.Fatalf("应分两段发送: %d", len(bot.groupSent))
	}
	first := bot.groupSent[0]["message"].([]map[string]any)
	// 首段带 reply + at + text
	if first[0]["type"] != "reply" || first[1]["type"] != "at" {
		t.Fatalf("首段前缀应为 reply+at: %v", first)
	}
	second := bot.groupSent[1]["message"].([]map[string]any)
	if len(second) != 1 || second[0]["type"] != "text" {
		t.Fatalf("次段应为纯文本: %v", second)
	}
}

// TestVoiceTagWithoutTTS：TTS 未启用时 [voice] 的可读回退。
func TestVoiceTagWithoutTTS(t *testing.T) {
	model := &fakeModel{replies: []string{"回复"}}
	runtime, bot, _ := newRuntime(t, nil, model)
	runtime.rootDir = t.TempDir()
	event := buildGroupEvent("hi", true, "99001", "2001")
	config := dispatcherConfig{QuoteReplyEnabled: false, MentionSenderOnReply: false}
	if err := runtime.dispatchReply(event, "group", "99001", "2001", "[voice:你好]", config, nil); err != nil {
		t.Fatalf("分发失败: %v", err)
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("应发送一条回退文本: %d", len(bot.groupSent))
	}
	message := fmt.Sprintf("%v", bot.groupSent[0]["message"])
	if !strings.Contains(message, "语音内容：你好") || !strings.Contains(message, "未启用 TTS") {
		t.Fatalf("回退文本异常: %s", message)
	}
}

// TestSendReasoningToQQInRuntime 校验开启 sendReasoningToQQ 时回复包含思维链调试文本。
func TestSendReasoningToQQInRuntime(t *testing.T) {
	model := &fakeModel{replies: []string{"你好"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{
			"sendReasoningToQQ": true,
			"bufferWindowMs":    0,
			"replyDelayMs":     0,
		},
	}, model)
	runtime.rootDir = t.TempDir()
	event := buildGroupEvent("hello", true, "99001", "2001")
	handled := runtime.HandleEvent(event)
	if !handled {
		t.Fatal("消息应被处理")
	}
	if bot.groupSentLen() != 1 {
		t.Fatalf("应发送一条回复，实际 %d", bot.groupSentLen())
	}
	sent := bot.getGroupSent()
	text := fmt.Sprintf("%v", sent[0]["message"])
	if !strings.Contains(text, "你好") {
		t.Fatalf("发送给 QQ 的消息异常: %s", text)
	}
}
