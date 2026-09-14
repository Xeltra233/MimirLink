package chat

// 日志文件写入（对齐 Node src/logger.js：logs/<date>.log 追加写入，供
// 面板 /api/logs 系列路由展示与下载）。

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// FileLogger 把日志同时写 stdout 与 logs/<date>.log。
type FileLogger struct {
	mu          sync.Mutex
	logDir      string
	current     string // 当前文件名
	file        *os.File
	multiWriter io.Writer
	base        *logWriter
}

// logWriter 适配标准 log.Logger 的最小接口由调用方持有——这里直接提供
// NewFileLogger 让 main.go 用 log.New(logger.Writer(), ...) 生成 logger。
type logWriter struct {
	logger *FileLogger
}

func (w *logWriter) Write(p []byte) (int, error) {
	return w.logger.append(string(p))
}

// NewFileLogger 创建文件日志（logDir 为空时返回 nil，仅用 stdout）。
func NewFileLogger(logDir string, now time.Time) *FileLogger {
	if logDir == "" {
		return nil
	}
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil
	}
	fl := &FileLogger{logDir: logDir}
	if err := fl.rotate(now); err != nil {
		return nil
	}
	fl.base = &logWriter{logger: fl}
	return fl
}

// Writer 返回可作为 log.Logger 输出的 writer。
func (l *FileLogger) Writer() io.Writer {
	if l == nil {
		return io.Discard
	}
	return l.base
}

// rotate 按日期切换日志文件。
func (l *FileLogger) rotate(now time.Time) error {
	name := now.Format("2006-01-02") + ".log"
	if l.file != nil && l.current == name {
		return nil
	}
	if l.file != nil {
		_ = l.file.Close()
	}
	path := filepath.Join(l.logDir, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	l.file = file
	l.current = name
	return nil
}

// append 写一行日志（自动按日期轮转）。
func (l *FileLogger) append(line string) (int, error) {
	if l == nil {
		return 0, nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.rotate(time.Now()); err != nil {
		return 0, err
	}
	stamped := fmt.Sprintf("%s %s", time.Now().Format("2006-01-02 15:04:05"), strings_TrimRightNewline(line))
	written, err := l.file.WriteString(stamped + "\n")
	return written, err
}

func strings_TrimRightNewline(text string) string {
	for len(text) > 0 && (text[len(text)-1] == '\n' || text[len(text)-1] == '\r') {
		text = text[:len(text)-1]
	}
	return text
}
