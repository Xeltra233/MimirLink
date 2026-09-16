package panel

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mimirlink/internal/config"
	"mimirlink/internal/store"
)

// newKnowledgeTestServer 构造带 mock AI 的面板实例（ai.providers[0] 指向 mock 服务）。
func newKnowledgeTestServer(t *testing.T, aiBaseURL string) (*Server, string) {
	t.Helper()
	root := t.TempDir()
	dataDir := filepath.Join(root, "data")
	for _, dir := range []string{"characters", "worlds", "presets", "chats", "character_overrides"} {
		if err := os.MkdirAll(filepath.Join(dataDir, dir), 0o755); err != nil {
			t.Fatalf("准备目录失败: %v", err)
		}
	}
	aiSection := `"ai": {"activeProviderId": "mock", "timeout": 5, "providers": [{"id": "mock", "type": "openai-compatible", "baseUrl": "` + aiBaseURL + `", "apiKey": "test-key", "model": "test-model"}]},`
	if aiBaseURL == "" {
		aiSection = ""
	}
	raw := []byte(`{
		"auth": {"enabled": false},
		"chat": {"dataDir": "` + filepath.ToSlash(dataDir) + `", "defaultCharacter": "测试角色"},
		"server": {"port": 8139},
		` + aiSection + `
		"memory": {"storage": {"path": "` + strings.ReplaceAll(filepath.Join(dataDir, "chats", "memory.sqlite"), `\`, `\\`) + `"}}
	}`)
	document, err := config.New(filepath.Join(root, "config.json"), raw)
	if err != nil {
		t.Fatalf("构造配置失败: %v", err)
	}
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

// TestSplitImportedNovelText 覆盖 Node splitImportedNovelText 的段落聚合与超长回退。
func TestSplitImportedNovelText(t *testing.T) {
	chunks := splitImportedNovelText("第一段。\n\n第二段。", 200)
	if len(chunks) != 1 || chunks[0] != "第一段。\n\n第二段。" {
		t.Fatalf("段落聚合不符: %#v", chunks)
	}

	long := strings.Repeat("句。", 400) // 800 字，超过 200 上限
	chunks = splitImportedNovelText(long, 200)
	if len(chunks) < 4 {
		t.Fatalf("超长段落未按句子切分: %d 段", len(chunks))
	}
	for _, chunk := range chunks {
		if len([]rune(chunk)) > 200 {
			t.Fatalf("切分结果超过上限: %d", len([]rune(chunk)))
		}
	}

	if chunks := splitImportedNovelText("   ", 1200); len(chunks) != 0 {
		t.Fatalf("空白文本不应有分块: %#v", chunks)
	}
}

// TestParseKnowledgeImportAIResponse 覆盖代码块包裹、数组形式与回退标题。
func TestParseKnowledgeImportAIResponse(t *testing.T) {
	drafts, err := parseKnowledgeImportAIResponse("```json\n{\"entries\":[{\"title\":\"人物\",\"content\":\"张三登场\",\"tags\":[\"人物\",\"\"]}]}\n```")
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(drafts) != 1 || drafts[0].Title != "人物" || drafts[0].Content != "张三登场" || len(drafts[0].Tags) != 1 {
		t.Fatalf("解析结果不符: %#v", drafts)
	}

	drafts, err = parseKnowledgeImportAIResponse(`[{"content":"无标题内容"}]`)
	if err != nil {
		t.Fatalf("数组解析失败: %v", err)
	}
	if len(drafts) != 1 || drafts[0].Title != "提炼知识 1" {
		t.Fatalf("标题回退不符: %#v", drafts)
	}

	if _, err := parseKnowledgeImportAIResponse("不是 JSON"); err == nil {
		t.Fatalf("非法 JSON 应报错")
	}
	if _, err := parseKnowledgeImportAIResponse(`{"entries":[]}`); err == nil {
		t.Fatalf("空条应报错")
	}
}

// TestKnowledgeImportAIPipeline 端到端：文本导入 → mock AI 提炼 → 入库 + 进度完成 + /api/status 暴露进度。
func TestKnowledgeImportAIPipeline(t *testing.T) {
	aiServer := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		body, _ := io.ReadAll(request.Body)
		if !strings.Contains(string(body), "提炼") {
			t.Errorf("提示词缺少提炼指令: %s", string(body)[:min(200, len(body))])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"{\"entries\":[{\"title\":\"人物设定\",\"content\":\"张三：主角，沉稳。\",\"tags\":[\"人物\"]}]}"}}]}`))
	}))
	defer aiServer.Close()

	server, _ := newKnowledgeTestServer(t, aiServer.URL)
	recorder := doRequest(server, http.MethodPost, "/api/memory/knowledge/import",
		`{"text":"第一段。\n\n第二段。","title":"测试导入","knowledgeType":"fixed","chunkSize":1200,"scopeType":"global_shared","scopeKey":"global_shared_memory"}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("导入失败: %d %s", recorder.Code, recorder.Body.String())
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if payload["success"] != true || numberValue(payload["importedCount"]) < 1 || numberValue(payload["chunkCount"]) != 1 {
		t.Fatalf("响应不符: %s", recorder.Body.String())
	}
	items, _ := payload["items"].([]any)
	if len(items) == 0 {
		t.Fatalf("items 为空: %s", recorder.Body.String())
	}
	first, _ := items[0].(map[string]any)
	if textOf(first["title"]) != "人物设定" || textOf(first["content"]) != "张三：主角，沉稳。" {
		t.Fatalf("入库内容不符: %v", first)
	}
	metadata, _ := first["metadata"].(map[string]any)
	if textOf(metadata["source"]) != "novel-import-llm" || textOf(metadata["importMode"]) != "llm-structured" {
		t.Fatalf("metadata 不符: %v", metadata)
	}

	status := doRequest(server, http.MethodGet, "/api/status", "")
	statusPayload := map[string]any{}
	if err := json.Unmarshal(status.Body.Bytes(), &statusPayload); err != nil {
		t.Fatalf("解析状态失败: %v", err)
	}
	progress, _ := statusPayload["knowledgeImportProgress"].(map[string]any)
	if progress == nil || textOf(progress["stage"]) != "completed" || numberValue(progress["savedCount"]) < 1 {
		t.Fatalf("进度不符: %v", statusPayload["knowledgeImportProgress"])
	}
}

// TestKnowledgeImportWithoutAIClient 对齐 Node：没有可用 AI 客户端时返回 500 且进度标记失败。
func TestKnowledgeImportWithoutAIClient(t *testing.T) {
	server, _ := newKnowledgeTestServer(t, "")
	recorder := doRequest(server, http.MethodPost, "/api/memory/knowledge/import",
		`{"text":"一些内容。","title":"无 AI 测试"}`)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("应返回 500，实际 %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "AI 客户端不可用") {
		t.Fatalf("错误信息不符: %s", recorder.Body.String())
	}
	progress := server.knowledgeProgressSnapshot()
	if textOf(progress["stage"]) != "failed" || progress["running"] != false {
		t.Fatalf("进度未标记失败: %v", progress)
	}
}

// TestKnowledgeImportRejectsEmptyText 空文本返回 400（对齐 Node 状态码）。
func TestKnowledgeImportRejectsEmptyText(t *testing.T) {
	server, _ := newKnowledgeTestServer(t, "")
	recorder := doRequest(server, http.MethodPost, "/api/memory/knowledge/import", `{"text":"  "}`)
	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "导入文本不能为空") {
		t.Fatalf("空文本契约不符: %d %s", recorder.Code, recorder.Body.String())
	}
}

func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
