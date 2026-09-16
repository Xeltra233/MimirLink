package panel

import (
	"encoding/json"
	"fmt"
	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/chat"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// 本文件补齐前端主要页面依赖的读接口（形状对齐 Node 版 src/routes.js）。

func (s *Server) registerExtendedRoutes() {
	s.mux.HandleFunc("/api/status", s.requireAuth(s.handleStatus))
	s.mux.HandleFunc("/api/characters", s.requireAuth(s.handleCharacters))
	s.mux.HandleFunc("/api/characters/current", s.requireAuth(s.handleCharacterCurrent))
	s.mux.HandleFunc("/api/characters/", s.requireAuth(s.handleCharacterDetail))
	s.mux.HandleFunc("/api/worldbooks", s.requireAuth(s.handleWorldbooks))
	s.mux.HandleFunc("/api/worldbooks/current", s.requireAuth(s.handleWorldbookCurrent))
	s.mux.HandleFunc("/api/sessions", s.requireAuth(s.handleSessions))
	s.mux.HandleFunc("/api/sessions/", s.requireAuth(s.handleSessionDetail))
	s.mux.HandleFunc("/api/logs/files", s.requireAuth(s.handleLogFiles))
	s.mux.HandleFunc("/api/logs/content/", s.requireAuth(s.handleLogContent))
	s.mux.HandleFunc("/api/test/ai", s.requireAuth(s.handleTestAI))
	s.mux.HandleFunc("/api/ai/probe", s.requireAuth(s.handleTestAI))
}

// ---------- /api/status ----------

func (s *Server) handleStatus(writer http.ResponseWriter, request *http.Request) {
	counts := store.Counts{}
	composition := store.CompositionCounts{}
	oldestMessage, newestMessage := int64(0), int64(0)
	activePath := ""
	if database, path, err := s.openActiveMemory(); err == nil {
		activePath = path
		if c, err := database.Counts(); err == nil {
			counts = c
		}
		if c, err := database.CompositionCounts(); err == nil {
			composition = c
		}
		if oldest, newest := database.MessageTimeRange(); oldest > 0 || newest > 0 {
			oldestMessage, newestMessage = oldest, newest
		}
		_ = database.Close()
	}
	character := s.currentCharacterName()
	worldbook := s.currentWorldbookName()
	sessionMode := fallback(s.document.String("chat.sessionMode"), "user_persistent")

	var memStats runtime.MemStats
	runtime.ReadMemStats(&memStats)
	writeJSON(writer, http.StatusOK, map[string]any{
		"version": Version,
		"uptime":  time.Since(s.startedAt).Seconds(),
		"memory": map[string]any{
			"rss":       memStats.Sys,
			"heapUsed":  memStats.HeapAlloc,
			"heapTotal": memStats.HeapSys,
			"external":  memStats.StackInuse,
		},
		"llmEnabled":                  true,
		"participantProfileProgress":  nil,
		"knowledgeImportProgress":     nil,
		"corpusEmbedProgress":         s.rangeEmbedProgressPayload(),
		"lastRouting":                 nil,
		"lastInjectionObservation":    nil,
		"recentInjectionObservations": []any{},
		"lastRecall":                  nil,
		"tokenStats":                  nil,
		"runtime": map[string]any{
			"maxConcurrentSessions": s.document.Int("chat.maxConcurrentSessions", 4),
			"bufferWindowMs":        s.document.Int("chat.bufferWindowMs", 1200),
			"engine":                "go",
		},
		"onebot":        s.onebotStatusPayload(),
		"character":     fallback(character, "未选择"),
		"characterFile": characterFileOf(character),
		"worldbook":     fallback(worldbook, "未加载"),
		"sessions": map[string]any{
			"active": counts.Sessions,
			"total":  counts.Sessions,
		},
		"activeSessions": counts.Sessions,
		"messages":       counts.Messages,
		"summaries":      counts.Summaries,
		"globalMemory": map[string]any{
			"sessions":         counts.Sessions,
			"messages":         counts.Messages,
			"totalMessages":    counts.Messages,
			"totalSessions":    counts.Sessions,
			"summaries":        counts.Summaries,
			"totalSummaries":   counts.Summaries,
			"sessionMode":      sessionMode,
			"oldestMessage":    nilIfZero(oldestMessage),
			"newestMessage":    nilIfZero(newestMessage),
			"memoryFileSizeMB": memoryFileSizeMB(activePath),
			"storage": map[string]any{
				"type": "sqlite",
				"path": activePath,
			},
		},
		// 面板数据构成（对齐 Node getDashboardMetricsSnapshot 的 composition 字段）
		"dashboardMetrics": map[string]any{
			"bucketMs": 600000,
			"timeline": []any{},
			"series": map[string]any{
				"chat":               []any{},
				"participantProfile": []any{},
				"knowledgeImport":    []any{},
				"tts":                []any{},
			},
			"composition": map[string]any{
				"messages":            counts.Messages,
				"summaries":           counts.Summaries,
				"participantProfiles": composition.ParticipantProfiles,
				"fixedKnowledge":      composition.FixedKnowledge,
				"dynamicKnowledge":    composition.DynamicKnowledge,
			},
			"updatedAt": time.Now().UnixMilli(),
		},
		"activeMemory": map[string]any{
			"currentCharacter":  character,
			"dbPath":            activePath,
			"sessionMode":       sessionMode,
			"accessControlMode": fallback(s.document.String("chat.accessControlMode"), "allowlist"),
			"adminUsers":        stringList(s.document, "chat.adminUsers"),
			"scopeDescription":  scopeDescription(sessionMode),
		},
		"chatRuntime": map[string]any{
			"maxConcurrentSessions": s.document.Int("chat.maxConcurrentSessions", 4),
			"bufferWindowMs":        s.document.Int("chat.bufferWindowMs", 1200),
			"replyDelayMs":          s.document.Int("chat.replyDelayMs", 0),
			"segmentDelayMs":        s.document.Int("chat.segmentDelayMs", 0),
			"historyLimit":          s.document.Int("chat.historyLimit", 100),
		},
		"model": s.document.String("chat.model"),
		"server": map[string]any{
			"host":                s.document.String("server.host"),
			"port":                s.document.Int("server.port", 8001),
			"healthLogIntervalMs": s.document.Int("server.healthLogIntervalMs", 60000),
		},
	})
}

// scopeDescription 返回四种 sessionMode 的中文说明（与 Node 一致）。
func scopeDescription(mode string) string {
	switch mode {
	case "user_persistent":
		return "同一 QQ 跨群/跨私聊共享长期记忆"
	case "group_user":
		return "每个群内每个用户单独记忆"
	case "group_shared":
		return "同一群共享一份记忆"
	case "global_shared":
		return "所有来源共享一份记忆"
	default:
		return ""
	}
}

func characterFileOf(name string) any {
	if strings.TrimSpace(name) == "" {
		return nil
	}
	return strings.TrimSuffix(name, filepath.Ext(name)) + ".png"
}

func (s *Server) currentWorldbookName() string {
	name := s.document.String("bindings.global.worldbook")
	if name == "" {
		name = s.document.String("chat.defaultWorldbook")
	}
	return name
}

func stringList(document *config.Document, path string) []string {
	result := document.Get(path)
	if !result.IsArray() {
		return []string{}
	}
	values := []string{}
	for _, item := range result.Array() {
		values = append(values, item.String())
	}
	return values
}

func fallback(value string, placeholder string) string {
	if strings.TrimSpace(value) == "" {
		return placeholder
	}
	return value
}

// ---------- 角色 ----------

func (s *Server) handleCharacters(writer http.ResponseWriter, request *http.Request) {
	cards := characters.List(s.dataDir)
	payload := make([]map[string]any, 0, len(cards))
	for _, card := range cards {
		payload = append(payload, map[string]any{"name": card.Name, "filename": card.Filename})
	}
	writeJSON(writer, http.StatusOK, payload)
}

func (s *Server) currentCharacterName() string {
	name := s.document.String("bindings.global.character")
	if name == "" {
		name = s.document.String("chat.defaultCharacter")
	}
	return name
}

func (s *Server) handleCharacterCurrent(writer http.ResponseWriter, request *http.Request) {
	name := s.currentCharacterName()
	if name == "" {
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": "未选择角色"})
		return
	}
	data, err := characters.Read(s.dataDir, name)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, data)
}

// characterManageActions 是需要交给 handleCharacterManage 处理的子操作后缀。
// 之前用「路径分段数 > 0」判断，导致 /api/characters/<name>/detail 与
// handleCharacterManage 的 default 分支互相递归，直接栈溢出杀掉面板进程。
var characterManageActions = []string{
	"/update", "/variable-defaults", "/download",
	"/memory-binding", "/worldbook-binding",
}

func (s *Server) handleCharacterDetail(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/characters/"), "/")
	if request.Method == http.MethodDelete {
		s.handleCharacterManage(writer, request)
		return
	}
	for _, action := range characterManageActions {
		if strings.HasSuffix(rest, action) {
			s.handleCharacterManage(writer, request)
			return
		}
	}
	name := strings.TrimSuffix(rest, "/detail")
	if strings.Contains(name, "/") {
		// 未识别的多级子路径：与 Node（未注册路由）一致返回 404，且不得进入递归分发
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "未知子路径"})
		return
	}
	s.renderCharacterDetail(writer, name)
}

// renderCharacterDetail 输出角色卡详情（/api/characters/:filename[/detail]）。
func (s *Server) renderCharacterDetail(writer http.ResponseWriter, name string) {
	safe, err := safeName(name)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	data, err := characters.Read(s.dataDir, safe)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
		return
	}
	metadata := s.characterMetadata(name)
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":             true,
		"character":           data,
		"importedMetadata":    metadata,
		"importPlan":          characterImportPlan(metadata),
		"bindingSummary":      s.bindingSummary(name),
		"variableScanSummary": s.variableScanSummary(name, metadata),
		// 前端「酒馆导入信息」面板读的是 summarizeCharacterMetadata 的字段
		// （hasEmbeddedWorldBook / regexScriptCount / hasSystemPrompt ...）
		"metadataSummary": mergeMetadataSummary(summarizeCharacterMetadata(metadata), map[string]any{
			"name":        data["name"],
			"description": data["description"],
			"scenario":    data["scenario"],
			"firstMes":    data["first_mes"],
			"tags":        data["tags"],
			"creator":     data["creator"],
		}),
	})
}

// variableScanSummary 扫描角色卡/预设/世界书的变量玩法（对齐 Node scanVariableUsage 的输入源）。
func (s *Server) variableScanSummary(name string, metadata map[string]any) map[string]any {
	sources := []map[string]string{}
	if card, err := characters.Read(s.dataDir, name); err == nil {
		for _, field := range []string{"description", "personality", "scenario", "first_mes", "mes_example", "system_prompt", "post_history_instructions"} {
			if content := textOf(card[field]); content != "" {
				sources = append(sources, map[string]string{"name": "character." + field, "content": content})
			}
		}
	}
	if preferred, ok := metadata["preferredPreset"].(map[string]any); ok {
		for _, field := range []string{"systemPrompt", "postHistoryInstructions", "assistantPrefill"} {
			if content := textOf(preferred[field]); content != "" {
				sources = append(sources, map[string]string{"name": "preset." + field, "content": content})
			}
		}
	}
	if book, ok := metadata["worldBook"].(map[string]any); ok {
		if entries, ok := book["entries"].([]any); ok {
			for index, item := range entries {
				entry, _ := item.(map[string]any)
				if entry == nil {
					continue
				}
				if content := textOf(entry["content"]); content != "" {
					sources = append(sources, map[string]string{"name": fmt.Sprintf("worldbook.%d", index), "content": content})
				}
			}
		}
	}
	return chat.ScanVariableUsage(sources)
}

// safeName 拒绝路径穿越并去掉扩展名。
func safeName(raw string) (string, error) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", err
	}
	cleaned := strings.TrimSpace(decoded)
	if cleaned == "" {
		return "", fmt.Errorf("名称不能为空")
	}
	if strings.Contains(cleaned, "..") || strings.ContainsAny(cleaned, "/\\") {
		return "", fmt.Errorf("非法名称")
	}
	return strings.TrimSuffix(cleaned, filepath.Ext(cleaned)), nil
}

// ---------- 世界书 ----------

func (s *Server) handleWorldbooks(writer http.ResponseWriter, request *http.Request) {
	entries, err := os.ReadDir(filepath.Join(s.dataDir, "worlds"))
	if err != nil {
		writeJSON(writer, http.StatusOK, []string{})
		return
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(strings.ToLower(name), ".json") || strings.HasSuffix(strings.ToLower(name), ".json.bak") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	writeJSON(writer, http.StatusOK, names)
}

func (s *Server) handleWorldbookCurrent(writer http.ResponseWriter, request *http.Request) {
	// worldbooks/:filename 子操作分发（content/save/download/DELETE）
	if request.URL.Path != "/api/worldbooks/current" && strings.HasPrefix(request.URL.Path, "/api/worldbooks/") {
		s.handleWorldbookManage(writer, request)
		return
	}
	name := s.document.String("bindings.global.worldbook")
	if name == "" {
		name = s.document.String("chat.defaultWorldbook")
	}
	if name == "" {
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": "未加载世界书"})
		return
	}
	candidates := []string{name}
	if !strings.HasSuffix(strings.ToLower(name), ".json") {
		candidates = append(candidates, name+".json")
	}
	for _, candidate := range candidates {
		safe, err := safeName(candidate)
		if err != nil {
			continue
		}
		path := filepath.Join(s.dataDir, "worlds", safe+".json")
		raw, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": "世界书解析失败: " + err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, payload)
		return
	}
	writeJSON(writer, http.StatusNotFound, map[string]any{"error": "世界书不存在: " + name})
}

// ---------- 会话 ----------

func (s *Server) handleSessions(writer http.ResponseWriter, request *http.Request) {
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	defer database.Close()
	sessions, err := database.ListSessions(500)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	payload := make([]map[string]any, 0, len(sessions))
	for _, session := range sessions {
		payload = append(payload, map[string]any{
			"id":           session.ID,
			"messageCount": session.MessageCount,
			"summaryCount": session.SummaryCount,
			"createdAt":    session.CreatedAt,
			"lastActive":   session.LastActive,
			"label":        session.ID,
		})
	}
	writeJSON(writer, http.StatusOK, payload)
}

func (s *Server) handleSessionDetail(writer http.ResponseWriter, request *http.Request) {
	rest := strings.TrimPrefix(request.URL.Path, "/api/sessions/")
	rest = strings.Trim(rest, "/")
	historyRequested := strings.HasSuffix(rest, "/history")
	id := strings.TrimSuffix(rest, "/history")
	if id == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "缺少会话 ID"})
		return
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	defer database.Close()

	limit := 50
	if raw := request.URL.Query().Get("limit"); raw != "" {
		if parsed, err := parsePositiveInt(raw); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if historyRequested && request.Method == http.MethodGet {
		messages, err := database.RecentMessagesThread(id, limit)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": err.Error()})
			return
		}
		payload := make([]map[string]any, 0, len(messages))
		for _, message := range messages {
			metadata := map[string]any{}
			if message.MetadataJSON != "" {
				_ = json.Unmarshal([]byte(message.MetadataJSON), &metadata)
			}
			payload = append(payload, map[string]any{
				"id":        message.ID,
				"role":      message.Role,
				"content":   message.Content,
				"metadata":  metadata,
				"timestamp": message.Timestamp,
				"dateIso":   message.DateISO,
			})
		}
		writeJSON(writer, http.StatusOK, payload)
		return
	}

	switch request.Method {
	case http.MethodDelete:
		if historyRequested {
			if err := database.ClearHistory(id); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "会话历史已清除"})
			return
		}
		if err := database.DeleteSession(id); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "会话已删除"})
		return
	}

	sessions, err := database.ListSessions(500)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	for _, session := range sessions {
		if session.ID == id {
			writeJSON(writer, http.StatusOK, map[string]any{
				"id":           session.ID,
				"messageCount": session.MessageCount,
				"summaryCount": session.SummaryCount,
				"createdAt":    session.CreatedAt,
				"lastActive":   session.LastActive,
			})
			return
		}
	}
	writeJSON(writer, http.StatusNotFound, map[string]any{"error": "会话不存在"})
}

// ---------- 正则 ----------

// regexLayerPath 返回 targetLayer 对应的配置路径（对齐 Node getRegexTargetRules：
// preset → preset.regexRules；character → bindings.characters.<name>.regexRules；
// 其余（global）→ bindings.global.regexRules）。
func (s *Server) regexLayerPath(layer string) (string, bool) {
	switch layer {
	case "preset":
		return "preset.regexRules", true
	case "character", "characters":
		name := s.currentCharacterName()
		if name == "" {
			return "", false
		}
		return "bindings.characters." + name + ".regexRules", true
	default:
		return "bindings.global.regexRules", true
	}
}

// regexLayerRules 读取指定层的规则数组。
func (s *Server) regexLayerRules(layer string) ([]any, bool) {
	path, ok := s.regexLayerPath(layer)
	if !ok {
		return nil, false
	}
	rules := []any{}
	if raw := s.document.Get(path); raw.Exists() && strings.TrimSpace(raw.Raw) != "" {
		_ = json.Unmarshal([]byte(raw.Raw), &rules)
	}
	if rules == nil {
		rules = []any{}
	}
	return rules, true
}

// handleRegex 处理 GET/POST /api/regex。
func (s *Server) handleRegex(writer http.ResponseWriter, request *http.Request) {
	if request.URL.Query().Get("summary") == "1" {
		writeJSON(writer, http.StatusOK, s.regexImportSummaries())
		return
	}
	layer := orDefault(request.URL.Query().Get("targetLayer"), "global")
	rules, ok := s.regexLayerRules(layer)
	if !ok {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "当前没有选中角色，无法读取角色层规则"})
		return
	}
	if request.Method == http.MethodPost {
		body := decodeBody(request)
		delete(body, "targetLayer")
		path, _ := s.regexLayerPath(layer)
		rules = append(rules, body)
		if err := s.document.Set(path, rules); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "规则已添加"})
		return
	}
	writeJSON(writer, http.StatusOK, rules)
}

// regexImportSummaries 返回正则导入记录摘要（对齐 Node summarizeRegexImportRecord）。
func (s *Server) regexImportSummaries() []map[string]any {
	records := []map[string]any{}
	for _, record := range s.regexImportRecords() {
		imported := []any{}
		if list, ok := record["importedRules"].([]any); ok {
			imported = list
		}
		records = append(records, map[string]any{
			"id": record["id"], "type": orDefault(textOf(record["type"]), "regex"),
			"filename": record["filename"], "targetLayer": orDefault(textOf(record["targetLayer"]), "global"),
			"createdAt": record["createdAt"], "importedCount": len(imported),
			"sourceType": record["sourceType"],
		})
	}
	return records
}

// regexImportRecords 读取原始导入记录（含导入的规则快照）。
func (s *Server) regexImportRecords() []map[string]any {
	raw := s.document.Get("imports.regexFiles")
	if !raw.Exists() || !raw.IsArray() {
		return nil
	}
	records := []map[string]any{}
	for _, item := range raw.Array() {
		record := map[string]any{}
		if err := json.Unmarshal([]byte(item.Raw), &record); err != nil {
			continue
		}
		records = append(records, record)
	}
	return records
}

// ---------- 日志 ----------

func (s *Server) handleLogFiles(writer http.ResponseWriter, request *http.Request) {
	entries, err := os.ReadDir(s.logDir())
	if err != nil {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	files := []map[string]any{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".log") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, map[string]any{
			"name":  entry.Name(),
			"size":  info.Size(),
			"mtime": info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(files, func(left, right int) bool {
		return files[left]["mtime"].(int64) > files[right]["mtime"].(int64)
	})
	writeJSON(writer, http.StatusOK, files)
}

var logFilePattern = regexp.MustCompile(`^[\w\-\.]+\.log$`)

func (s *Server) handleLogContent(writer http.ResponseWriter, request *http.Request) {
	name := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/logs/content/"), "/")
	// 对齐 Node：文件名必须是 xxx.log；返回 text/plain 原文（前端用 res.text() 直接展示）。
	if !logFilePattern.MatchString(name) {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": "无效的文件名"})
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.logDir(), name))
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": "文件不存在"})
		return
	}
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = writer.Write(raw)
}

// handleRecentLogs 对齐 Node GET /api/logs：返回最近日志（取最新日志文件尾部）。
func (s *Server) handleRecentLogs(writer http.ResponseWriter, request *http.Request) {
	entries, err := os.ReadDir(s.logDir())
	if err != nil {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	latest := ""
	var latestTime time.Time
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(strings.ToLower(entry.Name()), ".log") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		if latest == "" || info.ModTime().After(latestTime) {
			latest = entry.Name()
			latestTime = info.ModTime()
		}
	}
	if latest == "" {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.logDir(), latest))
	if err != nil {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	lines := strings.Split(string(raw), "\n")
	if len(lines) > 100 {
		lines = lines[len(lines)-100:]
	}
	writeJSON(writer, http.StatusOK, lines)
}

func (s *Server) logDir() string {
	if configured := s.document.String("server.logDir"); configured != "" {
		if filepath.IsAbs(configured) {
			return configured
		}
		return filepath.Join(s.rootDir, configured)
	}
	return filepath.Join(s.rootDir, "logs")
}

// ---------- AI 连通性测试 ----------

func (s *Server) handleTestAI(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "仅支持 POST"})
		return
	}
	provider, err := ai.ResolveProvider(s.document)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	prompt := "你好，请只回复：收到"
	if request.Body != nil {
		var payload struct {
			Prompt string `json:"prompt"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err == nil && strings.TrimSpace(payload.Prompt) != "" {
			prompt = payload.Prompt
		}
	}
	client := ai.New(provider)
	startedAt := time.Now()
	messages := []ai.Message{{Role: "user", Content: prompt}}
	result, err := client.Chat(request.Context(), messages, nil)
	elapsed := time.Since(startedAt).Milliseconds()
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{
			"success":   false,
			"error":     err.Error(),
			"provider":  provider.ID,
			"model":     provider.Model,
			"elapsedMs": elapsed,
		})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":   true,
		"reply":     result.Content,
		"provider":  provider.ID,
		"model":     provider.Model,
		"elapsedMs": elapsed,
	})
}

// openActiveMemory 打开当前生效的记忆库（与 Node getActiveMemoryInfo 的解析顺序一致）。
func (s *Server) openActiveMemory() (*store.DB, string, error) {
	path := s.document.String("bindings.global.memoryDbPath")
	if path == "" {
		path = s.document.String("memory.storage.path")
	}
	if path == "" {
		path = filepath.Join(s.dataDir, "chats", "memory-store.sqlite")
	} else if !filepath.IsAbs(path) {
		path = filepath.Join(s.rootDir, path)
	}
	if _, err := os.Stat(path); err != nil {
		return nil, path, err
	}
	database, err := store.Open(path)
	if err != nil {
		return nil, path, err
	}
	return database, path, nil
}

func parsePositiveInt(raw string) (int, error) {
	value := 0
	_, err := fmt.Sscanf(strings.TrimSpace(raw), "%d", &value)
	return value, err
}
