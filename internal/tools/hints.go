package tools

import (
	"fmt"
	"strings"

	"mimirlink/internal/config"
	"mimirlink/internal/mcp"
)

// 本文件对齐 Node src/tools.js 的工具说明段（goal-38 在 Node 落地，goal-39 补齐 Go）：
// 说明与工具定义同生共灭；两阶段模式下只进工具阶段，正式回复阶段不加载。

// BuildToolHintRules 通用总则：与具体功能无关，所有工具共用。
func BuildToolHintRules() string {
	return strings.Join([]string{
		"【工具使用总则】",
		"- 本次请求下发的工具定义是你唯一可调用的组件清单；不要调用未下发的工具名，也不要声称调用过。",
		"- 用户明确要求执行某个动作或使用某个能力时，必须真的调用对应工具，不能用文字假装完成。",
		"- 调用工具不受角色人设限制：语气可以保持人设，但不能以“我不会 / 角色做不到”为由拒绝调用。",
		"- 工具失败、超时或无结果时如实说明，不要编造结果，也不要假装成功。",
		"- 不要泄露工具名、JSON、参数，也不要说“我准备调用工具”这类过程话术。",
		"- 工具结果只作为依据，最终回复用自然语言总结。",
		"- 同一目标不要重复完全相同的调用；连续空转不超过 3 轮。",
	}, "\n")
}

// boolDefaultTrue 读取布尔配置，键缺失时按 true 处理（对齐 Node 的 `!== false` 语义）。
func boolDefaultTrue(document *config.Document, path string) bool {
	if document == nil {
		return true
	}
	if !document.Exists(path) {
		return true
	}
	return document.Bool(path)
}

// intDefault 读取整数配置，缺失或非正数时回退默认值。
func intDefault(document *config.Document, path string, fallback int) int {
	if document == nil {
		return fallback
	}
	value := int(document.Int(path, int64(fallback)))
	if value <= 0 {
		return fallback
	}
	return value
}

// BuildWebToolHint 联网检索段：仅在启用联网工具时生成，随配置变化（对齐 Node buildWebToolHint）。
func BuildWebToolHint(document *config.Document) string {
	if document == nil || !document.Bool("ai.tools.webSearch.enabled") {
		return ""
	}

	maxResults := intDefault(document, "ai.tools.webSearch.maxResults", 5)
	timeoutMs := intDefault(document, "ai.tools.webSearch.timeoutMs", 10000)
	maxSnippet := intDefault(document, "ai.tools.webSearch.maxSnippetLength", 800)
	fetchEnabled := boolDefaultTrue(document, "ai.tools.webSearch.fetch.enabled")
	spiceEnabled := boolDefaultTrue(document, "ai.tools.webSearch.spice.enabled")
	weatherDays := intDefault(document, "ai.tools.webSearch.spice.weatherDays", 3)

	available := []string{"web_search"}
	if fetchEnabled {
		available = append(available, "web_fetch")
	}
	if spiceEnabled {
		available = append(available, "get_weather", "convert_currency")
	}

	lines := []string{
		"【功能：联网检索】",
		fmt.Sprintf("可用组件：%s。", strings.Join(available, "、")),
	}
	if fetchEnabled || spiceEnabled {
		lines = append(lines, "必须调用、不得凭记忆或猜测作答的情形：用户明确要求 搜/查/查证/给链接/给来源/给出处/最新情况/是不是真的；涉及新闻、价格、政策、版本、赛事、天气、汇率、人物动态等实时或可能变化的信息；需要外部事实核验（链接、项目、库、资料、图片来源）。")
	}
	lines = append(lines,
		fmt.Sprintf("- web_search：参数 query（必填）、topic=web|news（新闻用 news）、timeRange=day|week|month|year、site=限定站点、limit=条数（默认 %d）。", maxResults),
		"- 图片出处：先读图中文字或可检索特征，再用 web_search 检索；图中没有可检索信息时直接说“我无法反查图片出处”，不要编 URL，也不要编造“全网都找不到”。",
	)
	if fetchEnabled {
		lines = append(lines, "- web_fetch：参数 url、maxChars；只在需要页面正文细节（确认出处、核对规格）时使用，不要对每条结果都抓取。")
	}
	if spiceEnabled {
		lines = append(lines,
			fmt.Sprintf("- get_weather：仅在用户明确问天气且能给出地点时使用；参数 location、days（默认 %d）。", weatherDays),
			"- convert_currency：仅在需要汇率或金额换算时使用；参数 from、to、amount。",
		)
	}
	lines = append(lines,
		"- 检索无结果或失败时，简短说明这次没查到，不要编造链接或依据。",
		fmt.Sprintf("- 限制：默认最多 %d 条结果，单次搜索超时 %dms，单条摘要最长 %d 字。", maxResults, timeoutMs, maxSnippet),
	)
	return strings.Join(lines, "\n")
}

// BuildMentionToolHint 主动 @ 段：仅在启用主动 @ 工具时生成（对齐 Node buildMentionToolHint）。
func BuildMentionToolHint(document *config.Document) string {
	if document == nil || !document.Bool("ai.tools.sendMention.enabled") {
		return ""
	}
	return strings.Join([]string{
		"【功能：主动 @ 群成员】",
		"可用组件：send_group_mention。",
		"- 使用时机：用户要求你转告、提醒、通知、叫某人，或明确让你 @ 某人；自己发起闲聊式 @ 不在范围内。",
		"- 参数：prompt（必填，写清要传达的要求或意图，最终正文由你按角色风格生成）、targetUserId（要 @ 的 QQ 号，上下文明确可省略）、groupId（当前群可省略）。",
		"- 硬限制：禁止 @all；仅群聊可用；同一轮不要重复 @ 同一个人。",
		"- 发送失败或权限不足时如实说明，不要假装已经通知到。",
	}, "\n")
}

// BuildMcpToolHint 外部 MCP 段：清单由已连接服务器的工具定义自动生成（对齐 Node buildMcpToolHint）。
func BuildMcpToolHint(definitions []mcp.ToolDefinition) string {
	if len(definitions) == 0 {
		return ""
	}

	serverOrder := []string{}
	byServer := map[string][]string{}
	for _, item := range definitions {
		serverName := strings.TrimSpace(item.ServerName)
		if serverName == "" {
			serverName = "mcp"
		}
		toolName := strings.TrimSpace(item.ToolName)
		if toolName == "" {
			toolName = item.Name
		}
		if _, exists := byServer[serverName]; !exists {
			serverOrder = append(serverOrder, serverName)
		}
		byServer[serverName] = append(byServer[serverName], toolName)
	}

	lines := []string{
		"【功能：外部 MCP 工具】",
		fmt.Sprintf("已连接服务器（共 %d 个工具，名称以 mcp__ 开头）：", len(definitions)),
	}
	for _, serverName := range serverOrder {
		names := byServer[serverName]
		lines = append(lines, fmt.Sprintf("- %s（%d）：%s", serverName, len(names), strings.Join(names, "、")))
	}
	lines = append(lines,
		"- 使用时机：用户明确需要这些能力（文件、数据库、浏览器、外部服务等）时调用；不确定时先说明你的能力范围。",
		"- 只能调用上面列出的工具名；调用失败、超时或被拒绝时如实说明，不要编造结果或假装成功。",
		"- 参数按工具定义传，不要臆造参数名。",
	)
	return strings.Join(lines, "\n")
}

// HintsFor 组装工具说明段（总则置首，仅在有可调用工具时下发）；运行时与面板预览共用。
func HintsFor(document *config.Document, client *mcp.Client) []string {
	hints := []string{}
	if web := BuildWebToolHint(document); web != "" {
		hints = append(hints, web)
	}
	if mention := BuildMentionToolHint(document); mention != "" {
		hints = append(hints, mention)
	}
	if client != nil {
		if definitions := client.Definitions(); len(definitions) > 0 {
			hints = append(hints, BuildMcpToolHint(definitions))
		}
	}
	if len(hints) > 0 {
		hints = append([]string{BuildToolHintRules()}, hints...)
	}
	return hints
}

// ToolHints 组装本请求下发的工具说明段（运行时入口）。
func (r *Registry) ToolHints() []string {
	if r == nil {
		return nil
	}
	return HintsFor(r.document, r.mcp)
}

// ToolNamesForPreview 按配置推导可用工具名（面板预览用，与 Definitions 的启用条件一致）。
func ToolNamesForPreview(document *config.Document, client *mcp.Client) []string {
	names := []string{}
	if document != nil && document.Bool("ai.tools.webSearch.enabled") {
		names = append(names, "web_search")
		if boolDefaultTrue(document, "ai.tools.webSearch.fetch.enabled") {
			names = append(names, "web_fetch")
		}
		if boolDefaultTrue(document, "ai.tools.webSearch.spice.enabled") {
			names = append(names, "get_weather", "convert_currency")
		}
	}
	if document != nil && document.Bool("ai.tools.sendMention.enabled") {
		names = append(names, "send_group_mention")
	}
	if client != nil {
		for _, item := range client.Definitions() {
			names = append(names, item.Name)
		}
	}
	return names
}
