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

// TestQuotedForwardImagesEnterImagePipeline：引用一条本身是合并转发的消息时，
// 被引用合并转发内的图片应进入识图输入（回归：此前只扫当前消息，
// 引用目标里的 forward 图片只被渲染成"含图片N张"文本，模型收不到图）。
func TestQuotedForwardImagesEnterImagePipeline(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(testPNG)
	imageURL := "base64://" + encoded
	model := &fakeModel{replies: []string{"看到了"}}
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, model)
	bot.forwards["fw-quote"] = map[string]any{"messages": []any{
		map[string]any{"sender": map[string]any{"nickname": "小明", "user_id": "3001"}, "message": []any{map[string]any{"type": "image", "data": map[string]any{"file": imageURL}}}},
	}}
	bot.messagesByID["m-quoted"] = map[string]any{
		"message_id": "m-quoted",
		"sender":     map[string]any{"nickname": "小明", "user_id": "3001"},
		"message":    []any{map[string]any{"type": "forward", "data": map[string]any{"id": "fw-quote"}}},
	}
	// 用户 @bot 并引用那条含图合并转发
	event := buildGroupEvent("看看这个", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": "m-quoted"}})
	runtime.HandleEvent(event)
	if len(model.requests) == 0 {
		t.Fatalf("未触发模型调用")
	}
	imageParts := 0
	for _, message := range model.requests[0] {
		if parts, ok := message.Content.([]any); ok {
			for _, part := range parts {
				if entry, ok := part.(map[string]any); ok && entry["type"] == "image_url" {
					imageParts++
				}
			}
		}
	}
	if imageParts != 1 {
		t.Fatalf("引用的合并转发内图片应直传模型，实际 %d 张", imageParts)
	}
}

// TestQuotedDirectImageEntersImagePipeline：引用普通含图消息时图片进入识图输入。
func TestQuotedDirectImageEntersImagePipeline(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(testPNG)
	imageURL := "base64://" + encoded
	model := &fakeModel{replies: []string{"看到了"}}
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, model)
	bot.messagesByID["m-img"] = map[string]any{
		"message_id": "m-img",
		"sender":     map[string]any{"nickname": "小红", "user_id": "3002"},
		"message":    []any{map[string]any{"type": "image", "data": map[string]any{"file": imageURL}}},
	}
	event := buildGroupEvent("看看", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "reply", "data": map[string]any{"id": "m-img"}})
	runtime.HandleEvent(event)
	if len(model.requests) == 0 {
		t.Fatalf("未触发模型调用")
	}
	imageParts := 0
	for _, message := range model.requests[0] {
		if parts, ok := message.Content.([]any); ok {
			for _, part := range parts {
				if entry, ok := part.(map[string]any); ok && entry["type"] == "image_url" {
					imageParts++
				}
			}
		}
	}
	if imageParts != 1 {
		t.Fatalf("引用消息内的直发图片应直传模型，实际 %d 张", imageParts)
	}
}

// nestedForwardFixture 构造两层嵌套合并转发的 fakeBot 数据（外层节点引用内层 forward 段）。
func nestedForwardFixture(bot *fakeBot, outerNodeMessage []any) {
	bot.forwards["fw-inner"] = map[string]any{"messages": []any{
		map[string]any{"sender": map[string]any{"nickname": "内层甲", "user_id": "4001"}, "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "内层消息"}}}},
	}}
	bot.forwards["fw-outer"] = map[string]any{"messages": []any{
		map[string]any{"sender": map[string]any{"nickname": "外层乙", "user_id": "4002"}, "message": outerNodeMessage},
	}}
}

// TestNestedForwardWithIDRendersInnerTranscript：嵌套转发段带 id 时递归拉取展开内层。
func TestNestedForwardWithIDRendersInnerTranscript(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, &fakeModel{replies: []string{"x"}})
	nestedForwardFixture(bot, []any{map[string]any{"type": "forward", "data": map[string]any{"id": "fw-inner"}}})
	rendered := runtime.renderForward("fw-outer")
	if !strings.Contains(rendered, "内层消息") {
		t.Fatalf("带 id 的嵌套转发内层应递归展开:\n%s", rendered)
	}
}

// TestNestedForwardInlineContentRendersWithoutID：嵌套转发段无 id 但内联 content 时直接展开
// （对齐 AstrBot chain_parser：seg_data.content 内联分支；此前渲染为"缺少 id"）。
func TestNestedForwardInlineContentRendersWithoutID(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, &fakeModel{replies: []string{"x"}})
	nestedForwardFixture(bot, []any{map[string]any{"type": "forward", "data": map[string]any{
		"content": []any{map[string]any{"type": "text", "data": map[string]any{"text": "内联内容"}}},
	}}})
	rendered := runtime.renderForward("fw-outer")
	if !strings.Contains(rendered, "内联内容") || strings.Contains(rendered, "缺少 id") {
		t.Fatalf("无 id 的内联嵌套转发应直接展开:\n%s", rendered)
	}
}

// TestNestedForwardFallsBackToInlineOnFetchFailure：嵌套段带 id 但拉取失败时，
// 降级展开段内内联节点（部分适配器对嵌套转发不可二次拉取）。
func TestNestedForwardFallsBackToInlineOnFetchFailure(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, &fakeModel{replies: []string{"x"}})
	nestedForwardFixture(bot, []any{map[string]any{"type": "forward", "data": map[string]any{
		"id":      "fw-missing",
		"content": []any{map[string]any{"type": "text", "data": map[string]any{"text": "降级内容"}}},
	}}})
	rendered := runtime.renderForward("fw-outer")
	if !strings.Contains(rendered, "降级内容") || strings.Contains(rendered, "读取失败") {
		t.Fatalf("拉取失败应降级展开内联节点:\n%s", rendered)
	}
}

// TestNormalizeForwardNodesNodeList：Lagrange 风格 nodeList 键兼容。
func TestNormalizeForwardNodesNodeList(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, &fakeModel{replies: []string{"x"}})
	bot.forwards["fw-nl"] = map[string]any{"nodeList": []any{
		map[string]any{"sender": map[string]any{"nickname": "节点甲", "user_id": "4003"}, "message": []any{map[string]any{"type": "text", "data": map[string]any{"text": "nodeList内容"}}}},
	}}
	rendered := runtime.renderForward("fw-nl")
	if !strings.Contains(rendered, "nodeList内容") {
		t.Fatalf("nodeList 键应被解析:\n%s", rendered)
	}
}

// TestForwardMsgAliasSegmentRenders：forward_msg 段类型别名兼容（对齐 AstrBot）。
func TestForwardMsgAliasSegmentRenders(t *testing.T) {
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, &fakeModel{replies: []string{"x"}})
	nestedForwardFixture(bot, nil)
	rendered := runtime.renderSegments([]map[string]any{{"type": "forward_msg", "data": map[string]any{"id": "fw-inner"}}})
	if !strings.Contains(rendered, "内层消息") {
		t.Fatalf("forward_msg 段类型应等价 forward 渲染:\n%s", rendered)
	}
}

// TestNestedForwardInlineImagesEnterImagePipeline：内联嵌套节点里的图片进入识图输入。
func TestNestedForwardInlineImagesEnterImagePipeline(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(testPNG)
	imageURL := "base64://" + encoded
	model := &fakeModel{replies: []string{"看到了"}}
	runtime, bot, _ := newRuntime(t, map[string]any{"chat": map[string]any{"bufferWindowMs": 0}}, model)
	bot.forwards["fw-outer"] = map[string]any{"messages": []any{
		map[string]any{"sender": map[string]any{"nickname": "外层乙", "user_id": "4002"}, "message": []any{map[string]any{"type": "forward", "data": map[string]any{
			"content": []any{map[string]any{"type": "image", "data": map[string]any{"file": imageURL}}},
		}}}},
	}}
	event := buildGroupEvent("看看", true, "99001", "2001")
	segments, _ := event["message"].([]any)
	event["message"] = append(segments, map[string]any{"type": "forward", "data": map[string]any{"id": "fw-outer"}})
	runtime.HandleEvent(event)
	if len(model.requests) == 0 {
		t.Fatalf("未触发模型调用")
	}
	imageParts := 0
	for _, message := range model.requests[0] {
		if parts, ok := message.Content.([]any); ok {
			for _, part := range parts {
				if entry, ok := part.(map[string]any); ok && entry["type"] == "image_url" {
					imageParts++
				}
			}
		}
	}
	if imageParts != 1 {
		t.Fatalf("内联嵌套转发里的图片应进入识图输入，实际 %d 张", imageParts)
	}
}
