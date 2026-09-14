package panel

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"mimirlink/internal/characters"
	"mimirlink/internal/store"
)

// 本文件补齐 goal-36 审计发现的端点缺口与角色卡元信息辅助函数：
//
//   - 世界书 refresh / batch-download（tar.gz）
//   - /api/regex/:index 的 PUT/DELETE（前端按索引编辑/删除规则）
//   - /api/preset/imports/:id 与 batch-delete
//   - /api/memory/knowledge/import、/api/memory/knowledge/:id
//   - /api/participant-profiles/:id（GET/DELETE）、analyze、refresh-name
//   - 角色卡元信息摘要（上传响应所需）

// ---------------- 角色卡元信息 ----------------

// characterMetadata 对齐 Node CharacterManager.extractSillyTavernMetadata。
func (s *Server) characterMetadata(name string) map[string]any {
	card, err := characters.Read(s.dataDir, name)
	if err != nil {
		return map[string]any{}
	}
	nested, _ := card["data"].(map[string]any)
	pick := func(key string) any {
		if value, ok := card[key]; ok && value != nil {
			return value
		}
		if nested != nil {
			return nested[key]
		}
		return nil
	}
	extensions, _ := pick("extensions").(map[string]any)
	depthPrompt, _ := extensions["depth_prompt"].(map[string]any)
	book, _ := pick("character_book").(map[string]any)
	entriesCount := 0
	if book != nil {
		switch entries := book["entries"].(type) {
		case []any:
			entriesCount = len(entries)
		case map[string]any:
			entriesCount = len(entries)
		}
	}
	regexScripts, _ := extensions["regex_scripts"].([]any)
	if regexScripts == nil {
		regexScripts, _ = pick("regex_scripts").([]any)
	}
	tags := []any{}
	for _, source := range []any{card["tags"], nested["tags"]} {
		if list, ok := source.([]any); ok {
			tags = append(tags, list...)
		}
	}
	return map[string]any{
		"name":                    firstText(textOf(pick("name")), safeBase(name)),
		"spec":                    textOf(pick("spec")),
		"specVersion":             textOf(pick("spec_version")),
		"hasEmbeddedWorldBook":    book != nil,
		"worldBookEntries":        entriesCount,
		"worldBook":               book,
		"tags":                    tags,
		"creatorNotes":            firstText(textOf(pick("creator_notes")), textOf(pick("creatorcomment"))),
		"alternateGreetings":      anyOr(pick("alternate_greetings"), []any{}),
		"postHistoryInstructions": textOf(pick("post_history_instructions")),
		"systemPrompt":            textOf(pick("system_prompt")),
		"preferredPreset": map[string]any{
			"name":                    "",
			"systemPrompt":            firstText(textOf(depthPrompt["prompt"]), textOf(pick("system_prompt"))),
			"postHistoryInstructions": textOf(pick("post_history_instructions")),
			"assistantPrefill":        textOf(pick("assistant_prefill")),
		},
		"regexScripts": regexScripts,
	}
}

// summarizeCharacterMetadata 对齐 Node summarizeCharacterMetadata 的返回字段。
func summarizeCharacterMetadata(metadata map[string]any) map[string]any {
	regexScripts, _ := metadata["regexScripts"].([]any)
	greetings, _ := metadata["alternateGreetings"].([]any)
	tags, _ := metadata["tags"].([]any)
	preferred, _ := metadata["preferredPreset"].(map[string]any)
	importable := 0
	for _, item := range regexScripts {
		if rule, ok := item.(map[string]any); ok && isBackendCompatibleRegexRule(rule) {
			importable++
		}
	}
	return map[string]any{
		"hasEmbeddedWorldBook":       metadata["hasEmbeddedWorldBook"] == true,
		"worldBookEntries":           intOr(metadata["worldBookEntries"], 0),
		"regexScriptCount":           len(regexScripts),
		"importableRegexScriptCount": importable,
		"alternateGreetingsCount":    len(greetings),
		"hasPostHistoryInstructions": textOf(metadata["postHistoryInstructions"]) != "" || textOf(preferred["postHistoryInstructions"]) != "",
		"hasSystemPrompt":            textOf(metadata["systemPrompt"]) != "" || textOf(preferred["systemPrompt"]) != "",
		"tags":                       tags,
		"creatorNotes":               textOf(metadata["creatorNotes"]),
		"spec":                       textOf(metadata["spec"]),
		"specVersion":                textOf(metadata["specVersion"]),
	}
}

// characterImportPlan 对齐 Node buildCharacterMetadataPlan 的 plan 字段。
func characterImportPlan(metadata map[string]any) map[string]any {
	preferred, _ := metadata["preferredPreset"].(map[string]any)
	return map[string]any{
		"importWorldBook": metadata["hasEmbeddedWorldBook"] == true && metadata["worldBook"] != nil,
		"importPreset": textOf(metadata["systemPrompt"]) != "" ||
			textOf(metadata["postHistoryInstructions"]) != "" ||
			textOf(preferred["assistantPrefill"]) != "",
		"importRegex": summarizeCharacterMetadata(metadata)["importableRegexScriptCount"].(int) > 0,
	}
}

// isBackendCompatibleRegexRule 判断角色卡附带正则能否在服务端使用（对齐 Node 的过滤）。
func isBackendCompatibleRegexRule(rule map[string]any) bool {
	find := firstText(textOf(rule["findRegex"]), textOf(rule["pattern"]))
	replace := firstText(textOf(rule["replaceString"]), textOf(rule["replacement"]))
	if find == "" {
		return false
	}
	// 纯展示型（markdownOnly/promptOnly 且无替换）视为不可用
	if replace == "" && (rule["markdownOnly"] == true || rule["promptOnly"] == true) {
		return false
	}
	return true
}

// bindingSummary 对齐 Node getBindingSummary 的关键字段（面板展示绑定来源）。
func (s *Server) bindingSummary(name string) map[string]any {
	overrides := characters.ReadOverrides(s.dataDir, name)
	memoryPath := textOf(overrides["memoryDbPath"])
	if memoryPath == "" {
		memoryPath = s.document.String("bindings.global.memoryDbPath")
	}
	if memoryPath == "" {
		memoryPath = s.document.String("memory.storage.path")
	}
	worldbook := textOf(overrides["worldBook"])
	if worldbook == "" {
		worldbook = s.document.String("bindings.global.worldbook")
	}
	source := func(explicit string, fallback string) string {
		if explicit != "" {
			return "character"
		}
		if fallback != "" {
			return "global"
		}
		return "none"
	}
	return map[string]any{
		"memoryDbPath": map[string]any{
			"source": source(textOf(overrides["memoryDbPath"]), s.document.String("bindings.global.memoryDbPath")),
			"value":  nilIf(memoryPath),
		},
		"worldbook": map[string]any{
			"source": source(textOf(overrides["worldBook"]), s.document.String("bindings.global.worldbook")),
			"value":  nilIf(worldbook),
		},
		"preset": map[string]any{
			"source": "none",
			"value":  nilIf(s.document.String("bindings.global.preset")),
		},
	}
}

// ---------------- 打包下载 ----------------

// serveArchive 把 dir 下指定文件名打包成 tar.gz 输出（对齐 Node tar-fs + gzip）。
func serveArchive(writer http.ResponseWriter, dir string, raw any, prefix string) {
	items, _ := raw.([]any)
	names := []string{}
	for _, item := range items {
		name := safeBase(textOf(item))
		if name == "" {
			continue
		}
		for _, candidate := range []string{name + ".png", name + ".json"} {
			if _, err := os.Stat(filepath.Join(dir, candidate)); err == nil {
				names = append(names, candidate)
				break
			}
		}
	}
	if len(names) == 0 {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "没有有效文件"})
		return
	}
	writer.Header().Set("Content-Type", "application/gzip")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s-%d.tar.gz\"", prefix, nowMillis()))
	gzipWriter := gzip.NewWriter(writer)
	tarWriter := tar.NewWriter(gzipWriter)
	for _, name := range names {
		path := filepath.Join(dir, name)
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			continue
		}
		header.Name = name
		if err := tarWriter.WriteHeader(header); err != nil {
			break
		}
		file, err := os.Open(path)
		if err != nil {
			continue
		}
		_, _ = io.Copy(tarWriter, file)
		_ = file.Close()
	}
	_ = tarWriter.Close()
	_ = gzipWriter.Close()
}

// ---------------- 世界书 ----------------

func (s *Server) handleWorldbookRefresh(writer http.ResponseWriter, request *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "worldbooks": s.worldbookList()})
}

// worldbookList 返回世界书文件名列表（对齐 Node GET /api/worldbooks）。
func (s *Server) worldbookList() []string {
	entries, err := os.ReadDir(filepath.Join(s.dataDir, "worlds"))
	if err != nil {
		return []string{}
	}
	names := []string{}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		lowered := strings.ToLower(name)
		if strings.HasSuffix(lowered, ".json") || strings.HasSuffix(lowered, ".json.bak") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

func (s *Server) handleWorldbookBatchDownload(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	serveArchive(writer, filepath.Join(s.dataDir, "worlds"), body["filenames"], "worldbooks")
}

// ---------------- regex 写操作 ----------------

// handleRegexIndex 处理 PUT/DELETE /api/regex/:index（前端按索引编辑/删除规则）。
// 对齐 Node：PUT 的 targetLayer 取自 body（无则 global），索引越界返回 404；
// DELETE 的 targetLayer 取自 query，索引越界仍返回成功。
func (s *Server) handleRegexIndex(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/regex/"), "/")
	if rest == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少规则索引"})
		return
	}
	index, err := strconv.Atoi(rest)
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "规则索引无效"})
		return
	}
	switch request.Method {
	case http.MethodPut:
		body := decodeBody(request)
		layer := orDefault(textOf(body["targetLayer"]), "global")
		delete(body, "targetLayer")
		path, ok := s.regexLayerPath(layer)
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "当前没有选中角色，无法更新角色层规则"})
			return
		}
		rules, _ := s.regexLayerRules(layer)
		if index < 0 || index >= len(rules) {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "规则不存在"})
			return
		}
		merged := map[string]any{}
		if existing, ok := rules[index].(map[string]any); ok {
			for key, value := range existing {
				merged[key] = value
			}
		}
		for key, value := range body {
			merged[key] = value
		}
		rules[index] = merged
		if err := s.document.Set(path, rules); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "规则已更新"})
	case http.MethodDelete:
		layer := orDefault(request.URL.Query().Get("targetLayer"), "global")
		path, ok := s.regexLayerPath(layer)
		if !ok {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "当前没有选中角色，无法删除角色层规则"})
			return
		}
		rules, _ := s.regexLayerRules(layer)
		if index >= 0 && index < len(rules) {
			rules = append(rules[:index], rules[index+1:]...)
		}
		if err := s.document.Set(path, rules); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "规则已删除"})
	case http.MethodGet:
		layer := orDefault(request.URL.Query().Get("targetLayer"), "global")
		rules, _ := s.regexLayerRules(layer)
		if index < 0 || index >= len(rules) {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "规则不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, rules[index])
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// ---------------- 预设导入记录 ----------------

// handlePresetImportDelete 删除导入记录（Go 版导入直接写 presets 目录，无独立记录表）。
func (s *Server) handlePresetImportDelete(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/preset/imports/"), "/")
	if rest == "batch-delete" && request.Method == http.MethodPost {
		s.handlePresetImportBatchDelete(writer, request)
		return
	}
	if request.Method != http.MethodDelete {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	name := safeBase(rest)
	if name == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少导入 ID"})
		return
	}
	if err := os.Remove(filepath.Join(s.dataDir, "presets", "preset-"+name+".json")); err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "导入记录不存在"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "导入记录已删除"})
}

// ---------------- 知识条目 ----------------

// handleMemoryKnowledgeImport 批量导入知识条目（对齐 Node /api/memory/knowledge/import）。
func (s *Server) handleMemoryKnowledgeImport(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	body := decodeBody(request)
	entries, _ := body["entries"].([]any)
	if len(entries) == 0 {
		// Node 契约：{ text, title, chunkSize } 的分块导入
		if textOf(body["text"]) != "" {
			s.handleMemoryKnowledgeImportText(writer, request)
			return
		}
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "导入文本不能为空"})
		return
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	options := s.variableScope(body)
	imported := 0
	skipped := 0
	for _, item := range entries {
		entry, _ := item.(map[string]any)
		if entry == nil {
			skipped++
			continue
		}
		record := store.KnowledgeEntry{
			Title:         firstText(textOf(entry["title"]), textOf(entry["name"])),
			Content:       textOf(entry["content"]),
			KnowledgeType: orDefault(textOf(entry["knowledgeType"]), "fixed"),
			Tags:          stringListOf(entry["tags"]),
			Metadata:      objectOf(entry["metadata"]),
		}
		if record.Content == "" {
			skipped++
			continue
		}
		if _, err := database.UpsertKnowledgeEntry(options, record); err != nil {
			skipped++
			continue
		}
		imported++
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "imported": imported, "skipped": skipped, "message": fmt.Sprintf("已导入 %d 条知识", imported)})
}

// handleMemoryKnowledgeDetail 处理 /api/memory/knowledge/:id 的 GET/DELETE。
func (s *Server) handleMemoryKnowledgeDetail(writer http.ResponseWriter, request *http.Request) {
	entryID := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/memory/knowledge/"), "/")
	if entryID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少知识 ID"})
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
		item, err := database.GetKnowledgeEntry(entryID)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if item == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "知识条目不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item})
	case http.MethodDelete:
		deleted, err := database.DeleteKnowledgeEntry(entryID)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if !deleted {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "知识条目不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "知识条目已删除"})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// ---------------- 人物档案 ----------------

// handleParticipantProfileDetail 处理 /api/participant-profiles/:id 与其子操作。
func (s *Server) handleParticipantProfileDetail(writer http.ResponseWriter, request *http.Request) {
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, "/api/participant-profiles/"), "/")
	if rest == "" {
		s.handleParticipantProfiles(writer, request)
		return
	}
	if strings.HasSuffix(rest, "/analyze") {
		id := strings.TrimSuffix(rest, "/analyze")
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		existing, err := database.GetParticipantProfileByEntryID(id)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if existing == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "人物档案不存在"})
			return
		}
		// 面板进程无 bot 上下文（在线昵称/群成员资料）：按 Node 无能力时的语义返回 501
		writeJSON(writer, http.StatusNotImplemented, map[string]any{
			"success": false,
			"error":   "人物档案手动分析由 bot 进程触发；面板进程无 OneBot 连接与聊天上下文",
		})
		return
	}
	if strings.HasSuffix(rest, "/refresh-name") {
		id := strings.TrimSuffix(rest, "/refresh-name")
		database, _, err := s.openActiveMemory()
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		defer database.Close()
		existing, err := database.GetParticipantProfileByEntryID(id)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if existing == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "人物档案不存在"})
			return
		}
		writeJSON(writer, http.StatusNotImplemented, map[string]any{
			"success": false,
			"error":   "刷新昵称需要 OneBot 连接（QQ 全局资料/群成员资料），面板进程无该能力",
		})
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
		item, err := database.GetParticipantProfileByEntryID(rest)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if item == nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "人物档案不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item})
	case http.MethodDelete:
		deleted, err := database.DeleteParticipantProfile(rest)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if !deleted {
			writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "人物档案不存在"})
			return
		}
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "人物档案已删除"})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// handleParticipantProfileSave 面板保存人物档案（对齐 Node POST /api/participant-profiles）。
func (s *Server) handleParticipantProfileSave(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	entryID := firstText(textOf(body["id"]), textOf(body["entryId"]))
	title := textOf(body["title"])
	content := textOf(body["content"])
	metadata := objectOf(body["metadata"])
	if metadata == nil {
		metadata = map[string]any{}
	}
	if note := textOf(body["note"]); note != "" {
		metadata["note"] = note
	}
	metadata["updatedBy"] = orDefault(firstText(textOf(body["updatedBy"]), textOf(metadata["updatedBy"])), "admin-panel")
	metadata["editedBy"] = orDefault(firstText(textOf(body["editedBy"]), textOf(metadata["editedBy"])), "admin-panel")
	metadata["source"] = orDefault(textOf(metadata["source"]), "participant_profile")
	if entryID == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "人物档案 ID 不能为空"})
		return
	}
	if title == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "人物档案标题不能为空"})
		return
	}
	if content == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "人物档案内容不能为空"})
		return
	}
	database, _, err := s.openActiveMemory()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer database.Close()
	if _, err := database.SaveParticipantProfile(s.variableScope(body), entryID, textOf(metadata["participantId"]), title, content, stringListOf(body["tags"]), metadata, ""); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	item, err := database.GetParticipantProfileByEntryID(entryID)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	if item == nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "人物档案不存在"})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "item": item, "message": "人物档案已更新"})
}

// mergeMetadataSummary 合并元信息摘要（后者仅补充缺失键，不覆盖 Node 语义字段）。
func mergeMetadataSummary(base map[string]any, extra map[string]any) map[string]any {
	merged := map[string]any{}
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range extra {
		if _, exists := merged[key]; exists {
			continue
		}
		merged[key] = value
	}
	return merged
}
