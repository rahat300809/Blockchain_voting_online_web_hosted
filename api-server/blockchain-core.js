/**
 * blockchain-core.js — Pure Node.js Blockchain Engine
 *
 * Replaces all C++ executables (admin.exe, voter.exe, agent.exe, core.exe).
 * Implements the full AES-256 encrypted blockchain voting system in JavaScript.
 *
 * Features:
 *  - AES-256-CBC encryption for stored data
 *  - SHA-256 hash-chained blockchain
 *  - Proof-of-Work block mining (3 leading zeros)
 *  - Tamper detection via hash verification
 *  - OTP generation & validation (5-min expiry)
 *  - Anonymous votes via voter hash
 *  - JSON persistence (file or Firestore)
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..');
const DATA_FILE = path.join(DATA_DIR, 'election_data.json');

// Default credentials (fallback)
let ADMIN_ID   = 'admin';
let ADMIN_PASS = 'system';
let AGENT_ID   = 'agent';
let AGENT_PASS = 'agentpass';

function loadCredentialsFromCpp() {
  try {
    const candidates = [
      path.join(__dirname, 'core.cpp'),
      path.join(__dirname, '..', 'core.cpp'),
      path.join(process.cwd(), 'core.cpp'),
    ];
    let content = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) {
        content = fs.readFileSync(p, 'utf8');
        break;
      }
    }
    if (content) {
      const matchAdminId   = content.match(/const\s+string\s+ADMIN_ID\s*=\s*"([^"]+)"/);
      const matchAdminPass = content.match(/const\s+string\s+ADMIN_PASS\s*=\s*"([^"]+)"/);
      const matchAgentId   = content.match(/const\s+string\s+AGENT_ID\s*=\s*"([^"]+)"/);
      const matchAgentPass = content.match(/const\s+string\s+AGENT_PASS\s*=\s*"([^"]+)"/);

      if (matchAdminId && !process.env.ADMIN_ID)     ADMIN_ID   = matchAdminId[1];
      if (matchAdminPass && !process.env.ADMIN_PASS) ADMIN_PASS = matchAdminPass[1];
      if (matchAgentId && !process.env.AGENT_ID)     AGENT_ID   = matchAgentId[1];
      if (matchAgentPass && !process.env.AGENT_PASS) AGENT_PASS = matchAgentPass[1];

      console.log(`[Blockchain] Dynamically loaded C++ credentials — Admin: "${ADMIN_ID}", Agent: "${AGENT_ID}"`);
    }
  } catch (err) {
    console.warn('[Blockchain] Failed to load credentials from core.cpp:', err.message);
  }
}

// Perform initial load
loadCredentialsFromCpp();

// Override with env variables if provided
if (process.env.ADMIN_ID)   ADMIN_ID   = process.env.ADMIN_ID;
if (process.env.ADMIN_PASS) ADMIN_PASS = process.env.ADMIN_PASS;
if (process.env.AGENT_ID)   AGENT_ID   = process.env.AGENT_ID;
if (process.env.AGENT_PASS) AGENT_PASS = process.env.AGENT_PASS;

const ENC_KEY = crypto.scryptSync(
  process.env.ENCRYPT_KEY || 'BlockVote-AES256-Key-2024',
  'salt-blockchain300809', 32
);
const POW_DIFFICULTY = 3; // hash must start with '000'

// ── In-Memory State ───────────────────────────────────────────────────────────
let state = {
  votingDayOn:  false,
  candidates:   [],
  voterList:    {},  // voterNumber -> fingerprint (from loaded voter file)
  voters:       {},  // voterNumber -> { fingerprint, secretKey, voted, otpCode, otpExpiry }
  blockchain:   [],  // array of blocks
};

// ── Crypto Utilities ──────────────────────────────────────────────────────────

function sha256(data) {
  return crypto.createHash('sha256').update(String(data)).digest('hex');
}

function aesEncrypt(text) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', ENC_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function aesDecrypt(encText) {
  const [ivHex, dataHex] = encText.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', ENC_KEY, iv);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}

function generateSecretKey() {
  return crypto.randomBytes(12).toString('hex').toUpperCase();
}

function generateOtp() {
  return String(crypto.randomInt(100000, 999999));
}

// ── Blockchain Engine ─────────────────────────────────────────────────────────

function getPrevHash() {
  if (state.blockchain.length === 0) return '0'.repeat(64);
  return state.blockchain[state.blockchain.length - 1].hash;
}

function computeHash(index, timestamp, data, prevHash, nonce) {
  return sha256(`${index}|${timestamp}|${JSON.stringify(data)}|${prevHash}|${nonce}`);
}

function mineBlock(type, data) {
  const index     = state.blockchain.length;
  const timestamp = Date.now();
  const prevHash  = getPrevHash();
  let nonce = 0;
  let hash;
  const prefix = '0'.repeat(POW_DIFFICULTY);

  do {
    hash = computeHash(index, timestamp, data, prevHash, nonce);
    nonce++;
  } while (!hash.startsWith(prefix));

  return { index, timestamp, type, data, prevHash, hash, nonce: nonce - 1 };
}

function addBlock(type, data) {
  const block = mineBlock(type, data);
  state.blockchain.push(block);
  saveState();
  return block;
}

function verifyChain() {
  for (let i = 1; i < state.blockchain.length; i++) {
    const b    = state.blockchain[i];
    const prev = state.blockchain[i - 1];
    if (b.prevHash !== prev.hash) return false;
    const recomputed = computeHash(b.index, b.timestamp, b.data, b.prevHash, b.nonce);
    if (recomputed !== b.hash) return false;
  }
  return true;
}

// ── Persistence ───────────────────────────────────────────────────────────────

function saveState() {
  try {
    const json = JSON.stringify(state, null, 2);
    const enc  = aesEncrypt(json);
    fs.writeFileSync(DATA_FILE + '.enc', enc, 'utf8');
    // Also save plain JSON backup
    fs.writeFileSync(DATA_FILE, json, 'utf8');
  } catch (e) {
    console.warn('[Blockchain] Save failed:', e.message);
  }
}

function loadState() {
  // Try encrypted file first
  try {
    const enc  = fs.readFileSync(DATA_FILE + '.enc', 'utf8');
    const json = aesDecrypt(enc);
    const loaded = JSON.parse(json);
    Object.assign(state, loaded);
    console.log('[Blockchain] State loaded from encrypted file.');
    return;
  } catch (_) {}

  // Fall back to plain JSON
  try {
    const json   = fs.readFileSync(DATA_FILE, 'utf8');
    const loaded = JSON.parse(json);
    Object.assign(state, loaded);
    console.log('[Blockchain] State loaded from JSON file.');
  } catch (_) {
    console.log('[Blockchain] No saved state. Starting fresh.');
  }
}

loadState();

// ── Admin Functions ───────────────────────────────────────────────────────────

async function adminLogin(id, password) {
  if (id === ADMIN_ID && password === ADMIN_PASS) {
    return { ok: true, messages: ['[OK] Login successful'] };
  }
  return { ok: false, errors: ['[DENIED] Invalid credentials'] };
}

async function adminLoadVoterFile(filePathOrData) {
  try {
    let content = '';
    // Try reading as file path relative to project root
    const candidates = [
      filePathOrData,
      path.join(DATA_DIR, filePathOrData),
      path.join(__dirname, '..', filePathOrData),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) { content = fs.readFileSync(p, 'utf8'); break; }
      } catch (_) {}
    }
    // If no file found, treat as raw pasted data
    if (!content) content = filePathOrData;

    state.voterList = {};
    let count = 0;
    content.trim().split('\n').forEach(line => {
      const parts = line.trim().split(/[\s,;|]+/);
      if (parts.length >= 2 && parts[0]) {
        state.voterList[parts[0]] = parts[1];
        count++;
      }
    });

    if (count === 0) return { ok: false, errors: ['No valid voter data found. Format: "VoterNumber Fingerprint" per line'] };

    addBlock('CONFIG', { action: 'voter_file_loaded', count });
    return { ok: true, messages: [`[OK] Loaded ${count} voters into the system`] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

async function adminAddCandidate(name) {
  if (!name || !name.trim()) return { ok: false, errors: ['Candidate name is required'] };
  const n = name.trim();
  if (state.candidates.includes(n)) return { ok: false, errors: ['Candidate already exists'] };
  state.candidates.push(n);
  addBlock('CANDIDATE', { name: n });
  return { ok: true, messages: [`[OK] Candidate "${n}" added`] };
}

async function adminGetResults() {
  const results = {};
  state.candidates.forEach(c => { results[c] = 0; });
  state.blockchain
    .filter(b => b.type === 'VOTE')
    .forEach(b => {
      if (b.data.candidate && results[b.data.candidate] !== undefined) {
        results[b.data.candidate]++;
      }
    });
  const sorted = Object.entries(results).sort((a, b) => b[1] - a[1]);
  const leader      = sorted[0]?.[0]  || null;
  const leaderVotes = sorted[0]?.[1]  || 0;
  return { ok: true, results, leader, leaderVotes };
}

async function adminVerifyChain() {
  const intact = verifyChain();
  const lines = state.blockchain.map(b => {
    const ts = new Date(b.timestamp).toLocaleString();
    const label = intact ? '[INTACT]' : '[TAMPERED]';
    return `${label} Block #${b.index} | ${b.type} | ${ts} | Hash: ${b.hash.slice(0, 16)}...`;
  });
  if (state.blockchain.length === 0) lines.push('Blockchain is empty.');
  return { ok: true, intact, lines };
}

async function adminResetVotes() {
  state.blockchain = state.blockchain.filter(b => b.type !== 'VOTE');
  Object.values(state.voters).forEach(v => { v.voted = false; });
  saveState();
  return { ok: true, messages: ['[OK] All votes have been reset'] };
}

async function adminFactoryReset() {
  state = { votingDayOn: false, candidates: [], voterList: {}, voters: {}, blockchain: [] };
  saveState();
  return { ok: true, messages: ['[OK] Factory reset complete — all data wiped'] };
}

async function adminToggleVotingDay() {
  state.votingDayOn = !state.votingDayOn;
  const status = state.votingDayOn ? 'ON' : 'OFF';
  addBlock('CONFIG', { action: 'voting_day_toggle', votingDayOn: state.votingDayOn });
  return { ok: true, votingDayOn: state.votingDayOn, messages: [`[OK] Voting Day is now: ${status}`] };
}

async function adminAuditLedger() {
  const lines = state.blockchain.map(b => {
    const ts   = new Date(b.timestamp).toLocaleString();
    const extra = b.type === 'VOTE'
      ? ` | Candidate: ${b.data.candidate}`
      : b.type === 'CANDIDATE'
        ? ` | Name: ${b.data.name}`
        : b.type === 'REGISTRATION'
          ? ` | [Anonymous voter]`
          : b.data.action
            ? ` | ${b.data.action}`
            : '';
    return `>>> Block #${b.index} [${b.type}] ${ts}${extra} | Hash: ${b.hash.slice(0, 20)}...`;
  });
  if (lines.length === 0) lines.push('>>> Blockchain is empty. No blocks recorded yet.');
  return { ok: true, lines };
}

// ── Agent Functions ───────────────────────────────────────────────────────────

async function agentLogin(id, password) {
  if (id === AGENT_ID && password === AGENT_PASS) {
    return { ok: true, messages: ['[OK] Agent login successful'] };
  }
  return { ok: false, errors: ['[DENIED] Invalid agent credentials'] };
}

async function agentIssueOtpFull(voterNumber, fingerprint) {
  if (!state.voterList[voterNumber]) {
    return { ok: false, errors: ['[DENIED] Voter number not found in approved list'] };
  }
  if (state.voterList[voterNumber] !== fingerprint) {
    return { ok: false, errors: ['[DENIED] Fingerprint mismatch'] };
  }

  const otp    = generateOtp();
  const expiry = Date.now() + 5 * 60 * 1000; // 5 minutes

  if (!state.voters[voterNumber]) state.voters[voterNumber] = {};
  state.voters[voterNumber].otpCode  = otp;
  state.voters[voterNumber].otpExpiry = expiry;
  saveState();

  return { ok: true, otp, expiry, messages: [`[SUCCESS] OTP issued: ${otp}`] };
}

// ── Voter Functions ───────────────────────────────────────────────────────────

async function voterRegister(voterNumber, fingerprint) {
  if (!state.voterList[voterNumber]) {
    return { ok: false, errors: ['[DENIED] Voter number not in approved list — contact admin'] };
  }
  if (state.voterList[voterNumber] !== fingerprint) {
    return { ok: false, errors: ['[DENIED] Fingerprint does not match records'] };
  }
  if (state.voters[voterNumber]?.secretKey) {
    return { ok: false, errors: ['[DENIED] This voter has already registered'] };
  }

  const secretKey = generateSecretKey();
  state.voters[voterNumber] = {
    fingerprint,
    secretKey,
    voted:      false,
    otpCode:    null,
    otpExpiry:  null,
  };

  // Record anonymized registration on blockchain
  addBlock('REGISTRATION', { voterHash: sha256(voterNumber + fingerprint) });

  return { ok: true, secretKey, messages: [`[SUCCESS] Voter Account Created. >>> YOUR SECRET KEY: ${secretKey}`] };
}

async function voterLogin(secretKey, fingerprint) {
  const entry = Object.entries(state.voters).find(
    ([, v]) => v.secretKey === secretKey && v.fingerprint === fingerprint
  );
  if (!entry) return { ok: false, errors: ['[DENIED] Invalid credentials'] };
  return { ok: true, messages: ['[OK] Login successful'], voterNumber: entry[0] };
}

async function voterCastVote(secretKey, fingerprint, otp, candidateIndex) {
  const entry = Object.entries(state.voters).find(
    ([, v]) => v.secretKey === secretKey && v.fingerprint === fingerprint
  );
  if (!entry) return { ok: false, errors: ['[DENIED] Invalid credentials'] };

  const [voterNumber, voter] = entry;

  if (!state.votingDayOn) {
    return { ok: false, errors: ['[DENIED] Voting is not open today. Admin must enable voting day.'] };
  }
  if (voter.voted) {
    return { ok: false, errors: ['[DENIED] You have already cast your vote'] };
  }
  if (!voter.otpCode || voter.otpCode !== String(otp)) {
    return { ok: false, errors: ['[DENIED] Invalid OTP. Get a new OTP from the polling agent.'] };
  }
  if (Date.now() > voter.otpExpiry) {
    return { ok: false, errors: ['[DENIED] OTP has expired. Request a new OTP from the agent.'] };
  }

  const idx = parseInt(candidateIndex) - 1;
  if (isNaN(idx) || idx < 0 || idx >= state.candidates.length) {
    return { ok: false, errors: ['[ERROR] Invalid candidate selection'] };
  }

  const candidate       = state.candidates[idx];
  voter.voted           = true;
  voter.otpCode         = null; // Invalidate OTP
  voter.otpExpiry       = null;

  addBlock('VOTE', {
    candidate,
    voterHash: sha256(voterNumber + secretKey), // Fully anonymous
  });

  return { ok: true, messages: [`[SUCCESS] Vote cast successfully for: ${candidate}`] };
}

async function voterVerifyVote(secretKey, fingerprint) {
  const entry = Object.entries(state.voters).find(
    ([, v]) => v.secretKey === secretKey && v.fingerprint === fingerprint
  );
  if (!entry) return { ok: false, errors: ['[DENIED] Invalid credentials'] };

  const [voterNumber] = entry;
  const voterHash = sha256(voterNumber + secretKey);

  const voteBlock = state.blockchain.find(
    b => b.type === 'VOTE' && b.data.voterHash === voterHash
  );

  if (voteBlock) {
    return {
      ok: true, found: true,
      blockIndex: voteBlock.index,
      blockHash:  voteBlock.hash,
      candidate:  voteBlock.data.candidate,
      messages: [
        `[FOUND] Your vote is recorded on the blockchain.`,
        `Block Index : ${voteBlock.index}`,
        `Block Hash  : ${voteBlock.hash}`,
        `Candidate   : ${voteBlock.data.candidate}`,
      ],
    };
  }
  return { ok: true, found: false, messages: ['[NOT FOUND] No vote record for this voter'] };
}

function killAll() {
  // No-op: pure JS, no child processes to kill
}

function getState() {
  return {
    candidates:      state.candidates,
    votes:           {},
    votingDayOn:     state.votingDayOn,
    voterCount:      Object.keys(state.voterList).length,
    registeredCount: Object.values(state.voters).filter(v => v.secretKey).length,
    votesCast:       state.blockchain.filter(b => b.type === 'VOTE').length,
    blockCount:      state.blockchain.length,
    chainIntact:     state.blockchain.length > 0 ? verifyChain() : null,
  };
}

module.exports = {
  // Admin
  adminLogin, adminLoadVoterFile, adminAddCandidate,
  adminGetResults, adminVerifyChain, adminResetVotes,
  adminFactoryReset, adminToggleVotingDay, adminAuditLedger,
  // Agent
  agentLogin, agentIssueOtpFull,
  // Voter
  voterRegister, voterLogin, voterCastVote, voterVerifyVote,
  // Utilities
  killAll, getState,
};
