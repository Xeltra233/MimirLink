package chat

import (
	"testing"
	"time"
)

// TestGroupRepeatDetector：计数触发、不同文本重置、冷却、禁用。
func TestGroupRepeatDetector(t *testing.T) {
	detector := NewGroupRepeatDetector()
	config := GroupRepeatConfig{Enabled: true, TriggerCount: 3, CooldownMs: 60000}
	selfID := "1000"

	makeEvent := func(text string, userID string) map[string]any {
		return map[string]any{
			"post_type": "message", "message_type": "group", "group_id": "99001",
			"user_id": userID, "message": []any{
				map[string]any{"type": "text", "data": map[string]any{"text": text}},
			},
		}
	}

	// 两次未达阈值
	if result := detector.ObserveMessage(config, makeEvent("哈哈哈", "2001"), "哈哈哈", selfID, testNow(0)); result.ShouldRepeat {
		t.Fatalf("第 1 次不应触发: %+v", result)
	}
	if result := detector.ObserveMessage(config, makeEvent("哈哈哈", "2002"), "哈哈哈", selfID, testNow(1)); result.ShouldRepeat || result.Count != 2 {
		t.Fatalf("第 2 次应 tracking: %+v", result)
	}
	// 第三次触发
	third := detector.ObserveMessage(config, makeEvent("哈哈哈", "2003"), "哈哈哈", selfID, testNow(2))
	if !third.ShouldRepeat || third.Count != 3 || third.RepeatText != "哈哈哈" {
		t.Fatalf("第 3 次应触发复读: %+v", third)
	}
	// 冷却期内不重复触发
	if result := detector.ObserveMessage(config, makeEvent("哈哈哈", "2004"), "哈哈哈", selfID, testNow(3)); result.ShouldRepeat || result.Reason != "cooldown" {
		t.Fatalf("冷却期内不应触发: %+v", result)
	}
	// 不同文本重置计数
	if result := detector.ObserveMessage(config, makeEvent("不一样", "2005"), "不一样", selfID, testNow(4)); result.ShouldRepeat || result.Count != 1 {
		t.Fatalf("不同文本应重新计数: %+v", result)
	}
	// bot 自己的消息不观察
	if result := detector.ObserveMessage(config, makeEvent("自己", "1000"), "自己", selfID, testNow(5)); result.Reason != "not_observable" {
		t.Fatalf("bot 消息不应观察: %+v", result)
	}
	// 私聊不观察
	private := makeEvent("哈哈哈", "2006")
	private["message_type"] = "private"
	if result := detector.ObserveMessage(config, private, "哈哈哈", selfID, testNow(6)); result.Reason != "not_observable" {
		t.Fatalf("私聊不应观察: %+v", result)
	}
	// 含图片段不观察
	withImage := makeEvent("", "2007")
	withImage["message"] = []any{
		map[string]any{"type": "image", "data": map[string]any{"file": "x.jpg"}},
	}
	if result := detector.ObserveMessage(config, withImage, "", selfID, testNow(7)); result.Reason != "not_observable" {
		t.Fatalf("图片消息不应观察: %+v", result)
	}
	// 禁用
	disabled := GroupRepeatConfig{Enabled: false}
	if result := detector.ObserveMessage(disabled, makeEvent("哈哈哈", "2008"), "哈哈哈", selfID, testNow(8)); result.Reason != "disabled" {
		t.Fatalf("禁用应返回 disabled: %+v", result)
	}
}

// TestQQInteractions：表情 ID 归一化、命令识别、@ 提取。
func TestQQInteractions(t *testing.T) {
	if NormalizeEmojiReactionId("", "") != "289" {
		t.Fatal("默认表情应为 289")
	}
	if NormalizeEmojiReactionId("赞", "") != "76" || NormalizeEmojiReactionId("LIKE", "") != "76" {
		t.Fatal("别名解析异常")
	}
	if NormalizeEmojiReactionId("id:123", "") != "123" {
		t.Fatal("数字前缀解析异常")
	}
	if !isCommandInvocation("/戳一戳", "/戳一戳") || !isCommandInvocation("/戳一戳 @123", "/戳一戳") {
		t.Fatal("命令识别异常")
	}
	if isCommandInvocation("/戳一戳123", "/戳一戳") {
		t.Fatal("非空白后缀不应识别为命令")
	}
	event := map[string]any{"message": []any{
		map[string]any{"type": "at", "data": map[string]any{"qq": "111"}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "111"}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "all"}},
		map[string]any{"type": "at", "data": map[string]any{"qq": "222"}},
	}}
	targets := extractMentionedUserIds(messageSegments(event["message"]))
	if len(targets) != 2 || targets[0] != "111" || targets[1] != "222" {
		t.Fatalf("@ 提取异常: %v", targets)
	}
	if !hasAtAllMention(messageSegments(event["message"])) {
		t.Fatal("应检测到 @全体")
	}
}

// TestAdminPokeCommand：管理员校验 + 发送（mock onebot Call）。
func TestAdminPokeCommand(t *testing.T) {
	model := &fakeModel{replies: []string{"ok"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{"adminUsers": []any{"9999"}},
	}, model)
	runtime.rootDir = t.TempDir()
	event := buildGroupEvent("/戳一戳 @2002", true, "99001", "9999")
	// 戳拍走 onebot Call——mock bot 未实现 Call，应报错但命令已识别
	handled := runtime.maybeHandleAdminPokeCommand(event, "group", "99001", "9999", "/戳一戳 @2002")
	if !handled {
		t.Fatal("管理员命令应被处理")
	}
	_ = bot
	// 非管理员
	event2 := buildGroupEvent("/戳一戳 @2002", true, "99001", "2001")
	if handled := runtime.maybeHandleAdminPokeCommand(event2, "group", "99001", "2001", "/戳一戳 @2002"); !handled {
		t.Fatal("非管理员命令也应被处理（发送失败提示）")
	}
	// 非命令文本
	if handled := runtime.maybeHandleAdminPokeCommand(buildGroupEvent("普通聊天", true, "99001", "9999"), "group", "99001", "9999", "普通聊天"); handled {
		t.Fatal("普通文本不应被命令处理")
	}
}

// testNow 生成递增时间。
func testNow(offsetSeconds int) time.Time {
	return time.Unix(1789311808+int64(offsetSeconds), 0)
}
