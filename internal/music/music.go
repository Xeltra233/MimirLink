// Package music 移植 Node src/music.js：点歌指令解析、ytmusic-bridge 桥接客户端、
// 会话状态、音频下载与语音/文件发送（ffmpeg 切段可注入便于测试）。
package music

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 常量对齐 Node 导出。
const (
	DefaultMusicBaseURL        = "http://127.0.0.1:8787"
	DefaultMusicCommand        = "/music"
	DefaultMusicExitCommand    = "/music-exit"
	DefaultVoiceSegmentSeconds = 120
	DefaultFFmpegPath          = "ffmpeg"
)

// AudioFormats / DownloadFormats 对齐 Node MUSIC_*_FORMATS。
var (
	AudioFormats    = []string{"mp3", "m4a", "opus"}
	DownloadFormats = []string{"mp3", "m4a", "opus", "mp4"}
	TrailingTokens  = []string{"mp3", "m4a", "opus", "flac", "file", "voice", "mv", "video", "official"}
)

// trailingParamRE：末尾独立白名单词（前面必须有正文）。
var trailingParamRE = regexp.MustCompile(`(?i)^([\s\S]*?\S)\s+(` + strings.Join(TrailingTokens, "|") + `)$`)

var fullWidthDigits = regexp.MustCompile(`[０-９]`)

// SanitizeText 对齐 Node sanitizeText。
func SanitizeText(value any) string {
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

// Config 是归一化后的点歌配置（对齐 Node normalizeMusicConfig）。
type Config struct {
	Enabled             bool
	Command             string
	ExitCommand         string
	BaseURL             string
	APIKey              string
	Limit               int
	MinScore            float64
	SearchTimeoutMs     int
	DownloadTimeoutMs   int
	SessionTTLMS        int
	MaxDurationSeconds  int
	VoiceSegmentSeconds int
	MaxFilesizeMB       int
	Format              string
}

// NormalizeConfig 应用 Node 默认值。
func NormalizeConfig(raw map[string]any) Config {
	clampInt := func(value any, min int, max int, fallback int) int {
		number, ok := toFloat(value)
		if !ok {
			return fallback
		}
		result := int(number)
		if result < min {
			return min
		}
		if result > max {
			return max
		}
		return result
	}
	config := Config{
		Enabled:             boolOf(raw["enabled"]),
		Command:             normalizeCommandText(SanitizeText(raw["command"]), DefaultMusicCommand),
		ExitCommand:         normalizeCommandText(SanitizeText(raw["exitCommand"]), DefaultMusicExitCommand),
		BaseURL:             orDefault(SanitizeText(raw["baseUrl"]), DefaultMusicBaseURL),
		APIKey:              stringOf(raw["apiKey"]),
		Limit:               clampInt(raw["limit"], 1, 20, 10),
		MinScore:            0.35,
		SearchTimeoutMs:     clampInt(raw["searchTimeoutMs"], 1000, 120000, 20000),
		DownloadTimeoutMs:   clampInt(raw["downloadTimeoutMs"], 5000, 600000, 300000),
		SessionTTLMS:        clampInt(raw["sessionTtlMs"], 60000, 3600000, 1800000),
		MaxDurationSeconds:  clampInt(raw["maxDurationSeconds"], 0, 7200, 900),
		VoiceSegmentSeconds: clampInt(raw["voiceSegmentSeconds"], 0, 600, DefaultVoiceSegmentSeconds),
		MaxFilesizeMB:       clampInt(raw["maxFilesizeMB"], 1, 200, 30),
		Format:              "mp3",
	}
	if score, ok := toFloat(raw["minScore"]); ok {
		if score < 0 {
			score = 0
		}
		if score > 1 {
			score = 1
		}
		config.MinScore = score
	}
	format := strings.ToLower(SanitizeText(raw["format"]))
	for _, candidate := range AudioFormats {
		if format == candidate {
			config.Format = format
		}
	}
	return config
}

func toFloat(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	}
	return 0, false
}

func boolOf(value any) bool {
	typed, ok := value.(bool)
	return ok && typed
}

func stringOf(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func orDefault(value string, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func normalizeCommandText(value string, fallback string) string {
	if value == "" || strings.ContainsAny(value, " \t\n") {
		return fallback
	}
	return value
}

// StripLeadingMentions 对齐 Node stripLeadingMentionsForCommand。
func StripLeadingMentions(text string) string {
	normalized := SanitizeText(text)
	atRe := regexp.MustCompile(`(?i)^\[@bot\]\s*`)
	anyAt := regexp.MustCompile(`^\[[^\]]*\]\s*`)
	cqAt := regexp.MustCompile(`(?i)^\[CQ:at,[^\]]*\]\s*`)
	bareAt := regexp.MustCompile(`^@\S+\s+`)
	previous := ""
	for normalized != "" && normalized != previous {
		previous = normalized
		normalized = strings.TrimSpace(atRe.ReplaceAllString(normalized, ""))
		normalized = strings.TrimSpace(cqAt.ReplaceAllString(normalized, ""))
		normalized = strings.TrimSpace(anyAt.ReplaceAllString(normalized, ""))
		normalized = strings.TrimSpace(bareAt.ReplaceAllString(normalized, ""))
	}
	return normalized
}

// BuildSessionKey 对齐 Node buildMusicSessionKey：群聊按群+用户隔离，私聊按用户隔离。
func BuildSessionKey(event map[string]any) string {
	userID := SanitizeText(event["user_id"])
	if SanitizeText(event["message_type"]) == "group" {
		return fmt.Sprintf("group:%s:user:%s", SanitizeText(event["group_id"]), userID)
	}
	return "private:" + userID
}

// TrailingParam 是剥离尾参的结果。
type TrailingParam struct {
	Body          string
	DeliveryMode  string // voice / file / video
	Format        string
	TrailingToken string
}

// SplitTrailingParam 对齐 Node splitMusicTrailingParam：只认最后一个独立白名单词。
func SplitTrailingParam(argument string) TrailingParam {
	text := SanitizeText(argument)
	if text == "" {
		return TrailingParam{DeliveryMode: "voice"}
	}
	match := trailingParamRE.FindStringSubmatch(text)
	if match == nil {
		return TrailingParam{Body: text, DeliveryMode: "voice"}
	}
	body := SanitizeText(match[1])
	if body == "" {
		return TrailingParam{Body: text, DeliveryMode: "voice"}
	}
	token := strings.ToLower(match[2])
	switch {
	case token == "voice":
		return TrailingParam{Body: body, DeliveryMode: "voice", TrailingToken: token}
	case token == "file":
		return TrailingParam{Body: body, DeliveryMode: "file", TrailingToken: token}
	case token == "mv" || token == "video" || token == "official":
		return TrailingParam{Body: body, DeliveryMode: "video", TrailingToken: token}
	default:
		// mp3/m4a/opus/flac => 文件发送 + 指定格式
		return TrailingParam{Body: body, DeliveryMode: "file", Format: token, TrailingToken: token}
	}
}

// DownloadFormat 是尾参到 /download format 的映射结果（对齐 Node resolveMusicDownloadFormat）。
type DownloadFormat struct {
	OK           bool
	DeliveryMode string
	Format       string
	Reason       string
	Message      string
}

// ResolveDownloadFormat 对齐 Node resolveMusicDownloadFormat。
func ResolveDownloadFormat(deliveryMode string, token string) DownloadFormat {
	rawDelivery := strings.ToLower(SanitizeText(deliveryMode))
	token = strings.ToLower(SanitizeText(token))
	if rawDelivery == "video" || token == "mv" || token == "video" || token == "official" {
		return DownloadFormat{OK: true, DeliveryMode: "video", Format: "mp4", Reason: "official_video"}
	}
	effective := deliveryMode
	if effective != "file" {
		effective = "voice"
	}
	if token == "flac" {
		return DownloadFormat{OK: false, DeliveryMode: "file", Format: "flac", Reason: "unsupported_format", Message: "暂不支持 flac，请改用 mp3 / m4a / opus"}
	}
	if effective == "voice" {
		return DownloadFormat{OK: true, DeliveryMode: "voice", Format: "opus"}
	}
	if token == "mp3" || token == "m4a" || token == "opus" {
		return DownloadFormat{OK: true, DeliveryMode: "file", Format: token}
	}
	return DownloadFormat{OK: true, DeliveryMode: "file", Format: "mp3"}
}

// matchesCommandPrefix 对齐 Node matchesCommandPrefix：命令后必须是边界或结束。
func matchesCommandPrefix(text string, command string) bool {
	if text == command {
		return true
	}
	if !strings.HasPrefix(text, command) {
		return false
	}
	next := text[len(command):]
	if next == "" {
		return false
	}
	first := strings.TrimSpace(next[:1])
	return first == "" || first != next[:1]
}

// ParsedCommand 是解析结果（对齐 Node parseMusicCommand 返回）。
type ParsedCommand struct {
	Type          string // none / exit / usage / select / search
	Index         int
	IndexSet      bool
	Name          string
	Query         string
	Raw           string
	DeliveryMode  string
	Format        string
	TrailingToken string
}

// ParseCommand 对齐 Node parseMusicCommand。
func ParseCommand(plainText string, command string, exitCommand string, session *Session) ParsedCommand {
	normalizedText := StripLeadingMentions(plainText)
	normalizedCommand := normalizeCommandText(SanitizeText(command), DefaultMusicCommand)
	normalizedExit := normalizeCommandText(SanitizeText(exitCommand), DefaultMusicExitCommand)
	none := ParsedCommand{Type: "none"}
	if normalizedText == "" {
		return none
	}
	if matchesCommandPrefix(normalizedText, normalizedExit) {
		return ParsedCommand{Type: "exit"}
	}
	if !matchesCommandPrefix(normalizedText, normalizedCommand) {
		return none
	}
	argument := SanitizeText(normalizedText[len(normalizedCommand):])
	if argument == "" {
		return ParsedCommand{Type: "usage"}
	}
	trailing := SplitTrailingParam(argument)
	if trailing.Body == "" {
		return ParsedCommand{Type: "usage"}
	}
	parsed := ParsedCommand{
		Type:          "search",
		Query:         trailing.Body,
		Raw:           trailing.Body,
		DeliveryMode:  trailing.DeliveryMode,
		Format:        trailing.Format,
		TrailingToken: trailing.TrailingToken,
	}
	if session != nil && len(session.Results) > 0 {
		numeric := fullWidthDigits.ReplaceAllStringFunc(trailing.Body, func(char string) string {
			return string(rune([]rune(char)[0] - 0xFEE0))
		})
		if regexp.MustCompile(`^\d+$`).MatchString(numeric) {
			index, _ := strconv.Atoi(numeric)
			parsed.Type = "select"
			parsed.Index = index
			parsed.IndexSet = true
			parsed.Query = ""
			return parsed
		}
		for _, item := range session.Results {
			if normalizeNameForMatch(SanitizeText(item["display_name"])) == normalizeNameForMatch(trailing.Body) {
				parsed.Type = "select"
				parsed.Name = SanitizeText(item["display_name"])
				parsed.Query = ""
				return parsed
			}
		}
	}
	return parsed
}

func normalizeNameForMatch(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

// Session 是一个点歌候选会话。
type Session struct {
	BridgeSessionID string
	Query           string
	Results         []map[string]any
	CreatedAt       time.Time
	ExpiresAt       time.Time
}

// SessionStore 对齐 Node MusicSessionStore（带过期淘汰、容量上限、下载互斥）。
type SessionStore struct {
	mu              sync.Mutex
	sessions        map[string]*Session
	order           []string
	activeDownloads map[string]bool
	maxSessions     int
	now             func() time.Time
}

// NewSessionStore 构造存储。
func NewSessionStore() *SessionStore {
	return &SessionStore{
		sessions:        map[string]*Session{},
		activeDownloads: map[string]bool{},
		maxSessions:     500,
		now:             time.Now,
	}
}

// Get 读取会话（过期自动删除）。
func (s *SessionStore) Get(key string) *Session {
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[key]
	if !ok {
		return nil
	}
	if !session.ExpiresAt.After(s.now()) {
		delete(s.sessions, key)
		s.removeOrder(key)
		return nil
	}
	return session
}

// Set 写入会话（LRU 顺序）。
func (s *SessionStore) Set(key string, session *Session, ttl time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pruneLocked()
	delete(s.sessions, key)
	s.removeOrder(key)
	session.CreatedAt = s.now()
	session.ExpiresAt = s.now().Add(ttl)
	s.sessions[key] = session
	s.order = append(s.order, key)
}

// Delete 删除会话，返回是否存在。
func (s *SessionStore) Delete(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, existed := s.sessions[key]
	delete(s.sessions, key)
	s.removeOrder(key)
	return existed
}

// AcquireDownload 尝试占用下载互斥位。
func (s *SessionStore) AcquireDownload(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.activeDownloads[key] {
		return false
	}
	s.activeDownloads[key] = true
	return true
}

// ReleaseDownload 释放下载互斥位。
func (s *SessionStore) ReleaseDownload(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.activeDownloads, key)
}

func (s *SessionStore) removeOrder(key string) {
	for index, item := range s.order {
		if item == key {
			s.order = append(s.order[:index], s.order[index+1:]...)
			break
		}
	}
}

func (s *SessionStore) pruneLocked() {
	current := s.now()
	for key, session := range s.sessions {
		if !session.ExpiresAt.After(current) {
			delete(s.sessions, key)
			s.removeOrder(key)
		}
	}
	for len(s.sessions) > s.maxSessions && len(s.order) > 0 {
		oldest := s.order[0]
		s.order = s.order[1:]
		delete(s.sessions, oldest)
	}
}

// BridgeError 对齐 Node MusicBridgeError。
type BridgeError struct {
	Message   string
	Status    int
	Code      string
	Detail    any
	Retryable bool
}

func (e *BridgeError) Error() string { return e.Message }

// BridgeClient 对齐 Node MusicBridgeClient：search/download + 可重试错误一次重试。
type BridgeClient struct {
	BaseURL string
	APIKey  string
	HTTP    *http.Client
	retried bool
}

func (c *BridgeClient) buildHeaders() map[string]string {
	headers := map[string]string{"Content-Type": "application/json; charset=utf-8"}
	if c.APIKey != "" {
		headers["X-API-Key"] = c.APIKey
	}
	return headers
}

func (c *BridgeClient) do(ctx context.Context, pathname string, body map[string]any, timeout time.Duration, config Config) (map[string]any, http.Header, []byte, error) {
	base := strings.TrimRight(config.BaseURL, "/")
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, nil, nil, &BridgeError{Message: "序列化请求失败: " + err.Error()}
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, base+pathname, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, nil, &BridgeError{Message: "构建请求失败: " + err.Error()}
	}
	for key, value := range c.buildHeaders() {
		request.Header.Set(key, value)
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		if requestContext.Err() == context.DeadlineExceeded {
			return nil, nil, nil, &BridgeError{Message: fmt.Sprintf("请求超时（%dms）", timeout.Milliseconds()), Code: "TIMEOUT", Retryable: true}
		}
		return nil, nil, nil, &BridgeError{Message: err.Error(), Code: "SERVICE_UNAVAILABLE"}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var payload map[string]any
		_ = json.NewDecoder(response.Body).Decode(&payload)
		code := SanitizeText(payload["code"])
		if code == "" {
			code = fmt.Sprintf("HTTP_%d", response.StatusCode)
		}
		message := SanitizeText(payload["message"])
		if message == "" {
			message = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		retryable := response.StatusCode == 429 || response.StatusCode == 502 || response.StatusCode == 504
		return nil, nil, nil, &BridgeError{Message: message, Status: response.StatusCode, Code: code, Detail: payload["detail"], Retryable: retryable}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 64*1024*1024))
	if err != nil {
		return nil, nil, nil, &BridgeError{Message: "读取响应失败: " + err.Error()}
	}
	var decoded map[string]any
	if pathname == "/search" {
		if err := json.Unmarshal(raw, &decoded); err != nil {
			return nil, nil, nil, &BridgeError{Message: "解析响应失败: " + err.Error()}
		}
	}
	return decoded, response.Header, raw, nil
}

// Search 对齐 Node search（可重试错误重试一次）。
func (c *BridgeClient) Search(ctx context.Context, query string, config Config) (map[string]any, error) {
	body := map[string]any{"query": query, "limit": config.Limit, "min_score": config.MinScore}
	result, _, _, err := c.do(ctx, "/search", body, time.Duration(config.SearchTimeoutMs)*time.Millisecond, config)
	if err != nil {
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) && bridgeErr.Retryable {
			result, _, _, err = c.do(ctx, "/search", body, time.Duration(config.SearchTimeoutMs)*time.Millisecond, config)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	return result, nil
}

// Track 是下载结果。
type Track struct {
	Buffer          []byte
	Format          string
	VideoID         string
	DurationSeconds float64
	CacheHit        bool
}

// Download 对齐 Node download：按 video_id/index/name 定位 + 大小限制。
func (c *BridgeClient) Download(ctx context.Context, sessionID string, index int, indexSet bool, name string, videoID string, format string, config Config) (*Track, error) {
	requestedFormat := strings.ToLower(orDefault(SanitizeText(format), orDefault(config.Format, "mp3")))
	if requestedFormat == "flac" {
		return nil, &BridgeError{Message: "暂不支持 flac，请改用 mp3 / m4a / opus", Code: "INVALID_REQUEST", Status: 400}
	}
	valid := false
	for _, candidate := range DownloadFormats {
		if requestedFormat == candidate {
			valid = true
		}
	}
	if !valid {
		requestedFormat = "mp3"
	}
	body := map[string]any{"format": requestedFormat}
	switch {
	case videoID != "":
		body["video_id"] = videoID
	case indexSet:
		body["session_id"] = sessionID
		body["index"] = index
	case name != "":
		body["session_id"] = sessionID
		body["name"] = name
	default:
		return nil, &BridgeError{Message: "缺少选歌方式（video_id / index / name）", Code: "INVALID_REQUEST"}
	}
	_, headers, raw, err := c.do(ctx, "/download", body, time.Duration(config.DownloadTimeoutMs)*time.Millisecond, config)
	if err != nil {
		var bridgeErr *BridgeError
		if errors.As(err, &bridgeErr) && bridgeErr.Retryable {
			_, headers, raw, err = c.do(ctx, "/download", body, time.Duration(config.DownloadTimeoutMs)*time.Millisecond, config)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	maxBytes := config.MaxFilesizeMB * 1024 * 1024
	if contentLength, convErr := strconv.Atoi(strings.TrimSpace(headers.Get("Content-Length"))); convErr == nil && contentLength > maxBytes {
		return nil, &BridgeError{
			Message: fmt.Sprintf("音频 %.1fMB 超过上限 %dMB", float64(contentLength)/1024/1024, config.MaxFilesizeMB),
			Code:    "FILE_TOO_LARGE", Status: 413,
		}
	}
	if len(raw) > maxBytes {
		return nil, &BridgeError{
			Message: fmt.Sprintf("音频 %.1fMB 超过上限 %dMB", float64(len(raw))/1024/1024, config.MaxFilesizeMB),
			Code:    "FILE_TOO_LARGE", Status: 413,
		}
	}
	track := &Track{Buffer: raw, Format: requestedFormat}
	if videoID != "" {
		track.VideoID = videoID
	}
	return track, nil
}

// FormatSearchList 对齐 Node formatMusicSearchList。
func FormatSearchList(query string, results []map[string]any, command string, exitCommand string, expiresInSeconds int, truncated bool) string {
	lines := make([]string, 0, len(results))
	for _, result := range results {
		durationText := ""
		if duration := formatDuration(result); duration != "" {
			durationText = fmt.Sprintf("（%s）", duration)
		}
		mvMark := ""
		if official := NormalizeOfficialVideoFields(result); official["has_official_video"] == true {
			mvMark = " [MV]"
		}
		index := SanitizeText(result["index"])
		lines = append(lines, fmt.Sprintf("%s. %s%s%s", index, SanitizeText(result["display_name"]), durationText, mvMark))
	}
	minutes := expiresInSeconds / 60
	if minutes < 1 {
		minutes = 1
	}
	header := fmt.Sprintf("🎵 「%s」的搜索结果（%d 条", SanitizeText(query), len(results))
	if truncated {
		header += "，上游还有更多"
	}
	header += "）"
	footer := strings.Join([]string{
		fmt.Sprintf("回复 %s 序号 选歌，例如 %s 1（默认语音；末尾加 mp3 发文件，加 mv 发官方视频）", command, command),
		fmt.Sprintf("也可以回复 %s 完整歌名", command),
		fmt.Sprintf("选错了可重发序号；退出请发 %s", exitCommand),
		fmt.Sprintf("%d 分钟内有效", minutes),
	}, "\n")
	return header + "\n" + strings.Join(lines, "\n") + "\n" + footer
}

func formatDuration(result map[string]any) string {
	if text := SanitizeText(result["duration"]); text != "" {
		return text
	}
	seconds, ok := toFloat(result["duration_seconds"])
	if !ok || seconds <= 0 {
		return ""
	}
	minutes := int(seconds) / 60
	remainder := int(seconds) % 60
	return fmt.Sprintf("%d:%02d", minutes, remainder)
}

// NormalizeOfficialVideoFields 对齐 Node normalizeOfficialVideoFields。
func NormalizeOfficialVideoFields(result map[string]any) map[string]any {
	official := map[string]any{}
	officialVideoID := SanitizeText(result["official_video_id"])
	officialVideoURL := SanitizeText(result["official_video_url"])
	official["official_video_id"] = officialVideoID
	official["official_video_url"] = officialVideoURL
	official["has_official_video"] = officialVideoID != "" || officialVideoURL != ""
	return official
}

// BuildOfficialVideoMessage 对齐 Node buildOfficialVideoMessage。
func BuildOfficialVideoMessage(picked map[string]any) string {
	official := NormalizeOfficialVideoFields(picked)
	title := SanitizeText(picked["display_name"])
	if title == "" {
		title = SanitizeText(picked["title"])
	}
	if title == "" {
		title = "所选歌曲"
	}
	url := SanitizeText(official["official_video_url"])
	id := SanitizeText(official["official_video_id"])
	if url == "" && id == "" {
		return ""
	}
	link := url
	if link == "" {
		link = "https://www.youtube.com/watch?v=" + id
	}
	return fmt.Sprintf("🎬 「%s」官方视频：\n%s", title, link)
}

// UserFacingBridgeMessage 对齐 Node buildUserFacingBridgeMessage 的错误文案映射。
func UserFacingBridgeMessage(err error, command string, exitCommand string) string {
	bridgeErr, ok := err.(*BridgeError)
	if !ok {
		return "点歌失败：" + err.Error()
	}
	switch bridgeErr.Code {
	case "SESSION_EXPIRED":
		return fmt.Sprintf("点歌候选已过期，请重新发送 %s 歌名 搜索", command)
	case "AMBIGUOUS_NAME":
		return "歌名匹配到多首同名歌曲，请改用序号选歌"
	case "NOT_FOUND":
		return "没找到这首候选（序号越界或歌名不匹配），请重新选一次"
	case "FILE_TOO_LARGE":
		return "这首歌文件太大，QQ 语音发不出去，换一首试试"
	case "RATE_LIMITED":
		return "点歌服务正在忙（下载排队已满），稍后再试一次"
	case "UNAUTHORIZED":
		return "点歌服务鉴权失败，请管理员检查音乐桥接的 API Key"
	case "INVALID_REQUEST":
		return "点歌参数不对：" + bridgeErr.Message
	case "UPSTREAM_ERROR":
		return "上游 YouTube Music 解析失败，稍后再试"
	case "TIMEOUT":
		return "点歌服务响应超时，稍后再试"
	}
	if bridgeErr.Code == "SERVICE_UNAVAILABLE" {
		return fmt.Sprintf("点歌服务连不上（%s），请管理员检查 ytmusic-bridge 是否启动。退出点歌可发 %s", bridgeErr.Message, exitCommand)
	}
	return "点歌失败：" + bridgeErr.Message
}

// BuildFileName 对齐 Node buildMusicFileName。
func BuildFileName(picked map[string]any, fallbackName string, format string) string {
	raw := SanitizeText(picked["display_name"])
	if raw == "" {
		raw = SanitizeText(picked["title"])
	}
	if raw == "" {
		raw = SanitizeText(fallbackName)
	}
	if raw == "" {
		raw = "track"
	}
	base := strings.NewReplacer("+", " ", "\\", "_", "/", "_", ":", "_", "*", "_", "?", "_", "\"", "_", "<", "_", ">", "_", "|", "_").
		Replace(raw)
	spaceRe := regexp.MustCompile(`\s+`)
	base = spaceRe.ReplaceAllString(strings.TrimSpace(base), " ")
	runes := []rune(base)
	if len(runes) > 80 {
		base = string(runes[:80])
	}
	if base == "" {
		base = "track"
	}
	ext := strings.ToLower(orDefault(SanitizeText(format), "mp3"))
	if ext == "" {
		ext = "mp3"
	}
	return base + "." + ext
}

func buildTrackLabel(track *Track, fallback string) string {
	title := SanitizeText(trackLabelOf(track))
	_ = title
	return fallback
}

func trackLabelOf(track *Track) string { return "" }

// randomHex 生成随机后缀。
func randomHex(length int) string {
	buffer := make([]byte, length)
	_, _ = rand.Read(buffer)
	return hex.EncodeToString(buffer)
}

// writeAudioFile 把音频写入临时目录（文件名只用时间戳与随机串，防路径穿越）。
func writeAudioFile(audioDir string, track *Track) (string, error) {
	if audioDir == "" {
		return "", errors.New("未配置音频临时目录")
	}
	if err := os.MkdirAll(audioDir, 0o755); err != nil {
		return "", err
	}
	filePath := filepath.Join(audioDir, fmt.Sprintf("music_%d_%s.%s", time.Now().UnixMilli(), randomHex(4), track.Format))
	if err := os.WriteFile(filePath, track.Buffer, 0o644); err != nil {
		return "", err
	}
	return filePath, nil
}

// splitAudioForVoice 对齐 Node splitAudioForVoice：优先流复制切段，失败回退 mp3 转码切段，再失败回退整段。
func splitAudioForVoice(audioDir string, ffmpegPath string, audioPath string, segmentSeconds int, durationSeconds float64, runCommand func(string, []string, time.Duration) error, warn func(string)) []string {
	if segmentSeconds <= 0 {
		return []string{audioPath}
	}
	if durationSeconds > 0 && durationSeconds <= float64(segmentSeconds) {
		return []string{audioPath}
	}
	if audioDir == "" {
		warn("未配置音频临时目录")
		return []string{audioPath}
	}
	inputExt := strings.TrimPrefix(strings.ToLower(filepath.Ext(audioPath)), ".")
	if inputExt == "" {
		inputExt = "mp3"
	}
	copyPattern := filepath.Join(audioDir, fmt.Sprintf("music_seg_%d_%s_%%03d.%s", time.Now().UnixMilli(), randomHex(3), inputExt))
	run := runCommand
	if run == nil {
		run = defaultRunCommand
	}
	timeout := 120 * time.Second
	// 1) 流复制
	copyErr := run(ffmpegPath, []string{"-y", "-i", audioPath, "-f", "segment", "-segment_time", strconv.Itoa(segmentSeconds), "-reset_timestamps", "1", "-c", "copy", copyPattern}, timeout)
	if copyErr == nil {
		if segments := collectSegments(audioDir, copyPattern, inputExt); len(segments) > 0 {
			return segments
		}
	} else if warn != nil {
		warn("流复制切段失败，改用 mp3 转码切段: " + copyErr.Error())
	}
	// 2) 回退转码
	mp3Pattern := filepath.Join(audioDir, fmt.Sprintf("music_seg_%d_%s_%%03d.mp3", time.Now().UnixMilli(), randomHex(3)))
	encodeErr := run(ffmpegPath, []string{"-y", "-i", audioPath, "-f", "segment", "-segment_time", strconv.Itoa(segmentSeconds), "-reset_timestamps", "1", "-ar", "44100", "-ac", "2", "-c:a", "libmp3lame", "-b:a", "192k", mp3Pattern}, timeout)
	if encodeErr == nil {
		if segments := collectSegments(audioDir, mp3Pattern, "mp3"); len(segments) > 0 {
			return segments
		}
	}
	if warn != nil {
		warn("语音切段失败，回退整段发送")
	}
	return []string{audioPath}
}

func collectSegments(audioDir string, pattern string, ext string) []string {
	prefix := strings.Split(filepath.Base(pattern), "%03d")[0]
	entries, err := os.ReadDir(audioDir)
	if err != nil {
		return nil
	}
	names := []string{}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, prefix) && strings.HasSuffix(name, "."+ext) {
			names = append(names, filepath.Join(audioDir, name))
		}
	}
	// 排序保证分段顺序
	for i := 0; i < len(names); i++ {
		for j := i + 1; j < len(names); j++ {
			if names[j] < names[i] {
				names[i], names[j] = names[j], names[i]
			}
		}
	}
	return names
}

func defaultRunCommand(command string, args []string, timeout time.Duration) error {
	// 与 Node defaultRunCommand 等价：隐藏窗口、stderr 截断、超时强杀
	return runProcess(command, args, timeout)
}

// Handler 是点歌指令处理器（对齐 Node MusicCommandHandler）。
type Handler struct {
	Config     func() map[string]any
	Client     *BridgeClient
	Store      *SessionStore
	AudioDir   string
	FFmpegPath string
	RunCommand func(string, []string, time.Duration) error
	Warn       func(string)
}

// Senders 是发送动作集合（由运行时注入，隔离群聊/私聊差异）。
type Senders struct {
	SendText  func(string) error
	SendVoice func(string) error
	SendFile  func(string, string) error
}

// Result 是 handle 的结果。
type Result struct {
	Handled bool
	OK      bool
	Reason  string
}

// Handle 对齐 Node MusicCommandHandler.handle。
func (h *Handler) Handle(ctx context.Context, event map[string]any, plainText string, senders Senders) Result {
	config := NormalizeConfig(h.Config())
	sessionKey := BuildSessionKey(event)
	session := h.store().Get(sessionKey)
	parsed := ParseCommand(plainText, config.Command, config.ExitCommand, session)
	if parsed.Type == "none" {
		return Result{Reason: "not_command"}
	}
	reply := func(text string) {
		if senders.SendText != nil {
			_ = senders.SendText(text)
		}
	}
	if !config.Enabled {
		reply(fmt.Sprintf("点歌功能未启用。请管理员在配置里打开「启用点歌指令」，并填写音乐 API 地址（%s）", orDefault(config.BaseURL, DefaultMusicBaseURL)))
		return Result{Handled: true, Reason: "disabled"}
	}
	switch parsed.Type {
	case "exit":
		existed := h.store().Delete(sessionKey)
		if existed {
			reply("已退出点歌状态，候选列表已清空")
		} else {
			reply("当前没有点歌状态")
		}
		return Result{Handled: true, OK: existed, Reason: "exit"}
	case "usage":
		reply(fmt.Sprintf("用法：%s 歌名（搜索）或 %s 序号（选歌）", config.Command, config.Command))
		return Result{Handled: true, Reason: "usage"}
	case "search":
		return h.handleSearch(ctx, config, sessionKey, parsed, reply)
	case "select":
		return h.handleSelect(ctx, config, sessionKey, session, parsed, reply, senders)
	}
	return Result{Reason: "unknown"}
}

func (h *Handler) store() *SessionStore {
	if h.Store != nil {
		return h.Store
	}
	h.Store = NewSessionStore()
	return h.Store
}

func (h *Handler) handleSearch(ctx context.Context, config Config, sessionKey string, parsed ParsedCommand, reply func(string)) Result {
	reply(fmt.Sprintf("🔍 正在搜索「%s」，请稍等", parsed.Query))
	payload, err := h.client().Search(ctx, parsed.Query, config)
	if err != nil {
		if h.Warn != nil {
			h.Warn("[点歌] 搜索失败: " + err.Error())
		}
		reply("⚠️ " + UserFacingBridgeMessage(err, config.Command, config.ExitCommand))
		return Result{Handled: true, Reason: "search_failed"}
	}
	results, _ := payload["results"].([]any)
	mapped := make([]map[string]any, 0, len(results))
	for _, item := range results {
		if entry, ok := item.(map[string]any); ok {
			mapped = append(mapped, entry)
		}
	}
	bridgeSessionID := SanitizeText(payload["session_id"])
	if len(mapped) == 0 || bridgeSessionID == "" {
		h.store().Delete(sessionKey)
		reply(fmt.Sprintf("没搜到「%s」，换个关键词或加上歌手名再试试", parsed.Query))
		return Result{Handled: true, Reason: "empty_result"}
	}
	ttl := time.Duration(config.SessionTTLMS) * time.Millisecond
	if expiresIn, ok := toFloat(payload["expires_in"]); ok && expiresIn > 0 {
		candidate := time.Duration(expiresIn) * time.Second
		if candidate < ttl {
			ttl = candidate
		}
	}
	h.store().Set(sessionKey, &Session{BridgeSessionID: bridgeSessionID, Query: parsed.Query, Results: mapped}, ttl)
	reply(FormatSearchList(parsed.Query, mapped, config.Command, config.ExitCommand, int(ttl.Milliseconds()/1000), payload["truncated"] == true))
	return Result{Handled: true, OK: true, Reason: "search"}
}

func (h *Handler) client() *BridgeClient {
	if h.Client != nil {
		return h.Client
	}
	config := NormalizeConfig(h.Config())
	h.Client = &BridgeClient{BaseURL: config.BaseURL, APIKey: config.APIKey}
	return h.Client
}

func (h *Handler) handleSelect(ctx context.Context, config Config, sessionKey string, session *Session, parsed ParsedCommand, reply func(string), senders Senders) Result {
	if session == nil {
		reply(fmt.Sprintf("当前没有候选歌单，请先发送 %s 歌名 搜索", config.Command))
		return Result{Handled: true, Reason: "no_session"}
	}
	picked := map[string]any{}
	if parsed.IndexSet {
		for _, item := range session.Results {
			if index, ok := toFloat(item["index"]); ok && int(index) == parsed.Index {
				picked = item
				break
			}
		}
		if picked == nil {
			reply(fmt.Sprintf("序号 %d 不在候选里，请选 1 - %d。选错了可重发序号，或发 %s 退出", parsed.Index, len(session.Results), config.ExitCommand))
			return Result{Handled: true, Reason: "index_out_of_range"}
		}
	} else {
		for _, item := range session.Results {
			if normalizeNameForMatch(SanitizeText(item["display_name"])) == normalizeNameForMatch(parsed.Name) {
				picked = item
				break
			}
		}
		if picked == nil {
			reply(fmt.Sprintf("候选里没有「%s」，请改用序号选歌。选错了可重发正确序号，或发 %s 退出", parsed.Name, config.ExitCommand))
			return Result{Handled: true, Reason: "name_not_found"}
		}
	}
	if config.MaxDurationSeconds > 0 {
		if duration, ok := toFloat(picked["duration_seconds"]); ok && duration > float64(config.MaxDurationSeconds) {
			reply(fmt.Sprintf("「%s」时长超过上限 %d 分钟，换一首吧", SanitizeText(picked["display_name"]), config.MaxDurationSeconds/60))
			return Result{Handled: true, Reason: "too_long"}
		}
	}
	if !h.store().AcquireDownload(sessionKey) {
		reply("你上一首还在下载中，等这首发出来再点下一首")
		return Result{Handled: true, Reason: "user_busy"}
	}
	resolved := ResolveDownloadFormat(parsed.DeliveryMode, orDefault(parsed.Format, parsed.TrailingToken))
	if !resolved.OK {
		reply(orDefault(resolved.Message, "暂不支持该音频格式，请改用 mp3 / m4a / opus"))
		h.store().ReleaseDownload(sessionKey)
		return Result{Handled: true, Reason: resolved.Reason}
	}
	createdPaths := []string{}
	defer func() {
		h.store().ReleaseDownload(sessionKey)
		for _, filePath := range createdPaths {
			_ = os.Remove(filePath)
		}
	}()

	if resolved.DeliveryMode == "video" {
		official := NormalizeOfficialVideoFields(picked)
		if official["has_official_video"] != true {
			reply(fmt.Sprintf("「%s」没有匹配到官方视频。可改发 %s %s 听音频，或换一首再试 mv", SanitizeText(picked["display_name"]), config.Command, orDefault(SanitizeText(picked["index"]), "1")))
			return Result{Handled: true, Reason: "no_official_video"}
		}
		if senders.SendFile == nil {
			message := BuildOfficialVideoMessage(picked)
			if message != "" {
				reply(message)
			} else {
				reply(fmt.Sprintf("「%s」有官方视频，但当前会话不支持发文件", SanitizeText(picked["display_name"])))
			}
			return Result{Handled: true, OK: message != "", Reason: "sent_official_video_link_fallback"}
		}
		reply(fmt.Sprintf("🎬 正在下载「%s」官方视频文件（mp4），请稍等", SanitizeText(picked["display_name"])))
		track, err := h.client().Download(ctx, session.BridgeSessionID, 0, false, "", SanitizeText(official["official_video_id"]), "mp4", config)
		if err != nil {
			link := BuildOfficialVideoMessage(picked)
			if link != "" {
				reply(fmt.Sprintf("官方视频文件下载失败（%s），先发链接：\n%s", err.Error(), strings.TrimPrefix(strings.SplitN(link, "\n", 2)[1], "")))
				return Result{Handled: true, OK: true, Reason: "sent_official_video_link_fallback"}
			}
			reply("⚠️ " + UserFacingBridgeMessage(err, config.Command, config.ExitCommand))
			return Result{Handled: true, Reason: "download_failed"}
		}
		filePath, writeErr := writeAudioFile(h.AudioDir, track)
		if writeErr != nil {
			reply("⚠️ 保存音频失败：" + writeErr.Error())
			return Result{Handled: true, Reason: "write_failed"}
		}
		createdPaths = append(createdPaths, filePath)
		fileName := BuildFileName(picked, picked["display_name"].(string), track.Format)
		if err := senders.SendFile(filePath, fileName); err != nil {
			reply("⚠️ 发送视频文件失败：" + err.Error())
			return Result{Handled: true, Reason: "send_failed"}
		}
		return Result{Handled: true, OK: true, Reason: "sent_official_video_file"}
	}

	if resolved.DeliveryMode == "file" {
		reply(fmt.Sprintf("📁 正在下载「%s」并按文件发送（%s），请稍等", SanitizeText(picked["display_name"]), resolved.Format))
	} else {
		reply(fmt.Sprintf("🎵 正在下载「%s」，转成语音后发出来，请稍等", SanitizeText(picked["display_name"])))
	}
	track, err := h.client().Download(ctx, session.BridgeSessionID, parsed.Index, parsed.IndexSet, parsed.Name, "", resolved.Format, config)
	if err != nil {
		if bridgeErr, ok := err.(*BridgeError); ok && bridgeErr.Code == "SESSION_EXPIRED" {
			h.store().Delete(sessionKey)
		}
		reply("⚠️ " + UserFacingBridgeMessage(err, config.Command, config.ExitCommand))
		return Result{Handled: true, Reason: "download_failed"}
	}
	audioPath, writeErr := writeAudioFile(h.AudioDir, track)
	if writeErr != nil {
		reply("⚠️ 保存音频失败：" + writeErr.Error())
		return Result{Handled: true, Reason: "write_failed"}
	}
	createdPaths = append(createdPaths, audioPath)

	if resolved.DeliveryMode == "file" {
		if senders.SendFile == nil {
			reply("当前会话不支持发送文件")
			return Result{Handled: true, Reason: "no_file_sender"}
		}
		fileName := BuildFileName(picked, SanitizeText(picked["display_name"]), track.Format)
		if err := senders.SendFile(audioPath, fileName); err != nil {
			reply("⚠️ 发送文件失败：" + err.Error())
			return Result{Handled: true, Reason: "send_failed"}
		}
		return Result{Handled: true, OK: true, Reason: "sent_file"}
	}

	if senders.SendVoice == nil {
		reply("当前会话不支持发送语音")
		return Result{Handled: true, Reason: "no_voice_sender"}
	}
	segmentPaths := splitAudioForVoice(h.AudioDir, orDefault(h.FFmpegPath, DefaultFFmpegPath), audioPath, config.VoiceSegmentSeconds, track.DurationSeconds, h.RunCommand, h.Warn)
	for index, segmentPath := range segmentPaths {
		if index > 0 {
			time.Sleep(350 * time.Millisecond)
		}
		if err := senders.SendVoice(segmentPath); err != nil {
			reply("⚠️ 发送语音失败：" + err.Error())
			return Result{Handled: true, Reason: "send_failed"}
		}
	}
	if len(segmentPaths) > 1 {
		reply(fmt.Sprintf("✅ 「%s」已分 %d 段发完", SanitizeText(picked["display_name"]), len(segmentPaths)))
	}
	return Result{Handled: true, OK: true, Reason: "sent"}
}
