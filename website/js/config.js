/**
 * config.js — BlockVote Server Configuration (v5.0 — KV-First)
 *
 * ════════════════════════════════════════════════════════════
 *  HOW IT WORKS
 * ════════════════════════════════════════════════════════════
 *
 *  When the Node.js server starts, it publishes the public tunnel
 *  URL to a free key-value store (keyvalue.immanuel.co).
 *  This script reads that URL so every device auto-connects —
 *  no manual config changes needed.
 *
 *  Resolution order:
 *    1. window.BLOCKVOTE_SERVER_URL  (hardcoded override)
 *    2. KV Store auto-discovery      (primary — fast & reliable)
 *    3. Firestore auto-discovery     (secondary — if KV store fails)
 *    4. Same-origin fallback         (for local dev)
 *    5. localhost:3000               (last resort)
 *
 * ════════════════════════════════════════════════════════════
 */

// ── Hardcoded override (set a URL here to skip auto-discovery) ─
window.BLOCKVOTE_SERVER_URL = null;

// ── Firebase project (for Firestore fallback) ─────────────────
const _FB_API_KEY    = "AIzaSyDH1xLRDcW-A4qa7RYISJ024JpcWkShriQ";
const _FB_PROJECT_ID = "blockchain300809";

// ── KV Store key ──────────────────────────────────────────────
const _KV_APP_KEY = 'b1v0t309';

/**
 * resolveServerUrl()
 * Returns a Promise<string> — the base URL of the backend server.
 * Called by websocket-client.js before connecting.
 */
window.resolveServerUrl = async function () {
  // 1. Hardcoded override wins
  if (window.BLOCKVOTE_SERVER_URL) {
    return window.BLOCKVOTE_SERVER_URL.replace(/\/+$/, '');
  }

  // 2. Primary: Public KV Store (fast, no auth needed, always works)
  try {
    const resp = await fetch(
      `https://keyvalue.immanuel.co/api/KeyVal/GetValue/${_KV_APP_KEY}/server_url`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (resp.ok) {
      const text = await resp.text();
      if (text) {
        let cleanText = text.trim();
        if (cleanText.startsWith('"') && cleanText.endsWith('"')) {
          cleanText = cleanText.substring(1, cleanText.length - 1);
        }
        // Base64url decode
        let base64 = cleanText.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        try {
          const decodedUrl = atob(base64);
          if (decodedUrl && decodedUrl.startsWith('http')) {
            console.log('[Config] ✅ Auto-discovered server URL from KV Store:', decodedUrl);
            return decodedUrl;
          }
        } catch (_) {
          // If decode fails, try using raw text as URL
          if (cleanText.startsWith('http')) {
            console.log('[Config] ✅ Auto-discovered server URL (raw):', cleanText);
            return cleanText;
          }
        }
      }
    }
  } catch (e) {
    console.warn('[Config] KV Store discovery failed:', e.message);
  }

  // 3. Fallback: Firestore REST API
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${_FB_PROJECT_ID}/databases/(default)/documents/election/server_config?key=${_FB_API_KEY}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const json = await resp.json();
      const serverUrl = json?.fields?.serverUrl?.stringValue;
      if (serverUrl && serverUrl.startsWith('http')) {
        console.log('[Config] 🌐 Auto-discovered server URL from Firestore:', serverUrl);
        return serverUrl;
      }
    }
  } catch (e) {
    console.warn('[Config] Firestore discovery failed:', e.message);
  }

  // 4. Same-origin (works when served directly from Node.js server)
  const h = window.location.hostname;
  if (h !== 'blockchain300809.web.app' &&
      h !== 'blockchain300809.firebaseapp.com') {
    const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    const origin = window.location.origin;
    // If not on firebase hosting, assume same server
    if (h !== 'localhost' && h !== '127.0.0.1') {
      console.log('[Config] 🌐 Using same-origin server:', origin);
      return origin;
    }
  }

  // 5. Localhost fallback
  console.error('[Config] ❌ Could not discover server URL. Is the server running?');
  return 'http://localhost:3000';
};
