// Package auth 提供面板登录、会话、登录限流与 MCP 令牌校验。
//
// 行为对齐 Node 版 src/routes.js 与 src/auth-gate.js：
//   - 认证未启用时直接放行
//   - 用户名/密码恒时比较
//   - 登录后轮换会话 ID（这里等价于新建会话）
//   - 登录限流：每 IP 每分钟 10 次
//   - MCP 接口使用独立令牌，未授权返回 401 + -32001
package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// SafeEqualStrings 恒时比较两个字符串，避免通过响应时间推断凭据。
func SafeEqualStrings(left string, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

// Session 是一次已登录会话。
type Session struct {
	ID        string
	Username  string
	ExpiresAt time.Time
}

// Manager 管理会话与登录限流。
type Manager struct {
	mu            sync.Mutex
	sessions      map[string]*Session
	attempts      map[string][]time.Time
	enabled       bool
	username      string
	password      string
	sessionDays   int
	shortHours    int
	maxAttempts   int
	attemptWindow time.Duration
	cookieName    string
}

// Options 配置鉴权行为。
type Options struct {
	Enabled       bool
	Username      string
	Password      string
	SessionDays   int
	ShortHours    int
	MaxAttempts   int
	AttemptWindow time.Duration
	CookieName    string
}

// NewManager 创建鉴权管理器。
func NewManager(options Options) *Manager {
	manager := &Manager{
		sessions:      map[string]*Session{},
		attempts:      map[string][]time.Time{},
		enabled:       options.Enabled,
		username:      options.Username,
		password:      options.Password,
		sessionDays:   options.SessionDays,
		shortHours:    options.ShortHours,
		maxAttempts:   options.MaxAttempts,
		attemptWindow: options.AttemptWindow,
		cookieName:    options.CookieName,
	}
	if manager.sessionDays <= 0 {
		manager.sessionDays = 30
	}
	if manager.shortHours <= 0 {
		manager.shortHours = 12
	}
	if manager.maxAttempts <= 0 {
		manager.maxAttempts = 10
	}
	if manager.attemptWindow <= 0 {
		manager.attemptWindow = time.Minute
	}
	if manager.cookieName == "" {
		manager.cookieName = "mimir.sid"
	}
	return manager
}

// Enabled 返回鉴权是否开启。
func (m *Manager) Enabled() bool { return m.enabled }

// CookieName 返回会话 Cookie 名。
func (m *Manager) CookieName() string { return m.cookieName }

func newSessionID() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("生成会话 ID 失败: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

// TooManyAttempts 判断该 IP 是否触发登录限流。
func (m *Manager) TooManyAttempts(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	history := m.attempts[ip]
	kept := history[:0]
	for _, stamp := range history {
		if now.Sub(stamp) < m.attemptWindow {
			kept = append(kept, stamp)
		}
	}
	m.attempts[ip] = kept
	return len(kept) >= m.maxAttempts
}

// NoteAttempt 记录一次登录尝试。
func (m *Manager) NoteAttempt(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.attempts[ip] = append(m.attempts[ip], time.Now())
}

// Login 校验凭据并创建会话，返回会话与是否记住我。
func (m *Manager) Login(username string, password string, rememberMe bool) (*Session, bool) {
	if !SafeEqualStrings(username, m.username) || !SafeEqualStrings(password, m.password) {
		return nil, false
	}
	id, err := newSessionID()
	if err != nil {
		return nil, false
	}
	duration := time.Duration(m.shortHours) * time.Hour
	if rememberMe {
		duration = time.Duration(m.sessionDays) * 24 * time.Hour
	}
	session := &Session{ID: id, Username: username, ExpiresAt: time.Now().Add(duration)}
	m.mu.Lock()
	m.sessions[id] = session
	m.mu.Unlock()
	return session, true
}

// Lookup 按会话 ID 取有效会话。
func (m *Manager) Lookup(id string) *Session {
	if id == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	session, ok := m.sessions[id]
	if !ok {
		return nil
	}
	if time.Now().After(session.ExpiresAt) {
		delete(m.sessions, id)
		return nil
	}
	return session
}

// Logout 注销会话。
func (m *Manager) Logout(id string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.sessions, id)
}

// RequestIP 提取请求来源 IP（兼容 X-Forwarded-For 链）。
func RequestIP(request *http.Request) string {
	if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if candidate := strings.TrimSpace(parts[0]); candidate != "" {
			return candidate
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return host
}

// TokenRequest 判断请求携带的 MCP 令牌是否有效。
func TokenRequest(request *http.Request, expected string) bool {
	token := strings.TrimSpace(request.Header.Get("X-MCP-Token"))
	if token == "" {
		authorization := strings.TrimSpace(request.Header.Get("Authorization"))
		if strings.HasPrefix(strings.ToLower(authorization), "bearer ") {
			token = strings.TrimSpace(authorization[7:])
		}
	}
	if token == "" || expected == "" {
		return false
	}
	return SafeEqualStrings(token, expected)
}

// IsMCPPath 判断请求路径是否属于 MCP 接口。
func IsMCPPath(path string) bool {
	trimmed := strings.TrimSuffix(path, "/")
	return trimmed == "/mcp" || strings.HasPrefix(trimmed, "/mcp/")
}
