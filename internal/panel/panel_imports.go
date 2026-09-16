package panel

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/characters"
	"mimirlink/internal/chat"
)

// 本文件补齐 goal-36 审计发现的剩余 Node 契约对齐：
//   - POST /api/preset/import：返回 preset/diagnostics/importRecord 等（前端导入弹窗依赖）
//   - DELETE /api/preset/imports/:id 与 POST /api/preset/imports/batch-delete：导入记录结构
//   - POST /api/preset/train|tune：真实 AI 训练/优化（移植 src/prompt-trainer.js 与路由逻辑）
//   - POST /api/memory/knowledge/import：支持 Node 的「文本分块导入」契约
//   - POST /api/worldbooks/extract-from-character：支持 Node 的 { filename } 契约
// ---------- 导入记录共用工具（对齐 Node routes.js 的 stableStringify / 记录 ID 语义） ----------

// importRecordID 生成导入记录 ID（对齐 Node `${type}-${Date.now()}-${random6}`）。
func importRecordID(kind string) string {
	const charset = "abcdefghijklmnopqrstuvwxyz0123456789"
	random := make([]byte, 6)
	for index := range random {
		random[index] = charset[rand.Intn(len(charset))]
	}
	return fmt.Sprintf("%s-%d-%s", kind, time.Now().UnixMilli(), string(random))
}

// stableJSON 键排序递归序列化（对齐 Node stableStringify，用于快照等价比较与规则去重）。
func stableJSON(value any) string {
	switch typed := value.(type) {
	case nil:
		return "null"
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, stableJSON(item))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case map[string]any:
		keys := make([]string, 0, len(typed))
		for key := range typed {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		parts := make([]string, 0, len(keys))
		for _, key := range keys {
			encodedKey, _ := json.Marshal(key)
			parts = append(parts, string(encodedKey)+":"+stableJSON(typed[key]))
		}
		return "{" + strings.Join(parts, ",") + "}"
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return "null"
		}
		return string(encoded)
	}
}

// snapshotsEqual 对齐 Node areSnapshotsEqual。
func snapshotsEqual(left, right any) bool { return stableJSON(left) == stableJSON(right) }

// cloneSnapshot JSON 往返克隆（对齐 Node cloneImportSnapshot）。
func cloneSnapshot(value any) any {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil
	}
	var cloned any
	if err := json.Unmarshal(encoded, &cloned); err != nil {
		return nil
	}
	return cloned
}

// removeMatchingRulesBySnapshot 移除与导入快照完全相同的规则，返回移除数量（对齐 Node removeMatchingRules）。
func removeMatchingRulesBySnapshot(targetRules []any, importedRules []any) int {
	if len(targetRules) == 0 || len(importedRules) == 0 {
		return 0
	}
	signatures := map[string]bool{}
	for _, rule := range importedRules {
		signatures[stableJSON(rule)] = true
	}
	kept := []any{}
	for _, rule := range targetRules {
		if signatures[stableJSON(rule)] {
			continue
		}
		kept = append(kept, rule)
	}
	removed := len(targetRules) - len(kept)
	copy(targetRules, kept)
	return removed
}

// removePresetImportDiskFile 删除磁盘上的导入记录文件（对齐 Node deletePresetImportDiskFile：presets/<id>.json）。
func (s *Server) removePresetImportDiskFile(recordID string) {
	normalized := strings.TrimSpace(recordID)
	if normalized == "" || strings.ContainsAny(normalized, "/\\") {
		return
	}
	presetsDir := filepath.Join(s.dataDir, "presets")
	target := filepath.Join(presetsDir, normalized+".json")
	if !strings.HasPrefix(target, presetsDir+string(os.PathSeparator)) {
		return
	}
	_ = os.Remove(target)
}

// presetImportRecord 是一条预设导入记录（对齐 Node config.imports.presetFiles 记录形状）。
type presetImportRecord struct {
	ID             string         `json:"id"`
	Type           string         `json:"type"`
	Filename       string         `json:"filename"`
	PresetName     string         `json:"presetName"`
	CreatedAt      string         `json:"createdAt"`
	ImportedFields []string       `json:"importedFields"`
	PreviousPreset map[string]any `json:"previousPreset"`
}

// presetImportRecords 读取预设导入记录。
func (s *Server) presetImportRecords() []map[string]any {
	raw := s.document.Get("imports.presetFiles")
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

// presetImportSummaries 返回预设导入记录摘要（前端 /api/regex?summary=1 等场景使用）。
func (s *Server) presetImportSummaries() []map[string]any {
	summaries := []map[string]any{}
	for _, record := range s.presetImportRecords() {
		fields, _ := record["importedFields"].([]any)
		summaries = append(summaries, map[string]any{
			"id": record["id"], "type": orDefault(textOf(record["type"]), "preset"),
			"filename": record["filename"], "presetName": record["presetName"],
			"createdAt": record["createdAt"], "importedFields": fields,
			"importedFieldCount": len(fields),
		})
	}
	return summaries
}

// stripPresetToPrompts 对齐 Node stripPresetToPrompts（只保留 prompts 数组及必要字段）。
func stripPresetToPrompts(imported map[string]any) map[string]any {
	rawPrompts, _ := imported["prompts"].([]any)
	if rawPrompts == nil {
		return imported
	}
	cleaned := []any{}
	for _, item := range rawPrompts {
		prompt, _ := item.(map[string]any)
		if prompt == nil {
			continue
		}
		cleaned = append(cleaned, map[string]any{
			"identifier":         firstText(textOf(prompt["identifier"]), ""),
			"name":               firstText(textOf(prompt["name"]), ""),
			"content":            textOr(prompt["content"], ""),
			"enabled":            prompt["enabled"] != false,
			"role":               orDefault(textOf(prompt["role"]), "system"),
			"injection_position": intOr(prompt["injection_position"], 0),
			"injection_depth":    intOr(prompt["injection_depth"], 0),
			"system_prompt":      prompt["system_prompt"] == true,
			"marker":             prompt["marker"] == true,
			"forbid_overrides":   prompt["forbid_overrides"] == true,
		})
	}
	result := map[string]any{}
	for key, value := range imported {
		result[key] = value
	}
	result["prompts"] = cleaned
	return result
}

// handlePresetImportFull 是 /api/preset/import 的完整实现（对齐 Node：记录字段/关联正则/磁盘文件）。
func (s *Server) handlePresetImportFull(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	preset := stripPresetToPrompts(body)
	delete(preset, "sourceFilename")
	presetName := textOf(body["name"])
	sourceFilename := firstText(textOf(body["sourceFilename"]), presetName, fmt.Sprintf("preset-%d.json", time.Now().UnixMilli()))

	previous := map[string]any{}
	if raw := s.document.Get("preset"); raw.Exists() {
		_ = json.Unmarshal([]byte(raw.Raw), &previous)
	}
	// importedFields 对齐 Node：Object.keys(preset).filter(key => preset[key] !== '' && preset[key] !== false)
	importedFields := []string{}
	for key, value := range preset {
		switch typed := value.(type) {
		case string:
			if typed == "" {
				continue
			}
		case bool:
			if !typed {
				continue
			}
		}
		importedFields = append(importedFields, key)
	}
	sort.Strings(importedFields)

	// 关联正则（角色卡/预设附带的 regex_scripts / regexRules）
	importedRules := chat.NormalizeImportedRules(body)
	originalRules := chat.NormalizeImportedRules(map[string]any{"rules": previous["regexRules"]})
	recordID := importRecordID("preset")

	// 关联正则独立记录（Node：linkedRegexImportRecord，目标层 preset）
	linkedRegexID := ""
	if len(importedRules) > 0 {
		linkedRegexID = importRecordID("regex")
		linked := map[string]any{
			"id": linkedRegexID, "type": "regex", "sourceType": "preset",
			"presetImportId": recordID,
			"filename":       sourceFilename + " / 预设关联正则",
			"targetLayer":    "preset",
			"createdAt":      time.Now().UTC().Format(time.RFC3339),
			"importedRules":  toAnyList(importedRules),
			"previousRules":  cloneSnapshot(previous["regexRules"]),
		}
		regexRecords := s.regexImportRecords()
		regexRecords = append([]map[string]any{linked}, regexRecords...)
		_ = s.document.Set("imports.regexFiles", toAnyList(regexRecords))
	}

	merged := map[string]any{}
	for key, value := range previous {
		merged[key] = value
	}
	for key, value := range preset {
		merged[key] = value
	}
	merged["regexRules"] = toAnyList(importedRules) // Node 语义：总是覆盖（即使为空）
	if err := s.document.Set("preset", merged); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}

	// previousPreset 只保留 importedFields 对应键（对齐 Node Object.fromEntries(importedFields.map(...))）
	previousSnapshot := map[string]any{}
	for _, key := range importedFields {
		previousSnapshot[key] = cloneSnapshot(previous[key])
	}
	record := map[string]any{
		"id": recordID, "type": "preset",
		"filename": sourceFilename, "presetName": nilIfEmpty(presetName),
		"createdAt":           time.Now().UTC().Format(time.RFC3339),
		"importedFields":      importedFields,
		"importedPreset":      cloneSnapshot(preset),
		"importedRegexRules":  toAnyList(importedRules),
		"linkedRegexImportId": nilIfEmpty(linkedRegexID),
		"previousRegexRules":  cloneSnapshot(previous["regexRules"]),
		"previousPreset":      previousSnapshot,
	}
	records := s.presetImportRecords()
	records = append([]map[string]any{record}, records...)
	_ = s.document.Set("imports.presetFiles", toAnyList(records))

	// 落盘导入记录文件（Node：presets/<recordId>.json，备份分类直接拍）
	if err := os.MkdirAll(filepath.Join(s.dataDir, "presets"), 0o755); err == nil {
		encoded, _ := json.MarshalIndent(record, "", "  ")
		_ = os.WriteFile(filepath.Join(s.dataDir, "presets", recordID+".json"), encoded, 0o644)
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}

	prompts, _ := preset["prompts"].([]any)
	message := "预设已导入"
	if len(importedRules) > 0 {
		message = fmt.Sprintf("预设已导入，并同步导入 %d 条正则", len(importedRules))
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true,
		"preset":  merged,
		"diagnostics": map[string]any{
			"promptCount": len(prompts), "importedFields": importedFields,
		},
		"regexDiagnostics": map[string]any{
			"recognized": len(importedRules), "previous": len(originalRules),
		},
		"importedRegexCount": len(importedRules),
		"importedFields":     importedFields,
		"importRecord":       summarizePresetRecord(record),
		"message":            message,
	})
}

// deleteTrackedPresetImport 删除一条预设导入记录并回退其影响（对齐 Node deleteTrackedPresetImport）。
func (s *Server) deleteTrackedPresetImport(recordID string) (found bool, removedCount int, restoredFields []string, record map[string]any) {
	records := s.presetImportRecords()
	index := -1
	for position, item := range records {
		if textOf(item["id"]) == recordID {
			index = position
			break
		}
	}
	if index < 0 {
		return false, 0, nil, nil
	}
	record = records[index]
	remaining := append(append([]map[string]any{}, records[:index]...), records[index+1:]...)
	_ = s.document.Set("imports.presetFiles", toAnyList(remaining))

	// 关联正则记录随之删除（Node：record.linkedRegexImportId）
	if linkedID := textOf(record["linkedRegexImportId"]); linkedID != "" {
		kept := []map[string]any{}
		for _, item := range s.regexImportRecords() {
			if textOf(item["id"]) != linkedID {
				kept = append(kept, item)
			}
		}
		_ = s.document.Set("imports.regexFiles", toAnyList(kept))
	}

	// 磁盘预设记录（非导入应用内容）直接移除，不回退 preset
	if textOf(record["sourceType"]) == "disk-preset" || record["fileBackedOnly"] == true {
		return true, 0, []string{}, record
	}

	current := map[string]any{}
	if raw := s.document.Get("preset"); raw.Exists() {
		_ = json.Unmarshal([]byte(raw.Raw), &current)
	}
	importedPreset, _ := record["importedPreset"].(map[string]any)
	previousPreset, _ := record["previousPreset"].(map[string]any)
	restoredFields = []string{}
	for key := range importedPreset {
		if key == "regexRules" {
			continue // 对齐 Node getPresetFieldsFromSnapshot
		}
		// 仅当当前值仍等于导入值时才回退（避免覆盖用户后续修改）
		if !snapshotsEqual(current[key], importedPreset[key]) {
			continue
		}
		if previousValue, ok := previousPreset[key]; ok && previousValue != nil {
			current[key] = cloneSnapshot(previousValue)
		} else {
			delete(current, key)
		}
		restoredFields = append(restoredFields, key)
	}
	sort.Strings(restoredFields)

	currentRules, _ := current["regexRules"].([]any)
	importedRules, _ := record["importedRegexRules"].([]any)
	previousRules, hasPrevious := record["previousRegexRules"]
	if snapshotsEqual(currentRules, importedRules) {
		removedCount = len(importedRules)
		if hasPrevious && previousRules != nil {
			current["regexRules"] = cloneSnapshot(previousRules)
		} else {
			delete(current, "regexRules")
		}
	} else {
		removedCount = removeMatchingRulesBySnapshot(currentRules, importedRules)
		current["regexRules"] = currentRules
	}
	_ = s.document.Set("preset", current)
	return true, removedCount, restoredFields, record
}

// handlePresetImportDeleteFull 删除单条预设导入记录（对齐 Node DELETE /api/preset/imports/:id）。
func (s *Server) handlePresetImportDeleteFull(writer http.ResponseWriter, rest string) {
	found, removedCount, restoredFields, _ := s.deleteTrackedPresetImport(rest)
	if !found {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "导入记录不存在"})
		return
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	s.removePresetImportDiskFile(rest)
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "removedCount": removedCount, "restoredFields": restoredFields,
		"message": fmt.Sprintf("已删除预设导入文件，并恢复 %d 个字段，移除 %d 条关联正则", len(restoredFields), removedCount),
	})
}

// handlePresetImportBatchDelete 批量删除预设导入记录（对齐 Node POST /api/preset/imports/batch-delete）。
func (s *Server) handlePresetImportBatchDelete(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	items, _ := body["ids"].([]any)
	ids := []string{}
	seen := map[string]bool{}
	for _, item := range items {
		id := textOf(item)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if len(ids) == 0 {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供要删除的预设导入记录 ID"})
		return
	}
	deletedIDs := []string{}
	notFoundIDs := []string{}
	failed := []map[string]any{}
	removedCount := 0
	restoredFields := []string{}
	restoredSeen := map[string]bool{}
	for _, id := range ids {
		found, removed, restored, _ := s.deleteTrackedPresetImport(id)
		if !found {
			notFoundIDs = append(notFoundIDs, id)
			continue
		}
		deletedIDs = append(deletedIDs, id)
		removedCount += removed
		for _, field := range restored {
			if !restoredSeen[field] {
				restoredSeen[field] = true
				restoredFields = append(restoredFields, field)
			}
		}
		s.removePresetImportDiskFile(id)
	}
	if err := s.document.Save(); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": len(failed) == 0, "deletedIds": deletedIDs, "notFoundIds": notFoundIDs,
		"failed": failed, "removedCount": removedCount, "restoredFields": restoredFields,
		"message": fmt.Sprintf("已删除 %d 个预设导入文件", len(deletedIDs)),
	})
}

// ---------------- 提示词训练 / 调优 ----------------

// trainingProfile 是训练用的角色画像（对齐 Node buildCharacterProfile）。
type trainingProfile struct {
	Name        string
	Description string
	Personality string
	Scenario    string
	FirstMes    string
	Examples    string
}

func (s *Server) trainingProfile() trainingProfile {
	name := s.currentCharacterName()
	card, err := characters.Read(s.dataDir, name)
	if err != nil {
		return trainingProfile{Name: name}
	}
	return trainingProfile{
		Name:        firstText(textOf(card["name"]), name),
		Description: textOf(card["description"]),
		Personality: textOf(card["personality"]),
		Scenario:    textOf(card["scenario"]),
		FirstMes:    textOf(card["first_mes"]),
		Examples:    textOf(card["mes_example"]),
	}
}

// trainingHistory 读取最近聊天记录（对齐 Node loadChatHistory）。
func (s *Server) trainingHistory(limit int) []ai.Message {
	database, _, err := s.openActiveMemory()
	if err != nil {
		return nil
	}
	defer database.Close()
	messages, err := database.RecentMessagesThread("global_shared_memory", limit)
	if err != nil || len(messages) == 0 {
		sessions, _ := database.ListSessions(1)
		for _, session := range sessions {
			items, err := database.RecentMessagesThread(session.ID, limit)
			if err == nil && len(items) > 0 {
				messages = items
				break
			}
		}
	}
	result := []ai.Message{}
	for _, message := range messages {
		if len([]rune(message.Content)) <= 10 {
			continue
		}
		role := message.Role
		if role != "user" && role != "assistant" {
			role = "user"
		}
		result = append(result, ai.Message{Role: role, Content: message.Content})
	}
	return result
}

// runPromptTraining 移植 Node prompt-trainer.runPromptTraining。
func (s *Server) runPromptTraining(rounds int) map[string]any {
	if rounds < 1 {
		rounds = 10
	}
	if rounds > 50 {
		rounds = 50
	}
	profile := s.trainingProfile()
	history := s.trainingHistory(100)
	if len(history) == 0 {
		return map[string]any{"success": false, "error": "没有可用的聊天记录进行训练"}
	}
	client := s.buildRangeAIClient("", "")
	if client == nil {
		return map[string]any{"success": false, "error": "无法构建 AI 客户端，请检查 ai.providers 配置"}
	}
	systemPrompt := buildTrainingSystemPrompt(profile)
	results := []map[string]any{}
	scores := []float64{}
	topFixes := []string{}
	issueFrequency := map[string]int{}

	for round := 1; round <= rounds; round++ {
		sample, sampleStart := sampleTrainingRange(history)
		analysis, err := s.analyzeRound(client, systemPrompt, profile, sample)
		if err != nil {
			continue
		}
		score, _ := analysis["score"].(float64)
		issues := []any{}
		if list, ok := analysis["issues"].([]any); ok {
			issues = list
		}
		fixPrompt := textOf(analysis["fixPrompt"])
		results = append(results, map[string]any{
			"round": round, "score": score, "issues": issues, "fixPrompt": fixPrompt,
			"sampleRange": fmt.Sprintf("%d-%d", sampleStart, sampleStart+len(sample)),
		})
		if score > 0 {
			scores = append(scores, score)
		}
		for _, item := range issues {
			text := textOf(item)
			if text != "" {
				key := text
				if len([]rune(key)) > 80 {
					key = string([]rune(key)[:80])
				}
				issueFrequency[key]++
			}
		}
		if score < 80 && len([]rune(fixPrompt)) > 20 {
			topFixes = append(topFixes, fixPrompt)
		}
	}
	average := 0.0
	if len(scores) > 0 {
		total := 0.0
		for _, score := range scores {
			total += score
		}
		average = total / float64(len(scores))
	}
	type issueCount struct {
		Issue string
		Count int
	}
	ranked := []issueCount{}
	for issue, count := range issueFrequency {
		ranked = append(ranked, issueCount{Issue: issue, Count: count})
	}
	for left := 0; left < len(ranked); left++ {
		for right := left + 1; right < len(ranked); right++ {
			if ranked[right].Count > ranked[left].Count {
				ranked[left], ranked[right] = ranked[right], ranked[left]
			}
		}
	}
	topIssues := []map[string]any{}
	for index, item := range ranked {
		if index >= 10 {
			break
		}
		topIssues = append(topIssues, map[string]any{"issue": item.Issue, "count": item.Count})
	}
	if len(topFixes) > 5 {
		topFixes = topFixes[:5]
	}
	detailed := results
	if len(detailed) > 20 {
		detailed = detailed[len(detailed)-20:]
	}
	return map[string]any{
		"success": true,
		"profile": map[string]any{"name": profile.Name, "description": truncateRunes(profile.Description, 300)},
		"rounds":  rounds, "completedRounds": len(scores),
		"averageScore":     fmt.Sprintf("%.1f", average),
		"topIssues":        topIssues,
		"recommendedFixes": topFixes,
		"detailedResults":  detailed,
	}
}

// sampleTrainingRange 随机采样 6-12 条消息作为一轮训练样本，并返回起始下标
// （对齐 Node prompt-trainer：sampleSize = 6 + floor(random*7)，随机起点）。
func sampleTrainingRange(history []ai.Message) ([]ai.Message, int) {
	if len(history) == 0 {
		return history, 0
	}
	size := 6 + rand.Intn(7)
	if len(history) <= size {
		return history, 0
	}
	start := rand.Intn(len(history) - size + 1)
	end := start + size
	if end > len(history) {
		end = len(history)
	}
	return history[start:end], start
}

func buildTrainingSystemPrompt(profile trainingProfile) string {
	return fmt.Sprintf(`你是一位世界级的角色扮演 AI 提示词工程专家。你的专长是分析和优化系统提示词（system prompt），让 AI 在角色扮演中做到极致的人设还原。

## 你的分析框架

你会从以下维度评估 AI 的回复是否符合角色人设：

1. **语气一致性** — 用词、句式、口头禅是否和角色设定一致
2. **行为逻辑** — 角色的动机、反应、决策是否符合其性格和背景
3. **知识边界** — 角色是否说了不该知道的事，或没提该知道的事
4. **情感层次** — 情感的强度、转变、细腻程度是否到位
5. **对话风格** — 话多话少、主动被动、攻击性/温和性等
6. **避免模板化** — 是否出现了"八股文"式的统一回复结构

## 当前角色设定

**角色名**：%s
**描述**：%s
**性格**：%s
**场景**：%s
**开场白**：%s
**对话范例**：%s`,
		profile.Name,
		truncateRunes(profile.Description, 800),
		truncateRunes(profile.Personality, 500),
		truncateRunes(profile.Scenario, 300),
		truncateRunes(profile.FirstMes, 300),
		truncateRunes(profile.Examples, 500),
	)
}

func (s *Server) analyzeRound(client *ai.Client, systemPrompt string, profile trainingProfile, sample []ai.Message) (map[string]any, error) {
	if len(sample) == 0 {
		return nil, fmt.Errorf("样本为空")
	}
	lines := []string{"## 对话样本"}
	for _, message := range sample {
		role := "用户"
		if message.Role == "assistant" {
			role = "AI"
		}
		lines = append(lines, fmt.Sprintf("%s: %s", role, truncateRunes(stringValueOf(message.Content), 400)))
	}
	userPrompt := fmt.Sprintf(`%s

## 任务

分析以上 AI 回复在多大程度上符合角色"%s"的人设。从以下角度逐条评价：

1. 语气是否贴合角色？哪里不像？
2. 行为和角色设定矛盾吗？
3. 有没有模板化的痕迹（固定句式、过度格式化）？
4. 情感表达是否符合角色性格？

然后**输出一个 JSON 对象**，包含：
- score: 人设符合度评分（0-100）
- issues: 发现的具体问题（数组，每项一句话）
- fixPrompt: 如果要修改当前提示词来修复这些问题，新的提示词内容应该是什么

只输出 JSON：{"score":75,"issues":["问题1","问题2"],"fixPrompt":"修改后的完整提示词文本"}`,
		strings.Join(lines, "\n"), profile.Name)
	ctx, cancel := contextWithTimeout(60 * time.Second)
	defer cancel()
	completion, err := client.Chat(ctx, []ai.Message{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: userPrompt},
	}, nil)
	if err != nil {
		return nil, err
	}
	parsed := parseJSONObject(completion.Content)
	if len(parsed) == 0 {
		return map[string]any{"score": float64(0), "issues": []any{"无法解析分析结果"}, "fixPrompt": ""}, nil
	}
	return parsed, nil
}

// handlePresetTrainFull 执行训练（对齐 Node POST /api/preset/train）。
func (s *Server) handlePresetTrainFull(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	rounds := intOr(body["rounds"], 10)
	result := s.runPromptTraining(rounds)
	writeJSON(writer, http.StatusOK, result)
}

// handlePresetTune 执行单轮提示词优化（对齐 Node POST /api/preset/tune）。
func (s *Server) handlePresetTune(writer http.ResponseWriter, request *http.Request) {
	profile := s.trainingProfile()
	history := s.trainingHistory(20)
	samples := []string{}
	for index, message := range history {
		if message.Role != "assistant" || len([]rune(stringValueOf(message.Content))) <= 20 {
			continue
		}
		if index >= 5 {
			break
		}
		samples = append(samples, fmt.Sprintf("[第%d条] %s", len(samples)+1, truncateRunes(stringValueOf(message.Content), 600)))
	}
	prompts := []any{}
	if raw := s.document.Get("preset.prompts"); raw.Exists() {
		_ = json.Unmarshal([]byte(raw.Raw), &prompts)
	}
	enabled := []map[string]any{}
	for _, item := range prompts {
		prompt, _ := item.(map[string]any)
		if prompt == nil || prompt["enabled"] == false {
			continue
		}
		enabled = append(enabled, prompt)
	}
	promptList := []string{}
	for index, prompt := range enabled {
		identifier := firstText(textOf(prompt["identifier"]), textOf(prompt["name"]), fmt.Sprintf("item-%d", index))
		promptList = append(promptList, fmt.Sprintf("<prompt index=\"%d\">\n<id>%s</id>\n<role>%s</role>\n<content>%s</content>\n</prompt>",
			index, identifier, orDefault(textOf(prompt["role"]), "system"), truncateRunes(textOf(prompt["content"]), 1500)))
	}
	tunePrompt := fmt.Sprintf(`任务：优化角色扮演 AI 的提示词，让它更像角色。

角色名：%s
角色设定：%s
%s

当前已启用的提示词（只改<content>，不动<id><role>）：
%s

要求：
1. 参考"角色设定"和"最近AI实际回复"，找出提示词的问题
2. 如果 AI 回复和角色设定差距大，加强相关提示词的约束
3. 只修改<content>标签内的文本，<id>和<role>一个字都不能改
4. 让提示词更贴合角色语气、用词习惯、思维方式
5. 去掉冗余表述，保留核心指令
6. 如果某条提示词已经很好，原样保留
7. 输出合法 JSON 数组：
[{"index":0,"content":"优化后提示词"},...]

只输出 JSON 数组：`,
		profile.Name,
		truncateRunes(strings.Join([]string{profile.Description, profile.Personality, profile.Scenario, profile.FirstMes, profile.Examples, ""}, "\n"), 2000),
		func() string {
			if len(samples) == 0 {
				return ""
			}
			return "\n## 最近AI实际回复（用于判断提示词效果）\n" + strings.Join(samples, "\n---\n")
		}(),
		strings.Join(promptList, "\n"))
	client := s.buildRangeAIClient("", "")
	if client == nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": "无法构建 AI 客户端，请检查 ai.providers 配置"})
		return
	}
	ctx, cancel := contextWithTimeout(time.Duration(s.document.Int("ai.timeout", 120)) * time.Second)
	defer cancel()
	completion, err := client.Chat(ctx, []ai.Message{{Role: "user", Content: tunePrompt}}, nil)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": "模型请求失败: " + err.Error()})
		return
	}
	optimized := parseJSONArray(completion.Content)
	valid := []map[string]any{}
	for _, item := range optimized {
		index, ok := item["index"].(float64)
		if !ok {
			if fallback, ok := item["i"].(float64); ok {
				index = fallback
			} else {
				continue
			}
		}
		position := int(index)
		if position < 0 || position >= len(enabled) {
			continue
		}
		content := textOf(item["content"])
		if len([]rune(content)) < 10 {
			continue
		}
		valid = append(valid, map[string]any{"index": position, "content": strings.TrimSpace(content)})
	}
	payload := map[string]any{
		"success": true, "optimizedPrompts": nil, "suggestion": nil,
		"message": "AI 返回了建议但无法自动解析，请查看文本框手动参考",
	}
	if len(valid) > 0 {
		payload["optimizedPrompts"] = valid
		payload["message"] = fmt.Sprintf("AI 优化了 %d 条提示词，点击保存生效", len(valid))
	} else {
		payload["suggestion"] = completion.Content
	}
	writeJSON(writer, http.StatusOK, payload)
}

// ---------------- 知识文本导入 ----------------

// ---------------- 世界书提取（Node 契约：filename） ----------------

// handleWorldbookExtractFromCharacter 对齐 Node POST /api/worldbooks/extract-from-character。
func (s *Server) handleWorldbookExtractFromCharacter(writer http.ResponseWriter, request *http.Request) {
	body := decodeBody(request)
	filename := textOf(body["filename"])
	if filename == "" {
		filename = textOf(body["characterName"])
	}
	if filename == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供有效的角色卡文件名"})
		return
	}
	name := strings.TrimSuffix(filename, filepath.Ext(filename))
	card, err := characters.Read(s.dataDir, name)
	if err != nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": err.Error()})
		return
	}
	book, _ := card["character_book"].(map[string]any)
	if book == nil {
		if nested, ok := card["data"].(map[string]any); ok {
			book, _ = nested["character_book"].(map[string]any)
		}
	}
	if book == nil {
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "该角色卡没有内嵌世界书"})
		return
	}
	displayName := firstText(textOf(card["name"]), name)
	entries, _ := book["entries"].([]any)
	if entries == nil {
		entries = []any{}
	}
	worldbookFilename := safeBase(displayName) + "'s Lorebook.json"
	worldbook := map[string]any{
		"name":        displayName + " 世界书",
		"description": "从角色卡 " + displayName + " 提取的世界书",
		"entries":     entries,
	}
	_ = os.MkdirAll(filepath.Join(s.dataDir, "worlds"), 0o755)
	encoded, _ := json.MarshalIndent(worldbook, "", "  ")
	if err := os.WriteFile(filepath.Join(s.dataDir, "worlds", worldbookFilename), encoded, 0o644); err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success": true, "message": "世界书已提取并保存",
		"filename": worldbookFilename, "entriesCount": len(entries),
		"entries": entries,
	})
}

// truncateRunes 按字符截断。
func truncateRunes(text string, limit int) string {
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}
	return string(runes[:limit])
}

// parseJSONArray 从模型输出中提取 JSON 数组。
func parseJSONArray(text string) []map[string]any {
	trimmed := strings.TrimSpace(text)
	trimmed = strings.TrimPrefix(trimmed, "```json")
	trimmed = strings.TrimPrefix(trimmed, "```")
	trimmed = strings.TrimSuffix(strings.TrimSpace(trimmed), "```")
	start := strings.Index(trimmed, "[")
	end := strings.LastIndex(trimmed, "]")
	if start < 0 || end <= start {
		return nil
	}
	var items []map[string]any
	if err := json.Unmarshal([]byte(trimmed[start:end+1]), &items); err != nil {
		return nil
	}
	return items
}
