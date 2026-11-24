#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROXY_URLS = (process.env.AUDIUS_PROXY_URLS || 'https://audius.qring99.workers.dev,https://audius.qringgreen.workers.dev')
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
  if (!global.__AUDIUS_PROXY_LOGGED) {
    console.log(`[*] Route: Cloudflare proxy (${PROXY_URLS.length})`);
    global.__AUDIUS_PROXY_LOGGED = true;
  }
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
const STATE_FILE = path.join(ROOT_DIR, '.audius_comment_state.json');
const TARGET_ADDRESS = 'qringgreen@gmail.com';

// Custom (tastemaker-triggered) runs use run numbers in this range so they never collide
// with scheduled daily runs (1..CFG.runsPerDay).
const CUSTOM_RUN_START = 100;
const CUSTOM_RUN_END = 200;

const HANDLE_RE = /^[A-Za-z0-9_.]{1,30}$/;

const CFG = {
  timezone: process.env.RESET_TIMEZONE || 'America/Los_Angeles',
  resetHour: Number(process.env.RESET_HOUR ?? 12),
  dayTimezone: process.env.DAY_TIMEZONE || 'Africa/Lagos',
  dailyPerTrack: Number(process.env.DAILY_COMMENTS_PER_TRACK || 50),
  runsPerDay: 2,
  lockTtlMs: Number(process.env.LOCK_TTL_MINUTES || 120) * 60000,
  lockStaleMs: Number(process.env.LOCK_STALE_SECONDS || 120) * 1000,
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  verifyTries: 3,
  verifyDelayMs: Number(process.env.VERIFY_DELAY_MS || 500),
  failStopAfter: Number(process.env.FAIL_STOP_AFTER || 20),
  minFollowers: Number(process.env.MIN_COMMENTER_FOLLOWERS || 50),
  followerBatch: Number(process.env.FOLLOWER_CHECK_BATCH || 50),
  emojiShare: process.env.COMMENT_EMOJI_SHARE === undefined ? 0.3 : Number(process.env.COMMENT_EMOJI_SHARE),
  scanPages: Number(process.env.COMMENT_SCAN_PAGES || 5),
  commentDelayMs: Number(process.env.COMMENT_DELAY_MS || 100),
  concurrency: Number(process.env.CONCURRENCY || 5),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_SECONDS || 20) * 1000,
  maxRunMs: Number(process.env.MAX_RUN_MINUTES || 0) * 60000,
};

const attemptsPerRun = (cap, custom) => custom ? cap : Math.ceil(cap / CFG.runsPerDay);

const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

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
      const { data, error } = await sb.from('audius').select('address, handle, user_id, app_data, comment')
        .order('address', { ascending: true }).range(from, from + page - 1);
      if (error) {
        const e = new Error(/comment/i.test(error.message) && /column|exist|schema/i.test(error.message)
          ? 'audius.comment column is missing - run the SQL migration first.' : error.message);
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

// Only the LAST published batch counts.
function collectTracks(upTracks) {
  const days = isObj(upTracks) && Array.isArray(upTracks.days) ? upTracks.days : [];
  const ok = days.filter(d => d && d.status === 'success' && d.track_id != null && typeof d.date === 'string' &&
    TRACK_ID_RE.test(String(d.track_id).trim()));
  if (!ok.length) return [];
  const latest = ok.reduce((m, d) => (d.date > m ? d.date : m), ok[0].date);
  const seen = new Map();
  for (const d of ok) {
    if (d.date !== latest) continue;
    const id = String(d.track_id).trim();
    if (seen.has(id)) continue;
    seen.set(id, {
      id, key: id, address: d.address || null, handle: typeof d.handle === 'string' ? d.handle : null,
      title: typeof d.published_title === 'string' && d.published_title.trim() ? d.published_title.trim().slice(0, 80) : null,
      date: latest, cap: CFG.dailyPerTrack,
    });
  }
  return [...seen.values()];
}

// ============ NEW: user lookup / track fetching for handle= mode ============
async function audiusGet(pathname, what, timeoutMs = CFG.callTimeoutMs) {
  const url = `https://api.audius.co${pathname}`;
  let lastErr;
  for (let i = 1; i <= CFG.retries; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        if (res.status === 429 || res.status >= 500) {
          lastErr = Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
          await sleep(3000 * i);
          continue;
        }
        throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
      }
      const data = await res.json();
      return (data && data.data) || [];
    } catch (e) {
      lastErr = e;
      const isAbort = controller.signal.aborted || /abort/i.test(String(e.message || ''));
      if (isAbort) lastErr = new Error(`timeout after ${timeoutMs / 1000}s`);
      if (i < CFG.retries) await sleep(1000 * i);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error(`${what} failed`);
}

async function fetchUserByHandle(handle) {
  const data = await audiusGet(`/v1/users/handle/${encodeURIComponent(handle)}?app_name=comment`, 'user lookup', CFG.callTimeoutMs);
  const user = Array.isArray(data) ? data[0] : data;
  if (!user || !user.id) throw new Error(`user not found: @${handle}`);
  return user;
}

async function fetchUserTracks(userId) {
  const out = [];
  const seen = new Set();
  const page = 100;
  for (let offset = 0; offset < 1000; offset += page) {
    const data = await audiusGet(`/v1/users/${encodeURIComponent(userId)}/tracks?limit=${page}&offset=${offset}&sort=date&app_name=comment`, 'user tracks', CFG.callTimeoutMs);
    const list = Array.isArray(data) ? data : [];
    for (const t of list) {
      const id = String(t.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, title: t.title || '', created_at: t.created_at || t.release_date || null });
    }
    if (list.length < page) break;
  }
  return out;
}

// ============ STATE ============
function sameWeek(raw, weekStart) {
  if (!isObj(raw)) return false;
  if (raw.week_start === weekStart) return true;
  if (!Array.isArray(raw.runs) || !raw.runs.length) return false;
  const end = addDays(weekStart, 8);
  return raw.runs.every(r => r.date >= weekStart && r.date < end);
}

function normalizeComment(raw, weekStart) {
  if (sameWeek(raw, weekStart) && Array.isArray(raw.runs)) {
    const h = JSON.parse(JSON.stringify(raw));
    h.week_start = weekStart;
    return h;
  }
  const h = { week_start: weekStart, runs: [] };
  if (isObj(raw) && raw.lock) h.lock = raw.lock;
  return h;
}

function commentedSet(raw, weekStart) {
  const s = new Set();
  if (sameWeek(raw, weekStart) && Array.isArray(raw.runs)) {
    for (const r of raw.runs) for (const t of (r.tracks || [])) if (t.status === 'success') s.add(String(t.track_id));
  }
  return s;
}

let HELD_LOCK = null;

async function updateComment(sb, address, weekStart, mutate) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const { data, error } = await sb.from('audius').select('address, comment').eq('address', address).limit(1);
      if (error) throw new Error(error.message);
      if (!data || !data[0]) throw Object.assign(new Error(`account row not found: ${address}`), { fatal: true });
      const raw = data[0].comment;
      const hist = normalizeComment(raw, weekStart);
      if (address === TARGET_ADDRESS && HELD_LOCK && !(hist.lock && hist.lock.token === HELD_LOCK.token)) {
        throw new LockLostError('batch lock was taken over by another run');
      }
      if (mutate(hist) === false) return hist;
      const prevV = isObj(raw) && Number.isInteger(raw.v) ? raw.v : null;
      hist.v = (prevV || 0) + 1;
      let q = sb.from('audius').update({ comment: hist }).eq('address', address);
      q = prevV === null ? q.is('comment->>v', null) : q.eq('comment->>v', String(prevV));
      const res = await q.select('address, comment');
      if (res.error) throw new Error(res.error.message);
      if (res.data && res.data.length === 1) return normalizeComment(res.data[0].comment, weekStart);
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

async function recordComment(sb, weekStart, address, f) {
  const key = String(f.track_id);
  const has = h => h.runs.some(r => (r.tracks || []).some(t => String(t.track_id) === key && t.status === 'success'));
  const stored = await updateComment(sb, address, weekStart, h => {
    if (has(h)) return false;
    let run = h.runs.find(r => r.date === f.date && r.run_number === f.run_number);
    if (!run) { run = { date: f.date, day: f.day, run_number: f.run_number, tracks: [] }; h.runs.push(run); }
    run.tracks.push({ track_id: key, status: 'success', commented_at: f.at, ...(f.comment_id ? { comment_id: String(f.comment_id) } : {}) });
    return true;
  });
  if (!has(stored)) throw new Error(`database verification failed for ${address} -> ${key}`);
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
    try { await recordComment(sb, ctx.weekStart, p.address, p); } catch (_) { keep.push(p); }
  }
  log(`[*] Recovered ${PENDING.length - keep.length}/${PENDING.length} unsaved comments.`);
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
  await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
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
      await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
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
    await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
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

const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const an = w => (/^[aeiou]/i.test(w) ? 'an ' : 'a ') + w;

const EMOJI = {
  hearts: ['❤️', '🖤', '💜', '💙', '💚', '💛', '🧡', '🤍', '💖', '💗', '💓', '💞', '💘', '💝', '🩷', '🩵', '❤️‍🔥'],
  fire: ['🔥', '💥', '⚡', '💫', '✨', '🌟', '🚀', '☄️', '🌋', '💣', '🎆', '🎇'],
  faces: ['😍', '🥰', '🤩', '😎', '🤯', '🥹', '😭', '😮‍💨', '😌', '🥵', '🫠', '😏', '🤤', '😳', '🫶'],
  music: ['🎧', '🎶', '🎵', '🎹', '🎸', '🥁', '🔊', '🎼', '🪩', '🕺', '💃', '🎤', '🎷', '🎺', '📻', '🎛️'],
  hype: ['🙌', '👏', '🫡', '💪', '👌', '🤝', '🙏', '🫰', '🤘', '✊', '👊', '🙆'],
  vibes: ['💎', '👑', '🏆', '💯', '🌊', '🌙', '🌈', '⭐', '🌌', '🪐', '🌆', '🌴', '🍃', '🦋', '🔮', '🧿', '🐐', '🥇'],
};
const EMOJI_FAMILIES = Object.keys(EMOJI);
const EMOJI_ALL = [].concat(...Object.values(EMOJI));

function emojiComment() {
  const r = Math.random();
  const fam = () => EMOJI[pick(EMOJI_FAMILIES)];
  if (r < 0.34) return pick(EMOJI_ALL).repeat(randInt(2, 5));
  if (r < 0.62) {
    const f = shuffle(fam());
    return f.slice(0, randInt(3, 5)).join('');
  }
  if (r < 0.80) return pick(fam()).repeat(randInt(2, 3)) + pick(fam()).repeat(randInt(2, 3));
  if (r < 0.92) return pick(fam()).repeat(randInt(2, 4)) + pick(['💯', '🔥', '🎧', '👑', '🙌', '🫶']).repeat(randInt(1, 2));
  return `${pick(EMOJI.faces)}${pick(EMOJI.music)}${pick(EMOJI.fire)}${pick(EMOJI.hearts)}`;
}

const CM = {
  react: [
    'absolutely insane', 'straight fire', 'pure heat', 'unreal', 'no way this is real', 'this is criminal', 'wow just wow',
    'okay this is huge', 'instant favorite', 'goosebumps already', 'I cannot stop replaying this', 'what a monster',
    'this one is special', 'big big big', 'we are not ready', 'this is dangerous', 'chills from the first second',
    'hands down the best today', 'sheer perfection', 'immaculate', 'beyond words', 'this is next level', 'cold blooded',
    'it just keeps getting better', 'I am speechless', 'certified heater', 'this one hits the soul', 'mind blown',
    'this deserves a million plays', 'complete masterclass', 'this is world class', 'monster energy', 'pure magic',
    'finally something real', 'this is the one', 'stop everything and listen', 'volume all the way up',
    'crazy good', 'unbelievably clean', 'ridiculous in the best way', 'top tier', 'elite level', 'legendary stuff',
    'this just made my day', 'I needed this', 'how is this not everywhere yet', 'the energy is unmatched',
  ],
  adj: [
    'fire', 'insane', 'legendary', 'unreal', 'massive', 'electric', 'flawless', 'phenomenal', 'monstrous', 'immaculate',
    'epic', 'ridiculous', 'cinematic', 'majestic', 'explosive', 'blistering', 'hypnotic', 'euphoric', 'colossal', 'savage',
    'next level', 'otherworldly', 'spotless', 'sublime', 'radiant', 'lethal', 'untouchable', 'divine', 'bulletproof', 'luminous',
    'razor sharp', 'face melting', 'earth shaking', 'heart stopping', 'jaw dropping', 'mind bending', 'soul shaking',
    'breathtaking', 'thunderous', 'glorious', 'supreme', 'elite', 'dazzling', 'gripping', 'relentless', 'towering',
    'spellbinding', 'transcendent', 'stellar', 'staggering', 'wicked', 'filthy', 'nasty', 'crisp', 'silky', 'velvety',
    'monumental', 'heavenly', 'volcanic', 'cosmic', 'surreal', 'addictive', 'infectious', 'unstoppable', 'timeless',
    'larger than life', 'top shelf', 'world class', 'studio perfect', 'club ready', 'festival ready', 'headphone worthy',
    'chart worthy', 'powerful', 'mesmerizing', 'immersive', 'fearless', 'bold', 'gigantic', 'smooth as glass', 'razor clean',
  ],
  noun: [
    'banger', 'masterpiece', 'anthem', 'heater', 'gem', 'monster', 'weapon', 'bomb', 'jam', 'vibe', 'track', 'release',
    'production', 'journey', 'wave', 'groove', 'beast', 'tune', 'record', 'creation', 'sound', 'moment', 'experience',
    'drop', 'build', 'rush', 'storm', 'classic', 'piece of art', 'sonic trip', 'earworm', 'riot', 'hit', 'mood',
    'adventure', 'powerhouse', 'showstopper', 'game changer', 'flex', 'statement', 'ride', 'blast', 'jewel', 'lifesaver',
  ],
  verb: [
    'slaps', 'hits different', 'goes crazy', 'goes so hard', 'goes off', 'hits so hard', 'delivers', 'never misses',
    'keeps me hooked', 'gives me chills', 'sounds massive', 'sounds so clean', 'lives in my head', 'is stuck on repeat',
    'grabs you instantly', 'lifts the whole room', 'wins every time', 'takes over', 'blows me away', 'knocks me out',
    'moves the whole body', 'lights up my day', 'turns heads', 'does not miss', 'pulls you in', 'makes me feel alive',
    'steals the show', 'runs the playlist', 'owns the night', 'melts me', 'rattles the speakers', 'shakes the walls',
  ],
  element: [
    'that bass', 'the drop', 'that synth work', 'the kick', 'the melody', 'the build up', 'the low end', 'the groove', 'the hi-hat work',
    'the lead', 'the arpeggio', 'the atmosphere', 'the mix', 'the sound design', 'the transition work', 'the rhythm', 'the texture design',
    'the chord progression', 'the vocal work', 'the percussion', 'the sub', 'the energy', 'the pacing', 'the layering', 'the mastering',
    'the stereo width', 'the snare', 'the break', 'the riser', 'the intro', 'the outro', 'the second half', 'the hook',
    'that pad work', 'that drum work', 'the reverb work', 'the arrangement', 'the texture work', 'the bassline', 'the top end',
  ],
  elPraise: [
    'is unreal', 'is nasty', 'is insane', 'is out of this world', 'is pure gold', 'is perfection', 'is so clean', 'is crazy',
    'is lethal', 'is too good', 'is stunning', 'is huge', 'is something else', 'is on another level', 'hits so hard',
    'goes crazy', 'sounds incredible', 'sounds massive', 'gives me chills', 'is dripping with energy', 'deserves an award',
    'is perfectly crafted', 'is so satisfying', 'is flawless', 'is addicting', 'is breathtaking', 'is wild', 'is dangerous',
  ],
  feel: [
    'chills', 'goosebumps', 'pure energy', 'good vibes only', 'all the feels', 'full focus', 'instant joy', 'a rush',
    'total euphoria', 'serious momentum', 'real power', 'big confidence', 'fire in my chest', 'peace and power at once',
  ],
  where: [
    'on a late night drive', 'in the headphones at full volume', 'in the gym', 'on the dance floor', 'through the car speakers',
    'on a long walk', 'while working', 'at 3am', 'on a rooftop at night', 'in the club', 'on a road trip', 'at sunrise',
  ],
  closer: [
    'Keep them coming!', 'More of this please.', 'Absolute respect.', 'Run it back.', 'Putting this on repeat.',
    'Subscribed to the sound.', 'Sharing this everywhere.', 'This is going straight into my playlist.',
    'Big support!', 'Massive respect.', 'Never stop creating.', 'The future is bright.', 'Take a bow.',
    'Do not change a thing.', 'Do not sleep on this.', 'Everybody needs to hear this.', 'Loved every second.',
    'Waiting for the next one.', 'Underrated no more.', 'Playing this again right now.', 'You nailed it.', 'Pure talent.',
    'Easily one of the best I have heard.', 'This deserves way more plays.', 'Thank you for this one.',
  ],
};

function textComment(title) {
  const T = title ? `"${title}"` : null;
  const makers = [
    () => `${cap(pick(CM.react))}${pick(['!', '!!', '.'])} ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
    () => `This ${pick(CM.noun)} is ${pick(CM.adj)}${pick(['!', '.', '!!'])}`,
    () => `${cap(pick(CM.adj))} ${pick(CM.noun)}. ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
    () => `${cap(pick(CM.element))} ${pick(CM.elPraise)} and ${pick(CM.element)} ${pick(CM.elPraise)}!`,
    () => `${cap(pick(CM.react))}. ${pick(CM.closer)}`,
    () => `${cap(an(pick(CM.adj)))} ${pick(CM.noun)} from start to finish. ${pick(CM.closer)}`,
    () => `This ${pick(CM.verb)}. ${cap(pick(CM.element))} ${pick(CM.elPraise)}${pick(['!', '.'])}`,
    () => `Giving me ${pick(CM.feel)} ${pick(CM.where)}. ${cap(pick(CM.adj))}!`,
    () => `${cap(pick(CM.react))}${pick(['!', '.'])} Sounds ${pick(CM.adj)} ${pick(CM.where)}.`,
    () => `${cap(pick(CM.adj))}, ${pick(CM.adj)} and ${pick(CM.adj)}. ${pick(CM.closer)}`,
    () => `Not just ${an(pick(CM.noun))}, it is ${an(pick(CM.adj))} ${pick(CM.noun)}. ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
    () => `${cap(pick(CM.element))} ${pick(CM.elPraise)}${pick(['!', '.'])} ${cap(pick(CM.react))}.`,
    () => `Straight up ${pick(CM.adj)}. ${cap(pick(CM.element))} ${pick(CM.verb)}.`,
    () => `${cap(pick(CM.noun))} alert! ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
    () => `I keep coming back for ${pick(CM.element)}. ${cap(pick(CM.adj))} work.`,
    () => `${cap(pick(CM.feel))} from the first second. ${pick(CM.closer)}`,
    () => `${cap(pick(CM.react))}${pick(['!', '!!'])} ${cap(an(pick(CM.adj)))} ${pick(CM.noun)}.`,
    () => `If you like ${pick(CM.adj)} sounds, this ${pick(CM.verb)}. ${pick(CM.closer)}`,
    () => `${cap(pick(CM.element))} alone is worth the listen. ${cap(pick(CM.adj))}${pick(['!', '.'])}`,
    () => `${cap(pick(CM.noun))} of the day. ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
  ];
  if (T) {
    makers.push(
      () => `${T} ${pick(CM.verb)}${pick(['!', '.'])} ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
      () => `${T} is ${an(pick(CM.adj))} ${pick(CM.noun)}${pick(['!', '.'])} ${pick(CM.closer)}`,
      () => `${cap(pick(CM.react))} - ${T}${pick(['!', '.'])}`,
      () => `${T}: ${pick(CM.adj)}, ${pick(CM.adj)} and ${pick(CM.adj)}. ${cap(pick(CM.element))} ${pick(CM.elPraise)}.`,
      () => `Played ${T} ${pick(CM.where)} and got ${pick(CM.feel)}. ${cap(pick(CM.adj))}!`,
    );
  }
  let text = pick(makers)();
  const r = Math.random();
  if (r < 0.12) text = text.toLowerCase();
  else if (r < 0.2) text = text.replace(/[.!]+$/, '');
  if (Math.random() < 0.38) text += ` ${emojiBurst()}`;
  return text;
}

function emojiBurst() {
  const fam = EMOJI[pick(EMOJI_FAMILIES)];
  return pick(fam).repeat(randInt(1, 3)) + (Math.random() < 0.4 ? pick(EMOJI_ALL) : '');
}

function generateComment(title) {
  const share = Number.isFinite(CFG.emojiShare) ? CFG.emojiShare : 0.3;
  const text = Math.random() < share ? emojiComment() : textComment(title);
  return text.slice(0, 300);
}

function nextComment(run, target) {
  let used = run.used.get(target.id);
  if (!used) { used = new Set(); run.used.set(target.id, used); }
  let text = generateComment(target.title);
  for (let i = 0; i < 40 && used.has(text); i++) text = generateComment(target.title);
  while (used.has(text)) text += pick(EMOJI_ALL);
  used.add(text);
  return text;
}

function entityIdOf(trackId) {
  const H = sdkPkg.HashId || (sdkPkg.default && sdkPkg.default.HashId);
  if (!H || typeof H.parse !== 'function') throw new Error('installed @audius/sdk does not export HashId; cannot decode track ids');
  return H.parse(trackId);
}
const ENTITY_TRACK = (sdkPkg.EntityType && sdkPkg.EntityType.TRACK) || (sdkPkg.default && sdkPkg.default.EntityType && sdkPkg.default.EntityType.TRACK) || 'Track';

async function findComment(sdk, userId, trackId, message) {
  for (let page = 0; page < CFG.scanPages; page++) {
    const r = await readRetry(() => sdk.tracks.getTrackComments({ trackId, userId, limit: 50, offset: page * 50, sortMethod: 'newest' }));
    const list = (r && r.data) || [];
    const hit = list.find(c => String(c.userId !== undefined ? c.userId : c.user_id) === String(userId) &&
      (message == null || c.message === message));
    if (hit) return hit;
    if (list.length < 50) break;
  }
  return null;
}

async function verifyComment(sdk, userId, trackId, message) {
  for (let i = 1; i <= CFG.verifyTries; i++) {
    await sleep(CFG.verifyDelayMs * i);
    const c = await findComment(sdk, userId, trackId, message);
    if (c) return c;
  }
  return null;
}

async function loadFollowerCounts(sdk, ids) {
  const counts = new Map();
  for (let i = 0; i < ids.length; i += CFG.followerBatch) {
    const chunk = ids.slice(i, i + CFG.followerBatch);
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

function tracksBelowCap(rows, published, ctx) {
  const today = countTracks(rows, ctx);
  return published.filter(p => (today.get(p.key) || 0) < p.cap);
}

function allDoneMsg(n) {
  return `[*] All ${n} tracks reached their daily comment limit. Exiting.`;
}

function dayState(coord, today) {
  for (let n = 1; n <= CFG.runsPerDay; n++) {
    const b = (coord.batches || []).find(x => x.date === today && x.run_number === n);
    if (!b || !b.done) return { runNumber: n, batch: b || null };
  }
  return null;
}

// Find the next free custom run number (100..199) for today.
function nextCustomRunNumber(coord, today) {
  for (let n = CUSTOM_RUN_START; n < CUSTOM_RUN_END; n++) {
    const b = (coord.batches || []).find(x => x.date === today && x.run_number === n);
    if (!b || !b.done) return { runNumber: n, batch: b || null };
  }
  return null;
}

function reason(e) {
  if (isRateLimit(e)) return '429';
  const code = statusOf(e);
  if (code) return `HTTP ${code}`;
  const m = String((e && e.message) || e);
  if (/timeout|timed out/i.test(m)) return 'timeout';
  return m.slice(0, 50);
}

async function commentJob(sb, ctx, run, acct, target) {
  const st = run.stats;
  const who = acct.handle ? `@${acct.handle}` : acct.address;
  const say = text => { if (VERBOSE) log(`[*] ${who} -> track ${target.id} | ${text}`); };
  let verified = false;
  let already = false;
  let commentId = null;
  let outcome;
  try {
    let sdk = run.sdks.get(acct.address);
    if (!sdk) { sdk = makeSdk(acct); run.sdks.set(acct.address, sdk); }

    const existing = await findComment(sdk, acct.user_id, target.id, null);
    if (existing) {
      already = true;
      commentId = existing.id || null;
    } else {
      const body = nextComment(run, target);
      let reqErr = null;
      try {
        await withTimeout(sdk.comments.createComment({
          userId: acct.user_id,
          metadata: { entityId: entityIdOf(target.id), entityType: ENTITY_TRACK, body },
        }), CFG.callTimeoutMs, 'createComment');
      } catch (e) {
        if (isRateLimit(e)) throw e;
        reqErr = e;
      }
      const found = await verifyComment(sdk, acct.user_id, target.id, body);
      if (!found) throw reqErr || new Error('comment could not be verified');
      commentId = found.id || null;
      say(body);
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
      address: acct.address, track_id: target.id, comment_id: commentId, date: ctx.today, day: ctx.dayName, run_number: run.number,
      week_start: ctx.weekStart, at: new Date().toISOString(),
    };
    let saved = true;
    try { await recordComment(sb, ctx.weekStart, acct.address, item); } catch (e) {
      saved = false;
      PENDING.push(item); savePending();
      if (e instanceof LockLostError) run.abort = e;
    }
    acct.commented.add(target.key);
    acct.today++;
    if (!saved) log(`[!] ${who} -> track ${target.id} | commented, DB save failed (kept locally)`);
    else say(already ? 'already commented' : 'successful');
  }
  if (CFG.commentDelayMs) await sleep(CFG.commentDelayMs);
  return outcome;
}

async function fillTrack(sb, ctx, run, target, attempts, maxOk, candidates) {
  let got = 0;
  let inflight = 0;
  let started = 0;
  const step = async () => {
    if (run.abort || LOCK_LOST || run.stop) return false;
    if (CFG.maxRunMs && Date.now() - run.startedAt > CFG.maxRunMs) {
      run.stop = true;
      log('[!] Time limit reached; stopping. Next run resumes.');
      return false;
    }
    if (got >= maxOk || started >= attempts) return false;
    if (got + inflight >= maxOk) {
      if (!inflight) return false;
      await sleep(50);
      return true;
    }
    const acct = candidates.shift();
    if (!acct) return false;
    inflight++;
    started++;
    const outcome = await commentJob(sb, ctx, run, acct, target);
    inflight--;
    if (outcome === 'ok' || outcome === 'already') got++;
    return true;
  };
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, async () => { while (await step()); }));
  return { got, started, skipped: started - got };
}

function countToday(raw, ctx) {
  let n = 0;
  if (sameWeek(raw, ctx.weekStart) && Array.isArray(raw.runs)) {
    for (const r of raw.runs) if (r.date === ctx.today) n += (r.tracks || []).filter(t => t.status === 'success').length;
  }
  return n;
}

function countTracks(rows, ctx, runNumber) {
  const counts = new Map();
  for (const r of rows) {
    const f = r.comment;
    if (!isObj(f) || !sameWeek(f, ctx.weekStart) || !Array.isArray(f.runs)) continue;
    for (const x of f.runs) {
      if (x.date !== ctx.today || (runNumber !== undefined && x.run_number !== runNumber)) continue;
      for (const t of x.tracks || []) {
        if (t.status !== 'success') continue;
        const k = String(t.track_id);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  }
  return counts;
}

// MODIFIED: accepts `custom` and `excludeUser`. For custom runs, `attempts`/`maxOk` are
// derived from this run's own contribution only (independent of the scheduled daily cap).
async function processRun(sb, ctx, rows, targets, { runNumber, batch, custom = false, excludeUser = null }) {
  const accounts = rows.map(r => ({
    address: r.address, handle: typeof r.handle === 'string' ? r.handle.trim().replace(/^@/, '') : null,
    user_id: r.user_id, app_data: r.app_data, hasCreds: hasCreds(r), commented: commentedSet(r.comment, ctx.weekStart),
    today: countToday(r.comment, ctx),
  }));
  const reader = accounts.find(a => a.hasCreds);
  if (!reader) throw new Error('no account with complete credentials');
  {
    const probe = makeSdk(reader);
    if (!probe.comments || typeof probe.comments.createComment !== 'function') {
      throw new Error('installed @audius/sdk has no comments.createComment(); check the SDK version');
    }
    if (!probe.tracks || typeof probe.tracks.getTrackComments !== 'function') {
      throw new Error('installed @audius/sdk has no tracks.getTrackComments(); cannot verify comments');
    }
    entityIdOf(targets[0].id);
  }

  const withCreds = accounts.filter(a => a.hasCreds);
  const followerCounts = await loadFollowerCounts(makeSdk(reader), withCreds.map(a => String(a.user_id)));
  for (const a of accounts) {
    const n = followerCounts.get(String(a.user_id));
    a.qualified = a.hasCreds && n !== undefined && n >= CFG.minFollowers;
  }
  const qualifiedCount = accounts.filter(a => a.qualified).length;
  const unknownCount = withCreds.filter(a => !followerCounts.has(String(a.user_id))).length;
  if (!qualifiedCount) log(`[!] No accounts with ${CFG.minFollowers}+ followers available.`);
  else if (VERBOSE) {
    log(`[*] Follower check: ${qualifiedCount} of ${withCreds.length} accounts have ${CFG.minFollowers}+ followers.`);
    if (unknownCount) log(`[*] Follower count unavailable for ${unknownCount} accounts; skipped this run.`);
  }

  const todayDone = countTracks(rows, ctx);
  const runDone = countTracks(rows, ctx, runNumber);
  const need = new Map(targets.map(t => {
    const thisRunDone = runDone.get(t.key) || 0;
    if (custom) {
      // Custom run: do up to `t.cap` (== target) in THIS run, independent of other runs today.
      const remaining = Math.max(0, t.cap - thisRunDone);
      return [t.key, { attempts: remaining, maxOk: remaining }];
    }
    const left = Math.max(0, t.cap - (todayDone.get(t.key) || 0));
    const attempts = Math.max(0, attemptsPerRun(t.cap, false) - thisRunDone);
    return [t.key, { attempts: left ? attempts : 0, maxOk: left }];
  }));
  let totalNeed = 0;
  let active = 0;
  for (const t of targets) {
    const n = need.get(t.key);
    if (!n.attempts) continue;
    totalNeed += Math.min(n.attempts, n.maxOk);
    active++;
  }
  if (!totalNeed) {
    if (!custom && !tracksBelowCap(rows, targets, ctx).length) {
      log(allDoneMsg(targets.length));
      return { status: 'ALREADY_COMPLETED' };
    }
    await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.batches) h.batches = [];
      const b = h.batches.find(x => x.date === ctx.today && x.run_number === runNumber);
      if (b && b.done) return false;
      if (b) b.done = true; else h.batches.push({ date: ctx.today, run_number: runNumber, done: true });
      return true;
    });
    log(`[*] Run ${runNumber}: nothing left to attempt in this run.`);
    return { status: 'COMPLETED' };
  }
  const atCap = custom ? 0 : targets.filter(t => (todayDone.get(t.key) || 0) >= t.cap).length;
  log(`[*] ${custom ? 'Custom' : ''} run ${runNumber}${batch ? ' (resumed)' : ''}: ${active} tracks to do${atCap ? ` (${atCap} already at daily limit)` : ''}, up to ${totalNeed} comments.`);

  if (!batch) {
    await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.batches) h.batches = [];
      if (h.batches.some(b => b.date === ctx.today && b.run_number === runNumber)) return false;
      h.batches.push({ date: ctx.today, run_number: runNumber, done: false });
      return true;
    });
  }

  const run = { startedAt: Date.now(), number: runNumber, cool: new Set(), abort: null, stop: false, consecFail: 0, lastReqErr: null, sdks: new Map(), used: new Map(), stats: { ok: 0, already: 0, rate: 0, retry: 0, perm: 0 } };
  const st = run.stats;
  let incomplete = false;

  for (const t of targets) {
    const n = need.get(t.key);
    if (!n.attempts) continue;
    if (run.stop) { incomplete = true; continue; }
    const pool = accounts.filter(a => a.qualified && !a.commented.has(t.key) && !run.cool.has(a.address) &&
      (!excludeUser || String(a.user_id) !== String(excludeUser)));
    const candidates = shuffle(pool).sort((x, y) => x.today - y.today);
    const { got, started, skipped } = await fillTrack(sb, ctx, run, t, n.attempts, n.maxOk, candidates);
    if (run.abort || LOCK_LOST) throw run.abort || LOCK_LOST;
    const day = (todayDone.get(t.key) || 0) + got;
    const inRun = (runDone.get(t.key) || 0) + got;
    if (started < n.attempts && got < n.maxOk && !run.stop) {
      log(`[!] track ${t.id} | ${custom ? `${inRun}/${t.cap} this run` : `${day}/${t.cap} today`} (no more accounts available${skipped ? `, ${skipped} skipped` : ''})`);
    } else {
      log(`[*] track ${t.id} | ${custom ? `${inRun}/${t.cap} this run` : `${day}/${t.cap} today`}${custom ? '' : day >= t.cap ? ' (done)' : ''}${skipped ? ` (${skipped} skipped)` : ''}`);
    }
    if (run.stop) incomplete = true;
  }

  const left = incomplete;
  if (!left) {
    await updateComment(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      const b = (h.batches || []).find(x => x.date === ctx.today && x.run_number === runNumber);
      if (!b || b.done) return false;
      b.done = true;
      return true;
    });
  }
  const parts = [`${st.ok} commented`];
  if (st.already) parts.push(`${st.already} already commented`);
  if (st.rate) parts.push(`${st.rate} rate-limited`);
  if (st.retry) parts.push(`${st.retry} errors`);
  if (st.perm) parts.push(`${st.perm} failed`);
  log(`[*] ${custom ? 'Custom' : ''} run ${runNumber} ${left ? 'incomplete' : 'complete'}: ${parts.join(', ')}.${left ? ' Next run resumes.' : ''}`);
  return { status: left ? 'INCOMPLETE' : 'COMPLETED' };
}

// Scheduled entry point (unchanged behavior).
async function runComment({ now = new Date() } = {}) {
  const ctx = buildContext(now);
  const sb = connectSupabase();
  PENDING = loadPending();

  const published = collectTracks(await readUpTracks(sb));
  if (!published.length) {
    log('[!] No successfully published tracks found in up_tracks. Exiting.');
    return { status: 'NO_TARGETS' };
  }
  log(`[*] Targeting the last published batch (${published[0].date}): ${published.length} track(s).`);

  let rows = await fetchRows(sb);
  const coordRaw = rows.find(r => r.address === TARGET_ADDRESS).comment;
  if (isObj(coordRaw) && coordRaw.week_start && !sameWeek(coordRaw, ctx.weekStart)) {
    log('[*] New week: history reset.');
  }
  if (!tracksBelowCap(rows, published, ctx).length) {
    log(allDoneMsg(published.length));
    return { status: 'ALREADY_COMPLETED' };
  }
  if (!dayState(normalizeComment(coordRaw, ctx.weekStart), ctx.today)) {
    log('[*] Both runs already done today. Exiting.');
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
    const coord = normalizeComment(rows.find(r => r.address === TARGET_ADDRESS).comment, ctx.weekStart);
    if (!tracksBelowCap(rows, published, ctx).length) {
      log(allDoneMsg(published.length));
      return { status: 'ALREADY_COMPLETED' };
    }
    const state = dayState(coord, ctx.today);
    if (!state) {
      log('[*] Both runs already done today. Exiting.');
      return { status: 'ALREADY_COMPLETED' };
    }
    return await processRun(sb, ctx, rows, published, state);
  } finally {
    stopHeartbeat();
    HELD_LOCK = null;
    await releaseLock(sb, ctx, lock);
  }
}

// ============ NEW: runComments (tastemaker integration) ============
// Called from tastemaker.js with a specific handle and target. Reuses all comment machinery
// but uses a custom run number (100..199) so it never interferes with the scheduled runs.
//
//   runComments({ handle: 'illpetill', target: 50 })
//   runComments({ tracks: [{ id, title }], target: 50 })
//   runComments({ handle: 'illpetill', tracks: [...], target: 50 })
//
// Semantics: "do up to `target` comments on each track in THIS invocation". Running twice
// does `target` more (a new custom run number is allocated), unless the pool is exhausted.
async function runComments({ handle = null, tracks = null, target, now = new Date() } = {}) {
  if (!Number.isInteger(target) || target <= 0) {
    throw new Error(`runComments: target must be a positive integer (got ${target})`);
  }
  if (!tracks && !handle) {
    throw new Error('runComments: either tracks or handle is required');
  }

  const ctx = buildContext(now);
  const sb = connectSupabase();
  PENDING = loadPending();

  let rows = await fetchRows(sb);
  const reader = rows.find(r => hasCreds(r));
  if (!reader) throw new Error('runComments: no account with complete credentials');

  let focusUserId = null;
  let focusHandle = null;
  let focusTracks;

  if (handle) {
    const sdk = makeSdk(reader);
    let user = null;
    try {
      const res = await readRetry(() => sdk.users.getUserByHandle({ handle }));
      user = res && res.data;
    } catch (e) {
      if (isRateLimit(e)) throw e;
    }
    if (!user) {
      try { user = await fetchUserByHandle(handle); } catch (e) { throw new Error(`runComments: user not found: @${handle} (${errMsg(e)})`); }
    }
    if (!user || !user.id) throw new Error(`runComments: user not found: @${handle}`);
    focusUserId = String(user.id);
    focusHandle = user.handle || handle;
  }

  if (tracks && tracks.length) {
    focusTracks = tracks.map(t => ({
      id: String(t.id),
      key: String(t.id),
      address: t.address || null,
      handle: t.handle || focusHandle,
      title: (t.title || '').toString().trim().slice(0, 80) || null,
      date: ctx.today,
      cap: target,
    }));
  } else if (focusUserId) {
    let list;
    try {
      list = await fetchUserTracks(focusUserId);
    } catch (e) {
      throw new Error(`runComments: could not fetch tracks for @${focusHandle || handle}: ${errMsg(e)}`);
    }
    focusTracks = list.map(t => ({
      id: String(t.id),
      key: String(t.id),
      address: null,
      handle: focusHandle || handle,
      title: (t.title || '').toString().trim().slice(0, 80) || null,
      date: ctx.today,
      cap: target,
    }));
  } else {
    throw new Error('runComments: could not resolve tracks');
  }

  // Deduplicate by id.
  const seen = new Set();
  focusTracks = focusTracks.filter(t => (seen.has(t.key) ? false : (seen.add(t.key), true)));

  if (!focusTracks.length) {
    log('[!] runComments: no tracks to comment on.');
    return { status: 'NO_TARGETS' };
  }

  log(`[*] runComments: ${focusTracks.length} track(s), target ${target} per track${focusHandle ? ` (focus @${focusHandle})` : ''}.`);

  const lock = await acquireLock(sb, ctx);
  if (!lock) return { status: 'LOCKED' };
  HELD_LOCK = lock;
  LOCK_LOST = null;
  const stopHeartbeat = startHeartbeat(sb, ctx);

  try {
    await flushPending(sb, ctx);
    rows = await fetchRows(sb);

    const coord = normalizeComment(rows.find(r => r.address === TARGET_ADDRESS).comment, ctx.weekStart);
    const slot = nextCustomRunNumber(coord, ctx.today);
    if (!slot) {
      log('[*] runComments: no free custom run slot today (100..199 all used).');
      return { status: 'ALREADY_COMPLETED' };
    }

    // Quick check: is any track below target within this run slot?
    const runDone = countTracks(rows, ctx, slot.runNumber);
    let anyNeed = false;
    for (const t of focusTracks) {
      if ((runDone.get(t.key) || 0) < target) { anyNeed = true; break; }
    }
    if (!anyNeed) {
      log(`[*] runComments: all tracks already at target ${target} in run ${slot.runNumber}.`);
      return { status: 'ALREADY_COMPLETED' };
    }

    return await processRun(sb, ctx, rows, focusTracks, {
      runNumber: slot.runNumber,
      batch: slot.batch,
      custom: true,
      excludeUser: focusUserId,
    });
  } finally {
    stopHeartbeat();
    HELD_LOCK = null;
    await releaseLock(sb, ctx, lock);
  }
}

if (require.main === module) {
  runComment().catch(err => {
    console.error('[!] Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = {
  runComment,
  runComments,
  collectTracks,
  buildContext,
  CFG,
  fetchUserByHandle,
  fetchUserTracks,
};