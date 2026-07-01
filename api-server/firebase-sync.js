/**
 * firebase-sync.js — Firebase Admin SDK integration
 *
 * Pushes election state summaries to Firestore for real-time cross-device
 * dashboard sync. The actual blockchain data stays in election_data.enc —
 * Firebase only holds metadata (vote counts, candidate list, status flags).
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Path to service account key (download from Firebase Console → Project Settings → Service Accounts)
const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'serviceAccountKey.json');

let db = null;
let initialized = false;

function init() {
  if (initialized) return;

  // Check if service account key exists
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn('[Firebase] serviceAccountKey.json not found. Firebase sync disabled.');
    console.warn('[Firebase] Download it from: Firebase Console → Project Settings → Service Accounts → Generate new private key');
    return;
  }

  try {
    const serviceAccount = require(SERVICE_ACCOUNT_PATH);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: 'blockchain300809',
    });
    db = admin.firestore();
    initialized = true;
    console.log('[Firebase] Admin SDK initialized. Firestore sync enabled.');
  } catch (err) {
    console.warn('[Firebase] Init failed:', err.message);
  }
}

/**
 * Sync election summary to Firestore.
 * Called after any state-changing operation.
 */
async function syncElectionState(state) {
  if (!db) return;
  try {
    await db.collection('election').doc('state').set(
      {
        ...state,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error('[Firebase] Sync error:', err.message);
  }
}

/**
 * Update vote counts in real-time
 * @param {{ [candidateName: string]: number }} counts
 */
async function updateVoteCounts(counts) {
  if (!db) return;
  try {
    await db.collection('election').doc('votes').set(
      {
        counts,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (err) {
    console.error('[Firebase] Vote count sync error:', err.message);
  }
}

/**
 * Log an audit event to Firestore
 */
async function logAuditEvent(event) {
  if (!db) return;
  try {
    await db.collection('audit_log').add({
      ...event,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Firebase] Audit log error:', err.message);
  }
}

/**
 * Update blockchain integrity status
 */
async function updateChainStatus(intact, blockCount) {
  if (!db) return;
  try {
    await db.collection('election').doc('chain').set({
      intact,
      blockCount,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Firebase] Chain status sync error:', err.message);
  }
}

/**
 * Push candidate list
 */
async function updateCandidates(candidates) {
  if (!db) return;
  try {
    await db.collection('election').doc('candidates').set({
      list: candidates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    console.error('[Firebase] Candidates sync error:', err.message);
  }
}

/**
 * Publish the current public server URL (tunnel URL) to KV Store + Firestore.
 * KV Store is tried FIRST (always works, no auth needed).
 * The frontend reads this at startup to auto-discover the backend.
 * @param {string} url — e.g. "https://abc123.lhr.life"
 */
async function publishServerUrl(url) {
  let published = false;

  // ── 1. Primary: Public KV Store (always works, no service account needed) ──
  try {
    const https = require('https');
    const appKey = 'b1v0t309';
    const b64 = Buffer.from(url).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const kvPath = `/api/KeyVal/UpdateValue/${appKey}/server_url/${b64}`;
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'keyvalue.immanuel.co',
        port: 443,
        path: kvPath,
        method: 'POST',
        headers: { 'Content-Length': '0' },
        timeout: 8000,
      }, (res) => {
        let data = '';
        res.on('data', d => { data += d; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            console.log(`[Discovery] ✅ Published server URL via KV Store: ${url}`);
            published = true;
            resolve();
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('KV Store timeout')));
      req.end();
    });
  } catch (err) {
    console.warn('[Discovery] KV Store publish failed:', err.message);
  }

  // ── 2. Admin SDK (if serviceAccountKey.json exists) ─────────────────────
  if (db) {
    try {
      await db.collection('election').doc('server_config').set({
        serverUrl: url,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log(`[Firebase] ✅ Published server URL via Admin SDK: ${url}`);
      published = true;
    } catch (err) {
      console.warn('[Firebase] Admin SDK publish failed:', err.message);
    }
  }

  // ── 3. Firestore REST API (fallback if Admin SDK not available) ──────────
  if (!db) {
    try {
      const https = require('https');
      const FB_API_KEY = 'AIzaSyDH1xLRDcW-A4qa7RYISJ024JpcWkShriQ';
      const FB_PROJECT = 'blockchain300809';
      const body = JSON.stringify({
        fields: {
          serverUrl: { stringValue: url },
          updatedAt: { stringValue: new Date().toISOString() },
        }
      });
      await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'firestore.googleapis.com',
          port: 443,
          path: `/v1/projects/${FB_PROJECT}/databases/(default)/documents/election/server_config?key=${FB_API_KEY}`,
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 8000,
        }, (res) => {
          let data = '';
          res.on('data', d => { data += d; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log(`[Firebase] ✅ Published server URL via REST: ${url}`);
              resolve();
            } else {
              reject(new Error(`HTTP ${res.statusCode}`));
            }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Firestore timeout')));
        req.write(body);
        req.end();
      });
    } catch (err) {
      // Firestore may be disabled — silently skip, KV store is enough
      if (!published) {
        console.warn('[Firebase] Firestore REST failed (API may be disabled):', err.message);
      }
    }
  }

  if (!published) {
    console.error('[Discovery] ❌ Failed to publish server URL via any method');
  }
}

module.exports = {
  init,
  syncElectionState,
  updateVoteCounts,
  logAuditEvent,
  updateChainStatus,
  updateCandidates,
  publishServerUrl,
};
