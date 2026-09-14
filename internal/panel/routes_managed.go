package panel

// 面板管理路由补齐（对齐 Node src/routes.js）：characters/worldbooks 管理、
// regex 写操作、preset import/train、memory global/export/clear-all、
// status onebot/llm、data/clear、logs 下载。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/chat"
	"mimirlink/internal/config"
	"mimirlink/internal/search"
	"mimirlink/internal/store"
	"mimirlink/internal/tools"
)

// registerManagedRoutes 注册管理路由（/api/characters/ 与 /api/worldbooks/ 前缀
// 复用 routes_ext.go 的注册点，子操作在 handler 内分发）。
func (s *Server) registerManagedRoutes() {
	s.mux.HandleFunc("/api/characters/select", s.requireAuth(s.handleCharacterSelect))
	s.mux.HandleFunc("/api/characters/refresh", s.requireAuth(s.handleCharacterRefresh))
	s.mux.HandleFunc("/api/characters/upload", s.requireAuth(s.handleCharacterUpload))
	s.mux.HandleFunc("/api/characters/batch-download", s.requireAuth(s.handleCharacterBatchDownload))
	s.mux.HandleFunc("/api/worldbooks/select", s.requireAuth(s.handleWorldbookSelect))
	s.mux.HandleFunc("/api/worldbooks/upload", s.requireAuth(s.handleWorldbookUpload))
	s.mux.HandleFunc("/api/worldbooks/refresh", s.requireAuth(s.handleWorldbookRefresh))
	s.mux.HandleFunc("/api/worldbooks/batch-delete", s.requireAuth(s.handleWorldbookBatchDelete))
	s.mux.HandleFunc("/api/worldbooks/batch-download", s.requireAuth(s.handleWorldbookBatchDownload))
	s.mux.HandleFunc("/api/worldbooks/test", s.requireAuth(s.handleWorldbookTest))
	s.mux.HandleFunc("/api/worldbooks/extract-from-character", s.requireAuth(s.handleWorldbookExtractFromCharacter))
	s.mux.HandleFunc("/api/worldbooks/", s.requireAuth(s.handleWorldbookManage))
	s.mux.HandleFunc("/api/regex", s.requireAuth(s.handleRegex))
	s.mux.HandleFunc("/api/regex/", s.requireAuth(s.handleRegexIndex))
	s.mux.HandleFunc("/api/regex/test", s.requireAuth(s.handleRegexTest))
	s.mux.HandleFunc("/api/regex/import", s.requireAuth(s.handleRegexImport))
	s.mux.HandleFunc("/api/regex/export", s.requireAuth(s.handleRegexExport))
	s.mux.HandleFunc("/api/regex/imports/", s.requireAuth(s.handleRegexImportDelete))
	s.mux.HandleFunc("/api/regex-write", s.requireAuth(s.handleRegexWrite))
	s.mux.HandleFunc("/api/preset/import", s.requireAuth(s.handlePresetImportFull))
	s.mux.HandleFunc("/api/preset/imports/", s.requireAuth(s.handlePresetImportDelete))
	s.mux.HandleFunc("/api/preset/train", s.requireAuth(s.handlePresetTrainFull))
	s.mux.HandleFunc("/api/preset/tune", s.requireAuth(s.handlePresetTune))
	s.mux.HandleFunc("/api/memory/global", s.requireAuth(s.handleMemoryGlobal))
	s.mux.HandleFunc("/api/memory/export", s.requireAuth(s.handleMemoryExport))
	s.mux.HandleFunc("/api/memory/clear-all", s.requireAuth(s.handleMemoryClearAll))
	s.mux.HandleFunc("/api/memory/knowledge/", s.requireAuth(s.handleMemoryKnowledgeDetail))
	s.mux.HandleFunc("/api/memory/knowledge/import", s.requireAuth(s.handleMemoryKnowledgeImport))
	s.mux.HandleFunc("/api/status/onebot/reconnect", s.requireAuth(s.handleOnebotReconnect))
	s.mux.HandleFunc("/api/status/llm", s.requireAuth(s.handleLLMStatus))
	s.mux.HandleFunc("/api/status/llm/toggle", s.requireAuth(s.handleLLMToggle))
	s.mux.HandleFunc("/api/data/clear", s.requireAuth(s.handleDataClear))
	s.mux.HandleFunc("/api/logs", s.requireAuth(s.handleRecentLogs))
	s.mux.HandleFunc("/api/logs/download/", s.requireAuth(s.handleLogDownload))
	s.mux.HandleFunc("/api/participant-profiles/", s.requireAuth(s.handleParticipantProfileDetail))
	s.mux.HandleFunc("/api/participant-profiles-analyze", s.requireAuth(s.handleProfileAnalyze))
	s.mux.HandleFunc("/api/favicon.ico", s.handleFavicon)
	s.mux.HandleFunc("/favicon.ico", s.handleFavicon)
	s.mux.HandleFunc("/api/test/mention", s.requireAuth(s.handleTestMention))
	s.mux.HandleFunc("/api/tools/web-search/test", s.requireAuth(s.handleWebSearchTest))
	s.mux.HandleFunc("/api/runtime/prompt-preview", s.requireAuth(s.handlePromptPreview))
}

// handleFavicon 对齐 Node：返回 204 空响应。
func (s *Server) handleFavicon(writer http.ResponseWriter, request *http.Request) {
	writer.WriteHeader(http.StatusNoContent)
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
	// 对齐 Node POST /api/characters/select 的返回：前端要读 metadataSummary/bindingSummary/
	// appliedActions/importPlan，用来渲染「酒馆导入信息」与绑定提示。
	metadata := s.characterMetadata(name)
	card, _ := characters.Read(s.dataDir, name)
	applied := []string{}
	if metadata["hasEmbeddedWorldBook"] == true {
		applied = append(applied, "检测到内嵌世界书")
	}
	if summarizeCharacterMetadata(metadata)["importableRegexScriptCount"].(int) > 0 {
		applied = append(applied, "检测到可导入正则")
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":          true,
		"character":        card,
		"importedMetadata": metadata,
		"metadataSummary":  summarizeCharacterMetadata(metadata),
		"appliedActions":   applied,
		"importPlan":       characterImportPlan(metadata),
		"importOptions":    map[string]any{"importWorldBook": nil, "importPreset": nil, "importRegex": nil},
		"bindingSummary":   s.bindingSummary(name),
		"variableInit":     map[string]any{"readCount": 0, "appliedCount": 0, "unsupportedCount": 0},
		"message":          "角色已切换",
	})
}

// handleCharacterRefresh 重新扫描角色目录并返回列表（对齐 Node POST /api/characters/refresh）。
func (s *Server) handleCharacterRefresh(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "characters": s.characterListPayload()})
}

// characterListPayload 返回 [{name, filename}]（对齐 Node GET /api/characters）。
func (s *Server) characterListPayload() []map[string]any {
	cards := characters.List(s.dataDir)
	payload := make([]map[string]any, 0, len(cards))
	for _, card := range cards {
		payload = append(payload, map[string]any{"name": card.Name, "filename": card.Filename})
	}
	return payload
}

// handleCharacterUpload 上传角色卡：兼容 multipart(file) 与 JSON(card) 两种形式。
// 对齐 Node：写 PNG 到 data/characters，并返回元信息/导入计划供前端弹窗。
func (s *Server) handleCharacterUpload(writer http.ResponseWriter, request *http.Request) {
	if strings.HasPrefix(request.Header.Get("Content-Type"), "multipart/form-data") {
		s.handleCharacterUploadMultipart(writer, request)
		return
	}
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
	writeJSON(writer, http.StatusOK, s.characterUploadPayload(name))
}

// handleCharacterUploadMultipart 处理前端 FormData 上传的 PNG 角色卡。
func (s *Server) handleCharacterUploadMultipart(writer http.ResponseWriter, request *http.Request) {
	if err := request.ParseMultipartForm(64 << 20); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "上传内容解析失败: " + err.Error()})
		return
	}
	file, header, err := request.FormFile("file")
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "未上传文件"})
		return
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 64<<20))
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "读取上传内容失败"})
		return
	}
	name := safeBase(header.Filename)
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "文件名为空"})
		return
	}
	charDir := filepath.Join(s.dataDir, "characters")
	if err := os.MkdirAll(charDir, 0o755); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	target := filepath.Join(charDir, name+".png")
	if !bytes.HasPrefix(raw, []byte{0x89, 'P', 'N', 'G'}) {
		// 非 PNG（如 JSON 卡）：落成同名字符串文件，与 characters.Read 的 JSON 回退一致
		target = filepath.Join(charDir, name+".json")
	}
	if err := os.WriteFile(target, raw, 0o644); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, s.characterUploadPayload(name))
}

// characterUploadPayload 组装上传响应（对齐 Node upload 的返回字段）。
func (s *Server) characterUploadPayload(name string) map[string]any {
	metadata := s.characterMetadata(name)
	return map[string]any{
		"success":          true,
		"message":          "角色卡上传成功",
		"filename":         name + ".png",
		"characters":       s.characterListPayload(),
		"importedMetadata": metadata,
		"metadataSummary":  summarizeCharacterMetadata(metadata),
		"importPlan":       characterImportPlan(metadata),
		"bindingSummary":   s.bindingSummary(name),
		"variableInit":     nil,
	}
}

// handleCharacterBatchDownload 打包导出角色卡（对齐 Node：tar.gz）。
func (s *Server) handleCharacterBatchDownload(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	serveArchive(writer, filepath.Join(s.dataDir, "characters"), body["filenames"], "characters")
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
		updated, err := characters.Update(s.dataDir, name, body)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "角色卡已保存", "character": updated})
	case strings.HasSuffix(rest, "/variable-defaults"):
		name := safeBase(strings.TrimSuffix(rest, "/variable-defaults"))
		card, err := characters.Read(s.dataDir, name)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
			return
		}
		switch request.Method {
		case http.MethodGet:
			defaults := card["variable_defaults"]
			if defaults == nil {
				defaults = map[string]any{}
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "variableDefaults": defaults, "defaults": defaults})
		case http.MethodPut:
			body := decodeBody(request)
			defaults := body["variableDefaults"]
			if defaults == nil {
				defaults = body["variable_defaults"]
			}
			if _, ok := defaults.(map[string]any); !ok {
				writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "variableDefaults 必须是对象"})
				return
			}
			if _, err := characters.Update(s.dataDir, name, map[string]any{"variable_defaults": defaults}); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
			writeJSON(writer, http.StatusOK, map[string]any{"success": true})
		default:
			writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		}
	case strings.HasSuffix(rest, "/download"):
		name := safeBase(strings.TrimSuffix(rest, "/download"))
		path := filepath.Join(s.dataDir, "characters", name+".png")
		if _, err := os.Stat(path); err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "角色文件不存在"})
			return
		}
		writer.Header().Set("Content-Type", "image/png")
		writer.Header().Set("Content-Disposition", "attachment; filename=\""+name+".png\"")
		raw, err := os.ReadFile(path)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		_, _ = writer.Write(raw)
	case strings.HasSuffix(rest, "/memory-binding"):
		s.handleMemoryBinding(writer, request, safeBase(strings.TrimSuffix(rest, "/memory-binding")), "memory")
	case strings.HasSuffix(rest, "/worldbook-binding"):
		s.handleMemoryBinding(writer, request, safeBase(strings.TrimSuffix(rest, "/worldbook-binding")), "worldbook")
	default:
		if request.Method == http.MethodDelete {
			name := safeBase(rest)
			removed := false
			for _, ext := range []string{".png", ".json"} {
				if err := os.Remove(filepath.Join(s.dataDir, "characters", name+ext)); err == nil {
					removed = true
				}
			}
			if !removed {
				writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "角色不存在"})
				return
			}
			_ = os.Remove(characters.OverridesPath(s.dataDir, name))
			writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "角色已删除"})
			return
		}
		if strings.HasSuffix(rest, "/detail") {
			s.renderCharacterDetail(writer, strings.TrimSuffix(rest, "/detail"))
			return
		}
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "未知子路径"})
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
	message := "角色记忆绑定已更新"
	if kind == "worldbook" {
		message = "角色世界书绑定已更新"
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":        true,
		"message":        message,
		"bindingSummary": s.bindingSummary(name),
	})
}

// writeCharacterCardByName 写回角色卡：已有 PNG 走内嵌数据重写，否则新建 PNG。
// 之前直接写 characters/<name>.json，Node 版看不到、Go 自己的读路径也优先 PNG，更新等于丢失。
func (s *Server) writeCharacterCardByName(name string, card map[string]any) error {
	safe := safeBase(name)
	if _, err := os.Stat(filepath.Join(s.dataDir, "characters", safe+".png")); err == nil {
		_, err := characters.Update(s.dataDir, safe, card)
		return err
	}
	return characters.Create(s.dataDir, safe, card)
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
	name := safeBase(firstText(textOf(body["characterName"]), strings.TrimSuffix(s.currentWorldbookName(), ".json")))
	input := firstText(textOf(body["text"]), textOf(body["input"]))
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
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "entries": matched, "matched": matched, "count": len(matched)})
}

// handleWorldbookManage /api/worldbooks/:filename 的子操作分发。
func (s *Server) handleWorldbookManage(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/worldbooks/"), "/")
	switch {
	case strings.HasSuffix(rest, "/content"):
		name := safeBase(strings.TrimSuffix(rest, "/content"))
		raw, err := os.ReadFile(filepath.Join(s.dataDir, "worlds", name+".json"))
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": "世界书不存在"})
			return
		}
		var worldbook any
		if err := json.Unmarshal(raw, &worldbook); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": "世界书解析失败: " + err.Error()})
			return
		}
		// 对齐 Node GET /api/worldbooks/:filename/content → { success, worldbook }
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "worldbook": worldbook})
	case strings.HasSuffix(rest, "/save"):
		name := safeBase(strings.TrimSuffix(rest, "/save"))
		body := decodeBody(request)
		// Node 契约是 { worldbook: {...} }；同时兼容直接提交世界书对象的历史用法
		worldbook, ok := body["worldbook"].(map[string]any)
		if !ok {
			if _, hasEntries := body["entries"]; hasEntries {
				worldbook = body
				ok = true
			}
		}
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供世界书数据"})
			return
		}
		encoded, _ := json.MarshalIndent(worldbook, "", "  ")
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

// handleRegexTest 正则规则测试：兼容 Node 契约 {pattern, flags, replacement, testText}
// 与靶场/规则列表用的 {input, rules} 两种请求体。
func (s *Server) handleRegexTest(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	if pattern := textOf(body["pattern"]); pattern != "" {
		testText := firstText(textOf(body["testText"]), textOf(body["input"]), textOf(body["text"]))
		compiled, err := compileJSRegexFlags(pattern, textOf(body["flags"]))
		if err != nil {
			writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error()})
			return
		}
		matches := compiled.FindAllString(testText, -1)
		if matches == nil {
			matches = []string{}
		}
		result := compiled.ReplaceAllString(testText, textOf(body["replacement"]))
		writeJSON(writer, http.StatusOK, map[string]any{
			"success": true, "matches": matches, "result": result, "changed": result != testText,
		})
		return
	}
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

// handleRegexImport 正则规则导入（对齐 Node POST /api/regex/import）。
func (s *Server) handleRegexImport(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	layer := orDefault(textOf(body["targetLayer"]), "global")
	importedRules := chat.NormalizeImportedRules(body)
	if len(importedRules) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "未识别到可导入的正则规则"})
		return
	}
	path, ok := s.regexLayerPath(layer)
	if !ok {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "当前没有选中角色，无法导入到角色层"})
		return
	}
	existing, _ := s.regexLayerRules(layer)
	seen := map[string]bool{}
	for _, item := range existing {
		if rule, ok := item.(map[string]any); ok {
			seen[ruleFingerprint(rule)] = true
		}
	}
	nextRules := []map[string]any{}
	for _, rule := range importedRules {
		key := ruleFingerprint(rule)
		if seen[key] {
			continue
		}
		seen[key] = true
		nextRules = append(nextRules, rule)
	}
	merged := append(existing, toAnyList(nextRules)...)
	if err := s.document.Set(path, merged); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	record := map[string]any{
		"id": fmt.Sprintf("regex_%d", nowMillis()), "type": "regex",
		"filename":    orDefault(textOf(body["sourceFilename"]), fmt.Sprintf("regex-%d.json", nowMillis())),
		"targetLayer": layer, "createdAt": time.Now().UTC().Format(time.RFC3339),
		"importedRules": toAnyList(nextRules),
	}
	records := s.regexImportRecords()
	records = append([]map[string]any{record}, records...)
	_ = s.document.Set("imports.regexFiles", toAnyList(records))
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "count": len(nextRules), "importedRules": nextRules,
		"diagnostics": map[string]any{"recognized": len(importedRules), "applied": len(nextRules)},
		"targetLayer": layer,
		"importRecord": map[string]any{
			"id": record["id"], "type": "regex", "filename": record["filename"],
			"targetLayer": layer, "createdAt": record["createdAt"], "importedCount": len(nextRules),
		},
	})
}

// ruleFingerprint 是规则去重键（对齐 Node 的 name|pattern|replacement）。
func ruleFingerprint(rule map[string]any) string {
	return textOf(rule["name"]) + "|" + textOf(rule["pattern"]) + "|" + textOf(rule["replacement"])
}

// toAnyList 把强类型切片转成 []any（配置文档写入用）。
func toAnyList[T any](items []T) []any {
	result := make([]any, 0, len(items))
	for _, item := range items {
		result = append(result, item)
	}
	return result
}

// handleRegexExport 正则规则导出（对齐 Node GET /api/regex/export）。
func (s *Server) handleRegexExport(writer http.ResponseWriter, request *http.Request) {
	format := "native"
	if request.URL.Query().Get("format") == "sillytavern" {
		format = "sillytavern"
	}
	payload := chat.ExportRules(s.document, format)
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=regex-%s-%d.json", format, nowMillis()))
	encoded, _ := json.MarshalIndent(payload, "", "  ")
	_, _ = writer.Write(encoded)
}

// handleRegexImportDelete 删除导入记录并移除其导入的规则（对齐 Node）。
func (s *Server) handleRegexImportDelete(writer http.ResponseWriter, request *http.Request) {
	recordID := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/regex/imports/"), "/")
	records := s.regexImportRecords()
	var target map[string]any
	remaining := []map[string]any{}
	for _, record := range records {
		if textOf(record["id"]) == recordID {
			target = record
			continue
		}
		remaining = append(remaining, record)
	}
	if target == nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "导入记录不存在"})
		return
	}
	layer := orDefault(textOf(target["targetLayer"]), "global")
	imported, _ := target["importedRules"].([]any)
	if path, ok := s.regexLayerPath(layer); ok && len(imported) > 0 {
		signatures := map[string]bool{}
		for _, item := range imported {
			if rule, ok := item.(map[string]any); ok {
				signatures[ruleFingerprint(rule)] = true
			}
		}
		existing, _ := s.regexLayerRules(layer)
		kept := []any{}
		for _, item := range existing {
			if rule, ok := item.(map[string]any); ok && signatures[ruleFingerprint(rule)] {
				continue
			}
			kept = append(kept, item)
		}
		_ = s.document.Set(path, kept)
	}
	_ = s.document.Set("imports.regexFiles", toAnyList(remaining))
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "导入记录已删除", "removedCount": len(imported)})
}

// compileJSRegexFlags 按 Node new RegExp(pattern, flags) 的语义编译（支持 g/i/m/s）。
func compileJSRegexFlags(pattern string, flags string) (*regexp.Regexp, error) {
	prefix := ""
	if strings.Contains(flags, "i") {
		prefix += "(?i)"
	}
	if strings.Contains(flags, "s") {
		prefix += "(?s)"
	}
	if strings.Contains(flags, "m") {
		prefix += "(?m)"
	}
	return regexp.Compile(prefix + pattern)
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
	counts := store.Counts{}
	if c, err := database.Counts(); err == nil {
		counts = c
	}
	knowledge, _ := database.ListKnowledgeEntriesFiltered(store.VariableFilters{Limit: 500})
	writer.Header().Set("Content-Disposition", "attachment; filename=memory-export-"+fmt_Sprint(time.Now().UnixMilli())+".json")
	writeJSON(writer, http.StatusOK, map[string]any{
		"sessions":       sessions,
		"knowledge":      knowledge,
		"globalTimeline": []any{},
		"stats": map[string]any{
			"totalMessages":    counts.Messages,
			"totalSessions":    counts.Sessions,
			"totalSummaries":   counts.Summaries,
			"memoryFileSizeMB": memoryFileSizeMB(path),
		},
		"exportDate": time.Now().UTC().Format(time.RFC3339),
		"storage":    map[string]any{"type": "sqlite", "path": path},
		"exportedAt": time.Now().UnixMilli(),
		"dbPath":     path,
	})
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

// handleDataClear 对齐 Node POST /api/data/clear：
// body.confirm === true 时清空整个记忆库（会话/消息/变量/档案/知识），
// 同时保留 Go 侧的 targets:['audio'|'logs'] 文件清理扩展。
// 旧实现忽略 confirm，前端「清空所有数据」会拿到 success 但什么都没清（假成功）。
func (s *Server) handleDataClear(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	if body["confirm"] == true {
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		cleared, err := database.ClearAllData()
		_ = database.Close()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		s.logger.Printf("已清空记忆库: %v", cleared)
		writeJSON(writer, http.StatusOK, map[string]any{
			"success": true,
			"cleared": cleared,
			"message": "所有会话、消息、变量、档案、知识库已清空",
		})
		return
	}
	if _, hasTargets := body["targets"]; !hasTargets {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "需要 confirm: true 确认清空操作"})
		return
	}
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

// handleWebSearchTest 执行真实联网搜索（对齐 Node POST /api/tools/web-search/test）。
func (s *Server) handleWebSearchTest(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	query := strings.TrimSpace(textOf(body["query"]))
	if query == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "搜索关键词不能为空"})
		return
	}
	topic := "web"
	if textOf(body["topic"]) == "news" {
		topic = "news"
	}
	limit := intOr(body["limit"], 0)
	config := tools.LoadSearchConfig(s.document)
	service := search.New(config, s.logger)
	requestOptions := search.Request{
		Topic:     topic,
		TimeRange: textOf(body["timeRange"]),
		Site:      textOf(body["site"]),
	}
	if limit > 0 {
		requestOptions.Limit = limit
	}
	startedAt := time.Now()
	results, attempts, err := service.Search(request.Context(), query, requestOptions)
	durationMs := time.Since(startedAt).Milliseconds()
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{
			"success": false, "error": err.Error(), "attempts": attempts, "query": query, "durationMs": durationMs,
		})
		return
	}
	providerID := config.Provider
	source := providerID
	if len(results) > 0 && results[0].Source != "" {
		source = results[0].Source
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":     true,
		"ok":          true,
		"provider":    providerID,
		"source":      source,
		"query":       query,
		"topic":       topic,
		"durationMs":  durationMs,
		"resultCount": len(results),
		"results":     results,
		"attempts":    attempts,
	})
}

func (s *Server) handlePromptPreview(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	contextBody, _ := body["context"].(map[string]any)

	message := strings.TrimSpace(textOf(body["userMessage"]))
	history := []ai.Message{}
	if contextBody != nil {
		if items, ok := contextBody["recentMessages"].([]any); ok {
			for _, item := range items {
				entry, _ := item.(map[string]any)
				if entry == nil {
					continue
				}
				content := strings.TrimSpace(fmt.Sprintf("%v", entry["content"]))
				if content == "" {
					continue
				}
				role := strings.TrimSpace(fmt.Sprintf("%v", entry["role"]))
				if role != "user" && role != "assistant" {
					role = "user"
				}
				history = append(history, ai.Message{Role: role, Content: content})
			}
		}
	}
	if message == "" && len(history) > 0 {
		message = orDefault(fmt.Sprintf("%v", history[len(history)-1].Content), "")
	}

	// 角色/世界书：沿用运行时的解析顺序（显式指定 → 当前绑定）
	characterName := strings.TrimSuffix(strings.TrimSpace(textOf(body["characterName"])), ".png")
	if characterName == "" {
		characterName = strings.TrimSuffix(s.currentCharacterName(), ".png")
	}
	worldbookName := strings.TrimSpace(textOf(body["worldbookName"]))

	memory, _, memoryErr := s.openActiveMemory()
	if memoryErr == nil {
		defer func() { _ = memory.Close() }()
	}

	in := chat.RangeInput{
		Document:         s.document,
		DataDir:          s.dataDir,
		CharacterName:    characterName,
		WorldbookName:    worldbookName,
		Message:          message,
		MessageType:      orDefault(strings.TrimSpace(textOf(body["messageType"])), "group"),
		GroupID:          strings.TrimSpace(textOf(body["groupId"])),
		UserID:           strings.TrimSpace(textOf(body["userId"])),
		History:          history,
		Memory:           memory,
		SessionKey:       strings.TrimSpace(textOf(body["sessionKey"])),
		Participants:     s.previewParticipants(body),
		ReplyReference:   strings.TrimSpace(textOf(body["replyReference"])),
		ContextOverrides: contextOverridesOf(body),
		Logger:           s.logger,
	}
	if variables, ok := body["variableBlock"].(string); ok {
		in.VariableBlock = variables
	}
	messages, segments, activeBook, err := chat.BuildRangePrompt(in)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	composition := chat.BuildRuntimeComposition(segments)
	sources := make([]map[string]any, 0, len(segments))
	for _, segment := range segments {
		sources = append(sources, map[string]any{
			"sourceSlot": segment.ID,
			"stage":      segment.Stage,
			"kind":       segment.Kind,
			"label":      segment.Label,
			"tokens":     segment.Tokens,
			"chars":      len([]rune(segment.Content)),
			"meta":       segment.Meta,
		})
	}
	binding := map[string]any{"characterName": characterName, "worldbookName": activeBook}
	worldbookSource := "none"
	if strings.TrimSpace(worldbookName) != "" {
		worldbookSource = "explicit"
	} else if strings.TrimSpace(activeBook) != "" {
		worldbookSource = "global"
	}
	regexRules, _ := s.regexLayerRules("global")
	bindingTrace := map[string]any{
		"worldbook": map[string]any{"source": worldbookSource, "value": nilIfEmpty(activeBook)},
		"preset":    chat.ResolvePresetTrace(s.document, characterName),
		"regexRules": map[string]any{
			"source": "global",
			"count":  len(regexRules),
		},
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":            true,
		"character":          map[string]any{"name": characterName},
		"worldBook":          map[string]any{"name": nilIfEmpty(activeBook)},
		"effectiveBinding":   binding,
		"bindingTrace":       bindingTrace,
		"sources":            sources,
		"segments":           segments,
		"runtimeComposition": composition,
		"messageTrace":       chat.BuildMessageTrace(messages, segments),
		"messages":           messages,
		"contextConfig":      contextConfigSnapshot(s.document),
	})
}

// previewParticipants 从请求体（或模拟记忆）整理参与者名单，供上下文注入展示。
func (s *Server) previewParticipants(body map[string]any) []string {
	if raw, ok := body["participants"].([]any); ok {
		result := []string{}
		for _, item := range raw {
			if value := strings.TrimSpace(fmt.Sprintf("%v", item)); value != "" {
				result = append(result, value)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	contextBody, _ := body["context"].(map[string]any)
	if contextBody == nil {
		return nil
	}
	seen := map[string]bool{}
	result := []string{}
	if items, ok := contextBody["recentMessages"].([]any); ok {
		for _, item := range items {
			entry, _ := item.(map[string]any)
			if entry == nil {
				continue
			}
			name := strings.TrimSpace(fmt.Sprintf("%v", entry["userName"]))
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			result = append(result, name)
		}
	}
	return result
}

// contextConfigSnapshot 回传上下文注入开关现状（前端展示「哪些开关已生效」）。
func contextConfigSnapshot(document *config.Document) map[string]any {
	keys := []string{"enabled", "includeSessionFacts", "includeParticipants", "includeReplyReference", "includeRecentUserIntent"}
	snapshot := map[string]any{}
	for _, key := range keys {
		enabled := true
		if document != nil && document.Exists("context."+key) {
			enabled = document.Bool("context." + key)
		}
		snapshot[key] = enabled
	}
	return snapshot
}

func nilIfEmpty(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
