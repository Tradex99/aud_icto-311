#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROXY_URLS = (process.env.AUDIUS_PROXY_URLS || 'https://audius-v2.qringgreen.workers.dev,https://audius-v2.qring99.workers.dev,https://audius.henrygreen311.workers.dev,https://audius-v2.henrygreen311.workers.dev,https://audius.qring99.workers.dev,https://audius.qringgreen.workers.dev')
  .split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
const PROXY_KEY = process.env.AUDIUS_PROXY_KEY || '';
{
  const realFetch = globalThis.fetch;
  const CONNECT_ERRS = new Set(['ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
  const downUntil = new Map();
  const warned = new Set();
  const ATTEMPTS = Number(process.env.PROXY_ATTEMPTS || 6);
  const pick = () => {
    const now = Date.now();
    const up = PROXY_URLS.filter(u => (downUntil.get(u) || 0) <= now);
    const pool = up.length ? up : PROXY_URLS;
    return pool[Math.floor(Math.random() * pool.length)];
  };
  console.log(`[*] Route: Cloudflare proxy (${PROXY_URLS.length})`);
  globalThis.fetch = async (input, init) => {
    const isReq = typeof input === 'object' && input !== null && 'url' in input;
    let url;
    try { url = new URL(isReq ? input.url : String(input)); } catch (_) { return realFetch(input, init); }
    if (url.hostname !== 'api.audius.co') return realFetch(input, init);
    const headers = new Headers((init && init.headers) || (isReq ? input.headers : undefined));
    if (PROXY_KEY) headers.set('x-proxy-key', PROXY_KEY);
    let lastErr;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const proxy = pick();
      const target = proxy + url.pathname + url.search;
      try {
        return isReq && !init
          ? await realFetch(new Request(target, input.clone()), { headers })
          : await realFetch(target, { ...init, headers });
      } catch (e) {
        const code = e && ((e.cause && e.cause.code) || e.code);
        if (!CONNECT_ERRS.has(code)) throw e;
        lastErr = e;
        downUntil.set(proxy, Date.now() + 20000);
        if (!warned.has(proxy)) { warned.add(proxy); console.log(`[!] Proxy ${new URL(proxy).host} unreachable; using another.`); }
        await new Promise(r => setTimeout(r, 300 * attempt));
      }
    }
    throw lastErr;
  };
}

let sdkPkg;
try {
  sdkPkg = require('@audius/sdk');
} catch (e) {
  console.error('[!] Failed to require @audius/sdk:', e.message);
  process.exit(1);
}
let sdkFactory;
if (typeof sdkPkg === 'function') sdkFactory = sdkPkg;
else if (typeof sdkPkg.sdk === 'function') sdkFactory = sdkPkg.sdk;
else if (typeof sdkPkg.default === 'function') sdkFactory = sdkPkg.default;
else if (sdkPkg.default && typeof sdkPkg.default.sdk === 'function') sdkFactory = sdkPkg.default.sdk;
else sdkFactory = Object.values(sdkPkg).find(v => typeof v === 'function' && v.name.toLowerCase().includes('sdk'));
if (!sdkFactory) {
  console.error('[!] Could not find SDK factory function in @audius/sdk exports.');
  process.exit(1);
}

const log = console.log.bind(console);
const VERBOSE = /^(1|true|yes)$/i.test(process.env.VERBOSE || '') || process.argv.includes('--verbose') || process.argv.includes('-v');
let lastBgLog = 0;
process.on('unhandledRejection', e => {
  if (Date.now() - lastBgLog < 30000) return;
  lastBgLog = Date.now();
  const c = e && e.cause && e.cause.code;
  log(`[!] Background network error${c ? ` (${c})` : ''}; continuing.`);
});
for (const level of ['log', 'info', 'debug', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[audius-sdk]')) return;
    orig(...args);
  };
}

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');
const STATE_FILE = path.join(ROOT_DIR, '.audius_follower_state.json');
const TARGET_ADDRESS = 'qringgreen@gmail.com';

const CFG = {
  timezone: process.env.RESET_TIMEZONE || 'America/Los_Angeles',
  resetHour: Number(process.env.RESET_HOUR ?? 12),
  dayTimezone: process.env.DAY_TIMEZONE || 'Africa/Lagos',
  accountsPerRun: 50,
  dailyPerHandle: Number(process.env.DAILY_FOLLOWERS_PER_HANDLE || 100),
  runsPerDay: 2,
  lockTtlMs: Number(process.env.LOCK_TTL_MINUTES || 120) * 60000,
  lockStaleMs: Number(process.env.LOCK_STALE_SECONDS || 120) * 1000,
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  verifyTries: 3,
  verifyDelayMs: Number(process.env.VERIFY_DELAY_MS || 500),
  failStopAfter: Number(process.env.FAIL_STOP_AFTER || 20),
  followDelayMs: Number(process.env.FOLLOW_DELAY_MS || 100),
  concurrency: Number(process.env.CONCURRENCY || 5),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_SECONDS || 20) * 1000,
  maxRunMs: Number(process.env.MAX_RUN_MINUTES || 0) * 60000,
  scanPages: Number(process.env.FOLLOWING_SCAN_PAGES || 10),
};

const HANDLE_RE = /^[A-Za-z0-9_.]{1,30}$/;

// Custom (follow= / target=) runs use run numbers in this range so they never
// collide with scheduled daily runs (1..CFG.runsPerDay).
const CUSTOM_RUN_START = 100;
const CUSTOM_RUN_END = 200;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const statusOf = e => e && ((e.response && e.response.status) || e.status);
const errMsg = e => `${statusOf(e) ? `HTTP ${statusOf(e)} ` : ''}${(e && e.message) || e}`;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// NEW: parse `target=N` — must be a positive integer.
function parseTarget(spec) {
  if (spec === null || spec === undefined || spec === '') return null;
  const n = Number(spec);
  if (!Number.isInteger(n) || n <= 0) {
    log(`[!] Ignoring invalid target=${spec} (must be a positive integer).`);
    return null;
  }
  return n;
}

function isRateLimit(e) {
  return statusOf(e) === 429 || /rate.?limit|too many requests|\b429\b/i.test(String((e && e.message) || e));
}

function isTransient(e) {
  const s = statusOf(e);
  if (s) return s === 408 || s >= 500;
  const msg = String((e && e.message) || e).toLowerCase();
  const code = String((e && (e.code || (e.cause && e.cause.code))) || '').toUpperCase();
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/.test(code) ||
    /fetch failed|network|timeout|timed out|socket hang up|temporar|bad gateway|service unavailable|gateway/.test(msg);
}

function classify(e) {
  if (isRateLimit(e)) return 'rate';
  const s = statusOf(e);
  return s && s >= 400 && s < 500 && s !== 408 ? 'permanent' : 'retry';
}

async function withRetry(fn, retryIf = isTransient, tries = CFG.retries) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (i === tries || !retryIf(e)) break;
      await sleep(CFG.retryBaseMs * 2 ** (i - 1));
    }
  }
  throw lastErr;
}
function withTimeout(promise, ms = CFG.callTimeoutMs, what = 'request') {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout: ${what} took longer than ${ms / 1000}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}
const readRetry = fn => withRetry(() => withTimeout(fn()), e => !isRateLimit(e) && isTransient(e));

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function buildContext(now) {
  let parts;
  let dayParts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    }).formatToParts(new Date(now.getTime() - CFG.resetHour * 3600000));
    dayParts = new Intl.DateTimeFormat('en-US', {
      timeZone: CFG.dayTimezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    }).formatToParts(now);
  } catch (e) {
    throw new Error(`Invalid timezone (RESET_TIMEZONE "${CFG.timezone}", DAY_TIMEZONE "${CFG.dayTimezone}"): ${e.message}`);
  }
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const d = {};
  for (const x of dayParts) d[x.type] = x.value;
  const weekDay = `${p.year}-${p.month}-${p.day}`;
  const dayIndex = ['Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].indexOf(p.weekday);
  return { today: `${d.year}-${d.month}-${d.day}`, dayName: d.weekday, dayIndex, weekStart: addDays(weekDay, -dayIndex), tz: CFG.timezone };
}

class LockLostError extends Error {}

function connectSupabase() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`db.txt not found at: ${DB_FILE}`);
  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
  return createClient(urlMatch[1], keyMatch[1]);
}

async function fetchRows(sb) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const data = await withRetry(async () => {
      const { data, error } = await sb.from('audius').select('address, handle, user_id, app_data, follower')
        .order('address', { ascending: true }).range(from, from + page - 1);
      if (error) {
        const e = new Error(/follower/i.test(error.message) && /column|exist|schema/i.test(error.message)
          ? 'audius.follower column is missing - run the SQL migration first.' : error.message);
        e.fatal = true;
        throw e;
      }
      return data || [];
    }, e => !e.fatal);
    out.push(...data);
    if (data.length < page) break;
  }
  if (!out.some(r => r.address === TARGET_ADDRESS)) throw new Error(`row not found in audius table: ${TARGET_ADDRESS}`);
  return out;
}

async function readUpTracks(sb) {
  const { data, error } = await sb.from('audius').select('up_tracks').eq('address', TARGET_ADDRESS).limit(1);
  if (error) throw new Error(`could not read up_tracks: ${error.message}`);
  return data && data[0] ? data[0].up_tracks : null;
}

// Only the LAST published batch counts: the newest date in up_tracks that has at least one
// successful upload. Earlier days are ignored completely, and the same accounts stay the
// targets until upload_track.js publishes a newer batch.
function latestHandles(upTracks) {
  const days = isObj(upTracks) && Array.isArray(upTracks.days) ? upTracks.days : [];
  const handleOf = d => (typeof d.handle === 'string' ? d.handle.trim().replace(/^@/, '') : '');
  const ok = days.filter(d => d && d.status === 'success' && typeof d.date === 'string' && HANDLE_RE.test(handleOf(d)));
  if (!ok.length) return [];
  const latest = ok.reduce((m, d) => (d.date > m ? d.date : m), ok[0].date);
  const seen = new Map();
  for (const d of ok) {
    if (d.date !== latest) continue;
    const h = handleOf(d);
    if (seen.has(h.toLowerCase())) continue;
    seen.set(h.toLowerCase(), { handle: h, address: d.address || null, date: latest });
  }
  return [...seen.values()];
}

// Parse a `follow=handle1,handle2,...` specification into published-shape entries.
function customHandles(spec, ctx) {
  const parsed = String(spec || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
  if (!parsed.length) return [];
  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const h of parsed) {
    if (!HANDLE_RE.test(h)) { invalid.push(h); continue; }
    const k = h.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    valid.push({ handle: h, address: null, date: ctx.today });
  }
  if (invalid.length) log(`[!] Ignoring invalid handle(s): ${invalid.join(', ')}`);
  return valid;
}

function sameWeek(raw, weekStart) {
  if (!isObj(raw)) return false;
  if (raw.week_start === weekStart) return true;
  if (!Array.isArray(raw.runs) || !raw.runs.length) return false;
  const end = addDays(weekStart, 8);
  return raw.runs.every(r => r.date >= weekStart && r.date < end);
}

function normalizeFollower(raw, weekStart) {
  if (sameWeek(raw, weekStart) && Array.isArray(raw.runs)) {
    const h = JSON.parse(JSON.stringify(raw));
    h.week_start = weekStart;
    return h;
  }
  const h = { week_start: weekStart, runs: [] };
  if (isObj(raw) && raw.lock) h.lock = raw.lock;
  return h;
}

function followedSet(raw, weekStart) {
  const s = new Set();
  if (sameWeek(raw, weekStart) && Array.isArray(raw.runs)) {
    for (const r of raw.runs) for (const t of (r.targets || [])) s.add(String(t.handle).toLowerCase());
  }
  return s;
}

let HELD_LOCK = null;

async function updateFollower(sb, address, weekStart, mutate) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const { data, error } = await sb.from('audius').select('address, follower').eq('address', address).limit(1);
      if (error) throw new Error(error.message);
      if (!data || !data[0]) throw Object.assign(new Error(`account row not found: ${address}`), { fatal: true });
      const raw = data[0].follower;
      const hist = normalizeFollower(raw, weekStart);
      if (address === TARGET_ADDRESS && HELD_LOCK && !(hist.lock && hist.lock.token === HELD_LOCK.token)) {
        throw new LockLostError('batch lock was taken over by another run');
      }
      if (mutate(hist) === false) return hist;
      const prevV = isObj(raw) && Number.isInteger(raw.v) ? raw.v : null;
      hist.v = (prevV || 0) + 1;
      let q = sb.from('audius').update({ follower: hist }).eq('address', address);
      q = prevV === null ? q.is('follower->>v', null) : q.eq('follower->>v', String(prevV));
      const res = await q.select('address, follower');
      if (res.error) throw new Error(res.error.message);
      if (res.data && res.data.length === 1) return normalizeFollower(res.data[0].follower, weekStart);
      lastErr = new Error(`update conflict for ${address}`);
      await sleep(100 + Math.random() * 300);
    } catch (e) {
      if (e instanceof LockLostError || e.fatal) throw e;
      lastErr = e;
      await sleep(CFG.retryBaseMs * Math.min(attempt, 3));
    }
  }
  throw lastErr;
}

async function recordFollow(sb, weekStart, address, f) {
  const key = f.handle.toLowerCase();
  const has = h => h.runs.some(r => (r.targets || []).some(t => String(t.handle).toLowerCase() === key));
  const stored = await updateFollower(sb, address, weekStart, h => {
    if (has(h)) return false;
    let run = h.runs.find(r => r.date === f.date && r.run_number === f.run_number);
    if (!run) { run = { date: f.date, day: f.day, run_number: f.run_number, targets: [] }; h.runs.push(run); }
    run.targets.push({ handle: f.handle, followed_at: f.at });
    return true;
  });
  if (!has(stored)) throw new Error(`database verification failed for ${address} -> ${f.handle}`);
}

let PENDING = [];
function loadPending() {
  try { const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); return Array.isArray(j.pending) ? j.pending : []; } catch (_) { return []; }
}
function savePending() {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ pending: PENDING }));
  fs.renameSync(tmp, STATE_FILE);
}
async function flushPending(sb, ctx) {
  if (!PENDING.length) return;
  const keep = [];
  for (const p of PENDING) {
    if (!(p.date >= ctx.weekStart && p.date < addDays(ctx.weekStart, 8))) continue;
    try { await recordFollow(sb, ctx.weekStart, p.address, p); } catch (_) { keep.push(p); }
  }
  log(`[*] Recovered ${PENDING.length - keep.length}/${PENDING.length} unsaved follows.`);
  PENDING = keep;
  savePending();
}

function lockStaleReason(lock) {
  if (!(Date.parse(lock.expires_at) > Date.now())) return 'it expired';
  const beat = Date.parse(lock.beat || lock.acquired_at);
  if (!Number.isFinite(beat) || Date.now() - beat > CFG.lockStaleMs) return 'its owner stopped responding (cancelled run)';
  if (lock.pid && lock.host === os.hostname()) {
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code !== 'EPERM') return 'its owner process is no longer running'; }
  }
  return null;
}

async function acquireLock(sb, ctx) {
  const token = crypto.randomUUID();
  let blocked = null;
  await updateFollower(sb, TARGET_ADDRESS, ctx.weekStart, h => {
    blocked = null;
    if (h.lock && h.lock.token) {
      const why = lockStaleReason(h.lock);
      if (!why) { blocked = h.lock; return false; }
      log('[*] Took over lock from a stopped run.');
    }
    h.lock = {
      token, acquired_at: new Date().toISOString(), beat: new Date().toISOString(),
      expires_at: new Date(Date.now() + CFG.lockTtlMs).toISOString(), pid: process.pid, host: os.hostname(),
    };
    return true;
  });
  if (blocked) { log('[!] Another run is active. Exiting.'); return null; }
  return { token };
}

let LOCK_LOST = null;

function startHeartbeat(sb, ctx) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || LOCK_LOST) return;
    busy = true;
    try {
      await updateFollower(sb, TARGET_ADDRESS, ctx.weekStart, h => {
        h.lock.beat = new Date().toISOString();
        h.lock.expires_at = new Date(Date.now() + CFG.lockTtlMs).toISOString();
        return true;
      });
    } catch (e) { if (e instanceof LockLostError) LOCK_LOST = e; } finally { busy = false; }
  }, Math.max(5000, CFG.lockStaleMs / 4));
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseLock(sb, ctx, lock) {
  if (!lock) return;
  try {
    await updateFollower(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.lock || h.lock.token !== lock.token) return false;
      delete h.lock;
      return true;
    });
  } catch (e) {
    console.error(`[!] Could not release lock (it expires on its own): ${e.message}`);
  }
}

const hasCreds = r => !!(r.user_id && r.app_data && r.app_data.api_key && r.app_data.api_secret && r.app_data.bearer_token);

function makeSdk(acct) {
  return sdkFactory({
    apiKey: acct.app_data.api_key,
    apiSecret: acct.app_data.api_secret,
    bearerToken: acct.app_data.bearer_token,
  });
}

async function resolveTargets(published, sdk) {
  const targets = [];
  let unresolved = 0;
  for (const t of published) {
    try {
      const res = await readRetry(() => sdk.users.getUserByHandle({ handle: t.handle }));
      const id = res && res.data && res.data.id;
      if (id) targets.push({ ...t, id: String(id), key: t.handle.toLowerCase() });
      else log(`[!] @${t.handle} not found; skipped.`);
    } catch (e) {
      if (classify(e) === 'permanent') log(`[!] @${t.handle} not found; skipped.`);
      else { unresolved++; log(`[!] @${t.handle} lookup failed (${errMsg(e)}); retry next run.`); }
    }
  }
  return { targets, unresolved };
}

async function isFollowing(sdk, followerId, targetId) {
  const res = await readRetry(() => sdk.users.getUser({ id: targetId, userId: followerId }));
  const d = res && res.data;
  const flag = d && (d.doesCurrentUserFollow !== undefined ? d.doesCurrentUserFollow : d.does_current_user_follow);
  if (typeof flag === 'boolean') return flag;
  for (let page = 0; page < CFG.scanPages; page++) {
    const r = await readRetry(() => sdk.users.getFollowing({ id: followerId, limit: 100, offset: page * 100 }));
    const list = (r && r.data) || [];
    if (list.some(u => String(u.id) === String(targetId))) return true;
    if (list.length < 100) break;
  }
  return false;
}

async function verifyFollow(sdk, followerId, targetId) {
  for (let i = 1; i <= CFG.verifyTries; i++) {
    await sleep(CFG.verifyDelayMs * i);
    if (await isFollowing(sdk, followerId, targetId)) return true;
  }
  return false;
}

// MODIFIED: cap is now a parameter (defaults to CFG.dailyPerHandle).
function handlesBelowCap(rows, published, ctx, cap = CFG.dailyPerHandle) {
  const today = countHandles(rows, ctx);
  return published.filter(p => (today.get(p.handle.toLowerCase()) || 0) < cap);
}

// MODIFIED: cap is now a parameter.
function allDoneMsg(n, cap = CFG.dailyPerHandle) {
  return `[*] All ${n} handles reached ${cap} followers today. Exiting.`;
}

function dayState(coord, today, custom = false) {
  const start = custom ? CUSTOM_RUN_START : 1;
  const end = custom ? CUSTOM_RUN_END : CFG.runsPerDay + 1;
  for (let n = start; n < end; n++) {
    const b = (coord.batches || []).find(x => x.date === today && x.run_number === n);
    if (!b || !b.done) return { runNumber: n, batch: b || null };
  }
  return null;
}

const FOLLOW_STYLES = [
  (f, t) => ({ id: t, userId: f, followeeUserId: t }),
  (f, t) => ({ id: f, userId: f, followeeUserId: t }),
];

function reason(e) {
  if (isRateLimit(e)) return '429';
  const code = statusOf(e);
  if (code) return `HTTP ${code}`;
  const m = String((e && e.message) || e);
  if (/timeout|timed out/i.test(m)) return 'timeout';
  return m.slice(0, 50);
}

async function followJob(sb, ctx, run, acct, target) {
  const st = run.stats;
  const who = acct.handle ? `@${acct.handle}` : acct.address;
  const say = text => { if (VERBOSE) log(`[*] ${who} -> @${target.handle} | ${text}`); };
  let verified = false;
  let already = false;
  let outcome;
  try {
    let sdk = run.sdks.get(acct.address);
    if (!sdk) { sdk = makeSdk(acct); run.sdks.set(acct.address, sdk); }

    already = await isFollowing(sdk, acct.user_id, target.id);
    if (!already) {
      let lastErr = null;
      for (const i of run.style === null ? [0, 1] : [run.style]) {
        lastErr = null;
        try { await withTimeout(sdk.users.followUser(FOLLOW_STYLES[i](acct.user_id, target.id)), CFG.callTimeoutMs, 'followUser'); } catch (e) {
          if (isRateLimit(e)) throw e;
          lastErr = e;
          if (!statusOf(e) && /required parameter|invalid/i.test(String(e.message))) continue;
        }
        if (await verifyFollow(sdk, acct.user_id, target.id)) {
          if (run.style === null) run.style = i;
          lastErr = null;
          verified = true;
          break;
        }
      }
      if (!verified) throw lastErr || new Error('follow could not be verified');
    }
    verified = true;
    run.consecFail = 0;
    outcome = already ? 'already' : 'ok';
    already ? st.already++ : st.ok++;
  } catch (e) {
    const kind = classify(e);
    if (kind === 'rate') { outcome = 'rate'; st.rate++; say('429'); }
    else if (kind === 'permanent') { outcome = 'perm'; st.perm++; run.cool.add(acct.address); say(reason(e)); }
    else { outcome = 'retry'; st.retry++; say(reason(e)); }
    if (++run.consecFail >= CFG.failStopAfter && !run.stop) {
      run.stop = true;
      log('[!] Too many failures in a row; stopping. Next run resumes.');
    }
  }
  if (verified) {
    const item = {
      address: acct.address, handle: target.handle, date: ctx.today, day: ctx.dayName, run_number: run.number,
      week_start: ctx.weekStart, at: new Date().toISOString(),
    };
    let saved = true;
    try { await recordFollow(sb, ctx.weekStart, acct.address, item); } catch (e) {
      saved = false;
      PENDING.push(item); savePending();
      if (e instanceof LockLostError) run.abort = e;
    }
    acct.followed.add(target.key);
    acct.today++;
    if (!saved) log(`[!] ${who} -> @${target.handle} | followed, DB save failed (kept locally)`);
    else say(already ? 'already following' : 'successful');
  }
  if (CFG.followDelayMs) await sleep(CFG.followDelayMs);
  return outcome;
}

async function fillHandle(sb, ctx, run, target, need, candidates) {
  let got = 0;
  let inflight = 0;
  let transient = 0;
  let skipped = 0;
  const step = async () => {
    if (run.abort || LOCK_LOST || run.stop) return false;
    if (CFG.maxRunMs && Date.now() - run.startedAt > CFG.maxRunMs) {
      run.stop = true;
      log('[!] Time limit reached; stopping. Next run resumes.');
      return false;
    }
    if (got >= need) return false;
    if (got + inflight >= need) {
      if (!inflight) return false;
      await sleep(50);
      return true;
    }
    const acct = candidates.shift();
    if (!acct) return false;
    inflight++;
    const outcome = await followJob(sb, ctx, run, acct, target);
    inflight--;
    if (outcome === 'ok' || outcome === 'already') got++;
    else skipped++;
    if (outcome === 'rate' || outcome === 'retry') transient++;
    return true;
  };
  for (let n = 0; n < 3 && run.style === null; n++) if (!(await step())) break;
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, async () => { while (await step()); }));
  return { got, transient, skipped };
}

function countToday(raw, ctx) {
  let n = 0;
  if (sameWeek(raw, ctx.weekStart) && Array.isArray(raw.runs)) {
    for (const r of raw.runs) if (r.date === ctx.today) n += (r.targets || []).length;
  }
  return n;
}

function countHandles(rows, ctx, runNumber) {
  const counts = new Map();
  for (const r of rows) {
    const f = r.follower;
    if (!isObj(f) || !sameWeek(f, ctx.weekStart) || !Array.isArray(f.runs)) continue;
    for (const x of f.runs) {
      if (x.date !== ctx.today || (runNumber !== undefined && x.run_number !== runNumber)) continue;
      for (const t of x.targets || []) {
        const k = String(t.handle).toLowerCase();
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  return counts;
}

// MODIFIED: accepts dailyCap and perRunCap (driven by target=).
async function processRun(sb, ctx, rows, published, { runNumber, batch, isCustom = false, dailyCap = CFG.dailyPerHandle, perRunCap = CFG.accountsPerRun }) {
  const isCustomRun = isCustom || runNumber >= CUSTOM_RUN_START;
  const runLabel = isCustomRun ? `Custom run ${runNumber}` : `Run ${runNumber}`;

  const accounts = rows.map(r => ({
    address: r.address, handle: typeof r.handle === 'string' ? r.handle.trim().replace(/^@/, '') : null,
    user_id: r.user_id, app_data: r.app_data, hasCreds: hasCreds(r), followed: followedSet(r.follower, ctx.weekStart),
    today: countToday(r.follower, ctx),
  }));
  const reader = accounts.find(a => a.hasCreds);
  if (!reader) throw new Error('no account with complete credentials');

  const { targets, unresolved } = await resolveTargets(published, makeSdk(reader));
  if (!targets.length) { log('[!] No handles found on Audius. Exiting.'); return { status: 'NO_TARGETS' }; }

  const todayDone = countHandles(rows, ctx);
  const runDone = countHandles(rows, ctx, runNumber);
  const lastRun = !isCustomRun && runNumber >= CFG.runsPerDay;
  const need = new Map(targets.map(t => {
    const left = Math.max(0, dailyCap - (todayDone.get(t.key) || 0));
    const perRun = lastRun ? left : Math.min(left, Math.max(0, perRunCap - (runDone.get(t.key) || 0)));
    return [t.key, perRun];
  }));
  let totalNeed = 0;
  let active = 0;
  for (const n of need.values()) { totalNeed += n; if (n) active++; }
  if (!totalNeed && !unresolved) {
    log(allDoneMsg(targets.length, dailyCap));
    return { status: 'ALREADY_COMPLETED' };
  }
  const atCap = targets.filter(t => (todayDone.get(t.key) || 0) >= dailyCap).length;
  log(`[*] ${runLabel}${batch ? ' (resumed)' : ''}: ${active} handles to do${atCap ? ` (${atCap} already at ${dailyCap})` : ''}, ${totalNeed} follows.`);

  if (!batch) {
    await updateFollower(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.batches) h.batches = [];
      if (h.batches.some(b => b.date === ctx.today && b.run_number === runNumber)) return false;
      h.batches.push({ date: ctx.today, run_number: runNumber, done: false });
      return true;
    });
  }

  const run = { startedAt: Date.now(), number: runNumber, cool: new Set(), abort: null, stop: false, style: null, consecFail: 0, sdks: new Map(), stats: { ok: 0, already: 0, rate: 0, retry: 0, perm: 0 } };
  const st = run.stats;
  let incomplete = false;

  for (const t of targets) {
    const want = need.get(t.key);
    if (!want) continue;
    if (run.stop) { incomplete = true; continue; }
    const pool = accounts.filter(a => a.hasCreds && String(a.user_id) !== String(t.id) && !(a.handle && a.handle.toLowerCase() === t.key) && !a.followed.has(t.key) && !run.cool.has(a.address));
    const candidates = shuffle(pool).sort((x, y) => x.today - y.today);
    const { got, transient, skipped } = await fillHandle(sb, ctx, run, t, want, candidates);
    if (run.abort || LOCK_LOST) throw run.abort || LOCK_LOST;
    const day = (todayDone.get(t.key) || 0) + got;
    if (got < want) {
      if (transient || run.stop) incomplete = true;
      log(`[!] @${t.handle} | ${day}/${dailyCap} today${transient || run.stop ? '' : ' (no more accounts available)'}`);
    } else {
      log(`[*] @${t.handle} | ${day}/${dailyCap} today${day >= dailyCap ? ' (done)' : ''}${skipped ? ` (${skipped} skipped)` : ''}`);
    }
  }

  const left = incomplete || unresolved > 0;
  if (!left) {
    await updateFollower(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      const b = (h.batches || []).find(x => x.date === ctx.today && x.run_number === runNumber);
      if (!b || b.done) return false;
      b.done = true;
      return true;
    });
  }
  const parts = [`${st.ok} followed`];
  if (st.already) parts.push(`${st.already} already following`);
  if (st.rate) parts.push(`${st.rate} rate-limited`);
  if (st.retry) parts.push(`${st.retry} errors`);
  if (st.perm) parts.push(`${st.perm} failed`);
  if (unresolved) parts.push(`${unresolved} handle(s) unresolved`);
  log(`[*] ${runLabel} ${left ? 'incomplete' : 'complete'}: ${parts.join(', ')}.${left ? ' Next run resumes.' : ''}`);
  return { status: left ? 'INCOMPLETE' : 'COMPLETED' };
}

// MODIFIED: accepts `{ follow, target }`. `follow` selects custom handles; `target` overrides
// the per-handle daily cap AND the per-run cap.
async function runFollower({ now = new Date(), follow = null, target = null } = {}) {
  const ctx = buildContext(now);
  const sb = connectSupabase();
  PENDING = loadPending();

  const dailyCap = target || CFG.dailyPerHandle;
  const perRunCap = target || CFG.accountsPerRun;
  const isCustom = !!(follow || target);

  if (target) {
    log(`[*] Custom target: up to ${target} follows per handle (per-run cap ${perRunCap}, daily cap ${dailyCap}).`);
  }

  let published;
  if (follow) {
    published = customHandles(follow, ctx);
    if (!published.length) {
      log('[!] No valid handles provided for follow=. Exiting.');
      return { status: 'NO_TARGETS' };
    }
    log(`[*] Custom follow target(s): ${published.map(t => '@' + t.handle).join(', ')}`);
  } else {
    published = latestHandles(await readUpTracks(sb));
    if (!published.length) {
      log('[!] No successfully published handles found in up_tracks. Exiting.');
      return { status: 'NO_TARGETS' };
    }
    log(`[*] Targeting the last published batch (${published[0].date}): ${published.length} handle(s).`);
  }

  let rows = await fetchRows(sb);
  const coordRaw = rows.find(r => r.address === TARGET_ADDRESS).follower;
  if (isObj(coordRaw) && coordRaw.week_start && !sameWeek(coordRaw, ctx.weekStart)) {
    log('[*] New week: history reset.');
  }
  if (!handlesBelowCap(rows, published, ctx, dailyCap).length) {
    log(allDoneMsg(published.length, dailyCap));
    return { status: 'ALREADY_COMPLETED' };
  }
  if (!dayState(normalizeFollower(coordRaw, ctx.weekStart), ctx.today, isCustom)) {
    log(isCustom ? '[*] No custom follow slots left today. Exiting.' : '[*] Both runs already done today. Exiting.');
    return { status: 'ALREADY_COMPLETED' };
  }

  const lock = await acquireLock(sb, ctx);
  if (!lock) return { status: 'LOCKED' };
  HELD_LOCK = lock;
  LOCK_LOST = null;
  const stopHeartbeat = startHeartbeat(sb, ctx);

  try {
    await flushPending(sb, ctx);
    rows = await fetchRows(sb);
    const coord = normalizeFollower(rows.find(r => r.address === TARGET_ADDRESS).follower, ctx.weekStart);
    if (!handlesBelowCap(rows, published, ctx, dailyCap).length) {
      log(allDoneMsg(published.length, dailyCap));
      return { status: 'ALREADY_COMPLETED' };
    }
    const state = dayState(coord, ctx.today, isCustom);
    if (!state) {
      log(isCustom ? '[*] No custom follow slots left today. Exiting.' : '[*] Both runs already done today. Exiting.');
      return { status: 'ALREADY_COMPLETED' };
    }
    return await processRun(sb, ctx, rows, published, { ...state, isCustom, dailyCap, perRunCap });
  } finally {
    stopHeartbeat();
    HELD_LOCK = null;
    await releaseLock(sb, ctx, lock);
  }
}

const BOOST = {
  targetFollowers: Number(process.env.BOOST_TARGET_FOLLOWERS || 50),
  maxFollowers: Number(process.env.BOOST_MAX_FOLLOWERS || 300),
  step: Number(process.env.BOOST_STEP || 50),
  batchSize: Number(process.env.BOOST_BATCH_SIZE || 10),
  waitMs: Number(process.env.BOOST_WAIT_MINUTES || 2) * 60000,
  countBatch: 50,
};

function boostTiers() {
  const tiers = [];
  const step = Math.max(1, BOOST.step);
  for (let t = BOOST.targetFollowers; t < BOOST.maxFollowers; t += step) tiers.push(t);
  tiers.push(Math.max(BOOST.maxFollowers, BOOST.targetFollowers));
  return tiers;
}

async function fetchBoostAccounts(sb) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const data = await withRetry(async () => {
      const { data, error } = await sb.from('audius').select('address, handle, user_id, app_data')
        .order('address', { ascending: true }).range(from, from + page - 1);
      if (error) throw new Error(error.message);
      return data || [];
    });
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function loadFollowerCounts(sdk, ids) {
  const counts = new Map();
  for (let i = 0; i < ids.length; i += BOOST.countBatch) {
    const chunk = ids.slice(i, i + BOOST.countBatch);
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const res = await readRetry(() => sdk.users.getBulkUsers({ id: chunk }));
        for (const u of (res && res.data) || []) {
          const n = u.followerCount !== undefined ? u.followerCount : u.follower_count;
          if (Number.isFinite(Number(n))) counts.set(String(u.id), Number(n));
        }
        break;
      } catch (e) {
        if (!isRateLimit(e) || attempt === 3) break;
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  return counts;
}

async function loadFollowerIds(sdk, targetId, max) {
  const ids = new Set();
  for (let offset = 0; offset < max; offset += 100) {
    const res = await readRetry(() => sdk.users.getFollowers({ id: targetId, limit: 100, offset }));
    const list = (res && res.data) || [];
    for (const u of list) ids.add(String(u.id));
    if (list.length < 100) break;
  }
  return ids;
}

async function boostJob(state, acct, target, precheck) {
  const st = state.stats;
  const who = acct.handle ? `@${acct.handle}` : acct.address;
  const say = text => { if (VERBOSE) log(`[*] ${who} -> @${target.handle} | ${text}`); };
  let outcome;
  try {
    let sdk = state.sdks.get(acct.address);
    if (!sdk) { sdk = makeSdk(acct); state.sdks.set(acct.address, sdk); }

    if (precheck && await isFollowing(sdk, acct.user_id, target.id)) {
      say('already following');
      return 'already';
    }
    let verified = false;
    let lastErr = null;
    for (const i of state.style === null ? [0, 1] : [state.style]) {
      lastErr = null;
      try { await withTimeout(sdk.users.followUser(FOLLOW_STYLES[i](acct.user_id, target.id)), CFG.callTimeoutMs, 'followUser'); } catch (e) {
        if (isRateLimit(e)) throw e;
        lastErr = e;
        if (!statusOf(e) && /required parameter|invalid/i.test(String(e.message))) continue;
      }
      if (await verifyFollow(sdk, acct.user_id, target.id)) {
        if (state.style === null) state.style = i;
        lastErr = null;
        verified = true;
        break;
      }
    }
    if (!verified) throw lastErr || new Error('follow could not be verified');
    state.consecFail = 0;
    st.ok++;
    outcome = 'ok';
    say('successful');
  } catch (e) {
    const kind = classify(e);
    if (kind === 'rate') { outcome = 'rate'; st.rate++; say('429'); }
    else if (kind === 'permanent') { outcome = 'perm'; st.perm++; state.cool.add(acct.address); say(reason(e)); }
    else { outcome = 'retry'; st.retry++; say(reason(e)); }
    if (++state.consecFail >= CFG.failStopAfter && !state.stop) {
      state.stop = true;
      log('[!] Too many failures in a row; ending this batch early.');
    }
  }
  if (CFG.followDelayMs) await sleep(CFG.followDelayMs);
  return outcome;
}

async function boostTarget(state, target, attempts, candidates, precheck) {
  let got = 0;
  let started = 0;
  const step = async () => {
    if (state.stop) return false;
    if (started >= attempts) return false;
    const acct = candidates.shift();
    if (!acct) return false;
    started++;
    const outcome = await boostJob(state, acct, target, precheck);
    if (outcome === 'ok') got++;
    if (outcome === 'already') started--;
    return true;
  };
  for (let n = 0; n < 3 && state.style === null; n++) if (!(await step())) break;
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, async () => { while (await step()); }));
  return { got, started };
}

async function boostBatch(state, sb, batchNo) {
  const accounts = await fetchBoostAccounts(sb);
  const withCreds = accounts.filter(hasCreds);
  if (!withCreds.length) {
    log('[!] No account with complete credentials.');
    return;
  }
  const reader = shuffle(withCreds)[0];
  const sdk = makeSdk(reader);
  const counts = await loadFollowerCounts(sdk, accounts.filter(a => a.user_id).map(a => String(a.user_id)));
  const tiers = boostTiers();
  let goal = 0;
  let low = [];
  for (const tier of tiers) {
    low = accounts.filter(a => a.user_id && counts.has(String(a.user_id)) && counts.get(String(a.user_id)) < tier &&
      !(Date.now() - (state.exhausted.get(`${a.address}:${tier}`) || 0) < 3600000));
    if (low.length) { goal = tier; break; }
  }
  if (!low.length) {
    if (!state.idle) log(`[*] No accounts left to boost; checking again every ${Math.round(BOOST.waitMs / 60000)} min.`);
    state.idle = true;
    return;
  }
  state.idle = false;
  if (state.goal && state.goal !== goal) log(`[*] Goal is now ${goal} followers per account.`);
  state.goal = goal;
  const targets = shuffle(low)
    .sort((x, y) => (state.targeted.get(x.address) || 0) - (state.targeted.get(y.address) || 0))
    .slice(0, BOOST.batchSize);
  log(`[*] Batch ${batchNo}: ${targets.length} of ${low.length} accounts under ${goal} followers.`);

  state.stats = { ok: 0, rate: 0, retry: 0, perm: 0 };
  state.stop = false;
  state.consecFail = 0;
  let total = 0;
  for (const acct of targets) {
    if (state.stop) break;
    const id = String(acct.user_id);
    const have = counts.get(id);
    const need = goal - have;
    let existing = null;
    try { existing = await loadFollowerIds(sdk, id, Math.max(200, have + 100)); } catch (_) { existing = null; }
    const pool = withCreds.filter(a => String(a.user_id) !== id && !state.cool.has(a.address) && !(existing && existing.has(String(a.user_id))));
    const target = { id, handle: acct.handle || acct.address };
    if (!pool.length) {
      state.exhausted.set(`${acct.address}:${goal}`, Date.now());
      log(`[*] @${target.handle} | no accounts left to follow it (had ${have})`);
      continue;
    }
    const { got } = await boostTarget(state, target, need, shuffle(pool), !existing);
    state.targeted.set(acct.address, (state.targeted.get(acct.address) || 0) + 1);
    total += got;
    log(`[*] @${target.handle} | ${got}/${need} followed (had ${have})`);
  }
  const st = state.stats;
  const parts = [`${total} followed`];
  if (st.rate) parts.push(`${st.rate} rate-limited`);
  if (st.retry) parts.push(`${st.retry} errors`);
  if (st.perm) parts.push(`${st.perm} failed`);
  log(`[*] Batch ${batchNo} complete: ${parts.join(', ')}.`);
}

async function runBoost() {
  const sb = connectSupabase();
  const state = { style: null, sdks: new Map(), cool: new Set(), targeted: new Map(), stats: { ok: 0, rate: 0, retry: 0, perm: 0 }, stop: false, consecFail: 0, idle: false, goal: 0, exhausted: new Map() };
  for (let batchNo = 1; ; batchNo++) {
    try {
      await boostBatch(state, sb, batchNo);
    } catch (e) {
      log(`[!] Batch ${batchNo} failed: ${errMsg(e).slice(0, 80)}`);
    }
    await sleep(BOOST.waitMs);
  }
}

async function runList() {
  const sb = connectSupabase();
  const accounts = await fetchBoostAccounts(sb);
  const reader = shuffle(accounts.filter(hasCreds))[0];
  if (!reader) throw new Error('no account with complete credentials');
  const sdk = makeSdk(reader);
  const counts = await loadFollowerCounts(sdk, accounts.filter(a => a.user_id).map(a => String(a.user_id)));
  const rows = accounts.map(a => ({
    name: a.handle ? `@${String(a.handle).replace(/^@/, '')}` : a.address,
    count: a.user_id && counts.has(String(a.user_id)) ? counts.get(String(a.user_id)) : null,
  })).sort((x, y) => (x.count === null) - (y.count === null) || x.count - y.count || x.name.localeCompare(y.name));
  for (const r of rows) log(`[*] ${r.name} | ${r.count === null ? 'n/a' : r.count}`);
  const known = rows.filter(r => r.count !== null);
  const tiers = boostTiers();
  const bands = [{ label: `under ${tiers[0]}`, n: known.filter(r => r.count < tiers[0]).length }];
  tiers.forEach((t, i) => {
    const next = tiers[i + 1];
    bands.push(next === undefined
      ? { label: `${t}+`, n: known.filter(r => r.count >= t).length }
      : { label: `${t}-${next - 1}`, n: known.filter(r => r.count >= t && r.count < next).length });
  });
  const total = known.reduce((n, r) => n + r.count, 0);
  log(`[*] ${rows.length} accounts | ${bands.map(b => `${b.label}: ${b.n}`).join(' | ')}${rows.length > known.length ? ` | n/a: ${rows.length - known.length}` : ''} | ${total} followers in total`);
}

const MODE_ARG = process.argv.slice(2).find(a => /^id=/.test(a));

if (require.main === module) {
  const followArg = process.argv.slice(2).find(a => /^follow=/.test(a));
  const targetArg = process.argv.slice(2).find(a => /^target=/.test(a));
  const follow = followArg ? followArg.slice('follow='.length) : null;
  const target = targetArg ? parseTarget(targetArg.slice('target='.length)) : null;

  let task;
  if (!MODE_ARG) {
    task = runFollower({ follow, target });
  } else if (MODE_ARG === 'id=2') {
    if (follow || target) console.error('[!] follow= and target= are only supported in default mode (no id=). Ignoring for id=2.');
    task = runBoost();
  } else if (MODE_ARG === 'id=3') {
    if (follow || target) console.error('[!] follow= and target= are only supported in default mode (no id=). Ignoring for id=3.');
    task = runList().then(() => process.exit(0));
  } else {
    console.error(`[!] Unknown mode "${MODE_ARG}". Use no argument, id=2 or id=3.`);
    process.exit(1);
  }
  task.catch(err => {
    console.error('[!] Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { runFollower, runBoost, runList, latestHandles, buildContext, customHandles, parseTarget, CFG };
