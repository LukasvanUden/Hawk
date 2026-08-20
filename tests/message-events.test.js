const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');

const { registerMessageArchiveHandlers } = require('../message-events');

function createSocket() {
    return { ev: new EventEmitter() };
}

function nextTick() {
    return new Promise(resolve => setImmediate(resolve));
}

test('archives messages emitted by history sync', async () => {
    const sock = createSocket();
    const archived = [];

    registerMessageArchiveHandlers(sock, async (messages, context) => {
        archived.push({ messages, context });
    });

    sock.ev.emit('messaging-history.set', {
        messages: [{ key: { id: 'history-message' } }],
        syncType: 2,
        progress: 100,
        isLatest: true
    });
    await nextTick();

    assert.equal(archived.length, 1);
    assert.equal(archived[0].messages[0].key.id, 'history-message');
    assert.equal(archived[0].context.source, 'history');
    assert.equal(archived[0].context.progress, 100);
});

test('archives notify and append upserts only', async () => {
    const sock = createSocket();
    const archived = [];

    registerMessageArchiveHandlers(sock, async (messages, context) => {
        archived.push({ messages, context });
    });

    sock.ev.emit('messages.upsert', {
        messages: [{ key: { id: 'notify-message' } }],
        type: 'notify'
    });
    sock.ev.emit('messages.upsert', {
        messages: [{ key: { id: 'ignored-message' } }],
        type: 'replace'
    });
    sock.ev.emit('messages.upsert', {
        messages: [{ key: { id: 'append-message' } }],
        type: 'append',
        requestId: 'phone-backfill'
    });
    await nextTick();

    assert.equal(archived.length, 2);
    assert.deepEqual(archived.map(batch => batch.messages[0].key.id), ['notify-message', 'append-message']);
    assert.deepEqual(archived.map(batch => batch.context.source), ['upsert', 'upsert']);
    assert.equal(archived[1].context.requestId, 'phone-backfill');
});
