package chat

import (
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 本文件实现连发消息聚合调度（对齐 Node src/runtime.js MessageRuntime）：
//   - 同一会话内的连续消息进入缓冲，缓冲窗口 chat.bufferWindowMs（默认 1200ms）
//   - 窗口内每来一条新消息就重置计时器，安静满窗口后合并为一条输入交给模型
//   - 合并文本用换行连接；批内消息数、触发原因写入情境感知段
//   - 处理前等待 chat.replyDelayMs（默认 800ms，对齐 Node 的回复节奏）
//   - 会话内串行、跨会话并发上限 chat.maxConcurrentSessions（默认 2）
//
// 旧实现每条消息立即触发一轮对话，连发 3 条会得到 3 段割裂的回复，
// 且面板上的「缓冲/延迟/并发」三个配置项完全不生效。

// pendingMessage 是一条待聚合的消息（已完成快速通道判定）。
type pendingMessage struct {
	event         map[string]any
	sessionKey    string
	text          string
	messageType   string
	groupID       string
	userID        string
	isAtBotSelf   bool
	triggerReason string
	// replyInfo 为预解析的引用消息信息（路由判定已拉取，避免处理时重复请求）
	replyInfo replyInfo
	// observationOnly 表示未触发回复、仅需观察群复读的消息（对齐 Node group_repeat_watch）
	observationOnly bool
}

// aggregateBuffer 是单会话的聚合缓冲。
type aggregateBuffer struct {
	items  []pendingMessage
	timer  *time.Timer
	closed bool
}

// aggregateState 持有调度器状态（惰性初始化，避免影响既有测试）。
type aggregateState struct {
	mu       sync.Mutex
	buffers  map[string]*aggregateBuffer
	sessions map[string]*sync.Mutex
	sem      chan struct{}
	inflight int64
	now      func() time.Time
}

func (r *Runtime) aggregate() *aggregateState {
	r.aggregateMu.Lock()
	defer r.aggregateMu.Unlock()
	if r.aggregator == nil {
		r.aggregator = &aggregateState{
			buffers:  map[string]*aggregateBuffer{},
			sessions: map[string]*sync.Mutex{},
			now:      time.Now,
		}
	}
	return r.aggregator
}

// aggregateSettings 读取聚合相关配置（对齐 Node chatConfig 默认值）。
func (r *Runtime) aggregateSettings() (enabled bool, windowMs int, replyDelayMs int, maxConcurrent int) {
	windowMs = int(r.document.Int("chat.bufferWindowMs", 1200))
	if windowMs < 0 {
		windowMs = 0
	}
	replyDelayMs = int(r.document.Int("chat.replyDelayMs", 800))
	if replyDelayMs < 0 {
		replyDelayMs = 0
	}
	maxConcurrent = int(r.document.Int("chat.maxConcurrentSessions", 2))
	if maxConcurrent < 1 {
		maxConcurrent = 1
	}
	// windowMs == 0 表示关闭聚合（每条消息立即处理）
	return windowMs > 0, windowMs, replyDelayMs, maxConcurrent
}

// enqueueAggregated 把消息放入会话缓冲，返回是否已接受（true 表示稍后处理）。
func (r *Runtime) enqueueAggregated(item pendingMessage) bool {
	_, windowMs, _, _ := r.aggregateSettings()
	state := r.aggregate()
	state.mu.Lock()
	buffer := state.buffers[item.sessionKey]
	if buffer == nil {
		buffer = &aggregateBuffer{}
		state.buffers[item.sessionKey] = buffer
	}
	buffer.items = append(buffer.items, item)
	if buffer.timer != nil {
		buffer.timer.Stop()
	}
	window := time.Duration(windowMs) * time.Millisecond
	buffer.timer = time.AfterFunc(window, func() {
		r.flushAggregated(item.sessionKey)
	})
	state.mu.Unlock()
	return true
}

// flushAggregated 取出会话缓冲并异步处理（会话内串行、跨会话受限并发）。
func (r *Runtime) flushAggregated(sessionKey string) {
	state := r.aggregate()
	state.mu.Lock()
	buffer := state.buffers[sessionKey]
	if buffer == nil || len(buffer.items) == 0 {
		state.mu.Unlock()
		return
	}
	items := buffer.items
	buffer.items = nil
	if buffer.timer != nil {
		buffer.timer.Stop()
		buffer.timer = nil
	}
	lock := state.sessions[sessionKey]
	if lock == nil {
		lock = &sync.Mutex{}
		state.sessions[sessionKey] = lock
	}
	state.mu.Unlock()

	atomic.AddInt64(&state.inflight, 1)
	go func() {
		defer atomic.AddInt64(&state.inflight, -1)
		lock.Lock()
		defer lock.Unlock()
		r.runAggregatedBatch(sessionKey, items)
	}()
}

// runAggregatedBatch 合并批内消息后走一次完整对话流程。
func (r *Runtime) runAggregatedBatch(sessionKey string, items []pendingMessage) {
	if len(items) == 0 {
		return
	}
	_, _, replyDelayMs, maxConcurrent := r.aggregateSettings()
	state := r.aggregate()
	state.mu.Lock()
	if state.sem == nil || cap(state.sem) != maxConcurrent {
		// 并发上限变更时重建信号量（旧的仍在使用中会被 GC）
		state.sem = make(chan struct{}, maxConcurrent)
	}
	semaphore := state.sem
	state.mu.Unlock()
	semaphore <- struct{}{}
	defer func() { <-semaphore }()

	if replyDelayMs > 0 {
		time.Sleep(time.Duration(replyDelayMs) * time.Millisecond)
	}

	// 对齐 Node processBatch：优先取最后一条「触发回复」的消息作为主消息，
	// 批内全是复读观察（observationOnly）时退化为最后一条。
	primary := items[len(items)-1]
	for index := len(items) - 1; index >= 0; index-- {
		if !items[index].observationOnly {
			primary = items[index]
			break
		}
	}
	texts := make([]string, 0, len(items))
	for _, item := range items {
		if trimmed := strings.TrimSpace(item.text); trimmed != "" {
			texts = append(texts, trimmed)
		}
	}
	merged := strings.Join(texts, "\n")
	if merged == "" {
		return
	}
	if len(items) > 1 {
		r.logger.Printf("[调度] 合并 %d 条连发消息 [%s]: %s", len(items), sessionKey, truncateForLog(merged, 60))
	}
	r.aggregateCount = len(items)
	r.aggregateReason = primary.triggerReason
	defer func() {
		r.aggregateCount = 0
		r.aggregateReason = ""
	}()
	primary.text = merged
	r.processIncoming(primary, true)
}

// WaitForAggregates 等待所有进行中的批处理结束（用于退出与测试）。
func (r *Runtime) WaitForAggregates(timeout time.Duration) bool {
	state := r.aggregate()
	deadline := time.Now().Add(timeout)
	for {
		if state.pendingCount() == 0 && atomic.LoadInt64(&state.inflight) == 0 {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// pendingCount 统计仍在缓冲中（尚未触发处理）的消息数。
func (s *aggregateState) pendingCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, buffer := range s.buffers {
		if buffer != nil {
			total += len(buffer.items)
		}
	}
	return total
}

// FlushAggregates 立即冲刷所有会话缓冲（用于退出前把待处理消息处理完）。
func (r *Runtime) FlushAggregates() {
	state := r.aggregate()
	state.mu.Lock()
	keys := make([]string, 0, len(state.buffers))
	for key, buffer := range state.buffers {
		if buffer != nil && len(buffer.items) > 0 {
			keys = append(keys, key)
		}
	}
	state.mu.Unlock()
	for _, key := range keys {
		r.flushAggregated(key)
	}
	_ = r.WaitForAggregates(30 * time.Second)
}

func truncateForLog(text string, limit int) string {
	runes := []rune(strings.ReplaceAll(text, "\n", " / "))
	if len(runes) <= limit {
		return string(runes)
	}
	return string(runes[:limit]) + "…"
}

// describeAggregateState 供状态查询/日志使用。
func (r *Runtime) describeAggregateState() string {
	state := r.aggregate()
	state.mu.Lock()
	defer state.mu.Unlock()
	pending := 0
	for _, buffer := range state.buffers {
		pending += len(buffer.items)
	}
	return fmt.Sprintf("会话 %d / 待处理 %d", len(state.buffers), pending)
}
