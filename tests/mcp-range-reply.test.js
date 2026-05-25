import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { createMCPHandler, sanitizeMcpRangeReply } from '../src/mcp.js';
import { PromptBuilder } from '../src/prompt.js';
import { RegexProcessor } from '../src/regex.js';

let testPortOffset = 0;

async function listenTestApp(app) {
    const port = 25080 + (testPortOffset++ % 1000);
    return new Promise((resolve, reject) => {
        const server = app.listen(port, '127.0.0.1', () => resolve(server));
        server.once('error', reject);
    });
}

test('sanitizeMcpRangeReply strips internal tags and keeps visible reply', () => {
    const reply = sanitizeMcpRangeReply('<thinking>草稿</thinking>\n这步能跑通就很关键。');

    assert.equal(reply, '这步能跑通就很关键。');
});

test('sanitizeMcpRangeReply prefers content tag over thinking text', () => {
    const reply = sanitizeMcpRangeReply('<thinking>方圆：不要发我</thinking><content>在，啥事，说吧。</content>');

    assert.equal(reply, '在，啥事，说吧。');
});

test('sanitizeMcpRangeReply rejects empty visible replies', () => {
    assert.throws(
        () => sanitizeMcpRangeReply('<thinking>只有内部思考</thinking>'),
        /AI 返回空回复/
    );
});

test('mcp range_test returns observation fields for prompt, reasoning, raw and final replies', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));

    const config = {
        chat: { defaultCharacter: '角色A', modelProviderId: 'provider-chat', model: 'deepseek-v4-pro' },
        ai: { model: 'fallback-model', providers: [{ id: 'provider-chat', name: 'Provider', model: 'provider-model' }] },
        preset: { enabled: true, prompts: [] },
        regex: {
            enabled: true,
            rules: [{ name: 'MCP Rename', pattern: 'provider', flags: 'g', replacement: 'Provider', enabled: true, stage: 'output' }]
        },
        bindings: { global: { regexRules: [] }, characters: {} }
    };
    const characterManager = {
        readFromPng() {
            return { name: '角色A', description: '角色描述', personality: '', scenario: '', system_prompt: '', first_mes: '' };
        },
        readOverrides() { return {}; }
    };
    const worldBookManager = {
        readWorldBook() { return null; },
        matchEntries() { return []; },
        clearCache() {}
    };
    const promptBuilder = new PromptBuilder(characterManager, worldBookManager, config);
    const managers = {
        aiClient: {
            async chat() {
                return {
                    content: '<thinking>方圆：内部</thinking><content>mcp provider 回复</content>',
                    reasoningContent: 'mcp reasoning',
                    usage: { total_tokens: 12 }
                };
            },
            getVisibleResponseContent(result) { return result.content || ''; }
        },
        promptBuilder,
        characterManager,
        worldBookManager,
        regexProcessor: new RegexProcessor(config.regex, { info() {}, warn() {}, error() {}, debug() {} }),
        sessionManager: {
            listVariables() { return []; },
            upsertVariable() {},
            listParticipantProfiles() { return []; }
        },
        logger: { info() {}, warn() {}, error() {}, debug() {} }
    };

    app.post('/mcp', createMCPHandler(managers, config, () => {}));
    const server = await listenTestApp(app);
    const { port } = server.address();

    try {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'range_test',
                    arguments: {
                        message: '你好',
                        characterName: '角色A',
                        fakeHistory: [{ role: 'user', content: '上一句' }]
                    }
                }
            })
        });
        const rpc = await response.json();
        const payload = JSON.parse(rpc.result.content[0].text);

        assert.equal(response.status, 200);
        assert.equal(payload.rawReply, '<thinking>方圆：内部</thinking><content>mcp provider 回复</content>');
        assert.equal(payload.regexProcessedReply, 'mcp Provider 回复');
        assert.equal(payload.cleanedReply, 'mcp Provider 回复');
        assert.equal(payload.finalReply, 'mcp Provider 回复');
        assert.equal(payload.reasoningContent, '方圆：内部');
        assert.equal(payload.inputHeader.includes('eventType:mcp_range_test'), true);
        assert.equal(payload.fakeHistoryCount, 1);
        assert.equal(Array.isArray(payload.prompt.messages), true);
        assert.equal(Array.isArray(payload.messageTrace), true);
        assert.equal(payload.prompt.currentMessageFocus?.meta?.source, 'current_message_focus');
        assert.equal(payload.regexTrace.output.appliedRules.some((rule) => rule.name === 'MCP Rename'), true);
        assert.equal(payload.observation.finalReply, payload.finalReply);
    } finally {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
