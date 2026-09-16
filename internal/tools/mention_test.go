package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"mimirlink/internal/ai"
)

// mentionCall 构造一次 send_group_mention 调用。
func mentionCall(t *testing.T, arguments string) ai.ToolCall {
	t.Helper()
	call := ai.ToolCall{}
	call.Function.Name = "send_group_mention"
	call.Function.Arguments = arguments
	return call
}

// TestDefinitionsMentionGate：主动 @ 工具随 ai.tools.sendMention.enabled 进工具表。
func TestDefinitionsMentionGate(t *testing.T) {
	if definitions := New(newDocument(t, map[string]any{}), nil, nil).Definitions(); len(definitions) != 0 {
		t.Fatalf("未开启时不应有工具: %v", definitions)
	}
	document := newDocument(t, map[string]any{
		"ai": map[string]any{"tools": map[string]any{"sendMention": map[string]any{"enabled": true}}},
	})
	definitions := New(document, nil, nil).Definitions()
	if len(definitions) != 1 || definitions[0].Function.Name != "send_group_mention" {
		t.Fatalf("应下发 send_group_mention: %v", definitions)
	}
	parameters := definitions[0].Function.Parameters
	required, _ := parameters["required"].([]string)
	if len(required) != 1 || required[0] != "prompt" {
		t.Fatalf("required 应为 prompt: %v", parameters["required"])
	}
}

// TestMentionValidation：参数校验失败以 {ok:false} 返回，不抛执行错误。
func TestMentionValidation(t *testing.T) {
	registry := New(newDocument(t, map[string]any{}), nil, nil)
	cases := []struct {
		name      string
		arguments string
		scope     CallScope
		expected  string
	}{
		{"缺少群号", `{"prompt":"提醒交作业"}`, CallScope{}, "缺少群号"},
		{"目标为空", `{"prompt":"提醒交作业","targetUserId":"all"}`, CallScope{GroupID: "99001"}, "不能是 @all"},
		{"要求为空", `{}`, CallScope{GroupID: "99001", TargetUserID: "2001"}, "不能为空"},
		{"未接入运行时", `{"prompt":"提醒交作业"}`, CallScope{GroupID: "99001", TargetUserID: "2001"}, "未接入运行时"},
	}
	for _, item := range cases {
		output := registry.Execute(context.Background(), mentionCall(t, item.arguments), item.scope)
		payload := map[string]any{}
		if err := json.Unmarshal([]byte(output), &payload); err != nil {
			t.Fatalf("%s: 结果不是 JSON: %s", item.name, output)
		}
		if payload["ok"] != false || !strings.Contains(toString(payload["error"]), item.expected) {
			t.Fatalf("%s: 期望 ok:false 且含 %q，实际 %s", item.name, item.expected, output)
		}
	}
}

// TestMentionSuccess：默认值回退 scope，生成器返回正文后给出 ok:true 结构。
func TestMentionSuccess(t *testing.T) {
	registry := New(newDocument(t, map[string]any{}), nil, nil)
	generated := []string{}
	scope := CallScope{
		GroupID:      "99001",
		TargetUserID: "2001",
		TargetName:   "测试员",
		MentionGenerator: func(ctx context.Context, groupID string, targetUserID string, targetName string, promptText string) (string, error) {
			generated = append(generated, strings.Join([]string{groupID, targetUserID, targetName, promptText}, "|"))
			return "作业写完了吗？", nil
		},
	}
	output := registry.Execute(context.Background(), mentionCall(t, `{"prompt":"  提醒他交作业  "}`), scope)
	payload := map[string]any{}
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		t.Fatalf("结果不是 JSON: %s", output)
	}
	if payload["ok"] != true || toString(payload["generatedMessage"]) != "作业写完了吗？" {
		t.Fatalf("成功结构不符: %s", output)
	}
	if toString(payload["groupId"]) != "99001" || toString(payload["targetUserId"]) != "2001" {
		t.Fatalf("默认值应回退 scope: %s", output)
	}
	if len(generated) != 1 || generated[0] != "99001|2001|测试员|提醒他交作业" {
		t.Fatalf("生成器入参不符: %v", generated)
	}
}

// TestMentionFailure：生成器报错时如实返回 ok:false。
func TestMentionFailure(t *testing.T) {
	registry := New(newDocument(t, map[string]any{}), nil, nil)
	scope := CallScope{
		GroupID:      "99001",
		TargetUserID: "2001",
		MentionGenerator: func(ctx context.Context, groupID string, targetUserID string, targetName string, promptText string) (string, error) {
			return "", errors.New("发送失败: 权限不足")
		},
	}
	output := registry.Execute(context.Background(), mentionCall(t, `{"prompt":"提醒交作业"}`), scope)
	payload := map[string]any{}
	if err := json.Unmarshal([]byte(output), &payload); err != nil {
		t.Fatalf("结果不是 JSON: %s", output)
	}
	if payload["ok"] != false || !strings.Contains(toString(payload["error"]), "权限不足") {
		t.Fatalf("失败结构不符: %s", output)
	}
}

func toString(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return strings.TrimSpace(fmt.Sprintf("%v", value))
}
