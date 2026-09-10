/**
 * 模型图片输入能力识别单元测试
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeModelKey,
    inferModelSupportsImage,
    getModelCapabilityReason,
    resolveModelImageSupport,
    modelSupportsImage,
    describeModelCapabilities
} from '../src/model-capabilities.js';
import { mainModelSupportsImage, shouldSkipImageCaption } from '../src/image-input.js';

test('渠道前缀与供应商前缀会被归一化掉', () => {
    assert.equal(normalizeModelKey('[某R反代渠道] gemini-3.5-flash'), 'gemini-3.5-flash');
    assert.equal(normalizeModelKey('[Joverna公益站渠道-仅酒馆、机翻、字幕、对话。不支持龙独/代码-仅支持OpenAlChat接口-请轻量使用] gemini-3-pro-preview'), 'gemini-3-pro-preview');
    assert.equal(normalizeModelKey('zai-org/GLM-4.5V'), 'glm-4.5v');
    assert.equal(normalizeModelKey('Pro/moonshotai/Kimi-K2.6'), 'kimi-k2.6');
    assert.equal(normalizeModelKey('google/gemma-4-31b-it:free'), 'gemma-4-31b-it');
    assert.equal(normalizeModelKey('  '), '');
});

test('已知多模态族识别为支持图片输入', () => {
    const visionModels = [
        '[Vertex反代渠道] gemini-3-flash-preview',
        'gemini-3.1-flash-image',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
        'gpt-4o', 'gpt-4.1-mini', 'gpt-5.6-terra', 'o3-mini',
        'grok-4.3-medium', 'grok-2-vision-1212',
        'Qwen/Qwen3-VL-8B-Instruct', 'qwen-vl-max', 'qwen3-omni-30b',
        'zai-org/GLM-4.5V', 'glm-4v-plus',
        'deepseek-v4-flash-vision-exp',
        'moonshotai/kimi-latest',
        'meta/llama-3.2-11b-vision-instruct', 'llama-4-scout-17b',
        'mistral-small-3.1-24b-instruct',
        'microsoft/phi-3-vision-128k-instruct',
        'google/gemma-3-12b-it',
        'bailu-2.7-vl-350m', 'bailu-apex-2.7', 'bailu-2.7-1m',
        // MCP(fathom-search) 检索：DeepSeek 官方文档 V4-Flash-Vision-Exp 支持混合文本+图片输入；
        // CloudBase 文档以 model:'deepseek-v4-pro' 传多模态消息；Qwen3.6-27B 带视觉编码器
        '[IDC兑换] deepseek-v4-pro',
        'Qwen/Qwen3.6-27B',
        'internvl2-8b', 'minicpm-v-2.6', 'pixtral-12b',
        'amazon/nova-lite-v1', 'yi-vl-plus', 'ernie-4.5-vl', 'doubao-vision-pro'
    ];
    for (const id of visionModels) {
        assert.equal(inferModelSupportsImage(id), true, `${id} 应识别为支持图片`);
    }
});

test('向量、重排、语音、审核、生成与代码模型识别为不支持图片输入', () => {
    const textModels = [
        'BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'Qwen/Qwen3-VL-Reranker-8B', 'Qwen/Qwen3-VL-Embedding-8B',
        'llama-guard-3-8b', 'nvidia/llama-3.1-nemoguard-8b-content-safety',
        'Qwen/Qwen3-Reranker-4B', 'nvidia/nvclip', 'nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1',
        'openai/whisper-large-v3', 'XingChenAGI/XingChenASR-V3.2',
        'Wan-AI/Wan2.2-I2V-A14B', 'baidu/ERNIE-Image-Turbo', 'Tongyi-MAI/Z-Image', 'Kwai-Kolors/Kolors',
        'deepseek-ai/deepseek-coder-6.7b-instruct', 'mistralai/codestral-22b-instruct-v0.1',
        'tencent/Hunyuan-MT-7B'
    ];
    for (const id of textModels) {
        assert.equal(inferModelSupportsImage(id), false, `${id} 应识别为不支持图片`);
    }
});

test('无法判断的模型返回 null 并给出理由', () => {
    for (const id of ['big-pickle', 'x-preview-f', 'gpt-oss-120b-medium', 'bailu-2.6-preview', 'writer/palmyra-med-70b',
        'MiniMaxAI/MiniMax-M2.5', 'glm-4.7-flash']) {
        assert.equal(inferModelSupportsImage(id), null, `${id} 应无法判断`);
    }
    assert.match(getModelCapabilityReason('gemini-3-flash'), /Gemini/);
    assert.match(getModelCapabilityReason('BAAI/bge-m3'), /向量/);
    assert.equal(getModelCapabilityReason('big-pickle'), '');
    assert.equal(inferModelSupportsImage(''), null);
});

test('图片能力只看名称识别与来源（面板不提供手动开关）', () => {
    const provider = { id: 'p1', models: [{ id: 'gemini-3-flash' }] };
    assert.deepEqual(resolveModelImageSupport(provider, 'gemini-3.5-flash').supported, true);  // 名称识别
    assert.equal(resolveModelImageSupport(provider, 'gemini-3.5-flash').source, 'inferred');
    assert.deepEqual(resolveModelImageSupport(provider, 'big-pickle-2').supported, false);     // 未识别且非拉取来源 → 走转述
    assert.equal(resolveModelImageSupport(provider, 'big-pickle-2').source, 'default');
    // 未识别的「拉取添加」模型 → 支持
    assert.deepEqual(resolveModelImageSupport(provider, { id: 'big-pickle-2', pulled: true }).supported, true);
    assert.equal(resolveModelImageSupport(provider, { id: 'big-pickle-2', pulled: true }).source, 'pulled');
    // 已下线的手动开关字段不再影响判定（含历史配置残留）
    assert.equal(resolveModelImageSupport({ id: 'p1', imageInputMode: 'on', models: [] }, 'big-pickle-2').supported, false);
    assert.equal(resolveModelImageSupport({ id: 'p1', models: [{ id: 'gemini-3-flash', supportsImage: false }] }, 'gemini-3-flash').supported, true);
    assert.equal(resolveModelImageSupport({ supportsImage: true }, 'big-pickle-2').supported, false);
});

test('批量能力描述用于面板徽标', () => {
    const described = describeModelCapabilities(['[某R反代渠道] gemini-3.5-flash', 'BAAI/bge-m3', 'big-pickle', '']);
    assert.deepEqual(Object.keys(described).sort(), ['BAAI/bge-m3', '[某R反代渠道] gemini-3.5-flash', 'big-pickle']);
    assert.equal(described['[某R反代渠道] gemini-3.5-flash'].supported, true);
    assert.equal(described['BAAI/bge-m3'].supported, false);
    assert.equal(described['big-pickle'].supported, false);  // 未识别：批量描述按保守默认，拉取来源由接口用 resolve 覆盖
    assert.equal(described['big-pickle'].inferred, null);   // 名称规则原始判定仍是“没认出来”
    assert.deepEqual(describeModelCapabilities(null), {});
});

test('聊天模型图片能力解析贯穿到转述跳过逻辑', () => {
    const cfg = {
        ai: {
            activeProviderId: 'p1', model: 'fallback-model',
            providers: [{ id: 'p1', model: 'qwen-vl-max', models: [] }]
        },
        chat: { modelProviderId: 'p1' }
    };
    assert.equal(mainModelSupportsImage(cfg), true);
    assert.equal(shouldSkipImageCaption(cfg), true);
    cfg.chat.imageCaptionSkipWhenModelSupportsImage = false;
    assert.equal(shouldSkipImageCaption(cfg), false);
    // 显式关闭跳过时，即使模型多模态也不跳过（只影响 skip 判定）
    cfg.chat.imageCaptionSkipWhenModelSupportsImage = true;
    cfg.chat.model = 'gpt-oss-120b-medium';
    assert.equal(mainModelSupportsImage(cfg), false);  // 未识别且非拉取来源 → 走图片转述
    cfg.ai.providers[0].models = [{ id: 'gpt-oss-120b-medium', pulled: true }];
    assert.equal(mainModelSupportsImage(cfg), true);   // 拉取添加的未识别模型 → 直接带图
    cfg.ai.providers[0].models = [{ id: 'gpt-oss-120b-medium' }];
    assert.equal(mainModelSupportsImage(cfg), false);  // 只有真实来源标记才生效
});


