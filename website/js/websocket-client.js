/**
 * websocket-client.js — Shared WebSocket Client Library
 *
 * Handles:
 * - Auto-reconnect with exponential backoff
 * - Event routing to registered handlers
 * - Toast notification system
 * - Real-time state sync
 */

(function (window) {
  'use strict';

  // ──────────────────────────────────────────────────────────────
  // Configuration (resolved asynchronously via config.js)
  // ──────────────────────────────────────────────────────────────

  let _serverBase = null;
  let API_URL = null;
  let WS_URL  = null;

  // Will be set when resolution completes
  let _resolveReady;
  const _readyPromise = new Promise(r => { _resolveReady = r; });

  // Kick off URL resolution immediately
  (async () => {
    try {
      if (window.BLOCKVOTE_SERVER_URL) {
        _serverBase = window.BLOCKVOTE_SERVER_URL;
      } else if (typeof window.resolveServerUrl === 'function') {
        _serverBase = await window.resolveServerUrl();
      } else {
        // Fallback if config.js didn't load
        const h = window.location.hostname;
        _serverBase = (h === 'localhost' || h === '127.0.0.1')
          ? 'http://localhost:3000'
          : `${window.location.protocol}//${h}`; // Use same origin (cloud)
      }
    } catch (e) {
      _serverBase = 'http://localhost:3000';
    }
    _serverBase = _serverBase.replace(/\/+$/, '');
    API_URL = _serverBase;
    WS_URL  = _serverBase.replace(/^http/, 'ws');
    _resolveReady();
  })();

  // ──────────────────────────────────────────────────────────────
  // WebSocket Manager
  // ──────────────────────────────────────────────────────────────

  class VotingWS {
    constructor() {
      this.ws = null;
      this.reconnectDelay = 1000;
      this.maxDelay = 30000;
      this.handlers = {};
      this.role = 'unknown';
      this.connected = false;
      this._pingInterval = null;
    }

    connect(role = 'unknown') {
      this.role = role;
      // Wait for URL resolution before connecting
      _readyPromise.then(() => this._connect());
    }

    _connect() {
      try {
        this.ws = new WebSocket(WS_URL);

        this.ws.onopen = () => {
          this.connected = true;
          this.reconnectDelay = 1000;
          console.log('[WS] Connected to voting server');

          // Identify role
          this.ws.send(JSON.stringify({ action: 'identify', role: this.role }));

          // Show connection banner
          showConnectionBanner(true);

          // Start ping
          this._pingInterval = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ action: 'ping' }));
            }
          }, 30000);

          this._trigger('connected', {});
        };

        this.ws.onmessage = (evt) => {
          try {
            const msg = JSON.parse(evt.data);
            this._trigger(msg.event, msg.data);
            this._trigger('*', msg); // wildcard handler
          } catch (e) {
            console.error('[WS] Parse error:', e);
          }
        };

        this.ws.onclose = () => {
          this.connected = false;
          clearInterval(this._pingInterval);
          console.warn('[WS] Disconnected. Reconnecting in', this.reconnectDelay, 'ms');
          showConnectionBanner(false);
          this._trigger('disconnected', {});
          setTimeout(() => {
            this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxDelay);
            this._connect();
          }, this.reconnectDelay);
        };

        this.ws.onerror = (err) => {
          console.error('[WS] Error:', err);
        };
      } catch (e) {
        console.error('[WS] Failed to create WebSocket:', e);
      }
    }

    on(event, handler) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(handler);
      return this;
    }

    off(event, handler) {
      if (!this.handlers[event]) return;
      this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    }

    _trigger(event, data) {
      (this.handlers[event] || []).forEach((h) => {
        try { h(data); } catch (e) { console.error('[WS] Handler error:', e); }
      });
    }
  }

  // ──────────────────────────────────────────────────────────────
  // API Helper
  // ──────────────────────────────────────────────────────────────

  async function apiPost(path, body = {}) {
    await _readyPromise;
    const resp = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return resp.json();
  }

  async function apiGet(path) {
    await _readyPromise;
    const resp = await fetch(`${API_URL}${path}`);
    return resp.json();
  }

  // ──────────────────────────────────────────────────────────────
  // Toast Notifications
  // ──────────────────────────────────────────────────────────────

  let toastContainer = null;

  function ensureToastContainer() {
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.className = 'toast-container';
      toastContainer.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastContainer);
    }
    return toastContainer;
  }

  function toast(message, type = 'info', duration = 4000) {
    const container = ensureToastContainer();
    const icons = { success: '✅', error: '🔴', warn: '⚠️', info: 'ℹ️' };

    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <span class="toast-icon">${icons[type] || icons.info}</span>
      <span class="toast-message">${message}</span>
    `;
    container.appendChild(el);

    setTimeout(() => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  // ──────────────────────────────────────────────────────────────
  // Connection Banner
  // ──────────────────────────────────────────────────────────────

  let bannerEl = null;

  function showConnectionBanner(isConnected) {
    if (!bannerEl) {
      bannerEl = document.createElement('div');
      bannerEl.className = 'connection-banner';
      document.body.prepend(bannerEl);
    }
    bannerEl.className = `connection-banner ${isConnected ? 'connected' : 'disconnected'}`;
    bannerEl.textContent = isConnected
      ? '🔗 Connected to Voting Server'
      : '🔴 Disconnected — Reconnecting...';

    // Update status dot if present
    const dot = document.querySelector('.status-dot');
    if (dot) {
      dot.className = `status-dot ${isConnected ? 'online' : 'offline'}`;
      const label = dot.parentElement?.querySelector('.status-text');
      if (label) label.textContent = isConnected ? 'Live' : 'Offline';
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Button Loading State
  // ──────────────────────────────────────────────────────────────

  function setButtonLoading(btn, loading) {
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
      btn._originalText = btn.innerHTML;
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
      if (btn._originalText) btn.innerHTML = btn._originalText;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Alert Helper
  // ──────────────────────────────────────────────────────────────

  function showAlert(container, message, type = 'info') {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const icons = { success: '✅', error: '❌', warn: '⚠️', info: 'ℹ️' };
    container.innerHTML = `
      <div class="alert alert-${type} fade-in">
        <span class="alert-icon">${icons[type]}</span>
        <div>${message}</div>
      </div>
    `;
    container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function clearAlert(container) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (container) container.innerHTML = '';
  }

  // ──────────────────────────────────────────────────────────────
  // OTP Digits Display
  // ──────────────────────────────────────────────────────────────

  function displayOtp(container, otp) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const digits = String(otp).padStart(6, '0').split('');
    container.innerHTML = digits
      .map((d, i) => `<div class="otp-digit" style="animation-delay:${i * 60}ms">${d}</div>`)
      .join('');
  }

  // ──────────────────────────────────────────────────────────────
  // Vote Bar Chart
  // ──────────────────────────────────────────────────────────────

  function renderVoteBars(container, results) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const total = Object.values(results).reduce((a, b) => a + b, 0) || 1;
    const maxVotes = Math.max(...Object.values(results), 1);
    const sorted = Object.entries(results).sort((a, b) => b[1] - a[1]);

    container.innerHTML = sorted
      .map(([name, votes], i) => {
        const pct = Math.round((votes / total) * 100);
        const isLeader = votes === maxVotes && votes > 0;
        return `
          <div class="vote-bar-wrap fade-in" style="animation-delay:${i * 80}ms">
            <div class="vote-bar-label">
              <span class="vote-bar-name">${name} ${isLeader ? '👑' : ''}</span>
              <span class="vote-bar-count">${votes} vote${votes !== 1 ? 's' : ''} (${pct}%)</span>
            </div>
            <div class="vote-bar-track">
              <div class="vote-bar-fill ${isLeader ? 'leader' : ''}" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // ──────────────────────────────────────────────────────────────
  // Candidate Cards
  // ──────────────────────────────────────────────────────────────

  function renderCandidateCards(container, candidates, onSelect) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const emojis = ['🗳️', '⭐', '🔵', '🟢', '🔴', '🏛️', '🌟', '💡', '🎯', '🚀'];
    container.innerHTML = candidates
      .map((name, i) => `
        <div class="candidate-card fade-in" data-index="${i + 1}" data-name="${name}"
             style="animation-delay:${i * 60}ms" role="radio" aria-label="${name}"
             tabindex="0">
          <div class="candidate-avatar">${emojis[i % emojis.length]}</div>
          <div class="candidate-name">${name}</div>
          <div class="candidate-index">Candidate ${i + 1}</div>
        </div>
      `)
      .join('');

    container.querySelectorAll('.candidate-card').forEach((card) => {
      const selectCard = () => {
        container.querySelectorAll('.candidate-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        if (onSelect) onSelect(card.dataset.index, card.dataset.name);
      };
      card.addEventListener('click', selectCard);
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCard(); } });
    });
  }

  // ──────────────────────────────────────────────────────────────
  // Countdown Timer (for OTP expiry)
  // ──────────────────────────────────────────────────────────────

  function startCountdown(container, seconds, onExpire) {
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    let remaining = seconds;
    const update = () => {
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      container.textContent = `${m}:${s.toString().padStart(2, '0')}`;
      container.style.color = remaining <= 30 ? 'var(--c-danger)' : 'var(--c-success)';
      if (remaining <= 0) {
        clearInterval(timer);
        if (onExpire) onExpire();
      }
      remaining--;
    };
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }

  // ──────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────

  window.VotingSystem = {
    ws: new VotingWS(),
    api: { post: apiPost, get: apiGet },
    ui: {
      toast,
      showAlert,
      clearAlert,
      setButtonLoading,
      displayOtp,
      renderVoteBars,
      renderCandidateCards,
      startCountdown,
      showConnectionBanner,
    },
    SERVER_URL: API_URL,
    WS_URL,
  };
})(window);
