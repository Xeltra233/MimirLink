package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mimirlink/internal/characters"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

// newTestServer 构造一个使用临时目录、关闭鉴权的面板实例。
func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	for _, dir := range []string{"characters", "worlds", "presets", "chats", "character_overrides"} {
		if err := os.MkdirAll(filepath.Join(dataDir, dir), 0o755); err != nil {
			t.Fatalf("准备目录失败: %v", err)
		}
	}
	raw := []byte(`{
		"auth": {"enabled": false},
		"chat": {"dataDir": "` + strings.ReplaceAll(dataDir, `\`, `\\`) + `", "defaultCharacter": "测试角色"},
		"server": {"port": 8139},
		"memory": {"storage": {"path": "` + strings.ReplaceAll(filepath.Join(dataDir, "chats", "memory.sqlite"), `\`, `\\`) + `"}}
	}`)
	document, err := config.New(filepath.Join(root, "config.json"), raw)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	// 记忆库需要真实存在（与运行时一致）
	database, err := store.Open(filepath.Join(dataDir, "chats", "memory.sqlite"))
	if err != nil {
		t.Fatalf("创建记忆库失败: %v", err)
	}
	if err := database.EnsureSchema(); err != nil {
		t.Fatalf("初始化记忆库失败: %v", err)
	}
	_ = database.Close()
	server, err := NewServer(Options{RootDir: root, Document: document})
	if err != nil {
		t.Fatalf("构造面板失败: %v", err)
	}
	return server, dataDir
}

func doRequest(server *Server, method string, path string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	server.Handler().ServeHTTP(recorder, request)
	return recorder
}

// TestCharacterDetailDoesNotRecurse 守护 goal-36 发现的 P0 缺陷：
// GET /api/characters/:name/detail 曾与 handleCharacterManage 互相递归导致栈溢出杀进程。
func TestCharacterDetailDoesNotRecurse(t *testing.T) {
	server, dataDir := newTestServer(t)
	card := map[string]any{"name": "测试角色", "description": "描述", "personality": "沉稳"}
	if err := characters.Create(dataDir, "测试角色", card); err != nil {
		t.Fatalf("创建角色卡失败: %v", err)
	}
	recorder := doRequest(server, http.MethodGet, "/api/characters/测试角色/detail", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("detail 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	if payload["success"] != true || payload["character"] == nil {
		t.Fatalf("detail 响应结构异常: %s", recorder.Body.String())
	}
	// Node 契约字段
	for _, key := range []string{"importedMetadata", "importPlan", "bindingSummary", "variableScanSummary"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("detail 缺少字段 %s", key)
		}
	}

	// 未知子路径不得递归：应返回 404 结构化错误
	unknown := doRequest(server, http.MethodGet, "/api/characters/测试角色/nope/deep", "")
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("未知子路径返回 %d: %s", unknown.Code, unknown.Body.String())
	}
}

// TestCharacterUpdateWritesPNG 守护角色卡更新落盘（写入 PNG 内嵌数据而非旁路 JSON）。
func TestCharacterUpdateWritesPNG(t *testing.T) {
	server, dataDir := newTestServer(t)
	if err := characters.Create(dataDir, "测试角色", map[string]any{"name": "测试角色", "personality": "沉稳"}); err != nil {
		t.Fatalf("创建角色卡失败: %v", err)
	}
	recorder := doRequest(server, http.MethodPost, "/api/characters/测试角色/update", `{"personality":"活泼"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("update 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	read, err := characters.Read(dataDir, "测试角色")
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if read["personality"] != "活泼" {
		t.Fatalf("更新未落盘: %#v", read["personality"])
	}
	if _, err := os.Stat(filepath.Join(dataDir, "characters", "测试角色.json")); err == nil {
		t.Fatal("不应再旁路写 characters/测试角色.json")
	}
}

// TestWorldbookContentAndSaveContract 守护世界书内容/保存的 Node 契约（{success, worldbook}）。
func TestWorldbookContentAndSaveContract(t *testing.T) {
	server, dataDir := newTestServer(t)
	worldbook := map[string]any{"name": "测试世界书", "entries": []any{map[string]any{"content": "旧内容"}}}
	encoded, _ := json.Marshal(worldbook)
	if err := os.WriteFile(filepath.Join(dataDir, "worlds", "测试角色.json"), encoded, 0o644); err != nil {
		t.Fatalf("写入世界书失败: %v", err)
	}

	content := doRequest(server, http.MethodGet, "/api/worldbooks/测试角色.json/content", "")
	if content.Code != http.StatusOK {
		t.Fatalf("content 返回 %d: %s", content.Code, content.Body.String())
	}
	payload := map[string]any{}
	_ = json.Unmarshal(content.Body.Bytes(), &payload)
	if payload["success"] != true || payload["worldbook"] == nil {
		t.Fatalf("content 响应结构异常: %s", content.Body.String())
	}

	save := doRequest(server, http.MethodPost, "/api/worldbooks/测试角色.json/save",
		`{"worldbook":{"name":"测试世界书","entries":[{"content":"新内容"}]}}`)
	if save.Code != http.StatusOK {
		t.Fatalf("save 返回 %d: %s", save.Code, save.Body.String())
	}
	raw, err := os.ReadFile(filepath.Join(dataDir, "worlds", "测试角色.json"))
	if err != nil {
		t.Fatalf("读取世界书失败: %v", err)
	}
	if !strings.Contains(string(raw), "新内容") {
		t.Fatalf("保存未落盘: %s", string(raw))
	}
	// 缺少 worldbook 字段时应报 400（不再是静默写空文件）
	missing := doRequest(server, http.MethodPost, "/api/worldbooks/测试角色.json/save", `{"foo":"bar"}`)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("缺少 worldbook 应返回 400，实际 %d", missing.Code)
	}
}

// TestRegexLayerConfigPaths 守护正则规则写在 Node 的绑定层键上（bindings.global.regexRules），
// 旧实现写到了 regex.global，面板读不到、Node 版也读不到。
func TestRegexLayerConfigPaths(t *testing.T) {
	server, dataDir := newTestServer(t)
	if err := characters.Create(dataDir, "测试角色", map[string]any{"name": "测试角色"}); err != nil {
		t.Fatalf("创建角色卡失败: %v", err)
	}
	// 新增
	if recorder := doRequest(server, http.MethodPost, "/api/regex?targetLayer=global", `{"name":"规则A","pattern":"/a/g","replacement":"b"}`); recorder.Code != http.StatusOK {
		t.Fatalf("POST /api/regex 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	// 读取
	recorder := doRequest(server, http.MethodGet, "/api/regex?targetLayer=global", "")
	var rules []map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &rules); err != nil {
		t.Fatalf("规则列表不是数组: %s", recorder.Body.String())
	}
	if len(rules) != 1 || rules[0]["name"] != "规则A" {
		t.Fatalf("规则未写入绑定层: %s", recorder.Body.String())
	}
	// 更新
	if recorder := doRequest(server, http.MethodPut, "/api/regex/0", `{"targetLayer":"global","replacement":"c"}`); recorder.Code != http.StatusOK {
		t.Fatalf("PUT /api/regex/0 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	// 删除（越界也应成功，对齐 Node）
	if recorder := doRequest(server, http.MethodDelete, "/api/regex/9?targetLayer=global", ""); recorder.Code != http.StatusOK {
		t.Fatalf("DELETE 越界返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder := doRequest(server, http.MethodDelete, "/api/regex/0?targetLayer=global", ""); recorder.Code != http.StatusOK {
		t.Fatalf("DELETE 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	after := doRequest(server, http.MethodGet, "/api/regex?targetLayer=global", "")
	var remaining []map[string]any
	_ = json.Unmarshal(after.Body.Bytes(), &remaining)
	if len(remaining) != 0 {
		t.Fatalf("删除后仍有规则: %s", after.Body.String())
	}
	// 导出应包含预设默认规则（对齐 Node RegexProcessor.getRules）
	exported := doRequest(server, http.MethodGet, "/api/regex/export", "")
	var payload map[string]any
	if err := json.Unmarshal(exported.Body.Bytes(), &payload); err != nil {
		t.Fatalf("导出不是 JSON: %v", err)
	}
	exportedRules, _ := payload["rules"].([]any)
	if len(exportedRules) == 0 {
		t.Fatalf("导出规则为空: %s", exported.Body.String())
	}
}

// TestMemoryExportShape 守护 /api/memory/export 的导出结构（前端导出按钮依赖）。
func TestMemoryExportShape(t *testing.T) {
	server, _ := newTestServer(t)
	recorder := doRequest(server, http.MethodGet, "/api/memory/export", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("export 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("导出不是 JSON: %v", err)
	}
	for _, key := range []string{"sessions", "knowledge", "globalTimeline", "stats", "exportDate", "storage"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("导出缺少字段 %s", key)
		}
	}
}

// TestStatusShape 守护 /api/status 的字段（仪表盘依赖）。
func TestStatusShape(t *testing.T) {
	server, _ := newTestServer(t)
	recorder := doRequest(server, http.MethodGet, "/api/status", "")
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("status 不是 JSON: %v", err)
	}
	for _, key := range []string{"version", "uptime", "memory", "llmEnabled", "onebot", "character", "worldbook", "activeMemory", "corpusEmbedProgress", "server"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("status 缺少字段 %s", key)
		}
	}
}

// TestDataClearConfirmContract 守护 /api/data/clear 的 Node 契约：
// confirm=true 清库；无 confirm 且无 targets 时返回 400（不再假成功）。
func TestDataClearConfirmContract(t *testing.T) {
	server, _ := newTestServer(t)
	// 未确认 → 400
	if recorder := doRequest(server, http.MethodPost, "/api/data/clear", `{}`); recorder.Code != http.StatusBadRequest {
		t.Fatalf("缺少 confirm 应返回 400，实际 %d: %s", recorder.Code, recorder.Body.String())
	}
	// 确认 → 清库并返回 cleared 计数
	recorder := doRequest(server, http.MethodPost, "/api/data/clear", `{"confirm":true}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("confirm=true 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	_ = json.Unmarshal(recorder.Body.Bytes(), &payload)
	if payload["success"] != true || payload["cleared"] == nil {
		t.Fatalf("清空响应结构异常: %s", recorder.Body.String())
	}
	// targets 扩展仍然可用
	targets := doRequest(server, http.MethodPost, "/api/data/clear", `{"targets":["logs"]}`)
	if targets.Code != http.StatusOK {
		t.Fatalf("targets 清理返回 %d: %s", targets.Code, targets.Body.String())
	}
}
