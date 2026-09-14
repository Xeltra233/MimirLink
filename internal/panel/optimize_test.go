package panel

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"mimirlink/internal/ai"
)

// optimizeStub 返回固定 JSON 的桩模型，用于验证 optimize-step 的解析与判定。
func optimizeStub(t *testing.T, payload string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		body := map[string]any{
			"choices": []map[string]any{{"message": map[string]any{"role": "assistant", "content": payload}}},
		}
		_ = json.NewEncoder(writer).Encode(body)
	}))
	t.Cleanup(server.Close)
	return server
}

func configureOptimizeProvider(t *testing.T, server *Server, baseURL string) {
	t.Helper()
	if err := server.document.Set("ai.providers", []any{
		map[string]any{"id": "judge", "baseUrl": baseURL + "/v1", "apiKey": "k", "model": "judge-model"},
	}); err != nil {
		t.Fatalf("写供应商失败: %v", err)
	}
	if err := server.document.Set("ai.activeProviderId", "judge"); err != nil {
		t.Fatalf("写激活供应商失败: %v", err)
	}
}

// TestOptimizeStepParsesNodeSchema 守护 optimize-step 对齐 Node 的响应结构：
// elo(result/reasoning/history/bWins)、evaluation(issues/highlights)、
// modifiedPrompts/Character/WorldBook 归一化为 allChanges、decision 与停轮判定。
func TestOptimizeStepParsesNodeSchema(t *testing.T) {
	server, _ := newTestServer(t)
	stub := optimizeStub(t, `{
		"decision": "modify",
		"elo": {"result": "B_wins", "reasoning": "新版去掉了八股"},
		"evaluation": {"issues": ["仍有微表情"], "highlights": ["更贴近语料"]},
		"modifiedPrompts": [{"identifier": "main", "oldContent": "旧", "newContent": "新"}],
		"modifiedCharacter": [{"field": "personality", "oldContent": "沉稳", "newContent": "沉稳但话少"}],
		"modifiedWorldBook": [{"index": -1, "action": "add", "entry": {"content": "夜色设定"}}],
		"nextTestMessage": "换个话题再试",
		"changeSummary": "砍八股"
	}`)
	configureOptimizeProvider(t, server, stub.URL)

	body := `{"goal":"去八股","iterationNumber":1,"maxIterations":5,"lastUserMessage":"你好","lastAIResponse":"似乎有一股涟漪"}`
	recorder := doRequest(server, "POST", "/api/prompt-range/optimize-step", body)
	if recorder.Code != 200 {
		t.Fatalf("状态码应为 200，实际 %d：%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeJSON(t, recorder.Body.Bytes())
	if payload["success"] != true {
		t.Fatalf("success 应为 true：%+v", payload)
	}
	elo, _ := payload["elo"].(map[string]any)
	if elo["result"] != "B_wins" || elo["reasoning"] != "新版去掉了八股" {
		t.Fatalf("elo 结果不符：%+v", elo)
	}
	if elo["bWins"] != float64(1) {
		t.Fatalf("bWins 应为 1：%+v", elo["bWins"])
	}
	history, _ := elo["history"].([]any)
	if len(history) != 1 || history[0] != "B_wins" {
		t.Fatalf("elo 历史不符：%+v", history)
	}
	evaluation, _ := payload["evaluation"].(map[string]any)
	issues, _ := evaluation["issues"].([]any)
	if len(issues) != 1 {
		t.Fatalf("evaluation.issues 解析失败：%+v", evaluation)
	}
	changes, _ := payload["allChanges"].([]any)
	if len(changes) != 3 {
		t.Fatalf("三类修改应归一化为 3 条 allChanges，实际 %d", len(changes))
	}
	types := map[string]bool{}
	for _, item := range changes {
		change, _ := item.(map[string]any)
		types[textOf(change["type"])] = true
	}
	for _, expected := range []string{"prompt", "character", "worldbook"} {
		if !types[expected] {
			t.Fatalf("allChanges 缺少类型 %s：%+v", expected, changes)
		}
	}
	if textOf(payload["nextTestMessage"]) != "换个话题再试" {
		t.Fatalf("nextTestMessage 解析失败：%+v", payload["nextTestMessage"])
	}
	if payload["shouldStop"] == true {
		t.Fatalf("第 1 轮 B 胜不应停止：%+v", payload)
	}
}

// TestOptimizeStepStopsAfterBWins 守护 Node 的停轮规则：B 连胜 2 次即停止。
func TestOptimizeStepStopsAfterBWins(t *testing.T) {
	server, _ := newTestServer(t)
	stub := optimizeStub(t, `{"decision":"modify","elo":{"result":"B_wins","reasoning":"更好"},"evaluation":{"issues":[],"highlights":[]},"modifiedPrompts":[],"modifiedCharacter":[],"modifiedWorldBook":[]}`)
	configureOptimizeProvider(t, server, stub.URL)

	var last map[string]any
	for index := 1; index <= 2; index++ {
		body := `{"goal":"去八股","iterationNumber":` + itoaForPanel(index) + `,"maxIterations":5,"lastUserMessage":"你好","lastAIResponse":"回复"}`
		last = decodeJSON(t, doRequest(server, "POST", "/api/prompt-range/optimize-step", body).Body.Bytes())
	}
	elo, _ := last["elo"].(map[string]any)
	if elo["bWins"] != float64(2) {
		t.Fatalf("连续两次 B 胜后 bWins 应为 2：%+v", elo)
	}
	if last["shouldStop"] != true {
		t.Fatalf("B 连胜 2 次应停止优化：%+v", last)
	}
}

// TestOptimizePromptIncludesMethodologyAndCorpus 守护提示词确实带上方法论与语料采样：
// 旧实现只拼了三行，模型缺少判定口径。
func TestOptimizePromptIncludesMethodologyAndCorpus(t *testing.T) {
	var captured string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var payload map[string]any
		_ = json.NewDecoder(request.Body).Decode(&payload)
		if messages, ok := payload["messages"].([]any); ok && len(messages) > 0 {
			first, _ := messages[0].(map[string]any)
			captured = textOf(first["content"])
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"choices":[{"message":{"role":"assistant","content":"{\"decision\":\"stop\",\"elo\":{\"result\":\"draw\"}}"}}]}`))
	}))
	defer server.Close()

	panelServer, dataDir := newTestServer(t)
	configureOptimizeProvider(t, panelServer, server.URL)
	// 写入语料，验证采样段落
	corpus := `{"lines":["小明: 今天去哪玩","小红: 随便逛逛吧","小明: 那就去公园"],"stats":{},"updatedAt":1}`
	if err := os.WriteFile(filepath.Join(dataDir, "range-corpus.json"), []byte(corpus), 0o644); err != nil {
		t.Fatalf("写语料失败: %v", err)
	}
	body := `{"goal":"让回复更像真人","iterationNumber":2,"maxIterations":5,"lastUserMessage":"在吗","lastAIResponse":"在的"}`
	payload := decodeJSON(t, doRequest(panelServer, "POST", "/api/prompt-range/optimize-step", body).Body.Bytes())
	if payload["success"] != true {
		t.Fatalf("success 应为 true：%+v", payload)
	}
	for _, expected := range []string{"性格调色盘", "绝对零度", "八股检测", "ELO对战", "群聊语料", "优化目标: 让回复更像真人", "轮次: 2/5"} {
		if !strings.Contains(captured, expected) {
			t.Fatalf("提示词缺少 %q：\n%s", expected, captured[:min(len(captured), 600)])
		}
	}
}

// TestSampleTrainingRangeRandom 守护训练采样对齐 Node：
// 每轮 6-12 条、起点随机（旧实现固定取末尾 6 条，样本多样性受限）。
func TestSampleTrainingRangeRandom(t *testing.T) {
	history := make([]ai.Message, 0, 40)
	for index := 0; index < 40; index++ {
		role := "user"
		if index%2 == 1 {
			role = "assistant"
		}
		history = append(history, ai.Message{Role: role, Content: "第" + itoaForPanel(index) + "条"})
	}
	sizes := map[int]bool{}
	starts := map[int]bool{}
	for index := 0; index < 200; index++ {
		sample, start := sampleTrainingRange(history)
		if len(sample) < 6 || len(sample) > 12 {
			t.Fatalf("采样条数应在 6-12 之间，实际 %d", len(sample))
		}
		if start < 0 || start+len(sample) > len(history) {
			t.Fatalf("采样区间越界: start=%d size=%d total=%d", start, len(sample), len(history))
		}
		if sample[0].Content != history[start].Content {
			t.Fatalf("采样起点与内容不一致: %s vs %s", sample[0].Content, history[start].Content)
		}
		sizes[len(sample)] = true
		starts[start] = true
	}
	if len(sizes) < 3 {
		t.Fatalf("采样条数应有多样性，实际只出现 %d 种", len(sizes))
	}
	if len(starts) < 5 {
		t.Fatalf("采样起点应随机，实际只出现 %d 种", len(starts))
	}
	// 短历史应整体返回
	short := history[:4]
	sample, start := sampleTrainingRange(short)
	if len(sample) != 4 || start != 0 {
		t.Fatalf("短历史应整体返回: size=%d start=%d", len(sample), start)
	}
}
