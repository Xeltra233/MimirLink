package panel

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/config"
	"mimirlink/internal/store"
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
	s.mux.HandleFunc("/api/regex", s.requireAuth(s.handleRegex))
	s.mux.HandleFunc("/api/logs/files", s.requireAuth(s.handleLogFiles))
	s.mux.HandleFunc("/api/logs/content/", s.requireAuth(s.handleLogContent))
	s.mux.HandleFunc("/api/test/ai", s.requireAuth(s.handleTestAI))
	s.mux.HandleFunc("/api/ai/probe", s.requireAuth(s.handleTestAI))
}

// ---------- /api/status ----------

func (s *Server) handleStatus(writer http.ResponseWriter, request *http.Request) {
	counts := store.Counts{}
	activePath := ""
	if database, path, err := s.openActiveMemory(); err == nil {
		activePath = path
		if c, err := database.Counts(); err == nil {
			counts = c
		}
		_ = database.Close()
	}
	character := s.currentCharacterName()
	worldbook := s.currentWorldbookName()
	sessionMode := fallback(s.document.String("chat.sessionMode"), "user_persistent")

	writeJSON(writer, http.StatusOK, map[string]any{
		"version":    Version,
		"uptime":     time.Since(s.startedAt).Seconds(),
		"llmEnabled": true,
		"runtime": map[string]any{
			"maxConcurrentSessions": s.document.Int("chat.maxConcurrentSessions", 4),
			"bufferWindowMs":        s.document.Int("chat.bufferWindowMs", 1200),
			"engine":                "go",
		},
		"onebot": map[string]any{
			"connected": false,
			"url":       s.document.String("onebot.url"),
			"mode":      s.document.String("onebot.mode"),
			"note":      "Go 面板不承载 OneBot 连接，请使用 -bot 进程",
		},
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
			"sessions":      counts.Sessions,
			"messages":      counts.Messages,
			"totalMessages": counts.Messages,
			"summaries":     counts.Summaries,
			"storage": map[string]any{
				"type": "sqlite",
				"path": activePath,
			},
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
			"host": s.document.String("server.host"),
			"port": s.document.Int("server.port", 8001),
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

func (s *Server) handleCharacterDetail(writer http.ResponseWriter, request *http.Request) {
	// 子操作分发（update/variable-defaults/download/memory-binding/worldbook-binding/delete）
	if request.URL.Path != "/api/characters/" && strings.Count(strings.TrimPrefix(request.URL.Path, "/api/characters/"), "/") > 0 ||
		request.Method == http.MethodDelete {
		s.handleCharacterManage(writer, request)
		return
	}
	rest := strings.TrimPrefix(request.URL.Path, "/api/characters/")
	rest = strings.TrimSuffix(rest, "/detail")
	name, err := safeName(rest)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	data, err := characters.Read(s.dataDir, name)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":   true,
		"character": data,
		"metadataSummary": map[string]any{
			"name":        data["name"],
			"description": data["description"],
			"scenario":    data["scenario"],
			"firstMes":    data["first_mes"],
			"tags":        data["tags"],
			"creator":     data["creator"],
		},
	})
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

func (s *Server) handleRegex(writer http.ResponseWriter, request *http.Request) {
	target := request.URL.Query().Get("targetLayer")
	if target == "" {
		target = "global"
	}
	path := "regex.global"
	switch target {
	case "character", "characters":
		path = "regex.character"
	case "preset":
		path = "regex.preset"
	}
	result := s.document.Get(path)
	if !result.Exists() {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	raw := result.Raw
	if strings.TrimSpace(raw) == "" {
		writeJSON(writer, http.StatusOK, []any{})
		return
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_, _ = writer.Write([]byte(raw))
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
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, map[string]any{
			"name":     entry.Name(),
			"size":     info.Size(),
			"modified": info.ModTime().UnixMilli(),
		})
	}
	sort.Slice(files, func(left, right int) bool {
		return files[left]["modified"].(int64) > files[right]["modified"].(int64)
	})
	writeJSON(writer, http.StatusOK, files)
}

func (s *Server) handleLogContent(writer http.ResponseWriter, request *http.Request) {
	name, err := safeName(strings.TrimPrefix(request.URL.Path, "/api/logs/content/"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	path := filepath.Join(s.logDir(), name)
	raw, err := os.ReadFile(path)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"error": "日志不存在"})
		return
	}
	const maxBytes = 512 * 1024
	truncated := false
	if len(raw) > maxBytes {
		raw = raw[len(raw)-maxBytes:]
		truncated = true
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"name":      name,
		"content":   string(raw),
		"truncated": truncated,
	})
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
