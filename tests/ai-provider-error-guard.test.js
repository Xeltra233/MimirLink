import test from 'node:test';
import assert from 'node:assert/strict';
import { AIClient } from '../src/ai.js';

function jsonResponse(payload, init = {}) {
    return new Response(JSON.stringify(payload), {
        status: init.status || 200,
        statusText: init.statusText || 'OK',
        headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
}

test('AI client treats upstream rate-limit content as retryable error, not normal reply', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
            return jsonResponse({
                choices: [{
                    message: {
                        role: 'assistant',
                        content: '[Upstream error: Rate limit exceeded. Please try again in a minute.]'
                    }
                }]
            });
        }
        return jsonResponse({
            choices: [{
                message: {
                    role: 'assistant',
                    content: '稳定画像: 正常恢复后的档案\n当前状态: ok'
                }
            }]
        });
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    }, { info() {}, warn() {}, error() {}, debug() {} });

    const result = await client.chat([{ role: 'user', content: '分析人物档案' }]);
    assert.equal(callCount >= 2, true);
    assert.match(result.content, /稳定画像: 正常恢复后的档案/);
    assert.doesNotMatch(result.content, /Rate limit exceeded/i);
});

test('AI client rejects provider error content via getVisibleResponseContent', () => {
    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model'
    }, { info() {}, warn() {}, error() {}, debug() {} });

    assert.throws(
        () => client.getVisibleResponseContent({
            content: '[Upstream error: Rate limit exceeded. Please try again in a minute.]'
        }),
        /上游错误内容|Rate limit/i
    );
});

test('AI client retries HTTP 429 rate limit responses', async () => {
    let callCount = 0;
    globalThis.fetch = async () => {
        callCount += 1;
        if (callCount === 1) {
            return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), {
                status: 429,
                statusText: 'Too Many Requests',
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return jsonResponse({
            choices: [{
                message: {
                    role: 'assistant',
                    content: 'retry ok'
                }
            }]
        });
    };

    const client = new AIClient({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'test-key',
        model: 'test-model',
        maxTokens: 1024,
        temperature: 0.7
    }, { info() {}, warn() {}, error() {}, debug() {} });

    const result = await client.chat([{ role: 'user', content: 'hello' }]);
    assert.equal(callCount >= 2, true);
    assert.equal(result.content, 'retry ok');
});
