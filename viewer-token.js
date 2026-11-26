// Firebase custom token for the viewer (index.html).
//
// The viewer reads Firestore straight from the browser. firestore.rules only lets it do
// that with a token whose `hawkChats` claim names the chats collection it may read, so
// the backend issues this token from /api/verify after the password check succeeded.

function viewerTokenIdentity(chatsCollection) {
    if (typeof chatsCollection !== 'string' || !/^([A-Za-z0-9_-]+_)?Chats$/.test(chatsCollection)) {
        throw new Error(`Refusing to issue a viewer token for "${chatsCollection}"`);
    }
    return {
        uid: `hawk-viewer-${chatsCollection}`,
        claims: { hawkChats: chatsCollection }
    };
}

async function createViewerToken(auth, chatsCollection) {
    const { uid, claims } = viewerTokenIdentity(chatsCollection);
    return auth.createCustomToken(uid, claims);
}

module.exports = { viewerTokenIdentity, createViewerToken };
