// Package panel：靶场「优化一步」提示词（对齐 Node /api/prompt-range/optimize-step）。
package panel

import (
	"encoding/json"
	"strings"

	"mimirlink/internal/config"
)

// nodeOptimizeInput 是优化提示词的输入（字段与 Node 侧模板一致）。
type nodeOptimizeInput struct {
	Goal            string
	IterationNumber int
	MaxIterations   int
	LastResultText  string
	PromptItems     string
	Character       string
	Worldbook       string
	Corpus          string
	NoJSONMode      bool
}

// nodeMethodology 是 Node 侧内置的方法论文本（萧谴 / 明月秋青 / A.U.T.O）。
// 这段文案决定模型输出质量与判定口径，必须与 Node 保持一致。
const nodeMethodology = `你是 SillyTavern 写卡优化专家，融合明月秋青/萧谴/A.U.T.O 三套方法论。

## 创作方法论(明月秋青)
性格调色盘: 底色+主色调+点缀+衍生,用行为展现性格,非贴标签
绝对零度: 白描事实,不修饰渲染,用名词动词避形容词,语料展现性格
八股检测(必须砍): 模糊词(似乎/仿佛/宛如) | 劣质比喻(小兽/涟漪/投石) | 微表情(嘴角上扬/闪过光芒) | 语气描写 | 大段内心 | 模板句

## 产出标准(萧谴+明月秋青)
角色卡字段: description(浓缩人设) | personality(行为模式) | scenario(场景) | first_mes(开场用语料展现性格) | mes_example(对话示例用<START>标签) | system_prompt(系统级约束) | post_history_instructions(后置注入)
世界书: key(触发词覆盖角色称呼/特征) | order(核心设定>细节) | position(角色前=人设,后=行为约束) | content(去八股,用行为描述)
预设: 修改prompt的content字段,不改marker和name

## 结构化工作流(A.U.T.O)
阶段1 DIAGNOSE: 识别回复中的八股/冗余/角色偏离
阶段2 TUNE: 按性格调色盘+绝对零度修改→ELO对战验证
阶段3 VERIFY: 换语料验证→确保没改坏

## 场景策略
QQ群聊→砍冗长,砍动作,≤2条消息每段≤80字,如真人水群
角色扮演→去八股,用语料+行为替代形容词

## ELO对战
A(旧版回复) vs B(新版回复): A_wins / B_wins / draw
B连胜2次或draw 2次→达标停止`

const nodeOptimizeJSONSchema = `返回JSON:
{
  "decision": "modify"或"stop",
  "elo": {"result":"A_wins"或"B_wins"或"draw","reasoning":"从性格调色盘/绝对零度/八股角度说明"},
  "evaluation": {"issues":["问题"],"highlights":["亮点"]},
  "modifiedPrompts": [{"identifier":"id","oldContent":"原文","newContent":"新文"}],
  "modifiedCharacter": [{"field":"字段名","oldContent":"原文","newContent":"新文"}],
  "modifiedWorldBook": [{"index":-1,"action":"update/add/delete","entry":{}}],
  "nextTestMessage": "验证消息",
  "changeSummary": "一句话"
}`

// nodeOptimizePrompt 组装优化提示词（与 Node 模板逐段对应）。
func nodeOptimizePrompt(input nodeOptimizeInput) string {
	var builder strings.Builder
	builder.WriteString(nodeMethodology)
	builder.WriteString("\n\n## 优化目标: ")
	builder.WriteString(input.Goal)
	builder.WriteString(" | 轮次: ")
	builder.WriteString(itoaForPanel(input.IterationNumber))
	builder.WriteString("/")
	builder.WriteString(itoaForPanel(input.MaxIterations))
	builder.WriteString("\n\n## 测试结果\n")
	builder.WriteString(orDefault(input.LastResultText, "(尚无测试结果)"))
	builder.WriteString("\n\n## 当前配置\n提示词: ")
	builder.WriteString(orDefault(input.PromptItems, "(无)"))
	builder.WriteString("\n角色卡: ")
	builder.WriteString(orDefault(input.Character, "(未提供)"))
	builder.WriteString("\n世界书: ")
	builder.WriteString(orDefault(input.Worldbook, "(未提供)"))
	builder.WriteString("\n")
	if input.Corpus != "" {
		builder.WriteString("\n")
		builder.WriteString(input.Corpus)
		builder.WriteString("\n")
	}
	if input.NoJSONMode {
		builder.WriteString("\n请用简洁的中文分点输出：先判定 A/B 胜负（A_wins/B_wins/draw）与理由，" +
			"再列出问题与亮点，最后给出需要修改的提示词/角色卡/世界书字段与新的完整内容。")
		return builder.String()
	}
	builder.WriteString("\n")
	builder.WriteString(nodeOptimizeJSONSchema)
	return builder.String()
}

func itoaForPanel(value int) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	if negative {
		return "-" + digits
	}
	return digits
}

// mapOfAny 把任意值转为 map（供优化结果解析使用）。
func mapOfAny(value any) map[string]any {
	result, _ := value.(map[string]any)
	return result
}

// presetForPanel 读取当前生效预设（内联 config.preset）。
func presetForPanel(document *config.Document) map[string]any {
	result := map[string]any{}
	raw := document.Get("preset")
	if !raw.Exists() {
		return result
	}
	if err := json.Unmarshal([]byte(raw.Raw), &result); err != nil {
		return map[string]any{}
	}
	return result
}

// worldBookToMap 把靶场世界书结构转成通用 map（供摘要使用）。
func worldBookToMap(book *rangeWorldBook) map[string]any {
	if book == nil {
		return nil
	}
	entries := make([]any, 0, len(book.Entries))
	for _, entry := range book.Entries {
		entries = append(entries, entry)
	}
	return map[string]any{"entries": entries}
}

// toStringSliceOf 把任意值转为字符串切片（字符串或数组）。
func toStringSliceOf(value any) []string {
	result := []string{}
	switch typed := value.(type) {
	case string:
		if trimmed := strings.TrimSpace(typed); trimmed != "" {
			result = append(result, trimmed)
		}
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
				result = append(result, strings.TrimSpace(text))
			}
		}
	}
	return result
}
