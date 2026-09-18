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
	"mimirlink/internal/metrics"
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
		"chat": {"dataDir": "` + filepath.ToSlash(dataDir) + `", "defaultCharacter": "测试角色", "allowedGroups": ["99001"]},
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

	// 验证 .json.bak 备份文件能正常读取 content，不会错误拼接成 .json.bak.json 报 500
	bakFile := filepath.Join(dataDir, "worlds", "测试世界书.json.bak")
	if err := os.WriteFile(bakFile, encoded, 0o644); err != nil {
		t.Fatalf("写入备份世界书失败: %v", err)
	}
	bakContent := doRequest(server, http.MethodGet, "/api/worldbooks/测试世界书.json.bak/content", "")
	if bakContent.Code != http.StatusOK {
		t.Fatalf("读取 .json.bak 备份世界书 content 失败 (返回 %d): %s", bakContent.Code, bakContent.Body.String())
	}

	// 验证带空格与 URL 编码 (%20) 的文件能正常读取，不报 500
	spaceFile := filepath.Join(dataDir, "worlds", "测试 徐缺's Lorebook.json.bak")
	if err := os.WriteFile(spaceFile, encoded, 0o644); err != nil {
		t.Fatalf("写入带空格备份世界书失败: %v", err)
	}
	spaceContent := doRequest(server, http.MethodGet, "/api/worldbooks/测试%20徐缺's%20Lorebook.json.bak/content", "")
	if spaceContent.Code != http.StatusOK {
		t.Fatalf("读取带 URL 编码的世界书 content 失败 (返回 %d): %s", spaceContent.Code, spaceContent.Body.String())
	}

	// 验证选择 .bak 世界书与获取当前世界书 (/api/worldbooks/current)
	selectResp := doRequest(server, http.MethodPost, "/api/worldbooks/select", `{"filename":"测试 徐缺's Lorebook.json.bak"}`)
	if selectResp.Code != http.StatusOK {
		t.Fatalf("选择 .bak 世界书失败 (返回 %d): %s", selectResp.Code, selectResp.Body.String())
	}
	currentResp := doRequest(server, http.MethodGet, "/api/worldbooks/current", "")
	if currentResp.Code != http.StatusOK {
		t.Fatalf("读取当前 .bak 世界书失败 (返回 %d): %s", currentResp.Code, currentResp.Body.String())
	}
}

// TestCharacterSelectImportsEmbeddedWorldbook 守护「导入内嵌世界书」链路：勾选 importWorldBook 时
// 写出 worlds/<角色名>'s Lorebook.json 并写入角色绑定（此前 Go 版忽略 importOptions，
// 世界书缺失导致前端 content 请求 500）。
func TestCharacterSelectImportsEmbeddedWorldbook(t *testing.T) {
	server, dataDir := newTestServer(t)
	card := map[string]any{
		"name": "徐缺测试",
		"character_book": map[string]any{
			"entries": []any{
				map[string]any{"keys": []any{"徐缺"}, "content": "徐缺条目内容", "insertion_order": 10},
				map[string]any{"key": "老王,老王头", "content": "老王条目内容"},
			},
		},
	}
	if err := characters.Create(dataDir, "徐缺测试", card); err != nil {
		t.Fatalf("创建角色卡失败: %v", err)
	}
	recorder := doRequest(server, http.MethodPost, "/api/characters/select",
		`{"filename":"徐缺测试.png","importOptions":{"importWorldBook":true}}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("select 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	applied, _ := payload["appliedActions"].([]any)
	foundApplied := false
	for _, item := range applied {
		if strings.Contains(textOf(item), "已自动加载内嵌世界书") {
			foundApplied = true
		}
	}
	if !foundApplied {
		t.Fatalf("appliedActions 缺少自动加载提示: %s", recorder.Body.String())
	}
	wbPath := filepath.Join(dataDir, "worlds", "徐缺测试's Lorebook.json")
	raw, err := os.ReadFile(wbPath)
	if err != nil {
		t.Fatalf("世界书未写出: %v", err)
	}
	book := map[string]any{}
	if err := json.Unmarshal(raw, &book); err != nil {
		t.Fatalf("世界书 JSON 非法: %v", err)
	}
	entries, _ := book["entries"].([]any)
	if len(entries) != 2 {
		t.Fatalf("世界书条目数错误: %d (%s)", len(entries), string(raw))
	}
	summary, _ := payload["bindingSummary"].(map[string]any)
	worldbookSummary, _ := summary["worldbook"].(map[string]any)
	if worldbookSummary["value"] != "徐缺测试's Lorebook.json" {
		t.Fatalf("bindingSummary 世界书值错误: %#v", worldbookSummary)
	}
	// 旧缺陷复现点：绑定可解析后 content 必须 200，而不是 500 世界书不存在
	content := doRequest(server, http.MethodGet, "/api/worldbooks/徐缺测试's%20Lorebook.json/content", "")
	if content.Code != http.StatusOK {
		t.Fatalf("content 返回 %d: %s", content.Code, content.Body.String())
	}
}

// TestWorldbookSelectRejectsMissingFile 守护世界书绑定不被坏名字污染：
// 选择不存在的文件应 404 且不更新全局绑定（此前会把回退路径写进绑定，导致 content 500）。
func TestWorldbookSelectRejectsMissingFile(t *testing.T) {
	server, _ := newTestServer(t)
	recorder := doRequest(server, http.MethodPost, "/api/worldbooks/select", `{"filename":"不存在 的世界书.json.bak"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("选择不存在的世界书应 404，实际 %d: %s", recorder.Code, recorder.Body.String())
	}
	if bound := server.document.String("bindings.global.worldbook"); bound != "" {
		t.Fatalf("坏名字不应写入绑定: %q", bound)
	}
}

// TestLLMToggleFlipsState 守护 LLM 开关按钮契约：POST /api/status/llm/toggle 翻转当前状态
// 并返回新值（Node parity）。旧实现把空 body 当作 enabled=false，按钮只能关不能开。
func TestLLMToggleFlipsState(t *testing.T) {
	server, _ := newTestServer(t)

	// 未显式设置时默认开启 → 第一次点击应关闭
	first := doRequest(server, http.MethodPost, "/api/status/llm/toggle", "")
	if first.Code != http.StatusOK {
		t.Fatalf("toggle 返回 %d: %s", first.Code, first.Body.String())
	}
	firstPayload := map[string]any{}
	_ = json.Unmarshal(first.Body.Bytes(), &firstPayload)
	if firstPayload["success"] != true || firstPayload["enabled"] != false {
		t.Fatalf("首次翻转应关闭: %s", first.Body.String())
	}

	// 第二次点击 → 开启
	second := doRequest(server, http.MethodPost, "/api/status/llm/toggle", "")
	secondPayload := map[string]any{}
	_ = json.Unmarshal(second.Body.Bytes(), &secondPayload)
	if secondPayload["enabled"] != true {
		t.Fatalf("第二次翻转应开启: %s", second.Body.String())
	}

	// 状态接口与翻转结果一致
	status := doRequest(server, http.MethodGet, "/api/status/llm", "")
	statusPayload := map[string]any{}
	_ = json.Unmarshal(status.Body.Bytes(), &statusPayload)
	if statusPayload["enabled"] != true {
		t.Fatalf("状态接口应与翻转结果一致: %s", status.Body.String())
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

// TestStatusDashboardCompositionAndOneBot：状态接口的数据构成统计与 OneBot token 指示。
func TestStatusDashboardCompositionAndOneBot(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	for _, dir := range []string{"chats", "characters", "worlds", "presets"} {
		if err := os.MkdirAll(filepath.Join(dataDir, dir), 0o755); err != nil {
			t.Fatalf("准备目录失败: %v", err)
		}
	}
	memoryPath := filepath.Join(dataDir, "chats", "memory.sqlite")
	raw := []byte(`{
		"auth": {"enabled": false},
		"chat": {"dataDir": "` + filepath.ToSlash(dataDir) + `", "defaultCharacter": "测试角色", "sessionMode": "global_shared"},
		"onebot": {"url": "ws://127.0.0.1:1", "mode": "ws", "tokenMode": "header", "accessToken": "e2e-token"},
		"memory": {"storage": {"path": "` + filepath.ToSlash(memoryPath) + `"}}
	}`)
	document, err := config.New(filepath.Join(root, "config.json"), raw)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
	database, err := store.Open(memoryPath)
	if err != nil {
		t.Fatalf("创建记忆库失败: %v", err)
	}
	if err := database.EnsureSchema(); err != nil {
		t.Fatalf("初始化记忆库失败: %v", err)
	}
	options := store.NamespaceOptions{ScopeType: "global"}
	for _, entryType := range []string{"participant_profile", "participant_profile", "knowledge_fixed", "knowledge_dynamic", "conversation"} {
		if _, err := database.AddMemoryEntry(options, store.MemoryEntry{EntryType: entryType, Content: "测试内容 " + entryType}); err != nil {
			t.Fatalf("写入记忆条目失败: %v", err)
		}
	}
	if err := database.AppendMessage(store.Message{ID: "m1", SessionID: "global_shared_memory", Role: "user", Content: "你好", Timestamp: 1000, DateISO: "2026-01-01"}); err != nil {
		t.Fatalf("写入消息失败: %v", err)
	}
	_ = database.Close()

	server, err := NewServer(Options{RootDir: root, Document: document})
	if err != nil {
		t.Fatalf("构造面板失败: %v", err)
	}
	recorder := doRequest(server, http.MethodGet, "/api/status", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态接口失败: %d %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析状态失败: %v", err)
	}
	composition, _ := payload["dashboardMetrics"].(map[string]any)["composition"].(map[string]any)
	if num(composition["participantProfiles"]) != 2 || num(composition["fixedKnowledge"]) != 1 || num(composition["dynamicKnowledge"]) != 1 {
		t.Fatalf("数据构成统计不符: %v", composition)
	}
	if num(composition["messages"]) != 1 {
		t.Fatalf("数据构成消息数不符: %v", composition["messages"])
	}
	globalMemory, _ := payload["globalMemory"].(map[string]any)
	if num(globalMemory["totalSummaries"]) != 0 || globalMemory["sessionMode"] != "global_shared" {
		t.Fatalf("globalMemory 字段不符: %v", globalMemory)
	}
	onebot, _ := payload["onebot"].(map[string]any)
	if onebot["hasToken"] != true || onebot["tokenMode"] != "header" || onebot["mode"] != "ws" {
		t.Fatalf("OneBot 状态不符: %v", onebot)
	}
	if onebot["connected"] != false {
		t.Fatalf("Bot 未运行时不应显示已连接: %v", onebot)
	}
}

// TestMergedDashboardMetrics 守护 /api/status dashboardMetrics 的合并规则：
// bot 序列（经控制口 JSON 往返为 []any）+ 面板本地 knowledgeImport/tts 测试记录。
func TestMergedDashboardMetrics(t *testing.T) {
	server, _ := newTestServer(t)
	server.metrics.Record(metrics.KnowledgeImport, 2)
	server.metrics.Record(metrics.TTS, 1)
	bot := map[string]any{
		"bucketMs": float64(metrics.BucketMs),
		"timeline": []any{float64(1), float64(2), float64(3), float64(4), float64(5), float64(6)},
		"series": map[string]any{
			"chat":               []any{float64(0), float64(0), float64(0), float64(0), float64(0), float64(3)},
			"participantProfile": []any{float64(0), float64(0), float64(0), float64(0), float64(0), float64(1)},
			"tts":                []any{float64(0), float64(0), float64(0), float64(0), float64(0), float64(2)},
			"knowledgeImport":    []any{float64(0), float64(0), float64(0), float64(0), float64(0), float64(0)},
		},
	}
	merged := server.mergedDashboardMetrics(bot, store.CompositionCounts{}, store.Counts{})
	if merged["bucketMs"] != metrics.BucketMs {
		t.Fatalf("bucketMs 应为 %d，实际 %v", metrics.BucketMs, merged["bucketMs"])
	}
	series, _ := merged["series"].(map[string]any)
	chat, _ := series["chat"].([]float64)
	if len(chat) != 6 || chat[5] != 3 {
		t.Fatalf("chat 应来自 bot 序列: %v", chat)
	}
	profile, _ := series["participantProfile"].([]float64)
	if len(profile) != 6 || profile[5] != 1 {
		t.Fatalf("participantProfile 应来自 bot 序列: %v", profile)
	}
	tts, _ := series["tts"].([]float64)
	if len(tts) != 6 || tts[5] != 3 {
		t.Fatalf("tts 应为 bot(2)+面板(1)：%v", tts)
	}
	knowledge, _ := series["knowledgeImport"].([]float64)
	if len(knowledge) != 6 || knowledge[5] != 2 {
		t.Fatalf("knowledgeImport 应来自面板本地序列: %v", knowledge)
	}
	timeline, _ := merged["timeline"].([]any)
	if len(timeline) != 6 {
		t.Fatalf("timeline 应保留 6 桶: %v", timeline)
	}
}

func num(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	default:
		return -1
	}
}

// TestAudioFilePublicNoAuth /audio 公开可播（对齐 Node express.static 无鉴权）。
func TestAudioFilePublicNoAuth(t *testing.T) {
	server, _ := newTestServer(t)
	// 写一个 tts_ 前缀音频文件到 AudioDir
	name := "tts_test_public.mp3"
	if err := os.WriteFile(filepath.Join(server.AudioDir(), name), []byte("fake-audio"), 0o644); err != nil {
		t.Fatalf("写音频失败: %v", err)
	}
	recorder := doRequest(server, http.MethodGet, "/audio/"+name, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("/audio 应公开可播，实际状态 %d", recorder.Code)
	}
	if recorder.Body.String() != "fake-audio" {
		t.Fatalf("音频内容异常: %q", recorder.Body.String())
	}
	// 路径穿越（Go ServeMux 会先 307 清理 ..；编码穿越直达 handler，应被 Base 截断为 404）与非 tts_ 前缀仍 404
	if rec := doRequest(server, http.MethodGet, "/audio/%2e%2e/config.json", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("路径穿越应 404，实际 %d", rec.Code)
	}
	if rec := doRequest(server, http.MethodGet, "/audio/other.mp3", ""); rec.Code != http.StatusNotFound {
		t.Fatalf("非 tts_ 前缀应 404，实际 %d", rec.Code)
	}
}

// TestMCPDisabledReturns404 mcp.enabled=false 时端点停用（对齐 Node 不挂载）。
func TestMCPDisabledReturns404(t *testing.T) {
	server, _ := newTestServer(t)
	// 默认未配置 mcp.enabled：端点可用
	if rec := doRequest(server, http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"ping"}`); rec.Code == http.StatusNotFound {
		t.Fatalf("默认应挂载 MCP 端点，实际 404")
	}
	// 显式禁用：404
	if err := server.document.Set("mcp.enabled", false); err != nil {
		t.Fatalf("写配置失败: %v", err)
	}
	recorder := doRequest(server, http.MethodPost, "/mcp", `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("禁用后应 404，实际 %d", recorder.Code)
	}
}

// TestClearInactiveSessions 验证 DELETE /api/sessions 批量清理空会话。
func TestClearInactiveSessions(t *testing.T) {
	server, _ := newTestServer(t)
	db, _, err := server.openActiveMemory()
	if err != nil {
		t.Fatalf("打开记忆库失败: %v", err)
	}
	defer db.Close()

	// 创建一个空会话（无消息）和一个活跃会话（有消息）
	_ = db.EnsureSession("empty-session")
	_ = db.EnsureSession("active-session")
	_ = db.AppendMessage(store.Message{SessionID: "active-session", Role: "user", Content: "你好"})

	recorder := doRequest(server, http.MethodDelete, "/api/sessions", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("DELETE /api/sessions 返回 %d: %s", recorder.Code, recorder.Body.String())
	}
	var res map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &res)
	if res["success"] != true || intOr(res["deletedCount"], 0) != 1 {
		t.Fatalf("清理结果异常: %+v", res)
	}

	sessions, _ := db.ListSessions(100)
	if len(sessions) != 1 || sessions[0].ID != "active-session" {
		t.Fatalf("应仅保留 active-session，实际: %+v", sessions)
	}
}
