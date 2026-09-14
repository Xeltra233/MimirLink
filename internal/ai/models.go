package ai

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// 本文件对齐 Node src/ai.js 的 listModels / normalizeModel 与
// src/model-capabilities.js 的模型名能力识别规则。

// ModelInfo 是归一化后的模型条目（对齐 Node normalizeModel 输出形状）。
type ModelInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	OwnedBy       string `json:"ownedBy"`
	SupportsImage *bool  `json:"supportsImage"`
	Raw           any    `json:"raw"`
}

// resolveBaseURL 对齐 Node resolveApiUrl 的 /v1 处理。
func resolveBaseURL(path, baseURL string) string {
	normalized := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if normalized == "" {
		return ""
	}
	if strings.HasSuffix(normalized, "/v1") {
		return normalized + path
	}
	if strings.HasPrefix(path, "/v1") {
		return normalized + path
	}
	return normalized + "/v1" + path
}

// ListModels 拉取上游模型列表（对齐 Node listModels）。
func ListModels(baseURL, apiKey string) ([]ModelInfo, error) {
	apiURL := resolveBaseURL("/models", baseURL)
	if apiURL == "" {
		return nil, fmt.Errorf("未配置 AI API URL (baseUrl 或 apiUrl)")
	}
	client := &http.Client{Timeout: 30 * time.Second}
	request, err := http.NewRequest(http.MethodGet, apiURL, nil)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(apiKey) != "" {
		request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(apiKey))
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("模型列表拉取失败: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("模型列表拉取失败: %d - %s", response.StatusCode, truncateBody(string(body)))
	}
	var payload struct {
		Data   []json.RawMessage `json:"data"`
		Models []json.RawMessage `json:"models"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		// Node 还兼容顶层数组
		var list []json.RawMessage
		if err2 := json.Unmarshal(body, &list); err2 != nil {
			return nil, fmt.Errorf("解析模型列表失败: %w", err)
		}
		return normalizeModels(list), nil
	}
	raw := payload.Data
	if raw == nil {
		raw = payload.Models
	}
	return normalizeModels(raw), nil
}

func normalizeModels(raw []json.RawMessage) []ModelInfo {
	models := []ModelInfo{}
	for _, item := range raw {
		var entry struct {
			ID           string `json:"id"`
			Name         string `json:"name"`
			Model        string `json:"model"`
			OwnedBy      string `json:"owned_by"`
			Provider     string `json:"provider"`
			Organization string `json:"organization"`
		}
		var generic any
		_ = json.Unmarshal(item, &generic)
		if err := json.Unmarshal(item, &entry); err != nil {
			continue
		}
		id := firstNonEmpty(entry.ID, entry.Name, entry.Model, "unknown-model")
		supports := inferModelSupportsImage(id)
		models = append(models, ModelInfo{
			ID:            id,
			Name:          firstNonEmpty(entry.Name, entry.ID, entry.Model, "unknown-model"),
			OwnedBy:       firstNonEmpty(entry.OwnedBy, entry.Provider, entry.Organization),
			SupportsImage: supports,
			Raw:           generic,
		})
	}
	return models
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func truncateBody(text string) string {
	runes := []rune(text)
	if len(runes) > 300 {
		return string(runes[:300])
	}
	return text
}

// ---------- 模型图片输入能力识别（移植 src/model-capabilities.js） ----------

var (
	channelPrefixRe = regexp.MustCompile(`^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)\s*`)
	vendorPrefixRe  = regexp.MustCompile(`(?i)^\s*(?:pro|free|lora|openai|anthropic|google|meta|nvidia|qwen|moonshotai|minimaxai?|deepseek-ai|zai-org|z-ai|zhipuai|thudm|baidu|tencent|bytedance[\w-]*|mistralai|microsoft|inclusionai|stepfun-ai|ai21labs|databricks|writer|adept|opengvlab|internlm|01-ai|minimax)\s*/\s*`)
	// 后缀清理（:free/:beta 等）
	suffixRe = regexp.MustCompile(`(?i):(free|beta|stable|latest|thinking|nocache|extended)\b`)
	spaceRe  = regexp.MustCompile(`\s+`)
)

// normalizeModelKey 对齐 Node normalizeModelKey。
func normalizeModelKey(modelID string) string {
	key := strings.TrimSpace(modelID)
	for i := 0; i < 3; i++ {
		next := vendorPrefixRe.ReplaceAllString(channelPrefixRe.ReplaceAllString(key, ""), "")
		if next == key {
			break
		}
		key = next
	}
	key = suffixRe.ReplaceAllString(key, "")
	key = spaceRe.ReplaceAllString(key, " ")
	return strings.ToLower(strings.TrimSpace(key))
}

type capabilityRule struct {
	pattern *regexp.Regexp
	reason  string
}

// nonVisionRules 明确不支持图片输入的模型族。
var nonVisionRules = []capabilityRule{
	{regexp.MustCompile(`embed|embedding|bge-|m3e|gte-|e5-|jina-embed|voyage-|text-embedding|nv-embed|nvclip`), "向量/嵌入模型"},
	{regexp.MustCompile(`rerank|re-rank|reranker`), "重排模型"},
	{regexp.MustCompile(`whisper|asr|speech|tts|voice|audio|realtime-audio|riva-translate|sensevoice`), "语音模型"},
	{regexp.MustCompile(`guard|safety|moderation|prompt-guard|csl-`), "安全审核模型"},
	{regexp.MustCompile(`dall-e|gpt-image|flux|stable-diffusion|sd-[0-9]|kolors|z-image|qwen-image|wan2|i2v|t2v|image-edit|bailu-image|ernie-image|diffusiongemma|imagen`), "图像/视频生成模型"},
	{regexp.MustCompile(`stable-code|codestral|codegen|deepseek-coder|codegemma|codellama|qwen[\d.]*-coder|starcoder|codewhisperer|kimi-k2\.?\d*-code$`), "代码专用模型"},
	{regexp.MustCompile(`mt-|translate|translation`), "翻译专用模型"},
}

// visionRules 已知支持图片输入的模型族。
var visionRules = []capabilityRule{
	{regexp.MustCompile(`gemini`), "Gemini 全系支持图片输入"},
	{regexp.MustCompile(`claude-(?:3|4|5)(?:[.\-]|\b)|claude-(?:opus|sonnet|haiku)`), "Claude 3+ 支持图片输入"},
	{regexp.MustCompile(`gpt-(?:4o|4\.1|4\.5|5|6|4-turbo|4-vision)|gpt4o|(?:^|[/\s-])o(?:1|3|4)(?:$|[-_.\s])`), "OpenAI 多模态/推理模型"},
	{regexp.MustCompile(`grok-[^/]*vision|grok-(?:[3-9]|\d{2})`), "Grok 3+ / vision 变体"},
	{regexp.MustCompile(`qwen[\d.]*(?:-|_)?vl|qwen[^/]*omni|qwen-vl|qwen-?3\.6`), "Qwen-VL / Omni / 3.6 多模态族"},
	{regexp.MustCompile(`glm-?[\d.]*v(?:-|$|\b)|glm-4v|chatglm.*vision`), "GLM-V 系列"},
	{regexp.MustCompile(`deepseek[^/]*(?:vl|vision)|deepseek-v4`), "DeepSeek V4 / VL 视觉族"},
	{regexp.MustCompile(`kimi-(?:latest|vl|vision)|moonshot[^/]*vision`), "Kimi 视觉变体"},
	{regexp.MustCompile(`minimax[^/]*vl|abab[^/]*vl`), "MiniMax VL"},
	{regexp.MustCompile(`internvl|internlm-xcomposer|minicpm-v|llava|llama-?3\.2-(?:11b|90b)|llama-?4|mllama|idefics|pixtral|phi-[34][^/]*(?:vision|multimodal)|fuyu|neva|molmo|ovis|emu\d|bagel|cogvlm|paligemma|smolvlm|moondream`), "开源视觉/多模态模型"},
	{regexp.MustCompile(`mistral-small-3\.[1-9]|mistral-medium-3|mistral-large-3`), "Mistral 3.1+ 支持图片"},
	{regexp.MustCompile(`gemma-[34]|nova-(?:lite|pro|premier)|step-[^/]*v\d|step-1v|step-3v|yi-(?:vl|vision)|ernie[^/]*vl|doubao[^/]*vision|seed[^/]*vision|hunyuan[^/]*vision`), "主流多模态族"},
	{regexp.MustCompile(`bailu[^/]*(?:vl|vision)|bailu-apex|bailu-2\.\d+-1m|mimo[^/]*(?:vl|vision)`), "上游自建视觉族"},
	{regexp.MustCompile(`(?:^|[/\s\-_])(?:vl|vlm|vision|multimodal|omni|captioner|ocr|image-input)(?:$|[/\s\-_.:])`), "模型名含视觉关键词"},
}

// InferModelSupportsImage 依据模型名推断：true/false/nil（nil=无法判断）。
func InferModelSupportsImage(modelID string) *bool {
	return inferModelSupportsImage(modelID)
}

// ModelCapabilityReason 返回识别原因（对齐 Node getModelCapabilityReason）。
func ModelCapabilityReason(modelID string) string {
	return modelCapabilityReason(modelID)
}

// inferModelSupportsImage 依据模型名推断：true/false/nil（nil=无法判断）。
func inferModelSupportsImage(modelID string) *bool {
	key := normalizeModelKey(modelID)
	if key == "" {
		return nil
	}
	for _, rule := range nonVisionRules {
		if rule.pattern.MatchString(key) {
			return boolPtr(false)
		}
	}
	for _, rule := range visionRules {
		if rule.pattern.MatchString(key) {
			return boolPtr(true)
		}
	}
	return nil
}

func modelCapabilityReason(modelID string) string {
	key := normalizeModelKey(modelID)
	if key == "" {
		return ""
	}
	for _, rule := range nonVisionRules {
		if rule.pattern.MatchString(key) {
			return rule.reason
		}
	}
	for _, rule := range visionRules {
		if rule.pattern.MatchString(key) {
			return rule.reason
		}
	}
	return ""
}

func boolPtr(value bool) *bool { return &value }

// ModelCapability 是模型能力识别结果。
type ModelCapability struct {
	Supported *bool  `json:"supported"`
	Inferred  *bool  `json:"inferred"`
	Source    string `json:"source,omitempty"`
	Reason    string `json:"reason"`
}
