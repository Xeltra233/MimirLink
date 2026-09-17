package chat

import (
	"errors"
	"regexp"
	"strings"
)

// errEmptyReply 标记空回复耗尽（供失败提示文案分支识别）。
var errEmptyReply = errors.New("空回复")

// 本文件对齐 Node generateReplyWithRetry + buildAIServiceFailureMessage + isEmptyLikeReply：
//   - 空回复（空/上游错误内容/纯标点）按 chat.emptyReplyRetry 重试（默认启用/2次/800ms）
//   - 耗尽后给用户回一条引用失败提示（对齐 Node catch 后 sendQuotedStatusMessage）
//   - AI 调用报错同样回失败提示（对齐 Node 同一 catch 分支）

var emptyLikePunctPattern = regexp.MustCompile(`^[.。…·\s]+$`)

// emptyReplyRetrySettings 读取空回复重试配置（对齐 Node normalizeConfig emptyReplyRetry 段）。
type emptyReplyRetrySettings struct {
	Enabled    bool
	MaxRetries int
	DelayMs    int
}

func (r *Runtime) emptyReplyRetrySettings() emptyReplyRetrySettings {
	settings := emptyReplyRetrySettings{Enabled: true, MaxRetries: 2, DelayMs: 800}
	if r.document.Exists("chat.emptyReplyRetry.enabled") {
		settings.Enabled = r.document.Bool("chat.emptyReplyRetry.enabled")
	}
	if r.document.Exists("chat.emptyReplyRetry.maxRetries") {
		settings.MaxRetries = clampRetryInt(int(r.document.Int("chat.emptyReplyRetry.maxRetries", 2)), 0, 20, 2)
	}
	if r.document.Exists("chat.emptyReplyRetry.delayMs") {
		settings.DelayMs = clampRetryInt(int(r.document.Int("chat.emptyReplyRetry.delayMs", 800)), 0, 10000, 800)
	}
	return settings
}

// clampRetryInt 对齐 Node clampInteger：非正数/非法先取 fallback，再 clamp 到区间。
func clampRetryInt(value int, minimum int, maximum int, fallback int) int {
	if value <= 0 {
		value = fallback
	}
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

// isEmptyLikeReply 判断回复是否视为空（对齐 Node isEmptyLikeReply：空/上游错误内容/纯标点）。
func isEmptyLikeReply(text string) bool {
	normalized := strings.TrimSpace(strings.ReplaceAll(text, "\r", ""))
	if normalized == "" {
		return true
	}
	if isProviderErrorLikeReply(normalized) {
		return true
	}
	return emptyLikePunctPattern.MatchString(normalized)
}

// buildAIServiceFailureMessage 构造 AI 失败回执（对齐 Node buildAIServiceFailureMessage）。
func (r *Runtime) buildAIServiceFailureMessage(err error, emptyAttempts int) string {
	message := ""
	if err != nil {
		message = err.Error()
	}
	lowered := strings.ToLower(message)
	switch {
	case strings.Contains(message, "空回复"):
		attempts := emptyAttempts
		if attempts <= 0 {
			attempts = r.emptyReplyRetrySettings().MaxRetries + 1
		}
		return "AI 返回空回复，已自动重试" + itoa(attempts) + "次仍失败，请稍后再试"
	case strings.Contains(lowered, "timeout") || strings.Contains(message, "超时") || strings.Contains(lowered, "deadline"):
		timeoutMs := int(r.document.Int("ai.timeout", 60000))
		if timeoutMs < 1000 {
			timeoutMs = 60000
		}
		return "AI 响应超时（等待超过" + itoa(timeoutMs/1000) + "秒），请稍后再试或增大超时设置"
	case strings.Contains(lowered, "fetch failed") || strings.Contains(lowered, "econnrefused") || strings.Contains(lowered, "eacces") || strings.Contains(lowered, "connection refused") || strings.Contains(lowered, "no such host"):
		return "连接 AI 服务失败，请检查网络、代理或 API Base URL"
	case strings.Contains(message, "401") || strings.Contains(message, "403"):
		return "AI 服务拒绝请求，请检查 Base URL、模型名和 Key 是否属于同一供应商"
	case strings.Contains(message, "500") || strings.Contains(message, "502"):
		return "AI 服务暂时不可用，请稍后重试"
	default:
		return "处理消息时出现错误，请稍后重试"
	}
}
