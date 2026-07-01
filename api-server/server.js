/**
 * server.js — Main Express + WebSocket Server (v3.0 — P2P Edition)
 *
 * Blockchain Voting System v3.0
 * - REST API routes for all 4 terminal roles
 * - WebSocket server for real-time broadcast to all connected browsers
 * - Bridges to C++ executables via bridge.js (unchanged C++ logic)
 * - Firebase sync via firebase-sync.js
 *
 * New in v3.0:
 *   POST /api/admin/toggle-voting-day    — Toggle election open/closed
 *   GET  /api/admin/audit-ledger         — Full blockchain audit log
 *   POST /api/voter/verify-vote          — Voter verifies own vote on chain
 *   GET  /api/voter/candidates           — Candidate list via admin results
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const cors    = require('cors');
const helmet  = require('helmet');
const path    = require('path');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');

const bridge   = require('./bridge');
const firebase = require('./firebase-sync');

// ──────────────────────────────────────────────────────────────
// Server Setup
// ──────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3000;

const wss = new WebSocket.Server({ server });

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const WEBSITE_DIR = path.join(__dirname, '..', 'website');
app.use(express.static(WEBSITE_DIR));

// ──────────────────────────────────────────────────────────────
// WebSocket Utilities
// ──────────────────────────────────────────────────────────────

const clients = new Map(); // ws → { id, role, ip }

function broadcast(event, data, excludeWs = null) {
  const msg = JSON.stringify({ event, data, ts: Date.now() });
  wss.clients.forEach((ws) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

wss.on('connection', (ws, req) => {
  const id = uuidv4();
  const ip = req.socket.remoteAddress;
  clients.set(ws, { id, role: 'unknown', ip });
  console.log(`[WS] Client connected: ${id} from ${ip}`);

  // Send current state snapshot
  ws.send(JSON.stringify({ event: 'state_sync', data: electionState, ts: Date.now() }));

  ws.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (parsed.action === 'identify') {
        const info = clients.get(ws);
        if (info) info.role = parsed.role || 'unknown';
      }
    } catch (_) {}
  });

  ws.on('close',  () => { clients.delete(ws); });
  ws.on('error',  (err) => console.error(`[WS] Error ${id}:`, err.message));
});

// ──────────────────────────────────────────────────────────────
// In-Memory Election State Cache
// ──────────────────────────────────────────────────────────────

const electionState = {
  candidates:      [],
  votes:           {},
  chainIntact:     null,
  blockCount:      0,
  voterFileLoaded: false,
  registeredCount: 0,
  votesCast:       0,
  votingDayOn:     false,
  adminLoggedIn:   false,
  agentLoggedIn:   false,
};

// ──────────────────────────────────────────────────────────────
// Admin Routes — Election Commission
// ──────────────────────────────────────────────────────────────

app.post('/api/admin/login', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ ok: false, errors: ['Missing credentials'] });
  try {
    const r = await bridge.adminLogin(id, password);
    if (r.ok) {
      electionState.adminLoggedIn = true;
      broadcast('admin_online', { online: true });
      firebase.logAuditEvent({ type: 'admin_login', success: true });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/admin/load-voter-file', async (req, res) => {
  const { filePath } = req.body;
  if (!filePath) return res.status(400).json({ ok: false, errors: ['Missing filePath'] });
  try {
    const r = await bridge.adminLoadVoterFile(filePath);
    if (r.ok) {
      electionState.voterFileLoaded = true;
      broadcast('voter_file_loaded', { path: filePath, messages: r.messages });
      firebase.syncElectionState({ voterFileLoaded: true, voterFilePath: filePath });
      firebase.logAuditEvent({ type: 'voter_file_loaded', filePath });
      bridge.killAll(); // Restart sessions to load fresh database state
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/admin/save-voter-data', async (req, res) => {
  const { voterData, filePath } = req.body;
  if (!voterData) return res.status(400).json({ ok: false, errors: ['Missing voter data'] });
  const targetPath = filePath || 'data.txt';
  try {
    // Write pasted data to file
    const absolutePath = path.resolve(path.join(__dirname, '..', targetPath));
    fs.writeFileSync(absolutePath, voterData.trim() + '\n', 'utf8');

    // Load file into blockchain C++ process
    const r = await bridge.adminLoadVoterFile(targetPath);
    if (r.ok) {
      electionState.voterFileLoaded = true;
      broadcast('voter_file_loaded', { path: targetPath, messages: r.messages });
      firebase.syncElectionState({ voterFileLoaded: true, voterFilePath: targetPath });
      firebase.logAuditEvent({ type: 'voter_file_loaded', filePath: targetPath });
      bridge.killAll(); // Restart sessions to load fresh database state
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/admin/add-candidate', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ ok: false, errors: ['Missing candidate name'] });
  try {
    const r = await bridge.adminAddCandidate(name);
    if (r.ok) {
      if (!electionState.candidates.includes(name)) {
        electionState.candidates.push(name);
        electionState.votes[name] = 0;
      }
      broadcast('candidate_added', { name, candidates: electionState.candidates });
      firebase.updateCandidates(electionState.candidates);
      firebase.logAuditEvent({ type: 'candidate_added', name });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.get('/api/admin/results', async (req, res) => {
  try {
    const r = await bridge.adminGetResults();
    if (r.ok) {
      electionState.votes     = r.results;
      electionState.votesCast = Object.values(r.results).reduce((a, b) => a + b, 0);
      Object.keys(r.results).forEach((name) => {
        if (!electionState.candidates.includes(name)) electionState.candidates.push(name);
      });
      broadcast('results_updated', { results: r.results, leader: r.leader, leaderVotes: r.leaderVotes });
      firebase.updateVoteCounts(r.results);
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.get('/api/admin/verify-chain', async (req, res) => {
  try {
    const r = await bridge.adminVerifyChain();
    electionState.chainIntact = r.intact;
    broadcast('chain_verified', { intact: r.intact, lines: r.lines });
    firebase.updateChainStatus(r.intact, electionState.blockCount);
    firebase.logAuditEvent({ type: 'chain_verification', intact: r.intact });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/admin/reset-votes', async (req, res) => {
  try {
    const r = await bridge.adminResetVotes();
    if (r.ok) {
      electionState.votes     = {};
      electionState.votesCast = 0;
      broadcast('votes_reset', {});
      firebase.logAuditEvent({ type: 'votes_reset' });
      bridge.killAll(); // Restart sessions to load fresh database state
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/admin/factory-reset', async (req, res) => {
  try {
    const r = await bridge.adminFactoryReset();
    if (r.ok) {
      Object.assign(electionState, {
        candidates: [], votes: {}, votesCast: 0,
        voterFileLoaded: false, chainIntact: null,
        votingDayOn: false, registeredCount: 0,
      });
      broadcast('factory_reset', {});
      firebase.logAuditEvent({ type: 'factory_reset' });
      bridge.killAll(); // Restart sessions to load fresh database state
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ── NEW v3.0: Toggle Voting Day ──────────────────────────────
app.post('/api/admin/toggle-voting-day', async (req, res) => {
  try {
    const r = await bridge.adminToggleVotingDay();
    if (r.ok) {
      electionState.votingDayOn = r.votingDayOn;
      broadcast('voting_day_toggled', { votingDayOn: r.votingDayOn });
      firebase.syncElectionState({ votingDayOn: r.votingDayOn });
      firebase.logAuditEvent({ type: 'voting_day_toggle', state: r.votingDayOn ? 'ON' : 'OFF' });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ── NEW v3.0: Voting Day Status (read-only) ─────────────────
app.get('/api/admin/voting-day-status', (req, res) => {
  res.json({ ok: true, votingDayOn: electionState.votingDayOn });
});

// ── NEW v3.0: Audit Ledger ───────────────────────────────────
app.get('/api/admin/audit-ledger', async (req, res) => {
  try {
    const r = await bridge.adminAuditLedger();
    if (r.ok) {
      firebase.logAuditEvent({ type: 'audit_ledger_viewed' });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ──────────────────────────────────────────────────────────────
// Agent Routes — Polling Agent
// ──────────────────────────────────────────────────────────────

app.post('/api/agent/login', async (req, res) => {
  const { id, password } = req.body;
  if (!id || !password) return res.status(400).json({ ok: false, errors: ['Missing credentials'] });
  try {
    const r = await bridge.agentLogin(id, password);
    if (r.ok) {
      electionState.agentLoggedIn = true;
      broadcast('agent_online', { online: true });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/agent/issue-otp', async (req, res) => {
  const { voterNumber, fingerprint } = req.body;
  if (!voterNumber || !fingerprint) return res.status(400).json({ ok: false, errors: ['Missing fields'] });
  try {
    const r = await bridge.agentIssueOtpFull(voterNumber, fingerprint);
    if (r.ok && r.otp) {
      broadcast('otp_issued', {
        expiry: Date.now() + 300000,
        agentMessage: 'OTP issued to voter',
      });
      firebase.logAuditEvent({ type: 'otp_issued', voterNumber: '***' });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ──────────────────────────────────────────────────────────────
// Voter Routes
// ──────────────────────────────────────────────────────────────

app.post('/api/voter/register', async (req, res) => {
  const { voterNumber, fingerprint } = req.body;
  if (!voterNumber || !fingerprint) return res.status(400).json({ ok: false, errors: ['Missing fields'] });
  try {
    const r = await bridge.voterRegister(voterNumber, fingerprint);
    if (r.ok) {
      electionState.registeredCount++;
      broadcast('voter_registered', { count: electionState.registeredCount });
      firebase.logAuditEvent({ type: 'voter_registered' });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.post('/api/voter/login', async (req, res) => {
  const { secretKey, fingerprint } = req.body;
  if (!secretKey || !fingerprint) return res.status(400).json({ ok: false, errors: ['Missing credentials'] });
  try {
    const r = await bridge.voterLogin(secretKey, fingerprint);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.get('/api/voter/candidates', async (req, res) => {
  try {
    // Fetch candidates from admin results (most reliable source)
    const r = await bridge.adminGetResults();
    if (r.ok) {
      const candidates = Object.keys(r.results);
      // Merge any cached candidates too
      electionState.candidates.forEach((c) => {
        if (!candidates.includes(c)) candidates.push(c);
      });
      res.json({ ok: true, candidates });
    } else {
      // Fallback to in-memory cache
      res.json({ ok: true, candidates: electionState.candidates });
    }
  } catch (err) {
    res.json({ ok: true, candidates: electionState.candidates });
  }
});

app.post('/api/voter/cast-vote', async (req, res) => {
  const { secretKey, fingerprint, otp, candidateIndex } = req.body;
  if (!secretKey || !fingerprint || !otp || candidateIndex === undefined) {
    return res.status(400).json({ ok: false, errors: ['Missing fields'] });
  }
  try {
    const r = await bridge.voterCastVote(secretKey, fingerprint, otp, candidateIndex);
    if (r.ok) {
      electionState.votesCast++;
      // Fetch updated results and broadcast
      try {
        const results = await bridge.adminGetResults();
        if (results.ok) {
          electionState.votes = results.results;
          broadcast('vote_cast', {
            results: results.results,
            leader: results.leader,
            totalVotes: electionState.votesCast,
          });
          firebase.updateVoteCounts(results.results);
        }
      } catch (_) {
        broadcast('vote_cast', { totalVotes: electionState.votesCast });
      }
      firebase.logAuditEvent({ type: 'vote_cast' });
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ── NEW v3.0: Verify own vote ────────────────────────────────
app.post('/api/voter/verify-vote', async (req, res) => {
  const { secretKey, fingerprint } = req.body;
  if (!secretKey || !fingerprint) return res.status(400).json({ ok: false, errors: ['Missing credentials'] });
  try {
    const r = await bridge.voterVerifyVote(secretKey, fingerprint);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

// ──────────────────────────────────────────────────────────────
// General / Status Routes
// ──────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({ ok: true, state: electionState });
});

app.get('/api/ledger', async (req, res) => {
  try {
    const r = await bridge.adminAuditLedger();
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, errors: [err.message] });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    server: 'Blockchain Voting System v3.0',
    uptime: process.uptime(),
    clients: wss.clients.size,
    ts: Date.now(),
  });
});

// ── GET /api/tunnel/url — returns current active tunnel URL ──
app.get('/api/tunnel/url', (req, res) => {
  const url = detectTunnelUrl();
  res.json({ ok: true, tunnelUrl: url || null, localUrl: `http://localhost:${PORT}` });
});

// SPA fallback — must be LAST
app.get('*', (req, res) => {
  const indexFile = path.join(WEBSITE_DIR, 'index.html');
  if (fs.existsSync(indexFile)) {
    res.sendFile(indexFile);
  } else {
    res.status(404).send('Website not found.');
  }
});

// ──────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────

// ── Auto-detect tunnel URL from log files ────────────────────
function detectTunnelUrl() {
  const logCandidates = [
    { file: 'pinggy.log',  regex: /https:\/\/[\w.-]+\.free\.pinggy\.link/g },
    { file: 'pinggy.log',  regex: /https:\/\/[\w.-]+\.pinggy\.link/g },
    { file: 'lhr3.log',   regex: /https:\/\/[a-f0-9]+\.lhr\.life/g },
    { file: 'lhr2.log',   regex: /https:\/\/[a-f0-9]+\.lhr\.life/g },
    { file: 'lhr.log',    regex: /https:\/\/[a-f0-9]+\.lhr\.life/g },
  ];

  for (const { file, regex } of logCandidates) {
    const logFile = path.join(__dirname, '..', file);
    try {
      if (!fs.existsSync(logFile)) continue;
      let content = fs.readFileSync(logFile, 'utf8');
      if (content.includes('\u0000')) {
        content = fs.readFileSync(logFile, 'utf16le');
      }
      const matches = [...content.matchAll(regex)];
      if (matches.length > 0) {
        return matches[matches.length - 1][0];
      }
    } catch (_) {}
  }
  return null;
}

let _lastPublishedTunnelUrl = null;

async function tryPublishTunnelUrl() {
  const tunnelUrl = detectTunnelUrl();
  if (tunnelUrl && tunnelUrl !== _lastPublishedTunnelUrl) {
    _lastPublishedTunnelUrl = tunnelUrl;
    console.log(`  ➤  Tunnel   → ${tunnelUrl}`);
    await firebase.publishServerUrl(tunnelUrl);
  } else if (!tunnelUrl) {
    console.warn('  ⚠️  No tunnel URL found — run START_SERVER.bat to create one');
  }
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  BLOCKCHAIN VOTING SYSTEM — Web Server v3.0      ║');
  console.log('║  AES-256 Encrypted + P2P Gossip + WebSocket Live ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`\n  ➤  HTTP     → http://localhost:${PORT}`);
  console.log(`  ➤  WS       → ws://localhost:${PORT}`);
  console.log(`  ➤  Admin    → http://localhost:${PORT}/admin`);
  console.log(`  ➤  Agent    → http://localhost:${PORT}/agent`);
  console.log(`  ➤  Register → http://localhost:${PORT}/register`);
  console.log(`  ➤  Vote     → http://localhost:${PORT}/vote`);
  console.log('');
  firebase.init();

  // First publish attempt after 5s (tunnel needs time to start)
  setTimeout(tryPublishTunnelUrl, 5000);

  // Re-publish every 5 minutes so Firestore always has the latest URL
  setInterval(tryPublishTunnelUrl, 5 * 60 * 1000);
});

// Graceful shutdown
process.on('SIGINT',  () => { bridge.killAll(); process.exit(0); });
process.on('SIGTERM', () => { bridge.killAll(); process.exit(0); });

module.exports = { app, server, wss, broadcast };
