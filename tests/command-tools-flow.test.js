import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { buildAIToolContext } from '../src/tools.js';
import {
    extractMentionedUserIds,
    executeAdminPokeCommand,
    isCommandInvocation,
    normalizeEmojiReactionId,
    resolveEmojiReactionId
} from '../src/qq-interactions.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function buildPokeEvent(overrides = {}) {
    return {
        post_type: 'message',
        message_type: 'group',
        group_id: '123456',
        user_id: '10001',
        message_id: 987,
        raw_message: '/戳一戳 @10002',
        message: [
            { type: 'text', data: { text: '/戳一戳 ' } },
            { type: 'at', data: { qq: '10002' } }
        ],
        ...overrides
    };
}

const SEARCH_QUERY_GROUPS = Object.freeze({
    life_small_questions: [
        '洗衣机有异味怎么处理',
        '冰箱冷藏室结冰怎么办',
        '厨房下水道反味怎么解决',
        '白衬衫染色怎么清洗',
        '米饭夹生怎么补救',
        '感冒发烧什么时候需要就医',
        '晚饭低油高蛋白吃什么',
        '睡眠质量差有哪些改善方法',
        '家里路由器信号弱怎么排查',
        '手机充电发烫正常吗',
        '电脑风扇噪音大怎么办',
        '饮水机多久清洗一次',
        '雨天通勤鞋子湿了怎么处理',
        '空调有霉味怎么清理',
        '运动后膝盖疼该注意什么'
    ],
    public_hotspots: [
        '近期国际新闻有哪些',
        '欧盟人工智能法案最新进展',
        '全球气候峰会最新消息',
        '2026年世界杯赛程最新消息',
        '近期重大科技公司裁员消息',
        '某国大选民调最新动态',
        '国际油价上涨原因最新分析',
        '最近公共卫生事件通报',
        '近期教育政策调整最新消息',
        '近期芯片出口管制新闻',
        '新能源汽车补贴政策最新进展',
        '近期重大航天发射新闻',
        '最近金融监管政策变化',
        '近期网络安全重大事件',
        '近期AI版权诉讼进展'
    ],
    research_frontier: [
        '2026年多模态大模型最新进展',
        '固态电池最新研究综述',
        'CRISPR base editing 最新论文',
        '量子计算纠错 surface code 进展',
        '可控核聚变等离子体控制最新成果',
        '钙钛矿太阳能电池稳定性研究',
        '脑机接口临床试验最新进展',
        '蛋白质结构预测模型新论文',
        '自动驾驶端到端模型研究进展',
        '具身智能机器人最新研究',
        '低空经济无人机通信技术研究',
        '碳捕集封存技术最新论文',
        '新型抗生素发现机器学习研究',
        '星舰复用火箭工程进展',
        '高温超导材料最新突破'
    ],
    weather_time_finance: [
        '北京今天会下雨吗要不要带伞',
        '上海明天天气和气温',
        '深圳现在温度多少',
        '杭州周末天气预报',
        '现在北京时间是几点',
        '今天几号星期几',
        '纽约现在时间',
        '东京当前时间',
        '今天美元兑人民币汇率',
        'EUR CNY exchange rate today',
        '今天黄金价格多少',
        '今天油价调整最新消息',
        '今天NBA比赛比分',
        '北京到上海高铁今天晚点吗',
        '现在广州路况堵车吗'
    ],
    policy_public_service: [
        '北京居住证办理流程最新',
        '上海社保缴费基数最新标准',
        '个税专项附加扣除政策',
        '医保异地报销最新流程',
        '公积金贷款利率最新政策',
        '护照办理预约材料',
        '高考报名政策最新通知',
        '研究生考试调剂规则最新',
        '租房提取公积金流程',
        '新能源车牌照申请条件',
        '电子发票报销规定',
        '个人征信查询官方入口',
        '居民身份证到期换证流程',
        '城市公共交通优惠政策',
        '企业年报公示截止时间'
    ],
    tech_dev_security: [
        'Node.js LTS 最新版本',
        'OpenAI API 最新模型列表',
        'Windows 11 最新更新问题',
        'Ubuntu 24.04 安装 Docker 教程',
        'Kubernetes 版本兼容矩阵',
        'PostgreSQL 备份恢复最佳实践',
        'Redis 持久化 AOF RDB 区别',
        'GitHub Actions 缓存依赖配置',
        'npm supply chain attack latest news',
        'CVE-2026 latest vulnerability roundup',
        'OWASP Top 10 最新版本',
        'nginx 反向代理 websocket 配置',
        'Cloudflare Workers KV 限制',
        'Vite React 构建性能优化',
        'Docker Compose 健康检查配置'
    ],
    market_transport_sports: [
        '今天A股主要指数表现',
        '比特币价格今天',
        '美元兑日元汇率',
        '国际金价最新走势',
        '原油价格今天',
        '英超赛程最新',
        '欧冠比赛结果',
        'F1大奖赛最新排名',
        '北京首都机场航班延误',
        '上海虹桥火车站列车晚点',
        '今天高速路况查询',
        '特斯拉最新股价',
        '苹果公司财报最新',
        '人民币汇率中间价',
        '电影票房排行榜最新'
    ]
});

const VARIED_SEARCH_SCENARIOS = Object.entries(SEARCH_QUERY_GROUPS).flatMap(([category, queries]) => (
    queries.map((query) => ({ category, query }))
));

function mockSearchResponse(body, contentType = 'application/json') {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', contentType]]),
        async json() {
            return body;
        },
        async text() {
            return text;
        },
        async arrayBuffer() {
            return Buffer.from(text);
        }
    };
}

function buildDuckDuckGoHtmlPage(query, count = 3) {
    const blocks = Array.from({ length: count }, (_, index) => `
        <div class="result results_links results_links_deep web-result">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(`https://evidence.example.test/search/${encodeURIComponent(query)}/${index + 1}`)}">${query} 资料 ${index + 1}</a>
            </h2>
            <a class="result__snippet" href="#">检索摘要：${query}（第 ${index + 1} 条）。这是模拟的公开网页资料，用于验证 web_search 返回标题、链接与摘要。</a>
          </div>
        </div>`).join('\n');
    return `<!DOCTYPE html><html><body>${blocks}</body></html>`;
}

function buildDuckDuckGoLitePage(query, count = 3) {
    const rows = Array.from({ length: count }, (_, index) => `
        <tr><td>${index + 1}.</td><td><a rel="nofollow" href="https://evidence.example.test/lite/${encodeURIComponent(query)}/${index + 1}" class='result-link'>${query} lite 资料 ${index + 1}</a></td></tr>
        <tr><td class='result-snippet'>lite 摘要：${query} 第 ${index + 1} 条。</td></tr>`).join('\n');
    return `<html><body><table>${rows}</table></body></html>`;
}

function createMockFetch(callLog) {
    return async (url, options = {}) => {
        const parsed = new URL(String(url));
        callLog.push(parsed.toString());

        if (parsed.hostname === 'html.duckduckgo.com') {
            return mockSearchResponse(buildDuckDuckGoHtmlPage(parsed.searchParams.get('q') || ''), 'text/html');
        }

        if (parsed.hostname === 'lite.duckduckgo.com') {
            return mockSearchResponse(buildDuckDuckGoLitePage(parsed.searchParams.get('q') || ''), 'text/html');
        }

        if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/') {
            return mockSearchResponse('<html><body><input value="vqd=\'4-123456789012345678901234567890123456789\'" /></body></html>', 'text/html');
        }

        if (parsed.hostname === 'duckduckgo.com' && parsed.pathname === '/news.js') {
            return mockSearchResponse({
                results: [
                    {
                        title: 'Mock 新闻 A',
                        url: 'https://news.example.test/a',
                        excerpt: '模拟新闻摘要 A，包含事件时间与公开来源。',
                        date: 1789000000,
                        relative_time: '1天前'
                    },
                    {
                        title: 'Mock 新闻 B',
                        url: 'https://news.example.test/b',
                        excerpt: '模拟新闻摘要 B，包含后续进展。',
                        date: 1789000100,
                        relative_time: '2天前'
                    }
                ]
            });
        }

        if (parsed.hostname === 'duckduckgo.com' && parsed.pathname.startsWith('/js/spice/forecast/')) {
            const payload = {
                currentWeather: {
                    asOf: '2026-09-13T00:00:00Z',
                    conditionCode: 'Clear',
                    temperature: 22.5,
                    temperatureApparent: 23.1,
                    humidity: 0.5,
                    windSpeed: 8.2,
                    windGust: 12,
                    uvIndex: 3,
                    precipitationIntensity: 0,
                    cloudCover: 0.1
                },
                forecastDaily: {
                    days: [
                        { forecastStart: '2026-09-13T00:00:00Z', conditionCode: 'Clear', temperatureMax: 28, temperatureMin: 18, daytimeForecast: { precipitationChance: 0.1 } },
                        { forecastStart: '2026-09-14T00:00:00Z', conditionCode: 'Rain', temperatureMax: 25, temperatureMin: 17, daytimeForecast: { precipitationChance: 0.6 } }
                    ]
                },
                location: { name: '北京' },
                timezone: 'Asia/Shanghai'
            };
            return mockSearchResponse(`ddg_spice_forecast(\n${JSON.stringify(payload)}\n);`, 'text/javascript');
        }

        if (parsed.hostname === 'duckduckgo.com' && parsed.pathname.startsWith('/js/spice/currency/')) {
            const payload = { from: 'USD', amount: 1, timestamp: '2026-09-13T00:00:00Z', to: [{ quotecurrency: 'CNY', mid: 7.18 }] };
            return mockSearchResponse(`ddg_spice_currency(\n${JSON.stringify(payload)}\n);`, 'text/javascript');
        }

        if (parsed.hostname === 'example.test') {
            return mockSearchResponse('<!DOCTYPE html><html><head><title>Mock 页面</title></head><body><article><h1>Mock 文章标题</h1><p>这是用于验证 web_fetch 的正文内容。MimirLink 测试页面，包含足够长的段落以便 Readability 提取正文。</p><p>第二段内容，继续提供正文文本，确保提取结果非空并且可读。</p></article></body></html>', 'text/html');
        }

        throw new Error(`unexpected network request in search test: ${parsed.toString()}`);
    };
}

function assertSearchResultIsGroundingOnly(result, contextLabel) {
    assert.equal(result.ok, true, contextLabel);
    assert.equal(typeof result.query, 'string', contextLabel);
    assert.equal(typeof result.source, 'string', contextLabel);
    assert.ok(Array.isArray(result.results), contextLabel);
    assert.ok(result.results.length > 0, contextLabel);
    assert.equal(result.resultCount, result.results.length, contextLabel);
    assert.equal('reply' in result, false, contextLabel);
    assert.equal('response' in result, false, contextLabel);
    assert.equal('content' in result, false, contextLabel);
    assert.equal('message' in result, false, contextLabel);

    for (const item of result.results) {
        assert.equal(typeof item.title, 'string', contextLabel);
        assert.equal(typeof item.url, 'string', contextLabel);
        assert.equal(typeof item.snippet, 'string', contextLabel);
        assert.ok(item.title.trim(), contextLabel);
        assert.ok(item.url.trim(), contextLabel);
        assert.ok(item.snippet.trim(), contextLabel);
    }
}
test('admin poke command calls OneBot group_poke five times', async () => {
    const pokeCalls = [];
    const statuses = [];
    const result = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        command: '/戳一戳',
        repeatCount: 5,
        isAdmin: true,
        bot: {
            async sendGroupPoke(groupId, userId) {
                pokeCalls.push({ groupId, userId });
            }
        },
        onCommandAccepted() {
            statuses.push('emoji');
        },
        sendStatusMessage(message) {
            statuses.push(message);
        },
        sendFailureMessage(message) {
            statuses.push(`failure:${message}`);
        },
        logger: silentLogger
    });

    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(result.targetUserId, '10002');
    assert.equal(result.repeatCount, 5);
    assert.equal(pokeCalls.length, 5);
    assert.deepEqual(new Set(pokeCalls.map((item) => `${item.groupId}:${item.userId}`)), new Set(['123456:10002']));
    assert.deepEqual(statuses, ['emoji']);
});

test('admin poke command supports compact multi-mention syntax without success reply', async () => {
    const pokeCalls = [];
    const statuses = [];
    const event = buildPokeEvent({
        raw_message: '/戳一戳@10002@10003@10002',
        message: [
            { type: 'text', data: { text: '/戳一戳' } },
            { type: 'at', data: { qq: '10002' } },
            { type: 'at', data: { qq: '10003' } },
            { type: 'at', data: { qq: '10002' } }
        ]
    });
    const result = await executeAdminPokeCommand({
        event,
        plainText: '/戳一戳[@A|QQ:10002][@B|QQ:10003]',
        command: '/戳一戳',
        repeatCount: 2,
        isAdmin: true,
        bot: {
            async sendGroupPoke(groupId, userId) {
                pokeCalls.push({ groupId, userId });
            }
        },
        onCommandAccepted() {
            statuses.push('emoji');
        },
        sendStatusMessage(message) {
            statuses.push(message);
        },
        sendFailureMessage(message) {
            statuses.push(`failure:${message}`);
        },
        logger: silentLogger
    });

    assert.equal(isCommandInvocation('/戳一戳@10002', '/戳一戳'), true);
    assert.equal(isCommandInvocation('/戳一戳[@A|QQ:10002]', '/戳一戳'), true);
    assert.equal(isCommandInvocation('/戳一戳abc', '/戳一戳'), false);
    assert.deepEqual(extractMentionedUserIds(event), ['10002', '10003']);
    assert.equal(result.handled, true);
    assert.equal(result.ok, true);
    assert.equal(result.targetUserId, '10002');
    assert.deepEqual(result.targetUserIds, ['10002', '10003']);
    assert.equal(result.targetCount, 2);
    assert.equal(result.repeatCount, 2);
    assert.deepEqual(pokeCalls.map((item) => `${item.groupId}:${item.userId}`), [
        '123456:10002',
        '123456:10002',
        '123456:10003',
        '123456:10003'
    ]);
    assert.deepEqual(statuses, ['emoji']);
});

test('admin poke command reports visible failure states', async () => {
    const failures = [];
    const nonAdmin = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        isAdmin: false,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(nonAdmin.handled, true);
    assert.equal(nonAdmin.ok, false);
    assert.match(failures.at(-1), /只有管理员/);

    const missingTarget = await executeAdminPokeCommand({
        event: buildPokeEvent({ message: [{ type: 'text', data: { text: '/戳一戳' } }] }),
        plainText: '/戳一戳',
        isAdmin: true,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(missingTarget.reason, 'missing_target');
    assert.match(failures.at(-1), /@某人/);

    const notGroup = await executeAdminPokeCommand({
        event: buildPokeEvent({ message_type: 'private', group_id: null }),
        plainText: '/戳一戳',
        isAdmin: true,
        bot: { async sendGroupPoke() {} },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(notGroup.reason, 'not_group');
    assert.match(failures.at(-1), /仅支持群聊/);

    const botFailure = await executeAdminPokeCommand({
        event: buildPokeEvent(),
        plainText: '/戳一戳',
        repeatCount: 5,
        isAdmin: true,
        bot: {
            async sendGroupPoke() {
                throw new Error('OneBot refused');
            }
        },
        sendFailureMessage(message) { failures.push(message); },
        logger: silentLogger
    });
    assert.equal(botFailure.reason, 'poke_failed');
    assert.match(failures.at(-1), /OneBot refused/);
});

test('QQ emoji reaction supports numeric ids and aliases while preserving switch semantics', () => {
    assert.equal(normalizeEmojiReactionId('277'), '277');
    assert.equal(normalizeEmojiReactionId('qq:277'), '277');
    assert.equal(normalizeEmojiReactionId('点赞'), '76');
    assert.equal(normalizeEmojiReactionId('doge'), '277');
    assert.equal(normalizeEmojiReactionId('未知别名'), '289');
    assert.equal(resolveEmojiReactionId({ chat: { emojiReactionId: '狗头' } }), '277');

    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    assert.ok(source.includes('return config.chat?.emojiReaction === true;'));
    assert.ok(source.includes('const emojiId = resolveEmojiReactionId(config);'));
    assert.ok(source.includes('bot.setMsgEmojiLike(event.message_id, emojiId)'));
});

test('admin /at command routes generated mention text through output regex processing before sending', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const generateStart = source.indexOf('async function generateAdminMentionReply');
    const generateEnd = source.indexOf('function buildReplyReference', generateStart);
    const handleStart = source.indexOf('async function handleAdminMentionCommand');
    const handleEnd = source.indexOf('async function handleAdminPokeCommand');

    assert.notEqual(generateStart, -1);
    assert.notEqual(generateEnd, -1);
    assert.notEqual(handleStart, -1);
    assert.notEqual(handleEnd, -1);

    const generateSource = source.slice(generateStart, generateEnd);
    const handleSource = source.slice(handleStart, handleEnd);

    assert.equal(
        /processMentionOutputText|regexProcessor\.processOutput/.test(generateSource),
        true,
        'generateAdminMentionReply must run generated text through output regex processing'
    );
    assert.match(handleSource, /generateAdminMentionReply/);
    assert.match(handleSource, /buildMentionMessage\(mentionedParticipant\.participantId,\s*messageText\)/);
});

test('web_search covers 100+ varied search rounds and only returns grounding data', async () => {
    assert.ok(VARIED_SEARCH_SCENARIOS.length >= 100);
    assert.ok(SEARCH_QUERY_GROUPS.life_small_questions.length >= 15);
    assert.ok(SEARCH_QUERY_GROUPS.public_hotspots.length >= 15);
    assert.ok(SEARCH_QUERY_GROUPS.research_frontier.length >= 15);

    const originalFetch = globalThis.fetch;
    const fetchCalls = [];
    globalThis.fetch = createMockFetch(fetchCalls);

    const toolContext = buildAIToolContext({
        config: {
            ai: {
                tools: {
                    webSearch: {
                        enabled: true,
                        provider: 'duckduckgo',
                        maxResults: 1,
                        timeoutMs: 5000,
                        maxSnippetLength: 800
                    }
                }
            }
        },
        logger: silentLogger
    });

    try {
        const observedSources = new Set();
        const observedCategories = new Map();

        for (let round = 0; round < VARIED_SEARCH_SCENARIOS.length; round += 1) {
            const scenario = VARIED_SEARCH_SCENARIOS[round];
            const topic = scenario.category === 'public_hotspots' ? 'news' : 'web';
            const result = await toolContext.handlers.web_search({
                query: scenario.query,
                limit: 2,
                topic
            });
            assertSearchResultIsGroundingOnly(result, `round ${round} ${scenario.category}: ${scenario.query}`);
            observedSources.add(result.source);
            observedCategories.set(scenario.category, (observedCategories.get(scenario.category) || 0) + 1);
        }

        assert.equal(observedCategories.get('life_small_questions'), 15);
        assert.equal(observedCategories.get('public_hotspots'), 15);
        assert.equal(observedCategories.get('research_frontier'), 15);
        assert.ok(observedSources.has('duckduckgo_html'));
        assert.ok(observedSources.has('duckduckgo_news'));

        // 天气/汇率：只向模型返回数据，不得替模型输出最终回答
        const weather = await toolContext.handlers.get_weather({ location: '北京', days: 2 });
        assert.equal(weather.ok, true);
        assert.equal(weather.source, 'duckduckgo_weather');
        assert.match(weather.summary, /北京/);
        assert.equal('reply' in weather, false);
        assert.equal('response' in weather, false);

        const currency = await toolContext.handlers.convert_currency({ from: 'USD', to: 'CNY', amount: 1 });
        assert.equal(currency.ok, true);
        assert.equal(currency.source, 'duckduckgo_currency');
        assert.ok(currency.rate > 0);
        assert.equal('reply' in currency, false);

        // 页面正文读取：只返回正文数据
        const page = await toolContext.handlers.web_fetch({ url: 'https://example.test/article', maxChars: 800 });
        assert.equal(page.ok, true);
        assert.match(page.text, /正文/);
        assert.equal('reply' in page, false);

        assert.ok(fetchCalls.some((url) => url.includes('html.duckduckgo.com')));
        assert.ok(fetchCalls.some((url) => url.includes('/news.js')));
        assert.ok(fetchCalls.some((url) => url.includes('/js/spice/forecast/')));
        assert.ok(fetchCalls.some((url) => url.includes('/js/spice/currency/')));
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('runtime code no longer exposes realtime direct-answer bypass', () => {
    const indexSource = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const routesSource = fs.readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
    const toolsSource = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
    const publicSource = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

    for (const source of [indexSource, routesSource, toolsSource, publicSource]) {
        assert.doesNotMatch(source, /generateRealtimeAnswer/);
        assert.doesNotMatch(source, /buildDirectRealtimeResponse/);
        assert.doesNotMatch(source, /realtime_bypass/);
        assert.doesNotMatch(source, /buildRealtimeGroundingMessage/);
        assert.doesNotMatch(source, /matchRealtimeIntent/);
    }

    // 旧的程序直答数据源（wttr.in / rss2json / er-api）不再被运行时引用
    for (const source of [indexSource, routesSource, toolsSource]) {
        assert.doesNotMatch(source, /wttr\.in/);
        assert.doesNotMatch(source, /rss2json/);
        assert.doesNotMatch(source, /open\.er-api/);
    }
});

test('config UI exposes poke command and QQ emoji id settings', () => {
    const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    assert.ok(html.includes('id="config-chat-emoji-reaction-id"'));
    assert.ok(html.includes('currentConfig.chat?.emojiReactionId ||'));
    assert.ok(html.includes("emojiReactionId: document.getElementById('config-chat-emoji-reaction-id').value.trim() || '289'"));
    assert.ok(html.includes('id="config-chat-command-admin-poke-enabled"'));
    assert.ok(html.includes('id="config-chat-command-admin-poke-command"'));
    assert.ok(html.includes('id="config-chat-command-admin-poke-repeat"'));
    assert.ok(html.includes('/戳一戳@A@B'));
    assert.ok(html.includes('成功后不发送完成消息'));
    assert.ok(html.includes('adminPoke: {'));
});
