const assert = require('node:assert/strict');
const test = require('node:test');

const { viewerTokenIdentity, createViewerToken } = require('../viewer-token');

test('default account viewer may read the "Chats" collection', () => {
    const { uid, claims } = viewerTokenIdentity('Chats');
    assert.equal(uid, 'hawk-viewer-Chats');
    assert.deepEqual(claims, { hawkChats: 'Chats' });
});

test('a namespaced account gets its own uid and collection', () => {
    const { uid, claims } = viewerTokenIdentity('freund_Chats');
    assert.equal(uid, 'hawk-viewer-freund_Chats');
    assert.deepEqual(claims, { hawkChats: 'freund_Chats' });
});

test('refuses to issue a token for a collection that is not a chats collection', () => {
    assert.throws(() => viewerTokenIdentity('whatsapp_auth'));
    assert.throws(() => viewerTokenIdentity('phone2_auth'));
    assert.throws(() => viewerTokenIdentity(''));
});

test('createViewerToken passes uid and claims to the auth service', async () => {
    const calls = [];
    const fakeAuth = { createCustomToken: async (uid, claims) => { calls.push([uid, claims]); return 'signed-token'; } };
    const token = await createViewerToken(fakeAuth, 'Chats');
    assert.equal(token, 'signed-token');
    assert.deepEqual(calls, [['hawk-viewer-Chats', { hawkChats: 'Chats' }]]);
});
