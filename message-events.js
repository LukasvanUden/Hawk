function registerMessageArchiveHandlers(sock, archiveMessages) {
    sock.ev.on('messages.upsert', async ({ messages, type, requestId }) => {
        if (type !== 'notify' && type !== 'append') return;
        await archiveMessages(messages, { source: 'upsert', type, requestId });
    });

    sock.ev.on('messaging-history.set', async ({ messages, syncType, progress, isLatest, peerDataRequestSessionId }) => {
        if (!messages || messages.length === 0) return;
        await archiveMessages(messages, {
            source: 'history',
            syncType,
            progress,
            isLatest,
            peerDataRequestSessionId
        });
    });
}

module.exports = { registerMessageArchiveHandlers };
