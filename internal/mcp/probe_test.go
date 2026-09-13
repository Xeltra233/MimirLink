package mcp

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// 用真实配置（隔离实例）验证 MCP 连接与工具清单。
func TestRealConfigProbe(t *testing.T) {
	configPath := filepath.Join("..", "..", "goal-33", "e2e", "app", "config.json")
	raw, err := os.ReadFile(configPath)
	if err != nil {
		t.Skipf("跳过：找不到真实配置 %s", configPath)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("解析配置失败: %v", err)
	}
	section, _ := document["mcp"].(map[string]any)
	config := LoadConfig(section)
	t.Logf("enabled=%v servers=%d", config.Enabled, len(config.Servers))
	for index, server := range config.Servers {
		t.Logf("  [%d] id=%q name=%s transport=%s command=%s url=%s enabled=%v include=%v exclude=%v",
			index, server.ID, server.Name, server.Transport, server.Command, server.URL, server.Enabled,
			server.ToolFilter.Include, server.ToolFilter.Exclude)
	}
	client := New(config, testLogger{t})
	client.ConnectAll(context.Background())
	defer client.Close()
	client.mu.Lock()
	for key, entry := range client.servers {
		t.Logf("服务器键=%q 名称=%s 工具=%d 传输=%v 错误=%q", key, entry.config.Name, len(entry.tools), entry.transport != nil, entry.lastError)
	}
	client.mu.Unlock()
	definitions := client.Definitions()
	t.Logf("Definitions() 返回 %d 个工具", len(definitions))
	for _, item := range definitions {
		t.Logf("  %s [%s] %s", item.Name, item.ServerName, item.ToolName)
	}
}
