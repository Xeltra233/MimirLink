// Package metrics 实现面板仪表盘的实时分桶指标（对齐 Node src/index.js
// DASHBOARD_METRIC_* 语义）：6 个 5 分钟桶，滚动窗口，按类型累计事件数。
//
// bot 进程记录 chat / participantProfile / tts；面板进程记录 knowledgeImport。
// 面板聚合 /api/status 时以 bot 上报的序列覆盖对应类型（bot 是这三类的唯一来源）。
package metrics

import (
	"sync"
	"time"
)

// 桶窗口参数（对齐 Node DASHBOARD_METRIC_WINDOW_SIZE / DASHBOARD_METRIC_BUCKET_MS）。
const (
	WindowSize = 6
	BucketMs   = 5 * 60 * 1000
)

// 指标类型（对齐 Node DASHBOARD_METRIC_TYPES）。
const (
	Chat               = "chat"
	ParticipantProfile = "participantProfile"
	KnowledgeImport    = "knowledgeImport"
	TTS                = "tts"
)

// Types 是全部支持的指标类型（输出序列的固定键序）。
var Types = []string{Chat, ParticipantProfile, KnowledgeImport, TTS}

type bucket struct {
	Start  int64
	Values map[string]int64
}

// Recorder 是并发安全的滚动分桶记录器。
type Recorder struct {
	mu      sync.Mutex
	buckets []bucket
	now     func() time.Time
}

// New 创建记录器。
func New() *Recorder {
	return &Recorder{now: time.Now}
}

func floorTimestamp(ms int64) int64 {
	return ms / BucketMs * BucketMs
}

func newBucket(start int64) bucket {
	return bucket{Start: start, Values: map[string]int64{}}
}

func (r *Recorder) ensureBuckets(nowMs int64) []bucket {
	latest := floorTimestamp(nowMs)
	if len(r.buckets) == 0 {
		r.buckets = make([]bucket, 0, WindowSize)
		for index := 0; index < WindowSize; index += 1 {
			r.buckets = append(r.buckets, newBucket(latest-int64(WindowSize-1-index)*BucketMs))
		}
		return r.buckets
	}
	currentLatest := r.buckets[len(r.buckets)-1].Start
	if latest > currentLatest {
		steps := (latest - currentLatest) / BucketMs
		for index := int64(1); index <= steps; index += 1 {
			r.buckets = append(r.buckets, newBucket(currentLatest+index*BucketMs))
		}
	}
	// 只保留 <= latest 的最后 WindowSize 个桶
	filtered := make([]bucket, 0, WindowSize)
	for _, item := range r.buckets {
		if item.Start <= latest {
			filtered = append(filtered, item)
		}
	}
	if len(filtered) > WindowSize {
		filtered = filtered[len(filtered)-WindowSize:]
	}
	// 不足则前向补齐（对齐 Node unshift 逻辑）
	for len(filtered) < WindowSize {
		first := filtered[0].Start
		filtered = append([]bucket{newBucket(first - BucketMs)}, filtered...)
	}
	r.buckets = filtered
	return r.buckets
}

// Record 累计一次事件（count<=0 时按 1 计）。
func (r *Recorder) Record(metric string, count int) {
	r.RecordAt(metric, count, r.now())
}

// RecordAt 按指定时间累计（测试用）。
func (r *Recorder) RecordAt(metric string, count int, at time.Time) {
	if count < 1 {
		count = 1
	}
	valid := false
	for _, item := range Types {
		if item == metric {
			valid = true
			break
		}
	}
	if !valid {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	buckets := r.ensureBuckets(at.UnixMilli())
	start := floorTimestamp(at.UnixMilli())
	for index := range buckets {
		if buckets[index].Start == start {
			buckets[index].Values[metric] += int64(count)
			return
		}
	}
}

// Snapshot 输出 {bucketMs, timeline, series, updatedAt}（对齐 Node getDashboardMetricsSnapshot
// 的序列部分；composition 由调用方按存储统计填充）。
func (r *Recorder) Snapshot() map[string]any {
	r.mu.Lock()
	buckets := r.ensureBuckets(r.now().UnixMilli())
	timeline := make([]int64, 0, len(buckets))
	series := map[string][]int64{}
	for _, item := range Types {
		series[item] = make([]int64, 0, len(buckets))
	}
	for _, item := range buckets {
		timeline = append(timeline, item.Start)
		for _, metric := range Types {
			series[metric] = append(series[metric], item.Values[metric])
		}
	}
	r.mu.Unlock()

	anySeries := map[string]any{}
	for _, metric := range Types {
		anySeries[metric] = series[metric]
	}
	return map[string]any{
		"bucketMs":  BucketMs,
		"timeline":  timeline,
		"series":    anySeries,
		"updatedAt": time.Now().UnixMilli(),
	}
}

// Sum 统计窗口内某类型的总事件数（仪表盘“近30分钟调用”卡片的兜底）。
func (r *Recorder) Sum(metric string) int64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	buckets := r.ensureBuckets(r.now().UnixMilli())
	var total int64
	for _, item := range buckets {
		total += item.Values[metric]
	}
	return total
}
