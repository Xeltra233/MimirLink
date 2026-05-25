import test from 'node:test';
import assert from 'node:assert/strict';
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

