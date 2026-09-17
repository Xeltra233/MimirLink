package panel

// 面板 HTTP 中间件：安全响应头 + 按 IP 限流（对齐 Node src/index.js 的
// 全局 300/分钟与 /api/auth/login 10/分钟，以及 Express 上挂的安全响应头）。

import (
	"net"
	"net/http"
	"net/url"
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

// isWriteMethod 判断是否为写方法（对齐 Node isWriteMethod：POST/PUT/PATCH/DELETE）。
func isWriteMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	}
	return false
}

// isAllowedPanelOrigin 校验写请求的来源是否同源（对齐 Node isAllowedPanelOrigin：
// Origin/Referer 缺失放行；跨主机、跨协议、跨端口拒绝）。
func isAllowedPanelOrigin(request *http.Request, originValue string) bool {
	if strings.TrimSpace(originValue) == "" {
		return true
	}
	origin, err := urlParse(originValue)
	if err != nil {
		return false
	}
	host := request.Host
	hostname, port := splitHostPort(host)
	if port == "" {
		if request.TLS != nil {
			port = "443"
		} else {
			port = "80"
		}
	}
	originPort := origin.port
	if originPort == "" {
		if origin.scheme == "https" {
			originPort = "443"
		} else {
			originPort = "80"
		}
	}
	if origin.scheme != "http" && origin.scheme != "https" {
		return false
	}
	if originPort != port {
		return false
	}
	switch origin.hostname {
	case hostname, "127.0.0.1", "localhost", "::1":
		return true
	}
	return false
}

// originParts 是来源解析结果。
type originParts struct {
	scheme   string
	hostname string
	port     string
}

func urlParse(raw string) (originParts, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return originParts{}, err
	}
	_, port := splitHostPort(parsed.Host)
	return originParts{scheme: strings.ToLower(parsed.Scheme), hostname: strings.ToLower(parsed.Hostname()), port: port}, nil
}

func splitHostPort(hostport string) (string, string) {
	if host, port, err := net.SplitHostPort(hostport); err == nil {
		return strings.ToLower(host), port
	}
	return strings.ToLower(hostport), ""
}

// middleware 组合安全头与限流（对齐 Node app.use 顺序：安全头 → 全局限流 → 登录限流 → 同源写校验）。
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
		// 同源写校验（对齐 Node requireSameOriginWrite：仅写方法 + /api 下生效；
		// Origin/Referer 缺失放行，跨源写请求 403）。
		if strings.HasPrefix(request.URL.Path, "/api/") && isWriteMethod(request.Method) {
			sourceOrigin := strings.TrimSpace(request.Header.Get("Origin"))
			if sourceOrigin == "" {
				if referer := strings.TrimSpace(request.Header.Get("Referer")); referer != "" {
					if refererOrigin, err := url.Parse(referer); err == nil {
						sourceOrigin = refererOrigin.Scheme + "://" + refererOrigin.Host
					} else {
						sourceOrigin = "invalid"
					}
				}
			}
			if sourceOrigin != "" && !isAllowedPanelOrigin(request, sourceOrigin) {
				s.logger.Printf("跨源写入请求已被拒绝 method=%s path=%s origin=%q referer=%q", request.Method, request.URL.Path, request.Header.Get("Origin"), request.Header.Get("Referer"))
				writeJSON(writer, http.StatusForbidden, map[string]any{"success": false, "error": "跨源写入请求已被拒绝"})
				return
			}
		}
		// 请求体上限（对齐 Node express.json({limit:'25mb'})：仅约束 /api 下非 multipart 的
		// JSON 请求；文件上传走 multipart 自带限额，不在此截断）。
		if strings.HasPrefix(request.URL.Path, "/api/") && !strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "multipart/") {
			request.Body = http.MaxBytesReader(writer, request.Body, 25<<20)
		}
		next.ServeHTTP(writer, request)
	})
}
