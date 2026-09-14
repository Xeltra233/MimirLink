package panel

// 面板管理路由补齐（对齐 Node src/routes.js）：characters/worldbooks 管理、
// regex 写操作、preset import/train、memory global/export/clear-all、
// status onebot/llm、data/clear、logs 下载。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mimirlink/internal/characters"
)

// registerManagedRoutes 注册管理路由（/api/characters/ 与 /api/worldbooks/ 前缀
// 复用 routes_ext.go 的注册点，子操作在 handler 内分发）。
func (s *Server) registerManagedRoutes() {
	s.mux.HandleFunc("/api/characters/select", s.requireAuth(s.handleCharacterSelect))
	s.mux.HandleFunc("/api/characters/upload", s.requireAuth(s.handleCharacterUpload))
	s.mux.HandleFunc("/api/characters/batch-download", s.requireAuth(s.handleCharacterBatchDownload))
	s.mux.HandleFunc("/api/worldbooks/select", s.requireAuth(s.handleWorldbookSelect))
	s.mux.HandleFunc("/api/worldbooks/upload", s.requireAuth(s.handleWorldbookUpload))
	s.mux.HandleFunc("/api/worldbooks/batch-delete", s.requireAuth(s.handleWorldbookBatchDelete))
	s.mux.HandleFunc("/api/worldbooks/test", s.requireAuth(s.handleWorldbookTest))
	s.mux.HandleFunc("/api/worldbooks/extract-from-character", s.requireAuth(s.handleWorldbookExtract))
	s.mux.HandleFunc("/api/worldbooks/", s.requireAuth(s.handleWorldbookManage))
	s.mux.HandleFunc("/api/regex/test", s.requireAuth(s.handleRegexTest))
	s.mux.HandleFunc("/api/regex/import", s.requireAuth(s.handleRegexImport))
	s.mux.HandleFunc("/api/regex/export", s.requireAuth(s.handleRegexExport))
	s.mux.HandleFunc("/api/regex/imports/", s.requireAuth(s.handleRegexImportDelete))
	s.mux.HandleFunc("/api/regex-write", s.requireAuth(s.handleRegexWrite))
	s.mux.HandleFunc("/api/preset/import", s.requireAuth(s.handlePresetImport))
	s.mux.HandleFunc("/api/preset/train", s.requireAuth(s.handlePresetTrain))
	s.mux.HandleFunc("/api/preset/tune", s.requireAuth(s.handlePresetTrain))
	s.mux.HandleFunc("/api/memory/global", s.requireAuth(s.handleMemoryGlobal))
	s.mux.HandleFunc("/api/memory/export", s.requireAuth(s.handleMemoryExport))
	s.mux.HandleFunc("/api/memory/clear-all", s.requireAuth(s.handleMemoryClearAll))
	s.mux.HandleFunc("/api/status/onebot/reconnect", s.requireAuth(s.handleOnebotReconnect))
	s.mux.HandleFunc("/api/status/llm", s.requireAuth(s.handleLLMStatus))
	s.mux.HandleFunc("/api/status/llm/toggle", s.requireAuth(s.handleLLMToggle))
	s.mux.HandleFunc("/api/data/clear", s.requireAuth(s.handleDataClear))
	s.mux.HandleFunc("/api/logs/download/", s.requireAuth(s.handleLogDownload))
	s.mux.HandleFunc("/api/participant-profiles-analyze", s.requireAuth(s.handleProfileAnalyze))
	s.mux.HandleFunc("/api/test/mention", s.requireAuth(s.handleTestMention))
	s.mux.HandleFunc("/api/tools/web-search/test", s.requireAuth(s.handleWebSearchTest))
	s.mux.HandleFunc("/api/runtime/prompt-preview", s.requireAuth(s.handlePromptPreview))
}

func decodeBody(request *http.Request) map[string]any {
	var body map[string]any
	_ = json.NewDecoder(request.Body).Decode(&body)
	return body
}

func textArg(args map[string]any, key string) string {
	if value, ok := args[key].(string); ok {
		return strings.TrimSpace(value)
	}
	return textOf(nil)
}

func fmt_Sprint(value any) string {
	return strings.TrimSpace(strings.Trim(strings.Trim(fmt.Sprintf("%v", value), "["), "]"))
}

func safeBase(name string) string {
	name = strings.TrimSpace(name)
	name = strings.TrimSuffix(name, ".json")
	name = strings.TrimSuffix(name, ".png")
	return strings.ReplaceAll(strings.ReplaceAll(name, "/", ""), "\\", "")
}

func safeLogName(name string) (string, error) {
	cleaned := filepath.Clean(strings.TrimPrefix(strings.TrimSpace(name), "/"))
	if strings.HasPrefix(cleaned, "..") || strings.ContainsAny(cleaned, "/\\") {
		return "", fmt.Errorf("非法文件名")
	}
	return cleaned, nil
}

// ---------------- characters ----------------

// handleCharacterSelect 切换当前角色。
func (s *Server) handleCharacterSelect(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := strings.TrimSuffix(orDefault(textOf(body["filename"]), textOf(body["characterName"])), ".png")
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少角色名"})
		return
	}
	if _, err := characters.Read(s.dataDir, name); err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Set("bindings.global.character", name); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "character": name, "message": "角色已切换"})
}

// handleCharacterUpload 上传角色卡 JSON。
func (s *Server) handleCharacterUpload(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := strings.TrimSuffix(orDefault(textOf(body["filename"]), textOf(body["name"])), ".png")
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少角色名"})
		return
	}
	card, _ := body["card"].(map[string]any)
	if card == nil {
		card = body
		delete(card, "filename")
	}
	card["name"] = name
	if err := s.writeCharacterCardByName(name, card); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "filename": name + ".json"})
}

// handleCharacterBatchDownload 批量导出角色卡。
func (s *Server) handleCharacterBatchDownload(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	result := []map[string]any{}
	if items, ok := body["filenames"].([]any); ok {
		for _, item := range items {
			name := safeBase(textOf(item))
			if card, err := characters.Read(s.dataDir, name); err == nil {
				result = append(result, card)
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"characters": result})
}

// handleCharacterManage /api/characters/:filename 的子操作分发
// （update/variable-defaults/download/memory-binding/worldbook-binding/DELETE）。
func (s *Server) handleCharacterManage(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/characters/"), "/")
	if rest == "" || rest == "select" || rest == "upload" || rest == "batch-download" {
		return // 固定路径由各自 handler 处理（不应到这里）
	}
	switch {
	case strings.HasSuffix(rest, "/update"):
		name := safeBase(strings.TrimSuffix(rest, "/update"))
		body := decodeBody(request)
		card, err := characters.Read(s.dataDir, name)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
			return
		}
		for key, value := range body {
			card[key] = value
		}
		if err := s.writeCharacterCardByName(name, card); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "角色已更新"})
	case strings.HasSuffix(rest, "/variable-defaults"):
		name := safeBase(strings.TrimSuffix(rest, "/variable-defaults"))
		card, err := characters.Read(s.dataDir, name)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
			return
		}
		switch request.Method {
		case http.MethodGet:
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "defaults": card["variable_defaults"]})
		case http.MethodPut:
			body := decodeBody(request)
			card["variable_defaults"] = body["variable_defaults"]
			if err := s.writeCharacterCardByName(name, card); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true})
		}
	case strings.HasSuffix(rest, "/download"):
		name := safeBase(strings.TrimSuffix(rest, "/download"))
		card, err := characters.Read(s.dataDir, name)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, card)
	case strings.HasSuffix(rest, "/memory-binding"):
		s.handleMemoryBinding(writer, request, safeBase(strings.TrimSuffix(rest, "/memory-binding")), "memory")
	case strings.HasSuffix(rest, "/worldbook-binding"):
		s.handleMemoryBinding(writer, request, safeBase(strings.TrimSuffix(rest, "/worldbook-binding")), "worldbook")
	default:
		if request.Method == http.MethodDelete {
			name := safeBase(rest)
			if err := os.Remove(filepath.Join(s.dataDir, "characters", name+".json")); err != nil {
				writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "角色不存在"})
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "角色已删除"})
			return
		}
		s.handleCharacterDetail(writer, request)
	}
}

// handleMemoryBinding 角色记忆/世界书绑定（写入 character_overrides）。
func (s *Server) handleMemoryBinding(writer http.ResponseWriter, request *http.Request, name string, kind string) {
	body := decodeBody(request)
	overrideDir := filepath.Join(s.dataDir, "character_overrides")
	_ = os.MkdirAll(overrideDir, 0o755)
	overridePath := filepath.Join(overrideDir, safeBase(name)+".json")
	overrides := map[string]any{}
	if raw, err := os.ReadFile(overridePath); err == nil {
		_ = json.Unmarshal(raw, &overrides)
	}
	key := "memoryDbPath"
	if kind == "worldbook" {
		key = "worldBook"
	}
	mode := textOf(body["mode"])
	if mode == "inherit" || mode == "" {
		delete(overrides, key)
	} else if dbPath := textOf(body["dbPath"]); dbPath != "" {
		overrides[key] = dbPath
	} else if worldbook := textOf(body["worldbook"]); worldbook != "" {
		overrides[key] = worldbook
	}
	encoded, _ := json.MarshalIndent(overrides, "", "  ")
	if err := os.WriteFile(overridePath, encoded, 0o644); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

// writeCharacterCardByName 写回角色卡 JSON。
func (s *Server) writeCharacterCardByName(name string, card map[string]any) error {
	safe := safeBase(name)
	encoded, err := json.MarshalIndent(card, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dataDir, "characters", safe+".json"), encoded, 0o644)
}

// ---------------- worldbooks ----------------

func (s *Server) handleWorldbookSelect(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := strings.TrimSuffix(strings.TrimSpace(textOf(body["filename"])), ".json")
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少世界书名"})
		return
	}
	if err := s.document.Set("bindings.global.worldbook", name+".json"); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "worldbook": name})
}

func (s *Server) handleWorldbookUpload(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := strings.TrimSuffix(strings.TrimSpace(textOf(body["filename"])), ".json")
	worldbook, _ := body["worldbook"].(map[string]any)
	if worldbook == nil {
		worldbook = body
		delete(worldbook, "filename")
	}
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少世界书名"})
		return
	}
	encoded, _ := json.MarshalIndent(worldbook, "", "  ")
	if err := os.WriteFile(filepath.Join(s.dataDir, "worlds", name+".json"), encoded, 0o644); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "filename": name + ".json"})
}

func (s *Server) handleWorldbookBatchDelete(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	deleted := 0
	if items, ok := body["filenames"].([]any); ok {
		for _, item := range items {
			if err := os.Remove(filepath.Join(s.dataDir, "worlds", safeBase(textOf(item))+".json")); err == nil {
				deleted++
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "deleted": deleted})
}

func (s *Server) handleWorldbookTest(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := safeBase(textOf(body["characterName"]))
	input := textOf(body["input"])
	book := map[string]any{}
	raw, err := os.ReadFile(filepath.Join(s.dataDir, "worlds", name+".json"))
	if err == nil {
		_ = json.Unmarshal(raw, &book)
	}
	entries, _ := book["entries"].([]any)
	matched := []any{}
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		if entry["constant"] == true {
			matched = append(matched, entry)
			continue
		}
		for _, key := range entryKeys(entry) {
			if key != "" && strings.Contains(input, key) {
				matched = append(matched, entry)
				break
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "matched": matched, "count": len(matched)})
}

func (s *Server) handleWorldbookExtract(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := safeBase(textOf(body["characterName"]))
	card, err := characters.Read(s.dataDir, name)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
		return
	}
	entries := []any{}
	if lorebook, ok := card["character_book"].(map[string]any); ok {
		if items, ok := lorebook["entries"].([]any); ok {
			entries = items
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "entries": entries, "count": len(entries)})
}

// handleWorldbookManage /api/worldbooks/:filename 的子操作分发。
func (s *Server) handleWorldbookManage(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/worldbooks/"), "/")
	switch {
	case strings.HasSuffix(rest, "/content"):
		name := safeBase(strings.TrimSuffix(rest, "/content"))
		raw, err := os.ReadFile(filepath.Join(s.dataDir, "worlds", name+".json"))
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "世界书不存在"})
			return
		}
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = writer.Write(raw)
	case strings.HasSuffix(rest, "/save"):
		name := safeBase(strings.TrimSuffix(rest, "/save"))
		body := decodeBody(request)
		encoded, _ := json.MarshalIndent(body, "", "  ")
		if err := os.WriteFile(filepath.Join(s.dataDir, "worlds", name+".json"), encoded, 0o644); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "世界书已保存"})
	case strings.HasSuffix(rest, "/download"):
		name := safeBase(strings.TrimSuffix(rest, "/download"))
		raw, err := os.ReadFile(filepath.Join(s.dataDir, "worlds", name+".json"))
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "世界书不存在"})
			return
		}
		writer.Header().Set("Content-Disposition", "attachment; filename="+name+".json")
		writer.Header().Set("Content-Type", "application/json; charset=utf-8")
		_, _ = writer.Write(raw)
	default:
		if request.Method == http.MethodDelete {
			name := safeBase(rest)
			if err := os.Remove(filepath.Join(s.dataDir, "worlds", name+".json")); err != nil {
				writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "世界书不存在"})
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "世界书已删除"})
			return
		}
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "未知子路径"})
	}
}

// ---------------- regex 写操作 ----------------

// regexConfigKey targetLayer → 配置键。
func regexConfigKey(layer string) string {
	switch layer {
	case "character", "characters":
		return "regex.character"
	case "preset":
		return "regex.preset"
	default:
		return "regex.global"
	}
}

// handleRegexWrite regex 条目整体写入（POST 新增 / PUT 更新 / DELETE 删除经 rules 替换）。
func (s *Server) handleRegexWrite(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	layer := orDefault(request.URL.Query().Get("targetLayer"), "global")
	if err := s.document.Set(regexConfigKey(layer), body["rules"]); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

// handleRegexTest 正则规则测试。
func (s *Server) handleRegexTest(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	input := textOf(body["input"])
	output := input
	if items, ok := body["rules"].([]any); ok {
		for _, item := range items {
			rule, _ := item.(map[string]any)
			if rule == nil {
				continue
			}
			pattern := orDefault(textOf(rule["findRegex"]), textOf(rule["pattern"]))
			replace := orDefault(textOf(rule["replaceString"]), textOf(rule["replacement"]))
			if pattern == "" {
				continue
			}
			re, err := compileJSRegex(pattern)
			if err != nil {
				continue
			}
			output = re.ReplaceAllString(output, replace)
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "output": output})
}

// handleRegexImport 正则规则导入。
func (s *Server) handleRegexImport(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	layer := orDefault(textOf(body["targetLayer"]), "global")
	imported, _ := body["rules"].([]any)
	if err := s.document.Set(regexConfigKey(layer), imported); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "count": len(imported)})
}

// handleRegexExport 正则规则导出。
func (s *Server) handleRegexExport(writer http.ResponseWriter, request *http.Request) {
	layer := orDefault(request.URL.Query().Get("targetLayer"), "global")
	raw := s.document.Get(regexConfigKey(layer))
	payload := []any{}
	if raw.Exists() {
		_ = json.Unmarshal([]byte(raw.Raw), &payload)
	}
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	encoded, _ := json.MarshalIndent(payload, "", "  ")
	_, _ = writer.Write(encoded)
}

// handleRegexImportDelete 删除导入记录（精简实现：导入直接写配置，无独立记录表）。
func (s *Server) handleRegexImportDelete(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "Go 版导入直接写配置，无独立导入记录"})
}

// compileJSRegex 剥 JS 正则 /.../flags 定界符后编译。
func compileJSRegex(pattern string) (*regexp.Regexp, error) {
	trimmed := strings.TrimSpace(pattern)
	if strings.HasPrefix(trimmed, "/") && strings.LastIndex(trimmed, "/") > 0 {
		lastSlash := strings.LastIndex(trimmed, "/")
		body := trimmed[1:lastSlash]
		flags := trimmed[lastSlash+1:]
		prefix := ""
		if strings.Contains(flags, "i") {
			prefix += "(?i)"
		}
		if strings.Contains(flags, "s") {
			prefix += "(?s)"
		}
		return regexp.Compile(prefix + body)
	}
	return regexp.Compile(pattern)
}

// ---------------- preset import/train ----------------

func (s *Server) handlePresetImport(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	name := safeBase(textOf(body["name"]))
	if name == "" {
		name = fmt_Sprint(time.Now().UnixMilli())
	}
	preset, _ := body["preset"].(map[string]any)
	if preset == nil {
		preset = body
		delete(preset, "name")
	}
	encoded, _ := json.MarshalIndent(preset, "", "  ")
	if err := os.WriteFile(filepath.Join(s.dataDir, "presets", "preset-"+name+".json"), encoded, 0o644); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "filename": "preset-" + name + ".json"})
}

func (s *Server) handlePresetTrain(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "训练任务已接受（Go 版精简实现：AI 迭代训练见 MCP range_test/analyze 工具）"})
}

// ---------------- memory global/export/clear-all ----------------

func (s *Server) handleMemoryGlobal(writer http.ResponseWriter, request *http.Request) {
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	messages, err := database.RecentMessagesThread("global_shared_memory", 100)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"messages": messages, "stats": map[string]any{"total": len(messages)}})
}

func (s *Server) handleMemoryExport(writer http.ResponseWriter, request *http.Request) {
	database, path, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	sessions, _ := database.ListSessions(500)
	writer.Header().Set("Content-Disposition", "attachment; filename=memory-export-"+fmt_Sprint(time.Now().UnixMilli())+".json")
	writeJSON(writer, http.StatusOK, map[string]any{"sessions": sessions, "exportedAt": time.Now().UnixMilli(), "dbPath": path})
}

func (s *Server) handleMemoryClearAll(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	if textOf(body["confirm"]) != "CLEAR_ALL_MEMORY" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "确认信息不正确"})
		return
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	for _, sql := range []string{`DELETE FROM messages`, `DELETE FROM summaries`, `UPDATE sessions SET message_count = 0, summary_count = 0`} {
		if _, err := database.Exec(sql); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "全局记忆已清空"})
}

// ---------------- status / data / logs / 其它 ----------------

func (s *Server) handleOnebotReconnect(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "重连指令已接受（bot 进程内自动重连，面板进程无 OneBot 连接）"})
}

func (s *Server) handleLLMStatus(writer http.ResponseWriter, request *http.Request) {
	enabled := !(s.document.Bool("runtime.llmEnabled") == false && s.document.Exists("runtime.llmEnabled"))
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "enabled": enabled})
}

func (s *Server) handleLLMToggle(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	enabled := body["enabled"] == true
	if err := s.document.Set("runtime.llmEnabled", enabled); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "enabled": enabled})
}

func (s *Server) handleDataClear(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	cleared := []string{}
	if items, ok := body["targets"].([]any); ok {
		for _, item := range items {
			var dir string
			switch textOf(item) {
			case "audio":
				dir = filepath.Join(s.dataDir, "audio")
			case "logs":
				dir = s.logDir()
			default:
				continue
			}
			if entries, err := os.ReadDir(dir); err == nil {
				for _, entry := range entries {
					_ = os.RemoveAll(filepath.Join(dir, entry.Name()))
				}
				cleared = append(cleared, textOf(item))
			}
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "cleared": cleared})
}

func (s *Server) handleLogDownload(writer http.ResponseWriter, request *http.Request) {
	safe, err := safeLogName(strings.TrimPrefix(request.URL.Path, "/api/logs/download/"))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	raw, err := os.ReadFile(filepath.Join(s.logDir(), safe))
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "日志文件不存在"})
		return
	}
	writer.Header().Set("Content-Disposition", "attachment; filename="+safe)
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = writer.Write(raw)
}

func (s *Server) handleProfileAnalyze(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"message": "手动分析由 bot 进程的 chat.commands.participantProfileManual 命令触发；面板进程无 bot 上下文",
	})
}

func (s *Server) handleTestMention(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "主动 @ 测试请在 bot 进程内使用 chat.commands.adminMention 命令触发"})
}

func (s *Server) handleWebSearchTest(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	query := textOf(body["query"])
	if query == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "query 不能为空"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "搜索测试请在 bot 进程触发（联网搜索按需构建），query=" + query})
}

func (s *Server) handlePromptPreview(writer http.ResponseWriter, request *http.Request) {
	_ = decodeBody(request)
	presetPath, err := s.resolveRangePresetPath("")
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "segments": []any{}, "message": "无预设"})
		return
	}
	preset, err := readJSONFile(presetPath)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	segments := []map[string]any{}
	if prompts, ok := preset["prompts"].([]any); ok {
		for _, item := range prompts {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			content := strings.TrimSpace(fmt.Sprintf("%v", entry["content"]))
			segments = append(segments, map[string]any{
				"identifier": entry["identifier"],
				"enabled":    entry["enabled"] != false,
				"length":     len([]rune(content)),
				"role":       entry["role"],
			})
		}
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "preset": filepath.Base(presetPath), "segments": segments})
}
