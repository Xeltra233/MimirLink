/**
 * 模型图片输入（多模态）能力识别
 *
 * 上游模型列表只有 id / owned_by，没有能力声明；这里用「模型名规则表」做识别：
 *   true  —— 已知支持图片输入（视觉/多模态族）
 *   false —— 已知不支持图片输入（纯文本、向量、重排、语音、图像生成等）
 *   null  —— 名称无法识别：分两种默认（都不需要写配置）
 *            · 「拉取模型」添加进来的模型（models[].pulled === true）→ 默认按支持图片处理
 *            · 手动输入或旧配置里已有的模型 → 默认按不支持处理（走图片转述）
 *
 * 规则顺序：先排除族（false）→ 再视觉族（true）→ 都不命中返回 null。
 * 面板里的优先级：模型级显式 > 供应商级强制 > 这里识别出的结果 > 未识别时的默认（拉取添加的默认开）。
 */


// 渠道前缀（NewAPI/one-api 常见）：[某渠道] xxx、[渠道-说明] xxx
const CHANNEL_PREFIX_RE = /^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】)\s*/;
// 供应商命名空间前缀：zai-org/xxx、meta/xxx、Pro/xxx、LoRA/xxx
const VENDOR_PREFIX_RE = /^\s*(?:pro|free|lora|openai|anthropic|google|meta|nvidia|qwen|moonshotai|minimaxai?|deepseek-ai|zai-org|z-ai|zhipuai|thudm|baidu|tencent|bytedance[\w-]*|mistralai|microsoft|inclusionai|stepfun-ai|ai21labs|databricks|writer|adept|opengvlab|internlm|01-ai|minimax)\s*\/\s*/i;

/**
 * 归一化模型名，便于规则匹配：去掉渠道前缀、供应商前缀、:free/:beta 等后缀、模型名里的空格
 */
export function normalizeModelKey(modelId = '') {
    let key = String(modelId || '').trim();
    for (let i = 0; i < 3; i++) {
        const next = key.replace(CHANNEL_PREFIX_RE, '').replace(VENDOR_PREFIX_RE, '');
        if (next === key) break;
        key = next;
    }
    return key
        .replace(/:(?:free|beta|stable|latest|thinking|nocache|extended)\b/gi, '')
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

/**
 * 明确不支持图片输入的模型族（向量、重排、语音、审核、图像/视频生成、纯代码补全等）
 */
const NON_VISION_RULES = Object.freeze([
    { pattern: /embed|embedding|bge-|m3e|gte-|e5-|jina-embed|voyage-|text-embedding|nv-embed|nvclip/, reason: '向量/嵌入模型' },
    { pattern: /rerank|re-rank|reranker/, reason: '重排模型' },
    { pattern: /whisper|asr|speech|tts|voice|audio|realtime-audio|riva-translate|sensevoice/, reason: '语音模型' },
    { pattern: /guard|safety|moderation|prompt-guard|csl-/, reason: '安全审核模型' },
    { pattern: /dall-e|gpt-image|flux|stable-diffusion|sd-[0-9]|kolors|z-image|qwen-image|wan2|i2v|t2v|image-edit|bailu-image|ernie-image|diffusiongemma|imagen/, reason: '图像/视频生成模型' },
    { pattern: /stable-code|codestral|codegen|deepseek-coder|codegemma|codellama|qwen[\d.]*-coder|starcoder|codewhisperer|kimi-k2\.?\d*-code$/, reason: '代码专用模型' },
    { pattern: /mt-|translate|translation/, reason: '翻译专用模型' }
]);

/**
 * 已知支持图片输入的模型族（含 2024-2026 主流商用/开源多模态）
 */
const VISION_RULES = Object.freeze([
    // Gemini 全系（1.0 起即多模态；图像生成族在上面已排除）
    { pattern: /gemini/, reason: 'Gemini 全系支持图片输入' },
    // Claude 3 及以后（3/3.5/3.7/4/4.5/4.6/5 的 opus/sonnet/haiku）
    { pattern: /claude-(?:3|4|5)(?:[.\-]|\b)|claude-(?:opus|sonnet|haiku)/, reason: 'Claude 3+ 支持图片输入' },
    // OpenAI：gpt-4o / 4.1 / 4.5 / 4-turbo / 4-vision / gpt-5 全系 / o 系列推理模型
    { pattern: /gpt-(?:4o|4\.1|4\.5|5|6|4-turbo|4-vision)|gpt4o|(?:^|[/\s-])o(?:1|3|4)(?:$|[-_.\s])/, reason: 'OpenAI 多模态/推理模型' },
    // Grok：vision 变体与 grok-3 以后
    { pattern: /grok-[^/]*vision|grok-(?:[3-9]|\d{2})/, reason: 'Grok 3+ / vision 变体' },
    // Qwen：VL 系列、Omni 系列、Qwen3.6 稠密多模态（vLLM recipe/OpenRouter 标注 image 输入）
    { pattern: /qwen[\d.]*(?:-|_)?vl|qwen[^/]*omni|qwen-vl|qwen-?3\.6/, reason: 'Qwen-VL / Omni / 3.6 多模态族' },
    // GLM：4V / 4.1V / 4.5V / 5V、GLM-4V-Plus
    { pattern: /glm-?[\d.]*v(?:-|$|\b)|glm-4v|chatglm.*vision/, reason: 'GLM-V 系列' },
    // DeepSeek：V4 起原生多模态（官方文档 V4-Flash-Vision-Exp 支持混合文本+图片输入），另有 VL/vision 变体
    { pattern: /deepseek[^/]*(?:vl|vision)|deepseek-v4/, reason: 'DeepSeek V4 / VL 视觉族' },
    // Kimi / Moonshot：kimi-latest、kimi-vl、vision 变体
    { pattern: /kimi-(?:latest|vl|vision)|moonshot[^/]*vision/, reason: 'Kimi 视觉变体' },
    // MiniMax：minimax-vl / abab-vl
    { pattern: /minimax[^/]*vl|abab[^/]*vl/, reason: 'MiniMax VL' },
    // 开源视觉族
    { pattern: /internvl|internlm-xcomposer|minicpm-v|llava|llama-?3\.2-(?:11b|90b)|llama-?4|mllama|idefics|pixtral|phi-[34][^/]*(?:vision|multimodal)|fuyu|neva|molmo|ovis|emu\d|bagel|cogvlm|paligemma|smolvlm|moondream/, reason: '开源视觉/多模态模型' },
    // Mistral Small 3.1+ / Medium 3 起支持图片
    { pattern: /mistral-small-3\.[1-9]|mistral-medium-3|mistral-large-3/, reason: 'Mistral 3.1+ 支持图片' },
    // Gemma 3/4（除 1b）、Nova、Step-V、Yi-VL、ERNIE-VL、Doubao-vision、Hunyuan-vision
    { pattern: /gemma-[34]|nova-(?:lite|pro|premier)|step-[^/]*v\d|step-1v|step-3v|yi-(?:vl|vision)|ernie[^/]*vl|doubao[^/]*vision|seed[^/]*vision|hunyuan[^/]*vision/, reason: '主流多模态族' },
    // 自建/聚合站常见命名（实测 bailu-apex-2.7、bailu-2.7-1m 可读四色图）
    { pattern: /bailu[^/]*(?:vl|vision)|bailu-apex|bailu-2\.\d+-1m|mimo[^/]*(?:vl|vision)/, reason: '上游自建视觉族' },
    // 通用关键词兜底
    { pattern: /(?:^|[/\s\-_])(?:vl|vlm|vision|multimodal|omni|captioner|ocr|image-input)(?:$|[/\s\-_.:])/, reason: '模型名含视觉关键词' }
]);

export function getModelCapabilityRules() {
    return { nonVision: NON_VISION_RULES, vision: VISION_RULES };
}

/**
 * 依据模型名推断图片输入能力
 * @returns {boolean|null} true=支持，false=不支持，null=无法判断
 */
export function inferModelSupportsImage(modelId = '') {
    const key = normalizeModelKey(modelId);
    if (!key) return null;
    for (const rule of NON_VISION_RULES) {
        if (rule.pattern.test(key)) return false;
    }
    for (const rule of VISION_RULES) {
        if (rule.pattern.test(key)) return true;
    }
    return null;
}

export function getModelCapabilityReason(modelId = '') {
    const key = normalizeModelKey(modelId);
    if (!key) return '';
    for (const rule of NON_VISION_RULES) {
        if (rule.pattern.test(key)) return rule.reason;
    }
    for (const rule of VISION_RULES) {
        if (rule.pattern.test(key)) return rule.reason;
    }
    return '';
}

export function findProvider(config = {}, providerId = '') {
    const providers = Array.isArray(config.ai?.providers) ? config.ai.providers : [];
    const id = String(providerId || '').trim();
    if (!id) return null;
    return providers.find((provider) => String(provider?.id || '') === id) || null;
}

export function findModelEntry(provider = null, modelRef = '') {
    const models = Array.isArray(provider?.models) ? provider.models : [];
    const id = String((modelRef && typeof modelRef === 'object' ? (modelRef.id || modelRef.name) : modelRef) || '').trim();
    if (!id) return null;
    return models.find((model) => String(model?.id || model?.name || '') === id) || null;
}

/**
 * 解析某个供应商+模型最终是否支持图片输入
 * 判定只看两件事：模型名规则；名字认不出来时看来源（是否由「拉取模型」添加）。面板不提供手动开关。
 * @param provider 供应商配置
 * @param modelRef 模型 id，或模型条目对象（可携带 pulled）
 * @returns {{ supported: boolean, source: 'inferred'|'pulled'|'default', reason: string }}
 */
export function resolveModelImageSupport(provider = null, modelRef = '') {
    const inlineEntry = modelRef && typeof modelRef === 'object' ? modelRef : null;
    const modelId = inlineEntry ? (inlineEntry.id || inlineEntry.name || '') : modelRef;
    const entry = findModelEntry(provider, modelId) || inlineEntry;
    const inferred = inferModelSupportsImage(modelId);
    if (inferred === true) return { supported: true, source: 'inferred', reason: getModelCapabilityReason(modelId) || '模型名识别为多模态' };
    if (inferred === false) return { supported: false, source: 'inferred', reason: getModelCapabilityReason(modelId) || '模型名识别为非多模态' };
    // 未识别：只有「拉取模型」添加进来的模型按支持处理，其余按不支持（走图片转述）
    if (entry?.pulled === true) {
        return { supported: true, source: 'pulled', reason: '从「拉取模型」添加的模型，未识别的名字按支持图片处理' };
    }
    return { supported: false, source: 'default', reason: '未能识别模型名且不是从「拉取模型」添加，按不支持图片处理（走图片转述）' };
}

/**
 * 便捷布尔判定：解析结果只有明确 true 才算支持
 */
export function modelSupportsImage(provider = null, modelId = '') {
    return resolveModelImageSupport(provider, modelId).supported === true;
}

/**
 * 批量识别（供控制面板在模型列表里显示徽标）
 * @param {string[]} modelIds
 * @returns {Record<string, { supported: boolean|null, inferred: boolean|null, reason: string }>}
 */
export function describeModelCapabilities(modelIds = []) {
    const result = {};
    for (const id of Array.isArray(modelIds) ? modelIds : []) {
        const key = String(id || '').trim();
        if (!key) continue;
        const inferred = inferModelSupportsImage(key);
        // inferred 是名称规则的原始判定（null=没认出来）；supported 是这里能给出的默认（未识别一律不支持）。
        // 面板接口会用 resolveModelImageSupport 覆盖 supported：拉取添加的未识别模型在那里变成 true。
        result[key] = { supported: inferred === null ? false : inferred, inferred, reason: getModelCapabilityReason(key) };
    }
    return result;
}
