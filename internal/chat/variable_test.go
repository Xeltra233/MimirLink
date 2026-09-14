package chat

import (
	"strings"
	"testing"

	"mimirlink/internal/store"
)

// TestExtractTaggedContent：标签提取（大小写不敏感、带属性、无块回退原文）。
func TestExtractTaggedContent(t *testing.T) {
	if got := extractTaggedContent("前置<thinking>思考内容</thinking>后置", "thinking"); got != "思考内容" {
		t.Fatalf("标签提取异常: %q", got)
	}
	if got := extractTaggedContent("<CONTENT details-x>带属性</CONTENT>", "content"); got != "带属性" {
		t.Fatalf("大小写与属性支持异常: %q", got)
	}
	if got := extractVisibleContent("普通文本"); got != "普通文本" {
		t.Fatalf("无 content 块应回退原文: %q", got)
	}
	if got := extractVisibleContent("a<content>可见</content>b"); got != "可见" {
		t.Fatalf("content 块提取异常: %q", got)
	}
}

// TestStripInternalTags：内部标签剥离（保留 UpdateVariable、删 thinking、去 HTML、未闭合尾部）。
func TestStripInternalTags(t *testing.T) {
	input := `<UpdateVariable>
[{"op":"replace","path":"/好感度","value":50}]
</UpdateVariable>
<thinking class="x">内部思考</thinking>
<details>状态面板</details>
<div style="x">残留</div>
可见回复`
	output := stripInternalTags(input)
	if !strings.Contains(output, "UpdateVariable") {
		t.Fatalf("UpdateVariable 应保留: %s", output)
	}
	if strings.Contains(output, "内部思考") || strings.Contains(output, "thinking") {
		t.Fatalf("thinking 应连内容删除: %s", output)
	}
	if strings.Contains(output, "details") {
		t.Fatalf("details 标签应剥离（内容保留）: %s", output)
	}
	if !strings.Contains(output, "状态面板") || !strings.Contains(output, "可见回复") {
		t.Fatalf("可见内容应保留: %s", output)
	}
	if strings.Contains(output, "<div") {
		t.Fatalf("残留 HTML 应去除: %s", output)
	}
	// 未闭合 thinking 到结尾全部删除
	if output2 := stripInternalTags("开头<thinking>未闭合全部是思考"); strings.Contains(output2, "未闭合全部是思考") {
		t.Fatalf("未闭合标签应删除到结尾: %q", output2)
	}
}

// TestParseLiteralAndInfer：字面量解析与类型推断。
func TestParseLiteralAndInfer(t *testing.T) {
	if parseLiteralValue("true") != true || parseLiteralValue("FALSE") != false {
		t.Fatal("布尔解析异常")
	}
	if v := parseLiteralValue("3.5"); v != 3.5 {
		t.Fatalf("数字解析异常: %v", v)
	}
	if v := parseLiteralValue("  文本 "); v != "文本" {
		t.Fatalf("字符串应裁剪: %v", v)
	}
	if inferType(3.5) != "number" || inferType(true) != "boolean" || inferType("x") != "string" || inferType(map[string]any{}) != "json" {
		t.Fatal("类型推断异常")
	}
	if normalizePatchPath("/stat_data/好感度") != "stat_data.好感度" {
		t.Fatalf("路径归一化异常: %s", normalizePatchPath("/stat_data/好感度"))
	}
	if normalizeLookupKey("stat_data.角色.好感度") != "角色.好感度" {
		t.Fatalf("查找键归一化异常")
	}
}

// TestUpdateVariableExtraction：块解析、协议检测、清洗。
func TestUpdateVariableExtraction(t *testing.T) {
	runtime, _, memory := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	runtime.rootDir = t.TempDir()
	input := `回复正文
<UpdateVariable>
[{"op":"replace","path":"/stat_data/角色/好感度","value":88},{"op":"remove","path":"/旧变量"}]
</UpdateVariable>`
	scope := storeScope(memory)
	extraction := runtime.extractAndApplyVariables(input, scope)
	if !extraction.ProtocolPresent || extraction.BlockCount != 1 {
		t.Fatalf("协议检测异常: %+v", extraction)
	}
	if len(extraction.Applied) != 2 {
		t.Fatalf("应应用 2 个补丁: %+v", extraction.Applied)
	}
	if strings.Contains(extraction.CleanedOutput, "UpdateVariable") || !strings.Contains(extraction.CleanedOutput, "回复正文") {
		t.Fatalf("清洗输出异常: %q", extraction.CleanedOutput)
	}
	// 空数组也算协议存在
	empty := runtime.extractAndApplyVariables("文本<UpdateVariable>[]</UpdateVariable>", scope)
	if !empty.ProtocolPresent || len(empty.Applied) != 0 {
		t.Fatalf("空数组协议异常: %+v", empty)
	}
}

// TestVariableMacrosAndStatus：宏解析 + setvar + 状态块。
func TestVariableMacrosAndStatus(t *testing.T) {
	runtime, _, _ := newRuntime(t, nil, &fakeModel{replies: []string{"ok"}})
	runtime.rootDir = t.TempDir()
	scope := storeScope(runtime.memory)

	// 静态 setvar 写入
	text := `介绍{{setvar::好感度::60}}结束`
	cleaned, applied := runtime.applyStaticSetvarsFromText(text, scope, false)
	if len(applied) != 1 || cleaned != "介绍结束" {
		t.Fatalf("setvar 异常: cleaned=%q applied=%v", cleaned, applied)
	}
	// 宏解析
	resolved := runtime.resolveVariableMacros("当前好感 {{getvar::好感度}} / {{get_message_variable::stat_data.好感度}}", scope)
	if strings.Contains(resolved, "{{") || !strings.Contains(resolved, "60") {
		t.Fatalf("宏解析异常: %q", resolved)
	}
	// 状态块
	block := runtime.buildVariableStatusBlock(scope)
	if !strings.Contains(block, "好感度: 60") {
		t.Fatalf("状态块异常: %q", block)
	}
	// 未知宏保持原样
	if kept := runtime.resolveVariableMacros("{{getvar::不存在}}", scope); !strings.Contains(kept, "{{getvar::不存在}}") {
		t.Fatalf("未知宏应保留: %q", kept)
	}
	// 变量值更新后宏跟随
	_, _, err := runtime.memory.UpsertVariable(scope, storeVariable("好感度", "99"))
	if err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if updated := runtime.resolveVariableMacros("好感 {{getvar::好感度}}", scope); !strings.Contains(updated, "99") {
		t.Fatalf("更新后宏应取新值: %q", updated)
	}
	// remove 补丁
	if extraction := runtime.extractAndApplyVariables(`<UpdateVariable>[{"op":"remove","path":"/好感度"}]</UpdateVariable>`, scope); len(extraction.Applied) != 1 {
		t.Fatalf("remove 补丁应应用: %+v", extraction.Applied)
	}
	if after := runtime.resolveVariableMacros("{{getvar::好感度}}", scope); !strings.Contains(after, "{{getvar::好感度}}") {
		t.Fatalf("删除后宏应不再解析: %q", after)
	}
}

// storeScope / storeVariable 是测试辅助。
func storeScope(_ any) store.NamespaceOptions {
	return store.NamespaceOptions{ScopeType: "user_persistent", ScopeKey: "user:2001"}
}

func storeVariable(key string, value string) store.Variable {
	return store.Variable{Key: key, RawValue: value, ValueType: "string", Metadata: map[string]any{"source": "ai"}}
}
