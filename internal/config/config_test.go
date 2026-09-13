package config

import (
	"os"
	"path/filepath"
	"testing"
)

const fixture = `{
  "auth": {
    "enabled": false,
    "password": "keep-me"
  },
  "ai": {
    "apiKey": "sk-test",
    "providers": [
      { "id": "p1", "apiKey": "sk-p1" }
    ]
  },
  "chat": {
    "model": "[Antigravity渠道] gemini-3.8-flash-high",
    "maxToolRounds": 0
  },
  "unknownFutureKey": {
    "nested": [1, 2, 3],
    "flag": true
  }
}`

func writeFixture(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("写入夹具失败: %v", err)
	}
	return path
}

func TestLoadAndReadValues(t *testing.T) {
	path := writeFixture(t, fixture)
	document, err := Load(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if got := document.String("chat.model"); got != "[Antigravity渠道] gemini-3.8-flash-high" {
		t.Fatalf("model 读取错误: %q", got)
	}
	if got := document.Int("chat.maxToolRounds", -1); got != 0 {
		t.Fatalf("maxToolRounds 读取错误: %d", got)
	}
	if document.Bool("auth.enabled") {
		t.Fatalf("auth.enabled 应为 false")
	}
	if got := document.String("ai.providers.0.apiKey"); got != "sk-p1" {
		t.Fatalf("providers 数组读取错误: %q", got)
	}
	keys := document.Keys()
	expected := []string{"auth", "ai", "chat", "unknownFutureKey"}
	if len(keys) != len(expected) {
		t.Fatalf("顶层键数量不符: %v", keys)
	}
	for index, key := range expected {
		if keys[index] != key {
			t.Fatalf("顶层键顺序不符，期望 %v，实际 %v", expected, keys)
		}
	}
}

func TestSetPreservesUnknownKeysAndOrder(t *testing.T) {
	path := writeFixture(t, fixture)
	document, err := Load(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if err := document.Set("chat.maxToolRounds", 5); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := document.Save(); err != nil {
		t.Fatalf("保存失败: %v", err)
	}

	reloaded, err := Load(path)
	if err != nil {
		t.Fatalf("重新加载失败: %v", err)
	}
	if got := reloaded.Int("chat.maxToolRounds", -1); got != 5 {
		t.Fatalf("写入未生效: %d", got)
	}
	if got := reloaded.String("auth.password"); got != "keep-me" {
		t.Fatalf("无关字段被破坏: %q", got)
	}
	if !reloaded.Exists("unknownFutureKey.nested.2") {
		t.Fatalf("未知键在保存后丢失")
	}
	if got := reloaded.Get("unknownFutureKey.nested").Array(); len(got) != 3 {
		t.Fatalf("未知键内容被破坏: %v", got)
	}
	keys := reloaded.Keys()
	if len(keys) != 4 || keys[3] != "unknownFutureKey" {
		t.Fatalf("保存后键顺序变化: %v", keys)
	}
}

func TestFormattedMatchesNodeStyle(t *testing.T) {
	document, err := New("/tmp/config.json", []byte("{\"a\":1,\"b\":{\"c\":[1,2]}}"))
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	formatted, err := document.Formatted()
	if err != nil {
		t.Fatalf("格式化失败: %v", err)
	}
	expected := "{\n  \"a\": 1,\n  \"b\": {\n    \"c\": [\n      1,\n      2\n    ]\n  }\n}"
	if string(formatted) != expected {
		t.Fatalf("格式与 Node 不一致:\n%s", formatted)
	}
}

func TestSaveToKeepsOriginalUntouched(t *testing.T) {
	path := writeFixture(t, fixture)
	document, err := Load(path)
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	target := filepath.Join(t.TempDir(), "copy.json")
	if err := document.Set("chat.model", "changed"); err != nil {
		t.Fatalf("写入失败: %v", err)
	}
	if err := document.SaveTo(target); err != nil {
		t.Fatalf("另存失败: %v", err)
	}
	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取原文件失败: %v", err)
	}
	if string(original) != fixture {
		t.Fatalf("SaveTo 不应修改原文件")
	}
	copied, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("读取副本失败: %v", err)
	}
	if string(copied) == fixture {
		t.Fatalf("副本应包含修改")
	}
}

func TestLoadRejectsInvalidJSON(t *testing.T) {
	path := writeFixture(t, "{ not json }")
	if _, err := Load(path); err == nil {
		t.Fatalf("非法 JSON 应返回错误")
	}
}

func TestDeletePath(t *testing.T) {
	document, err := New("/tmp/config.json", []byte(`{"keep":1,"drop":2}`))
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	if err := document.Delete("drop"); err != nil {
		t.Fatalf("删除失败: %v", err)
	}
	if document.Exists("drop") {
		t.Fatalf("删除未生效")
	}
	if !document.Exists("keep") {
		t.Fatalf("其他字段被误删")
	}
}
