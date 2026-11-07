const assert = require('node:assert/strict');
const test = require('node:test');

const { buildLogoutAlert, LOGGED_OUT } = require('../connection-alerts');

test('logout alert names the problem and tells the user to re-scan', () => {
    const msg = buildLogoutAlert();
    assert.match(msg, /abgemeldet/i);
    assert.match(msg, /scannen/i);
});

test('logout alert includes the re-link URL when one is known', () => {
    const msg = buildLogoutAlert('https://hawk-5f9m.onrender.com');
    assert.ok(msg.includes('https://hawk-5f9m.onrender.com'));
});

test('logout alert omits the link line when no URL is known', () => {
    const msg = buildLogoutAlert('');
    assert.ok(!msg.includes('http'));
});

test('LOGGED_OUT matches WhatsApp status code 401', () => {
    assert.equal(LOGGED_OUT, 401);
});
