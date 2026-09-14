package tts

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func decodeBase64(value string) ([]byte, error) { return base64.StdEncoding.DecodeString(value) }

// postJSON 发送 JSON 请求并返回响应体（限 16MB）。
func postJSON(ctx context.Context, url string, headers map[string]string, body []byte) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 16*1024*1024))
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d: %s", response.StatusCode, truncateForLog(string(data), 300))
	}
	return data, nil
}

func truncateForLog(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit]) + "…"
}

// writeAudioFile 将音频写入缓存目录并返回路径。
func (m *Manager) writeAudioFile(audio []byte) (string, error) {
	return m.writeAudioFileExt(audio, m.config.Encoding)
}

// writeAudioFileExt 用指定扩展名写入音频文件。
func (m *Manager) writeAudioFileExt(audio []byte, extension string) (string, error) {
	filename := fmt.Sprintf("tts_%d.%s", m.nowFunc().UnixMilli(), extension)
	path := filepath.Join(m.audio, filename)
	if err := os.WriteFile(path, audio, 0o644); err != nil {
		return "", fmt.Errorf("写入音频文件失败: %w", err)
	}
	m.logger.Printf("[TTS %s] 音频已保存 bytes=%d file=%s", m.config.Provider, len(audio), filename)
	return path, nil
}

// ---------- MiniMax: POST {base}/v1/t2a_v2，音频以 hex 返回 ----------

func (m *Manager) synthesizeMinimax(ctx context.Context, text string) (string, error) {
	url := fmt.Sprintf("%s/v1/t2a_v2", m.ResolvedBaseURL())
	body := map[string]any{
		"model":         m.config.ModelID,
		"text":          text,
		"stream":        false,
		"output_format": "hex",
		"voice_setting": map[string]any{
			"voice_id": m.config.VoiceID,
			"speed":    m.config.Speed,
			"vol":      m.config.Volume,
			"pitch":    int64(m.config.Pitch),
		},
		"audio_setting": map[string]any{
			"format": m.config.Encoding,
		},
	}
	encoded, _ := json.Marshal(body)
	data, err := postJSON(ctx, url, map[string]string{"Authorization": "Bearer " + m.config.APIKey}, encoded)
	if err != nil {
		return "", fmt.Errorf("Minimax TTS 请求失败: %w", err)
	}
	var payload struct {
		BaseResp struct {
			StatusCode int    `json:"status_code"`
			StatusMsg  string `json:"status_msg"`
		} `json:"base_resp"`
		Data struct {
			Audio string `json:"audio"`
		} `json:"data"`
		Audio string `json:"audio"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("Minimax TTS 响应解析失败: %w", err)
	}
	if payload.BaseResp.StatusCode != 0 {
		return "", fmt.Errorf("Minimax TTS 请求失败: %s (%d)", payload.BaseResp.StatusMsg, payload.BaseResp.StatusCode)
	}
	audioHex := payload.Data.Audio
	if audioHex == "" {
		audioHex = payload.Audio
	}
	if audioHex == "" {
		return "", fmt.Errorf("Minimax TTS 返回中没有音频数据")
	}
	audio, err := hex.DecodeString(strings.TrimSpace(audioHex))
	if err != nil {
		return "", fmt.Errorf("Minimax TTS 音频解码失败: %w", err)
	}
	return m.writeAudioFile(audio)
}

// ---------- Qwen(DashScope): POST /services/aigc/multimodal-generation/generation，返回音频 URL ----------

func (m *Manager) synthesizeQwen(ctx context.Context, text string) (string, error) {
	base := strings.TrimSuffix(m.config.BaseURL, "/")
	if base == "" {
		base = qwenDefaultBaseURL
	} else if !strings.Contains(base, "/api/v1") {
		base = strings.TrimSuffix(base, "/v1") + "/api/v1"
	}
	url := base + "/services/aigc/multimodal-generation/generation"
	input := map[string]any{
		"text":  text,
		"voice": m.config.VoiceID,
	}
	if m.config.LanguageType != "" {
		input["language_type"] = m.config.LanguageType
	}
	body := map[string]any{"model": m.config.ModelID, "input": input}
	encoded, _ := json.Marshal(body)
	data, err := postJSON(ctx, url, map[string]string{"Authorization": "Bearer " + m.config.APIKey}, encoded)
	if err != nil {
		return "", fmt.Errorf("Qwen TTS 请求失败: %w", err)
	}
	var payload struct {
		StatusCode int    `json:"status_code"`
		Code       string `json:"code"`
		Message    string `json:"message"`
		Output     struct {
			Audio struct {
				URL  string `json:"url"`
				Data string `json:"data"`
			} `json:"audio"`
		} `json:"output"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("Qwen TTS 响应解析失败: %w", err)
	}
	if payload.StatusCode != 0 && payload.StatusCode != 200 {
		return "", fmt.Errorf("Qwen TTS 请求失败: %s (%s)", payload.Message, payload.Code)
	}
	// 优先取 base64 直存，否则下载 OSS URL（24h 有效）
	if payload.Output.Audio.Data != "" {
		audio, err := decodeBase64(payload.Output.Audio.Data)
		if err != nil {
			return "", fmt.Errorf("Qwen TTS 音频解码失败: %w", err)
		}
		return m.writeAudioFile(audio)
	}
	if payload.Output.Audio.URL == "" {
		return "", fmt.Errorf("Qwen TTS 返回中没有音频数据")
	}
	audio, err := downloadFile(ctx, payload.Output.Audio.URL)
	if err != nil {
		return "", fmt.Errorf("Qwen TTS 音频下载失败: %w", err)
	}
	return m.writeAudioFile(audio)
}

// ---------- MiMo(小米): POST {base}/chat/completions，audio.data 为 base64 ----------

func (m *Manager) synthesizeMimo(ctx context.Context, text string) (string, error) {
	base := strings.TrimSuffix(m.config.BaseURL, "/")
	if base == "" {
		base = mimoDefaultBaseURL
	} else if !strings.HasSuffix(base, "/v1") {
		base += "/v1"
	}
	url := base + "/chat/completions"
	messages := []map[string]any{}
	if instruction := strings.TrimSpace(m.config.StyleInstruction); instruction != "" {
		messages = append(messages, map[string]any{"role": "user", "content": instruction})
	}
	messages = append(messages, map[string]any{"role": "assistant", "content": text})
	format := m.config.Encoding
	if format != "wav" && format != "pcm16" {
		format = "wav"
	}
	body := map[string]any{
		"model":    m.config.ModelID,
		"messages": messages,
		"audio": map[string]any{
			"format": format,
			"voice":  m.config.VoiceID,
		},
		"stream": false,
	}
	encoded, _ := json.Marshal(body)
	data, err := postJSON(ctx, url, map[string]string{"Authorization": "Bearer " + m.config.APIKey}, encoded)
	if err != nil {
		return "", fmt.Errorf("MiMo TTS 请求失败: %w", err)
	}
	var payload struct {
		Choices []struct {
			Message struct {
				Audio struct {
					Data string `json:"data"`
				} `json:"audio"`
			} `json:"message"`
		} `json:"choices"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error,omitempty"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		return "", fmt.Errorf("MiMo TTS 响应解析失败: %w", err)
	}
	if payload.Error != nil && payload.Error.Message != "" {
		return "", fmt.Errorf("MiMo TTS 请求失败: %s", payload.Error.Message)
	}
	if len(payload.Choices) == 0 || payload.Choices[0].Message.Audio.Data == "" {
		return "", fmt.Errorf("MiMo TTS 返回中没有音频数据")
	}
	audio, err := decodeBase64(payload.Choices[0].Message.Audio.Data)
	if err != nil {
		return "", fmt.Errorf("MiMo TTS 音频解码失败: %w", err)
	}
	// pcm16 为裸 PCM 数据，文件名用 .pcm 扩展名如实标记，不改配置
	extension := m.config.Encoding
	if format == "pcm16" {
		extension = "pcm"
	}
	return m.writeAudioFileExt(audio, extension)
}

func downloadFile(ctx context.Context, url string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 60 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("HTTP %d", response.StatusCode)
	}
	return io.ReadAll(io.LimitReader(response.Body, 32*1024*1024))
}
