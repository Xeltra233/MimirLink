package panel

// 面板 HTTP 中间件：安全响应头 + 按 IP 限流（对齐 Node src/index.js 的
// 全局 300/分钟与 /api/auth/login 10/分钟，以及 Express 上挂的安全响应头）。

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ipRateLimiter 是按 IP 的滑动窗口限流器。
type ipRateLimiter struct {
	mu     sync.Mutex
	hits   map[string][]time.Time
	limit  int
	window time.Duration
}

func newIPRateLimiter(limit int, window time.Duration) *ipRateLimiter {
	return &ipRateLimiter{hits: map[string][]time.Time{}, limit: limit, window: window}
}

func (l *ipRateLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	cutoff := now.Add(-l.window)
	recent := make([]time.Time, 0, len(l.hits[key])+1)
	for _, at := range l.hits[key] {
		if at.After(cutoff) {
			recent = append(recent, at)
		}
	}
	if len(recent) >= l.limit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}

// setSecurityHeaders 对齐 Node 版安全响应头（逐条一致）。
func setSecurityHeaders(writer http.ResponseWriter) {
	header := writer.Header()
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("X-Frame-Options", "DENY")
	header.Set("X-XSS-Protection", "1; mode=block")
	header.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	header.Set("X-DNS-Prefetch-Control", "off")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

// clientIP 解析请求来源 IP（trustProxy 打开时取 X-Forwarded-For 首段）。
func (s *Server) clientIP(request *http.Request) string {
	if s.document.Bool("server.trustProxy") {
		if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
			return strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return host
}

// middleware 组合安全头与限流（对齐 Node app.use 顺序：安全头 → 全局限流 → 登录限流）。
func (s *Server) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		setSecurityHeaders(writer)
		now := time.Now()
		ip := s.clientIP(request)
		if !s.globalLimiter.allow(ip, now) {
			writeJSON(writer, http.StatusTooManyRequests, map[string]any{"success": false, "error": "请求过于频繁，请稍后再试"})
			return
		}
		if request.URL.Path == "/api/auth/login" && !s.loginLimiter.allow(ip, now) {
			writeJSON(writer, http.StatusTooManyRequests, map[string]any{"success": false, "error": "登录尝试过于频繁，请 1 分钟后再试"})
			return
		}
		next.ServeHTTP(writer, request)
	})
}
