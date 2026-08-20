const {
    default: makeWASocket,
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    BufferJSON,
    initAuthCreds,
    downloadMediaMessage,
    proto
} = require('@whiskeysockets/baileys');
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const admin = require('firebase-admin');
const crypto = require('crypto');
const path = require('path');
const { fetchHistoryBatch, registerMessageArchiveHandlers } = require('./message-events');

// --- CONFIGURATION ---
const PORT = process.env.PORT || 3000;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
const APP_HTML_PATH = path.join(__dirname, 'index.html');
const ASSET_PATHS = {
    '/assets/icon.svg': path.join(__dirname, 'icon.svg'),
    '/assets/manifest-wpChat.json': path.join(__dirname, 'manifest.json'),
    '/assets/sw-wpChat.js': path.join(__dirname, 'sw.js')
};

// Per-account namespace: lets one Firebase project hold several phones side by side.
// - Leave ACCOUNT_ID unset for the original phone (keeps existing 'Chats'/'whatsapp_auth').
// - Set ACCOUNT_ID (e.g. "phone2") for an additional phone → its data + session live
//   under their own prefixed collections, fully separate from the first account.
const ACCOUNT_ID = (process.env.ACCOUNT_ID || '').trim();
const CHATS_COLLECTION = ACCOUNT_ID ? `${ACCOUNT_ID}_Chats` : 'Chats';
const AUTH_COLLECTION = ACCOUNT_ID ? `${ACCOUNT_ID}_auth` : 'whatsapp_auth';
console.log(`System: Account namespace = "${ACCOUNT_ID || '(default)'}" → data collection "${CHATS_COLLECTION}"`);

// Initialize Express
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 

// --- FIREBASE SETUP ---
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } else {
        serviceAccount = require('./serviceAccountKey.json');
    }

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log("System: Firebase Admin initialized successfully.");
} catch (error) {
    console.error("System Error: Failed to initialize Firebase. Make sure FIREBASE_SERVICE_ACCOUNT env var is set.");
    process.exit(1);
}

const db = admin.firestore();

// Firebase Storage bucket for media (voice notes / audio). Override via env if needed.
const STORAGE_BUCKET = process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`;
console.log(`System: Storage bucket = "${STORAGE_BUCKET}"`);

// Format a duration in seconds as m:ss (e.g. 312 -> "5:12")
function formatDuration(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Tracks groups whose name we've already resolved this session (avoids refetching)
const resolvedGroups = new Set();

// Fetch a group's subject (its real name) and store it as the chat's display name
async function syncGroupName(jid) {
    try {
        if (!sock) return;
        const meta = await sock.groupMetadata(jid);
        if (meta && meta.subject) {
            await db.collection(CHATS_COLLECTION).doc(jid).set({ displayName: meta.subject }, { merge: true });
        }
    } catch (err) {
        // Group metadata not available (e.g. we left the group) — ignore quietly
    }
}

// --- FIRESTORE AUTH ADAPTER FOR BAILEYS ---
async function useFirestoreAuthState(db, collectionName = 'whatsapp_auth') {
    const collection = db.collection(collectionName);

    const writeData = async (data, id) => {
        try {
            // BufferJSON converts buffers & uint8 arrays into storable base64 strings
            const str = JSON.stringify(data, BufferJSON.replacer);
            await collection.doc(id).set({ data: str });
        } catch (err) {
            console.error("System: Error writing auth state:", err.message);
        }
    };

    const readData = async (id) => {
        try {
            const doc = await collection.doc(id).get();
            if (doc.exists) {
                return JSON.parse(doc.data().data, BufferJSON.reviver);
            }
        } catch (err) {
            console.error("System: Error reading auth state:", err.message);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await collection.doc(id).delete();
        } catch (err) {
            console.error("System: Error removing auth state:", err.message);
        }
    };

    const clearState = async () => {
        const documents = await collection.listDocuments();
        await Promise.all(documents.map(document => document.delete()));
        console.log(`System: Cleared ${documents.length} WhatsApp auth document(s) from Firestore.`);
    };

    // Load credentials from Firestore or generate new ones (for initial QR scan)
    const storedCreds = await readData('creds');
    if (!storedCreds) {
        // A missing primary credential document means any remaining Signal keys are stale.
        await clearState();
    }
    const creds = storedCreds || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const docId = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, docId));
                            } else {
                                tasks.push(removeData(docId));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        },
        clearState
    };
}

// --- BAILEYS SETUP ---
let qrCodeData = null;
let sock = null;
let isConnected = false;
let isConnecting = false;
let reconnectTimer = null;
let reconnectAttempt = 0;
let backfillRunning = false;
let backfillPaused = false;
const BACKFILL_JOB_ID = 'backfill-2026-08-20-3-days';
const BACKFILL_CONTROL_ID = 'backfill-control';
let backfillState = {
    status: 'idle',
    days: 3,
    chats: 0,
    currentChat: 0,
    requested: 0,
    received: 0,
    skipped: 0,
    failed: 0,
    error: null
};

async function setBackfillState(patch) {
    backfillState = { ...backfillState, ...patch, updatedAt: new Date().toISOString() };
    try {
        await db.collection('Hawk_Jobs').doc(BACKFILL_CONTROL_ID).set(backfillState, { merge: true });
    } catch (error) {
        console.log(`System: Could not persist backfill status: ${error.message}`);
    }
}

async function waitWhileBackfillPaused(currentSocket) {
    while (backfillPaused) {
        if (sock !== currentSocket || !isConnected) {
            throw new Error('WhatsApp connection changed while backfill was paused');
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

function messageTimestampSeconds(message) {
    const timestamp = message?.messageTimestamp;
    if (!timestamp) return 0;
    if (typeof timestamp === 'number') return timestamp;
    if (typeof timestamp.toNumber === 'function') return timestamp.toNumber();
    return timestamp.low || 0;
}

async function backfillRecentMessages(currentSocket, days = 3) {
    const cutoff = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);
    const chats = await db.collection(CHATS_COLLECTION).where('lastActive', '>=', cutoff).get();
    const stats = { chats: chats.size, requested: 0, received: 0, skipped: 0, failed: 0 };

    await setBackfillState({ ...stats, currentChat: 0 });

    for (let chatIndex = 0; chatIndex < chats.docs.length; chatIndex++) {
        const chat = chats.docs[chatIndex];
        if (sock !== currentSocket || !isConnected) throw new Error('WhatsApp connection changed during backfill');

        const anchor = await chat.ref.collection('Messages')
            .where('timestamp', '>', cutoff)
            .orderBy('timestamp', 'asc')
            .limit(1)
            .get();
        if (anchor.empty) {
            stats.skipped++;
            await setBackfillState({ ...stats, currentChat: chatIndex + 1 });
            continue;
        }

        const oldestKnownMessage = anchor.docs[0].data();
        let oldestKey = {
            remoteJid: chat.id,
            fromMe: Boolean(oldestKnownMessage.fromMe),
            id: oldestKnownMessage.id
        };
        let oldestTimestamp = Number(oldestKnownMessage.timestamp || 0);
        if (!oldestKey.id) {
            stats.skipped++;
            await setBackfillState({ ...stats, currentChat: chatIndex + 1 });
            continue;
        }

        // ponytail: cap each chat at 500 messages; raise only if a busier chat needs more than three days.
        for (let page = 0; page < 10 && oldestTimestamp > cutoff; page++) {
            try {
                await waitWhileBackfillPaused(currentSocket);
                const messages = await fetchHistoryBatch(currentSocket, 50, oldestKey, oldestTimestamp);
                stats.requested++;
                stats.received += messages.length;
                await setBackfillState({ ...stats, currentChat: chatIndex + 1 });
                if (!messages.length) break;

                const datedMessages = messages
                    .map(message => ({ message, timestamp: messageTimestampSeconds(message) }))
                    .filter(item => item.message.key?.id && item.timestamp > 0)
                    .sort((a, b) => a.timestamp - b.timestamp);
                const oldest = datedMessages[0];
                if (!oldest || oldest.timestamp >= oldestTimestamp) break;

                oldestKey = oldest.message.key;
                oldestTimestamp = oldest.timestamp;
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                stats.failed++;
                await setBackfillState({ ...stats, currentChat: chatIndex + 1 });
                console.log(`System: Backfill chat failed: ${error.message}`);
                break;
            }
        }
    }

    console.log(`System: Backfill complete days=${days} chats=${stats.chats} requests=${stats.requested} received=${stats.received} skipped=${stats.skipped} failed=${stats.failed}`);
    return stats;
}

async function launchBackfill(currentSocket, days) {
    backfillRunning = true;
    backfillPaused = false;
    await setBackfillState({
        status: 'running',
        days,
        chats: 0,
        currentChat: 0,
        requested: 0,
        received: 0,
        skipped: 0,
        failed: 0,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null
    });

    try {
        const stats = await backfillRecentMessages(currentSocket, days);
        const status = stats.received === 0 ? 'empty' : 'complete';
        await setBackfillState({ ...stats, status, completedAt: new Date().toISOString() });
        return stats;
    } catch (error) {
        await setBackfillState({ status: 'failed', error: error.message });
        throw error;
    } finally {
        backfillRunning = false;
        backfillPaused = false;
    }
}

async function runPendingBackfill(currentSocket) {
    const job = db.collection('Hawk_Jobs').doc(BACKFILL_JOB_ID);
    const snapshot = await job.get();
    if (snapshot.data()?.status === 'complete' || backfillRunning) return;

    await job.set({ status: 'running', startedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    try {
        const stats = await launchBackfill(currentSocket, 3);
        await job.set({ status: 'complete', completedAt: admin.firestore.FieldValue.serverTimestamp(), stats }, { merge: true });
    } catch (error) {
        await job.set({ status: 'failed', error: error.message }, { merge: true });
        console.log(`System: Backfill failed: ${error.message}`);
    }
}

function describeDisconnect(error) {
    const statusCode = error?.output?.statusCode ?? error?.statusCode;
    return {
        statusCode: statusCode ?? 'unknown',
        reason: DisconnectReason[statusCode] || 'unknown',
        message: error?.output?.payload?.message || error?.message || 'No error details',
        uptimeSeconds: Math.round(process.uptime())
    };
}

function scheduleReconnect(delayMs = Math.min(5000 * (2 ** reconnectAttempt), 60000)) {
    if (reconnectTimer) {
        console.log("System: Reconnect already scheduled; ignoring duplicate close event.");
        return;
    }

    reconnectAttempt++;
    console.log(`System: Reconnecting in ${delayMs / 1000}s (attempt ${reconnectAttempt})...`);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startWhatsApp();
    }, delayMs);
}

async function startWhatsApp() {
    if (isConnecting) {
        console.log("System: Connection attempt already running; skipping duplicate start.");
        return;
    }

    isConnecting = true;
    const logger = pino({ level: 'warn' });
    let currentSocket;
    let saveCreds;
    let clearState;

    try {
        // Use our custom Firestore Auth adapter instead of useMultiFileAuthState
        const authState = await useFirestoreAuthState(db, AUTH_COLLECTION);
        const { state } = authState;
        ({ saveCreds, clearState } = authState);
        const { version } = await fetchLatestBaileysVersion();

        console.log(`System: Connecting to WhatsApp servers (Baileys ${version.join('.')})...`);

        currentSocket = makeWASocket({
            version,
            logger,
            auth: state,
            browser: Browsers.ubuntu('Chrome'),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 30000,
            syncFullHistory: true
        });
        sock = currentSocket;
    } catch (err) {
        console.error(`System: WhatsApp connection setup failed ${JSON.stringify(describeDisconnect(err))}`);
        scheduleReconnect();
        return;
    } finally {
        isConnecting = false;
    }

    currentSocket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("System: No valid credentials. New QR Code generated.");
            qrCodeData = qr;
            isConnected = false;
        }

        if (connection === 'close') {
            if (sock !== currentSocket) {
                console.log("System: Ignoring close event from an outdated socket.");
                return;
            }

            sock = null;
            isConnected = false;
            const details = describeDisconnect(lastDisconnect?.error);
            console.log(`System: WhatsApp connection closed ${JSON.stringify(details)}`);

            if (details.statusCode === DisconnectReason.connectionReplaced) {
                console.log("System: A newer instance replaced this connection; reconnect disabled for this process.");
                return;
            } else if (details.statusCode === DisconnectReason.loggedOut) {
                console.log("System: Device Logged Out. Wiping session from Firestore.");
                await clearState();
                qrCodeData = null;
                reconnectAttempt = 0;
                scheduleReconnect(0); // Restart to grab a fresh QR code
            } else {
                scheduleReconnect(details.statusCode === DisconnectReason.restartRequired ? 0 : undefined);
            }
        } else if (connection === 'open') {
            console.log("System: Connection Open and Authenticated. Firebase Auth Sync Active.");
            qrCodeData = null;
            isConnected = true;
            reconnectAttempt = 0;
            if (reconnectTimer) {
                clearTimeout(reconnectTimer);
                reconnectTimer = null;
            }

            // Backfill all group names (subjects) once we're connected
            try {
                const groups = await sock.groupFetchAllParticipating();
                for (const jid in groups) {
                    const subject = groups[jid]?.subject;
                    if (subject) {
                        await db.collection(CHATS_COLLECTION).doc(jid).set({ displayName: subject }, { merge: true });
                        resolvedGroups.add(jid);
                    }
                }
                console.log(`System: Synced names for ${Object.keys(groups).length} group(s).`);
            } catch (err) {
                console.log("System: Could not fetch group names:", err.message);
            }

            runPendingBackfill(currentSocket)
                .catch(error => console.log(`System: Could not start pending backfill: ${error.message}`));
        }
    });

    // Keep group names up to date when a group is renamed
    currentSocket.ev.on('groups.update', async (updates) => {
        for (const g of updates) {
            if (g.id && g.subject) {
                await db.collection(CHATS_COLLECTION).doc(g.id).set({ displayName: g.subject }, { merge: true });
            }
        }
    });

    // Write updated credentials back to Firestore whenever keys change
    currentSocket.ev.on('creds.update', saveCreds);

    // --- FEATURE: REAL NUMBER SYNC ---
    currentSocket.ev.on('contacts.upsert', async (contacts) => {
        for (const contact of contacts) {
            let updateData = {};
            const displayName = contact.name || contact.notify;
            
            if (displayName) updateData.displayName = displayName;

            // Extract the real phone number when available.
            if (contact.id && contact.id.endsWith('@s.whatsapp.net')) {
                updateData.phoneNumber = contact.id.split('@')[0];
            } else if (contact.jid && contact.jid.endsWith('@s.whatsapp.net')) {
                // In Baileys 6.7.23 a LID-primary contact carries its real number
                // here (the field is `jid`, not `phoneNumber`). The old code missed this.
                updateData.phoneNumber = contact.jid.split('@')[0];
            }

            // Sync using LID or ID
            const primaryId = contact.lid || contact.id;

            if (primaryId && Object.keys(updateData).length > 0) {
                try {
                    await db.collection(CHATS_COLLECTION).doc(primaryId).set(updateData, { merge: true });
                    
                    // Keep the fallback JID document synced as well if we routed via LID
                    if (contact.lid && contact.id !== contact.lid) {
                        await db.collection(CHATS_COLLECTION).doc(contact.id).set(updateData, { merge: true });
                    }
                } catch (err) {
                    // Silent fail to keep logs clean
                }
            }
        }
    });

    // Direct LID -> phone-number pair — fires when a peer actively shares its number.
    currentSocket.ev.on('chats.phoneNumberShare', async ({ lid, jid }) => {
        if (!jid || !jid.endsWith('@s.whatsapp.net')) return;
        const phoneNumber = jid.split('@')[0];
        for (const target of [lid, jid].filter(Boolean)) {
            try {
                await db.collection(CHATS_COLLECTION).doc(target).set({ phoneNumber }, { merge: true });
            } catch (err) {
                // ignore
            }
        }
    });

    async function archiveMessages(messages, context = {}) {
        const stats = {
            total: messages.length,
            saved: 0,
            skippedNoMessage: 0,
            skippedStatus: 0,
            skippedUnsupported: 0,
            failed: 0
        };

        for (const msg of messages) {
            try {
                if (!msg.message) {
                    stats.skippedNoMessage++;
                    continue;
                }

                const remoteJid = msg.key.remoteJid;
                if (!remoteJid || remoteJid === 'status@broadcast') {
                    stats.skippedStatus++;
                    continue;
                }

                // Voice notes / audio arrive as audioMessage (sometimes wrapped in ephemeral/view-once)
                const audioMessage =
                    msg.message.audioMessage ||
                    msg.message.ephemeralMessage?.message?.audioMessage ||
                    msg.message.viewOnceMessage?.message?.audioMessage ||
                    msg.message.viewOnceMessageV2?.message?.audioMessage ||
                    null;

                let textContent =
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    "";

                // Keep only what we archive: text OR voice/audio. Skip everything else.
                if (!textContent && !audioMessage) {
                    stats.skippedUnsupported++;
                    continue;
                }

                const timestamp = msg.messageTimestamp
                    ? (typeof msg.messageTimestamp === 'number'
                        ? msg.messageTimestamp
                        : (typeof msg.messageTimestamp.toNumber === 'function'
                            ? msg.messageTimestamp.toNumber()
                            : msg.messageTimestamp.low))
                    : Math.floor(Date.now() / 1000);

                const isFromMe = msg.key.fromMe || false;
                const senderName = isFromMe ? "Me" : (msg.pushName || "Unknown");

                // 1. Ensure Chat Document Exists (+ capture a human-readable name)
                const isGroupChat = remoteJid.endsWith('@g.us');
                const chatMeta = { lastActive: timestamp, id: remoteJid };

                // For 1-on-1 chats, the sender's WhatsApp name (pushName) is the most
                // reliable label we get — especially for privacy-hidden @lid contacts.
                if (!isFromMe && !isGroupChat && msg.pushName) {
                    chatMeta.pushName = msg.pushName;
                }

                // Best-effort phone number: WhatsApp sometimes passes the real number
                // inline on the message key (sender_pn). It's frequently absent for
                // privacy-hidden @lid contacts, so always treat it as optional.
                if (!isFromMe && !isGroupChat && msg.key.senderPn && msg.key.senderPn.endsWith('@s.whatsapp.net')) {
                    chatMeta.phoneNumber = msg.key.senderPn.split('@')[0];
                }

                await db.collection(CHATS_COLLECTION).doc(remoteJid).set(chatMeta, { merge: true });

                // Resolve a group's real name (subject) once per session
                if (isGroupChat && !resolvedGroups.has(remoteJid)) {
                    resolvedGroups.add(remoteJid);
                    syncGroupName(remoteJid);
                }

                // 2. Save Message (for voice notes: download audio -> Storage, keep a reference here)
                const messageData = {
                    text: textContent,
                    senderId: remoteJid,
                    senderName: senderName,
                    timestamp: timestamp,
                    fromMe: isFromMe,
                    id: msg.key.id
                };

                if (audioMessage) {
                    const isPtt = audioMessage.ptt === true;
                    messageData.mediaType = 'audio';
                    messageData.isVoiceNote = isPtt;
                    messageData.durationSeconds = audioMessage.seconds || 0;
                    messageData.mimetype = audioMessage.mimetype || 'audio/ogg';
                    // Label so the message stays meaningful in the viewer even if the upload fails
                    if (!messageData.text) {
                        messageData.text = `🎤 ${isPtt ? 'Sprachnachricht' : 'Audio'} (${formatDuration(audioMessage.seconds)})`;
                    }

                    try {
                        const buffer = await downloadMediaMessage(
                            msg,
                            'buffer',
                            {},
                            { logger, reuploadRequest: currentSocket.updateMediaMessage }
                        );
                        const ext = (audioMessage.mimetype || '').includes('mp4') ? 'm4a' : 'ogg';
                        const storagePath = `voice-notes/${ACCOUNT_ID || 'default'}/${remoteJid}/${msg.key.id}.${ext}`;
                        await admin.storage().bucket(STORAGE_BUCKET).file(storagePath).save(buffer, {
                            resumable: false,
                            metadata: {
                                contentType: messageData.mimetype,
                                metadata: { chat: remoteJid, messageId: msg.key.id }
                            }
                        });
                        messageData.storageBucket = STORAGE_BUCKET;
                        messageData.storagePath = storagePath;
                        messageData.fileSize = buffer.length;
                        console.log(`System: Saved voice note -> ${storagePath} (${buffer.length} bytes)`);
                    } catch (audioErr) {
                        messageData.audioError = true;
                        console.log(`System: Voice note download/upload failed (${msg.key.id}): ${audioErr.message}`);
                    }
                }

                await db.collection(CHATS_COLLECTION)
                    .doc(remoteJid)
                    .collection('Messages')
                    .doc(msg.key.id)
                    .set(messageData, { merge: true });

                stats.saved++;
            } catch (err) {
                stats.failed++;
                console.log(`System: Message archive failed (${context.source || 'unknown'}): ${err.message}`);
            }
        }

        if (context.source || stats.saved || stats.failed) {
            console.log(
                `System: Message archive batch source=${context.source || 'unknown'} total=${stats.total} saved=${stats.saved} skippedNoMessage=${stats.skippedNoMessage} skippedStatus=${stats.skippedStatus} skippedUnsupported=${stats.skippedUnsupported} failed=${stats.failed}`
            );
        }

        return stats;
    }

    registerMessageArchiveHandlers(currentSocket, archiveMessages);
}

// --- AUTH UTILS ---
const SESSION_SECRET = crypto.createHash('sha256').update(AUTH_PASS || 'default').digest('hex');

function parseCookies(request) {
    const list = {};
    const rc = request.headers.cookie;
    if (rc) {
        rc.split(';').forEach((cookie) => {
            const parts = cookie.split('=');
            list[parts.shift().trim()] = decodeURI(parts.join('='));
        });
    }
    return list;
}

// --- EXPRESS ROUTES ---

// 1. Ping (UptimeRobot)
app.get('/ping', (req, res) => {
    res.status(200).send('Pong');
});

// 2. API: Verify Credentials
app.post('/api/verify', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

    if (!AUTH_USER || !AUTH_PASS) {
        return res.json({ success: true, authDisabled: true });
    }

    const { username, password } = req.body;

    if (username === AUTH_USER && password === AUTH_PASS) {
        return res.json({ success: true });
    } else {
        return res.status(401).json({ success: false });
    }
});

// CORS Pre-flight
app.options('/api/verify', (req, res) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.sendStatus(200);
});

// 3. Login Page
app.get('/login', (req, res) => {
    res.send(`
        <html>
            <body style="font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; background: #f0f2f5;">
                <form action="/login" method="POST" style="background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); width: 300px;">
                    <h2 style="margin-top: 0; text-align: center;">WhatsApp Logger</h2>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem;">Username</label>
                        <input type="text" name="username" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: block; margin-bottom: 0.5rem;">Password</label>
                        <input type="password" name="password" required style="width: 100%; padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; box-sizing: border-box;">
                    </div>
                    <div style="margin-bottom: 1rem;">
                        <label style="display: flex; align-items: center; font-size: 0.9rem;">
                            <input type="checkbox" name="remember" value="yes" style="margin-right: 0.5rem;">
                            Keep me logged in for 5 mins
                        </label>
                    </div>
                    <button type="submit" style="width: 100%; padding: 0.75rem; background: #25D366; color: white; border: none; border-radius: 4px; font-weight: bold; cursor: pointer;">Login</button>
                </form>
            </body>
        </html>
    `);
});

// 4. Login Action
app.post('/login', (req, res) => {
    const { username, password, remember } = req.body;

    if (username === AUTH_USER && password === AUTH_PASS) {
        let cookieSettings = 'HttpOnly; Path=/;'; 
        if (remember === 'yes') cookieSettings += ' Max-Age=300;';
        
        res.setHeader('Set-Cookie', `auth_session=${SESSION_SECRET}; ${cookieSettings}`);
        return res.redirect('/');
    }
    res.status(401).send('Invalid credentials. <a href="/login">Try again</a>');
});

// 5. Logout
app.get('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'auth_session=; Max-Age=0; Path=/;');
    res.redirect('/login');
});

// --- MIDDLEWARE ---
const checkAuth = (req, res, next) => {
    if (!AUTH_USER || !AUTH_PASS) return next();
    const cookies = parseCookies(req);
    if (cookies.auth_session === SESSION_SECRET) return next();
    
    if (req.path.startsWith('/api')) res.status(401).send('Unauthorized');
    else res.redirect('/login');
};

app.use(checkAuth);

function startBackfill(req, res) {
    if (!sock || !isConnected) {
        return res.status(409).json({ error: 'WhatsApp is not connected.' });
    }
    if (backfillRunning) {
        return res.status(409).json({ error: 'A backfill is already running.' });
    }

    const days = Number(req.body?.days);
    if (!Number.isInteger(days) || days < 1 || days > 7) {
        return res.status(400).json({ error: 'Days must be a whole number between 1 and 7.' });
    }

    const currentSocket = sock;
    res.status(202).json({ started: true, days });
    launchBackfill(currentSocket, days)
        .catch(error => console.log(`System: Backfill failed: ${error.message}`))
}

async function getBackfillStatus(req, res) {
    let state = backfillState;
    if (!backfillRunning) {
        try {
            const snapshot = await db.collection('Hawk_Jobs').doc(BACKFILL_CONTROL_ID).get();
            if (snapshot.exists) state = snapshot.data();
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    if (!backfillRunning && (state.status === 'running' || state.status === 'paused')) {
        state = { ...state, status: 'interrupted' };
    }
    if (state.status === 'complete' && Number(state.received) === 0) {
        state = { ...state, status: 'empty' };
    }
    res.json({ ...state, connected: isConnected });
}

app.get('/api/backfill/status', getBackfillStatus);
app.post('/api/backfill/start', startBackfill);
app.post('/api/backfill/pause', async (req, res) => {
    if (!backfillRunning || backfillPaused) {
        return res.status(409).json({ error: 'No running backfill can be paused.' });
    }
    backfillPaused = true;
    await setBackfillState({ status: 'paused' });
    res.json({ paused: true });
});
app.post('/api/backfill/resume', async (req, res) => {
    if (backfillRunning) {
        if (!backfillPaused) return res.status(409).json({ error: 'The backfill is already running.' });
        backfillPaused = false;
        await setBackfillState({ status: 'running' });
        return res.json({ resumed: true });
    }
    if (!sock || !isConnected) {
        return res.status(409).json({ error: 'WhatsApp is not connected.' });
    }

    const snapshot = await db.collection('Hawk_Jobs').doc(BACKFILL_CONTROL_ID).get();
    const stored = snapshot.data();
    if (!stored || (stored.status !== 'running' && stored.status !== 'paused')) {
        return res.status(409).json({ error: 'There is no interrupted backfill to resume.' });
    }

    res.status(202).json({ resumed: true, restarted: true });
    launchBackfill(sock, Number(stored.days) || 3)
        .catch(error => console.log(`System: Backfill resume failed: ${error.message}`));
});

app.get('/backfill', (req, res) => {
    res.send(`
        <!doctype html>
        <html lang="de">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <title>Hawk Backfill</title>
                <style>
                    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
                    body { margin: 0; background: #f5f7f7; color: #17201d; }
                    main { box-sizing: border-box; max-width: 560px; min-height: 100vh; margin: auto; padding: 28px 20px; }
                    a { color: inherit; }
                    .card { margin-top: 24px; padding: 24px; border: 1px solid #d7ddda; border-radius: 18px; background: white; box-shadow: 0 8px 30px rgba(0,0,0,.06); }
                    .row { display: flex; align-items: center; gap: 12px; margin: 18px 0; }
                    label { font-weight: 650; }
                    select, button { min-height: 44px; border: 1px solid #aeb8b3; border-radius: 10px; padding: 0 14px; font: inherit; }
                    select { margin-left: auto; background: white; color: inherit; }
                    button { cursor: pointer; background: #182b24; color: white; border-color: #182b24; }
                    button.secondary { background: white; color: #182b24; }
                    button:disabled { cursor: default; opacity: .45; }
                    progress { width: 100%; height: 12px; }
                    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 18px; }
                    .stat { padding: 12px; border-radius: 10px; background: #eef2f0; }
                    .stat strong { display: block; font-size: 1.35rem; }
                    #message { min-height: 24px; color: #a12a2a; }
                    @media (prefers-color-scheme: dark) {
                        body { background: #101513; color: #edf4f0; }
                        .card, select, button.secondary { background: #18201d; color: #edf4f0; }
                        .stat { background: #25302c; }
                    }
                </style>
            </head>
            <body>
                <main>
                    <a href="/">← Zurück zu Hawk</a>
                    <div class="card">
                        <h1>History Backfill</h1>
                        <p>Ältere WhatsApp-Nachrichten in Blöcken von maximal 50 abrufen.</p>
                        <div class="row">
                            <label for="days">Zeitraum</label>
                            <select id="days">
                                <option value="1">1 Tag</option>
                                <option value="2">2 Tage</option>
                                <option value="3" selected>3 Tage</option>
                                <option value="4">4 Tage</option>
                                <option value="5">5 Tage</option>
                                <option value="6">6 Tage</option>
                                <option value="7">7 Tage</option>
                            </select>
                        </div>
                        <div class="row">
                            <button id="start">Starten</button>
                            <button id="pause" class="secondary" disabled>Pausieren</button>
                        </div>
                        <p><strong>Status:</strong> <span id="status">Wird geladen…</span></p>
                        <progress id="progress" max="1" value="0"></progress>
                        <div class="stats">
                            <div class="stat"><strong id="chats">0/0</strong>Chats</div>
                            <div class="stat"><strong id="requested">0</strong>Anfragen</div>
                            <div class="stat"><strong id="received">0</strong>Empfangen</div>
                            <div class="stat"><strong id="failed">0</strong>Fehler</div>
                        </div>
                        <p id="message" role="alert"></p>
                    </div>
                </main>
                <script>
                    const elements = Object.fromEntries(['days','start','pause','status','progress','chats','requested','received','failed','message'].map(function(id) { return [id, document.getElementById(id)]; }));
                    const labels = { idle: 'Bereit', running: 'Läuft', paused: 'Pausiert', complete: 'Abgeschlossen', empty: 'Beendet · keine zusätzliche History erhalten', failed: 'Fehlgeschlagen', interrupted: 'Unterbrochen' };

                    async function api(path, options) {
                        const response = await fetch(path, options);
                        const data = await response.json();
                        if (!response.ok) throw new Error(data.error || 'Anfrage fehlgeschlagen');
                        return data;
                    }

                    function render(state) {
                        const active = state.status === 'running' || state.status === 'paused';
                        const resumable = state.status === 'interrupted';
                        elements.status.textContent = labels[state.status] || state.status;
                        if (!state.connected) elements.status.textContent += ' · WhatsApp getrennt';
                        elements.days.value = String(state.days || 3);
                        elements.days.disabled = active;
                        elements.start.disabled = active || resumable || !state.connected;
                        elements.pause.disabled = (!active && !resumable) || !state.connected;
                        elements.pause.textContent = state.status === 'paused' || resumable ? 'Fortsetzen' : 'Pausieren';
                        elements.progress.max = Math.max(1, Number(state.chats) || 0);
                        elements.progress.value = Number(state.currentChat) || 0;
                        elements.chats.textContent = (state.currentChat || 0) + '/' + (state.chats || 0);
                        elements.requested.textContent = state.requested || 0;
                        elements.received.textContent = state.received || 0;
                        elements.failed.textContent = state.failed || 0;
                        elements.message.textContent = state.error || '';
                    }

                    async function refresh() {
                        try { render(await api('/api/backfill/status')); }
                        catch (error) { elements.message.textContent = error.message; }
                    }

                    elements.start.addEventListener('click', async function() {
                        elements.message.textContent = '';
                        try {
                            await api('/api/backfill/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ days: Number(elements.days.value) }) });
                            await refresh();
                        } catch (error) { elements.message.textContent = error.message; }
                    });

                    elements.pause.addEventListener('click', async function() {
                        elements.message.textContent = '';
                        try {
                            const action = elements.pause.textContent === 'Fortsetzen' ? 'resume' : 'pause';
                            await api('/api/backfill/' + action, { method: 'POST' });
                            await refresh();
                        } catch (error) { elements.message.textContent = error.message; }
                    });

                    refresh();
                    setInterval(refresh, 1500);
                </script>
            </body>
        </html>
    `);
});

Object.entries(ASSET_PATHS).forEach(([route, filePath]) => {
    app.get(route, (req, res) => res.sendFile(filePath));
});

app.post('/pairing-code', async (req, res) => {
    const phoneNumber = String(req.body.phoneNumber || '').replace(/\D/g, '');
    if (!/^\d{8,15}$/.test(phoneNumber)) {
        return res.status(400).send('Enter the phone number with country code, using 8 to 15 digits. <a href="/">Back</a>');
    }
    if (!sock || isConnected) {
        return res.status(409).send('WhatsApp is not ready for pairing. <a href="/">Try again</a>');
    }

    try {
        const code = await sock.requestPairingCode(phoneNumber);
        const cleanCode = String(code).replace(/[^a-z0-9]/gi, '');
        if (!cleanCode) throw new Error('WhatsApp returned an empty pairing code');
        const displayCode = cleanCode.match(/.{1,4}/g).join('-');
        res.set('Cache-Control', 'no-store');
        return res.send(`
            <html>
                <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5;">
                    <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                        <h2>WhatsApp pairing code</h2>
                        <p style="font-size: 32px; font-weight: bold; letter-spacing: 4px;">${displayCode}</p>
                        <p>Enter this code in WhatsApp under Linked devices → Link a device → Link with phone number.</p>
                    </div>
                </body>
            </html>
        `);
    } catch (err) {
        console.log(`System: Pairing code request failed: ${err.message}`);
        return res.status(500).send('Could not create a pairing code. <a href="/">Try again</a>');
    }
});

// 6. Main Route
app.get('/', async (req, res) => {
    const logoutBtn = `<a href="/logout" style="position: absolute; top: 10px; right: 10px; padding: 8px 16px; background: #ff4444; color: white; text-decoration: none; border-radius: 4px; font-size: 14px;">Logout</a>`;

    if (isConnected) {
        return res.sendFile(APP_HTML_PATH);
    }

    if (qrCodeData) {
        try {
            const qrImage = await QRCode.toDataURL(qrCodeData);
            return res.send(`
                <html>
                    <head><meta http-equiv="refresh" content="10"></head>
                    <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background-color: #f0f2f5;">
                        ${logoutBtn}
                        <div style="background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
                            <h2>Scan to Link</h2>
                            <img src="${qrImage}" alt="QR Code" />
                            <p style="color: #666;">The QR code refreshes automatically.</p>
                            <hr style="margin: 28px 0; border: 0; border-top: 1px solid #ddd;" />
                            <h3>Or link with your phone number</h3>
                            <form action="/pairing-code" method="POST">
                                <input type="tel" name="phoneNumber" inputmode="tel" autocomplete="tel" placeholder="491701234567" required
                                    style="padding: 10px; width: 220px; box-sizing: border-box;" />
                                <button type="submit" style="padding: 10px 16px;">Create code</button>
                            </form>
                            <p style="color: #666; font-size: 12px;">Include the country code; spaces and + are allowed.</p>
                        </div>
                    </body>
                </html>
            `);
        } catch (e) {
            return res.send("Error generating QR.");
        }
    }

    return res.send(`
        <html>
            <head><meta http-equiv="refresh" content="2"></head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <p>Initializing connection or restoring auth state... please wait.</p>
                ${logoutBtn}
            </body>
        </html>
    `);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`System: Process started at ${new Date().toISOString()} (Node ${process.version}).`);
    startWhatsApp();
    console.log(`Server running on port ${PORT}`);
});

// --- KEEP-ALIVE (Render free tier) ---
// Render spins a free service down after 15 min without INBOUND traffic, which
// would drop the WhatsApp connection. We ping our own public URL every 5 minutes
// to reduce idle spin-downs. Free instances can still be restarted by Render.
// RENDER_EXTERNAL_URL is injected automatically by Render (absent locally, so this
// is a harmless no-op on your Mac).
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
    const PING_INTERVAL_MS = 5 * 60 * 1000; // 5 min — comfortably under the 15 min idle limit
    setInterval(async () => {
        try {
            await fetch(`${SELF_URL}/ping`);
            console.log("System: Keep-alive ping OK");
        } catch (err) {
            console.log("System: Keep-alive ping failed:", err.message);
        }
    }, PING_INTERVAL_MS);
    console.log(`System: Keep-alive self-ping active every 5 min -> ${SELF_URL}/ping`);
}
