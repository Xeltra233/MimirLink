package metrics

import (
	"testing"
	"time"
)

// TestBucketWindowRolling 校验 6 桶滚动窗口与按类型累计（对齐 Node ensureDashboardMetricBuckets）。
func TestBucketWindowRolling(t *testing.T) {
	recorder := New()
	now := time.UnixMilli(1_700_000_000_000)
	recorder.now = func() time.Time { return now }

	snapshot := recorder.Snapshot()
	timeline, _ := snapshot["timeline"].([]int64)
	if len(timeline) != WindowSize {
		t.Fatalf("窗口桶数应为 %d，实际 %d", WindowSize, len(timeline))
	}
	if snapshot["bucketMs"] != BucketMs {
		t.Fatalf("bucketMs 应为 %d，实际 %v", BucketMs, snapshot["bucketMs"])
	}
	for index := 1; index < len(timeline); index += 1 {
		if timeline[index]-timeline[index-1] != BucketMs {
			t.Fatalf("桶间隔应为 %d，实际 %d", BucketMs, timeline[index]-timeline[index-1])
		}
	}

	recorder.Record(Chat, 1)
	recorder.Record(Chat, 2)
	recorder.Record(TTS, 1)
	recorder.Record(KnowledgeImport, 5)
	recorder.Record("unknown-type", 9) // 非法类型忽略

	snapshot = recorder.Snapshot()
	series, _ := snapshot["series"].(map[string]any)
	chatSeries, _ := series["chat"].([]int64)
	if got := chatSeries[len(chatSeries)-1]; got != 3 {
		t.Fatalf("当前桶 chat 应为 3，实际 %d", got)
	}
	if sum := recorder.Sum(Chat); sum != 3 {
		t.Fatalf("窗口内 chat 总数应为 3，实际 %d", sum)
	}
	ttsSeries, _ := series["tts"].([]int64)
	if ttsSeries[len(ttsSeries)-1] != 1 {
		t.Fatalf("当前桶 tts 应为 1，实际 %d", ttsSeries[len(ttsSeries)-1])
	}
}

// TestBucketAdvance 校验时间前进后旧桶滚动出窗口、新桶补齐。
func TestBucketAdvance(t *testing.T) {
	recorder := New()
	base := time.UnixMilli(1_700_000_000_000)
	now := base
	recorder.now = func() time.Time { return now }

	recorder.Record(Chat, 1)
	now = base.Add(6 * time.Duration(BucketMs) * time.Millisecond)
	snapshot := recorder.Snapshot()
	timeline, _ := snapshot["timeline"].([]int64)
	if len(timeline) != WindowSize {
		t.Fatalf("滚动后仍应保持 %d 桶，实际 %d", WindowSize, len(timeline))
	}
	expectedLatest := base.UnixMilli()/BucketMs*BucketMs + 6*BucketMs
	if timeline[len(timeline)-1] != expectedLatest {
		t.Fatalf("最新桶应为 %d，实际 %d", expectedLatest, timeline[len(timeline)-1])
	}
	series, _ := snapshot["series"].(map[string]any)
	chatSeries, _ := series["chat"].([]int64)
	total := int64(0)
	for _, value := range chatSeries {
		total += value
	}
	if total != 0 {
		t.Fatalf("超出窗口的事件应滚出，实际窗口内 %d", total)
	}
}
