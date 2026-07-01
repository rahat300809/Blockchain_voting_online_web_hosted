/**
 * bridge.js — C++ Process Bridge (v3.0 — P2P Edition)
 *
 * Manages stdin/stdout communication with the C++ blockchain executables.
 * All crypto (AES-256, SHA-256, PoW, P2P gossip) runs entirely in the C++ process.
 *
 * New in v3.0:
 *  - Voting Day toggle (choice 6 in admin)
 *  - Audit Ledger (choice 7 in admin)
 *  - Vote verification (choice 3 in voter dashboard)
 *  - USER_VOTE record type (verifiable votes)
 *  - P2P node support via --port / --peers launch args
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const EXE_DIR = path.join(__dirname, '..');

// ─── Sentinel phrases emitted by the C++ programs ─────────────────────────────

const SENTINELS = {
  MAIN_MENU: 'Choice:',                   // top-level 5-item menu
  ADMIN_MENU: 'Choice:',                  // admin 8-item menu
  AGENT_MENU: 'Choice:',                  // agent 2-item menu
  VOTER_MENU: 'Choice:',                  // voter 5-item menu
  ADVANCED_RESET_MENU: 'Choice:',         // danger-zone sub-menu
  LOGIN_PROMPT_ID: 'ID       :',
  LOGIN_PROMPT_PASS: 'Password :',
  VOTER_NUM_PROMPT: 'Voter Number:',
  VOTER_NUM_PROMPT2: 'Voter Number         :',
  FP_PROMPT: 'Voter Fingerprint:',
  FP_PROMPT2: 'Fingerprint (4-digit):',
  FP_LOGIN: 'Fingerprint :',
  SECRET_KEY: 'Secret Key  :',
  CANDIDATE_NAME: 'Candidate Name:',
  VOTER_FILE: 'Enter voter file path:',
  SAVE_CREDS: 'Save credentials to file? (y/n):',
  SAVE_FILE: 'filename (e.g. my_key.txt):',
  CONFIRM: 'y/n):',
  CONFIRM_WIPE: 'Type CONFIRM to wipe everything:',
  OTP_PROMPT: 'Enter 6-digit OTP from Polling Agent:',
  SELECT_CANDIDATE: 'Choice:',
  AUDIT_FILE: 'Save audit to file? Enter filename',
};

// Regex for OTP secret key in registration output
const SECRET_KEY_RE = />>> YOUR SECRET KEY\s*:\s*(\S+)/;
const OTP_ISSUED_RE = />>> \[SUCCESS\] OTP issued:\s*(\d{6})/;
const VOTE_SUCCESS_RE = />>> \[SUCCESS\] Vote cast successfully/;
const LOGIN_OK_RE = />>> \[OK\] Login successful/;
const REG_SUCCESS_RE = />>> \[SUCCESS\] Voter Account Created/;
const DENIED_RE = />>> \[DENIED\]/;
const ERROR_RE = />>> \[ERROR\]/;
const VOTING_DAY_RE = />>> \[OK\] Voting Day is now:\s*(\w+)/;
const VERIFY_VOTE_RE = />>> \[FOUND\] Your vote is recorded/;
const VERIFY_NOT_RE = />>> \[NOT FOUND\] No vote record/;
const VOTE_BLOCK_RE = /Block Index\s+:\s+(\d+)/;
const VOTE_HASH_RE  = /Block Hash\s+:\s+([0-9a-f]+)/;
const VOTE_CAND_RE  = /Voted For\s+:\s+(.+)/;

// ─── BridgeSession — wraps one C++ process ─────────────────────────────────

class BridgeSession extends EventEmitter {
  /**
   * @param {'admin'|'agent'|'voter'} role
   * @param {object} [opts]
   * @param {string} [opts.port]       P2P port for this node (--port)
   * @param {string} [opts.peers]      Comma-separated peer ports (--peers)
   */
  constructor(role, opts = {}) {
    super();
    this.role = role;
    this.proc = null;
    this.output = '';
    this.ready = false;
    this.loggedIn = false;
    this.isReadyResolved = false;
    this._resolvers = [];
    this.opts = opts;

    this.readyPromise = new Promise((resolve, reject) => {
      this._resolveReady = resolve;
      this._rejectReady = reject;
    });
  }

  start() {
    const exeName = `${this.role}.exe`;
    const exePath = path.join(EXE_DIR, exeName);
    const args = [];
    if (this.opts.port)  { args.push('--port',  this.opts.port);  }
    if (this.opts.peers) { args.push('--peers', this.opts.peers); }

    this.proc = spawn(exePath, args, {
      cwd: EXE_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdin.on('error', (err) => {
      // Prevent crash on EPIPE if C++ process exits early
      if (process.env.DEBUG_BRIDGE) console.error(`[${this.role}/stdin/error] ${err.message}`);
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stdout.on('data', (chunk) => {
      this.output += chunk;

      // Auto-login logic for background processes
      if (this.role === 'admin' && !this.loggedIn) {
        if (this.output.includes('ID       :')) {
          this.output = this.output.replace('ID       :', '');
          this.send('admin');
        } else if (this.output.includes('Password :')) {
          this.output = this.output.replace('Password :', '');
          this.send('system');
          this.loggedIn = true;
        }
      }
      if (this.role === 'agent' && !this.loggedIn) {
        if (this.output.includes('ID       :')) {
          this.output = this.output.replace('ID       :', '');
          this.send('agent');
        } else if (this.output.includes('Password :')) {
          this.output = this.output.replace('Password :', '');
          this.send('agentpass');
          this.loggedIn = true;
        }
      }

      // Check if process has reached the main choice dashboard
      if (!this.isReadyResolved) {
        if (this.role === 'voter' && this.output.includes('Choice:')) {
          this.isReadyResolved = true;
          this.ready = true;
          this._resolveReady();
        } else if ((this.role === 'admin' || this.role === 'agent') && this.loggedIn && this.output.includes('Choice:')) {
          this.isReadyResolved = true;
          this.ready = true;
          this._resolveReady();
        }
      }

      this._flushResolvers();
      this.emit('output', chunk);
    });

    this.proc.stderr.on('data', (chunk) => {
      this.emit('p2p_log', chunk.trim());
      if (process.env.DEBUG_BRIDGE) console.error(`[${this.role}/stderr] ${chunk.trim()}`);
    });

    this.proc.on('close', (code) => {
      this.ready = false;
      this.loggedIn = false;
      this.isReadyResolved = false;
      this.readyPromise = new Promise((resolve, reject) => {
        this._resolveReady = resolve;
        this._rejectReady = reject;
      });
      this.emit('close', code);
      this._resolvers.forEach(({ reject }) => reject(new Error('Process exited')));
      this._resolvers = [];
    });

    this.proc.on('error', (err) => {
      this.emit('error', err);
      this._resolvers.forEach(({ reject }) => reject(err));
      this._resolvers = [];
    });
  }

  /**
   * Wait until `sentinel` appears in the accumulated output,
   * then return all accumulated output up to that point.
   */
  waitFor(sentinel, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      // Check if already present
      if (this.output.includes(sentinel)) {
        const out = this.output;
        this.output = '';
        return resolve(out);
      }
      const timer = setTimeout(() => {
        const idx = this._resolvers.findIndex((r) => r.sentinel === sentinel);
        if (idx !== -1) this._resolvers.splice(idx, 1);
        reject(new Error(`Timeout waiting for sentinel: ${sentinel}`));
      }, timeoutMs);

      this._resolvers.push({ sentinel, resolve: (out) => { clearTimeout(timer); resolve(out); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    });
  }

  _flushResolvers() {
    this._resolvers = this._resolvers.filter((entry) => {
      if (this.output.includes(entry.sentinel)) {
        const out = this.output;
        this.output = '';
        entry.resolve(out);
        return false;
      }
      return true;
    });
  }

  send(text) {
    if (this.proc && this.proc.stdin.writable) {
      this.proc.stdin.write(text + '\n');
    }
  }

  kill() {
    if (this.proc) this.proc.kill();
  }
}

// ─── Shared C++ process pool ───────────────────────────────────────────────

let _adminSession  = null;
let _agentSession  = null;
let _voterSessions = new Map(); // keyed by session token

function getAdminSession() {
  if (!_adminSession || !_adminSession.proc || _adminSession.proc.exitCode !== null) {
    _adminSession = new BridgeSession('admin');
    _adminSession.start();
  }
  return _adminSession;
}

function getAgentSession() {
  if (!_agentSession || !_agentSession.proc || _agentSession.proc.exitCode !== null) {
    _agentSession = new BridgeSession('agent');
    _agentSession.start();
  }
  return _agentSession;
}

function getVoterSession(token) {
  if (!_voterSessions.has(token) || _voterSessions.get(token).proc.exitCode !== null) {
    const s = new BridgeSession('voter');
    s.start();
    _voterSessions.set(token, s);
  }
  return _voterSessions.get(token);
}

// ──────────────────────────────────────────────────────────────────────────────
// ADMIN BRIDGE FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Authenticate as admin directly.
 * Returns { ok, errors, messages }
 */
async function adminLogin(id, password) {
  if (id === 'admin' && password === 'system') {
    return { ok: true, messages: ['Admin authenticated'] };
  } else {
    return { ok: false, errors: ['Invalid admin credentials'] };
  }
}

/**
 * Load voter file by sending choice 1 from the admin menu.
 */
async function adminLoadVoterFile(filePath) {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('1');
    await s.waitFor('voter file path:', 5000);
    s.send(filePath);
    const out = await s.waitFor('Choice:', 15000);
    if (out.includes('[ERROR]')) {
      const m = out.match(/>>> \[ERROR\] (.+)/);
      return { ok: false, errors: [m ? m[1] : 'Failed to load voter file'] };
    }
    const m = out.match(/(\d+) voter entries loaded/);
    return { ok: true, messages: [m ? `${m[1]} voters loaded` : 'Voter file loaded'] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Add a candidate (admin choice 2).
 */
async function adminAddCandidate(name) {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('2');
    await s.waitFor('Candidate Name:', 5000);
    s.send(name);
    const out = await s.waitFor('Choice:', 10000);
    if (out.includes('[ERROR]')) {
      return { ok: false, errors: [`Failed to add candidate: ${name}`] };
    }
    return { ok: true, messages: [`Candidate '${name}' added`] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Get live results (admin choice 3).
 * Returns { ok, results: {name: votes}, leader, leaderVotes }
 */
async function adminGetResults() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('3');
    const out = await s.waitFor('Choice:', 15000);
    const results = {};
    let leader = '';
    let leaderVotes = 0;

    // Parse: "  CandidateName : N votes"
    const lines = out.split('\n');
    for (const line of lines) {
      const m = line.match(/^\s{2}(.+?)\s+:\s+(\d+)\s+votes?/);
      if (m) {
        const name  = m[1].trim();
        const votes = parseInt(m[2], 10);
        results[name] = votes;
        if (votes > leaderVotes) {
          leaderVotes = votes;
          leader = name;
        }
      }
    }
    return { ok: true, results, leader, leaderVotes };
  } catch (err) {
    return { ok: false, errors: [err.message], results: {} };
  }
}

/**
 * Verify blockchain integrity (admin choice 4).
 * Returns { ok, intact, lines }
 */
async function adminVerifyChain() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('4');
    const out = await s.waitFor('Choice:', 20000);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const intact = out.includes('Chain is CLEAN') || out.includes('blocks verified');
    return { ok: true, intact, lines };
  } catch (err) {
    return { ok: false, errors: [err.message], intact: false, lines: [] };
  }
}

/**
 * Reset votes only (admin → choice 5 → choice 1).
 */
async function adminResetVotes() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('5');
    await s.waitFor('Choice:', 5000);
    s.send('1');
    await s.waitFor('Reset all votes? (y/n):', 5000);
    s.send('y');
    const out = await s.waitFor('Choice:', 15000);
    return { ok: true, messages: ['Votes reset'] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Factory reset (admin → choice 5 → choice 3 → CONFIRM).
 */
async function adminFactoryReset() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('5');
    await s.waitFor('Choice:', 5000);
    s.send('3');
    await s.waitFor('Type CONFIRM to wipe everything:', 5000);
    s.send('CONFIRM');
    const out = await s.waitFor('Choice:', 15000);
    return { ok: true, messages: ['Factory reset complete'] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Toggle Voting Day (admin choice 6).
 * Returns { ok, votingDayOn: bool }
 */
async function adminToggleVotingDay() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('6');
    const out = await s.waitFor('Choice:', 10000);
    const m = out.match(VOTING_DAY_RE);
    const state = m ? m[1] === 'ON' : null;
    return { ok: true, votingDayOn: state, messages: [`Voting Day is now: ${state ? 'ON' : 'OFF'}`] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Audit full blockchain ledger (admin choice 7).
 * Returns { ok, lines }
 */
async function adminAuditLedger() {
  const s = getAdminSession();
  try {
    await s.readyPromise;
    s.send('7');
    await s.waitFor('Save audit to file?', 5000);
    s.send(''); // press Enter = print to stdout
    const out = await s.waitFor('Choice:', 25000);
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    return { ok: true, lines };
  } catch (err) {
    return { ok: false, errors: [err.message], lines: [] };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// AGENT BRIDGE FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

async function agentLogin(id, password) {
  if (id === 'agent' && password === 'agentpass') {
    return { ok: true, messages: ['Agent authenticated'] };
  } else {
    return { ok: false, errors: ['Invalid agent credentials'] };
  }
}

/**
 * Issue OTP for a voter (agent choice 1).
 * Returns { ok, otp }
 */
async function agentIssueOtp(voterNumber, fingerprint) {
  const s = getAgentSession();
  try {
    s.send('1');
    await s.waitFor('Voter Number:', 5000);
    s.send(voterNumber);

    // The process may either ask for fingerprint or return an error immediately
    const afterNum = await s.waitFor('Choice:', 12000);

    if (afterNum.includes('[ERROR]')) {
      const m = afterNum.match(/>>> \[ERROR\] (.+)/);
      return { ok: false, errors: [m ? m[1].trim() : 'Voter not found or not registered'] };
    }

    // If fingerprint was asked
    if (afterNum.includes('Fingerprint:')) {
      const fpIdx = afterNum.lastIndexOf('Choice:');
      // Fingerprint prompt appeared — but waitFor already consumed it since "Choice:" came after
      // Re-issue for next cycle is not possible here; the agent process flow is linear.
      // We need to detect it BEFORE Choice: arrives.
    }

    // Re-trigger flow — the agent menu expects sequential: issue OTP then check
    // Check output for OTP
    const otpMatch = afterNum.match(OTP_ISSUED_RE);
    if (otpMatch) {
      return { ok: true, otp: otpMatch[1], messages: ['OTP issued'] };
    }

    const deniedMatch = afterNum.match(DENIED_RE);
    if (deniedMatch) {
      const m = afterNum.match(/>>> \[DENIED\] (.+)/);
      return { ok: false, errors: [m ? m[1].trim() : 'OTP denied'] };
    }

    return { ok: false, errors: ['Unexpected response from agent process'] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Full agent OTP flow — handles the two-step prompt correctly.
 */
async function agentIssueOtpFull(voterNumber, fingerprint) {
  const s = getAgentSession();
  try {
    s.send('1');
    // Wait for voter number prompt
    await s.waitFor('Voter Number:', 5000);
    s.send(voterNumber);

    // The C++ code checks registration first. If not registered → error before fingerprint.
    // We wait for EITHER the fingerprint prompt OR "Choice:" (error path)
    let midOut = '';
    await Promise.race([
      s.waitFor('Voter Fingerprint:', 6000).then((o) => { midOut = o; }),
      s.waitFor('[ERROR]', 6000).then((o) => { midOut = o; }),
    ]).catch(() => {});

    // Force read remaining
    if (!midOut) midOut = s.output;

    if (midOut.includes('[ERROR]')) {
      const m = midOut.match(/>>> \[ERROR\] (.+)/);
      s.output = ''; // clear
      return { ok: false, errors: [m ? m[1].trim() : 'Voter error'] };
    }

    // Send fingerprint
    s.send(fingerprint);

    const out = await s.waitFor('Choice:', 10000);

    const otpMatch = out.match(OTP_ISSUED_RE);
    if (otpMatch) {
      return { ok: true, otp: otpMatch[1], messages: ['OTP issued successfully'] };
    }

    const deniedLine = out.match(/>>> \[DENIED\] (.+)/);
    if (deniedLine) {
      return { ok: false, errors: [deniedLine[1].trim()] };
    }

    const errLine = out.match(/>>> \[ERROR\] (.+)/);
    if (errLine) {
      return { ok: false, errors: [errLine[1].trim()] };
    }

    return { ok: false, errors: ['OTP could not be issued'] };
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// VOTER BRIDGE FUNCTIONS
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Register a new voter (voter.exe, main menu → 3).
 * Returns { ok, secretKey, errors, messages }
 */
async function voterRegister(voterNumber, fingerprint) {
  const token = `reg_${voterNumber}_${Date.now()}`;
  const s = getVoterSession(token);
  try {
    await s.waitFor('Choice:', 10000); // main menu
    s.send('3');
    await s.waitFor('Voter Number         :', 5000);
    s.send(voterNumber);
    await s.waitFor('Fingerprint (4-digit):', 5000);
    s.send(fingerprint);

    const out = await s.waitFor('(y/n):', 20000); // wait for "Save credentials?"

    if (out.includes('[ERROR]')) {
      const m = out.match(/>>> \[ERROR\] (.+)/);
      s.send('n'); // answer the save prompt if it arrived
      s.kill();
      _voterSessions.delete(token);
      return { ok: false, errors: [m ? m[1].trim() : 'Registration failed'] };
    }

    const keyMatch = out.match(SECRET_KEY_RE);
    if (!keyMatch) {
      s.send('n');
      s.kill();
      _voterSessions.delete(token);
      return { ok: false, errors: ['Secret key not found in output'] };
    }

    const secretKey = keyMatch[1];
    s.send('n'); // don't save to file — web UI handles that
    await s.waitFor('Choice:', 10000);
    s.send('5'); // exit back to main menu
    s.kill();
    _voterSessions.delete(token);
    return { ok: true, secretKey, messages: ['Registration successful'] };
  } catch (err) {
    s.kill();
    _voterSessions.delete(token);
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Voter login — verifies credentials without voting.
 * Returns { ok, errors }
 */
async function voterLogin(secretKey, fingerprint) {
  // We open a short-lived session to verify credentials
  const token = `login_${secretKey.slice(0, 8)}_${Date.now()}`;
  const s = getVoterSession(token);
  try {
    await s.waitFor('Choice:', 10000);
    s.send('4'); // Voter Login
    await s.waitFor('Secret Key  :', 5000);
    s.send(secretKey);
    await s.waitFor('Fingerprint :', 5000);
    s.send(fingerprint);
    const out = await s.waitFor('Choice:', 8000); // voter dashboard OR error
    if (out.includes('[ERROR]') || !out.includes('[OK] Login successful')) {
      const m = out.match(/>>> \[ERROR\] (.+)/);
      s.kill(); _voterSessions.delete(token);
      return { ok: false, errors: [m ? m[1].trim() : 'Invalid credentials'] };
    }
    // Log out cleanly
    s.send('5');
    await s.waitFor('Choice:', 5000).catch(() => {});
    s.kill();
    _voterSessions.delete(token);
    return { ok: true, messages: ['Login verified'] };
  } catch (err) {
    s.kill();
    _voterSessions.delete(token);
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Get list of candidates (via voter menu option 2).
 * Returns { ok, candidates: string[] }
 */
async function voterGetCandidates() {
  const token = `cands_${Date.now()}`;
  const s = getVoterSession(token);
  try {
    await s.waitFor('Choice:', 10000);
    s.send('4');
    await s.waitFor('Secret Key  :', 5000);
    // Use a dummy login — admin should have loaded; we use admin bridge for this
    // Better: use admin get_options
    s.kill(); _voterSessions.delete(token);
    return { ok: true, candidates: [] };
  } catch (err) {
    s.kill(); _voterSessions.delete(token);
    return { ok: false, errors: [err.message], candidates: [] };
  }
}

/**
 * Cast a vote — full flow: login → enter OTP → select candidate.
 * Returns { ok, errors, messages }
 */
async function voterCastVote(secretKey, fingerprint, otp, candidateIndex) {
  const token = `vote_${secretKey.slice(0, 8)}_${Date.now()}`;
  const s = getVoterSession(token);
  try {
    await s.waitFor('Choice:', 10000);
    s.send('4'); // Voter Login

    await s.waitFor('Secret Key  :', 5000);
    s.send(secretKey);
    await s.waitFor('Fingerprint :', 5000);
    s.send(fingerprint);

    const loginOut = await s.waitFor('Choice:', 8000);
    if (loginOut.includes('[ERROR]') || !loginOut.includes('[OK] Login successful')) {
      s.kill(); _voterSessions.delete(token);
      return { ok: false, errors: ['Invalid credentials'] };
    }

    // choice 1 = Cast Vote
    s.send('1');

    // May get denied messages before OTP prompt
    const midOut = await s.waitFor('OTP from Polling Agent:', 10000);
    if (midOut.includes('[DENIED]')) {
      const m = midOut.match(/>>> \[DENIED\] (.+)/);
      s.kill(); _voterSessions.delete(token);
      return { ok: false, errors: [m ? m[1].trim() : 'Vote denied'] };
    }

    s.send(otp);

    // Wait for candidate list or denial
    const afterOtp = await s.waitFor('Choice:', 12000);

    if (afterOtp.includes('[DENIED]')) {
      const m = afterOtp.match(/>>> \[DENIED\] (.+)/);
      s.kill(); _voterSessions.delete(token);
      return { ok: false, errors: [m ? m[1].trim() : 'Vote denied (OTP error)'] };
    }

    // Send candidate index
    s.send(String(candidateIndex));
    const voteOut = await s.waitFor('Choice:', 15000);

    if (voteOut.includes('[SUCCESS]') && voteOut.includes('Vote cast')) {
      s.send('5'); // logout
      s.kill(); _voterSessions.delete(token);
      return { ok: true, messages: ['Vote cast successfully and recorded on blockchain'] };
    }

    const m = voteOut.match(/>>> \[DENIED\] (.+)|>>> \[ERROR\] (.+)/);
    s.kill(); _voterSessions.delete(token);
    return { ok: false, errors: [m ? (m[1] || m[2]).trim() : 'Vote failed'] };
  } catch (err) {
    s.kill(); _voterSessions.delete(token);
    return { ok: false, errors: [err.message] };
  }
}

/**
 * Verify voter's own vote on the blockchain (voter menu choice 3).
 * Returns { ok, found, blockIndex, blockHash, candidate, publicAddress }
 */
async function voterVerifyVote(secretKey, fingerprint) {
  const token = `verify_${secretKey.slice(0, 8)}_${Date.now()}`;
  const s = getVoterSession(token);
  try {
    await s.waitFor('Choice:', 10000);
    s.send('4');
    await s.waitFor('Secret Key  :', 5000);
    s.send(secretKey);
    await s.waitFor('Fingerprint :', 5000);
    s.send(fingerprint);
    const loginOut = await s.waitFor('Choice:', 8000);
    if (!loginOut.includes('[OK] Login successful')) {
      s.kill(); _voterSessions.delete(token);
      return { ok: false, errors: ['Invalid credentials'] };
    }
    s.send('3'); // Verify My Vote
    const out = await s.waitFor('==============================================', 12000);
    const found = VERIFY_VOTE_RE.test(out);
    const idxM  = out.match(VOTE_BLOCK_RE);
    const hashM = out.match(VOTE_HASH_RE);
    const candM = out.match(VOTE_CAND_RE);
    const pubM  = out.match(/Your Public Address:\s+(\S+)/);
    s.send('5'); // logout
    s.kill(); _voterSessions.delete(token);
    return {
      ok: true,
      found,
      blockIndex:    idxM  ? idxM[1]  : null,
      blockHash:     hashM ? hashM[1] : null,
      candidate:     candM ? candM[1].trim() : null,
      publicAddress: pubM  ? pubM[1]  : null,
    };
  } catch (err) {
    s.kill(); _voterSessions.delete(token);
    return { ok: false, errors: [err.message] };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Shared Helpers
// ──────────────────────────────────────────────────────────────────────────────

function killAll() {
  if (_adminSession) _adminSession.kill();
  if (_agentSession) _agentSession.kill();
  _voterSessions.forEach((s) => s.kill());
  _voterSessions.clear();
}

module.exports = {
  adminLogin,
  adminLoadVoterFile,
  adminAddCandidate,
  adminGetResults,
  adminVerifyChain,
  adminResetVotes,
  adminFactoryReset,
  adminToggleVotingDay,
  adminAuditLedger,
  agentLogin,
  agentIssueOtpFull,
  voterRegister,
  voterLogin,
  voterCastVote,
  voterVerifyVote,
  killAll,
  getAdminSession,
  getAgentSession,
};
