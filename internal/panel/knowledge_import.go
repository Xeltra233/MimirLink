package panel

// 知识导入（对齐 Node /api/memory/knowledge/import 的 AI 提炼流水线：
// 文本切块 → 逐段调用模型提炼结构化知识 → 写入记忆库，并维护 knowledgeImportProgress 供 /api/status 展示）。

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"
	"unicode/utf16"

	"mimirlink/internal/ai"
	"mimirlink/internal/metrics"
	"mimirlink/internal/store"
)

// knowledgeProgressDefaults 对齐 Node index.js 的 knowledgeImportProgress 初始对象。
func knowledgeProgressDefaults() map[string]any {
	return map[string]any{
		"running":         false,
		"stage":           "idle",
		"triggeredBy":     nil,
		"title":           nil,
		"knowledgeType":   nil,
		"scopeType":       nil,
		"scopeKey":        nil,
		"characterName":   nil,
		"presetName":      nil,
		"totalChunks":     0,
		"processedChunks": 0,
		"savedCount":      0,
		"currentChunk":    0,
		"currentMessage":  "暂无知识导入任务",
		"progressPercent": 0,
		"tasks":           []any{},
		"lastQueuedAt":    nil,
		"lastStartedAt":   nil,
		"lastCompletedAt": nil,
		"lastSuccessAt":   nil,
		"lastFailureAt":   nil,
		"lastError":       nil,
		"lastResult":      nil,
		"updatedAt":       time.Now().UnixMilli(),
	}
}

// knowledgeProgressSnapshot 返回当前进度快照（深拷贝 tasks，避免调用方修改共享状态）。
func (s *Server) knowledgeProgressSnapshot() map[string]any {
	s.knowledgeMu.Lock()
	defer s.knowledgeMu.Unlock()
	if s.knowledgeProgress == nil {
		s.knowledgeProgress = knowledgeProgressDefaults()
	}
	snapshot := map[string]any{}
	for key, value := range s.knowledgeProgress {
		snapshot[key] = value
	}
	tasks := []any{}
	if list, ok := s.knowledgeProgress["tasks"].([]any); ok {
		for _, item := range list {
			if task, ok := item.(map[string]any); ok {
				copied := map[string]any{}
				for key, value := range task {
					copied[key] = value
				}
				tasks = append(tasks, copied)
			}
		}
	}
	snapshot["tasks"] = tasks
	return snapshot
}

// updateKnowledgeProgress 合并进度字段并刷新 updatedAt（对齐 Node updateKnowledgeImportProgress）。
func (s *Server) updateKnowledgeProgress(patch map[string]any) {
	s.knowledgeMu.Lock()
	defer s.knowledgeMu.Unlock()
	if s.knowledgeProgress == nil {
		s.knowledgeProgress = knowledgeProgressDefaults()
	}
	for key, value := range patch {
		s.knowledgeProgress[key] = value
	}
	s.knowledgeProgress["updatedAt"] = time.Now().UnixMilli()
}

// knowledgeFirstTaskKey 取当前第一条任务的 taskKey（对齐 Node 的 tasks[0].taskKey 回退语义）。
func (s *Server) knowledgeFirstTaskKey() string {
	s.knowledgeMu.Lock()
	defer s.knowledgeMu.Unlock()
	if s.knowledgeProgress != nil {
		if tasks, ok := s.knowledgeProgress["tasks"].([]any); ok && len(tasks) > 0 {
			if task, ok := tasks[0].(map[string]any); ok {
				if key := textOf(task["taskKey"]); key != "" {
					return key
				}
			}
		}
	}
	return "knowledge-import-default"
}

// setKnowledgeImportTask 合并写入任务状态并重算总进度（对齐 Node setKnowledgeImportTask）。
func (s *Server) setKnowledgeImportTask(taskPatch map[string]any) {
	s.knowledgeMu.Lock()
	defer s.knowledgeMu.Unlock()
	if s.knowledgeProgress == nil {
		s.knowledgeProgress = knowledgeProgressDefaults()
	}
	taskKey := textOf(taskPatch["taskKey"])
	if taskKey == "" {
		taskKey = "knowledge-import-default"
	}
	tasks, _ := s.knowledgeProgress["tasks"].([]any)
	next := map[string]any{
		"progressPercent": 0,
		"running":         false,
		"stage":           "idle",
		"currentMessage":  "暂无任务状态",
	}
	for key, value := range taskPatch {
		next[key] = value
	}
	next["taskKey"] = taskKey
	updated := []any{}
	merged := false
	for _, item := range tasks {
		task, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if textOf(task["taskKey"]) == taskKey {
			combined := map[string]any{}
			for key, value := range task {
				combined[key] = value
			}
			for key, value := range next {
				combined[key] = value
			}
			combined["taskKey"] = taskKey
			updated = append(updated, combined)
			merged = true
			continue
		}
		updated = append(updated, task)
	}
	if !merged {
		updated = append(updated, next)
	}
	s.knowledgeProgress["tasks"] = updated
	total := 0.0
	for _, item := range updated {
		if task, ok := item.(map[string]any); ok {
			total += numberValue(task["progressPercent"])
		}
	}
	if len(updated) > 0 {
		s.knowledgeProgress["progressPercent"] = int(math.Round(total / float64(len(updated))))
	}
	s.knowledgeProgress["updatedAt"] = time.Now().UnixMilli()
}

// updateKnowledgeTaskAndProgress 同步更新顶层进度与当前任务（对齐 Node 每次成对调用的写法）。
func (s *Server) updateKnowledgeTaskAndProgress(fields map[string]any) {
	s.updateKnowledgeProgress(fields)
	task := map[string]any{}
	for key, value := range fields {
		task[key] = value
	}
	task["taskKey"] = s.knowledgeFirstTaskKey()
	s.setKnowledgeImportTask(task)
}

// numberValue 把 JSON 数值安全转成 float64。
func numberValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		converted, err := typed.Float64()
		if err != nil {
			return 0
		}
		return converted
	default:
		return 0
	}
}

// ---------- 文本切块（对齐 Node splitImportedNovelText） ----------

// jsLength 近似 JS 字符串 .length（UTF-16 码元数），用于对齐 Node 的切块阈值判断。
func jsLength(value string) int {
	return len(utf16.Encode([]rune(value)))
}

// sliceJS 按 UTF-16 码元切分（对齐 Node slice 语义；CJK 场景与按字符切分一致）。
func sliceJS(value string, start int, end int) string {
	units := utf16.Encode([]rune(value))
	if start < 0 {
		start = 0
	}
	if end > len(units) {
		end = len(units)
	}
	if start >= end {
		return ""
	}
	return string(utf16.Decode(units[start:end]))
}

// splitImportedNovelText 对齐 Node：段落聚合到 maxChunkLength，超长段落按句子回退切分。
func splitImportedNovelText(text string, maxChunkLength int) []string {
	normalized := strings.TrimSpace(strings.ReplaceAll(text, "\r\n", "\n"))
	if normalized == "" {
		return nil
	}
	limit := maxChunkLength
	if limit <= 0 {
		limit = 1200
	}
	if limit < 200 {
		limit = 200
	}
	if limit > 4000 {
		limit = 4000
	}
	paragraphs := []string{}
	for _, part := range splitParagraphs(normalized) {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			paragraphs = append(paragraphs, trimmed)
		}
	}
	if len(paragraphs) == 0 {
		paragraphs = []string{normalized}
	}
	chunks := []string{}
	current := ""
	flush := func() {
		if trimmed := strings.TrimSpace(current); trimmed != "" {
			chunks = append(chunks, trimmed)
		}
		current = ""
	}
	pushWithSentenceFallback := func(paragraph string) {
		sentences := splitSentences(paragraph)
		buffer := ""
		for _, sentence := range sentences {
			trimmed := strings.TrimSpace(sentence)
			if trimmed == "" {
				continue
			}
			candidate := trimmed
			if buffer != "" {
				candidate = buffer + trimmed
			}
			if jsLength(candidate) <= limit {
				buffer = candidate
				continue
			}
			if buffer != "" {
				if piece := strings.TrimSpace(buffer); piece != "" {
					chunks = append(chunks, piece)
				}
				buffer = ""
			}
			if jsLength(trimmed) <= limit {
				buffer = trimmed
				continue
			}
			for offset := 0; offset < jsLength(trimmed); offset += limit {
				if piece := strings.TrimSpace(sliceJS(trimmed, offset, offset+limit)); piece != "" {
					chunks = append(chunks, piece)
				}
			}
		}
		if trimmed := strings.TrimSpace(buffer); trimmed != "" {
			chunks = append(chunks, trimmed)
		}
	}
	for _, paragraph := range paragraphs {
		if jsLength(paragraph) > limit {
			flush()
			pushWithSentenceFallback(paragraph)
			continue
		}
		candidate := paragraph
		if current != "" {
			candidate = current + "\n\n" + paragraph
		}
		if jsLength(candidate) <= limit {
			current = candidate
			continue
		}
		flush()
		current = paragraph
	}
	flush()
	return chunks
}

// splitParagraphs 按 /\n{2,}/ 切段（对齐 Node split(/\n{2,}/)）。
func splitParagraphs(text string) []string {
	parts := []string{}
	current := strings.Builder{}
	newlines := 0
	for _, char := range text {
		if char == '\n' {
			newlines++
			continue
		}
		if newlines >= 2 {
			parts = append(parts, current.String())
			current.Reset()
		} else if newlines == 1 {
			current.WriteRune('\n')
		}
		newlines = 0
		current.WriteRune(char)
	}
	parts = append(parts, current.String())
	return parts
}

// splitSentences 对齐 Node /[^。！？!?\n]+[。！？!?]?/g 的句子切分。
func splitSentences(paragraph string) []string {
	sentences := []string{}
	current := strings.Builder{}
	for _, char := range paragraph {
		if char == '\n' {
			if current.Len() > 0 {
				sentences = append(sentences, current.String())
				current.Reset()
			}
			continue
		}
		current.WriteRune(char)
		if char == '。' || char == '！' || char == '？' || char == '!' || char == '?' {
			sentences = append(sentences, current.String())
			current.Reset()
		}
	}
	if current.Len() > 0 {
		sentences = append(sentences, current.String())
	}
	return sentences
}

// ---------- 模型提示词与解析（对齐 Node buildKnowledgeImportPrompt / parseKnowledgeImportAIResponse） ----------

// buildKnowledgeImportPrompt 构造提炼提示词（逐字对齐 Node 文案）。
func buildKnowledgeImportPrompt(title, chunk string, chunkIndex, totalChunks int, knowledgeType string) []ai.Message {
	if strings.TrimSpace(title) == "" {
		title = "小说导入"
	}
	normalizedType := "fixed"
	if knowledgeType == "dynamic" {
		normalizedType = "dynamic"
	}
	system := strings.Join([]string{
		"你是小说知识整理助手。",
		"任务是把原文片段提炼成适合写入知识库的结构化知识。",
		"严禁原样大段摘抄原文，输出必须是经过提炼后的知识。",
		"保留人物、身份、关系、事件、目标、设定、地点、规则、冲突、线索等高价值信息。",
		"输出严格 JSON，不要使用 Markdown 代码块，不要解释。",
		`JSON 格式: {"entries":[{"title":"知识标题","content":"提炼后的知识内容","tags":["标签1","标签2"]}] }`,
		"entries 最多 5 条；title 简洁明确；content 使用简体中文，写成可检索、可复用的知识描述。",
		fmt.Sprintf("knowledgeType 固定为 %s。", normalizedType),
	}, "\n")
	user := strings.Join([]string{
		fmt.Sprintf("知识库主题: %s", title),
		fmt.Sprintf("当前分块: %d/%d", chunkIndex+1, totalChunks),
		"请从下面片段中提炼知识：",
		chunk,
	}, "\n\n")
	return []ai.Message{{Role: "system", Content: system}, {Role: "user", Content: user}}
}

// knowledgeDraft 是一条提炼结果。
type knowledgeDraft struct {
	Title   string
	Content string
	Tags    []string
}

// stripJSONCodeFence 去掉模型输出外的 ```json 包裹（对齐 Node stripJsonCodeFence）。
func stripJSONCodeFence(text string) string {
	normalized := strings.TrimSpace(text)
	if !strings.HasPrefix(normalized, "```") {
		return normalized
	}
	normalized = strings.TrimSpace(normalized)
	normalized = strings.TrimPrefix(normalized, "```json")
	normalized = strings.TrimPrefix(normalized, "```")
	normalized = strings.TrimSuffix(strings.TrimSpace(normalized), "```")
	return strings.TrimSpace(normalized)
}

// parseKnowledgeImportAIResponse 解析模型输出（对齐 Node parseKnowledgeImportAIResponse）。
func parseKnowledgeImportAIResponse(text string) ([]knowledgeDraft, error) {
	normalized := stripJSONCodeFence(text)
	if normalized == "" {
		return nil, fmt.Errorf("AI 未返回可解析的知识内容")
	}
	var parsed any
	if err := json.Unmarshal([]byte(normalized), &parsed); err != nil {
		return nil, fmt.Errorf("AI 返回结果不是合法 JSON")
	}
	rawEntries := []any{}
	switch typed := parsed.(type) {
	case []any:
		rawEntries = typed
	case map[string]any:
		if list, ok := typed["entries"].([]any); ok {
			rawEntries = list
		}
	}
	entries := []knowledgeDraft{}
	for index, item := range rawEntries {
		if len(entries) >= 5 {
			break
		}
		entry, _ := item.(map[string]any)
		if entry == nil {
			continue
		}
		title := strings.TrimSpace(textOf(entry["title"]))
		if title == "" {
			title = fmt.Sprintf("提炼知识 %d", index+1)
		}
		content := firstText(
			strings.TrimSpace(textOf(entry["content"])),
			strings.TrimSpace(textOf(entry["summary"])),
			strings.TrimSpace(textOf(entry["description"])),
			strings.TrimSpace(textOf(entry["text"])),
		)
		if content == "" {
			continue
		}
		tags := []string{}
		if list, ok := entry["tags"].([]any); ok {
			for _, tag := range list {
				text := strings.TrimSpace(textOf(tag))
				if text == "" {
					continue
				}
				tags = append(tags, text)
				if len(tags) >= 8 {
					break
				}
			}
		}
		entries = append(entries, knowledgeDraft{Title: title, Content: content, Tags: tags})
	}
	if len(entries) == 0 {
		return nil, fmt.Errorf("AI 未提炼出有效知识条目")
	}
	return entries, nil
}

// ---------- 请求处理 ----------

// knowledgeImportPayload 对齐 Node normalizeKnowledgeImportPayload 的校验与默认值。
type knowledgeImportPayload struct {
	Text          string
	Title         string
	KnowledgeType string
	ChunkSize     int
	Tags          []string
	Metadata      map[string]any
}

func decodeKnowledgeImportPayload(body map[string]any) (knowledgeImportPayload, error) {
	text := ""
	if value, ok := body["text"].(string); ok {
		text = strings.TrimSpace(value)
	}
	if text == "" {
		return knowledgeImportPayload{}, fmt.Errorf("导入文本不能为空")
	}
	title := firstText(strings.TrimSpace(textOf(body["title"])), "小说导入")
	knowledgeType := "fixed"
	if strings.TrimSpace(textOf(body["knowledgeType"])) == "dynamic" {
		knowledgeType = "dynamic"
	}
	metadata := map[string]any{}
	if raw, ok := body["metadata"].(map[string]any); ok {
		for key, value := range raw {
			metadata[key] = value
		}
	}
	chunkSize := 1200
	if value, ok := body["chunkSize"].(float64); ok && !math.IsNaN(value) {
		chunkSize = int(math.Floor(value))
		if chunkSize < 200 {
			chunkSize = 200
		}
		if chunkSize > 4000 {
			chunkSize = 4000
		}
	}
	tags := []string{}
	if list, ok := body["tags"].([]any); ok {
		for _, item := range list {
			text := strings.TrimSpace(textOf(item))
			if text != "" {
				tags = append(tags, text)
			}
		}
	}
	metadata["note"] = firstText(strings.TrimSpace(textOf(body["note"])), strings.TrimSpace(textOf(metadata["note"])))
	metadata["updatedBy"] = firstText(strings.TrimSpace(textOf(body["updatedBy"])), strings.TrimSpace(textOf(metadata["updatedBy"])), "admin-panel")
	metadata["source"] = firstText(strings.TrimSpace(textOf(body["source"])), strings.TrimSpace(textOf(metadata["source"])), "novel-import")
	metadata["importTitle"] = title
	metadata["knowledgeType"] = knowledgeType
	return knowledgeImportPayload{
		Text: text, Title: title, KnowledgeType: knowledgeType,
		ChunkSize: chunkSize, Tags: tags, Metadata: metadata,
	}, nil
}

// handleKnowledgeImportAI 对齐 Node POST /api/memory/knowledge/import：
// 切块 → 逐段 AI 提炼 → 写入知识库，并同步 knowledgeImportProgress。
func (s *Server) handleKnowledgeImportAI(writer http.ResponseWriter, request *http.Request) {
	fail := func(status int, message string) {
		s.updateKnowledgeProgress(map[string]any{
			"running":         false,
			"stage":           "failed",
			"currentMessage":  "知识导入失败: " + message,
			"progressPercent": 100,
			"lastCompletedAt": time.Now().UnixMilli(),
			"lastFailureAt":   time.Now().UnixMilli(),
			"lastError":       message,
			"lastResult":      map[string]any{"status": "failed", "reason": message},
		})
		s.setKnowledgeImportTask(map[string]any{
			"taskKey":         s.knowledgeFirstTaskKey(),
			"running":         false,
			"stage":           "failed",
			"currentMessage":  "知识导入失败: " + message,
			"progressPercent": 100,
			"lastCompletedAt": time.Now().UnixMilli(),
			"lastFailureAt":   time.Now().UnixMilli(),
			"lastError":       message,
			"lastResult":      map[string]any{"status": "failed", "reason": message},
		})
		s.logger.Printf("导入小说知识失败: %s", message)
		writeJSON(writer, status, map[string]any{"success": false, "error": message})
	}

	body := decodeBody(request)
	payload, err := decodeKnowledgeImportPayload(body)
	if err != nil {
		fail(http.StatusBadRequest, err.Error())
		return
	}
	scopeOptions := s.variableScope(body)
	scope := map[string]any{
		"scopeType":     scopeOptions.ScopeType,
		"scopeKey":      scopeOptions.ScopeKey,
		"characterName": scopeOptions.CharacterName,
		"presetName":    scopeOptions.PresetName,
	}
	now := time.Now().UnixMilli()
	taskKey := strings.Join([]string{
		firstText(payload.Title, "untitled"), scopeOptions.ScopeType, scopeOptions.ScopeKey,
		scopeOptions.CharacterName, scopeOptions.PresetName,
	}, "|")
	s.updateKnowledgeProgress(map[string]any{
		"running": true, "stage": "queued", "triggeredBy": "admin_panel",
		"title": payload.Title, "knowledgeType": payload.KnowledgeType,
		"scopeType": scopeOptions.ScopeType, "scopeKey": scopeOptions.ScopeKey,
		"characterName": scopeOptions.CharacterName, "presetName": scopeOptions.PresetName,
		"totalChunks": 0, "processedChunks": 0, "savedCount": 0, "currentChunk": 0,
		"currentMessage": "任务已入队，准备切块", "progressPercent": 4,
		"lastQueuedAt": now, "lastStartedAt": now, "lastCompletedAt": nil,
		"lastError": nil, "lastResult": nil,
	})
	s.setKnowledgeImportTask(map[string]any{
		"taskKey": taskKey, "running": true, "stage": "queued", "triggeredBy": "admin_panel",
		"title": payload.Title, "knowledgeType": payload.KnowledgeType,
		"scopeType": scopeOptions.ScopeType, "scopeKey": scopeOptions.ScopeKey,
		"characterName": scopeOptions.CharacterName, "presetName": scopeOptions.PresetName,
		"totalChunks": 0, "processedChunks": 0, "savedCount": 0, "currentChunk": 0,
		"currentMessage": "任务已入队，准备切块", "progressPercent": 4,
		"lastQueuedAt": now, "lastStartedAt": now, "lastCompletedAt": nil,
		"lastError": nil,
	})

	chunks := splitImportedNovelText(payload.Text, payload.ChunkSize)
	if len(chunks) == 0 {
		fail(http.StatusBadRequest, "导入文本不能为空")
		return
	}

	client := s.buildRangeAIClient("", "")
	if client == nil {
		fail(http.StatusInternalServerError, "AI 客户端不可用，无法执行知识提炼")
		return
	}

	database, _, err := s.openActiveMemory()
	if err != nil {
		fail(http.StatusInternalServerError, err.Error())
		return
	}
	defer database.Close()

	s.updateKnowledgeTaskAndProgress(map[string]any{
		"running": true, "stage": "splitting", "totalChunks": len(chunks),
		"processedChunks": 0, "savedCount": 0,
		"currentMessage":  fmt.Sprintf("已切分 %d 段，准备逐段提炼知识", len(chunks)),
		"progressPercent": 10,
	})

	importedItems := []map[string]any{}
	savedCount := 0
	for index, chunk := range chunks {
		percent := int(math.Max(20, math.Min(78, math.Round((float64(index)+0.2)/float64(len(chunks))*100))))
		s.updateKnowledgeTaskAndProgress(map[string]any{
			"stage": "generating", "totalChunks": len(chunks),
			"processedChunks": index, "savedCount": savedCount, "currentChunk": index + 1,
			"currentMessage":  fmt.Sprintf("正在提炼第 %d/%d 段知识", index+1, len(chunks)),
			"progressPercent": percent,
		})
		messages := buildKnowledgeImportPrompt(payload.Title, chunk, index, len(chunks), payload.KnowledgeType)
		ctx, cancel := contextWithTimeout(time.Duration(s.document.Int("ai.timeout", 120)) * time.Second)
		completion, err := client.Chat(ctx, messages, nil)
		cancel()
		if err != nil {
			fail(http.StatusInternalServerError, "连接 AI 服务失败: "+err.Error())
			return
		}
		drafts, err := parseKnowledgeImportAIResponse(completion.Content)
		if err != nil {
			fail(http.StatusInternalServerError, err.Error())
			return
		}

		savePercent := int(math.Max(24, math.Min(88, math.Round((float64(index)+0.65)/float64(len(chunks))*100))))
		s.updateKnowledgeTaskAndProgress(map[string]any{
			"stage": "saving", "totalChunks": len(chunks),
			"processedChunks": index, "savedCount": savedCount, "currentChunk": index + 1,
			"currentMessage":  fmt.Sprintf("正在保存第 %d/%d 段提炼结果", index+1, len(chunks)),
			"progressPercent": savePercent,
		})

		for entryIndex, draft := range drafts {
			metadata := map[string]any{}
			for key, value := range payload.Metadata {
				metadata[key] = value
			}
			metadata["chunkIndex"] = index
			metadata["chunkNumber"] = index + 1
			metadata["chunkCount"] = len(chunks)
			metadata["chunkSize"] = payload.ChunkSize
			metadata["generatedEntryIndex"] = entryIndex
			metadata["generatedEntryCount"] = len(drafts)
			metadata["source"] = "novel-import-llm"
			metadata["importMode"] = "llm-structured"
			metadata["originalTitle"] = payload.Title
			title := draft.Title
			if len(drafts) > 1 {
				title = fmt.Sprintf("%s · 第%d条", draft.Title, entryIndex+1)
			}
			tags := append([]string{}, payload.Tags...)
			tags = append(tags, draft.Tags...)
			record := store.KnowledgeEntry{
				Title: title, Content: draft.Content,
				KnowledgeType: payload.KnowledgeType,
				Tags:          dedupeStrings(tags),
				Metadata:      metadata,
			}
			entryID, err := database.UpsertKnowledgeEntry(scopeOptions, record)
			if err != nil {
				continue
			}
			if saved, err := database.GetKnowledgeEntry(entryID); err == nil && saved != nil {
				encoded, _ := json.Marshal(saved)
				item := map[string]any{}
				if err := json.Unmarshal(encoded, &item); err == nil {
					importedItems = append(importedItems, item)
					savedCount++
				}
			}
		}

		stage := "generating"
		if index == len(chunks)-1 {
			stage = "saving"
		}
		percent = int(math.Max(30, math.Min(92, math.Round(float64(index+1)/float64(len(chunks))*100))))
		s.updateKnowledgeTaskAndProgress(map[string]any{
			"stage": stage, "totalChunks": len(chunks),
			"processedChunks": index + 1, "savedCount": savedCount, "currentChunk": index + 1,
			"currentMessage":  fmt.Sprintf("已完成第 %d/%d 段，累计保存 %d 条知识", index+1, len(chunks), savedCount),
			"progressPercent": percent,
		})
	}

	completedAt := time.Now().UnixMilli()
	result := map[string]any{"status": "success", "importedCount": savedCount, "chunkCount": len(chunks)}
	s.updateKnowledgeProgress(map[string]any{
		"running": false, "stage": "completed", "totalChunks": len(chunks),
		"processedChunks": len(chunks), "savedCount": savedCount, "currentChunk": len(chunks),
		"currentMessage":  fmt.Sprintf("知识导入完成，共保存 %d 条知识", savedCount),
		"progressPercent": 100, "lastCompletedAt": completedAt, "lastSuccessAt": completedAt,
		"lastError": nil, "lastResult": result,
	})
	s.setKnowledgeImportTask(map[string]any{
		"taskKey": s.knowledgeFirstTaskKey(), "running": false, "stage": "completed",
		"totalChunks": len(chunks), "processedChunks": len(chunks), "savedCount": savedCount,
		"currentChunk":    len(chunks),
		"currentMessage":  fmt.Sprintf("知识导入完成，共保存 %d 条知识", savedCount),
		"progressPercent": 100, "lastCompletedAt": completedAt, "lastSuccessAt": completedAt,
		"lastError": nil, "lastResult": result,
	})
	s.metrics.Record(metrics.KnowledgeImport, 1)
	// 仪表盘分桶：知识导入事件（对齐 Node routes.js recordDashboardMetric('knowledgeImport')）
	s.logger.Printf("小说导入完成: title=%s chunkCount=%d importedCount=%d", payload.Title, len(chunks), len(importedItems))

	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "message": fmt.Sprintf("已导入 %d 条知识", len(importedItems)),
		"importedCount": len(importedItems), "chunkCount": len(chunks),
		"knowledgeType": payload.KnowledgeType, "scope": scope, "items": importedItems,
	})
}

// dedupeStrings 去重并保持顺序（对齐 Node Array.from(new Set(...))）。
func dedupeStrings(items []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, item := range items {
		if seen[item] {
			continue
		}
		seen[item] = true
		result = append(result, item)
	}
	return result
}
