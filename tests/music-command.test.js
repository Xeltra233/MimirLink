import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    MusicBridgeClient,
    MusicBridgeError,
    MusicCommandHandler,
    MusicSessionStore,
    buildMusicSessionKey,
    formatMusicSearchList,
    normalizeMusicConfig,
    parseMusicCommand
} from '../src/music.js';

const BASE_CONFIG = {
    enabled: true,
    command: '/music',
    exitCommand: '/music-exit',
    baseUrl: 'http://127.0.0.1:8787',
    format: 'mp3'
};

/** 构造一条 /search 候选 */
function buildResult(index, displayName, extra = {}) {
    return {
        index,
        display_name: displayName,
        title: displayName.split(' - ')[0],
        artists: [displayName.split(' - ')[1] || ''],
        duration: '4:30',
        duration_seconds: 270,
        video_id: `vid_${index}`,
        match_score: 0.9,
        ...extra
    };
}

/** 构造一个可断言调用记录的假上游客户端 */
function createFakeClient({ searchResponses = [], downloadImpl } = {}) {
    const calls = { search: [], download: [] };
    const queue = [...searchResponses];
    return {
        calls,
        async search(query) {
            calls.search.push(query);
            const next = queue.shift();
            if (typeof next === 'function') {
                return next(query);
            }
            if (next instanceof Error) {
                throw next;
            }
            return next;
        },
        async download(args) {
            calls.download.push(args);
            if (typeof downloadImpl === 'function') {
                return downloadImpl(args);
            }
            return {
                buffer: Buffer.from('fake-audio'),
                format: 'mp3',
                title: '晴天',
                artists: '周杰伦',
                videoId: 'vid_1',
                durationSeconds: 270,
                cacheHit: false
            };
        }
    };
}

function createHandler({ client, config = {}, audioDir, runCommand, store } = {}) {
    const sessionStore = store || new MusicSessionStore();
    const handler = new MusicCommandHandler({
        getConfig: () => ({ ...BASE_CONFIG, ...config }),
        client,
        store: sessionStore,
        logger: { info() {}, warn() {}, error() {} },
        audioDir: audioDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mimir-music-')),
        runCommand
    });
    return { handler, store: sessionStore };
}

function createRecorder() {
    const texts = [];
    const voices = [];
    return {
        texts,
        voices,
        sendText: async (text) => { texts.push(text); },
        sendVoice: async (audioPath, meta) => {
            // 语音下发时文件必须已经真实落盘，否则 onebot 读文件会失败
            voices.push({ audioPath, exists: fs.existsSync(audioPath), meta });
        }
    };
}

const GROUP_EVENT_A = { message_type: 'group', group_id: 100, user_id: 1001, message_id: 'm1' };
const GROUP_EVENT_B = { message_type: 'group', group_id: 100, user_id: 2002, message_id: 'm2' };

test('normalizeMusicConfig 提供安全默认值并夹紧越界输入', () => {
    const fallback = normalizeMusicConfig();
    assert.equal(fallback.enabled, false, '默认必须关闭，避免误触发下载');
    assert.equal(fallback.command, '/music');
    assert.equal(fallback.exitCommand, '/music-exit');
    assert.equal(fallback.baseUrl, 'http://127.0.0.1:8787');
    assert.equal(fallback.format, 'mp3');
    assert.equal(fallback.voiceSegmentSeconds, 120, '默认按 QQ 语音约 2 分钟切段');

    const clamped = normalizeMusicConfig({
        enabled: 'yes',
        command: 'has space',
        limit: 999,
        minScore: 5,
        maxFilesizeMB: 0,
        downloadTimeoutMs: 1,
        format: 'wav'
    });
    assert.equal(clamped.enabled, false, 'enabled 只接受布尔 true');
    assert.equal(clamped.command, '/music', '带空格的指令名回退默认值');
    assert.equal(clamped.limit, 20);
    assert.equal(clamped.minScore, 1);
    assert.equal(clamped.maxFilesizeMB, 1);
    assert.equal(clamped.downloadTimeoutMs, 5000);
    assert.equal(clamped.format, 'mp3', '未知格式回退 mp3');
});

test('buildMusicSessionKey 按群+用户/私聊用户隔离', () => {
    assert.equal(buildMusicSessionKey(GROUP_EVENT_A), 'group:100:user:1001');
    assert.equal(buildMusicSessionKey(GROUP_EVENT_B), 'group:100:user:2002');
    assert.notEqual(buildMusicSessionKey(GROUP_EVENT_A), buildMusicSessionKey(GROUP_EVENT_B));
    assert.equal(buildMusicSessionKey({ message_type: 'private', user_id: 1001 }), 'private:1001');
    assert.notEqual(
        buildMusicSessionKey({ message_type: 'private', user_id: 1001 }),
        buildMusicSessionKey(GROUP_EVENT_A)
    );
});

test('parseMusicCommand 覆盖退出优先、用法、搜索、序号与歌名选择', () => {
    assert.deepEqual(parseMusicCommand('/music-exit'), { type: 'exit' });
    assert.deepEqual(parseMusicCommand('/music-exit  '), { type: 'exit' }, '/music-exit 不能被 /music 前缀吞掉');
    assert.deepEqual(parseMusicCommand('/music'), { type: 'usage' });
    assert.deepEqual(parseMusicCommand('/musicxyz 晴天'), { type: 'none' }, '指令后必须跟空白才算命中');
    assert.deepEqual(parseMusicCommand('随便聊天'), { type: 'none' });

    // 无候选时纯数字应当作搜索关键词
    assert.deepEqual(parseMusicCommand('/music 250'), { type: 'search', query: '250' });

    const session = { results: [buildResult(1, '晴天 - 周杰伦'), buildResult(2, 'Shape of You - Ed Sheeran')] };
    assert.deepEqual(parseMusicCommand('/music 2', { session }), { type: 'select', index: 2, raw: '2' });
    assert.deepEqual(parseMusicCommand('/music ２', { session }), { type: 'select', index: 2, raw: '２' }, '全角数字要归一化');
    assert.deepEqual(
        parseMusicCommand('/music 晴天 - 周杰伦', { session }),
        { type: 'select', name: '晴天 - 周杰伦', raw: '晴天 - 周杰伦' }
    );
    assert.deepEqual(
        parseMusicCommand('/music   shape of YOU -   Ed Sheeran  ', { session }),
        { type: 'select', name: 'Shape of You - Ed Sheeran', raw: 'shape of YOU -   Ed Sheeran' },
        '歌名匹配忽略大小写与多余空白'
    );
    assert.deepEqual(parseMusicCommand('/music 不存在的歌', { session }), { type: 'search', query: '不存在的歌' });

    // 自定义指令名同样生效
    assert.deepEqual(
        parseMusicCommand('!歌 周杰伦', { command: '!歌', exitCommand: '!歌退出' }),
        { type: 'search', query: '周杰伦' }
    );
});

test('formatMusicSearchList 输出序号、时长与用法提示', () => {
    const text = formatMusicSearchList('晴天 周杰伦', [buildResult(1, '晴天 - 周杰伦'), buildResult(2, '晴天(live) - 周杰伦')], {
        expiresInSeconds: 1800,
        truncated: true
    });
    assert.ok(text.includes('1. 晴天 - 周杰伦（4:30）'), text);
    assert.ok(text.includes('2. 晴天(live) - 周杰伦（4:30）'), text);
    assert.ok(text.includes('/music 1'), text);
    assert.ok(text.includes('/music 完整歌名'), text);
    assert.ok(text.includes('30 分钟内有效'), text);
    assert.ok(text.includes('/music-exit'), text);
});

test('功能未启用时不拦截消息', async () => {
    const client = createFakeClient();
    const { handler } = createHandler({ client, config: { enabled: false } });
    const recorder = createRecorder();
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
    assert.equal(result.handled, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(recorder.texts.length, 0);
    assert.equal(client.calls.search.length, 0);
});

test('搜索后选歌会写出音频并调用语音发送', async () => {
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_aaa',
            expires_in: 1800,
            truncated: false,
            results: [buildResult(1, '晴天 - 周杰伦'), buildResult(2, 'Shape of You - Ed Sheeran')]
        }]
    });
    const { handler } = createHandler({ client });
    const recorder = createRecorder();

    const searchResult = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
    assert.equal(searchResult.handled, true);
    assert.equal(searchResult.ok, true);
    assert.equal(searchResult.total, 2);
    assert.ok(recorder.texts.some((text) => text.includes('1. 晴天 - 周杰伦')), recorder.texts.join('\n'));

    const selectResult = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(selectResult.ok, true);
    assert.equal(selectResult.reason, 'sent');
    assert.deepEqual(client.calls.download, [{ sessionId: 's_aaa', index: 1, name: '' }]);
    assert.equal(recorder.voices.length, 1);
    assert.equal(recorder.voices[0].exists, true, '发送语音时临时文件必须存在');
    assert.ok(recorder.voices[0].audioPath.endsWith('.mp3'));
    assert.equal(recorder.voices[0].meta.label, '晴天 - 周杰伦');
    // 发送完成后临时文件必须清理，避免磁盘堆积
    assert.equal(fs.existsSync(recorder.voices[0].audioPath), false);
});

test('用完整歌名选歌时按 name 请求上游', async () => {
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_name',
            expires_in: 1800,
            results: [buildResult(1, '晴天 - 周杰伦'), buildResult(2, 'Shape of You - Ed Sheeran')]
        }]
    });
    const { handler } = createHandler({ client });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music Shape of You - Ed Sheeran', ...recorder });
    assert.equal(result.ok, true);
    assert.deepEqual(client.calls.download, [{ sessionId: 's_name', index: null, name: 'Shape of You - Ed Sheeran' }]);
});

test('同群多用户同时点歌互不串台', async () => {
    const client = createFakeClient({
        searchResponses: [
            { session_id: 's_userA', expires_in: 1800, results: [buildResult(1, '晴天 - 周杰伦')] },
            { session_id: 's_userB', expires_in: 1800, results: [buildResult(1, 'Shape of You - Ed Sheeran'), buildResult(2, 'Perfect - Ed Sheeran')] }
        ]
    });
    const { handler, store } = createHandler({ client });
    const recorderA = createRecorder();
    const recorderB = createRecorder();

    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorderA });
    await handler.handle({ event: GROUP_EVENT_B, plainText: '/music ed sheeran', ...recorderB });

    // B 的搜索不能覆盖 A 的候选
    assert.equal(store.get('group:100:user:1001').sessionId, 's_userA');
    assert.equal(store.get('group:100:user:2002').sessionId, 's_userB');

    await handler.handle({ event: GROUP_EVENT_B, plainText: '/music 2', ...recorderB });
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorderA });

    assert.deepEqual(client.calls.download, [
        { sessionId: 's_userB', index: 2, name: '' },
        { sessionId: 's_userA', index: 1, name: '' }
    ], '每个用户的下载必须带自己的 session_id 与序号');

    // A 退出不影响 B 的状态
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music-exit', ...recorderA });
    assert.equal(store.get('group:100:user:1001'), null);
    assert.equal(store.get('group:100:user:2002').sessionId, 's_userB');
    assert.ok(recorderA.texts.at(-1).includes('已退出点歌状态'));
});

test('同一用户重复点歌会被下载并发锁拦住', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const client = createFakeClient({
        searchResponses: [{ session_id: 's_lock', expires_in: 1800, results: [buildResult(1, '晴天 - 周杰伦'), buildResult(2, '龙卷风 - 周杰伦')] }],
        downloadImpl: async () => {
            await gate;
            return {
                buffer: Buffer.from('slow-audio'),
                format: 'mp3',
                title: '晴天',
                artists: '周杰伦',
                videoId: 'vid_1',
                durationSeconds: 270,
                cacheHit: false
            };
        }
    });
    const { handler } = createHandler({ client });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 周杰伦', ...recorder });

    const first = handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    // 等第一次进入下载后再发第二条
    await new Promise((resolve) => setImmediate(resolve));
    const second = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 2', ...recorder });
    assert.equal(second.reason, 'user_busy');
    assert.ok(recorder.texts.some((text) => text.includes('你上一首还在下载中')), recorder.texts.join('\n'));

    release();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(client.calls.download.length, 1, '被拦住的请求不能打到上游');

    // 锁释放后可以继续点歌
    const third = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 2', ...recorder });
    assert.equal(third.ok, true);
    assert.equal(client.calls.download.length, 2);
});

test('序号越界会给出可选范围且不打上游', async () => {
    const client = createFakeClient({
        searchResponses: [{ session_id: 's_range', expires_in: 1800, results: [buildResult(1, '晴天 - 周杰伦')] }]
    });
    const { handler } = createHandler({ client });
    const recorder = createRecorder();

    const searched = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
    assert.equal(searched.ok, true);

    const outOfRange = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 9', ...recorder });
    assert.equal(outOfRange.reason, 'index_out_of_range');
    assert.ok(recorder.texts.at(-1).includes('请选 1 - 1'), recorder.texts.at(-1));
    assert.equal(client.calls.download.length, 0);
});

test('超过时长上限的候选会被拦下', async () => {
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_long',
            expires_in: 1800,
            results: [buildResult(1, '超长现场 - 某人', { duration: '30:00', duration_seconds: 1800 })]
        }]
    });
    const { handler } = createHandler({ client, config: { maxDurationSeconds: 900 } });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 超长现场', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(result.reason, 'too_long');
    assert.ok(recorder.texts.at(-1).includes('超过上限 15 分钟'), recorder.texts.at(-1));
    assert.equal(client.calls.download.length, 0);
});

test('上游 session 过期会清掉本地候选并提示重新搜索', async () => {
    const client = createFakeClient({
        searchResponses: [{ session_id: 's_expire', expires_in: 1800, results: [buildResult(1, '晴天 - 周杰伦')] }],
        downloadImpl: async () => {
            throw new MusicBridgeError('会话已过期', { status: 410, code: 'SESSION_EXPIRED' });
        }
    });
    const { handler, store } = createHandler({ client });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(result.reason, 'download_failed');
    assert.equal(store.get('group:100:user:1001'), null, 'SESSION_EXPIRED 必须清掉本地候选');
    assert.ok(recorder.texts.at(-1).includes('请重新发送 /music 歌名 搜索'), recorder.texts.at(-1));
});

test('歌名歧义与文件过大都会映射为可读中文提示', async () => {
    const cases = [
        {
            error: new MusicBridgeError('歌名匹配到多首', {
                status: 409,
                code: 'AMBIGUOUS_NAME',
                detail: { candidates: [{ index: 1, display_name: '晴天 - 周杰伦' }, { index: 3, display_name: '晴天 - 群星' }] }
            }),
            expect: '3. 晴天 - 群星'
        },
        {
            error: new MusicBridgeError('文件过大', { status: 413, code: 'FILE_TOO_LARGE' }),
            expect: '文件太大'
        },
        {
            error: new MusicBridgeError('限流', { status: 429, code: 'RATE_LIMITED' }),
            expect: '稍后再试'
        },
        {
            error: new MusicBridgeError('连接失败', { code: 'SERVICE_UNAVAILABLE' }),
            expect: 'ytmusic-bridge 是否启动'
        }
    ];

    for (const item of cases) {
        const client = createFakeClient({
            searchResponses: [{ session_id: 's_err', expires_in: 1800, results: [buildResult(1, '晴天 - 周杰伦')] }],
            downloadImpl: async () => { throw item.error; }
        });
        const { handler } = createHandler({ client });
        const recorder = createRecorder();
        await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 晴天', ...recorder });
        const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
        assert.equal(result.ok, false);
        assert.ok(recorder.texts.at(-1).includes(item.expect), `${item.error.code}: ${recorder.texts.at(-1)}`);
    }
});

test('搜索无结果时清空候选并提示换关键词', async () => {
    const client = createFakeClient({ searchResponses: [{ session_id: 's_empty', results: [] }] });
    const { handler, store } = createHandler({ client });
    const recorder = createRecorder();
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music asdkjhasd', ...recorder });
    assert.equal(result.reason, 'empty_result');
    assert.equal(store.get('group:100:user:1001'), null);
    assert.ok(recorder.texts.at(-1).includes('换个关键词'), recorder.texts.at(-1));
});

test('MusicBridgeClient 对 429 重试一次并携带鉴权头与格式', async () => {
    const requests = [];
    let attempt = 0;
    const client = new MusicBridgeClient({
        getConfig: () => ({ ...BASE_CONFIG, apiKey: 'secret-key', limit: 5, minScore: 0.5 }),
        logger: { warn() {} },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            attempt += 1;
            if (attempt === 1) {
                return {
                    ok: false,
                    status: 429,
                    headers: new Headers(),
                    json: async () => ({ code: 'RATE_LIMITED', message: '排队已满' })
                };
            }
            return {
                ok: true,
                status: 200,
                headers: new Headers(),
                json: async () => ({ session_id: 's_retry', results: [buildResult(1, '晴天 - 周杰伦')] })
            };
        }
    });

    const payload = await client.search('晴天');
    assert.equal(payload.session_id, 's_retry');
    assert.equal(requests.length, 2, '429 必须重试一次');
    assert.equal(requests[0].url, 'http://127.0.0.1:8787/search');
    assert.equal(requests[0].options.headers['X-API-Key'], 'secret-key');
    assert.deepEqual(JSON.parse(requests[0].options.body), { query: '晴天', limit: 5, min_score: 0.5 });
});

test('MusicBridgeClient 解析下载响应头并按上限拒绝过大文件', async () => {
    const okClient = new MusicBridgeClient({
        getConfig: () => ({ ...BASE_CONFIG, maxFilesizeMB: 30 }),
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: new Headers({
                'content-length': '10',
                'x-track-title': encodeURIComponent('晴天'),
                'x-track-artists': encodeURIComponent('周杰伦'),
                'x-track-video-id': 'SJKoWAd5ySo',
                'x-track-duration': '270',
                'x-cache': 'hit'
            }),
            arrayBuffer: async () => new TextEncoder().encode('0123456789').buffer
        })
    });
    const track = await okClient.download({ sessionId: 's1', index: 1 });
    assert.equal(track.title, '晴天');
    assert.equal(track.artists, '周杰伦');
    assert.equal(track.videoId, 'SJKoWAd5ySo');
    assert.equal(track.durationSeconds, 270);
    assert.equal(track.cacheHit, true);
    assert.equal(track.buffer.length, 10);

    const tooLargeClient = new MusicBridgeClient({
        getConfig: () => ({ ...BASE_CONFIG, maxFilesizeMB: 1 }),
        fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: new Headers({ 'content-length': String(5 * 1024 * 1024) }),
            body: { cancel: async () => {} },
            arrayBuffer: async () => new ArrayBuffer(5 * 1024 * 1024)
        })
    });
    await assert.rejects(
        () => tooLargeClient.download({ sessionId: 's1', index: 1 }),
        (error) => error instanceof MusicBridgeError && error.code === 'FILE_TOO_LARGE'
    );
});


test('本地 TTL 过期后数字选歌会变成新搜索（已知摩擦，锁定现状）', async () => {
    let clock = 1000;
    const store = new MusicSessionStore({ now: () => clock });
    store.set('group:100:user:1001', {
        sessionId: 's_old',
        query: 'Screen Aim Fire',
        results: [buildResult(1, 'Scream Aim Fire - Bullet For My Valentine')],
        ttlMs: 100
    });
    clock += 200;
    assert.equal(store.get('group:100:user:1001'), null, '本地 TTL 过期后候选应消失');

    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_after_expire',
            expires_in: 1800,
            results: [buildResult(1, 'One - Fake')]
        }]
    });
    const { handler } = createHandler({ client, store });
    const recorder = createRecorder();
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });

    assert.equal(result.reason, 'search', '无候选时纯数字参数当前会走搜索而不是 select/no_session');
    assert.deepEqual(client.calls.search, ['1']);
    assert.ok(recorder.texts.some((text) => text.includes('「1」的搜索结果') || text.includes('One - Fake')), recorder.texts.join('\n'));
});

test('MusicSessionStore 过期清理与容量上限生效', () => {
    let clock = 1000;
    const store = new MusicSessionStore({ now: () => clock, maxSessions: 2 });
    store.set('a', { sessionId: 's_a', query: 'a', results: [], ttlMs: 100 });
    assert.equal(store.get('a').sessionId, 's_a');
    clock += 200;
    assert.equal(store.get('a'), null, '过期后读不到');

    clock = 1000;
    store.set('k1', { sessionId: 's1', query: 'q', results: [], ttlMs: 10000 });
    store.set('k2', { sessionId: 's2', query: 'q', results: [], ttlMs: 10000 });
    store.set('k3', { sessionId: 's3', query: 'q', results: [], ttlMs: 10000 });
    assert.equal(store.getStats().sessions, 2, '超过上限时淘汰最旧会话');
    assert.equal(store.get('k1'), null);
    assert.equal(store.get('k3').sessionId, 's3');
});

test('index.js 已接入点歌指令、访问控制与语音下发', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes("} from './music.js';"));
    assert.ok(source.includes('config.chat.music = normalizeMusicConfig(config.chat.music);'), '配置必须归一化');
    assert.ok(source.includes('async function handleMusicCommand(event, plainText)'));
    assert.ok(source.includes('if (await handleMusicCommand(event, plainText)) {'), 'handleMessage 必须调用点歌处理');
    const handlerStart = source.indexOf('async function handleMusicCommand(event, plainText)');
    const handler = source.slice(handlerStart, source.indexOf('async function processBatch'));
    assert.ok(handler.includes('if (!isAllowed(config, event))'), '点歌必须走访问控制');
    assert.ok(handler.includes('bot.sendGroupRecord(event.group_id, audioPath, prefixSegments)'));
    assert.ok(handler.includes('bot.sendPrivateRecord(event.user_id, audioPath, prefixSegments)'));
    assert.ok(handler.includes("type: 'reply'"));
    assert.ok(handler.includes("type: 'at'"));
});


test('短于切段阈值时只发一条语音', async () => {
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_short',
            expires_in: 1800,
            results: [buildResult(1, '短歌 - 测试', { duration: '1:30', duration_seconds: 90 })]
        }],
        downloadImpl: async () => ({
            buffer: Buffer.from('short-audio'),
            format: 'mp3',
            title: '短歌',
            artists: '测试',
            videoId: 'vid_short',
            durationSeconds: 90,
            cacheHit: false
        })
    });
    let splitCalls = 0;
    const { handler } = createHandler({
        client,
        config: { voiceSegmentSeconds: 120 },
        runCommand: async () => { splitCalls += 1; }
    });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 短歌', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(result.ok, true);
    assert.equal(result.parts, 1);
    assert.equal(recorder.voices.length, 1);
    assert.equal(splitCalls, 0, '时长未超限时不应调用 ffmpeg');
});

test('超过 voiceSegmentSeconds 的歌曲会切段并顺序连发', async () => {
    const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimir-music-seg-'));
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_split',
            expires_in: 1800,
            results: [buildResult(1, '长歌 - 测试', { duration: '4:30', duration_seconds: 270 })]
        }],
        downloadImpl: async () => ({
            buffer: Buffer.from('long-audio-source'),
            format: 'mp3',
            title: '长歌',
            artists: '测试',
            videoId: 'vid_long',
            durationSeconds: 270,
            cacheHit: false
        })
    });

    const { handler } = createHandler({
        client,
        audioDir,
        config: { voiceSegmentSeconds: 120 },
        runCommand: async (_cmd, args) => {
            const pattern = args.at(-1);
            // 模拟 ffmpeg segment 输出 3 段
            for (let i = 0; i < 3; i += 1) {
                const file = pattern.replace('%03d', String(i).padStart(3, '0'));
                fs.writeFileSync(file, Buffer.from(`seg-${i}`));
            }
        }
    });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 长歌', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(result.ok, true);
    assert.equal(result.parts, 3);
    assert.equal(recorder.voices.length, 3, '应顺序发送 3 段语音');
    assert.deepEqual(recorder.voices.map((item) => item.meta.part), [1, 2, 3]);
    assert.ok(recorder.voices.every((item) => item.exists === true), '发送时分段文件必须存在');
    assert.ok(recorder.texts.some((text) => text.includes('3 段语音连发')), recorder.texts.join('\n'));
    assert.ok(recorder.texts.some((text) => text.includes('已分 3 段发完')), recorder.texts.join('\n'));
    // 发送完成后临时文件应清理
    const leftover = fs.readdirSync(audioDir);
    assert.equal(leftover.length, 0, `临时文件未清理: ${leftover.join(',')}`);
});

test('voiceSegmentSeconds=0 时不切段', async () => {
    const client = createFakeClient({
        searchResponses: [{
            session_id: 's_nosplit',
            expires_in: 1800,
            results: [buildResult(1, '长歌 - 测试', { duration: '5:00', duration_seconds: 300 })]
        }],
        downloadImpl: async () => ({
            buffer: Buffer.from('no-split-audio'),
            format: 'mp3',
            title: '长歌',
            artists: '测试',
            videoId: 'vid_ns',
            durationSeconds: 300,
            cacheHit: false
        })
    });
    let splitCalls = 0;
    const { handler } = createHandler({
        client,
        config: { voiceSegmentSeconds: 0 },
        runCommand: async () => { splitCalls += 1; }
    });
    const recorder = createRecorder();
    await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 长歌', ...recorder });
    const result = await handler.handle({ event: GROUP_EVENT_A, plainText: '/music 1', ...recorder });
    assert.equal(result.ok, true);
    assert.equal(result.parts, 1);
    assert.equal(recorder.voices.length, 1);
    assert.equal(splitCalls, 0);
});
