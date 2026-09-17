// Package botctl 提供 bot 进程内的本地控制接口（仅监听 127.0.0.1）。
//
// 背景：面板与 bot 是两个进程，Node 单进程里「立即增量分析 / 刷新用户名 /
// 主动 @ 测试 / OneBot 重连」可以直接调用运行时；Go 版需要一条受控通道，
// 让面板把管理动作转发给真正持有 OneBot 连接与 AI 客户端的 bot 进程。
//
// 安全约束：
//   - 只监听回环地址，端口随机（避免固定端口冲突与外部可达）
//   - 每次启动生成随机令牌，通过 <dataDir>/bot-control.json 交给同机面板
//   - 控制文件包含 pid/时间戳，面板据此判断 bot 是否存活
package botctl

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Handler 由 bot 运行时实现，提供控制动作的真实执行逻辑。
type Handler interface {
	// Status 返回 bot 运行状态（OneBot 连接、登录号、LLM 开关等）。
	Status() map[string]any
	// ReconnectOneBot 主动断开并重连 OneBot。
	ReconnectOneBot() error
	// AdminMention 生成或直接发送一条主动 @ 消息，返回生成文本与结果。
	AdminMention(request MentionRequest) (map[string]any, error)
	// AnalyzeParticipantProfile 立即执行一次人物档案增量分析。
	AnalyzeParticipantProfile(request ProfileRequest) (map[string]any, error)
	// RefreshParticipantName 通过 OneBot 拉取昵称并回写档案。
	RefreshParticipantName(request ProfileRequest) (map[string]any, error)
	// TestAI 执行一次带工具上下文的测试对话（对齐 Node POST /api/test/ai）。
	TestAI(request TestAIRequest) (map[string]any, error)
}

// MentionRequest 是主动 @ 测试的请求。
type MentionRequest struct {
	GroupID      string `json:"groupId"`
	TargetUserID string `json:"targetUserId"`
	TargetName   string `json:"targetName"`
	Message      string `json:"message"`
}

// TestAIRequest 是 AI 测试对话请求（对齐 Node /api/test/ai 的 body）。
type TestAIRequest struct {
	Message      string `json:"message"`
	GroupID      string `json:"groupId"`
	TargetUserID string `json:"targetUserId"`
	TargetName   string `json:"targetName"`
}

type ProfileRequest struct {
	EntryID       string `json:"entryId"`
	ParticipantID string `json:"participantId"`
	Participant   string `json:"participantName"`
	ScopeKey      string `json:"scopeKey"`
	ScopeType     string `json:"scopeType"`
	CharacterName string `json:"characterName"`
	MessageType   string `json:"messageType"`
	GroupID       string `json:"groupId"`
}

// ControlFile 是写给面板的发现文件。
type ControlFile struct {
	Port      int    `json:"port"`
	Token     string `json:"token"`
	PID       int    `json:"pid"`
	StartedAt int64  `json:"startedAt"`
	UpdatedAt int64  `json:"updatedAt"`
	Version   string `json:"version"`
}

// Server 是控制接口服务。
type Server struct {
	handler   Handler
	logger    *log.Logger
	listener  net.Listener
	server    *http.Server
	control   ControlFile
	controlAt string
	mu        sync.Mutex
	closed    bool
}

// Start 启动控制服务并写入发现文件。
func Start(handler Handler, dataDir string, logger *log.Logger) (*Server, error) {
	if handler == nil {
		return nil, fmt.Errorf("缺少控制处理器")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("监听控制端口失败: %w", err)
	}
	token, err := randomToken()
	if err != nil {
		_ = listener.Close()
		return nil, err
	}
	address, _ := listener.Addr().(*net.TCPAddr)
	instance := &Server{
		handler:   handler,
		logger:    logger,
		listener:  listener,
		controlAt: filepath.Join(dataDir, "bot-control.json"),
		control: ControlFile{
			Port:      address.Port,
			Token:     token,
			PID:       os.Getpid(),
			StartedAt: time.Now().UnixMilli(),
			UpdatedAt: time.Now().UnixMilli(),
			Version:   "1",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/control/status", instance.handle(instance.handleStatus))
	mux.HandleFunc("/control/onebot/reconnect", instance.handle(instance.handleReconnect))
	mux.HandleFunc("/control/mention", instance.handle(instance.handleMention))
	mux.HandleFunc("/control/participant-profile/analyze", instance.handle(instance.handleAnalyze))
	mux.HandleFunc("/control/participant-profile/refresh-name", instance.handle(instance.handleRefreshName))
	mux.HandleFunc("/control/test-ai", instance.handle(instance.handleTestAI))
	instance.server = &http.Server{Handler: mux}
	if err := instance.writeControlFile(); err != nil {
		_ = listener.Close()
		return nil, err
	}
	go func() {
		if err := instance.server.Serve(listener); err != nil && err != http.ErrServerClosed {
			if instance.logger != nil {
				instance.logger.Printf("[控制接口] 服务退出: %v", err)
			}
		}
	}()
	if instance.logger != nil {
		instance.logger.Printf("[控制接口] 已监听 127.0.0.1:%d（面板可通过 %s 调用）", instance.control.Port, instance.controlAt)
	}
	return instance, nil
}

// Addr 返回控制服务地址（用于日志/测试）。
func (s *Server) Addr() string { return s.listener.Addr().String() }

// Token 返回本次启动的令牌（用于测试）。
func (s *Server) Token() string { return s.control.Token }

// Close 停止服务并清理发现文件。
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	s.mu.Unlock()
	_ = os.Remove(s.controlAt)
	return s.server.Close()
}

func (s *Server) writeControlFile() error {
	if err := os.MkdirAll(filepath.Dir(s.controlAt), 0o755); err != nil {
		return fmt.Errorf("创建控制文件目录失败: %w", err)
	}
	payload, err := json.Marshal(s.control)
	if err != nil {
		return fmt.Errorf("序列化控制信息失败: %w", err)
	}
	temp := s.controlAt + ".tmp"
	if err := os.WriteFile(temp, payload, 0o600); err != nil {
		return fmt.Errorf("写入控制文件失败: %w", err)
	}
	return os.Rename(temp, s.controlAt)
}

type handlerFunc func(writer http.ResponseWriter, request *http.Request)

func (s *Server) handle(next handlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Bot-Token") != s.control.Token {
			writeJSON(writer, http.StatusForbidden, map[string]any{"success": false, "error": "控制令牌无效"})
			return
		}
		if request.Method != http.MethodPost && request.Method != http.MethodGet {
			writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
			return
		}
		defer func() {
			if recovered := recover(); recovered != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": fmt.Sprintf("控制动作异常: %v", recovered)})
			}
		}()
		next(writer, request)
	}
}

func (s *Server) handleStatus(writer http.ResponseWriter, request *http.Request) {
	status := s.handler.Status()
	status["success"] = true
	status["pid"] = s.control.PID
	status["port"] = s.control.Port
	writeJSON(writer, http.StatusOK, status)
}

func (s *Server) handleReconnect(writer http.ResponseWriter, request *http.Request) {
	if err := s.handler.ReconnectOneBot(); err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "message": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "已向 Bot 进程下发 OneBot 重连指令"})
}

func (s *Server) handleMention(writer http.ResponseWriter, request *http.Request) {
	var payload MentionRequest
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体不是合法 JSON"})
		return
	}
	result, err := s.handler.AdminMention(payload)
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "message": err.Error()})
		return
	}
	result["success"] = true
	writeJSON(writer, http.StatusOK, result)
}

func (s *Server) handleAnalyze(writer http.ResponseWriter, request *http.Request) {
	var payload ProfileRequest
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体不是合法 JSON"})
		return
	}
	result, err := s.handler.AnalyzeParticipantProfile(payload)
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "message": err.Error()})
		return
	}
	result["success"] = true
	writeJSON(writer, http.StatusOK, result)
}

func (s *Server) handleRefreshName(writer http.ResponseWriter, request *http.Request) {
	var payload ProfileRequest
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体不是合法 JSON"})
		return
	}
	result, err := s.handler.RefreshParticipantName(payload)
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "message": err.Error()})
		return
	}
	result["success"] = true
	writeJSON(writer, http.StatusOK, result)
}

// handleTestAI 执行带工具上下文的测试对话（对齐 Node /api/test/ai 的 chatWithTools 语义）。
func (s *Server) handleTestAI(writer http.ResponseWriter, request *http.Request) {
	var payload TestAIRequest
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体不是合法 JSON"})
		return
	}
	result, err := s.handler.TestAI(payload)
	if err != nil {
		writeJSON(writer, http.StatusOK, map[string]any{"success": false, "error": err.Error(), "message": err.Error()})
		return
	}
	result["success"] = true
	writeJSON(writer, http.StatusOK, result)
}

func randomToken() (string, error) {
	buffer := make([]byte, 24)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("生成控制令牌失败: %w", err)
	}
	return hex.EncodeToString(buffer), nil
}

func writeJSON(writer http.ResponseWriter, status int, payload map[string]any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

// ReadControlFile 读取发现文件（面板侧使用）。
func ReadControlFile(dataDir string) (ControlFile, error) {
	empty := ControlFile{}
	path := filepath.Join(dataDir, "bot-control.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return empty, err
	}
	var control ControlFile
	if err := json.Unmarshal(raw, &control); err != nil {
		return empty, fmt.Errorf("控制文件损坏: %w", err)
	}
	if control.Port <= 0 || strings.TrimSpace(control.Token) == "" {
		return empty, fmt.Errorf("控制文件缺少端口或令牌")
	}
	return control, nil
}
