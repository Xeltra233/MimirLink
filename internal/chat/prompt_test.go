package chat

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPartitionPromptItems(t *testing.T) {
	preset := map[string]any{
		"enabled": true,
		"prompts": []any{
			map[string]any{"identifier": "main", "content": "主提示", "role": "system", "injection_position": 0},
			map[string]any{"identifier": "depth2", "content": "深度注入", "role": "system", "injection_position": 0, "injection_depth": 2},
			map[string]any{"identifier": "post", "content": "历史后注入", "role": "system", "injection_position": 1},
			map[string]any{"identifier": "prefill", "content": "预填内容", "role": "assistant"},
			map[string]any{"identifier": "off", "content": "被禁用", "role": "system", "enabled": false},
		},
	}
	partition := partitionPromptItems(preset)
	if len(partition.PreSystem) != 1 || partition.PreSystem[0].Identifier != "main" {
		t.Fatalf("preSystem 异常: %+v", partition.PreSystem)
	}
	if len(partition.HistoryInjection) != 1 || partition.HistoryInjection[0].InjectionDepth != 2 {
		t.Fatalf("historyInjection 异常: %+v", partition.HistoryInjection)
	}
	if len(partition.PostHistory) != 1 || partition.PostHistory[0].Identifier != "post" {
		t.Fatalf("postHistory 异常: %+v", partition.PostHistory)
	}
	if len(partition.AssistantPrefill) != 1 || partition.AssistantPrefill[0].Identifier != "prefill" {
		t.Fatalf("assistantPrefill 异常: %+v", partition.AssistantPrefill)
	}
	// 未启用整体 → 空
	if got := partitionPromptItems(map[string]any{"prompts": []any{}}); len(got.PreSystem) != 0 {
		t.Fatal("未启用预设应返回空切分")
	}
}

func TestMatchWorldBookEntries(t *testing.T) {
	book := &worldBook{Entries: []map[string]any{
		{"uid": "1", "keys": []any{"炸天帮"}, "content": "炸天帮是主角门派", "order": 10, "constant": true},
		{"uid": "2", "keys": []any{"徐缺"}, "secondary_keys": []any{"刀"}, "selectiveLogic": 0, "content": "徐缺带刀", "order": 5, "comment": "主角设定"},
		{"uid": "3", "keys": []any{"宗门大会"}, "content": "宗门大会背景", "order": 1, "sticky": 3},
		{"uid": "4", "keys": []any{"不该出现"}, "content": "禁用条目", "enabled": false},
		{"uid": "5", "position": "after_char", "keys": []any{"会后"}, "content": "会后剧情", "order": 0},
	}}
	matched := matchWorldBookEntries(book, "徐缺拿出了刀，谈到宗门大会的会后安排", 10, nil)
	if len(matched) != 4 {
		t.Fatalf("应命中 4 条: %+v", matched)
	}
	// order 降序
	if matched[0].Key != "1" || matched[0].Content != "炸天帮是主角门派" {
		t.Fatalf("常驻条目应排最前: %+v", matched[0])
	}
	byKey := map[string]matchedWorldBookEntry{}
	for _, entry := range matched {
		byKey[entry.Key] = entry
	}
	if byKey["2"].Content != "徐缺带刀" || !byKey["2"].TriggeredByKeyword {
		t.Fatalf("选择性逻辑 AND 未命中: %+v", byKey["2"])
	}
	if !byKey["3"].TriggeredByKeyword || byKey["3"].Sticky != 3 {
		t.Fatalf("粘性条目异常: %+v", byKey["3"])
	}
	// position=after_char → 1
	if byKey["5"].Position != 1 {
		t.Fatalf("position 解析异常: %+v", byKey["5"])
	}
	// 粘性激活（无关键词命中）
	stickyMatch := matchWorldBookEntries(book, "随便聊聊", 10, map[string]bool{"3": true})
	if len(stickyMatch) != 2 || stickyMatch[0].Key != "1" || stickyMatch[1].Key != "3" {
		t.Fatalf("粘性激活应命中常驻+粘性: %+v", stickyMatch)
	}
	if !stickyMatch[1].TriggeredBySticky {
		t.Fatalf("应标记 triggeredBySticky: %+v", stickyMatch[1])
	}
	// maxEntries 截断
	limited := matchWorldBookEntries(book, "徐缺拿出了刀，谈到宗门大会的会后安排", 2, nil)
	if len(limited) != 2 {
		t.Fatalf("maxEntries 截断异常: %d", len(limited))
	}
}

// TestReadWorldBookFilenameChain：文件名匹配链对齐 Node（含 U+2019 弯引号变体）。
func TestReadWorldBookFilenameChain(t *testing.T) {
	dataDir := t.TempDir()
	worldsDir := filepath.Join(dataDir, "worlds")
	if err := os.MkdirAll(worldsDir, 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	// 仅放弯引号变体：直引号候选找不到时必须落到弯引号文件。
	if err := os.WriteFile(filepath.Join(worldsDir, "测试角色’s Lorebook.json"), []byte(`{"entries": []}`), 0o644); err != nil {
		t.Fatalf("写世界书失败: %v", err)
	}
	book, name, err := readWorldBook(dataDir, "测试角色")
	if err != nil || book == nil {
		t.Fatalf("弯引号世界书应被命中: %v %q", err, name)
	}
	if name != "测试角色’s Lorebook.json" {
		t.Fatalf("命中文件名不符: %q", name)
	}
}

func TestRegexProcessorPipeline(t *testing.T) {
	configJSON := []byte(`{
		"chat": {"defaultCharacter": "角色A"},
		"regex": {
			"enabled": true,
			"rules": [
				{"name": "去引号", "pattern": "^[\\\"']+|[\\\"']+$", "flags": "g", "replacement": "", "stage": "output"},
				{"name": "输入清理", "pattern": "\\s{2,}", "flags": "g", "replacement": " ", "stage": "input"}
			]
		},
		"bindings": {
			"角色A": {"regexRules": [{"name": "角色专属", "pattern": "SECRET-[A-Z0-9]+", "flags": "g", "replacement": "[已隐藏]", "stage": "output"}]}
		}
	}`)
	processor := newRegexProcessor(configJSON)
	// 内置 preset 规则 + 全局 2 条 + 角色 1 条 + 内置输出 2 条
	if len(processor.rules) != 5+2+1+2 {
		t.Fatalf("规则合并数异常: %d", len(processor.rules))
	}
	// 输出阶段：内置思考标签移除 + 去引号 + 角色专属
	output := processor.process("\"<thinking>内部思考</thinking>你好 SECRET-A1\"", "output", 0)
	if strings.Contains(output, "thinking") || strings.Contains(output, "SECRET-A1") {
		t.Fatalf("输出正则未生效: %q", output)
	}
	if !strings.Contains(output, "你好") {
		t.Fatalf("正常内容不应被移除: %q", output)
	}
	// 输入阶段：空白压缩
	input := processor.process("你好  很  高兴", "input", 0)
	if input != "你好 很 高兴" {
		t.Fatalf("输入正则未生效: %q", input)
	}
	// 禁用总开关
	processor.enabled = false
	if got := processor.process("<thinking>x</thinking>", "output", 0); got != "<thinking>x</thinking>" {
		t.Fatalf("禁用后不应处理: %q", got)
	}
}

func TestRegexStageNormalization(t *testing.T) {
	if normalizeRuleStage("user_input", false) != "input" || normalizeRuleStage("display", false) != "output" {
		t.Fatal("stage 归一异常")
	}
	if normalizeRuleStage("", true) != "input" {
		t.Fatal("promptOnly 应强制 input")
	}
	// JS flags 转换
	flags := parseJSFlags("gimsu")
	if !strings.Contains(flags, "i") || !strings.Contains(flags, "s") || !strings.Contains(flags, "m") || strings.Contains(flags, "u") {
		t.Fatalf("flags 转换异常: %q", flags)
	}
	if convertJSReplacement("$&后缀") != "${0}后缀" {
		t.Fatalf("$& 转换异常")
	}
}

// TestResolveWorldBookPositionNumeric 数字 position 仅 1 为 after（对齐 Node ===1?1:0）。
func TestResolveWorldBookPositionNumeric(t *testing.T) {
	for _, value := range []any{1, 1.0, "1", "after_char", "post_history"} {
		if got := resolveWorldBookPosition(value); got != 1 {
			t.Fatalf("position %v 应为 1，实际 %d", value, got)
		}
	}
	for _, value := range []any{0, 2, -1, 1.5, "0", "before_char", "unknown", nil} {
		if got := resolveWorldBookPosition(value); got != 0 {
			t.Fatalf("position %v 应为 0，实际 %d", value, got)
		}
	}
}
