// Tiny, pure helpers for connection alerts — kept out of index.js so they can be
// unit-tested without starting the server or importing Baileys.

const LOGGED_OUT = 401; // DisconnectReason.loggedOut

// The ONLY connection event worth pinging a human about: a logout that needs a
// manual re-link (QR scan). Reconnectable drops (restart-required, lost connection)
// recover on their own and must stay silent — that constant noise is exactly what
// was deliberately disabled before (commit ef420fa).
function buildLogoutAlert(renderUrl) {
    const link = renderUrl ? `\n\nNeu verknüpfen: ${renderUrl}` : '';
    return `🔴 Hawk wurde abgemeldet${link}`;
}

module.exports = { buildLogoutAlert, LOGGED_OUT };
