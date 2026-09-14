// Package tts 实现多供应商语音合成：火山引擎(doubao)、MiniMax、Qwen(DashScope)、MiMo(小米)。
// 配置键与 Node 版 config.json 的 tts 节点保持键级兼容（未知键由 config 层保留）。
package tts

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	audioDirName          = "audio"
	cleanupInterval       = 10 * time.Minute
	maxCacheAge           = 24 * time.Hour
	maxCacheFiles         = 50
	maxTextLength         = 1000
	doubaoDefaultEndpoint = "wss://openspeech.bytedance.com/api/v3/tts/bidirection"
	minimaxDefaultBaseURL = "https://api.minimax.chat"
	qwenDefaultBaseURL    = "https://dashscope.aliyuncs.com/api/v1"
	mimoDefaultBaseURL    = "https://api.xiaomimimo.com/v1"
)

// Config 是 TTS 配置（与 Node normalizeTTSConfig 的字段对齐）。
type Config struct {
	Enabled  bool
	Provider string
	BaseURL  string
	APIKey   string
	ModelID  string
	VoiceID  string
	Speed    float64
	Volume   float64
	Pitch    float64
	AppID    string
	Encoding string
	// Qwen 扩展
	LanguageType string
	// MiMo 扩展：自然语言风格指令（放在 user 消息，不会被朗读）
	StyleInstruction string
}

// Manager 负责配置持有、合成调度与音频缓存清理。
type Manager struct {
	config  Config
	audio   string
	logger  *log.Logger
	nowFunc func() time.Time
}

// New 创建管理器；audioDir 为空时使用 <root>/audio。
func New(rootDir string, logger *log.Logger) *Manager {
	if logger == nil {
		logger = log.New(os.Stdout, "[tts] ", log.LstdFlags)
	}
	audio := filepath.Join(rootDir, audioDirName)
	_ = os.MkdirAll(audio, 0o755)
	return &Manager{config: Normalize(nil), audio: audio, logger: logger, nowFunc: time.Now}
}

// NewWithAudioDir 供测试注入隔离音频目录。
func NewWithAudioDir(audioDir string, logger *log.Logger) *Manager {
	if logger == nil {
		logger = log.New(os.Stdout, "[tts] ", log.LstdFlags)
	}
	_ = os.MkdirAll(audioDir, 0o755)
	return &Manager{config: Normalize(nil), audio: audioDir, logger: logger, nowFunc: time.Now}
}

// Normalize 归一化配置（字段别名与默认值与 Node 版一致）。
func Normalize(raw map[string]any) Config {
	get := func(keys ...string) string {
		for _, key := range keys {
			if value, ok := raw[key]; ok {
				if text, ok := value.(string); ok && strings.TrimSpace(text) != "" {
					return strings.TrimSpace(text)
				}
			}
		}
		return ""
	}
	floatOr := func(key string, fallback float64) float64 {
		if value, ok := raw[key]; ok {
			if number, ok := value.(float64); ok && number > 0 {
				return number
			}
		}
		return fallback
	}
	enabled := false
	if value, ok := raw["enabled"]; ok {
		if flag, ok := value.(bool); ok {
			enabled = flag
		}
	}
	config := Config{
		Enabled:          enabled,
		Provider:         get("provider"),
		BaseURL:          get("baseUrl"),
		APIKey:           get("apiKey", "accessToken", "token"),
		ModelID:          get("modelId", "model"),
		VoiceID:          get("voiceId", "voiceType"),
		Speed:            floatOr("speed", 1.0),
		Volume:           floatOr("volume", 1.0),
		Pitch:            floatOr("pitch", 1.0),
		AppID:            get("appId", "appid"),
		Encoding:         get("encoding"),
		LanguageType:     get("languageType"),
		StyleInstruction: get("styleInstruction"),
	}
	if config.Provider == "" {
		config.Provider = "doubao"
	}
	if config.VoiceID == "" {
		config.VoiceID = "zh_female_shuangkuaisisi_moon_bigtts"
	}
	if config.Encoding == "" {
		config.Encoding = "mp3"
	}
	return config
}

// Config 返回当前配置。
func (m *Manager) Config() Config { return m.config }

// UpdateConfig 合并并归一化新配置。
func (m *Manager) UpdateConfig(options map[string]any) {
	merged := map[string]any{
		"enabled":          m.config.Enabled,
		"provider":         m.config.Provider,
		"baseUrl":          m.config.BaseURL,
		"apiKey":           m.config.APIKey,
		"modelId":          m.config.ModelID,
		"voiceId":          m.config.VoiceID,
		"speed":            m.config.Speed,
		"volume":           m.config.Volume,
		"pitch":            m.config.Pitch,
		"appId":            m.config.AppID,
		"encoding":         m.config.Encoding,
		"languageType":     m.config.LanguageType,
		"styleInstruction": m.config.StyleInstruction,
	}
	for key, value := range options {
		if text, ok := value.(string); ok && text == "" && (key == "apiKey" || key == "accessToken" || key == "token") {
			continue
		}
		merged[key] = value
	}
	m.config = Normalize(merged)
}

// ValidateConfig 校验当前 provider 所需的配置完整性。
func (m *Manager) ValidateConfig() error {
	if !m.config.Enabled {
		return fmt.Errorf("TTS 未启用")
	}
	switch m.config.Provider {
	case "minimax":
		if m.config.APIKey == "" {
			return fmt.Errorf("TTS 配置不完整：缺少 API Key")
		}
		if m.config.ModelID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少模型 ID")
		}
		if m.config.VoiceID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少音色 ID")
		}
	case "qwen":
		if m.config.APIKey == "" {
			return fmt.Errorf("TTS 配置不完整：缺少 API Key")
		}
		if m.config.ModelID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少模型 ID（如 qwen3-tts-flash）")
		}
		if m.config.VoiceID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少音色（如 Cherry）")
		}
	case "mimo":
		if m.config.APIKey == "" {
			return fmt.Errorf("TTS 配置不完整：缺少 API Key")
		}
		if m.config.ModelID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少模型 ID（如 mimo-v2.5-tts）")
		}
	case "doubao":
		if m.config.AppID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少 App ID")
		}
		if m.config.APIKey == "" {
			return fmt.Errorf("TTS 配置不完整：缺少 API Key")
		}
		if m.config.VoiceID == "" {
			return fmt.Errorf("TTS 配置不完整：缺少音色 ID")
		}
	default:
		return fmt.Errorf("不支持的 TTS 供应商: %s（可选 doubao/minimax/qwen/mimo）", m.config.Provider)
	}
	return nil
}

// ResolvedBaseURL 返回归一化后的服务地址。
func (m *Manager) ResolvedBaseURL() string {
	base := strings.TrimSuffix(strings.TrimSuffix(m.config.BaseURL, "/"), "/v1")
	if base != "" {
		return base
	}
	switch m.config.Provider {
	case "minimax":
		return minimaxDefaultBaseURL
	case "qwen":
		return strings.TrimSuffix(qwenDefaultBaseURL, "/v1")
	case "mimo":
		return strings.TrimSuffix(mimoDefaultBaseURL, "/v1")
	default:
		return ""
	}
}

// Synthesize 合成文本并返回音频文件路径。
func (m *Manager) Synthesize(ctx context.Context, text string) (string, error) {
	if err := m.ValidateConfig(); err != nil {
		return "", err
	}
	normalized := strings.TrimSpace(text)
	if normalized == "" {
		return "", fmt.Errorf("合成文本不能为空")
	}
	if len([]rune(normalized)) > maxTextLength {
		normalized = string([]rune(normalized)[:maxTextLength])
	}
	var path string
	var err error
	switch m.config.Provider {
	case "doubao":
		path, err = m.synthesizeDoubao(ctx, normalized)
	case "minimax":
		path, err = m.synthesizeMinimax(ctx, normalized)
	case "qwen":
		path, err = m.synthesizeQwen(ctx, normalized)
	case "mimo":
		path, err = m.synthesizeMimo(ctx, normalized)
	default:
		err = fmt.Errorf("不支持的 TTS 供应商: %s", m.config.Provider)
	}
	if err != nil {
		return "", err
	}
	m.CleanupAudio()
	return path, nil
}

// CleanupAudio 清理过期与超量的缓存音频（与 Node 版策略一致）。
func (m *Manager) CleanupAudio() {
	entries, err := os.ReadDir(m.audio)
	if err != nil {
		return
	}
	type audioFile struct {
		name string
		path string
		mod  time.Time
	}
	files := []audioFile{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), "tts_") {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, audioFile{entry.Name(), filepath.Join(m.audio, entry.Name()), info.ModTime()})
	}
	sort.Slice(files, func(left, right int) bool { return files[left].mod.After(files[right].mod) })
	now := m.nowFunc()
	removed := 0
	for _, file := range files {
		if now.Sub(file.mod) > maxCacheAge {
			_ = os.Remove(file.path)
			removed++
		}
	}
	if len(files)-removed > maxCacheFiles {
		for _, file := range files[removed+maxCacheFiles:] {
			_ = os.Remove(file.path)
		}
	}
}

// AudioDir 返回音频目录。
func (m *Manager) AudioDir() string { return m.audio }
