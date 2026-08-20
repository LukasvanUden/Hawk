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

function fetchHistoryBatch(sock, count, oldestMsgKey, oldestMsgTimestamp, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
        let requestId;
        const cleanup = () => {
            clearTimeout(timeout);
            sock.ev.off('messaging-history.set', onHistory);
            sock.ev.off('connection.update', onConnection);
        };
        const onHistory = batch => {
            if (!requestId || batch.peerDataRequestSessionId !== requestId) return;
            cleanup();
            resolve(batch.messages || []);
        };
        const onConnection = update => {
            if (update.connection !== 'close') return;
            cleanup();
            reject(new Error('WhatsApp connection closed during backfill'));
        };
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error('WhatsApp history request timed out'));
        }, timeoutMs);

        sock.ev.on('messaging-history.set', onHistory);
        sock.ev.on('connection.update', onConnection);
        sock.fetchMessageHistory(count, oldestMsgKey, oldestMsgTimestamp)
            .then(id => { requestId = id; })
            .catch(error => {
                cleanup();
                reject(error);
            });
    });
}

module.exports = { fetchHistoryBatch, registerMessageArchiveHandlers };
