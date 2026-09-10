import test from 'node:test';
import assert from 'node:assert/strict';
import {
    IMAGE_INPUT_LIMITS,
    ImageInputError,
    normalizeImageCaptionConfig,
    getImageCaptionOverrides,
    getOneBotMessageSegments,
    prepareImageInput,
    attachImageParts
} from '../src/image-input.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=';
const DATA_URL = `data:image/png;base64,${PNG}`;
const image = (data) => ({ type: 'image', data });
const items = (...segments) => [{ event: { message_id: 1, user_id: 10001, message: segments } }];
const config = (chat = {}) => ({
    ai: {
        activeProviderId: 'chat', timeout: 1000,
        providers: [
            { id: 'chat', baseUrl: 'http://localhost:10001', model: 'text-model', apiKey: 'chat-test' },
            { id: 'vision', baseUrl: 'http://localhost:10002', model: 'vision-model', apiKey: 'vision-test' }
        ]
    },
    chat: { modelProviderId: 'chat', ...chat }
});
const noopClient = { chat() { throw new Error('不应调用专用模型'); } };

test('图片转述默认留空；空模型不会因 provider 存在而启用', () => {
    const empty = {};
    normalizeImageCaptionConfig(empty);
    assert.deepEqual(empty.chat, { imageCaptionModelProviderId: '', imageCaptionModel: '' });
    const cfg = config({ imageCaptionModelProviderId: 'vision', imageCaptionModel: '  ' });
    normalizeImageCaptionConfig(cfg);
    assert.equal(getImageCaptionOverrides(cfg), null);
    assert.equal(cfg.chat.imageCaptionModelProviderId, '');
});

test('专用模型引用使用自己的 provider，绝不混用聊天 key', () => {
    const options = getImageCaptionOverrides(config({ imageCaptionModelProviderId: ' vision ', imageCaptionModel: ' vision-model ' }));
    assert.equal(options.baseUrl, 'http://localhost:10002');
    assert.equal(options.apiKey, 'vision-test');
    assert.equal(options.model, 'vision-model');
    assert.equal(options.allowModelFallback, false);
    assert.throws(() => getImageCaptionOverrides(config({ imageCaptionModelProviderId: 'deleted', imageCaptionModel: 'vision-model' })), ImageInputError);
});

test('CQ 字符串解析保留段序并只解码一次转义', () => {
    const segments = getOneBotMessageSegments('看&#91;图&#93;[CQ:at,qq=999][CQ:image,file=cache.image,url=https://img.example/p?a=1&amp;b=2&#44;3]后续');
    assert.deepEqual(segments.map(s => s.type), ['text', 'at', 'image', 'text']);
    assert.equal(segments[0].data.text, '看[图]');
    assert.equal(segments[2].data.url, 'https://img.example/p?a=1&b=2,3');
    assert.equal(getOneBotMessageSegments('&amp;#91;')[0].data.text, '&#91;');
});

test('留空时多张图片直传聊天模型且不调用转述', async () => {
    const result = await prepareImageInput({
        items: items(image({ url: 'https://img.example/a.png', file: 'hash.image' }), image({ file: `base64://${PNG}` })),
        config: config(), aiClient: noopClient
    });
    assert.equal(result.mode, 'direct');
    assert.equal(result.imageCount, 2);
    assert.equal(result.captionText, '');
    assert.deepEqual(result.imageParts.map(p => p.image_url.url), ['https://img.example/a.png', DATA_URL]);
});

test('支持 data URI，按实际签名保留 PNG MIME', async () => {
    const result = await prepareImageInput({ items: items(image({ file: DATA_URL })), config: config(), aiClient: noopClient });
    assert.equal(result.imageParts[0].image_url.url, DATA_URL);
});

test('OneBot 仅给文件标识时调用 get_image，使用 URL 而非本地路径', async () => {
    const requests = [];
    const bot = { async getImage(file) { requests.push(file); return { file: 'C:/secret.png', url: 'https://img.example/resolved.png' }; } };
    const result = await prepareImageInput({ items: items(image({ file: 'cached.image' })), config: config(), bot, aiClient: noopClient });
    assert.deepEqual(requests, ['cached.image']);
    assert.equal(result.imageParts[0].image_url.url, 'https://img.example/resolved.png');
});

test('只在当前输入附图，不破坏历史消息或 assistant prefill', () => {
    const messages = [
        { role: 'user', content: '旧图', meta: { source: 'history' } },
        { role: 'user', content: '看当前图片', meta: { source: 'user_input' } },
        { role: 'assistant', content: '开始', meta: { source: 'assistant_prefill' } }
    ];
    attachImageParts(messages, [{ type: 'image_url', image_url: { url: DATA_URL } }]);
    assert.equal(messages[0].content, '旧图');
    assert.deepEqual(messages[1].content, [{ type: 'text', text: '看当前图片' }, { type: 'image_url', image_url: { url: DATA_URL } }]);
    assert.equal(messages[2].content, '开始');
    assert.throws(() => attachImageParts([{ role: 'system', content: '规则' }], [{ type: 'image_url', image_url: { url: DATA_URL } }]), ImageInputError);
});

test('显式选择后只请求专用模型一次，聊天输入仅获得转述文本', async () => {
    const requests = [];
    const aiClient = {
        async chat(messages, overrides) { requests.push({ messages, overrides }); return { content: '图1：红色方块。图2：蓝色圆形。' }; },
        getVisibleResponseContent(result) { return result.content; }
    };
    const result = await prepareImageInput({
        items: items(image({ file: DATA_URL }), image({ url: 'https://img.example/second.png' })),
        config: config({ imageCaptionModelProviderId: 'vision', imageCaptionModel: 'vision-model' }), aiClient
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].overrides.model, 'vision-model');
    assert.equal(requests[0].overrides.apiKey, 'vision-test');
    assert.equal(requests[0].overrides.allowModelFallback, false);
    assert.ok(requests[0].overrides.signal instanceof AbortSignal);
    assert.equal(requests[0].messages.length, 1);
    assert.equal(requests[0].messages[0].content.filter(p => p.type === 'image_url').length, 2);
    assert.equal(result.mode, 'caption');
    assert.match(result.captionText, /红色方块/);
    assert.deepEqual(result.imageParts, []);
});

test('纯文本即使配置转述也不额外调用', async () => {
    const result = await prepareImageInput({ items: items({ type: 'text', data: { text: '你好' } }), config: config({ imageCaptionModel: 'vision-model' }), aiClient: noopClient });
    assert.equal(result.mode, 'none');
    assert.equal(result.imageCount, 0);
});

for (const value of ['file:///C:/secret.png', 'C:/secret.png', '../secret.png', 'javascript:alert(1)', 'data:text/html;base64,SGVsbG8=', 'base64://not-image', 'https://user:password@img.example/a.png']) {
    test(`不读取本机路径或接受非法图片输入: ${value.split(':')[0]}`, async () => {
        await assert.rejects(prepareImageInput({ items: items(image({ file: value })), config: config(), aiClient: noopClient }), ImageInputError);
    });
}

test('图片数量上限不静默丢图', async () => {
    await assert.rejects(prepareImageInput({
        items: items(...Array.from({ length: IMAGE_INPUT_LIMITS.maxImages + 1 }, () => image({ file: DATA_URL }))),
        config: config(), aiClient: noopClient
    }), /最多/);
});

test('图片读取失败返回可理解错误，不默默忽略', async () => {
    await assert.rejects(prepareImageInput({ items: items(image({ file: 'cache.image' })), config: config(), bot: { async getImage() { throw new Error('raw credentials'); } }, aiClient: noopClient }), err => {
        assert.ok(err instanceof ImageInputError);
        assert.match(err.message, /图片/);
        assert.doesNotMatch(err.message, /raw credentials/);
        return true;
    });
});

for (const failure of ['empty', 'reject']) {
    test(`转述 ${failure} 时明确报错，不把原图回退到文本模型`, async () => {
        const aiClient = {
            async chat() { if (failure === 'reject') throw new Error('provider private detail'); return { content: ' ' }; },
            getVisibleResponseContent(result) { return result.content; }
        };
        await assert.rejects(prepareImageInput({ items: items(image({ file: DATA_URL })), config: config({ imageCaptionModelProviderId: 'vision', imageCaptionModel: 'vision-model' }), aiClient }), err => {
            assert.ok(err instanceof ImageInputError);
            assert.match(err.message, /图片转述/);
            assert.doesNotMatch(err.message, /provider private detail/);
            return true;
        });
    });
}

// 引用（回复）消息中的图片：与直发图片共用同一识图链路
const quotedItem = (segments, replyToMessageId = 1, eventMessage = [{ type: 'reply', data: { id: replyToMessageId } }, { type: 'text', data: { text: '这是啥' } }]) => ({
    event: { message_id: 9, user_id: 10001, message: eventMessage },
    replyToMessageId,
    replyImageSegments: segments
});

test('引用消息中的图片在留空时直传给聊天模型', async () => {
    const result = await prepareImageInput({
        items: [quotedItem([image({ url: 'https://img.example/quoted.png' })])],
        config: config(), aiClient: noopClient
    });
    assert.equal(result.mode, 'direct');
    assert.equal(result.imageCount, 1);
    assert.deepEqual(result.imageParts.map(p => p.image_url.url), ['https://img.example/quoted.png']);
});

test('引用图片在已选转述模型时同样先转述', async () => {
    const requests = [];
    const aiClient = {
        async chat(messages, overrides) { requests.push({ messages, overrides }); return { content: '引用图：一只猫。' }; },
        getVisibleResponseContent(result) { return result.content; }
    };
    const result = await prepareImageInput({
        items: [quotedItem([image({ file: DATA_URL })])],
        config: config({ imageCaptionModelProviderId: 'vision', imageCaptionModel: 'vision-model' }), aiClient
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].overrides.model, 'vision-model');
    assert.equal(requests[0].messages[0].content.filter(p => p.type === 'image_url').length, 1);
    assert.equal(result.mode, 'caption');
    assert.match(result.captionText, /一只猫/);
});

test('同一批多人引用同一张图时去重，不与直发图片重复计数', async () => {
    const result = await prepareImageInput({
        items: [
            quotedItem([image({ url: 'https://img.example/quoted.png' })], 77),
            quotedItem([image({ url: 'https://img.example/quoted.png' })], 77),
            items(image({ url: 'https://img.example/direct.png' }))[0]
        ],
        config: config(), aiClient: noopClient
    });
    assert.equal(result.imageCount, 2);
    assert.deepEqual(result.imageParts.map(p => p.image_url.url), ['https://img.example/direct.png', 'https://img.example/quoted.png']);
});

test('引用图片与直发图片共用张数上限，不静默丢弃', async () => {
    await assert.rejects(prepareImageInput({
        items: [
            items(...Array.from({ length: IMAGE_INPUT_LIMITS.maxImages }, () => image({ file: DATA_URL })))[0],
            quotedItem([image({ url: 'https://img.example/quoted.png' })], 78)
        ],
        config: config(), aiClient: noopClient
    }), /最多/);
});
