package characters

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCreateReadUpdateRoundTrip 复现并守护 goal-36 发现的角色卡写回缺陷：
//   - 新建 PNG 角色卡后能被读回；
//   - 标准字段（personality 等）改写进 PNG 内嵌数据，重读可见；
//   - 非标准字段写入 character_overrides 覆盖层，重读合并可见；
//   - 覆盖层文件本身不包含标准字段。
func TestCreateReadUpdateRoundTrip(t *testing.T) {
	dataDir := t.TempDir()
	card := map[string]any{
		"name":        "测试角色",
		"description": "原始描述",
		"personality": "沉稳",
		"first_mes":   "你好",
		"character_book": map[string]any{
			"entries": []any{map[string]any{"keys": []any{"测试"}, "content": "条目"}},
		},
	}
	if err := Create(dataDir, "测试角色", card); err != nil {
		t.Fatalf("Create 失败: %v", err)
	}
	pngPath := filepath.Join(dataDir, "characters", "测试角色.png")
	if _, err := os.Stat(pngPath); err != nil {
		t.Fatalf("PNG 未生成: %v", err)
	}

	read, err := Read(dataDir, "测试角色")
	if err != nil {
		t.Fatalf("Read 失败: %v", err)
	}
	if read["name"] != "测试角色" || read["description"] != "原始描述" {
		t.Fatalf("读回内容不符: %#v", read)
	}

	// 标准字段 + 本地字段
	updated, err := Update(dataDir, "测试角色", map[string]any{"personality": "活泼", "custom_flag": "on"})
	if err != nil {
		t.Fatalf("Update 失败: %v", err)
	}
	if updated["personality"] != "活泼" {
		t.Fatalf("标准字段未写回 PNG: %#v", updated["personality"])
	}
	if updated["custom_flag"] != "on" {
		t.Fatalf("本地字段未写入覆盖层: %#v", updated["custom_flag"])
	}

	// 重新读（模拟下一次请求）
	again, err := Read(dataDir, "测试角色")
	if err != nil {
		t.Fatalf("二次 Read 失败: %v", err)
	}
	if again["personality"] != "活泼" || again["custom_flag"] != "on" {
		t.Fatalf("更新未持久化: %#v", again)
	}

	// 覆盖层不应残留标准字段
	overrides := ReadOverrides(dataDir, "测试角色")
	if _, ok := overrides["personality"]; ok {
		t.Fatalf("覆盖层残留标准字段 personality: %#v", overrides)
	}
	if overrides["custom_flag"] != "on" {
		t.Fatalf("覆盖层缺少本地字段: %#v", overrides)
	}

	// PNG 仍是合法 PNG 且 chara 数据块可解析
	if payload, err := readPNGText(pngPath); err != nil || payload == nil {
		t.Fatalf("PNG 内嵌数据不可解析: %v", err)
	}
}

// TestUpdateMissingCard 角色卡不存在时应返回错误而不是静默新建。
func TestUpdateMissingCard(t *testing.T) {
	dataDir := t.TempDir()
	if _, err := Update(dataDir, "不存在的角色", map[string]any{"personality": "X"}); err == nil {
		t.Fatal("对不存在的角色卡执行 Update 应报错")
	}
}
