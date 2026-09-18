package music

import (
	"context"
	"os/exec"
	"time"
)

// runProcess 对齐 Node defaultRunCommand：超时强杀、stderr 截断保留尾部 4000 字节。
func runProcess(command string, args []string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	stderr := &limitedBuffer{max: 4000}
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	return nil
}

// limitedBuffer 保留尾部 max 字节。
type limitedBuffer struct {
	buf []byte
	max int
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	b.buf = append(b.buf, data...)
	if len(b.buf) > b.max {
		b.buf = b.buf[len(b.buf)-b.max:]
	}
	return len(data), nil
}
