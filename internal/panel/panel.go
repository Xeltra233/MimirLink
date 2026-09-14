// Package panel 提供面板 HTTP 服务：静态页面、登录、配置读写、备份恢复与记忆库只读接口。
//
// 路由与响应结构对齐 Node 版（src/routes.js），以便同一份 public/ 前端可直接使用。
package panel

import (
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"mimirlink/internal/auth"
	"mimirlink/internal/backup"
	"mimirlink/internal/config"
	"mimirlink/internal/mcp"
	"mimirlink/internal/store"
	"mimirlink/internal/tts"
)

// Version 是面板版本号（与 CLI 保持一致）。
const Version = "0.1.0-dev"

// Options 是面板服务的依赖。
type Options struct {
	RootDir  string
	Document *config.Document
	Logger   *log.Logger
	MCP      *mcp.Client
}

// Server 是面板 HTTP 处理器。
type Server struct {
	rootDir    string
	document   *config.Document
	logger     *log.Logger
	auth       *auth.Manager
	publicDir  string
	mux        *http.ServeMux
	dataDir    string
	startedAt  time.Time
	mcpClient  *mcp.Client
	rangeState *rangeState
}

// NewServer 构建面板服务。
func NewServer(options Options) (*Server, error) {
	if options.Document == nil {
		return nil, fmt.Errorf("缺少配置")
	}
	logger := options.Logger
	if logger == nil {
		logger = log.New(os.Stdout, "[panel] ", log.LstdFlags)
	}
	document := options.Document
	server := &Server{
		rootDir:    options.RootDir,
		document:   document,
		logger:     logger,
		publicDir:  resolvePublicDir(document, options.RootDir),
		mux:        http.NewServeMux(),
		startedAt:  time.Now(),
		mcpClient:  options.MCP,
		rangeState: newRangeState(),
	}
	server.dataDir = server.DataDir()
	server.auth = auth.NewManager(auth.Options{
		Enabled:     document.Bool("auth.enabled"),
		Username:    document.String("auth.username"),
		Password:    document.String("auth.password"),
		SessionDays: int(document.Int("auth.sessionDays", 30)),
		ShortHours:  int(document.Int("auth.shortSessionHours", 12)),
	})
	server.registerRoutes()
	server.registerExtendedRoutes()
	server.registerSearchRoutes()
	server.registerMCPRoutes()
	server.registerManagedRoutes()
	server.registerOpsRoutes()
	server.registerTTSRoutes(tts.NewWithAudioDir(server.AudioDir(), logger))
	server.registerRangeRoutes()
	server.loadRangeSnapshots()
	return server, nil
}

// resolvePublicDir 依次尝试：配置指定 → <root>/public → 可执行文件同目录/上级目录的 public。
// 部署时二进制常与数据目录分离，这里保证两者都能找到前端资源。
func resolvePublicDir(document *config.Document, rootDir string) string {
	if configured := strings.TrimSpace(document.String("server.publicDir")); configured != "" {
		if filepath.IsAbs(configured) {
			return configured
		}
		return filepath.Join(rootDir, configured)
	}
	candidates := []string{filepath.Join(rootDir, "public")}
	if executable, err := os.Executable(); err == nil {
		execDir := filepath.Dir(executable)
		candidates = append(candidates,
			filepath.Join(execDir, "public"),
			filepath.Join(execDir, "..", "public"),
			filepath.Join(execDir, "..", "..", "public"),
		)
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
	}
	return candidates[0]
}

// Handler 返回可直接挂到 http.Server 的处理器。
func (s *Server) Handler() http.Handler { return s.mux }

// DataDir 返回当前生效的数据目录。
func (s *Server) DataDir() string {
	dataDir := s.document.String("chat.dataDir")
	if dataDir == "" {
		return filepath.Join(s.rootDir, "data")
	}
	if !filepath.IsAbs(dataDir) {
		return filepath.Join(s.rootDir, dataDir)
	}
	return dataDir
}

// AudioDir 返回合成音频缓存目录（与 Node 版项目根 audio/ 对齐）。
func (s *Server) AudioDir() string {
	return filepath.Join(s.rootDir, "audio")
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("/api/auth/status", s.handleAuthStatus)
	s.mux.HandleFunc("/api/auth/login", s.handleLogin)
	s.mux.HandleFunc("/api/auth/logout", s.handleLogout)
	s.mux.HandleFunc("/api/config", s.requireAuth(s.handleConfig))
	s.mux.HandleFunc("/api/config/backup", s.requireAuth(s.handleBackupExport))
	s.mux.HandleFunc("/api/config/backup/inspect", s.requireAuth(s.handleBackupInspect))
	s.mux.HandleFunc("/api/config/restore", s.requireAuth(s.handleRestore))
	s.mux.HandleFunc("/api/memory/stats", s.requireAuth(s.handleMemoryStats))
	s.mux.HandleFunc("/api/memory/databases", s.requireAuth(s.handleMemoryDatabases))
	s.mux.HandleFunc("/api/memory/download", s.requireAuth(s.handleMemoryDownload))
	s.mux.HandleFunc("/mcp", s.handleMCP)
	s.mux.HandleFunc("/mcp/", s.handleMCP)
	s.mux.HandleFunc("/", s.handleStatic)
}

// ---------- 鉴权 ----------

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(status)
	encoder := json.NewEncoder(writer)
	_ = encoder.Encode(payload)
}

func (s *Server) requestAuthorized(request *http.Request) bool {
	if !s.auth.Enabled() {
		return true
	}
	cookie, err := request.Cookie(s.auth.CookieName())
	if err != nil {
		return false
	}
	return s.auth.Lookup(cookie.Value) != nil
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if s.requestAuthorized(request) {
			next(writer, request)
			return
		}
		writeJSON(writer, http.StatusUnauthorized, map[string]any{"success": false, "error": "未登录"})
	}
}

func (s *Server) handleAuthStatus(writer http.ResponseWriter, request *http.Request) {
	if !s.auth.Enabled() {
		writeJSON(writer, http.StatusOK, map[string]any{"enabled": false, "authenticated": true})
		return
	}
	payload := map[string]any{"enabled": true, "authenticated": false, "username": nil, "expiresAt": nil}
	if cookie, err := request.Cookie(s.auth.CookieName()); err == nil {
		if session := s.auth.Lookup(cookie.Value); session != nil {
			payload["authenticated"] = true
			payload["username"] = session.Username
			payload["expiresAt"] = session.ExpiresAt.UnixMilli()
		}
	}
	writeJSON(writer, http.StatusOK, payload)
}

func (s *Server) handleLogin(writer http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
		return
	}
	if !s.auth.Enabled() {
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "认证未启用"})
		return
	}
	ip := auth.RequestIP(request)
	if s.auth.TooManyAttempts(ip) {
		writeJSON(writer, http.StatusTooManyRequests, map[string]any{"success": false, "error": "尝试过于频繁，请稍后再试"})
		return
	}
	s.auth.NoteAttempt(ip)

	var payload struct {
		Username   string `json:"username"`
		Password   string `json:"password"`
		RememberMe bool   `json:"rememberMe"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 64*1024)).Decode(&payload); err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
		return
	}
	session, ok := s.auth.Login(payload.Username, payload.Password, payload.RememberMe)
	if !ok {
		s.logger.Printf("登录失败: 用户名或密码错误 ip=%s", ip)
		writeJSON(writer, http.StatusUnauthorized, map[string]any{"success": false, "error": "用户名或密码错误"})
		return
	}
	http.SetCookie(writer, &http.Cookie{
		Name:     s.auth.CookieName(),
		Value:    session.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Expires:  session.ExpiresAt,
	})
	s.logger.Printf("用户 %s 登录成功 ip=%s", session.Username, ip)
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":     true,
		"message":     "登录成功",
		"expiresInMs": time.Until(session.ExpiresAt).Milliseconds(),
	})
}

func (s *Server) handleLogout(writer http.ResponseWriter, request *http.Request) {
	if cookie, err := request.Cookie(s.auth.CookieName()); err == nil {
		s.auth.Logout(cookie.Value)
	}
	http.SetCookie(writer, &http.Cookie{Name: s.auth.CookieName(), Value: "", Path: "/", MaxAge: -1})
	writeJSON(writer, http.StatusOK, map[string]any{"success": true})
}

// ---------- 配置 ----------

func (s *Server) handleConfig(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		safe, err := BuildSafeConfig(s.document)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		writeJSON(writer, http.StatusOK, safe)
	case http.MethodPost:
		var incoming map[string]any
		if err := json.NewDecoder(io.LimitReader(request.Body, 16*1024*1024)).Decode(&incoming); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
			return
		}
		if err := MergeIncomingConfig(s.document, incoming); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		s.logger.Printf("配置已保存（顶层键 %d 个）", len(s.document.Keys()))
		writeJSON(writer, http.StatusOK, map[string]any{"success": true})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// ---------- 备份 ----------

func (s *Server) backupOptions(request *http.Request) backup.Options {
	query := request.URL.Query()
	categories := []string{}
	if raw := strings.TrimSpace(query.Get("categories")); raw != "" && raw != "all" {
		for _, item := range strings.Split(raw, ",") {
			if trimmed := strings.TrimSpace(item); trimmed != "" {
				categories = append(categories, trimmed)
			}
		}
	}
	return backup.Options{
		RootDir:     s.rootDir,
		DataDir:     s.DataDir(),
		IncludeKeys: query.Get("includeKeys") == "true",
		Categories:  categories,
		Now:         time.Now(),
	}
}

func (s *Server) handleBackupExport(writer http.ResponseWriter, request *http.Request) {
	options := s.backupOptions(request)
	name := options.ArchiveName()
	writer.Header().Set("Content-Type", "application/gzip")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	if err := backup.Export(options, writer); err != nil {
		s.logger.Printf("备份导出失败: %v", err)
		if !headerWritten(writer) {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		}
		return
	}
	s.logger.Printf("备份导出完成: %s", name)
}

func headerWritten(writer http.ResponseWriter) bool {
	return false // net/http 无法查询；导出失败时尽量返回 JSON
}

func (s *Server) handleBackupInspect(writer http.ResponseWriter, request *http.Request) {
	tempFile, err := os.CreateTemp("", "mimir-inspect-*.tar.gz")
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer os.Remove(tempFile.Name())
	if _, err := io.Copy(tempFile, io.LimitReader(request.Body, 512*1024*1024)); err != nil {
		_ = tempFile.Close()
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "读取上传内容失败"})
		return
	}
	_ = tempFile.Close()
	found, err := backup.Inspect(tempFile.Name())
	if err != nil {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": err.Error()})
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "categories": found})
}

func (s *Server) handleRestore(writer http.ResponseWriter, request *http.Request) {
	tempFile, err := os.CreateTemp("", "mimir-restore-*.tar.gz")
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer os.Remove(tempFile.Name())
	if _, err := io.Copy(tempFile, io.LimitReader(request.Body, 512*1024*1024)); err != nil {
		_ = tempFile.Close()
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "读取上传内容失败"})
		return
	}
	_ = tempFile.Close()

	options := s.backupOptions(request)
	changes, err := backup.Restore(options, tempFile.Name())
	if err != nil {
		s.logger.Printf("恢复失败: %v", err)
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	s.logger.Printf("恢复完成: replaced=%d added=%d", len(changes.Replaced), len(changes.Added))
	writeJSON(writer, http.StatusOK, map[string]any{"success": true, "changes": changes})
}

// ---------- 记忆库（只读） ----------

func (s *Server) memoryDatabases() ([]map[string]any, error) {
	paths, err := store.DiscoverMemoryDatabases(s.DataDir())
	if err != nil {
		return nil, err
	}
	bindings := s.memoryBindings()
	items := make([]map[string]any, 0, len(paths))
	for _, path := range paths {
		item := map[string]any{
			"path":      path,
			"sizeBytes": int64(0),
			"updatedAt": int64(0),
			"bindings":  bindings[path],
			"stats": map[string]any{
				"totalSessions": int64(0), "totalMessages": int64(0), "totalSummaries": int64(0),
			},
		}
		if item["bindings"] == nil {
			item["bindings"] = []map[string]any{}
		}
		if info, err := os.Stat(path); err == nil {
			item["sizeBytes"] = info.Size()
			item["updatedAt"] = info.ModTime().UnixMilli()
		} else {
			item["missing"] = true
		}
		handle, err := store.OpenReadOnly(path)
		if err == nil {
			if counts, err := handle.Counts(); err == nil {
				// 键名对齐 Node（前端读取 totalSessions / totalMessages / totalSummaries）
				item["stats"] = map[string]any{
					"totalSessions":       counts.Sessions,
					"totalMessages":       counts.Messages,
					"totalSummaries":      counts.Summaries,
					"sessions":            counts.Sessions,
					"messages":            counts.Messages,
					"summaries":           counts.Summaries,
					"memoryNamespaces":    counts.MemoryNamespaces,
					"memoryEntries":       counts.MemoryEntries,
					"summaryIndexEntries": counts.SummaryIndexEntries,
					"stickyEntries":       counts.StickyEntries,
				}
				item["counts"] = counts
			}
			_ = handle.Close()
		}
		items = append(items, item)
	}
	// 最近更新的排在前面（与 Node 一致）
	sort.Slice(items, func(left, right int) bool {
		return items[left]["updatedAt"].(int64) > items[right]["updatedAt"].(int64)
	})
	return items, nil
}

// memoryBindings 汇总记忆库绑定关系：全局默认 + 每个角色的独立记忆库。
func (s *Server) memoryBindings() map[string][]map[string]any {
	result := map[string][]map[string]any{}
	appendBinding := func(rawPath string, binding map[string]any) {
		path := strings.TrimSpace(rawPath)
		if path == "" {
			return
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(s.rootDir, path)
		}
		path = filepath.Clean(path)
		result[path] = append(result[path], binding)
	}

	globalPath := s.document.String("bindings.global.memoryDbPath")
	if globalPath == "" {
		globalPath = s.document.String("memory.storage.path")
	}
	appendBinding(globalPath, map[string]any{"type": "global-default", "name": "全局默认记忆库"})

	if bindings := s.document.Get("bindings.characters"); bindings.Exists() && bindings.IsObject() {
		for character, value := range bindings.Map() {
			entry := value.Get("memoryDbPath").String()
			if strings.TrimSpace(entry) == "" {
				continue
			}
			appendBinding(entry, map[string]any{"type": "character", "name": character})
		}
	}
	return result
}

func (s *Server) handleMemoryDatabases(writer http.ResponseWriter, request *http.Request) {
	items, err := s.memoryDatabases()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	activePath := ""
	if database, path, err := s.openActiveMemory(); err == nil {
		activePath = path
		_ = database.Close()
	} else {
		activePath = path
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"success":   true,
		"databases": items,
		"active": map[string]any{
			"currentCharacter": s.currentCharacterName(),
			"dbPath":           activePath,
			"sessionMode":      s.document.String("chat.sessionMode"),
		},
	})
}

func (s *Server) handleMemoryDownload(writer http.ResponseWriter, request *http.Request) {
	requested := strings.TrimSpace(request.URL.Query().Get("path"))
	if requested == "" {
		writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "缺少 path 参数"})
		return
	}
	normalized := filepath.ToSlash(requested)
	basename := path.Base(normalized)
	paths, err := store.DiscoverMemoryDatabases(s.DataDir())
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	target := ""
	for _, candidate := range paths {
		relative, _ := filepath.Rel(s.rootDir, candidate)
		clientPath := "./" + filepath.ToSlash(relative)
		if candidate == requested || clientPath == normalized || path.Base(filepath.ToSlash(candidate)) == basename {
			target = candidate
			break
		}
	}
	if target == "" {
		s.logger.Printf("记忆库下载被拒绝（不在已知列表）: %s", requested)
		writeJSON(writer, http.StatusNotFound, map[string]any{"success": false, "error": "未找到该记忆库"})
		return
	}
	store.Checkpoint(target)
	info, err := os.Stat(target)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	filename := path.Base(filepath.ToSlash(target))
	s.logger.Printf("记忆库下载: %s", filename)
	writer.Header().Set("Content-Type", "application/vnd.sqlite3")
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	writer.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))
	file, err := os.Open(target)
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	defer file.Close()
	_, _ = io.Copy(writer, file)
}

func (s *Server) handleMemoryStats(writer http.ResponseWriter, request *http.Request) {
	items, err := s.memoryDatabases()
	if err != nil {
		writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
		return
	}
	totals := map[string]int64{"sessions": 0, "messages": 0, "summaries": 0, "memoryEntries": 0, "memoryNamespaces": 0}
	for _, item := range items {
		if counts, ok := item["stats"].(store.Counts); ok {
			totals["sessions"] += counts.Sessions
			totals["messages"] += counts.Messages
			totals["summaries"] += counts.Summaries
			totals["memoryEntries"] += counts.MemoryEntries
			totals["memoryNamespaces"] += counts.MemoryNamespaces
		}
	}
	// Node GET /api/memory/stats = sessionManager.getStats() + runtime + activeMemory
	counts := store.Counts{}
	activePath := ""
	oldest, newest := int64(0), int64(0)
	if database, path, err := s.openActiveMemory(); err == nil {
		activePath = path
		if c, err := database.Counts(); err == nil {
			counts = c
		}
		oldest, newest = database.MessageTimeRange()
		_ = database.Close()
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"databases":        items,
		"totals":           totals,
		"databaseCount":    len(items),
		"totalMessages":    counts.Messages,
		"totalSessions":    counts.Sessions,
		"totalSummaries":   counts.Summaries,
		"sessionMode":      fallback(s.document.String("chat.sessionMode"), "user_persistent"),
		"storage":          map[string]any{"type": "sqlite", "path": activePath},
		"oldestMessage":    nilIfZero(oldest),
		"newestMessage":    nilIfZero(newest),
		"memoryFileSizeMB": memoryFileSizeMB(activePath),
		"runtime":          nil,
		"activeMemory":     s.activeMemoryInfo(),
	})
}

// nilIfZero 把 0 视为未知（Node 无消息时为 null）。
func nilIfZero(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

// memoryFileSizeMB 返回记忆库文件大小（MB，两位小数）。
func memoryFileSizeMB(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return "0.00"
	}
	return fmt.Sprintf("%.2f", float64(info.Size())/1024/1024)
}

// ---------- MCP 入口（令牌校验占位） ----------

func (s *Server) handleMCP(writer http.ResponseWriter, request *http.Request) {
	token := s.document.String("mcp.token")
	if token != "" && !auth.TokenRequest(request, token) {
		writer.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(writer, http.StatusUnauthorized, map[string]any{
			"jsonrpc": "2.0",
			"id":      nil,
			"error":   map[string]any{"code": -32001, "message": "未授权：MCP 令牌无效"},
		})
		return
	}
	s.handleMCPRange(writer, request)
}

// ---------- 静态资源 ----------

func (s *Server) handleStatic(writer http.ResponseWriter, request *http.Request) {
	path := request.URL.Path
	if path == "/" {
		path = "/index.html"
	}
	// 登录页与静态资源放行
	open := path == "/login.html" || strings.HasPrefix(path, "/assets/") || strings.HasPrefix(path, "/favicon")
	if !open && !s.requestAuthorized(request) {
		if strings.HasPrefix(path, "/api/") {
			writeJSON(writer, http.StatusUnauthorized, map[string]any{"success": false, "error": "未登录"})
			return
		}
		http.Redirect(writer, request, "/login.html", http.StatusFound)
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(path, "/"))
	if strings.HasPrefix(clean, "..") {
		http.NotFound(writer, request)
		return
	}
	full := filepath.Join(s.publicDir, clean)
	info, err := os.Stat(full)
	if err != nil || info.IsDir() {
		http.NotFound(writer, request)
		return
	}
	http.ServeFile(writer, request, full)
}
