// Package logging 提供与 Node src/logger.js 对齐的最近日志环形缓冲：
// GET /api/logs 返回 [{timestamp, level, message, data}]，供面板与外部集成读取。
//
// Go 侧日志由标准库 log 输出纯文本行，这里在写入时解析出行内容并归档；
// level 采用关键字推断（Node 侧是显式传参），前端不依赖该字段，仅用于形状对齐。
package logging

import (
	"bytes"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Entry 对齐 Node logger 的 recentLogs 条目形状。
type Entry struct {
	Timestamp string `json:"timestamp"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	Data      any    `json:"data"`
}

const maxRecent = 500

var (
	mu       sync.Mutex
	recent   []Entry
	lineHead = regexp.MustCompile(`^\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2} `)
	errorTag = regexp.MustCompile(`(?i)error|失败|错误|异常|panic|fatal`)
	warnTag  = regexp.MustCompile(`(?i)warn|警告|注意`)
)

// Record 记录一条日志（显式级别，数据可为 nil）。
func Record(level string, message string, data any) {
	mu.Lock()
	defer mu.Unlock()
	recent = append(recent, Entry{
		Timestamp: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Level:     level,
		Message:   message,
		Data:      data,
	})
	if len(recent) > maxRecent {
		recent = recent[len(recent)-maxRecent:]
	}
}

// Recent 返回最近 limit 条（对齐 Node getRecentLogs(limit=100) 的切片语义）。
func Recent(limit int) []Entry {
	if limit <= 0 {
		limit = 100
	}
	mu.Lock()
	defer mu.Unlock()
	if len(recent) == 0 {
		return []Entry{}
	}
	start := len(recent) - limit
	if start < 0 {
		start = 0
	}
	items := make([]Entry, len(recent)-start)
	copy(items, recent[start:])
	return items
}

// Reset 清空缓冲（测试用）。
func Reset() {
	mu.Lock()
	defer mu.Unlock()
	recent = nil
}

// recordingWriter 解析标准库 log 的输出行并记录，再透传给下游 writer。
type recordingWriter struct {
	next io.Writer
	mu   sync.Mutex
	rest []byte
}

// NewWriter 包装一个 writer：按行解析并记录到环形缓冲。
func NewWriter(next io.Writer) io.Writer {
	if next == nil {
		next = io.Discard
	}
	return &recordingWriter{next: next}
}

func (w *recordingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	chunk := append(append([]byte{}, w.rest...), p...)
	lines := bytes.Split(chunk, []byte("\n"))
	if len(lines) > 0 {
		w.rest = append([]byte{}, lines[len(lines)-1]...)
		lines = lines[:len(lines)-1]
	}
	for _, line := range lines {
		recordLine(strings.TrimRight(string(line), "\r"))
	}
	w.mu.Unlock()
	return w.next.Write(p)
}

// recordLine 从标准库日志行中解析时间与正文；无法解析时按原文记录。
func recordLine(line string) {
	message := line
	timestamp := time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	if head := lineHead.FindString(line); head != "" {
		if parsed, err := time.ParseInLocation("2006/01/02 15:04:05", strings.TrimSpace(head), time.Local); err == nil {
			timestamp = parsed.UTC().Format("2006-01-02T15:04:05.000Z")
		}
		message = strings.TrimSpace(line[len(head):])
	}
	message = strings.TrimSpace(strings.TrimPrefix(message, "[panel]"))
	level := "info"
	if errorTag.MatchString(message) {
		level = "error"
	} else if warnTag.MatchString(message) {
		level = "warn"
	}
	mu.Lock()
	defer mu.Unlock()
	recent = append(recent, Entry{Timestamp: timestamp, Level: level, Message: message, Data: nil})
	if len(recent) > maxRecent {
		recent = recent[len(recent)-maxRecent:]
	}
}
