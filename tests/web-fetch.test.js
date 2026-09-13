import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchPageContent, isPrivateAddress, isPrivateHostname } from '../src/search/fetch-page.js';

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function htmlResponse(html, status = 200, contentType = 'text/html') {
    const buffer = Buffer.from(html, 'utf8');
    return {
        ok: status >= 200 && status < 300,
        status,
        url: 'https://example.test/article',
        headers: new Map([['content-type', contentType]]),
        async arrayBuffer() {
            return buffer;
        }
    };
}

function withMockFetch(handler, callback) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        calls.push(String(url));
        return handler(new URL(String(url)), options);
    };
    return Promise.resolve()
        .then(callback)
        .finally(() => {
            globalThis.fetch = originalFetch;
        });
}

test('内网地址识别覆盖常见 IPv4 / IPv6 / 主机名', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.1.1', '0.0.0.0', '100.64.0.1']) {
        assert.equal(isPrivateAddress(address), true, address);
    }
    for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1']) {
        assert.equal(isPrivateAddress(address), false, address);
    }
    assert.equal(isPrivateAddress('::1'), true);
    assert.equal(isPrivateAddress('fe80::1'), true);
    assert.equal(isPrivateAddress('fd00::1'), true);
    assert.equal(isPrivateAddress('::ffff:192.168.0.1'), true);
    assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);

    for (const hostname of ['localhost', 'foo.local', 'bar.internal', 'ip6-localhost']) {
        assert.equal(isPrivateHostname(hostname), true, hostname);
    }
    assert.equal(isPrivateHostname('example.com'), false);
});

test('拒绝访问本机与内网 URL（不会发起请求）', async () => {
    await withMockFetch(() => {
        throw new Error('fetch should not be called for private urls');
    }, async () => {
        for (const url of ['http://127.0.0.1:8001/api/status', 'http://localhost/secret', 'http://10.0.0.5/admin', 'http://[::1]/x']) {
            await assert.rejects(
                () => fetchPageContent({ url, logger: silentLogger }),
                /拒绝访问/,
                url
            );
        }
        await assert.rejects(
            () => fetchPageContent({ url: 'file:///etc/passwd', logger: silentLogger }),
            /只支持 http\/https/
        );
        await assert.rejects(
            () => fetchPageContent({ url: 'not-a-url', logger: silentLogger }),
            /无效的 URL/
        );
    });
});

test('Readability 提取正文并限制字符数', async () => {
    const longParagraph = '这是一段用于测试正文截断的长文本，包含足够的字符数量以便触发截断逻辑。MimirLink 搜索模块移植了 Mozilla Readability 来提取网页正文，并按照配置的最大字符数截断输出。';
    const articleHtml = `<!DOCTYPE html><html><head><title>测试文章</title></head><body>
        <nav>导航栏</nav>
        <article>
            <h1>测试文章标题</h1>
            <p>第一段正文内容，用于验证 Readability 提取逻辑。这里需要足够多的文字，让正文块被识别为文章主体。</p>
            <p>${longParagraph}</p>
            <p>${longParagraph}</p>
            <p>${longParagraph}</p>
            <p>${longParagraph}</p>
            <p>${longParagraph}</p>
            <p>结尾段落：这段文字应当出现在截断之后被丢弃。</p>
        </article>
        <footer>页脚内容</footer>
    </body></html>`;

    await withMockFetch((parsed) => {
        assert.equal(parsed.hostname, 'example.test');
        return htmlResponse(articleHtml);
    }, async () => {
        const page = await fetchPageContent({ url: 'https://example.test/article', maxChars: 500, logger: silentLogger });
        assert.equal(page.ok, true);
        assert.equal(page.quality, 'readable');
        assert.match(page.title, /测试文章/);
        assert.match(page.text, /第一段正文内容/);
        assert.equal(page.truncated, true);
        assert.ok(page.text.length <= 501, `text length ${page.text.length}`);
        assert.equal('reply' in page, false);
        assert.equal('response' in page, false);
    });
});

test('非文章页面降级为文本提取', async () => {
    const plainHtml = '<html><head><title>纯文本</title></head><body><div>简单的纯文本页面内容，没有文章结构。</div></body></html>';
    await withMockFetch(() => htmlResponse(plainHtml), async () => {
        const page = await fetchPageContent({ url: 'https://example.test/plain', logger: silentLogger });
        assert.equal(page.ok, true);
        assert.ok(['readable', 'fallback'].includes(page.quality));
        assert.match(page.text, /简单的纯文本页面内容/);
    });
});

test('页面 HTTP 错误与空正文会抛出明确错误', async () => {
    await withMockFetch(() => htmlResponse('not found', 404, 'text/plain'), async () => {
        await assert.rejects(
            () => fetchPageContent({ url: 'https://example.test/missing', logger: silentLogger }),
            /HTTP 404/
        );
    });

    await withMockFetch(() => htmlResponse('<html><body>   </body></html>'), async () => {
        await assert.rejects(
            () => fetchPageContent({ url: 'https://example.test/empty', logger: silentLogger }),
            /未能提取到页面正文/
        );
    });
});
