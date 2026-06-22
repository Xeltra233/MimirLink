import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { detectChainLeak } from '../src/chain-leak-detection.js';

test('hidden provider reasoning does not trigger chain leak retry', () => {
    const result = detectChainLeak({
        rawReply: '<thinking>\u65b9\u5706\u5224\u65ad\uff1a\u5bf9\u65b9\u53ea\u662f\u5728\u558a\u5f90\u7f3a\u3002</thinking>\u8bf4\u5427\u3002',
        visibleReply: '<thinking>\u65b9\u5706\u5224\u65ad\uff1a\u5bf9\u65b9\u53ea\u662f\u5728\u558a\u5f90\u7f3a\u3002</thinking>\u8bf4\u5427\u3002',
        reasoningContent: "**Refining Current Context**\nI'm currently analyzing the speaker's identity before crafting the response.",
        userInput: '\u5f90\u7f3a'
    });

    assert.equal(result.leaked, false);
});

test('visible English reasoning log triggers chain leak retry', () => {
    const result = detectChainLeak({
        rawReply: "**Refining Current Context**\nI'm currently analyzing the speaker's identity to determine the precise intent behind their query.",
        visibleReply: "**Refining Current Context**\nI'm currently analyzing the speaker's identity to determine the precise intent behind their query.",
        userInput: '\u5f90\u7f3a'
    });

    assert.equal(result.leaked, true);
    assert.equal(result.reason, 'english-reasoning-phrase');
});

test('explicit English and code requests are not mistaken for chain leaks', () => {
    const englishResult = detectChainLeak({
        rawReply: 'This is the English answer the user asked for.',
        visibleReply: 'This is the English answer the user asked for.',
        userInput: 'Please answer in English.'
    });
    const codeResult = detectChainLeak({
        rawReply: '```js\nconst answer = 42;\nfunction run() {\n  return answer;\n}\n```',
        visibleReply: '```js\nconst answer = 42;\nfunction run() {\n  return answer;\n}\n```',
        userInput: 'Write JavaScript code.'
    });

    assert.equal(englishResult.leaked, false);
    assert.equal(codeResult.leaked, false);
});

test('real chat retry detector only receives visible reply text', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const detectorCallStart = source.indexOf('const chainLeak = detectChainLeak({');
    const detectorCallEnd = source.indexOf('});', detectorCallStart);
    const detectorCall = source.slice(detectorCallStart, detectorCallEnd);

    assert.ok(detectorCallStart >= 0);
    assert.ok(detectorCall.includes('rawReply: reply'));
    assert.ok(detectorCall.includes('visibleReply: reply'));
    assert.ok(!detectorCall.includes('reasoningContent'));
});
