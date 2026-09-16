package chat

import (
	"encoding/json"
	"log"
	"os"
	"testing"
	"time"

	"mimirlink/internal/store"
)

// callRecordingBot 记录 Call 调用（表情回应/戳一戳等非核心接口），其余能力复用 fakeBot。
type callRecordingBot struct {
	*fakeBot
	calls []map[string]any
}

func (b *callRecordingBot) Call(action string, params map[string]any) (json.RawMessage, error) {
	b.calls = append(b.calls, map[string]any{"action": action, "params": params})
	return json.RawMessage(`{"status":"ok","retcode":0}`), nil
}

func (b *callRecordingBot) callParams(action string) []map[string]any {
	results := []map[string]any{}
	for _, call := range b.calls {
		if call["action"] == action {
			results = append(results, call["params"].(map[string]any))
		}
	}
	return results
}

func newRuntimeForRouting(t *testing.T, overrides map[string]any, model *fakeModel, bot Bot) (*Runtime, *store.DB) {
	t.Helper()
	document, dataDir := buildDocument(t, overrides)
	memory := openMemory(t, dataDir)
	runtime := New(Options{
		Document: document,
		Memory:   memory,
		AI:       model,
		Bot:      bot,
		Logger:   log.New(os.Stdout, "[test] ", 0),
	})
	return runtime, memory
}

func routingChatConfig(extra map[string]any) map[string]any {
	config := map[string]any{
		"sessionMode":      "user_persistent",
		"requireAtInGroup": true,
		"allowedGroups":    []any{"99001"},
		"model":            "test-model",
		"bufferWindowMs":   0,
		"replyDelayMs":     0,
	}
	for key, value := range extra {
		config[key] = value
	}
	return config
}

// TestKeywordTriggerWithoutAt：triggerMode=keyword 时，关键词命中即可触发（无需 @bot）。
func TestKeywordTriggerWithoutAt(t *testing.T) {
	model := &fakeModel{replies: []string{"关键词回复"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{
			"triggerMode":     "keyword",
			"triggerKeywords": []any{"点歌"},
		}),
	}, model, bot)

	if handled := runtime.HandleEvent(buildGroupEvent("帮我点歌一首", false, "99001", "2001")); !handled {
		t.Fatal("关键词命中应触发回复（无需 @bot）")
	}
	if len(model.requests) != 1 {
		t.Fatalf("应调用模型一次，实际 %d", len(model.requests))
	}

	// 未命中关键词且未 @bot：不触发
	if handled := runtime.HandleEvent(buildGroupEvent("今天天气不错", false, "99001", "2001")); handled {
		t.Fatal("关键词未命中且未 @bot 不应触发")
	}
	// @bot 仍应触发
	if handled := runtime.HandleEvent(buildGroupEvent("今天天气不错", true, "99001", "2001")); !handled {
		t.Fatal("@bot 应触发回复")
	}
}

// TestAutoModeKeywordAlsoTriggers：auto 模式下关键词命中同样触发（对齐 Node）。
func TestAutoModeKeywordAlsoTriggers(t *testing.T) {
	model := &fakeModel{replies: []string{"收到"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"triggerKeywords": []any{"暗号"}}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("对个暗号", false, "99001", "2001")); !handled {
		t.Fatal("auto 模式关键词命中应触发")
	}
}

// TestPrefixTrigger：前缀触发模式与 auto 模式下的前缀命中。
func TestPrefixTrigger(t *testing.T) {
	model := &fakeModel{replies: []string{"前缀回复"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"triggerMode": "prefix", "triggerPrefix": "!ai"}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("!ai 讲个笑话", false, "99001", "2001")); !handled {
		t.Fatal("前缀命中应触发")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("讲个笑话", false, "99001", "2001")); handled {
		t.Fatal("前缀未命中且未 @bot 不应触发")
	}
}

// TestTriggerModeAlways：always 模式下无需 @ 也无需关键词。
func TestTriggerModeAlways(t *testing.T) {
	model := &fakeModel{replies: []string{"always"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"triggerMode": "always"}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("随便说一句", false, "99001", "2001")); !handled {
		t.Fatal("always 模式应直接触发")
	}
}

// TestAccessControlDisabled：模式为 disabled 时忽略白名单。
func TestAccessControlDisabled(t *testing.T) {
	model := &fakeModel{replies: []string{"放行"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"accessControlMode": "disabled"}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "88888", "2001")); !handled {
		t.Fatal("disabled 模式不应再按白名单拦截")
	}
}

// TestAccessControlBlocklist：blocklist 模式按用户/群拒绝。
func TestAccessControlBlocklist(t *testing.T) {
	model := &fakeModel{replies: []string{"放行"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{
			"accessControlMode": "blocklist",
			"blockedUsers":      []any{"2001"},
			"blockedGroups":     []any{"77777"},
		}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); handled {
		t.Fatal("blocklist 命中用户应拒绝")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "77777", "2002")); handled {
		t.Fatal("blocklist 命中群应拒绝")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2002")); !handled {
		t.Fatal("blocklist 未命中的用户/群应放行")
	}
}

// TestAccessControlAllowlistUsers：allowlist 模式下非空 allowedUsers 同样限制用户。
func TestAccessControlAllowlistUsers(t *testing.T) {
	model := &fakeModel{replies: []string{"放行"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"allowedUsers": []any{"2002"}}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); handled {
		t.Fatal("allowlist 未命中用户应拒绝")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2002")); !handled {
		t.Fatal("allowlist 命中用户应放行")
	}
}

// TestReplyToBotTriggers：回复 bot 的消息免 @ 触发。
func TestReplyToBotTriggers(t *testing.T) {
	model := &fakeModel{replies: []string{"接着聊"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{
		"9001": {
			"sender":  map[string]any{"user_id": "1000", "nickname": "bot"},
			"message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "bot 上一条"}}},
		},
	}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{"chat": routingChatConfig(nil)}, model, bot)

	event := buildGroupEvent("接着聊", false, "99001", "2001")
	event["message"] = []any{
		map[string]any{"type": "reply", "data": map[string]any{"id": "9001"}},
		map[string]any{"type": "text", "data": map[string]any{"text": "接着聊"}},
	}
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatal("回复 bot 的消息应触发回复（对齐 reply_to_bot）")
	}
}

// TestEmojiReactionOnAcceptedMessage：配置开启时，触发回复的消息会发 set_msg_emoji_like（数字 message_id）。
func TestEmojiReactionOnAcceptedMessage(t *testing.T) {
	model := &fakeModel{replies: []string{"在的"}}
	base := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	bot := &callRecordingBot{fakeBot: base}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"emojiReaction": true, "emojiReactionId": "289"}),
	}, model, bot)

	event := buildGroupEvent("你好", true, "99001", "2001")
	event["message_id"] = "12345"
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatal("消息应触发回复")
	}
	params := bot.callParams("set_msg_emoji_like")
	if len(params) != 1 {
		t.Fatalf("应发送一次表情回应，实际 %d", len(params))
	}
	if params[0]["message_id"] != int64(12345) {
		t.Fatalf("message_id 应为数字 12345，实际 %#v", params[0]["message_id"])
	}
	if params[0]["emoji_id"] != "289" || params[0]["emoji_type"] != "1" {
		t.Fatalf("emoji 参数不符: %#v", params[0])
	}
}

// TestEmojiReactionDisabledByDefault：默认关闭时不发表情回应。
func TestEmojiReactionDisabledByDefault(t *testing.T) {
	model := &fakeModel{replies: []string{"在的"}}
	base := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	bot := &callRecordingBot{fakeBot: base}
	runtime, _ := newRuntimeForRouting(t, map[string]any{"chat": routingChatConfig(nil)}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); !handled {
		t.Fatal("消息应触发回复")
	}
	if len(bot.callParams("set_msg_emoji_like")) != 0 {
		t.Fatal("关闭表情回应时不应发送")
	}
}

// TestLLMCommandToggle：管理员 /llm 切换并持久化 runtime.llmEnabled。
func TestLLMCommandToggle(t *testing.T) {
	model := &fakeModel{replies: []string{"不该回复"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"adminUsers": []any{"9999"}}),
	}, model, bot)

	if handled := runtime.HandleEvent(buildGroupEvent("/llm", false, "99001", "9999")); !handled {
		t.Fatal("管理员 /llm 应被处理")
	}
	if runtime.llmEnabled() {
		t.Fatal("/llm 后 LLM 应关闭")
	}
	if len(bot.groupSent) != 1 {
		t.Fatalf("应回复状态提示，实际 %d", len(bot.groupSent))
	}
	if len(model.requests) != 0 {
		t.Fatal("/llm 不应调用模型")
	}
	// 关闭后普通消息不处理
	if handled := runtime.HandleEvent(buildGroupEvent("你好", true, "99001", "2001")); handled {
		t.Fatal("LLM 关闭后普通消息不应处理")
	}
	// 非管理员的 /llm 不生效
	if handled := runtime.HandleEvent(buildGroupEvent("/llm", false, "99001", "2001")); handled {
		t.Fatal("非管理员 /llm 不应被处理")
	}
}

// TestAdminMentionCommand：/at @某人 生成要求 → 模型生成后 [at,text] 真实发送（对齐 Node）。
func TestAdminMentionCommand(t *testing.T) {
	model := &fakeModel{replies: []string{"来夸夸你"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"adminUsers": []any{"9999"}}),
	}, model, bot)

	event := buildGroupEvent("/at ", false, "99001", "9999")
	event["message"] = []any{
		map[string]any{"type": "text", "data": map[string]any{"text": "/at "}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "2002", "name": "犬皇"}},
		map[string]any{"type": "text", "data": map[string]any{"text": " 夸夸他"}},
	}
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatal("管理员 /at 应被处理")
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && len(bot.groupSent) == 0 {
		time.Sleep(20 * time.Millisecond)
	}
	if len(bot.groupSent) == 0 {
		t.Fatal("应真实发送主动 @ 消息")
	}
	segments, _ := bot.groupSent[0]["message"].([]map[string]any)
	if len(segments) != 2 || segments[0]["type"] != "at" || segments[1]["type"] != "text" {
		t.Fatalf("主动 @ 段结构不符: %+v", segments)
	}
	if segments[0]["data"].(map[string]any)["qq"] != "2002" {
		t.Fatalf("@ 目标不符: %+v", segments[0])
	}
	// 非管理员
	before := len(bot.groupSent)
	event2 := buildGroupEvent("/at ", false, "99001", "2001")
	event2["message"] = []any{
		map[string]any{"type": "text", "data": map[string]any{"text": "/at "}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "2002", "name": "犬皇"}},
		map[string]any{"type": "text", "data": map[string]any{"text": " 夸夸他"}},
	}
	if handled := runtime.HandleEvent(event2); !handled {
		t.Fatal("非管理员 /at 也应被处理（发送失败提示）")
	}
	if len(bot.groupSent) != before+1 {
		t.Fatalf("非管理员应收到失败提示，实际发送 %d 条", len(bot.groupSent)-before)
	}
}

// TestParticipantProfileManualCommand：缺 @ 目标时给出提示；非管理员被拒绝。
func TestParticipantProfileManualCommand(t *testing.T) {
	model := &fakeModel{replies: []string{"不该调用"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"adminUsers": []any{"9999"}}),
	}, model, bot)
	if handled := runtime.HandleEvent(buildGroupEvent("/人物档案", false, "99001", "9999")); !handled {
		t.Fatal("缺少 @ 目标时应被命令处理并给出提示")
	}
	if len(model.requests) != 0 {
		t.Fatal("缺少目标时不应调用模型")
	}
	if handled := runtime.HandleEvent(buildGroupEvent("/人物档案 @2002", false, "99001", "2001")); !handled {
		t.Fatal("非管理员命令也应被处理（发送失败提示）")
	}
}

// TestPokeCommandReaction：戳一戳命令被接受时发送表情回应（即便非管理员）。
func TestPokeCommandReaction(t *testing.T) {
	model := &fakeModel{replies: []string{"不该调用"}}
	base := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	bot := &callRecordingBot{fakeBot: base}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"emojiReaction": true, "emojiReactionId": "289"}),
	}, model, bot)
	event := buildGroupEvent("/戳一戳 @2002", false, "99001", "2001")
	event["message_id"] = "777"
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatal("戳一戳命令应被处理")
	}
	if len(bot.callParams("set_msg_emoji_like")) != 1 {
		t.Fatal("戳一戳命令被接受时应发送表情回应")
	}
}

// TestPokeNoticeResponds：戳 bot 触发对话链路；15 秒冷却；戳别人不响应。
func TestPokeNoticeResponds(t *testing.T) {
	model := &fakeModel{replies: []string{"别戳啦"}}
	bot := &fakeBot{selfID: "1000", forwards: map[string]any{}, messagesByID: map[string]map[string]any{}}
	runtime, _ := newRuntimeForRouting(t, map[string]any{
		"chat": routingChatConfig(map[string]any{"defaultCharacter": "测试角色"}),
	}, model, bot)
	makePoke := func(target string, user string) map[string]any {
		return map[string]any{
			"post_type": "notice", "notice_type": "notify", "sub_type": "poke",
			"group_id": "99001", "user_id": user, "target_id": target, "self_id": "1000",
			"sender": map[string]any{"nickname": "测试员"},
			"time":   float64(1789311808),
		}
	}
	if handled := runtime.HandleEvent(makePoke("1000", "2001")); !handled {
		t.Fatal("戳 bot 应触发回复")
	}
	if len(model.requests) != 1 {
		t.Fatalf("应调用模型一次，实际 %d", len(model.requests))
	}
	if handled := runtime.HandleEvent(makePoke("1000", "2002")); handled {
		t.Fatal("冷却期内不应再次响应")
	}
	if handled := runtime.HandleEvent(makePoke("2002", "2003")); handled {
		t.Fatal("戳他人不应响应")
	}
}
