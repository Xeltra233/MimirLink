package tools

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"mimirlink/internal/ai"
)

// 本文件对齐 Node src/tools.js + index.js 的主动 @ 工具链路（goal-39 补齐 Go）：
// 定义与默认值解析在 tools 层；正文生成与真实发送由 chat 运行时通过 MentionGenerator 注入，
// 避免 tools → chat 的反向依赖。

// CallScope 是一次工具执行的上下文（对齐 Node buildAIToolContext 的默认值参数）。
type CallScope struct {
	GroupID      string
	TargetUserID string
	TargetName   string
	// MentionGenerator 由 chat 运行时按消息注入：生成人设风格的 @ 正文并真实发送，
	// 返回最终发送的文本（对齐 Node mentionGenerator → generateContextualMentionReply）。
	MentionGenerator func(ctx context.Context, groupID string, targetUserID string, targetName string, promptText string) (string, error)
}

// buildMentionToolDefinition 对齐 Node buildAIToolContext 中 send_group_mention 的定义。
func buildMentionToolDefinition() ai.ToolDefinition {
	definition := ai.ToolDefinition{Type: "function"}
	definition.Function.Name = "send_group_mention"
	definition.Function.Description = "在群聊中主动 @ 某位成员并发送消息。入参里的 prompt 是要求，最终发送正文会由 AI 再生成后发出。禁止 @all。"
	definition.Function.Parameters = map[string]any{
		"type": "object",
		"properties": map[string]any{
			"groupId":      map[string]any{"type": "string", "description": "目标群号；若当前已在群上下文中可省略。"},
			"targetUserId": map[string]any{"type": "string", "description": "要 @ 的 QQ 号；若希望 @ 当前发言人且上下文明确可省略。"},
			"prompt":       map[string]any{"type": "string", "description": "希望发给对方的要求或意图，最终正文会由 AI 生成。"},
		},
		"required": []string{"prompt"},
	}
	return definition
}

// sendGroupMention 执行主动 @（对齐 Node send_group_mention handler）：
// 默认值回退当前群/发言人 → 参数校验 → 运行时生成正文并真实发送 → 返回 JSON 结果。
func (r *Registry) sendGroupMention(ctx context.Context, arguments map[string]any, scope CallScope) (string, error) {
	groupID := strings.TrimSpace(stringArg(arguments, "groupId"))
	if groupID == "" {
		groupID = strings.TrimSpace(scope.GroupID)
	}
	targetUserID := strings.TrimSpace(stringArg(arguments, "targetUserId"))
	if targetUserID == "" {
		targetUserID = strings.TrimSpace(scope.TargetUserID)
	}
	prompt := strings.TrimSpace(stringArg(arguments, "prompt"))

	// 失败以 {ok:false,...} 形式返回（对齐 Node handler 的返回对象），模型可据此如实说明
	fail := func(message string) (string, error) {
		payload := map[string]any{
			"ok":           false,
			"error":        message,
			"groupId":      groupID,
			"targetUserId": targetUserID,
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			return "", err
		}
		return string(encoded), nil
	}

	if groupID == "" {
		return fail("缺少群号，无法主动 @")
	}
	if targetUserID == "" || targetUserID == "all" {
		return fail("目标成员不能为空，且不能是 @all")
	}
	if prompt == "" {
		return fail("主动 @ 的要求不能为空")
	}
	if scope.MentionGenerator == nil {
		return fail("主动 @ 未接入运行时")
	}

	r.logger.Printf("[工具] 开始执行 send_group_mention（群 %s，目标 %s）", groupID, targetUserID)
	startedAt := time.Now()
	generated, err := scope.MentionGenerator(ctx, groupID, targetUserID, scope.TargetName, prompt)
	if err != nil {
		r.logger.Printf("[工具] send_group_mention 失败(%dms): %v", time.Since(startedAt).Milliseconds(), err)
		return fail(err.Error())
	}
	r.logger.Printf("[工具] send_group_mention 完成(%dms)", time.Since(startedAt).Milliseconds())

	payload := map[string]any{
		"ok":               true,
		"groupId":          groupID,
		"targetUserId":     targetUserID,
		"generatedMessage": generated,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	return string(encoded), nil
}
