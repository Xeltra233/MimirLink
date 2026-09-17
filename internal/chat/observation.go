// 观测快照与思考提示：recall 快照、注入观测事件、chat.thinkingNotify。
//
// 对齐 Node src/index.js：
//   - lastRecallSnapshot（3260 段）
//   - buildObservationEnvelope / buildObservationEvent / rememberObservationEvent（security.js + index.js）
//   - thinkingNotify 定时提示（3583 段）
package chat

import (
	"fmt"
	"strings"
	"time"

	"mimirlink/internal/store"
)

// 最近注入观测事件上限（对齐 Node MAX_RECENT_INJECTION_OBSERVATIONS）。
const maxRecentInjectionObservations = 20

// recordRecallSnapshot 记录最近一次召回快照（对齐 Node lastRecallSnapshot 字段形状）。
func (r *Runtime) recordRecallSnapshot(sessionKey string, query string, entries []store.MemoryEntry) {
	namespace := r.namespaceOptions(sessionKey)
	hits := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		title := entry.Title
		preview := entry.Content
		if len([]rune(preview)) > 160 {
			preview = string([]rune(preview)[:160])
		}
		hits = append(hits, map[string]any{
			"id":           entry.ID,
			"title":        title,
			"sourceKind":   entry.SourceKind,
			"recallReason": entry.RecallReason,
			"recallScore":  entry.RecallScore,
			"preview":      preview,
		})
	}
	snapshot := map[string]any{
		"at":        time.Now().UnixMilli(),
		"namespace": namespace,
		"query":     truncateRunes(strings.TrimSpace(query), 160),
		"hits":      hits,
	}
	r.observationMu.Lock()
	r.lastRecallSnapshot = snapshot
	r.observationMu.Unlock()
}

// recordInjectionObservation 记录注入观测（对齐 Node buildObservationEnvelope + rememberObservationEvent）。
func (r *Runtime) recordInjectionObservation(sessionKey string, messageType string, triggerReason string, content string, risk InjectionRisk, entries []store.MemoryEntry, userID string) {
	adminUser := r.isAdminUser(userID)
	trustedContext := map[string]any{
		"sessionMode":       r.document.String("chat.sessionMode"),
		"accessControlMode": r.document.String("chat.accessControlMode"),
		"character":         r.characterName(),
		"trustedSources":    []string{"character_card", "worldbook", "preset", "database_recall", "system_summary"},
		"adminUsers":        stringListField(r.document, "chat.adminUsers"),
	}
	runtimeStats := map[string]any{
		"sessionId":     sessionKey,
		"messageType":   messageType,
		"triggerReason": triggerReason,
	}
	riskPayload := map[string]any{
		"level":        risk.Level,
		"matchedRules": risk.MatchedRules,
		"score":        risk.Score,
	}
	userEntry := map[string]any{
		"type":    "user_message",
		"trusted": false,
		"content": content,
		"risk":    riskPayload,
	}
	adminEntry := map[string]any{
		"type":    "admin_user_message",
		"trusted": true,
		"content": content,
		"risk":    riskPayload,
	}
	memory := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		memory = append(memory, map[string]any{
			"trusted": true,
			"type":    entry.SourceKind,
			"title":   entry.Title,
			"content": entry.Content,
			"reason":  entry.RecallReason,
		})
	}
	observation := map[string]any{
		"trusted_context":         trustedContext,
		"runtime_stats":           runtimeStats,
		"untrusted_user_inputs":   []any{},
		"trusted_admin_inputs":    []any{},
		"system_generated_memory": memory,
	}
	if adminUser {
		observation["trusted_admin_inputs"] = []any{adminEntry}
	} else {
		observation["untrusted_user_inputs"] = []any{userEntry}
	}

	r.observationMu.Lock()
	r.lastInjectionObservation = observation
	event := buildObservationEvent(observation, adminUser)
	r.recentInjectionObservations = append([]map[string]any{event}, r.recentInjectionObservations...)
	if len(r.recentInjectionObservations) > maxRecentInjectionObservations {
		r.recentInjectionObservations = r.recentInjectionObservations[:maxRecentInjectionObservations]
	}
	r.observationMu.Unlock()
}

// buildObservationEvent 对齐 Node buildObservationEvent 的事件形状。
func buildObservationEvent(observation map[string]any, adminUser bool) map[string]any {
	source := map[string]any{}
	if adminUser {
		if list, ok := observation["trusted_admin_inputs"].([]any); ok && len(list) > 0 {
			source, _ = list[0].(map[string]any)
		}
	} else if list, ok := observation["untrusted_user_inputs"].([]any); ok && len(list) > 0 {
		source, _ = list[0].(map[string]any)
	}
	runtimeStats, _ := observation["runtime_stats"].(map[string]any)
	if runtimeStats == nil {
		runtimeStats = map[string]any{}
	}
	risk, _ := source["risk"].(map[string]any)
	matchedRules := []any{}
	if risk != nil {
		if list, ok := risk["matchedRules"].([]any); ok {
			matchedRules = list
		}
	}
	riskLevel := "none"
	if risk != nil {
		riskLevel = stringValue(risk["level"])
	}
	now := time.Now().UnixMilli()
	return map[string]any{
		"id":        fmt.Sprintf("%d-%d", now, now%1000003),
		"timestamp": now,
		"actorType": ternaryText(adminUser, "admin", "user"),
		"summary": map[string]any{
			"sessionId":      stringValue(runtimeStats["sessionId"]),
			"messageType":    stringValue(runtimeStats["messageType"]),
			"triggerReason":  stringValue(runtimeStats["triggerReason"]),
			"riskLevel":      riskLevel,
			"matchedRules":   matchedRules,
			"contentPreview": truncateRunes(stringValue(source["content"]), 160),
		},
		"observation": observation,
	}
}

// LastRecallSnapshot 返回最近召回快照（面板 /api/status）。
func (r *Runtime) LastRecallSnapshot() map[string]any {
	r.observationMu.RLock()
	defer r.observationMu.RUnlock()
	if r.lastRecallSnapshot == nil {
		return nil
	}
	copied := map[string]any{}
	for key, value := range r.lastRecallSnapshot {
		copied[key] = value
	}
	return copied
}

// LastInjectionObservation 返回最近注入观测（面板 /api/status）。
func (r *Runtime) LastInjectionObservation() map[string]any {
	r.observationMu.RLock()
	defer r.observationMu.RUnlock()
	if r.lastInjectionObservation == nil {
		return nil
	}
	copied := map[string]any{}
	for key, value := range r.lastInjectionObservation {
		copied[key] = value
	}
	return copied
}

// RecentInjectionObservations 返回最近注入观测事件列表（面板 /api/status）。
func (r *Runtime) RecentInjectionObservations() []map[string]any {
	r.observationMu.RLock()
	defer r.observationMu.RUnlock()
	copied := make([]map[string]any, 0, len(r.recentInjectionObservations))
	for _, item := range r.recentInjectionObservations {
		entry := map[string]any{}
		for key, value := range item {
			entry[key] = value
		}
		copied = append(copied, entry)
	}
	return copied
}

// ---------------- 思考中提示（chat.thinkingNotify） ----------------

type thinkingNotifySettings struct {
	Enabled  bool
	DelaySec int
	Message  string
}

func (r *Runtime) thinkingNotifySettings() thinkingNotifySettings {
	settings := thinkingNotifySettings{
		Enabled:  true,
		DelaySec: int(r.document.Int("chat.thinkingNotify.delaySec", 60)),
		Message:  strings.TrimSpace(r.document.String("chat.thinkingNotify.message")),
	}
	if r.document.Exists("chat.thinkingNotify.enabled") {
		settings.Enabled = r.document.Bool("chat.thinkingNotify.enabled")
	}
	if settings.DelaySec < 1 {
		settings.DelaySec = 1
	}
	if settings.DelaySec > 3600 {
		settings.DelaySec = 3600
	}
	return settings
}

// startThinkingNotify 启动思考超时提示定时器（对齐 Node thinkingTimer 建立点）；
// 返回 nil 表示未启用。调用方在 AI 调用结束后必须 Stop。
func (r *Runtime) startThinkingNotify(event map[string]any, messageType string, groupID string, userID string) *time.Timer {
	settings := r.thinkingNotifySettings()
	if !settings.Enabled || settings.DelaySec <= 0 {
		return nil
	}
	delaySec := settings.DelaySec
	message := settings.Message
	if message == "" {
		message = fmt.Sprintf("已思考%ds", delaySec)
	}
	return time.AfterFunc(time.Duration(delaySec)*time.Second, func() {
		r.sendQuotedStatus(event, messageType, groupID, userID, message)
	})
}
