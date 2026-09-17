// 人物档案（participant profile）完整生命周期：配置解析、触发模式（idle/interval/both）、
// 进度上报、重试队列、按分析模式构建提示词、旧档合并。
//
// 对齐 Node src/index.js（maybeBuildParticipantProfile / scheduleParticipantProfileUpdate /
// startParticipantProfileIntervalTimer）+ src/participant-profile-runtime.js。
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"mimirlink/internal/ai"
	"mimirlink/internal/metrics"
	"mimirlink/internal/store"
)

// ---------------- 配置 ----------------

// profileSettings 是解析后的 memory.participantProfile 配置。
type profileSettings struct {
	Enabled      bool
	Threshold    int
	SourceLimit  int
	AnalysisMode string
	TriggerMode  string
	IdleMs       int
	IntervalMs   int
	RetryOnError bool
	Blacklist    map[string]bool
}

func normalizeProfileTriggerMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "idle", "interval", "both":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "idle"
	}
}

func normalizeProfileAnalysisMode(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "messages_only", "profile_plus_messages", "bot_only_messages", "bot_only_profile":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "bot_only_profile"
	}
}

func profileSourceFilter(analysisMode string) string {
	if analysisMode == "bot_only_messages" || analysisMode == "bot_only_profile" {
		return "bot_only"
	}
	return "all"
}

// profileSettings 解析配置（每次调用都重读，天然支持热加载）。
func (r *Runtime) profileSettings() profileSettings {
	document := r.document
	settings := profileSettings{
		Enabled:     document.Bool("memory.participantProfile.enabled"),
		Threshold:   int(document.Int("memory.participantProfile.triggerMessages", 8)),
		SourceLimit: int(document.Int("memory.participantProfile.maxSourceMessages", 50)),
		IdleMs:      int(document.Int("memory.participantProfile.idleMs", 120000)),
		IntervalMs:  int(document.Int("memory.participantProfile.intervalMs", 300000)),
		Blacklist:   map[string]bool{},
	}
	if settings.Threshold < 1 {
		settings.Threshold = 8
	}
	if settings.SourceLimit < 1 {
		settings.SourceLimit = 50
	}
	if settings.IdleMs < 1 {
		settings.IdleMs = 120000
	}
	if settings.IntervalMs < 1 {
		settings.IntervalMs = 300000
	}
	settings.AnalysisMode = normalizeProfileAnalysisMode(document.String("memory.participantProfile.analysisMode"))
	settings.TriggerMode = normalizeProfileTriggerMode(document.String("memory.participantProfile.triggerMode"))
	settings.RetryOnError = true
	if document.Exists("memory.participantProfile.retryOnError") {
		settings.RetryOnError = document.Bool("memory.participantProfile.retryOnError")
	}
	for _, item := range document.Get("memory.participantProfile.blacklistParticipantIds").Array() {
		if id := strings.TrimSpace(item.String()); id != "" {
			settings.Blacklist[id] = true
		}
	}
	return settings
}

// profileAIClient 解析人物档案使用的 AI 客户端与模型覆盖（对齐 Node getParticipantProfileConfig
// 的 providerId/model 解析 + buildParticipantProfileAIOverrides）。
func (r *Runtime) profileAIClient() (ChatModel, map[string]any) {
	document := r.document
	providerID := strings.TrimSpace(document.String("memory.participantProfile.providerId"))
	if providerID == "" {
		providerID = strings.TrimSpace(document.String("chat.modelProviderId"))
	}
	if providerID == "" {
		providerID = strings.TrimSpace(document.String("ai.activeProviderId"))
	}
	modelOverride := strings.TrimSpace(document.String("memory.participantProfile.model"))
	if providerID != "" {
		raw := map[string]any{}
		if err := json.Unmarshal(document.Raw(), &raw); err == nil {
			if aiSection, ok := raw["ai"].(map[string]any); ok {
				if providers, ok := aiSection["providers"].([]any); ok {
					for _, item := range providers {
						entry, _ := item.(map[string]any)
						if entry == nil {
							continue
						}
						if strings.TrimSpace(stringValue(entry["id"])) != providerID {
							continue
						}
						provider := ai.Provider{
							ID:      providerID,
							BaseURL: strings.TrimSpace(stringValue(entry["baseUrl"])),
							APIKey:  strings.TrimSpace(stringValue(entry["apiKey"])),
							Model:   strings.TrimSpace(stringValue(entry["model"])),
						}
						if modelOverride != "" {
							provider.Model = modelOverride
						}
						if provider.BaseURL == "" {
							break
						}
						timeoutMs := document.Int("ai.timeout", 60000)
						if timeoutMs < 1000 {
							timeoutMs = 60000
						}
						provider.Timeout = time.Duration(timeoutMs) * time.Millisecond
						return ai.New(provider), nil
					}
				}
			}
		}
	}
	if modelOverride != "" {
		return r.ai, map[string]any{"model": modelOverride}
	}
	return r.ai, nil
}

// ---------------- 身份与任务键 ----------------

// profileIdentity 是建档目标的发言人身份。
type profileIdentity struct {
	ParticipantID   string
	ParticipantName string
	MessageType     string
	GroupID         string
}

// profileTargetEntry 是跟踪中的建档目标（interval 巡检用）。
type profileTargetEntry struct {
	Namespace store.NamespaceOptions
	Identity  profileIdentity
}

// profileRetryEntry 是挂起的重试任务。
type profileRetryEntry struct {
	Namespace store.NamespaceOptions
	Identity  profileIdentity
	AddedAt   time.Time
	Error     string
}

func profileTimerKey(namespace store.NamespaceOptions, identity profileIdentity) string {
	return strings.Join([]string{
		identity.ParticipantID,
		namespace.ScopeType,
		namespace.ScopeKey,
		namespace.CharacterName,
		namespace.PresetName,
	}, "|")
}

func profileTaskMeta(namespace store.NamespaceOptions, identity profileIdentity) map[string]any {
	name := identity.ParticipantName
	if name == "" {
		name = identity.ParticipantID
	}
	return map[string]any{
		"taskKey":         profileTimerKey(namespace, identity),
		"participantId":   identity.ParticipantID,
		"participantName": name,
		"scopeType":       nilIfBlank(namespace.ScopeType),
		"scopeKey":        nilIfBlank(namespace.ScopeKey),
		"characterName":   nilIfBlank(namespace.CharacterName),
		"presetName":      nilIfBlank(namespace.PresetName),
	}
}

// ---------------- 进度状态 ----------------

func initialProfileProgress() map[string]any {
	return map[string]any{
		"running":            false,
		"stage":              "idle",
		"triggeredBy":        nil,
		"participantId":      nil,
		"participantName":    nil,
		"scopeType":          nil,
		"scopeKey":           nil,
		"analysisMode":       nil,
		"sourceMessageCount": 0,
		"hasEnoughNewInfo":   false,
		"currentMessage":     "暂无人物档案任务",
		"progressPercent":    0,
		"tasks":              []map[string]any{},
		"savedCount":         0,
		"lastQueuedAt":       nil,
		"lastStartedAt":      nil,
		"lastCompletedAt":    nil,
		"lastSuccessAt":      nil,
		"lastFailureAt":      nil,
		"lastError":          nil,
		"lastResult":         nil,
		"updatedAt":          time.Now().UnixMilli(),
	}
}

// updateProfileProgress 合并进度补丁（对齐 Node updateParticipantProfileProgress）。
func (r *Runtime) updateProfileProgress(patch map[string]any) {
	r.profileMu.Lock()
	defer r.profileMu.Unlock()
	if r.profileProgress == nil {
		r.profileProgress = initialProfileProgress()
	}
	for key, value := range patch {
		r.profileProgress[key] = value
	}
	r.profileProgress["updatedAt"] = time.Now().UnixMilli()
}

// ProfileProgressSnapshot 输出进度快照（含 savedCount 与 tasks）。
func (r *Runtime) ProfileProgressSnapshot() map[string]any {
	r.profileMu.Lock()
	if r.profileProgress == nil {
		r.profileProgress = initialProfileProgress()
	}
	snapshot := make(map[string]any, len(r.profileProgress)+1)
	for key, value := range r.profileProgress {
		snapshot[key] = value
	}
	if tasks, ok := r.profileProgress["tasks"].([]map[string]any); ok {
		copied := make([]any, 0, len(tasks))
		for _, item := range tasks {
			entry := make(map[string]any, len(item))
			for key, value := range item {
				entry[key] = value
			}
			copied = append(copied, entry)
		}
		snapshot["tasks"] = copied
	} else {
		snapshot["tasks"] = []any{}
	}
	r.profileMu.Unlock()
	snapshot["savedCount"] = r.profileSavedCount()
	return snapshot
}

func (r *Runtime) profileSavedCount() int {
	if r.memory == nil {
		return 0
	}
	count, err := r.memory.CountParticipantProfiles("")
	if err != nil {
		return 0
	}
	return count
}

// setProfileTask upsert 单个任务状态并重算平均进度（对齐 Node setParticipantProfileTask）。
func (r *Runtime) setProfileTask(taskPatch map[string]any) {
	taskKey := strings.TrimSpace(stringValue(taskPatch["taskKey"]))
	if taskKey == "" {
		taskKey = "participant-profile-default"
	}
	r.profileMu.Lock()
	if r.profileProgress == nil {
		r.profileProgress = initialProfileProgress()
	}
	tasks, _ := r.profileProgress["tasks"].([]map[string]any)
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
	index := -1
	for position, item := range tasks {
		if stringValue(item["taskKey"]) == taskKey {
			index = position
			break
		}
	}
	if index >= 0 {
		merged := map[string]any{}
		for key, value := range tasks[index] {
			merged[key] = value
		}
		for key, value := range next {
			merged[key] = value
		}
		tasks[index] = merged
	} else {
		tasks = append(tasks, next)
	}
	r.profileProgress["tasks"] = tasks
	r.profileProgress["savedCount"] = r.profileSavedCount()
	if len(tasks) > 0 {
		total := 0
		for _, item := range tasks {
			total += int(intValue(item["progressPercent"]))
		}
		r.profileProgress["progressPercent"] = total / len(tasks)
	}
	r.profileProgress["updatedAt"] = time.Now().UnixMilli()
	r.profileMu.Unlock()
}

func intValue(value any) int64 {
	switch typed := value.(type) {
	case int:
		return int64(typed)
	case int64:
		return typed
	case float64:
		return int64(typed)
	case json.Number:
		parsed, _ := typed.Int64()
		return parsed
	default:
		return 0
	}
}

// ---------------- 触发：idle 定时器 / interval 巡检 ----------------

// scheduleParticipantProfileUpdate 在回复后登记建档目标并安排触发
// （对齐 Node scheduleParticipantProfileUpdate：success/error 两条路径都会调用）。
func (r *Runtime) scheduleParticipantProfileUpdate(sessionKey string, participantID string, participantName string, messageType string, groupID string) {
	if strings.TrimSpace(participantID) == "" {
		return
	}
	settings := r.profileSettings()
	if !settings.Enabled || settings.Blacklist[participantID] {
		return
	}
	namespace := r.namespaceOptions(sessionKey)
	identity := profileIdentity{
		ParticipantID:   participantID,
		ParticipantName: participantName,
		MessageType:     messageType,
		GroupID:         groupID,
	}
	timerKey := profileTimerKey(namespace, identity)
	taskMeta := profileTaskMeta(namespace, identity)
	now := time.Now().UnixMilli()

	r.profileMu.Lock()
	if r.profileTargets == nil {
		r.profileTargets = map[string]profileTargetEntry{}
	}
	r.profileTargets[timerKey] = profileTargetEntry{Namespace: namespace, Identity: identity}
	r.profileMu.Unlock()

	r.updateProfileProgress(map[string]any{
		"running":         false,
		"stage":           "queued",
		"triggeredBy":     "idle",
		"participantId":   identity.ParticipantID,
		"participantName": orDefaultString(identity.ParticipantName, identity.ParticipantID),
		"scopeType":       nilIfBlank(namespace.ScopeType),
		"scopeKey":        nilIfBlank(namespace.ScopeKey),
		"currentMessage":  "已进入空闲建档队列，等待触发",
		"progressPercent": 5,
		"lastQueuedAt":    now,
		"lastError":       nil,
	})
	taskPatch := map[string]any{}
	for key, value := range taskMeta {
		taskPatch[key] = value
	}
	taskPatch["running"] = false
	taskPatch["stage"] = "queued"
	taskPatch["triggeredBy"] = "idle"
	taskPatch["currentMessage"] = "已进入空闲建档队列，等待触发"
	taskPatch["progressPercent"] = 5
	taskPatch["lastQueuedAt"] = now
	taskPatch["lastError"] = nil
	r.setProfileTask(taskPatch)

	if settings.TriggerMode != "idle" && settings.TriggerMode != "both" {
		return
	}
	r.profileMu.Lock()
	if r.profileTimers == nil {
		r.profileTimers = map[string]*time.Timer{}
	}
	if existing := r.profileTimers[timerKey]; existing != nil {
		existing.Stop()
	}
	idleMs := settings.IdleMs
	r.profileTimers[timerKey] = time.AfterFunc(time.Duration(idleMs)*time.Millisecond, func() {
		r.profileMu.Lock()
		delete(r.profileTimers, timerKey)
		r.profileMu.Unlock()
		_, err := r.buildParticipantProfile(namespace, identity, profileBuildOptions{TriggeredBy: "idle"})
		if err != nil {
			r.logger.Printf("[档案] 空闲建档失败: %s %v", identity.ParticipantID, err)
		}
	})
	r.profileMu.Unlock()
}

// BackfillParticipantProfilesFromHistory 启动补建：对历史消息数达到阈值但还没有档案的参与者
// 强制建档一次（对齐 Node backfillParticipantProfilesFromHistory 的 global_shared 命名空间）。
func (r *Runtime) BackfillParticipantProfilesFromHistory() {
	settings := r.profileSettings()
	if !settings.Enabled || r.memory == nil {
		return
	}
	character := strings.TrimSpace(r.document.String("chat.defaultCharacter"))
	namespace := store.NamespaceOptions{
		ScopeType:     "global_shared",
		ScopeKey:      "global_shared_memory",
		CharacterName: character,
	}
	candidates, err := r.memory.ParticipantsEligibleForBackfill(settings.Threshold)
	if err != nil {
		r.logger.Printf("[档案] 启动补建查询失败: %v", err)
		return
	}
	for _, candidate := range candidates {
		if settings.Blacklist[candidate.ParticipantID] {
			continue
		}
		if existing, _ := r.memory.GetParticipantProfileEntry(namespace, candidate.ParticipantID); existing != nil {
			continue
		}
		identity := profileIdentity{
			ParticipantID:   candidate.ParticipantID,
			ParticipantName: candidate.ParticipantID,
			MessageType:     "group",
			GroupID:         candidate.GroupID,
		}
		if _, buildErr := r.buildParticipantProfile(namespace, identity, profileBuildOptions{Force: true, TriggeredBy: "backfill"}); buildErr != nil {
			r.logger.Printf("[档案] 启动补建失败: %s %v", candidate.ParticipantID, buildErr)
		}
	}
	if len(candidates) > 0 {
		r.logger.Printf("[档案] 启动补建检查完成（候选 %d 人）", len(candidates))
	}
}

// StartProfileTicker 启动档案巡检（幂等；对齐 Node participantProfileIntervalTimer）。
func (r *Runtime) StartProfileTicker() {
	r.profileTickerOnce.Do(func() {
		r.profileTickerStop = make(chan struct{})
		go r.profileTickerLoop()
	})
}

// StopProfileTimers 停止巡检与挂起的 idle 定时器（退出时调用）。
func (r *Runtime) StopProfileTimers() {
	r.profileStopOnce.Do(func() {
		if r.profileTickerStop != nil {
			close(r.profileTickerStop)
		}
		r.profileMu.Lock()
		for key, timer := range r.profileTimers {
			timer.Stop()
			delete(r.profileTimers, key)
		}
		r.profileMu.Unlock()
	})
}

func (r *Runtime) profileTickerLoop() {
	const maxCheckInterval = 30 * time.Second
	for {
		settings := r.profileSettings()
		interval := time.Duration(settings.IntervalMs) * time.Millisecond
		wait := interval
		if wait > maxCheckInterval {
			wait = maxCheckInterval
		}
		timer := time.NewTimer(wait)
		select {
		case <-r.profileTickerStop:
			timer.Stop()
			return
		case <-timer.C:
		}
		settings = r.profileSettings()
		if !settings.Enabled || (settings.TriggerMode != "interval" && settings.TriggerMode != "both") {
			continue
		}
		r.profileMu.Lock()
		lastRun := r.profileLastIntervalAt
		r.profileMu.Unlock()
		if !lastRun.IsZero() && time.Since(lastRun) < time.Duration(settings.IntervalMs)*time.Millisecond {
			continue
		}
		r.profileMu.Lock()
		r.profileLastIntervalAt = time.Now()
		r.profileMu.Unlock()
		r.runProfileIntervalPass()
	}
}

// runProfileIntervalPass 执行一次巡检：先处理重试队列，再遍历跟踪目标
// （对齐 Node participantProfileIntervalTimer 回调）。
func (r *Runtime) runProfileIntervalPass() {
	r.profileMu.Lock()
	retryItems := make([]profileRetryEntry, 0, len(r.profileRetryQueue))
	for key, item := range r.profileRetryQueue {
		retryItems = append(retryItems, item)
		delete(r.profileRetryQueue, key)
	}
	targets := make([]profileTargetEntry, 0, len(r.profileTargets))
	for _, item := range r.profileTargets {
		targets = append(targets, item)
	}
	r.profileMu.Unlock()

	for _, item := range retryItems {
		r.logger.Printf("[档案] 重试挂起的档案: %s(%s)", item.Identity.ParticipantName, item.Identity.ParticipantID)
		target := item
		go func() {
			if _, err := r.buildParticipantProfile(target.Namespace, target.Identity, profileBuildOptions{TriggeredBy: "retry"}); err != nil {
				r.logger.Printf("[档案] 重试建档失败: %s %v", target.Identity.ParticipantID, err)
			}
		}()
	}
	for _, item := range targets {
		target := item
		taskMeta := profileTaskMeta(target.Namespace, target.Identity)
		r.updateProfileProgress(map[string]any{
			"running":         false,
			"stage":           "queued",
			"triggeredBy":     "interval",
			"participantId":   target.Identity.ParticipantID,
			"participantName": orDefaultString(target.Identity.ParticipantName, target.Identity.ParticipantID),
			"scopeType":       nilIfBlank(target.Namespace.ScopeType),
			"scopeKey":        nilIfBlank(target.Namespace.ScopeKey),
			"currentMessage":  "定时巡检命中，准备执行人物档案更新",
			"lastQueuedAt":    time.Now().UnixMilli(),
			"lastError":       nil,
		})
		taskPatch := map[string]any{}
		for key, value := range taskMeta {
			taskPatch[key] = value
		}
		taskPatch["running"] = false
		taskPatch["stage"] = "queued"
		taskPatch["triggeredBy"] = "interval"
		taskPatch["currentMessage"] = "定时巡检命中，准备执行人物档案更新"
		taskPatch["lastQueuedAt"] = time.Now().UnixMilli()
		taskPatch["lastError"] = nil
		r.setProfileTask(taskPatch)
		go func() {
			if _, err := r.buildParticipantProfile(target.Namespace, target.Identity, profileBuildOptions{TriggeredBy: "interval"}); err != nil {
				r.logger.Printf("[档案] 定时建档失败: %s %v", target.Identity.ParticipantID, err)
			}
		}()
	}
}

// ---------------- 构建生命周期 ----------------

type profileBuildOptions struct {
	Force       bool
	TriggeredBy string
	RetryCount  int
}

// profileBuildResult 是构建结果（成功保存或跳过）。
type profileBuildResult struct {
	ProfileID       string
	ParticipantID   string
	ParticipantName string
	Skipped         bool
	SkipReason      string
	Content         string
	SourceCount     int
	AnalysisMode    string
	TriggeredBy     string
}

func (r *Runtime) beginProfileBuild(key string) bool {
	r.profileMu.Lock()
	defer r.profileMu.Unlock()
	if r.profileBuilds == nil {
		r.profileBuilds = map[string]bool{}
	}
	if r.profileBuilds[key] {
		return false
	}
	r.profileBuilds[key] = true
	return true
}

func (r *Runtime) endProfileBuild(key string) {
	r.profileMu.Lock()
	delete(r.profileBuilds, key)
	r.profileMu.Unlock()
}

// buildParticipantProfile 执行一次建档（含重试与失败挂起），对齐 Node maybeBuildParticipantProfile。
func (r *Runtime) buildParticipantProfile(namespace store.NamespaceOptions, identity profileIdentity, options profileBuildOptions) (*profileBuildResult, error) {
	if r.memory == nil {
		return nil, fmt.Errorf("记忆库未就绪")
	}
	if strings.TrimSpace(identity.ParticipantID) == "" {
		return nil, nil
	}
	settings := r.profileSettings()
	if !settings.Enabled {
		return nil, nil
	}
	if settings.Blacklist[identity.ParticipantID] {
		return nil, nil
	}
	key := profileTimerKey(namespace, identity)
	if !r.beginProfileBuild(key) {
		return nil, nil
	}
	result, err := r.runProfileBuild(namespace, identity, options, settings)
	if err == nil {
		r.endProfileBuild(key)
		return result, nil
	}
	if settings.RetryOnError && options.RetryCount < 2 {
		r.logger.Printf("[档案] 生成失败，重试 %d/2: %v", options.RetryCount+1, err)
		r.endProfileBuild(key)
		time.Sleep(2 * time.Second)
		return r.buildParticipantProfile(namespace, identity, profileBuildOptions{
			Force:       options.Force,
			TriggeredBy: options.TriggeredBy,
			RetryCount:  options.RetryCount + 1,
		})
	}
	if settings.RetryOnError {
		r.profileMu.Lock()
		if r.profileRetryQueue == nil {
			r.profileRetryQueue = map[string]profileRetryEntry{}
		}
		r.profileRetryQueue[key] = profileRetryEntry{
			Namespace: namespace,
			Identity:  identity,
			AddedAt:   time.Now(),
			Error:     err.Error(),
		}
		r.profileMu.Unlock()
	}
	r.finishProfileFailure(namespace, identity, settings, options, err)
	r.endProfileBuild(key)
	return nil, err
}

// runProfileBuild 是单次构建主体：采集 → 提示词 → AI 生成 →（旧档合并）→ 保存 → 进度。
func (r *Runtime) runProfileBuild(namespace store.NamespaceOptions, identity profileIdentity, options profileBuildOptions, settings profileSettings) (*profileBuildResult, error) {
	triggeredBy := options.TriggeredBy
	if triggeredBy == "" {
		triggeredBy = "auto"
	}
	taskMeta := profileTaskMeta(namespace, identity)
	baseTask := func(stage string, running bool, message string, percent int) map[string]any {
		patch := map[string]any{}
		for key, value := range taskMeta {
			patch[key] = value
		}
		patch["running"] = running
		patch["stage"] = stage
		patch["triggeredBy"] = triggeredBy
		patch["analysisMode"] = settings.AnalysisMode
		patch["currentMessage"] = message
		patch["progressPercent"] = percent
		return patch
	}

	r.updateProfileProgress(map[string]any{
		"running":            true,
		"stage":              "collecting",
		"triggeredBy":        triggeredBy,
		"participantId":      identity.ParticipantID,
		"participantName":    orDefaultString(identity.ParticipantName, identity.ParticipantID),
		"scopeType":          nilIfBlank(namespace.ScopeType),
		"scopeKey":           nilIfBlank(namespace.ScopeKey),
		"analysisMode":       settings.AnalysisMode,
		"sourceMessageCount": 0,
		"hasEnoughNewInfo":   false,
		"currentMessage":     "正在收集人物档案源消息",
		"progressPercent":    10,
		"lastStartedAt":      time.Now().UnixMilli(),
		"lastError":          nil,
		"lastResult":         nil,
	})
	r.setProfileTask(baseTask("collecting", true, "正在收集人物档案源消息", 10))

	source, err := r.memory.CollectParticipantProfileSource(identity.ParticipantID, namespace, store.ProfileSourceConfig{
		Threshold:    settings.Threshold,
		Limit:        settings.SourceLimit,
		SourceFilter: profileSourceFilter(settings.AnalysisMode),
		Force:        options.Force,
	})
	if err != nil {
		return nil, fmt.Errorf("采集源消息失败: %w", err)
	}

	existingID := ""
	if source.Existing != nil {
		existingID = source.Existing.ID
	}
	skippedResult := func(reason string, message string) *profileBuildResult {
		result := &profileBuildResult{
			ProfileID:       existingID,
			ParticipantID:   identity.ParticipantID,
			ParticipantName: orDefaultString(identity.ParticipantName, identity.ParticipantID),
			Skipped:         true,
			SkipReason:      reason,
			AnalysisMode:    settings.AnalysisMode,
			TriggeredBy:     triggeredBy,
		}
		r.updateProfileProgress(map[string]any{
			"running":         false,
			"stage":           "completed",
			"currentMessage":  message,
			"progressPercent": 100,
			"lastCompletedAt": time.Now().UnixMilli(),
			"lastSuccessAt":   time.Now().UnixMilli(),
			"lastResult": map[string]any{
				"skipped":       true,
				"reason":        reason,
				"participantId": identity.ParticipantID,
				"profileId":     nullableString(existingID),
			},
		})
		taskPatch := baseTask("completed", false, message, 100)
		taskPatch["triggeredBy"] = triggeredBy
		taskPatch["analysisMode"] = settings.AnalysisMode
		taskPatch["sourceMessageCount"] = len(source.Messages)
		taskPatch["hasEnoughNewInfo"] = source.HasEnoughNewInfo
		taskPatch["lastCompletedAt"] = time.Now().UnixMilli()
		taskPatch["lastSuccessAt"] = time.Now().UnixMilli()
		taskPatch["lastResult"] = map[string]any{
			"skipped":       true,
			"reason":        reason,
			"participantId": identity.ParticipantID,
			"profileId":     nullableString(existingID),
		}
		r.setProfileTask(taskPatch)
		return result
	}

	r.updateProfileProgress(map[string]any{
		"stage":              "collecting",
		"sourceMessageCount": len(source.Messages),
		"hasEnoughNewInfo":   source.HasEnoughNewInfo,
		"currentMessage":     fmt.Sprintf("已收集 %d 条源消息", len(source.Messages)),
		"progressPercent":    28,
	})
	collectPatch := baseTask("collecting", true, fmt.Sprintf("已收集 %d 条源消息", len(source.Messages)), 28)
	collectPatch["sourceMessageCount"] = len(source.Messages)
	collectPatch["hasEnoughNewInfo"] = source.HasEnoughNewInfo
	collectPatch["triggeredBy"] = triggeredBy
	collectPatch["analysisMode"] = settings.AnalysisMode
	r.setProfileTask(collectPatch)

	if !options.Force && !source.HasEnoughNewInfo {
		return skippedResult("not_enough_new_info", ternaryText(source.Existing != nil, "新信息不足，沿用现有人物档案", "新信息不足，尚未生成档案")), nil
	}
	if len(source.Messages) == 0 {
		return skippedResult("no_source_messages", "没有可用于建档的新消息"), nil
	}

	r.updateProfileProgress(map[string]any{
		"stage":           "prompting",
		"currentMessage":  "正在构建人物档案分析提示词",
		"progressPercent": 45,
	})
	r.setProfileTask(baseTask("prompting", true, "正在构建人物档案分析提示词", 45))

	prompt := buildProfilePrompt(source, settings.AnalysisMode, identity)

	r.updateProfileProgress(map[string]any{
		"stage":           "generating",
		"currentMessage":  "正在调用 AI 生成人物档案",
		"progressPercent": 70,
	})
	r.setProfileTask(baseTask("generating", true, "正在调用 AI 生成人物档案", 70))

	r.metrics.Record(metrics.ParticipantProfile, 1)
	client, overrides := r.profileAIClient()
	profileResult, err := client.Chat(context.Background(), []ai.Message{{Role: "user", Content: prompt}}, overrides)
	if err != nil {
		return nil, fmt.Errorf("调用 AI 失败: %w", err)
	}
	if profileResult == nil {
		return nil, fmt.Errorf("AI 未生成可保存的人物档案")
	}
	profileText := strings.TrimSpace(profileResult.Content)
	if profileText == "" {
		return nil, fmt.Errorf("AI 未生成可保存的人物档案")
	}
	if isProviderErrorLikeReply(profileText) {
		return nil, fmt.Errorf("AI 返回了上游错误内容，拒绝写入人物档案: %s", truncateRunes(profileText, 200))
	}

	// 旧档合并（对齐 Node：有旧档案时先合并再保存）
	if source.Existing != nil && strings.TrimSpace(source.Existing.Content) != "" {
		r.updateProfileProgress(map[string]any{
			"stage":           "merging",
			"currentMessage":  "正在合并旧档案和新版本",
			"progressPercent": 82,
		})
		r.setProfileTask(baseTask("merging", true, "正在合并旧档案和新版本", 82))
		mergePrompt := buildProfileMergePrompt(profileMergeRequest{
			ParticipantID:   identity.ParticipantID,
			ParticipantName: identity.ParticipantName,
			OldProfile:      source.Existing.Content,
			NewProfile:      profileText,
		})
		mergeResult, mergeErr := client.Chat(context.Background(), []ai.Message{{Role: "user", Content: mergePrompt}}, overrides)
		if mergeErr != nil {
			return nil, fmt.Errorf("合并旧档案失败: %w", mergeErr)
		}
		mergedText := strings.TrimSpace(mergeResult.Content)
		if mergedText == "" {
			return nil, fmt.Errorf("AI 未生成可保存的人物档案合并结果")
		}
		if isProviderErrorLikeReply(mergedText) {
			return nil, fmt.Errorf("AI 返回了上游错误内容，拒绝写入人物档案合并结果: %s", truncateRunes(mergedText, 200))
		}
		profileText = mergedText
	}

	r.updateProfileProgress(map[string]any{
		"stage":           "saving",
		"currentMessage":  "正在保存人物档案结果",
		"progressPercent": 88,
	})
	r.setProfileTask(baseTask("saving", true, "正在保存人物档案结果", 88))

	lastProcessedAt := source.LastProcessedAt
	lastSessionID := ""
	if len(source.Messages) > 0 {
		lastSessionID = source.Messages[len(source.Messages)-1].SessionID
	}
	metadata := map[string]any{
		"messageType":            nilIfBlank(identity.MessageType),
		"groupId":                nilIfBlank(identity.GroupID),
		"lastProcessedMessageAt": lastProcessedAt,
		"lastProcessedSessionId": nilIfBlank(lastSessionID),
		"lastSourceMessageCount": len(source.Messages),
		"analysisMode":           settings.AnalysisMode,
		"triggeredBy":            triggeredBy,
		"source":                 "participant_profile",
	}
	savedID, err := r.memory.SaveParticipantProfile(namespace, existingID, identity.ParticipantID,
		orDefaultString(identity.ParticipantName, identity.ParticipantID), profileText, []string{}, metadata, lastSessionID)
	if err != nil {
		return nil, fmt.Errorf("保存档案失败: %w", err)
	}

	result := &profileBuildResult{
		ProfileID:       savedID,
		ParticipantID:   identity.ParticipantID,
		ParticipantName: orDefaultString(identity.ParticipantName, identity.ParticipantID),
		Content:         profileText,
		SourceCount:     len(source.Messages),
		AnalysisMode:    settings.AnalysisMode,
		TriggeredBy:     triggeredBy,
	}
	now := time.Now().UnixMilli()
	r.updateProfileProgress(map[string]any{
		"running":         false,
		"stage":           "completed",
		"currentMessage":  "人物档案已更新完成",
		"progressPercent": 100,
		"lastCompletedAt": now,
		"lastSuccessAt":   now,
		"lastResult": map[string]any{
			"skipped":            false,
			"participantId":      identity.ParticipantID,
			"participantName":    result.ParticipantName,
			"profileId":          nullableString(savedID),
			"sourceMessageCount": len(source.Messages),
			"analysisMode":       settings.AnalysisMode,
			"triggeredBy":        triggeredBy,
		},
	})
	completePatch := baseTask("completed", false, "人物档案已更新完成", 100)
	completePatch["sourceMessageCount"] = len(source.Messages)
	completePatch["hasEnoughNewInfo"] = source.HasEnoughNewInfo
	completePatch["lastCompletedAt"] = now
	completePatch["lastSuccessAt"] = now
	completePatch["lastResult"] = map[string]any{
		"skipped":            false,
		"participantId":      identity.ParticipantID,
		"participantName":    result.ParticipantName,
		"profileId":          nullableString(savedID),
		"sourceMessageCount": len(source.Messages),
		"analysisMode":       settings.AnalysisMode,
		"triggeredBy":        triggeredBy,
	}
	r.setProfileTask(completePatch)
	r.logger.Printf("[档案] 已保存 %s → %s（来源 %d 条，触发 %s）", identity.ParticipantID, savedID, len(source.Messages), triggeredBy)
	return result, nil
}

// finishProfileFailure 记录失败/挂起进度（对齐 Node catch 分支）。
func (r *Runtime) finishProfileFailure(namespace store.NamespaceOptions, identity profileIdentity, settings profileSettings, options profileBuildOptions, buildErr error) {
	triggeredBy := orDefaultString(options.TriggeredBy, "auto")
	now := time.Now().UnixMilli()
	stage := "failed"
	message := fmt.Sprintf("人物档案分析失败: %v", buildErr)
	if settings.RetryOnError {
		stage = "queued"
		message = "重试失败已挂起，下次继续"
	}
	r.updateProfileProgress(map[string]any{
		"running":         false,
		"stage":           stage,
		"currentMessage":  message,
		"progressPercent": 100,
		"lastCompletedAt": now,
		"lastFailureAt":   now,
		"lastError":       buildErr.Error(),
		"lastResult": map[string]any{
			"skipped":         false,
			"participantId":   identity.ParticipantID,
			"participantName": orDefaultString(identity.ParticipantName, identity.ParticipantID),
			"triggeredBy":     triggeredBy,
		},
	})
	taskMeta := profileTaskMeta(namespace, identity)
	patch := map[string]any{}
	for key, value := range taskMeta {
		patch[key] = value
	}
	patch["running"] = false
	patch["stage"] = stage
	patch["triggeredBy"] = triggeredBy
	patch["analysisMode"] = settings.AnalysisMode
	patch["currentMessage"] = message
	patch["progressPercent"] = 100
	patch["lastCompletedAt"] = now
	patch["lastFailureAt"] = now
	patch["lastError"] = buildErr.Error()
	patch["lastResult"] = map[string]any{
		"skipped":         false,
		"participantId":   identity.ParticipantID,
		"participantName": orDefaultString(identity.ParticipantName, identity.ParticipantID),
		"triggeredBy":     triggeredBy,
	}
	r.setProfileTask(patch)
	r.logger.Printf("[档案] 构建失败 %s: %v", identity.ParticipantID, buildErr)
}

// ---------------- 提示词（对齐 Node participant-profile-runtime.js） ----------------

func profilePromptSpeakerLabel(message store.Message, identity profileIdentity) string {
	userID := store.MessageUserID(message)
	role := strings.ToLower(strings.TrimSpace(message.Role))
	targetName := orDefaultString(identity.ParticipantName, identity.ParticipantID)
	if userID != "" && identity.ParticipantID != "" && userID == identity.ParticipantID {
		suffix := ""
		if userID != "" {
			suffix = "|QQ:" + userID
		}
		return "目标人物|" + targetName + suffix
	}
	if role == "assistant" {
		return "Bot"
	}
	if role == "user" {
		who := userID
		if who == "" {
			who = "未知"
		}
		suffix := ""
		if userID != "" {
			suffix = "|QQ:" + userID
		}
		return "其他用户|" + who + suffix
	}
	return "未知说话人|" + orDefaultText(message.Role, "unknown")
}

func formatProfilePromptMessage(message store.Message, identity profileIdentity) string {
	sessionID := message.SessionID
	if sessionID == "" {
		sessionID = "-"
	}
	content := strings.TrimSpace(message.Content)
	if content == "" {
		content = "（空）"
	}
	return fmt.Sprintf("[%s] [说话人:%s] %s", sessionID, profilePromptSpeakerLabel(message, identity), content)
}

// buildProfilePrompt 对齐 Node buildParticipantProfilePrompt（4 种 analysisMode）。
func buildProfilePrompt(source *store.ProfileSource, analysisMode string, identity profileIdentity) string {
	targetID := strings.TrimSpace(identity.ParticipantID)
	targetName := strings.TrimSpace(identity.ParticipantName)
	if targetName == "" {
		targetName = targetID
	}
	if targetName == "" {
		targetName = "目标人物"
	}

	messages := []store.Message{}
	if source != nil {
		messages = source.Messages
	}
	messageLines := make([]string, 0, len(messages))
	for _, message := range messages {
		messageLines = append(messageLines, formatProfilePromptMessage(message, identity))
	}
	messageText := strings.Join(messageLines, "\n")
	if messageText == "" {
		messageText = "（无新增消息）"
	}

	isBotOnly := analysisMode == "bot_only_messages" || analysisMode == "bot_only_profile"
	isMessagesOnly := analysisMode == "messages_only" || analysisMode == "bot_only_messages"

	targetLabel := targetName
	if targetID != "" {
		targetLabel = fmt.Sprintf("%s（QQ:%s）", targetName, targetID)
	}
	rules := strings.Join([]string{
		"归因硬约束：",
		fmt.Sprintf("1. 档案只描述目标人物：%s。", targetLabel),
		"2. 必须把说话人掰开：目标人物 / Bot / 第三者；不得把 Bot 或第三者的话写成目标人物说的。",
		"3. 标记为“引用原文”的内容只作背景，不可记为目标人物观点、口头禅、性格或行为。",
		"4. 目标人物的稳定画像与当前状态，只能依据“说话人=目标人物”的本人发言归纳。",
		"5. Bot 与第三者内容可以用于理解语境，但禁止写入成目标人物自己的表达。",
		"6. 不要臆测未出现的信息；冲突时宁可写不确定或省略。",
	}, "\n")

	scopeHint := "范围说明：以下包含目标人物锚点附近的对话上下文，请按说话人标签拆开理解。"
	if isBotOnly {
		scopeHint = "范围说明：以下优先包含目标人物与 Bot 的交互上下文；其中 Bot 发言仅作背景，不是目标人物本人发言。"
	}

	verb := "增量更新"
	if isMessagesOnly {
		verb = "更新"
	}
	header := strings.Join([]string{
		fmt.Sprintf("请基于以下真实聊天内容%s人物档案。", verb),
		fmt.Sprintf("目标人物：%s", targetLabel),
		rules,
		scopeHint,
	}, "\n")

	if isMessagesOnly {
		return strings.Join([]string{
			header,
			"",
			"仅允许依据这些新增消息总结，不要臆测未出现的信息。",
			"新增消息如下：",
			messageText,
			"",
			"输出格式：",
			"稳定画像: ...",
			"当前状态: ...",
		}, "\n")
	}

	priorProfile := "无"
	if source != nil && source.Existing != nil {
		if content := strings.TrimSpace(source.Existing.Content); content != "" {
			priorProfile = content
		}
	}
	return strings.Join([]string{
		header,
		"",
		"已有档案如下：",
		priorProfile,
		"",
		"新增消息如下：",
		messageText,
		"",
		"输出格式：",
		"稳定画像: ...",
		"当前状态: ...",
	}, "\n")
}

type profileMergeRequest struct {
	ParticipantID   string
	ParticipantName string
	OldProfile      string
	NewProfile      string
}

// buildProfileMergePrompt 对齐 Node buildParticipantProfileMergePrompt。
func buildProfileMergePrompt(request profileMergeRequest) string {
	participantID := request.ParticipantID
	if participantID == "" {
		participantID = "-"
	}
	participantName := request.ParticipantName
	if participantName == "" {
		participantName = participantID
	}
	oldProfile := strings.TrimSpace(request.OldProfile)
	if oldProfile == "" {
		oldProfile = "无"
	}
	newProfile := strings.TrimSpace(request.NewProfile)
	if newProfile == "" {
		newProfile = "无"
	}
	return strings.Join([]string{
		"请合并同一个 QQ 用户的人物档案。",
		fmt.Sprintf("QQ：%s", participantID),
		fmt.Sprintf("当前昵称：%s", participantName),
		"",
		"要求：",
		"1. 只保留一个最终档案，不要输出两个版本，也不要解释合并过程。",
		"2. 以新版本中的最新状态为准，但不要丢掉旧档案里仍稳定、未被新版本推翻的信息。",
		"3. 删除重复、冲突、空泛和模型自述内容；冲突处按“新版本 > 旧档案”，无法判断时写成不确定或省略。",
		"4. 不要编造聊天记录中没有出现的信息。",
		"5. 输出纯文本人物档案，建议包含“稳定画像”和“当前状态”两段。",
		"",
		"旧档案：",
		oldProfile,
		"",
		"新版本：",
		newProfile,
	}, "\n")
}

// ---------------- 上游错误内容识别（对齐 Node isProviderErrorLikeReply） ----------------

var (
	upstreamErrorTagPattern  = regexp.MustCompile(`(?i)\[\s*upstream\s+error\b`)
	rateLimitPattern         = regexp.MustCompile(`\brate limit(?:ed|s)?\b|\brate_limit\b`)
	tooManyRequestsPattern   = regexp.MustCompile(`\btoo many requests\b|\bstatus\s*429\b`)
	tryAgainPattern          = regexp.MustCompile(`\b(please )?try again (in|after)\b`)
	tryAgainWindowPattern    = regexp.MustCompile(`\b(minute|second|hour|later|moment)\b`)
	providerErrorWordPattern = regexp.MustCompile(`\b(upstream error|provider error|api error|quota exceeded|overloaded)\b`)
)

// isProviderErrorLikeReply 判断文本是否是上游错误内容（不应写入档案）。
func isProviderErrorLikeReply(text string) bool {
	raw := strings.TrimSpace(text)
	if raw == "" {
		return false
	}
	normalized := strings.ToLower(regexp.MustCompile(`\s+`).ReplaceAllString(raw, " "))
	if upstreamErrorTagPattern.MatchString(raw) {
		return true
	}
	if rateLimitPattern.MatchString(normalized) {
		return true
	}
	if tooManyRequestsPattern.MatchString(normalized) {
		return true
	}
	if tryAgainPattern.MatchString(normalized) && tryAgainWindowPattern.MatchString(normalized) {
		return true
	}
	if providerErrorWordPattern.MatchString(normalized) && len([]rune(raw)) <= 400 {
		return true
	}
	return false
}

func ternaryText(condition bool, whenTrue string, whenFalse string) string {
	if condition {
		return whenTrue
	}
	return whenFalse
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}
