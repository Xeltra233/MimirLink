import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('participant profile manual command has visible start, success, and failure feedback', () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const handlerStart = source.indexOf('async function handleParticipantProfileManualCommand');
    const handlerEnd = source.indexOf('async function handleAdminMentionCommand');
    assert.notEqual(handlerStart, -1);
    assert.notEqual(handlerEnd, -1);
    const handler = source.slice(handlerStart, handlerEnd);

    assert.ok(source.includes('async function sendFailureMessage(event, message) {'));
    assert.ok(source.includes('await sendQuotedStatusMessage(event, `⚠️ ${normalizedMessage}`);'));
    assert.ok(handler.includes("await sendFailureMessage(event, '只有管理员可以手动分析人物档案');"));
    assert.ok(handler.includes('正在分析${speakerIdentity.participantName'));
    assert.ok(handler.includes('const profile = await maybeBuildParticipantProfile('));
    assert.ok(handler.indexOf('正在分析${speakerIdentity.participantName') < handler.indexOf('const profile = await maybeBuildParticipantProfile('));
    assert.ok(handler.includes('await dispatchReply(event, `已手动分析人物档案：'));
    assert.ok(handler.includes('await sendFailureMessage(event, `手动分析人物档案失败: ${error.message}`);'));
});
