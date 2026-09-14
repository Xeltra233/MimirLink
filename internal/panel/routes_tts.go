package panel

import (
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"mimirlink/internal/tts"
)

// registerTTSRoutes 注册 TTS 相关路由（形状对齐 Node 版 src/routes.js）。
func (s *Server) registerTTSRoutes(manager *tts.Manager) {
	s.mux.HandleFunc("/api/tts/config", s.requireAuth(s.handleTTSConfig))
	s.mux.HandleFunc("/api/tts/voices", s.requireAuth(s.handleTTSVoices))
	s.mux.HandleFunc("/api/tts/test", s.requireAuth(s.handleTTSTest(manager)))
	s.mux.HandleFunc("/audio/", s.requireAuth(s.handleAudioFile(manager)))
}

// handleTTSConfig GET 返回脱敏配置；POST 保存（apiKey 为 '******' 或缺失时保留原值）。
func (s *Server) handleTTSConfig(writer http.ResponseWriter, request *http.Request) {
	switch request.Method {
	case http.MethodGet:
		raw := map[string]any{}
		result := s.document.Get("tts")
		if result.IsObject() {
			if err := json.Unmarshal([]byte(result.Raw), &raw); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
		}
		safe := map[string]any{}
		hasKey := false
		for key, value := range raw {
			if key == "apiKey" || key == "accessToken" || key == "token" {
				if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
					hasKey = true
				}
				continue
			}
			safe[key] = value
		}
		safe["hasApiKey"] = hasKey
		writeJSON(writer, http.StatusOK, safe)
	case http.MethodPost:
		var incoming map[string]any
		if err := json.NewDecoder(io.LimitReader(request.Body, 1024*1024)).Decode(&incoming); err != nil {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请求体格式错误"})
			return
		}
		current := s.document.Get("tts.apiKey").String()
		hasIncoming := false
		incomingKey := ""
		for _, key := range []string{"apiKey", "accessToken", "token"} {
			if value, ok := incoming[key]; ok {
				hasIncoming = true
				if text, ok := value.(string); ok && text != "" {
					incomingKey = text
				}
			}
		}
		resolvedKey := current
		if hasIncoming && incomingKey != "******" {
			resolvedKey = incomingKey
		}
		stringOr := func(keys ...string) string {
			for _, key := range keys {
				if value, ok := incoming[key]; ok {
					if text, ok := value.(string); ok {
						return text
					}
				}
			}
			return ""
		}
		numberOr := func(keys ...string) any {
			for _, key := range keys {
				if value, ok := incoming[key]; ok {
					return value
				}
			}
			return nil
		}
		updates := map[string]any{
			"provider": fallback(stringOr("provider"), "doubao"),
			"baseUrl":  stringOr("baseUrl"),
			"apiKey":   resolvedKey,
			"modelId":  fallback(stringOr("modelId", "model"), ""),
			"voiceId":  fallback(stringOr("voiceId", "voiceType"), ""),
			"appId":    fallback(stringOr("appId", "appid"), ""),
		}
		if value := numberOr("speed", "speedRatio"); value != nil {
			updates["speed"] = value
		}
		if value := numberOr("volume", "volumeRatio"); value != nil {
			updates["volume"] = value
		}
		if value := numberOr("pitch", "pitchRatio"); value != nil {
			updates["pitch"] = value
		}
		if value, ok := incoming["enabled"]; ok {
			updates["enabled"] = value == true
		}
		if value := stringOr("encoding"); value != "" {
			updates["encoding"] = value
		}
		// 新增 provider 的扩展字段（qwen/mimo）
		if value := stringOr("languageType"); value != "" {
			updates["languageType"] = value
		}
		if value := stringOr("styleInstruction"); value != "" {
			updates["styleInstruction"] = value
		}
		for key, value := range updates {
			if err := s.document.Set("tts."+key, value); err != nil {
				writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
				return
			}
		}
		if err := s.document.Save(); err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		s.logger.Printf("TTS 配置已保存 provider=%s voiceId=%v hasApiKey=%v",
			updates["provider"], updates["voiceId"], resolvedKey != "")
		writeJSON(writer, http.StatusOK, map[string]any{"success": true, "message": "TTS 配置已保存"})
	default:
		writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "方法不支持"})
	}
}

// handleTTSVoices 返回当前 provider 的音色列表（[{id,name}]）。
func (s *Server) handleTTSVoices(writer http.ResponseWriter, request *http.Request) {
	provider := request.URL.Query().Get("provider")
	if provider == "" {
		provider = s.document.String("tts.provider")
	}
	if provider == "" {
		provider = "doubao"
	}
	writeJSON(writer, http.StatusOK, tts.VoicesForProvider(provider))
}

// handleTTSTest 合成测试文本并返回可访问的 URL。
func (s *Server) handleTTSTest(manager *tts.Manager) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			writeJSON(writer, http.StatusMethodNotAllowed, map[string]any{"success": false, "error": "仅支持 POST"})
			return
		}
		var payload struct {
			Text string `json:"text"`
		}
		if err := json.NewDecoder(io.LimitReader(request.Body, 64*1024)).Decode(&payload); err != nil || strings.TrimSpace(payload.Text) == "" {
			writeJSON(writer, http.StatusBadRequest, map[string]any{"success": false, "error": "请提供测试文本"})
			return
		}
		// 合成前同步配置，保证面板刚保存的参数立即生效
		manager.UpdateConfig(map[string]any{
			"enabled":          s.document.Bool("tts.enabled"),
			"provider":         s.document.String("tts.provider"),
			"baseUrl":          s.document.String("tts.baseUrl"),
			"apiKey":           s.document.String("tts.apiKey"),
			"modelId":          s.document.String("tts.modelId"),
			"voiceId":          s.document.String("tts.voiceId"),
			"appId":            s.document.String("tts.appId"),
			"encoding":         s.document.String("tts.encoding"),
			"languageType":     s.document.String("tts.languageType"),
			"styleInstruction": s.document.String("tts.styleInstruction"),
		})
		path, err := manager.Synthesize(request.Context(), payload.Text)
		if err != nil {
			writeJSON(writer, http.StatusInternalServerError, map[string]any{"success": false, "error": err.Error()})
			return
		}
		filename := filepath.Base(path)
		writeJSON(writer, http.StatusOK, map[string]any{
			"success":  true,
			"audioUrl": "/audio/" + filename,
			"filePath": path,
			"message":  "语音合成成功",
		})
	}
}

// handleAudioFile 提供合成音频的静态下载（限定 audio 目录内、tts_ 前缀文件）。
func (s *Server) handleAudioFile(manager *tts.Manager) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		name := strings.TrimPrefix(request.URL.Path, "/audio/")
		name = filepath.Base(name) // 拒绝路径穿越
		if !strings.HasPrefix(name, "tts_") {
			writeJSON(writer, http.StatusNotFound, map[string]any{"error": "音频不存在"})
			return
		}
		path := filepath.Join(manager.AudioDir(), name)
		data, err := os.ReadFile(path)
		if err != nil {
			writeJSON(writer, http.StatusNotFound, map[string]any{"error": "音频不存在"})
			return
		}
		contentType := mime.TypeByExtension(filepath.Ext(name))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		writer.Header().Set("Content-Type", contentType)
		writer.Header().Set("Content-Disposition", "inline; filename="+name)
		_, _ = writer.Write(data)
	}
}
