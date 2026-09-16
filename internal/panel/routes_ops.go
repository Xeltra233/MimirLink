package panel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tidwall/gjson"

	"mimirlink/internal/ai"
	"mimirlink/internal/store"
)

// 本文件补齐面板「记忆管理 / AI 模型 / 会话删除 / prompt-range / 预设导出」路由，
// 形状对齐 Node 版 src/routes.js（memory 3436-3560、ai 4474-4524、
// sessions 3213-3234、prompt-range 7033-7180、preset/export 5117）。

func (s *Server) registerOpsRoutes() {
	s.mux.HandleFunc("/api/memory/variables", s.requireAuth(s.handleMemoryVariables))
	s.mux.HandleFunc("/api/memory/variables/", s.requireAuth(s.handleMemoryVariableDetail))
	s.mux.HandleFunc("/api/memory/knowledge", s.requireAuth(s.handleMemoryKnowledge))
	s.mux.HandleFunc("/api/memory/activate", s.requireAuth(s.handleMemoryActivate))
	s.mux.HandleFunc("/api/memory/migrate", s.requireAuth(s.handleMemoryMigrate))
	s.mux.HandleFunc("/api/participant-profiles", s.requireAuth(s.handleParticipantProfiles))
	s.mux.HandleFunc("/api/ai/models", s.requireAuth(s.handleAIModels))
	s.mux.HandleFunc("/api/ai/model-capabilities", s.requireAuth(s.handleAIModelCapabilities))
	s.mux.HandleFunc("/api/prompt-range/prefs", s.requireAuth(s.handleRangePrefs))
	s.mux.HandleFunc("/api/prompt-range/models", s.requireAuth(s.handleRangeModels))
	s.mux.HandleFunc("/api/prompt-range/corpus", s.requireAuth(s.handleRangeCorpus))
	s.mux.HandleFunc("/api/prompt-range/corpus-progress", s.requireAuth(s.handleRangeCorpusProgress))
	s.mux.HandleFunc("/api/preset/export", s.requireAuth(s.handlePresetExport))
}

// ---------- 记忆变量 ----------

func normalizeFilters(query map[string][]string) store.VariableFilters {
	get := func(key string) string {
		if values, ok := query[key]; ok && len(values) > 0 {
			return strings.TrimSpace(values[0])
		}
		return ""
	}
	limit := 100
	if raw := get("limit"); raw != "" {
		if parsed := atoiOr(raw, 100); parsed >= 1 && parsed <= 500 {
			limit = parsed
		}
	}
	return store.VariableFilters{
		ScopeType:     get("scopeType"),
		ScopeKey:      get("scopeKey"),
		CharacterName: get("characterName"),
		PresetName:    get("presetName"),
		Search:        get("search"),
		KnowledgeType: get("knowledgeType"),
		Limit:         limit,
	}
}

func atoiOr(raw string, fallback int) int {
	value := 0
	if _, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &value); err != nil || value == 0 {
		return fallback
	}
	return value
}

func (s *Server) handleMemoryVariables(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		filters := normalizeFilters(request.URL.Query())
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		items, err := database.ListVariables(filters)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"success":      true,
			"items":        items,
			"filters":      filtersPayload(filters),
			"activeMemory": s.activeMemoryInfo(),
		})
	case http.MethodPost:
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
			return
		}
		options, message := s.variableScope(body), ""
		variable := store.Variable{
			Key:       textOf(body["key"]),
			Title:     textOf(body["title"]),
			ValueType: textOr(body["valueType"], "string"),
			RawValue:  textOf(body["rawValue"]),
			Value:     body["value"],
			Tags:      stringListOf(body["tags"]),
			Metadata:  objectOf(body["metadata"]),
		}
		if variable.RawValue == "" && variable.Value == nil {
			variable.RawValue = textOf(body["content"])
		}
		if note := textOf(body["note"]); note != "" {
			if variable.Metadata == nil {
				variable.Metadata = map[string]any{}
			}
			variable.Metadata["note"] = note
		}
		if variable.Metadata == nil {
			variable.Metadata = map[string]any{}
		}
		variable.Metadata["updatedBy"] = textOr(variable.Metadata["updatedBy"], "admin-panel")
		variable.Metadata["source"] = "admin"
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		id, updated, err := database.UpsertVariable(options, variable)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		item, err := database.GetVariableByEntryId(id)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if updated {
			message = "变量已更新"
		} else {
			message = "变量已创建"
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item, "created": !updated, "message": message})
	case http.MethodDelete:
		// 清空指定 scope 下的全部变量（对齐 Node DELETE /api/memory/variables?scopeKey=...）
		query := request.URL.Query()
		if strings.TrimSpace(query.Get("scopeKey")) == "" {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "必须指定 scopeKey"})
			return
		}
		filters := normalizeFilters(query)
		filters.Limit = 500
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		items, err := database.ListVariables(filters)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		deleted := 0
		for _, item := range items {
			if ok, err := database.DeleteVariable(item.ID); err == nil && ok {
				deleted++
			}
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": fmt.Sprintf("已彻底删除 %d 个变量（含系统变量）", deleted), "deleted": deleted})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

func (s *Server) handleMemoryVariableDetail(writer http.ResponseWriter, request *http.Request) {
	entryID := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/memory/variables/"), "/")
	if entryID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少变量 ID"})
		return
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	switch request.Method {
	case http.MethodGet:
		item, err := database.GetVariableByEntryId(entryID)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if item == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "变量不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item})
	case http.MethodDelete:
		deleted, err := database.DeleteVariable(entryID)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if !deleted {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "变量不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "变量已删除"})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// variableScope 对齐 Node normalizeVariableScopeInput 的回退链。
func (s *Server) variableScope(body map[string]any) store.NamespaceOptions {
	options := store.NamespaceOptions{
		ScopeType:     textOr(body["scopeType"], textOr(s.document.String("chat.sessionMode"), "user_persistent")),
		ScopeKey:      textOr(body["scopeKey"], "default"),
		CharacterName: textOf(body["characterName"]),
		PresetName:    textOf(body["presetName"]),
	}
	return options
}

// ---------- 知识条目 ----------

func (s *Server) handleMemoryKnowledge(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		query := request.URL.Query()
		filters := normalizeFilters(map[string][]string(query))
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		items, err := database.ListKnowledgeEntriesFiltered(filters)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{
			"success":      true,
			"items":        items,
			"filters":      filtersPayload(filters),
			"activeMemory": s.activeMemoryInfo(),
		})
	case http.MethodPost:
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
			return
		}
		entry := store.KnowledgeEntry{
			ID:            textOr(textOf(body["id"]), textOf(body["entryId"])),
			Title:         textOf(body["title"]),
			Content:       textOf(body["content"]),
			KnowledgeType: textOr(body["knowledgeType"], "dynamic"),
			Tags:          stringListOf(body["tags"]),
			Metadata:      objectOf(body["metadata"]),
		}
		if entry.Metadata == nil {
			entry.Metadata = map[string]any{}
		}
		if note := textOf(body["note"]); note != "" {
			entry.Metadata["note"] = note
		}
		options := s.variableScope(body)
		if character := textOr(body["characterName"], textOr(body["character"], textOr(body["roleName"], textOr(body["role"], "")))); character != "" && options.CharacterName == "" {
			options.CharacterName = character
		}
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		// 带 id/entryId 时为更新（对齐 Node payload.entryId → saveKnowledgeEntry 路径），否则新建
		if entry.ID != "" {
			updated, err := database.UpdateKnowledgeEntry(entry.ID, entry)
			if err != nil {
				statusCode := http.StatusInternalServerError
				if strings.Contains(err.Error(), "不能为空") {
					statusCode = http.StatusBadRequest
				}
				writeJSON(writer, statusCode, map[string]any{"success": false, "error": err.Error()})
				return
			}
			if !updated {
				writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "知识条目不存在"})
				return
			}
			item, _ := database.GetKnowledgeEntry(entry.ID)
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item, "created": false, "message": "知识条目已更新"})
			return
		}
		id, err := database.UpsertKnowledgeEntry(options, entry)
		if err != nil {
			statusCode := http.StatusInternalServerError
			if strings.Contains(err.Error(), "不能为空") {
				statusCode = http.StatusBadRequest
			}
			writeJSON(writer, statusCode, map[string]any{"success": false, "error": err.Error()})
			return
		}
		item, _ := database.GetKnowledgeEntry(id)
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item, "created": true, "message": "知识条目已创建"})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// ---------- 人物档案 ----------

func (s *Server) handleParticipantProfiles(writer http.ResponseWriter, request *http.Request) {
	if request.Method == http.MethodPost {
		s.handleParticipantProfileSave(writer, request)
		return
	}
	if request.Method != http.MethodGet {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	limit := atoiOr(request.URL.Query().Get("limit"), 50)
	if limit < 1 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	search := strings.TrimSpace(request.URL.Query().Get("search"))
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	items, err := database.ListParticipantProfiles(limit, search)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	total, err := database.CountParticipantProfiles("")
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	filteredTotal := total
	if search != "" {
		if filteredTotal, err = database.CountParticipantProfiles(search); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "items": items, "total": total, "filteredTotal": filteredTotal, "search": search,
	})
}

// ---------- 记忆库切换与迁移 ----------

func (s *Server) handleMemoryActivate(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body struct {
		DBPath string `json:"dbPath"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil || strings.TrimSpace(body.DBPath) == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少 dbPath"})
		return
	}
	dbPath := strings.TrimSpace(body.DBPath)
	if err := s.document.Set("memory.storage.path", dbPath); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Set("bindings.global.memoryDbPath", dbPath); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "dbPath": dbPath})
}

func (s *Server) handleMemoryMigrate(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body struct {
		TargetPath    string   `json:"targetPath"`
		SourcePath    string   `json:"sourcePath"`
		Replace       bool     `json:"replace"`
		SessionIDs    []string `json:"sessionIds"`
		SessionPrefix string   `json:"sessionPrefix"`
		UserID        string   `json:"userId"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	if strings.TrimSpace(body.TargetPath) == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "目标数据库路径不能为空"})
		return
	}
	if len(body.SessionIDs) > 0 || strings.TrimSpace(body.SessionPrefix) != "" || strings.TrimSpace(body.UserID) != "" {
		// 诚实边界：Go 版迁移走 SQLite VACUUM INTO 全量复制，暂不支持按会话筛选
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "Go 版暂不支持按会话筛选迁移（sessionIds/sessionPrefix/userId），请使用全量迁移",
		})
		return
	}
	sourcePath := strings.TrimSpace(body.SourcePath)
	if sourcePath == "" {
		database, path, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		sourcePath = path
		_ = database.Close()
	}
	if _, err := os.Stat(sourcePath); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": fmt.Sprintf("源数据库不存在: %s", sourcePath)})
		return
	}
	targetPath := strings.TrimSpace(body.TargetPath)
	if _, err := os.Stat(targetPath); err == nil {
		if !body.Replace {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "目标数据库已存在（replace=true 可覆盖）"})
			return
		}
		if err := os.Remove(targetPath); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
	} else if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	source, err := store.OpenReadOnly(sourcePath)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer source.Close()
	if _, err := source.Exec(fmt.Sprintf("VACUUM INTO '%s'", strings.ReplaceAll(targetPath, "'", "''"))); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("迁移失败: %v", err)})
		return
	}
	var counts store.Counts
	if target, err := store.OpenReadOnly(targetPath); err == nil {
		counts, _ = target.Counts()
		_ = target.Close()
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":    true,
		"sourcePath": sourcePath,
		"targetPath": targetPath,
		"result":     map[string]any{"sessions": counts.Sessions, "messages": counts.Messages, "summaries": counts.Summaries},
		"message":    "记忆迁移完成",
	})
}

// ---------- AI 模型 ----------

func (s *Server) handleAIModels(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body map[string]any
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		body = map[string]any{}
	}
	baseURL, apiKey := s.resolveAIProviderConfig(body)
	models, err := ai.ListModels(baseURL, apiKey)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "models": models})
}

// resolveAIProviderConfig 对齐 Node resolveAIProviderRequestConfig：providerId 精确匹配，
// 未知 providerId 不回退全局，避免把一个供应商的 Key 串给另一个供应商。
func (s *Server) resolveAIProviderConfig(body map[string]any) (baseURL string, apiKey string) {
	providerID := textOf(body["providerId"])
	baseURL = textOf(body["baseUrl"])
	apiKey = strings.TrimSpace(textOf(body["apiKey"]))
	if apiKey == "******" {
		apiKey = ""
	}
	providers := s.document.Get("ai.providers").Array()
	var provider gjson.Result
	if providerID != "" {
		for _, item := range providers {
			if item.Get("id").String() == providerID {
				provider = item
				break
			}
		}
		if !provider.Exists() {
			return strings.TrimSpace(baseURL), strings.TrimSpace(apiKey)
		}
	} else if len(providers) == 0 {
		provider = s.document.Get("ai")
	}
	if baseURL == "" && provider.Exists() {
		baseURL = strings.TrimSpace(provider.Get("baseUrl").String())
	}
	if apiKey == "" && provider.Exists() {
		apiKey = strings.TrimSpace(provider.Get("apiKey").String())
	}
	return strings.TrimSpace(baseURL), strings.TrimSpace(apiKey)
}

func (s *Server) handleAIModelCapabilities(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	var body struct {
		Models     []any  `json:"models"`
		ProviderID string `json:"providerId"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	// 找到 provider 配置（用于「拉取模型」条目判断）
	var providerModels []gjson.Result
	if body.ProviderID != "" {
		for _, item := range s.document.Get("ai.providers").Array() {
			if item.Get("id").String() == body.ProviderID {
				providerModels = item.Get("models").Array()
				break
			}
		}
	}
	knownModels := map[string]bool{}
	for _, item := range providerModels {
		id := firstText(item.Get("id").String(), item.Get("name").String())
		if id != "" {
			knownModels[id] = true
		}
	}
	capabilities := map[string]ai.ModelCapability{}
	processed := 0
	for _, raw := range body.Models {
		if processed >= 500 {
			break
		}
		var id string
		pulled := false
		switch typed := raw.(type) {
		case string:
			id = strings.TrimSpace(typed)
		case map[string]any:
			id = firstText2(textOf(typed["id"]), textOf(typed["name"]))
			pulled = typed["pulled"] == true
		}
		if id == "" {
			continue
		}
		processed++
		inferred := ai.InferModelSupportsImage(id)
		supported := false
		if inferred != nil {
			supported = *inferred
		} else if pulled || knownModels[id] {
			// 拉取模型/供应商已配置条目：与 Node 一致按 pulled 来源处理
			if pulled {
				supported = true
			}
		}
		capability := ai.ModelCapability{
			Supported: &supported,
			Inferred:  inferred,
			Reason:    ai.ModelCapabilityReason(id),
		}
		switch {
		case inferred == nil && pulled:
			capability.Source = "pulled"
			capability.Reason = "从「拉取模型」添加的模型，未识别的名字按支持图片处理"
		case inferred == nil:
			capability.Source = "default"
			capability.Reason = "未能识别模型名且不是从「拉取模型」添加，按不支持图片处理（走图片转述）"
		default:
			capability.Source = "inferred"
		}
		capabilities[id] = capability
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "capabilities": capabilities})
}

// ---------- prompt-range ----------

var rangePrefsFile = "range-prefs.json"

func (s *Server) handleRangePrefs(writer http.ResponseWriter, request *http.Request) {
	path := filepath.Join(s.dataDir, rangePrefsFile)
	switch request.Method {
	case http.MethodGet:
		data, err := os.ReadFile(path)
		if err != nil {
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "prefs": map[string]any{}})
			return
		}
		var prefs map[string]any
		if err := json.Unmarshal(data, &prefs); err != nil {
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "prefs": map[string]any{}})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "prefs": prefs})
	case http.MethodPost:
		var prefs map[string]any
		if err := json.NewDecoder(request.Body).Decode(&prefs); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
			return
		}
		encoded, err := json.MarshalIndent(prefs, "", "  ")
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

var (
	rangeEmbedRe  = regexp.MustCompile(`(?i)(?:text-embedding|embed|bge-|e5-|gte-|voyage-|jina-embeddings|llm2vec|retrieval|uae-)`)
	rangeRerankRe = regexp.MustCompile(`(?i)(?:rerank|re-rank|bge-rerank|cohere.*rerank|jina.*rerank)`)
	rangeVisionRe = regexp.MustCompile(`(?i)(?:vision|vl|gemini-2\.5|claude-3|gpt-4o|pixtral|qwen-vl|glm-4v|cogview|dall-e|flux|imagen)`)
)

func classifyRangeModel(modelID string) string {
	id := strings.ToLower(modelID)
	switch {
	case rangeRerankRe.MatchString(id):
		return "rerank"
	case rangeEmbedRe.MatchString(id):
		return "embedding"
	case rangeVisionRe.MatchString(id):
		return "vision"
	default:
		return "chat"
	}
}

// isLocalAIEndpoint 对齐 Node isLocalAIEndpoint。
func isLocalAIEndpoint(baseURL string) bool {
	text := strings.ToLower(strings.TrimSpace(baseURL))
	return regexp.MustCompile(`^https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|/|$)`).MatchString(text)
}

func (s *Server) handleRangeModels(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	providers := []map[string]any{}
	for _, item := range s.document.Get("ai.providers").Array() {
		models := []map[string]any{}
		chat, embed, rerank := 0, 0, 0
		for _, model := range item.Get("models").Array() {
			id := firstText(model.Get("id").String(), model.Get("name").String())
			capability := classifyRangeModel(id)
			entry := map[string]any{
				"id":         id,
				"name":       model.Get("name").String(),
				"capability": capability,
			}
			if model.Get("owned_by").Exists() {
				entry["ownedBy"] = model.Get("owned_by").String()
			}
			models = append(models, entry)
			switch capability {
			case "chat":
				chat++
			case "embedding":
				embed++
			case "rerank":
				rerank++
			}
		}
		baseURL := item.Get("baseUrl").String()
		providerType := strings.ToLower(item.Get("provider").String())
		requiresAPIKey := providerType != "ollama" && !isLocalAIEndpoint(baseURL)
		providers = append(providers, map[string]any{
			"id":               item.Get("id").String(),
			"name":             item.Get("name").String(),
			"provider":         item.Get("provider").String(),
			"model":            item.Get("model").String(),
			"hasApiKey":        item.Get("apiKey").String() != "",
			"requiresApiKey":   requiresAPIKey,
			"models":           models,
			"chatModels":       filterByCapability(models, "chat"),
			"embedModels":      filterByCapability(models, "embedding"),
			"rerankModels":     filterByCapability(models, "rerank"),
			"hasEmbedSupport":  embed > 0,
			"hasRerankSupport": rerank > 0,
		})
	}
	activeProviderID := textOr(s.document.Get("chat.modelProviderId").Value(), s.document.Get("ai.activeProviderId").String())
	activeModel := textOr(s.document.Get("chat.model").Value(), s.document.Get("ai.model").String())
	corpusStatus := s.rangeCorpusStatus()
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":          true,
		"providers":        providers,
		"activeProviderId": activeProviderID,
		"activeModel":      activeModel,
		"corpusStatus":     corpusStatus,
	})
}

func filterByCapability(models []map[string]any, capability string) []map[string]any {
	filtered := []map[string]any{}
	for _, model := range models {
		if model["capability"] == capability {
			filtered = append(filtered, model)
		}
	}
	return filtered
}

// rangeCorpus 读取 data/range-corpus.json（与 Node rangeCorpusStore 同一数据源）。
func (s *Server) rangeCorpus() (lines []string, embeddingsCount int, embedModel string, embedProvider string, stats map[string]any) {
	lines = []string{}
	data, err := os.ReadFile(filepath.Join(s.dataDir, "range-corpus.json"))
	if err != nil {
		return
	}
	var payload struct {
		Lines         []string       `json:"lines"`
		Embeddings    []any          `json:"embeddings"`
		EmbedModel    string         `json:"embedModel"`
		EmbedProvider string         `json:"embedProvider"`
		Stats         map[string]any `json:"stats"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return
	}
	lines = payload.Lines
	embeddingsCount = len(payload.Embeddings)
	embedModel = payload.EmbedModel
	embedProvider = payload.EmbedProvider
	stats = payload.Stats
	return
}

func (s *Server) rangeCorpusStatus() map[string]any {
	lines, embeddings, embedModel, embedProvider, stats := s.rangeCorpus()
	if len(lines) == 0 {
		return nil
	}
	return map[string]any{
		"lineCount":     len(lines),
		"hasEmbeddings": embeddings > 0,
		"embedModel":    embedModel,
		"embedProvider": embedProvider,
		"stats":         stats,
	}
}

func (s *Server) handleRangeCorpus(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	lines, _, _, _, stats := s.rangeCorpus()
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"corpus":  strings.Join(lines, "\n"),
		"stats":   stats,
	})
}

func (s *Server) handleRangeCorpusProgress(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	lines, embeddings, _, _, _ := s.rangeCorpus()
	progress := s.rangeEmbedProgressPayload()
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":         true,
		"running":         progress["running"],
		"stage":           progress["stage"],
		"currentMessage":  progress["currentMessage"],
		"progressPercent": progress["progressPercent"],
		"totalBatches":    progress["totalBatches"],
		"currentBatch":    progress["currentBatch"],
		"error":           progress["error"],
		"lineCount":       len(lines),
		"hasEmbeddings":   embeddings > 0,
	})
}

// ---------- 预设导出 ----------

func (s *Server) handlePresetExport(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	format := "native"
	if request.URL.Query().Get("format") == "sillytavern" {
		format = "sillytavern"
	}
	normalized := normalizePresetForExport(s.document.Get("preset"))
	var payload map[string]any
	if format == "sillytavern" {
		payload = map[string]any{
			"name":    textOr(normalized["name"], "Imported Preset"),
			"prompts": normalized["prompts"],
		}
	} else {
		payload = map[string]any{"preset": normalized}
	}
	encoded, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=preset-%s-%d.json", format, nowMillis()))
	_, _ = writer.Write(encoded)
}

// normalizePresetForExport 对齐 Node PromptBuilder.normalizePreset 的关键字段归一。
func normalizePresetForExport(source gjson.Result) map[string]any {
	prompts := []map[string]any{}
	for _, item := range source.Get("prompts").Array() {
		if item.Value() == nil {
			continue
		}
		prompts = append(prompts, map[string]any{
			"identifier":         item.Get("identifier").String(),
			"name":               item.Get("name").String(),
			"role":               textOr(item.Get("role").Value(), "system"),
			"content":            item.Get("content").String(),
			"enabled":            boolOr(item.Get("enabled").Value(), true),
			"injection_position": intOr(item.Get("injection_position").Value(), 0),
			"injection_depth":    intOr(item.Get("injection_depth").Value(), 0),
			"forbid_overrides":   boolOr(item.Get("forbid_overrides").Value(), false),
			"marker":             boolOr(item.Get("marker").Value(), false),
			"system_prompt":      boolOr(item.Get("system_prompt").Value(), false),
		})
	}
	enabled := source.Get("enabled").Bool()
	name := source.Get("name").String()
	return map[string]any{
		"enabled":    enabled,
		"name":       name,
		"prompts":    prompts,
		"regexRules": anyOr(source.Get("regexRules").Value(), []any{}),
	}
}

// ---------- 通用辅助 ----------

func textOf(value any) string {
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func firstText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstText2(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}

func textOr(value any, fallback string) string {
	if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
		return text
	}
	return fallback
}

func textOrAny(value any, fallback any) any {
	if value != nil {
		return value
	}
	return fallback
}

func boolOr(value any, fallback bool) bool {
	if value == nil {
		return fallback
	}
	if typed, ok := value.(bool); ok {
		return typed
	}
	return fallback
}

func intOr(value any, fallback int) int {
	if value == nil {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	default:
		return fallback
	}
}

func anyOr(value any, fallback any) any {
	if value == nil {
		return fallback
	}
	return value
}

func stringListOf(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	result := []string{}
	for _, item := range items {
		if text, ok := item.(string); ok {
			result = append(result, text)
		}
	}
	return result
}

func objectOf(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func filtersPayload(filters store.VariableFilters) map[string]any {
	return map[string]any{
		"scopeType":     filters.ScopeType,
		"scopeKey":      filters.ScopeKey,
		"characterName": filters.CharacterName,
		"presetName":    filters.PresetName,
		"search":        filters.Search,
		"knowledgeType": filters.KnowledgeType,
		"limit":         filters.Limit,
	}
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// activeMemoryInfo 对齐 Node getActiveMemoryInfo 的面板形状。
func (s *Server) activeMemoryInfo() map[string]any {
	dbPath := ""
	if database, path, err := s.openActiveMemory(); err == nil {
		dbPath = path
		_ = database.Close()
	} else {
		dbPath = path
	}
	sessionMode := textOr(s.document.String("chat.sessionMode"), "user_persistent")
	scopeDescriptions := map[string]string{
		"user_persistent": "同一 QQ 跨群/跨私聊共享长期记忆",
		"group_user":      "每个群内每个用户单独记忆",
		"group_shared":    "同一群共享一份记忆",
		"global_shared":   "所有来源共享一份记忆",
	}
	return map[string]any{
		"currentCharacter":  nilIf(s.document.String("chat.defaultCharacter")),
		"dbPath":            dbPath,
		"sessionMode":       sessionMode,
		"accessControlMode": textOr(s.document.String("chat.accessControlMode"), "allowlist"),
		"scopeDescription":  scopeDescriptions[sessionMode],
	}
}

func nilIf(value string) any {
	if value == "" {
		return nil
	}
	return value
}
