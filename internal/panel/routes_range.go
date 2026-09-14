package panel

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/chat"
	"mimirlink/internal/store"
)

// 本文件实现面板「Prompt 调优靶场」的剩余端点（对齐 Node src/routes.js 的
// /api/prompt-range/* 组）：语料导入/搜索/嵌入、快照、同步历史、批量测试任务、
// 应用修改、单次测试、优化一步步与 agent 对话。

// rangeState 是靶场面板的运行时状态（快照/批量任务/嵌入进度）。
type rangeState struct {
	mu           sync.Mutex
	snapshots    map[string]map[string]any
	batches      map[string]map[string]any
	embedRunning bool
	embedAborted bool
	embedMessage string
	embedPercent int
	embedBatches int
	embedCurrent int
	// eloHistory 记录最近 3 轮 ELO 判定（对齐 Node rangeCorpusStore._eloHistory）
	eloHistory []string
}

func newRangeState() *rangeState {
	return &rangeState{snapshots: map[string]map[string]any{}, batches: map[string]map[string]any{}}
}

func (s *Server) registerRangeRoutes() {
	s.mux.HandleFunc("/api/prompt-range/sync-latest", s.requireAuth(s.handleRangeSyncLatest))
	s.mux.HandleFunc("/api/prompt-range/snapshot", s.requireAuth(s.handleRangeSnapshot))
	s.mux.HandleFunc("/api/prompt-range/snapshots", s.requireAuth(s.handleRangeSnapshots))
	s.mux.HandleFunc("/api/prompt-range/snapshots/", s.requireAuth(s.handleRangeSnapshotDelete))
	s.mux.HandleFunc("/api/prompt-range/restore", s.requireAuth(s.handleRangeRestore))
	s.mux.HandleFunc("/api/prompt-range/apply-changes", s.requireAuth(s.handleRangeApplyChanges))
	s.mux.HandleFunc("/api/prompt-range/corpus-import", s.requireAuth(s.handleRangeCorpusImport))
	s.mux.HandleFunc("/api/prompt-range/corpus-clear", s.requireAuth(s.handleRangeCorpusClear))
	s.mux.HandleFunc("/api/prompt-range/corpus-abort", s.requireAuth(s.handleRangeCorpusAbort))
	s.mux.HandleFunc("/api/prompt-range/corpus-search", s.requireAuth(s.handleRangeCorpusSearch))
	s.mux.HandleFunc("/api/prompt-range/corpus-embed", s.requireAuth(s.handleRangeCorpusEmbed))
	s.mux.HandleFunc("/api/prompt-range/test", s.requireAuth(s.handleRangeTest))
	s.mux.HandleFunc("/api/prompt-range/test-batches", s.requireAuth(s.handleRangeBatchList))
	s.mux.HandleFunc("/api/prompt-range/test-batch", s.requireAuth(s.handleRangeBatchCreate))
	s.mux.HandleFunc("/api/prompt-range/test-batch/", s.requireAuth(s.handleRangeBatchTask))
	s.mux.HandleFunc("/api/prompt-range/optimize-step", s.requireAuth(s.handleRangeOptimizeStep))
	s.mux.HandleFunc("/api/prompt-range/agent-chat", s.requireAuth(s.handleRangeAgentChat))
}

// ---------------- 文件路径 ----------------

func (s *Server) rangeCorpusPath() string {
	return filepath.Join(s.dataDir, "range-corpus.json")
}

func (s *Server) rangeCorpusEmbeddingPath() string {
	return filepath.Join(s.dataDir, "range-corpus-embeddings.json")
}

func (s *Server) rangeSnapshotPath() string {
	return filepath.Join(s.dataDir, "range-snapshots.json")
}

func (s *Server) rangeSyncHistoryPath() string {
	return filepath.Join(s.dataDir, "range-sync-history.json")
}

// ---------------- 快照 ----------------

func (s *Server) loadRangeSnapshots() {
	if s.rangeState == nil {
		return
	}
	raw, err := os.ReadFile(s.rangeSnapshotPath())
	if err != nil {
		return
	}
	var payload struct {
		Snapshots []map[string]any `json:"snapshots"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return
	}
	s.rangeState.mu.Lock()
	defer s.rangeState.mu.Unlock()
	for _, item := range payload.Snapshots {
		id := textOf(item["id"])
		if id != "" {
			s.rangeState.snapshots[id] = item
		}
	}
}

func (s *Server) persistRangeSnapshots() {
	if s.rangeState == nil {
		return
	}
	s.rangeState.mu.Lock()
	items := make([]map[string]any, 0, len(s.rangeState.snapshots))
	for _, item := range s.rangeState.snapshots {
		items = append(items, item)
	}
	s.rangeState.mu.Unlock()
	sort.Slice(items, func(left, right int) bool {
		return intOr(items[left]["createdAt"], 0) > intOr(items[right]["createdAt"], 0)
	})
	encoded, err := json.MarshalIndent(map[string]any{"snapshots": items}, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(s.rangeSnapshotPath(), encoded, 0o644)
}

func (s *Server) handleRangeSnapshot(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	id := fmt.Sprintf("snap_%d_%s", time.Now().UnixMilli(), randomSuffix(4))
	snapshot := map[string]any{
		"id":           id,
		"label":        orDefault(textOf(body["label"]), fmt.Sprintf("快照 %d", len(s.rangeState.snapshots)+1)),
		"createdAt":    time.Now().UnixMilli(),
		"promptConfig": body["promptConfig"],
		"testMessage":  body["testMessage"],
		"stats":        body["stats"],
	}
	s.rangeState.mu.Lock()
	s.rangeState.snapshots[id] = snapshot
	s.rangeState.mu.Unlock()
	s.persistRangeSnapshots()
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "snapshot": map[string]any{
		"id": id, "label": snapshot["label"], "createdAt": snapshot["createdAt"],
	}})
}

func (s *Server) handleRangeSnapshots(writer http.ResponseWriter, request *http.Request) {
	s.rangeState.mu.Lock()
	items := make([]map[string]any, 0, len(s.rangeState.snapshots))
	for _, snapshot := range s.rangeState.snapshots {
		items = append(items, map[string]any{
			"id": snapshot["id"], "label": snapshot["label"], "createdAt": snapshot["createdAt"],
		})
	}
	s.rangeState.mu.Unlock()
	sort.Slice(items, func(left, right int) bool {
		return intOr(items[left]["createdAt"], 0) > intOr(items[right]["createdAt"], 0)
	})
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "snapshots": items})
}

func (s *Server) handleRangeRestore(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	id := firstText(textOf(body["snapshotId"]), textOf(body["id"]))
	s.rangeState.mu.Lock()
	snapshot, ok := s.rangeState.snapshots[id]
	s.rangeState.mu.Unlock()
	if !ok {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "快照不存在"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "snapshot": snapshot})
}

func (s *Server) handleRangeSnapshotDelete(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodDelete {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	id := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/prompt-range/snapshots/"), "/")
	if id == "__all__" {
		s.rangeState.mu.Lock()
		s.rangeState.snapshots = map[string]map[string]any{}
		s.rangeState.mu.Unlock()
		s.persistRangeSnapshots()
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "已清除所有快照"})
		return
	}
	s.rangeState.mu.Lock()
	delete(s.rangeState.snapshots, id)
	s.rangeState.mu.Unlock()
	s.persistRangeSnapshots()
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "已删除快照"})
}

// ---------------- 同步历史 ----------------

func (s *Server) handleRangeSyncLatest(writer http.ResponseWriter, request *http.Request) {
	limit := atoiOr(request.URL.Query().Get("limit"), 20)
	if limit < 1 {
		limit = 20
	}
	if limit > 50 {
		limit = 50
	}
	history := []map[string]any{}
	if raw, err := os.ReadFile(s.rangeSyncHistoryPath()); err == nil {
		var parsed []map[string]any
		if err := json.Unmarshal(raw, &parsed); err == nil {
			for _, item := range parsed {
				if item["payload"] != nil {
					history = append(history, item)
				}
			}
		}
	}
	if len(history) > limit {
		history = history[len(history)-limit:]
	}
	latest := any(nil)
	if len(history) > 0 {
		latest = history[len(history)-1]
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "latest": latest, "history": history})
}

// ---------------- 语料 ----------------

// rangeCorpusData 读取磁盘语料（lines/stats 来自 range-corpus.json，嵌入来自 range-corpus-embeddings.json）。
func (s *Server) rangeCorpusData() (lines []string, stats map[string]any, updatedAt int64, embeddings [][]float64, embedModel string, embedProvider string, embedProviderID string) {
	lines = []string{}
	if raw, err := os.ReadFile(s.rangeCorpusPath()); err == nil {
		var payload struct {
			Lines         []string       `json:"lines"`
			Stats         map[string]any `json:"stats"`
			UpdatedAt     int64          `json:"updatedAt"`
			Embeddings    []any          `json:"embeddings"`
			EmbedModel    string         `json:"embedModel"`
			EmbedProvider string         `json:"embedProvider"`
		}
		if err := json.Unmarshal(raw, &payload); err == nil {
			lines = payload.Lines
			stats = payload.Stats
			updatedAt = payload.UpdatedAt
			embedModel = payload.EmbedModel
			embedProvider = payload.EmbedProvider
			for _, item := range payload.Embeddings {
				if vector, ok := toFloatSlice(item); ok {
					embeddings = append(embeddings, vector)
				}
			}
		}
	}
	if raw, err := os.ReadFile(s.rangeCorpusEmbeddingPath()); err == nil {
		var payload struct {
			Embeddings []any  `json:"embeddings"`
			Model      string `json:"model"`
			Provider   string `json:"provider"`
			ProviderID string `json:"providerId"`
		}
		if err := json.Unmarshal(raw, &payload); err == nil && len(payload.Embeddings) > 0 {
			vectors := [][]float64{}
			for _, item := range payload.Embeddings {
				if vector, ok := toFloatSlice(item); ok {
					vectors = append(vectors, vector)
				}
			}
			if len(vectors) > 0 {
				embeddings = vectors
				embedModel = payload.Model
				embedProvider = payload.Provider
				embedProviderID = payload.ProviderID
			}
		}
	}
	return
}

func toFloatSlice(value any) ([]float64, bool) {
	items, ok := value.([]any)
	if !ok {
		return nil, false
	}
	vector := make([]float64, 0, len(items))
	for _, item := range items {
		number, ok := item.(float64)
		if !ok {
			return nil, false
		}
		vector = append(vector, number)
	}
	return vector, true
}

func (s *Server) handleRangeCorpusImport(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var (
		raw         []byte
		fileName    string
		limitValue  string
		includeSelf bool
	)
	if strings.HasPrefix(request.Header.Get("Content-Type"), "multipart/form-data") {
		if err := request.ParseMultipartForm(64 << 20); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体解析失败: " + err.Error()})
			return
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请上传JSON文件"})
			return
		}
		defer file.Close()
		raw, err = io.ReadAll(io.LimitReader(file, 64<<20))
		if err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "读取上传内容失败"})
			return
		}
		fileName = header.Filename
		limitValue = request.FormValue("limit")
		includeSelf = request.FormValue("includeSelf") == "true"
	} else {
		body := decodeBody(request)
		text := firstText(textOf(body["text"]), textOf(body["corpus"]))
		if text == "" {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供要导入的语料"})
			return
		}
		lines := []string{}
		for _, line := range strings.Split(text, "\n") {
			if trimmed := strings.TrimSpace(line); trimmed != "" {
				lines = append(lines, trimmed)
			}
		}
		s.saveRangeCorpus(lines, map[string]any{
			"fileName": "inline", "groupName": "", "totalMessages": len(lines),
			"extracted": len(lines), "speakerCount": 0,
		})
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "corpus": strings.Join(lines, "\n"), "stats": map[string]any{"extracted": len(lines)}})
		return
	}

	var payload struct {
		Messages []map[string]any `json:"messages"`
		ChatInfo map[string]any   `json:"chatInfo"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": "JSON 解析失败: " + err.Error()})
		return
	}
	selfUID := textOf(payload.ChatInfo["selfUid"])
	selfUin := textOf(payload.ChatInfo["selfUin"])
	isSelf := func(message map[string]any) bool {
		sender, _ := message["sender"].(map[string]any)
		if sender == nil {
			return false
		}
		return (selfUID != "" && textOf(sender["uid"]) == selfUID) ||
			(selfUin != "" && firstText(textOf(sender["uin"]), fmt.Sprintf("%v", sender["uin"])) == selfUin)
	}
	extracted := []string{}
	for _, message := range payload.Messages {
		if message["recalled"] == true || message["system"] == true {
			continue
		}
		if textOf(message["type"]) != "type_1" {
			continue
		}
		content, _ := message["content"].(map[string]any)
		text := textOf(content["text"])
		if text == "" {
			continue
		}
		if !includeSelf && isSelf(message) {
			continue
		}
		sender, _ := message["sender"].(map[string]any)
		name := textOf(sender["name"])
		if name == "" || name == "0" {
			continue
		}
		extracted = append(extracted, name+": "+text)
	}
	if limit := atoiOr(limitValue, 300); limit > 0 && len(extracted) > limit {
		extracted = extracted[len(extracted)-limit:]
	}
	speakers := map[string]bool{}
	for _, line := range extracted {
		if index := strings.Index(line, ": "); index > 0 {
			speakers[line[:index]] = true
		}
	}
	stats := map[string]any{
		"fileName": fileName, "groupName": textOf(payload.ChatInfo["name"]),
		"totalMessages": len(payload.Messages), "extracted": len(extracted), "speakerCount": len(speakers),
	}
	s.saveRangeCorpus(extracted, stats)
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "corpus": strings.Join(extracted, "\n"), "stats": stats})
}

func (s *Server) saveRangeCorpus(lines []string, stats map[string]any) {
	payload := map[string]any{"lines": lines, "stats": stats, "updatedAt": time.Now().UnixMilli()}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(s.rangeCorpusPath(), encoded, 0o644)
	_ = os.Remove(s.rangeCorpusEmbeddingPath())
}

func (s *Server) handleRangeCorpusClear(writer http.ResponseWriter, request *http.Request) {
	_ = os.Remove(s.rangeCorpusPath())
	_ = os.Remove(s.rangeCorpusEmbeddingPath())
	s.rangeState.mu.Lock()
	s.rangeState.embedRunning = false
	s.rangeState.embedAborted = false
	s.rangeState.mu.Unlock()
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

func (s *Server) handleRangeCorpusAbort(writer http.ResponseWriter, request *http.Request) {
	s.rangeState.mu.Lock()
	s.rangeState.embedAborted = true
	s.rangeState.embedRunning = false
	s.rangeState.embedMessage = "已取消"
	s.rangeState.embedPercent = 0
	s.rangeState.mu.Unlock()
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "已发送取消信号"})
}

func (s *Server) handleRangeCorpusSearch(writer http.ResponseWriter, request *http.Request) {
	query := strings.TrimSpace(request.URL.Query().Get("q"))
	if query == "" {
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "results": []any{}, "hasEmbeddings": false})
		return
	}
	topK := atoiOr(request.URL.Query().Get("limit"), 3)
	if topK > 10 {
		topK = 10
	}
	lines, _, _, embeddings, embedModel, _, embedProviderID := s.rangeCorpusData()
	results := []string{}
	hasEmbeddings := len(embeddings) > 0
	if hasEmbeddings {
		if vector, err := s.embedTexts([]string{query}, embedProviderID, embedModel); err == nil && len(vector) == 1 {
			type scored struct {
				index float64
				score float64
			}
			scores := []scored{}
			for index, candidate := range embeddings {
				scores = append(scores, scored{index: float64(index), score: cosineSimilarity(vector[0], candidate)})
			}
			sort.Slice(scores, func(left, right int) bool { return scores[left].score > scores[right].score })
			for _, item := range scores {
				if len(results) >= topK {
					break
				}
				position := int(item.index)
				if position >= 0 && position < len(lines) {
					results = append(results, lines[position])
				}
			}
		}
	}
	if len(results) == 0 {
		lowered := strings.ToLower(query)
		for _, line := range lines {
			if len(results) >= topK {
				break
			}
			if strings.Contains(strings.ToLower(line), lowered) {
				results = append(results, line)
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "results": results, "hasEmbeddings": hasEmbeddings})
}

// embedTexts 调用配置里的嵌入模型（对齐 Node /embeddings 调用）。
func (s *Server) embedTexts(inputs []string, providerID string, explicitModel string) ([][]float64, error) {
	baseURL, apiKey, model := s.resolveEmbedProvider(providerID, explicitModel)
	if baseURL == "" || model == "" {
		return nil, fmt.Errorf("没有可用嵌入模型。嵌入模型名需包含 embed/bge/e5/gte/voyage 等关键字")
	}
	body, _ := json.Marshal(map[string]any{"model": model, "input": inputs})
	endpoint := strings.TrimRight(baseURL, "/") + "/embeddings"
	client := &http.Client{Timeout: 60 * time.Second}
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("嵌入失败 HTTP %d: %s", response.StatusCode, string(raw[:minInt(len(raw), 300)]))
	}
	var payload struct {
		Data []struct {
			Embedding []float64 `json:"embedding"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, err
	}
	vectors := [][]float64{}
	for _, item := range payload.Data {
		vectors = append(vectors, item.Embedding)
	}
	return vectors, nil
}

// resolveEmbedProvider 选择嵌入供应商/模型（指定优先 → 自动检测含 embed 关键字的模型）。
func (s *Server) resolveEmbedProvider(providerID string, explicitModel string) (baseURL string, apiKey string, model string) {
	for _, item := range s.document.Get("ai.providers").Array() {
		id := item.Get("id").String()
		base := strings.TrimSpace(item.Get("baseUrl").String())
		key := strings.TrimSpace(item.Get("apiKey").String())
		if base == "" || key == "" {
			continue
		}
		entryModel := ""
		for _, candidate := range item.Get("models").Array() {
			name := firstText(candidate.Get("id").String(), candidate.Get("name").String())
			if classifyRangeModel(name) == "embedding" && entryModel == "" {
				entryModel = name
			}
		}
		switch {
		case providerID != "":
			if id != providerID {
				continue
			}
			if explicitModel != "" {
				return base, key, explicitModel
			}
			if entryModel != "" {
				return base, key, entryModel
			}
		case explicitModel != "":
			return base, key, explicitModel
		case entryModel != "":
			return base, key, entryModel
		}
	}
	return "", "", ""
}

func (s *Server) handleRangeCorpusEmbed(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	lines, _, _, _, _, _, _ := s.rangeCorpusData()
	if len(lines) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请先导入语料"})
		return
	}
	providerID := textOf(body["modelProviderId"])
	explicitModel := textOf(body["model"])
	if base, _, model := s.resolveEmbedProvider(providerID, explicitModel); base == "" || model == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "没有可用嵌入模型。嵌入模型名需包含 embed/bge/e5/gte/voyage 等关键字"})
		return
	}
	inputs := make([]string, 0, len(lines))
	for _, line := range lines {
		if index := strings.Index(line, ":"); index > 0 {
			inputs = append(inputs, strings.TrimSpace(line[index+1:]))
		} else {
			inputs = append(inputs, line)
		}
	}
	s.rangeState.mu.Lock()
	s.rangeState.embedAborted = false
	s.rangeState.embedRunning = true
	s.rangeState.embedMessage = fmt.Sprintf("正在向量化 %d 条语料...", len(inputs))
	s.rangeState.embedPercent = 0
	s.rangeState.embedBatches = (len(inputs) + 49) / 50
	s.rangeState.embedCurrent = 0
	s.rangeState.mu.Unlock()

	allEmbeddings := [][]float64{}
	batchSize := 50
	for start := 0; start < len(inputs); start += batchSize {
		s.rangeState.mu.Lock()
		aborted := s.rangeState.embedAborted
		s.rangeState.mu.Unlock()
		if aborted {
			s.rangeState.mu.Lock()
			s.rangeState.embedRunning = false
			s.rangeState.mu.Unlock()
			writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": "已取消"})
			return
		}
		end := start + batchSize
		if end > len(inputs) {
			end = len(inputs)
		}
		vectors, err := s.embedTexts(inputs[start:end], providerID, explicitModel)
		if err != nil {
			s.rangeState.mu.Lock()
			s.rangeState.embedRunning = false
			s.rangeState.embedMessage = "嵌入失败: " + err.Error()
			s.rangeState.mu.Unlock()
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		allEmbeddings = append(allEmbeddings, vectors...)
		s.rangeState.mu.Lock()
		s.rangeState.embedCurrent = start/batchSize + 1
		s.rangeState.embedPercent = int(float64(s.rangeState.embedCurrent) / float64(maxInt(s.rangeState.embedBatches, 1)) * 100)
		s.rangeState.embedMessage = fmt.Sprintf("向量化中 %d/%d (%d%%)", s.rangeState.embedCurrent, s.rangeState.embedBatches, s.rangeState.embedPercent)
		s.rangeState.mu.Unlock()
	}

	base := ""
	_, _, model := s.resolveEmbedProvider(providerID, explicitModel)
	for _, item := range s.document.Get("ai.providers").Array() {
		if providerID == "" || item.Get("id").String() == providerID {
			base = item.Get("name").String()
			break
		}
	}
	providerName := base
	providerResolved := providerID
	if providerResolved == "" {
		for _, item := range s.document.Get("ai.providers").Array() {
			for _, candidate := range item.Get("models").Array() {
				name := firstText(candidate.Get("id").String(), candidate.Get("name").String())
				if classifyRangeModel(name) == "embedding" {
					providerName = item.Get("name").String()
					providerResolved = item.Get("id").String()
					break
				}
			}
			if providerResolved != "" {
				break
			}
		}
	}
	encoded, _ := json.Marshal(map[string]any{
		"embeddings": allEmbeddings, "model": model, "provider": providerName,
		"providerId": providerResolved, "count": len(allEmbeddings), "updatedAt": time.Now().UnixMilli(),
	})
	_ = os.WriteFile(s.rangeCorpusEmbeddingPath(), encoded, 0o644)

	s.rangeState.mu.Lock()
	s.rangeState.embedRunning = false
	s.rangeState.embedPercent = 100
	s.rangeState.embedMessage = fmt.Sprintf("已完成 %d 条向量化", len(allEmbeddings))
	s.rangeState.mu.Unlock()

	dimension := 0
	if len(allEmbeddings) > 0 {
		dimension = len(allEmbeddings[0])
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "embedded": len(allEmbeddings), "model": model,
		"provider": providerName, "dimension": dimension,
	})
}

// ---------------- 应用修改 ----------------

func (s *Server) handleRangeApplyChanges(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	results := []map[string]any{}
	backupDir := filepath.Join(s.dataDir, "backups", fmt.Sprintf("range_%d", time.Now().UnixMilli()))
	_ = os.MkdirAll(backupDir, 0o755)

	// 1) 预设修改 → 写回 config.preset.prompts
	if modified, ok := body["modifiedPrompts"].([]any); ok && len(modified) > 0 {
		prompts := []any{}
		if raw := s.document.Get("preset.prompts"); raw.Exists() {
			_ = json.Unmarshal([]byte(raw.Raw), &prompts)
		}
		for _, item := range modified {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			identifier := textOf(entry["identifier"])
			for _, raw := range prompts {
				prompt, _ := raw.(map[string]any)
				if prompt == nil || textOf(prompt["identifier"]) != identifier {
					continue
				}
				_ = os.WriteFile(filepath.Join(backupDir, "preset_"+safeBase(identifier)+".json"),
					[]byte(fmt.Sprintf("{\n  \"identifier\": %q,\n  \"oldContent\": %q\n}\n", identifier, textOf(prompt["content"]))), 0o644)
				prompt["content"] = entry["newContent"]
				results = append(results, map[string]any{"type": "preset", "identifier": identifier, "status": "applied"})
				break
			}
		}
		if err := s.document.Set("preset.prompts", prompts); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
	}

	// 2) 角色卡修改
	if characterName := textOf(body["characterName"]); characterName != "" && body["modifiedCharacter"] != nil {
		updates := map[string]any{}
		list := []any{body["modifiedCharacter"]}
		if array, ok := body["modifiedCharacter"].([]any); ok {
			list = array
		}
		for _, item := range list {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			if field := textOf(entry["field"]); field != "" && entry["newContent"] != nil {
				updates[field] = entry["newContent"]
			}
		}
		if len(updates) > 0 {
			if raw, err := os.ReadFile(filepath.Join(s.dataDir, "characters", safeBase(characterName)+".png")); err == nil {
				_ = os.WriteFile(filepath.Join(backupDir, safeBase(characterName)+".png"), raw, 0o644)
			}
			if _, err := characters.Update(s.dataDir, characterName, updates); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			fields := make([]string, 0, len(updates))
			for field := range updates {
				fields = append(fields, field)
			}
			sort.Strings(fields)
			results = append(results, map[string]any{"type": "character", "fields": fields, "status": "applied"})
		}
	}

	// 3) 世界书修改
	if worldbookName := textOf(body["worldbookName"]); worldbookName != "" {
		if modified, ok := body["modifiedWorldBook"].([]any); ok && len(modified) > 0 {
			path := filepath.Join(s.dataDir, "worlds", safeBase(worldbookName)+".json")
			if raw, err := os.ReadFile(path); err == nil {
				_ = os.WriteFile(filepath.Join(backupDir, safeBase(worldbookName)+".json"), raw, 0o644)
			}
			book := map[string]any{"entries": []any{}}
			if raw, err := os.ReadFile(path); err == nil {
				_ = json.Unmarshal(raw, &book)
			}
			entries, _ := book["entries"].([]any)
			if entries == nil {
				entries = []any{}
			}
			for _, item := range modified {
				change, _ := item.(map[string]any)
				if change == nil {
					continue
				}
				index := intOr(change["index"], -1)
				switch textOf(change["action"]) {
				case "add":
					entries = append(entries, change["entry"])
					results = append(results, map[string]any{"type": "worldbook", "action": "add", "status": "applied"})
				case "delete":
					if index >= 0 && index < len(entries) {
						entries = append(entries[:index], entries[index+1:]...)
						results = append(results, map[string]any{"type": "worldbook", "action": "delete", "index": index, "status": "applied"})
					}
				case "update":
					if index >= 0 && index < len(entries) {
						target, _ := entries[index].(map[string]any)
						if target == nil {
							target = map[string]any{}
							entries[index] = target
						}
						entry, _ := change["entry"].(map[string]any)
						for key, value := range entry {
							target[key] = value
						}
						results = append(results, map[string]any{"type": "worldbook", "action": "update", "index": index, "status": "applied"})
					}
				}
			}
			book["entries"] = entries
			encoded, _ := json.MarshalIndent(book, "", "  ")
			if err := os.WriteFile(path, encoded, 0o644); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
		}
	}

	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "results": results, "backupDir": backupDir})
}

// ---------------- 单次测试 ----------------

// rangeTestPayload 是靶场测试的请求体。
type rangeTestPayload struct {
	UserMessage      string          `json:"userMessage"`
	CharacterName    string          `json:"characterName"`
	MessageType      string          `json:"messageType"`
	GroupID          string          `json:"groupId"`
	UserID           string          `json:"userId"`
	UserName         string          `json:"userName"`
	GroupName        string          `json:"groupName"`
	ModelProviderID  string          `json:"modelProviderId"`
	Model            string          `json:"model"`
	WorldbookName    string          `json:"worldbookName"`
	SessionKey       string          `json:"sessionKey"`
	ReplyReference   string          `json:"replyReference"`
	Context          map[string]any  `json:"context"`
	ContextOverrides map[string]bool `json:"contextConfig"`
	InjectProfiles   *bool           `json:"injectProfiles"`
	IncludeAI        *bool           `json:"includeAIResponse"`
	InjectVariables  *bool           `json:"injectVariables"`
}

func (s *Server) parseRangePayload(body map[string]any) rangeTestPayload {
	payload := rangeTestPayload{
		UserMessage:      firstText(textOf(body["userMessage"]), textOf(body["text"])),
		CharacterName:    textOf(body["characterName"]),
		MessageType:      orDefault(textOf(body["messageType"]), "group"),
		GroupID:          textOf(body["groupId"]),
		UserID:           textOf(body["userId"]),
		UserName:         firstText(textOf(body["userName"]), textOf(body["senderName"])),
		GroupName:        textOf(body["groupName"]),
		ModelProviderID:  textOf(body["modelProviderId"]),
		Model:            textOf(body["model"]),
		WorldbookName:    textOf(body["worldbookName"]),
		SessionKey:       textOf(body["sessionKey"]),
		ReplyReference:   textOf(body["replyReference"]),
		ContextOverrides: contextOverridesOf(body),
		InjectProfiles:   boolPointerOf(body["injectProfiles"]),
		Context:          objectOf(body["context"]),
	}
	if value, ok := body["includeAIResponse"].(bool); ok {
		payload.IncludeAI = &value
	}
	if value, ok := body["injectVariables"].(bool); ok {
		payload.InjectVariables = &value
	}
	if payload.CharacterName == "" {
		payload.CharacterName = s.currentCharacterName()
	}
	if payload.WorldbookName == "" {
		payload.WorldbookName = s.currentWorldbookName()
	}
	return payload
}

// rangeSpeakerProfile 按 injectProfiles 开关注入当前发言人画像（对齐 Node injectProfiles）。
func (s *Server) rangeSpeakerProfile(memory *store.DB, payload rangeTestPayload) string {
	if payload.InjectProfiles != nil && !*payload.InjectProfiles {
		return ""
	}
	if payload.InjectProfiles == nil && s.document.Exists("range.injectProfiles") && !s.document.Bool("range.injectProfiles") {
		return ""
	}
	if memory == nil || strings.TrimSpace(payload.UserID) == "" {
		return ""
	}
	entry, err := memory.GetParticipantProfileEntry(store.NamespaceOptions{
		ScopeType:     s.document.String("chat.sessionMode"),
		ScopeKey:      payload.SessionKey,
		CharacterName: s.currentCharacterName(),
	}, payload.UserID)
	if err != nil || entry == nil {
		return ""
	}
	return strings.TrimSpace(entry.Content)
}

// contextOverridesOf 把请求体 contextConfig 转成开关覆盖表。
func contextOverridesOf(body map[string]any) map[string]bool {
	raw, ok := body["contextConfig"].(map[string]any)
	if !ok || len(raw) == 0 {
		return nil
	}
	overrides := map[string]bool{}
	for key, value := range raw {
		if flag, ok := value.(bool); ok {
			overrides[key] = flag
		}
	}
	if len(overrides) == 0 {
		return nil
	}
	return overrides
}

// rangeParticipants 汇总靶场参与者（显式昵称 + 模拟记忆中的昵称）。
func rangeParticipants(payload rangeTestPayload, history []ai.Message) []string {
	result := []string{}
	seen := map[string]bool{}
	appendName := func(name string) {
		name = strings.TrimSpace(name)
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		result = append(result, name)
	}
	appendName(payload.UserName)
	if payload.Context != nil {
		if items, ok := payload.Context["recentMessages"].([]any); ok {
			for _, item := range items {
				entry, _ := item.(map[string]any)
				if entry == nil {
					continue
				}
				appendName(textOf(entry["userName"]))
			}
		}
	}
	return result
}

// countStageSegments 统计某阶段的分段数量。
func countStageSegments(segments []chat.RangeSegment, stage string) int {
	count := 0
	for _, segment := range segments {
		if segment.Stage == stage {
			count++
		}
	}
	return count
}

// rangeTestResult 执行一次靶场测试（供单次与批量共用）。
func (s *Server) rangeTestResult(body map[string]any, mode string) (map[string]any, int, error) {
	payload := s.parseRangePayload(body)
	if strings.TrimSpace(payload.UserMessage) == "" {
		return nil, http.StatusBadRequest, fmt.Errorf("请提供测试消息")
	}
	history := []ai.Message{}
	if payload.Context != nil {
		if items, ok := payload.Context["recentMessages"].([]any); ok {
			for _, item := range items {
				entry, _ := item.(map[string]any)
				if entry == nil {
					continue
				}
				role := textOf(entry["role"])
				if role != "user" && role != "assistant" {
					role = "user"
				}
				history = append(history, ai.Message{Role: role, Content: stringValueOf(entry["content"])})
			}
		}
	}
	variableBlock := ""
	if payload.InjectVariables == nil || *payload.InjectVariables {
		variableBlock = s.rangeVariableBlock(payload.CharacterName)
	}
	// 上下文注入与数据库召回：与运行时同一套开关与实现（config.context.*）
	memory, _, memoryErr := s.openActiveMemory()
	if memoryErr == nil {
		defer func() { _ = memory.Close() }()
	}
	messages, segments, activeBook, err := chat.BuildRangePrompt(chat.RangeInput{
		Document: s.document, DataDir: s.dataDir,
		CharacterName: payload.CharacterName, WorldbookName: payload.WorldbookName,
		Message: payload.UserMessage, MessageType: payload.MessageType,
		GroupID: payload.GroupID, UserID: payload.UserID, UserName: payload.UserName, GroupName: payload.GroupName,
		History: history, VariableBlock: variableBlock,
		Memory: memory, SessionKey: payload.SessionKey, Participants: rangeParticipants(payload, history),
		SpeakerProfile:   s.rangeSpeakerProfile(memory, payload),
		ReplyReference:   payload.ReplyReference,
		ContextOverrides: payload.ContextOverrides,
		Logger:           s.logger,
	})
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	inputHeader := fmt.Sprintf("[%s|QQ:%s|昵称:%s|群号:%s|群名:%s|时间:%s|eventType:message]",
		map[bool]string{true: "群聊", false: "私聊"}[payload.MessageType == "group"],
		firstText(payload.UserID, "N/A"), firstText(payload.UserName, "N/A"),
		map[bool]string{true: payload.GroupID, false: "N/A"}[payload.MessageType == "group"],
		firstText(payload.GroupName, "N/A"), time.Now().Format("2006/1/2 15:04:05"))

	totalTokens := 0
	worldbookHits := 0
	for _, segment := range segments {
		totalTokens += segment.Tokens
		if segment.Kind == "worldbook_entry" {
			worldbookHits++
		}
	}
	recallCount := 0
	for _, segment := range segments {
		if segment.Stage == "recall" {
			recallCount = 1
		}
	}
	stats := map[string]any{
		"totalTokenEstimate": totalTokens,
		"segmentCount":       len(segments),
		"worldbookHits":      worldbookHits,
		"memoryRecallCount":  recallCount,
		"messageCount":       len(messages),
		"contextSegments":    countStageSegments(segments, "context"),
		"recallSegments":     recallCount,
	}
	messagePayload := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		messagePayload = append(messagePayload, map[string]any{"role": message.Role, "content": stringValueOf(message.Content)})
	}
	result := map[string]any{
		"success":     true,
		"mode":        mode,
		"userMessage": payload.UserMessage,
		"inputHeader": inputHeader,
		"character":   map[string]any{"name": payload.CharacterName},
		"worldBook":   map[string]any{"name": nilIf(activeBook)},
		"segments":    segments,
		"stats":       stats,
		"messages":    messagePayload,
		"prompt": map[string]any{
			"messages":            messagePayload,
			"messageTrace":        chat.BuildMessageTrace(messages, segments),
			"currentMessageFocus": "",
		},
		"fakeHistory":          messagePayload[:minInt(len(messagePayload), 0)],
		"fakeHistoryCount":     len(history),
		"promptConfigSnapshot": s.document.Get("preset").Value(),
		"contextConfig": map[string]any{
			"enabled":               true,
			"includeSessionFacts":   true,
			"includeParticipants":   true,
			"includeReplyReference": true,
		},
		"trace": map[string]any{
			"runId":     fmt.Sprintf("range_%d", time.Now().UnixMilli()),
			"mode":      mode,
			"startedAt": time.Now().UnixMilli(),
			"steps":     []any{},
		},
	}

	includeAI := payload.IncludeAI == nil || *payload.IncludeAI
	if !includeAI {
		return result, http.StatusOK, nil
	}
	client := s.buildRangeAIClient(payload.ModelProviderID, payload.Model)
	if client == nil {
		return nil, http.StatusBadRequest, fmt.Errorf("无法构建 AI 客户端，请检查 ai.providers 配置")
	}
	timeout := time.Duration(s.document.Int("ai.timeout", 120)) * time.Second
	ctx, cancel := contextWithTimeout(timeout)
	defer cancel()
	completion, err := client.Chat(ctx, messages, nil)
	if err != nil {
		return nil, http.StatusBadGateway, fmt.Errorf("模型请求失败: %v", err)
	}
	reply := completion.Content
	splitEnabled := s.document.Get("chat.splitMessage").Value() != false
	mentionPrefix := ""
	if payload.MessageType == "group" && s.document.Get("chat.mentionSenderOnReply").Value() != false {
		mentionPrefix = fmt.Sprintf("[CQ:at,qq=%s] ", firstText(payload.UserID, "000000"))
	}
	rawSegments := []string{reply}
	if splitEnabled {
		rawSegments = splitNonEmpty(reply, "\n\n")
	}
	qqSegments := []map[string]any{}
	for index, segment := range rawSegments {
		text := strings.TrimSpace(segment)
		qqText := text
		if index == 0 {
			qqText = mentionPrefix + text
		}
		qqSegments = append(qqSegments, map[string]any{
			"index": index, "text": text, "qqText": qqText,
			"isFirst": index == 0, "hasPrefix": index == 0 && mentionPrefix != "",
			"charCount": len([]rune(text)),
		})
	}
	result["aiResponse"] = map[string]any{
		"text":             strings.TrimSpace(reply),
		"finalReply":       strings.TrimSpace(reply),
		"reasoningContent": nilIf(completion.ReasoningContent),
		"usage":            completion.Raw["usage"],
		"segments":         qqSegments,
		"segmentCount":     len(qqSegments),
		"splitConfig": map[string]any{
			"splitEnabled": splitEnabled, "mentionPrefix": mentionPrefix != "",
			"segmentDelayMs": s.document.Int("chat.segmentDelayMs", 300),
		},
	}
	result["rawReply"] = reply
	result["cleanedReply"] = strings.TrimSpace(reply)
	result["finalReply"] = strings.TrimSpace(reply)
	result["reasoningContent"] = nilIf(completion.ReasoningContent)
	return result, http.StatusOK, nil
}

// rangeVariableBlock 组装变量状态块（对齐靶场 injectVariables）。
func (s *Server) rangeVariableBlock(characterName string) string {
	database, _, err := s.openActiveMemory()
	if err != nil {
		return ""
	}
	defer database.Close()
	items, err := database.ListVariables(storeVariableFilters(characterName))
	if err != nil || len(items) == 0 {
		return ""
	}
	lines := []string{"【当前变量状态】"}
	for _, item := range items {
		lines = append(lines, fmt.Sprintf("- %s = %s", item.Key, item.RawValue))
	}
	return strings.Join(lines, "\n")
}

func (s *Server) handleRangeTest(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	result, status, err := s.rangeTestResult(body, "single")
	if err != nil {
		writeJSON(writer, status, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, result)
}

// ---------------- 批量测试 ----------------

func (s *Server) handleRangeBatchCreate(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	messages, _ := body["messages"].([]any)
	if len(messages) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供批量测试消息"})
		return
	}
	environments, _ := body["environments"].([]any)
	if len(environments) == 0 {
		environments = []any{map[string]any{}}
	}
	concurrency := intOr(body["concurrency"], 2)
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 8 {
		concurrency = 8
	}
	taskID := fmt.Sprintf("range_batch_%d", time.Now().UnixMilli())
	totalJobs := len(messages) * len(environments)
	task := map[string]any{
		"id": taskID, "mode": orDefault(textOf(body["executionMode"]), "serial"),
		"concurrency": concurrency, "startedAt": time.Now().Format(time.RFC3339),
		"finishedAt": nil, "running": true, "stage": "running",
		"currentMessage": "", "progressPercent": 0,
		"totalJobs": totalJobs, "completedJobs": 0, "failedJobs": 0,
		"environments": len(environments), "results": []any{}, "failed": []any{},
	}
	s.rangeState.mu.Lock()
	s.rangeState.batches[taskID] = task
	s.rangeState.mu.Unlock()
	go s.runRangeBatch(taskID, body, messages, environments, concurrency)
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "taskId": taskID, "task": task})
}

func (s *Server) runRangeBatch(taskID string, base map[string]any, messages []any, environments []any, concurrency int) {
	semaphore := make(chan struct{}, concurrency)
	var waitGroup sync.WaitGroup
	for _, rawMessage := range messages {
		message := stringValueOf(rawMessage)
		for _, rawEnvironment := range environments {
			environment, _ := rawEnvironment.(map[string]any)
			waitGroup.Add(1)
			semaphore <- struct{}{}
			go func(message string, environment map[string]any) {
				defer waitGroup.Done()
				defer func() { <-semaphore }()
				body := map[string]any{}
				for key, value := range base {
					body[key] = value
				}
				delete(body, "messages")
				delete(body, "environments")
				delete(body, "concurrency")
				body["userMessage"] = message
				for key, value := range environment {
					body[key] = value
				}
				result, _, err := s.rangeTestResult(body, "batch")
				s.rangeState.mu.Lock()
				defer s.rangeState.mu.Unlock()
				task := s.rangeState.batches[taskID]
				if task == nil {
					return
				}
				if err != nil {
					task["failedJobs"] = intOr(task["failedJobs"], 0) + 1
					failed, _ := task["failed"].([]any)
					task["failed"] = append(failed, map[string]any{"message": message, "error": err.Error()})
				} else {
					results, _ := task["results"].([]any)
					task["results"] = append(results, result)
				}
				completed := intOr(task["completedJobs"], 0) + 1
				total := intOr(task["totalJobs"], 1)
				task["completedJobs"] = completed
				task["progressPercent"] = int(float64(completed) / float64(total) * 100)
				task["currentMessage"] = message
				if completed >= total {
					task["running"] = false
					task["stage"] = "completed"
					task["finishedAt"] = time.Now().Format(time.RFC3339)
					task["progressPercent"] = 100
				}
			}(message, environment)
		}
	}
	waitGroup.Wait()
}

func (s *Server) handleRangeBatchList(writer http.ResponseWriter, request *http.Request) {
	s.rangeState.mu.Lock()
	tasks := make([]map[string]any, 0, len(s.rangeState.batches))
	for _, task := range s.rangeState.batches {
		tasks = append(tasks, map[string]any{
			"id": task["id"], "mode": task["mode"], "concurrency": task["concurrency"],
			"startedAt": task["startedAt"], "finishedAt": task["finishedAt"], "running": task["running"],
			"stage": task["stage"], "currentMessage": task["currentMessage"],
			"progressPercent": task["progressPercent"], "totalJobs": task["totalJobs"],
			"completedJobs": task["completedJobs"], "failedJobs": task["failedJobs"],
			"environments": task["environments"],
		})
	}
	s.rangeState.mu.Unlock()
	sort.Slice(tasks, func(left, right int) bool {
		return stringValueOf(tasks[left]["startedAt"]) > stringValueOf(tasks[right]["startedAt"])
	})
	if len(tasks) > 20 {
		tasks = tasks[:20]
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "tasks": tasks})
}

func (s *Server) handleRangeBatchTask(writer http.ResponseWriter, request *http.Request) {
	taskID := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/prompt-range/test-batch/"), "/")
	if taskID == "" {
		s.handleRangeBatchCreate(writer, request)
		return
	}
	s.rangeState.mu.Lock()
	task, ok := s.rangeState.batches[taskID]
	s.rangeState.mu.Unlock()
	if !ok {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "批量任务不存在"})
		return
	}
	if request.Method == http.MethodDelete {
		s.rangeState.mu.Lock()
		delete(s.rangeState.batches, taskID)
		s.rangeState.mu.Unlock()
		writeJSON(writer, http.StatusOK, map[string]any{"success": true})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "task": task})
}

// ---------------- 优化一步（AI） ----------------

func (s *Server) handleRangeOptimizeStep(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	goal := textOf(body["goal"])
	if goal == "" {
		goal = "让角色扮演更自然、更贴合人设"
	}
	iterationNumber := intOr(body["iterationNumber"], 1)
	maxIterations := intOr(body["maxIterations"], 5)
	noJSONMode := body["noJsonMode"] == true
	lastUser := textOf(body["lastUserMessage"])
	lastReply := textOf(body["lastAIResponse"])
	characterName := orDefault(textOf(body["characterName"]), s.currentCharacterName())
	providerID := firstText(textOf(body["modelProviderId"]), textOf(body["judgeProviderId"]))
	model := firstText(textOf(body["model"]), textOf(body["judgeModel"]))
	if lastReply == "" {
		// 没有上一轮结果时先跑一次测试，保持流程可继续
		result, status, err := s.rangeTestResult(body, "optimize")
		if err != nil {
			writeJSON(writer, status, map[string]any{"success": false, "error": err.Error()})
			return
		}
		lastUser = stringValueOf(result["userMessage"])
		if aiResponse, ok := result["aiResponse"].(map[string]any); ok {
			lastReply = stringValueOf(aiResponse["text"])
		}
	}
	client := s.buildRangeAIClient(providerID, model)
	if client == nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "无法构建 AI 客户端，请检查 ai.providers 配置"})
		return
	}

	promptItems := s.optimizePromptSummary(body["currentPromptConfig"])
	characterSummary := s.optimizeCharacterSummary(body["currentCharacter"], characterName)
	worldbookSummary := s.optimizeWorldbookSummary(body["currentWorldBook"])
	corpusSection := s.optimizeCorpusSection(goal, textOf(body["testCorpus"]))
	lastResultText := "(尚无测试结果)"
	if lastUser != "" || lastReply != "" {
		lastResultText = "用户消息: " + lastUser + "\nAI回复: " + lastReply
	}

	optimizePrompt := nodeOptimizePrompt(nodeOptimizeInput{
		Goal: goal, IterationNumber: iterationNumber, MaxIterations: maxIterations,
		LastResultText: lastResultText, PromptItems: promptItems,
		Character: characterSummary, Worldbook: worldbookSummary, Corpus: corpusSection,
		NoJSONMode: noJSONMode,
	})

	// 对齐 Node buildRangeAIOverrides：温度 0.4 / 输出上限 4096
	overrides := map[string]any{"temperature": 0.4, "maxTokens": 4096}
	ctx, cancel := contextWithTimeout(time.Duration(s.document.Int("ai.timeout", 120)) * time.Second)
	defer cancel()
	completion, err := client.Chat(ctx, []ai.Message{{Role: "user", Content: optimizePrompt}}, overrides)
	if err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"success": false, "error": "模型请求失败: " + err.Error()})
		return
	}
	parsed := parseJSONObject(completion.Content)
	decision := "stop"
	if textOf(parsed["decision"]) == "modify" {
		decision = "modify"
	}
	elo, _ := parsed["elo"].(map[string]any)
	evaluation, _ := parsed["evaluation"].(map[string]any)
	eloResult := orDefault(textOf(elo["result"]), "draw")
	if eloResult != "A_wins" && eloResult != "B_wins" && eloResult != "draw" {
		eloResult = "draw"
	}

	// ELO 历史与停轮判定（对齐 Node：B 连胜 2 次停止，最多保留 3 条）
	history := s.appendELOHistory(eloResult)
	bWins := 0
	for _, item := range history {
		if item == "B_wins" {
			bWins++
		}
	}
	shouldStop := decision == "stop" || iterationNumber >= maxIterations || bWins >= 2

	// 修改解析（对齐 Node：modifiedPrompts / modifiedCharacter / modifiedWorldBook → allChanges）
	allChanges := []map[string]any{}
	promptChanges := []map[string]any{}
	characterChanges := []map[string]any{}
	worldbookChanges := []map[string]any{}
	for _, raw := range asList(parsed["modifiedPrompts"]) {
		entry, _ := raw.(map[string]any)
		if entry == nil || textOf(entry["identifier"]) == "" {
			continue
		}
		newContent := textOf(entry["newContent"])
		if newContent == "" || newContent == textOf(entry["oldContent"]) {
			continue
		}
		change := map[string]any{
			"type": "prompt", "identifier": textOf(entry["identifier"]),
			"oldContent": textOf(entry["oldContent"]), "newContent": newContent,
		}
		promptChanges = append(promptChanges, change)
		allChanges = append(allChanges, change)
	}
	for _, raw := range asList(parsed["modifiedCharacter"]) {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			continue
		}
		field := textOf(entry["field"])
		newContent := textOf(entry["newContent"])
		if field == "" || newContent == "" || newContent == textOf(entry["oldContent"]) {
			continue
		}
		change := map[string]any{
			"type": "character", "identifier": "角色卡." + field,
			"oldContent": textOf(entry["oldContent"]), "newContent": newContent,
		}
		characterChanges = append(characterChanges, change)
		allChanges = append(allChanges, change)
	}
	for _, raw := range asList(parsed["modifiedWorldBook"]) {
		entry, _ := raw.(map[string]any)
		if entry == nil {
			continue
		}
		action := textOf(entry["action"])
		if action == "" {
			continue
		}
		index := intOr(entry["index"], -1)
		identifier := "世界书"
		switch {
		case action == "add":
			identifier = "世界书(新增)"
		case index >= 0:
			identifier = "世界书条目#" + strconv.Itoa(index)
		}
		change := map[string]any{
			"type": "worldbook", "identifier": identifier, "action": action,
			"newContent": textOf(mapOfAny(entry["entry"])["content"]),
		}
		worldbookChanges = append(worldbookChanges, change)
		allChanges = append(allChanges, change)
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"elo": map[string]any{
			"result": eloResult, "reasoning": textOf(elo["reasoning"]), "history": history, "bWins": bWins,
		},
		"evaluation": map[string]any{
			"issues":     asList(evaluation["issues"]),
			"highlights": asList(evaluation["highlights"]),
		},
		"decision":          decision,
		"shouldStop":        shouldStop,
		"allChanges":        allChanges,
		"modifiedPrompts":   promptChanges,
		"modifiedCharacter": characterChanges,
		"modifiedWorldBook": worldbookChanges,
		"nextTestMessage":   firstText(textOf(parsed["nextTestMessage"]), lastUser),
		"changeSummary":     textOf(parsed["changeSummary"]),
		"iterationNumber":   iterationNumber,
		"rawAIResponse":     truncateString(completion.Content, 2000),
	})
}

// appendELOHistory 维护 ELO 判定历史（对齐 Node rangeCorpusStore._eloHistory，最多 3 条）。
func (s *Server) appendELOHistory(result string) []string {
	s.rangeState.mu.Lock()
	defer s.rangeState.mu.Unlock()
	s.rangeState.eloHistory = append(s.rangeState.eloHistory, result)
	if len(s.rangeState.eloHistory) > 3 {
		s.rangeState.eloHistory = s.rangeState.eloHistory[len(s.rangeState.eloHistory)-3:]
	}
	history := make([]string, len(s.rangeState.eloHistory))
	copy(history, s.rangeState.eloHistory)
	return history
}

// optimizePromptSummary 汇总当前预设提示词（对齐 Node promptsSummary）。
func (s *Server) optimizePromptSummary(raw any) string {
	config, _ := raw.(map[string]any)
	items := []any{}
	if config != nil {
		items = asList(config["prompts"])
	}
	if len(items) == 0 {
		items = asList(presetForPanel(s.document)["prompts"])
	}
	lines := []string{}
	for _, item := range items {
		entry, _ := item.(map[string]any)
		if entry == nil || entry["enabled"] == false {
			continue
		}
		lines = append(lines, fmt.Sprintf("标识: %s | 名称: %s | 角色: %s\n内容: %s",
			orDefault(textOf(entry["identifier"]), "?"), textOf(entry["name"]),
			orDefault(textOf(entry["role"]), "system"), truncateString(stringValueOf(entry["content"]), 800)))
	}
	return strings.Join(lines, "\n---\n")
}

// optimizeCharacterSummary 汇总角色卡要点（对齐 Node charSummary 的字段与截断长度）。
func (s *Server) optimizeCharacterSummary(raw any, characterName string) string {
	character, _ := raw.(map[string]any)
	if character == nil {
		if card, err := s.readCharacterCard(characterName); err == nil {
			character = card
		}
	}
	if character == nil {
		return ""
	}
	type fieldLimit struct {
		key   string
		limit int
	}
	for _, item := range []fieldLimit{
		{"name", 0}, {"description", 600}, {"personality", 400}, {"scenario", 300},
		{"first_mes", 400}, {"mes_example", 500}, {"system_prompt", 600}, {"post_history_instructions", 400},
	} {
		value := strings.TrimSpace(stringValueOf(character[item.key]))
		if value == "" {
			continue
		}
		if item.limit > 0 {
			value = truncateString(value, item.limit)
		}
		_ = item
	}
	lines := []string{}
	for _, item := range []fieldLimit{
		{"name", 0}, {"description", 600}, {"personality", 400}, {"scenario", 300},
		{"first_mes", 400}, {"mes_example", 500}, {"system_prompt", 600}, {"post_history_instructions", 400},
	} {
		value := strings.TrimSpace(stringValueOf(character[item.key]))
		if value == "" {
			continue
		}
		if item.limit > 0 {
			value = truncateString(value, item.limit)
		}
		if item.key == "name" {
			lines = append(lines, "name: "+value)
			continue
		}
		lines = append(lines, item.key+": "+value)
	}
	return strings.Join(lines, "\n")
}

// optimizeWorldbookSummary 汇总世界书前 20 条（对齐 Node wbSummary）。
func (s *Server) optimizeWorldbookSummary(raw any) string {
	book, _ := raw.(map[string]any)
	if book == nil {
		if loaded, _, err := readRangeWorldBook(s.dataDir, s.currentWorldbookName()); err == nil && loaded != nil {
			book = worldBookToMap(loaded)
		}
	}
	if book == nil {
		return ""
	}
	entries := asList(book["entries"])
	if len(entries) > 20 {
		entries = entries[:20]
	}
	lines := []string{}
	for index, item := range entries {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		keys := strings.Join(toStringSliceOf(entry["key"]), ",")
		if keys == "" {
			keys = strings.Join(toStringSliceOf(entry["keys"]), ",")
		}
		position := "角色后"
		if intOr(entry["position"], 1) == 0 {
			position = "角色前"
		}
		lines = append(lines, fmt.Sprintf("条目#%d: key=%s | order=%d | position=%s | constant=%v | sticky=%d\ncontent: %s",
			index, keys, intOr(entry["order"], 100), position, entry["constant"] == true,
			intOr(entry["sticky"], 0), truncateString(stringValueOf(entry["content"]), 300)))
	}
	return strings.Join(lines, "\n---\n")
}

// optimizeCorpusSection 采样群聊语料（对齐 Node：有嵌入走语义检索，否则随机取 5 条）。
func (s *Server) optimizeCorpusSection(goal string, fallback string) string {
	lines, _, _, embeddings, embedModel, _, embedProviderID := s.rangeCorpusData()
	if len(lines) == 0 {
		if strings.TrimSpace(fallback) == "" {
			return ""
		}
		return "\n## 测试语料\n" + truncateString(fallback, 1500)
	}
	limit := 5
	if len(lines) < limit {
		limit = len(lines)
	}
	samples := []string{}
	if len(embeddings) > 0 {
		if vector, err := s.embedTexts([]string{goal}, embedProviderID, embedModel); err == nil && len(vector) == 1 {
			type scored struct {
				index int
				score float64
			}
			scores := []scored{}
			for index, candidate := range embeddings {
				scores = append(scores, scored{index: index, score: cosineSimilarity(vector[0], candidate)})
			}
			sort.Slice(scores, func(left int, right int) bool { return scores[left].score > scores[right].score })
			for _, item := range scores {
				if len(samples) >= limit {
					break
				}
				if item.index >= 0 && item.index < len(lines) {
					samples = append(samples, lines[item.index])
				}
			}
		}
	}
	if len(samples) == 0 {
		pool := make([]string, len(lines))
		copy(pool, lines)
		rand.Shuffle(len(pool), func(left int, right int) { pool[left], pool[right] = pool[right], pool[left] })
		samples = pool[:limit]
	}
	return fmt.Sprintf("\n## 群聊语料(共%d条,语义匹配%d条)\n%s\n从真实语料风格设计测试消息。",
		len(lines), limit, strings.Join(samples, "\n"))
}

// ---------------- agent 对话（AI） ----------------

func (s *Server) handleRangeAgentChat(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	rawMessages, _ := body["messages"].([]any)
	if len(rawMessages) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供消息数组"})
		return
	}
	contextPrompt := s.buildRangeAgentContext(body["rangeContext"])
	messages := []ai.Message{}
	if contextPrompt != "" {
		messages = append(messages, ai.Message{Role: "system", Content: contextPrompt})
	}
	for _, item := range rawMessages {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		role := textOf(entry["role"])
		if role != "user" && role != "assistant" && role != "system" {
			role = "user"
		}
		messages = append(messages, ai.Message{Role: role, Content: stringValueOf(entry["content"])})
	}
	providerID := firstText(textOf(body["modelProviderId"]), textOf(body["judgeProviderId"]))
	model := firstText(textOf(body["model"]), textOf(body["judgeModel"]))
	client := s.buildRangeAIClient(providerID, model)
	if client == nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "无法构建 AI 客户端，请检查 ai.providers 配置"})
		return
	}
	ctx, cancel := contextWithTimeout(time.Duration(s.document.Int("ai.timeout", 120)) * time.Second)
	defer cancel()
	completion, err := client.Chat(ctx, messages, nil)
	if err != nil {
		writeJSON(writer, http.StatusBadGateway, map[string]any{"success": false, "error": "模型请求失败: " + err.Error()})
		return
	}
	decision := parseJSONObject(completion.Content)
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":          true,
		"reply":            completion.Content,
		"reasoningContent": nilIf(completion.ReasoningContent),
		"agentDecision":    anyOr(decision["decision"], nil),
		"decision":         decision,
	})
}

// buildRangeAgentContext 拼装 agent 上下文提示（对齐 Node buildRangeAgentContextPrompt 的关键字段）。
func (s *Server) buildRangeAgentContext(rangeContext any) string {
	context, _ := rangeContext.(map[string]any)
	if context == nil {
		return ""
	}
	lines := []string{"你是 Prompt 调优靶场的自动化助手，请根据上下文给出下一步动作。"}
	appendField := func(label string, value any) {
		text := truncateString(stringValueOf(value), 1500)
		if strings.TrimSpace(text) == "" {
			return
		}
		lines = append(lines, fmt.Sprintf("## %s\n%s", label, text))
	}
	appendField("优化目标", context["goal"])
	appendField("当前预设状态", context["presetStatus"])
	appendField("最近测试结果", context["lastTestResult"])
	appendField("角色卡摘要", context["characterSummary"])
	appendField("世界书摘要", context["worldbookSummary"])
	appendField("agent 记忆", context["agentMemory"])
	appendField("语料样例", context["corpusSample"])
	lines = append(lines, "## 输出要求\n只输出 JSON：{\"decision\":\"test|score|modify|next_phase|done\",\"phase\":\"\",\"reason\":\"\",\"focusIssue\":\"\",\"message\":\"\"}")
	return strings.Join(lines, "\n\n")
}

// ---------------- 杂项辅助 ----------------

var jsonObjectPattern = regexp.MustCompile(`(?s)\{.*\}`)

// parseJSONObject 从模型输出里提取第一个 JSON 对象（容忍包裹文本/代码块）。
func parseJSONObject(text string) map[string]any {
	trimmed := strings.TrimSpace(text)
	trimmed = strings.TrimPrefix(trimmed, "```json")
	trimmed = strings.TrimPrefix(trimmed, "```")
	trimmed = strings.TrimSuffix(strings.TrimSpace(trimmed), "```")
	match := jsonObjectPattern.FindString(trimmed)
	if match == "" {
		return map[string]any{}
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(match), &parsed); err != nil {
		return map[string]any{}
	}
	return parsed
}

func splitNonEmpty(text string, separator string) []string {
	parts := strings.Split(text, separator)
	result := []string{}
	for _, part := range parts {
		if strings.TrimSpace(part) != "" {
			result = append(result, part)
		}
	}
	if len(result) == 0 {
		result = append(result, text)
	}
	return result
}

func truncateString(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit]
}

func minInt(left int, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

func randomSuffix(length int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	result := make([]byte, length)
	for index := range result {
		result[index] = alphabet[(int(time.Now().UnixNano())+index*7)%len(alphabet)]
	}
	return string(result)
}

func cosineSimilarity(left []float64, right []float64) float64 {
	if len(left) == 0 || len(left) != len(right) {
		return 0
	}
	var dot, leftNorm, rightNorm float64
	for index := range left {
		dot += left[index] * right[index]
		leftNorm += left[index] * left[index]
		rightNorm += right[index] * right[index]
	}
	if leftNorm == 0 || rightNorm == 0 {
		return 0
	}
	return dot / (sqrt(leftNorm) * sqrt(rightNorm))
}

func sqrt(value float64) float64 {
	if value <= 0 {
		return 0
	}
	x := value
	for index := 0; index < 40; index++ {
		x = (x + value/x) / 2
	}
	return x
}

// stringValueOf 把任意值渲染为字符串（对齐 Node String(value ?? ”)）。
func stringValueOf(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%d", int64(typed))
		}
		return fmt.Sprintf("%v", typed)
	case bool:
		if typed {
			return "true"
		}
		return "false"
	default:
		encoded, err := json.Marshal(typed)
		if err == nil {
			return string(encoded)
		}
		return fmt.Sprintf("%v", typed)
	}
}

// storeVariableFilters 构造按角色过滤的变量查询（靶场变量段）。
func storeVariableFilters(characterName string) store.VariableFilters {
	filters := store.VariableFilters{Limit: 200}
	if strings.TrimSpace(characterName) != "" {
		filters.CharacterName = characterName
	}
	return filters
}

// rangeEmbedProgressPayload 返回嵌入进度（面板 /api/prompt-range/corpus-progress 与 /api/status 共用）。
func (s *Server) rangeEmbedProgressPayload() map[string]any {
	s.rangeState.mu.Lock()
	defer s.rangeState.mu.Unlock()
	stage := "idle"
	switch {
	case s.rangeState.embedRunning:
		stage = "embedding"
	case s.rangeState.embedAborted:
		stage = "cancelled"
	case s.rangeState.embedPercent == 100 && s.rangeState.embedMessage != "":
		stage = "completed"
	}
	return map[string]any{
		"running":         s.rangeState.embedRunning,
		"stage":           stage,
		"currentMessage":  s.rangeState.embedMessage,
		"progressPercent": s.rangeState.embedPercent,
		"totalBatches":    s.rangeState.embedBatches,
		"currentBatch":    s.rangeState.embedCurrent,
		"error":           nil,
	}
}

// boolPointerOf 把请求体里的可选布尔值转成指针（nil 表示未提供）。
func boolPointerOf(value any) *bool {
	if flag, ok := value.(bool); ok {
		return &flag
	}
	return nil
}
