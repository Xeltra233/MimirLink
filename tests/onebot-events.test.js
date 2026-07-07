import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OneBotClient } from '../src/onebot.js';

function createClient() {
    return new OneBotClient({ mode: 'ws', url: 'ws://127.0.0.1:1' }, {
        info() {},
        warn() {},
        error() {},
        debug() {}
    });
}

test('websocket event handler forwards OneBot notice and request events', () => {
    const client = createClient();
    const received = [];
    client.on('message', (event) => received.push(event));

    const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: 10001, target_id: 10002 };
    const request = { post_type: 'request', request_type: 'friend', user_id: 10003 };
    client._handleMessage(poke);
    client._handleMessage(request);

    assert.deepEqual(received, [poke, request]);
});

test('websocket event handler still resolves API echoes without emitting them as messages', async () => {
    const client = createClient();
    const received = [];
    client.on('message', (event) => received.push(event));

    const resolved = new Promise((resolve, reject) => {
        client.pendingCalls.set('echo-1', { resolve, reject });
    });
    client._handleMessage({ echo: 'echo-1', status: 'ok', data: { ok: true } });

    assert.deepEqual(await resolved, { ok: true });
    assert.equal(received.length, 0);
});

test('record messages can carry reply and mention prefix segments', async () => {
    const client = createClient();
    const calls = [];
    client._call = async (action, params) => {
        calls.push({ action, params });
        return { ok: true };
    };

    const tempFile = path.join(os.tmpdir(), `mimirlink-record-${Date.now()}.silk`);
    fs.writeFileSync(tempFile, Buffer.from('audio-bytes'));
    try {
        await client.sendGroupRecord(10001, tempFile, [
            { type: 'reply', data: { id: '30003' } },
            { type: 'at', data: { qq: '20002' } }
        ]);
    } finally {
        fs.rmSync(tempFile, { force: true });
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'send_group_msg');
    assert.equal(calls[0].params.group_id, 10001);
    assert.deepEqual(calls[0].params.message.slice(0, 2), [
        { type: 'reply', data: { id: '30003' } },
        { type: 'at', data: { qq: '20002' } }
    ]);
    assert.equal(calls[0].params.message[2].type, 'record');
    assert.match(calls[0].params.message[2].data.file, /^base64:\/\//);
});
