package chat

import (
	"encoding/base64"
	"strings"
	"testing"
)

// TestForwardNodeNameParity：用户名口径对齐 Node forward-message.js normalizeForwardNodes：
// nickname > sender.card > sender.nickname > name > user_id > sender.user_id > 未知。
func TestForwardNodeNameParity(t *testing.T) {
	payload := map[string]any{"messages": []any{
		// nickname 优先于 sender.card
		map[string]any{"nickname": "昵A", "sender": map[string]any{"card": "卡A", "nickname": "群昵A"}, "message": "hi"},
		// 无 nickname 时用 sender.card
		map[string]any{"sender": map[string]any{"card": "卡B", "nickname": "群昵B"}, "message": "hi"},
		// 无 card 时用 sender.nickname
		map[string]any{"sender": map[string]any{"nickname": "群昵C"}, "message": "hi"},
		// 兼容 name 键
		map[string]any{"name": "名D", "message": "hi"},
		// 兼容 user_id 回退
		map[string]any{"user_id": "5001", "message": "hi"},
		// 全无时为 未知
		map[string]any{"message": "hi"},
	}}
	nodes := normalizeForwardNodes(payload)
	want := []string{"昵A", "卡B", "群昵C", "名D", "5001", "未知"}
	if len(nodes) != len(want) {
		t.Fatalf("节点数应为 %d，实际 %d", len(want), len(nodes))
	}
	for i, name := range want {
		if nodes[i].name != name {
			t.Fatalf("节点 %d 用户名应为 %q，实际 %q", i, name, nodes[i].name)
		}
	}
}

// TestForwardNodeMessageContentKey：节点内容键兼容 message_content（对齐 Node）。
func TestForwardNodeMessageContentKey(t *testing.T) {
	payload := map[string]any{"messages": []any{
		map[string]any{"nickname": "甲", "message_content": "内容键兼容"},
	}}
	runtime, bot, _ := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	bot.forwards["fw-mc"] = payload
	text := runtime.renderForward("fw-mc")
	if !strings.Contains(text, "内容键兼容") {
		t.Fatalf("message_content 内容未渲染：%q", text)
	}
}

// TestForwardIDKeys：forward 段 id 兼容 id/message_id/messageId/res_id/resId（对齐 Node findForwardSegments）。
func TestForwardIDKeys(t *testing.T) {
	for _, key := range []string{"id", "message_id", "messageId", "res_id", "resId"} {
		if got := forwardSegmentID(map[string]any{key: "fw-x"}); got != "fw-x" {
			t.Fatalf("forward data 键 %q 应解析出 fw-x，实际 %q", key, got)
		}
	}
}

// TestForwardSkipsEmptyNodes：空文本节点跳过不占行（对齐 Node fetchForwardTranscript）。
func TestForwardSkipsEmptyNodes(t *testing.T) {
	runtime, bot, _ := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	bot.forwards["fw-empty"] = map[string]any{"messages": []any{
		map[string]any{"nickname": "甲", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "有效"}}}},
		map[string]any{"nickname": "乙", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "   "}}}},
		map[string]any{"nickname": "丙", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "也有"}}}},
	}}
	rendered := runtime.renderForward("fw-empty")
	if strings.Contains(rendered, "乙:") {
		t.Fatalf("空文本节点不应占行：%s", rendered)
	}
	if !strings.Contains(rendered, "1. 甲: 有效") || !strings.Contains(rendered, "2. 丙: 也有") {
		t.Fatalf("序号应连续：%s", rendered)
	}
}

// TestForwardKeywordTrigger：转发展开内容（含用户名）参与关键词触发（对齐 Node plainText 并入 transcript）。
func TestForwardKeywordTrigger(t *testing.T) {
	model := &fakeModel{replies: []string{"收到"}}
	runtime, bot, _ := newRuntime(t, map[string]any{
		"chat": map[string]any{"triggerMode": "keyword", "triggerKeywords": []string{"火锅"}, "bufferWindowMs": 0},
	}, model)
	bot.forwards["fw-kw"] = map[string]any{"messages": []any{
		map[string]any{"nickname": "小红", "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "今晚吃火锅"}}}},
	}}
	event := buildGroupEvent("", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "forward", "data": map[string]any{"id": "fw-kw"}})
	if handled := runtime.HandleEvent(event); !handled {
		t.Fatalf("转发内容命中关键词应触发")
	}
	if len(model.requests) == 0 {
		t.Fatalf("关键词触发后应调用模型")
	}
	joined := ""
	for _, message := range model.requests[0] {
		if text, ok := message.Content.(string); ok {
			joined += text + "\n"
		}
	}
	if !strings.Contains(joined, "火锅") || !strings.Contains(joined, "小红") {
		t.Fatalf("提示词应含转发展开内容与用户名:\n%s", joined)
	}
}

// TestForwardImagesEnterImagePipeline：转发内图片进入识图输入（对齐 Node forwardImageSegments）。
func TestForwardImagesEnterImagePipeline(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(testPNG)
	imageURL := "base64://" + encoded
	model := &fakeModel{replies: []string{"看到了"}}
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, model)
	bot.forwards["fw-img"] = map[string]any{"messages": []any{
		map[string]any{"sender": map[string]any{"nickname": "小明", "user_id": "3001"}, "message": []any{map[string]any{"type": "image", "data": map[string]any{"file": imageURL}}}},
	}}
	event := buildGroupEvent("看看", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "forward", "data": map[string]any{"id": "fw-img"}})
	runtime.HandleEvent(event)
	if len(model.requests) == 0 {
		t.Fatalf("未触发模型调用")
	}
	joined := ""
	imageParts := 0
	for _, message := range model.requests[0] {
		if text, ok := message.Content.(string); ok {
			joined += text + "\n"
		}
		if parts, ok := message.Content.([]any); ok {
			for _, part := range parts {
				if entry, ok := part.(map[string]any); ok && entry["type"] == "image_url" {
					imageParts++
				}
			}
		}
	}
	if imageParts != 1 {
		t.Fatalf("转发内图片应直传模型，实际 %d 张", imageParts)
	}
}
