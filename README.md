# WhatsApp Logger (Self-Hosted)

A privacy-focused, self-hosted WhatsApp archiving tool. It captures messages (including deleted ones) via a linked device connection and stores them in your own Firebase Firestore database.

> [!IMPORTANT]
> **Low risk, not zero risk.** The logger uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial, reverse-engineered WhatsApp Web client, which is against WhatsApp's Terms of Service. It only listens and never sends messages, which keeps the ban risk low, but WhatsApp can still restrict or ban a number. Don't use a number you cannot afford to lose.
>
> **Privacy:** it also stores the messages your contacts send you. Keep the archive private; sharing it without their consent may violate privacy laws (e.g. GDPR).

> [!WARNING]
> **Follow this README, not the original upstream guide.** The upstream guide (<a href="https://amit.is-a.dev/logger">amit.is-a.dev/logger</a>) tells you to set Firestore rules that make your whole archive, including your WhatsApp session keys, readable by anyone who knows your project ID. This fork closes the database and requires a login (see Step 1.3).
<a href="https://www.producthunt.com/products/whatsapp-logger-self-hosted?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-whatsapp-logger-self-hosted" target="_blank" rel="noopener noreferrer"><img alt="WhatsApp Logger (Self-Hosted) - Privacy-focused WhatsApp archiving with Anti-Delete. | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1122776&amp;theme=light&amp;t=1776172043162"></a>

### Important notes:
 * It is recommended to download the **web app (PWA)** after the publication of the webpage for better security and native experience. 
 * It is recommended to use **PIN** or **Biometric authentication** inside the web app. Find the authentication options in Settings.

## Features

* **Anti-Delete**: Logs messages instantly, preserving them even if the sender deletes them.
* **Privacy First**: You host the backend and database. No third-party servers access your data.
* **Secure Access**: The database is closed to the public. The viewer logs in against your backend, receives a Firebase token, and the Firestore rules (`firestore.rules`) only let that token read your own chats.
* **Media Support**: Captures text messages and voice notes (stored as `.ogg` in Firebase Storage). Other media is not downloaded.
* **Logout Alert**: Optional Telegram message the moment WhatsApp logs the linked device out, so the archive never stops silently.
* **Search & Filter**: Search by content or filter by date.
* **Export**: Export chat logs to `.txt` files.
* **Offline Ready**: Uses IndexedDB caching so you can read your logs even without an internet connection.

---

## Prerequisites

1.  A **GitHub** Account.
2.  A **Render** Account. The free tier works (750 free instance hours per workspace per month, enough for exactly one always-on service); the paid Starter plan (~$7/month) is more stable.
3.  A **Firebase** project on the pay-as-you-go **Blaze** plan. Cloud Storage (for voice notes) requires it; a private archive normally stays within the free quota. Set a budget alert.
4.  A **WhatsApp** account on your phone.
5.  Optional: a **Telegram** account for the logout alert.

---

## Step 1: Firebase Setup (The Database)

1.  Go to the [Firebase Console](https://console.firebase.google.com/) and create a new project, then switch it to the **Blaze** plan and set a budget alert.
2.  **Create Database**:
    * Navigate to **Firestore Database** in the sidebar.
    * Click **Create Database** (Standard edition).
    * Select a location (e.g., `europe-west3` to keep the data in the EU, or `nam5`).
    * Start in **Production Mode**.
3.  **Set Security Rules (before you link WhatsApp!)**:
    * Go to the **Rules** tab in Firestore.
    * Replace the rules with the complete content of [`firestore.rules`](firestore.rules) from this repository and click **Publish**.
    * These rules deny everything to the public. Only a viewer that logged in through your backend gets a token that can read your chats and rename a chat. Messages and the WhatsApp session (`whatsapp_auth`) can never be read or changed from the browser. The backend uses the Admin SDK and is not affected.
    * ⚠️ Never use `allow read: if true` (as older versions of this guide did): your project ID is public in `index.html`, so anyone could read your archive and your WhatsApp session keys.
4.  **Enable Authentication**:
    * Navigate to **Authentication** and click **Get started**.
    * You don't need to enable any sign-in provider (the viewer signs in with a custom token from your backend), and you don't need the Identity Platform upgrade.
    * Without this step the viewer login fails with `CONFIGURATION_NOT_FOUND`.
5.  **Enable Storage** (for voice notes):
    * Navigate to **Storage** and click **Get started**, in **Production Mode**.
    * Buckets in `US-CENTRAL1`, `US-EAST1` or `US-WEST1` include Google Cloud's "Always Free" storage; other locations cost a few cents per month at this volume.
    * Keep the Storage rules fully closed (`allow read, write: if false;`). The backend doesn't need them.
6.  **Get Backend Credentials (Service Account)**:
    * Go to **Project Settings** (Gear icon) -> **Service accounts**.
    * Click **Generate new private key**.
    * This will download a `.json` file. **Keep this safe and never commit it** (the repository is public). You will need its content for Render.
7.  **Get Frontend Configuration**:
    * Go to **Project Settings** -> **General**.
    * Scroll down to "Your apps" and click the **Web (</>)** icon.
    * Register app (nickname: "Logger Frontend").
    * Copy the `firebaseConfig` object (API Key, Project ID, etc.). You will need this for `index.html` (Step 2).

---

## Step 2: Deploy Backend (The Listener)

1.  **Fork this Repository** to your own GitHub account.
2.  In your fork, open `index.html` and find the configuration block (search for `firebaseConfig`, around line 920):
    * Replace the whole `firebaseConfig` object with yours from Step 1.7. The values in this repository belong to someone else's project.
    * Set `STATIC_VIEWER_BACKEND_URL` to your Render URL once you have it (only used by a local viewer on port 8088, see Step 4).
    * Leave `DATA_COLLECTION` as `"Chats"`.
    * Commit the change to your fork.
3.  Log in to [Render](https://render.com/).
4.  Click **New +** -> **Web Service**.
5.  Connect your forked repository.
6.  **Runtime**: Select **Docker**.
7.  **Environment Variables** (Critical Step):
    Add the following variables under "Advanced":
    * `FIREBASE_SERVICE_ACCOUNT`: Paste the **entire content** of the JSON file you downloaded in Step 1.
    * `AUTH_USER`: Set a username (e.g., `admin`).
    * `AUTH_PASS`: Set a strong password **using only letters and digits**. Characters like `$`, quotes or spaces get mangled by Render's environment handling, and the login then fails even though the dashboard shows the right value.
    * Optional, for the logout alert: `TELEGRAM_BOT_TOKEN` (create a bot with `@BotFather`) and `TELEGRAM_CHAT_ID` (send your bot `/start`, then read the ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`).
    * Don't set `PORT` (Render injects it) or `ACCOUNT_ID` (only for several phones in one Firebase project).
8.  Click **Create Web Service**.
9.  Wait for the deployment to finish. Render will give you a URL like `https://your-app.onrender.com`.

Run only **one** backend per WhatsApp session. Starting a second one against the same Firebase project (for example `node index.js` locally while Render is running) makes the two kick each other out (`connectionReplaced`).

---

## Step 3: Connect WhatsApp

1.  Open your Render URL (`https://your-app.onrender.com`) in a browser.
2.  You will be prompted for a login. Use the `AUTH_USER` and `AUTH_PASS` you set in Render.
3.  You will see a **QR Code**.
4.  Open **WhatsApp** on your phone:
    * iOS: Settings -> Linked Devices
    * Android: Three dots -> Linked Devices
5.  Tap **Link a Device** and scan the QR code. Alternatively, enter your phone number on the Render page and use the displayed code under **Link with phone number**.
6.  The page refreshes on its own and then shows the viewer. The Render logs show `Connection Open and Authenticated`. Your backend is now listening!

Automatic history sync is disabled: connecting or restarting Hawk only logs new live messages, never requests older history from the primary phone, and ignores unsolicited history batches outside a manually started backfill. To explicitly request one to seven days of older messages, open the authenticated `/backfill` page or use **Settings → History Backfill**. Hawk selects chats from their stored message timestamps, continues backwards from the oldest stored message inside that window, and shows live progress plus pause/resume controls between WhatsApp's 50-message batches. Availability still depends on what the primary phone provides; an empty result is reported separately from a successful import.

---

## Step 4: The Viewer

The backend serves the viewer itself: once WhatsApp is linked, your Render URL shows it. There is nothing else to host. The viewer needs the backend's `/api/verify` endpoint on the same origin to log in, so hosting `index.html` somewhere else (GitHub Pages, Netlify, Firebase Hosting) does not work.

Optional, a local copy on your computer: serve `index.html`, `manifest.json`, `sw.js` and `icon.svg` from one folder with `python3 -m http.server 8088` and open `http://localhost:8088`. On port 8088 the viewer logs in through `STATIC_VIEWER_BACKEND_URL` (Step 2.2).

---

## Step 5: Usage

1.  Open your Render URL.
2.  You will see a Login Screen.
3.  Enter the same `AUTH_USER` and `AUTH_PASS` you configured on Render. The viewer then signs in to Firebase with the token your backend returns.
4.  Once unlocked, your chats will load from Firebase.
    * **Sidebar**: Shows chat list sorted by newest activity.
    * **Search**: Filter contacts by name or phone number.
    * **Export**: Download chat history as a `.txt` file.

---

## Step 6: Check That Your Data Is Private

Open these two URLs in a browser where you are **not** logged in (replace `<PROJECT_ID>` with yours):

* `https://firestore.googleapis.com/v1/projects/<PROJECT_ID>/databases/(default)/documents/whatsapp_auth?pageSize=1`
* `https://firestore.googleapis.com/v1/projects/<PROJECT_ID>/databases/(default)/documents/Chats?pageSize=1`

Both must answer with `403` / `PERMISSION_DENIED`. If either shows data, your rules are wrong: fix them (Step 1.3) before anything else.

---

## Step 7: Keep it Alive

Render's free tier spins down after 15 minutes without inbound traffic. On Render the backend pings its own public URL every 5 minutes (via `RENDER_EXTERNAL_URL`, which Render sets automatically), so no extra setup is needed.

An external monitor is optional belt-and-braces:

1.  Create a free account on [UptimeRobot](https://uptimerobot.com/).
2.  Click **Add New Monitor**.
3.  **Monitor Type**: HTTP(s).
4.  **Friendly Name**: WhatsApp Logger.
5.  **URL (or IP)**: `https://your-app.onrender.com/ping` (Make sure to add `/ping` at the end).
6.  **Monitoring Interval**: 5 minutes.
7.  Click **Create Monitor**.

Render can still restart free instances. Truly uninterrupted operation requires an always-on paid instance; the automatic reconnect minimizes the interruption after a restart.

---

## Troubleshooting

* **"No chats found"**: Send a message to the linked WhatsApp account to trigger the first log.
* **"Incorrect Credentials"**: Ensure your Render backend is running and you are using the exact Username/Password defined in Render Environment Variables (letters and digits only).
* **Login works but no chats appear / `permission-denied` in the browser console**: Check that `firebaseConfig` in `index.html` is your own project and that Firebase Authentication was started (Step 1.4). `CONFIGURATION_NOT_FOUND` means Authentication was never started.
* **Logged out by WhatsApp**: Linked devices get logged out from time to time. Open your Render URL and scan the new QR code. With `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set you get a message when this happens.
* **Connection interruptions**: The backend reconnects automatically with increasing delays (up to 60 seconds). Check Render for `System: WhatsApp connection closed` to see the status code, reason, error message, and process uptime. A `loggedOut` reason clears the complete stored WhatsApp session before generating a new QR code. A Render worker replaced during deployment does not reconnect and compete with the newer worker.
* **Proof/Phone Numbers**: If a chat shows a long ID (e.g., `1155...@lid`), wait a few minutes. The backend automatically syncs contacts and updates the record with the real phone number.

## Disclaimer

This tool is for personal archiving purposes. Using it to log conversations without consent may violate privacy laws in your jurisdiction. The author is not responsible for misuse.
