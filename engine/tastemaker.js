#!/usr/bin/env node
'use strict';

// ============ CONSTANTS ============
const DEFAULT_TRENDING_HOURS = 5;
const DEFAULT_HELPER_COUNT = 50;
const DEFAULT_TRENDING_MIN = 1;
const DEFAULT_TRENDING_MAX = 20;
const DEFAULT_FEED_LIMIT = 30;
const DEFAULT_MAX_TRACKS_PER_RUN = 5;
const DEFAULT_FIRST_RUN_TRACKS = 10;
const TARGET_INTERACTIONS = 20;
const FOCUS_DEFAULT_TARGET = 200;
const DEFAULT_COMMENTS_PER_TRACK = 50;
const FEED_TRACK_MAX_AGE_MS = 24 * 3600 * 1000;
const STATE_VERSION_MAX_TRACKS = 1000;

// ============ IMPORTS ============
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PROXY_URLS = (process.env.AUDIUS_PROXY_URLS ||
  'https://audius-v2.qringgreen.workers.dev,https://audius-v2.qring99.workers.dev,https://audius.henrygreen311.workers.dev,https://audius-v2.henrygreen311.workers.dev,https://audius.qring99.workers.dev,https://audius.qringgreen.workers.dev')
  .split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean);
const PROXY_KEY = process.env.AUDIUS_PROXY_KEY || '';

{
  const realFetch = globalThis.fetch;
  const CONNECT_ERRS = new Set(['ETIMEDOUT', 'ENETUNREACH', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
  const RETRY_STATUS = new Set([502, 503, 504]);
  const downUntil = new Map();
  const warned = new Set();
  const ATTEMPTS = Number(process.env.PROXY_ATTEMPTS || 6);
  const STATUS_ATTEMPTS = Number(process.env.PROXY_STATUS_ATTEMPTS || 3);
  const sleepMs = ms => new Promise(r => setTimeout(r, ms));

  const pick = avoid => {
    const now = Date.now();
    const up = PROXY_URLS.filter(u => (downUntil.get(u) || 0) <= now);
    let pool = up.length ? up : PROXY_URLS;
    if (avoid && pool.length > 1) pool = pool.filter(u => u !== avoid);
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
    let lastProxy = null;
    let statusTries = 0;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const proxy = (lastProxy && PROXY_URLS.length > 1) ? pick(lastProxy) : pick();
      lastProxy = proxy;
      const target = proxy + url.pathname + url.search;
      let res;
      try {
        res = isReq && !init
          ? await realFetch(new Request(target, input.clone()), { headers })
          : await realFetch(target, { ...init, headers });
      } catch (e) {
        const code = e && ((e.cause && e.cause.code) || e.code);
        if (!CONNECT_ERRS.has(code)) throw e;
        lastErr = e;
        downUntil.set(proxy, Date.now() + 20000);
        if (!warned.has(proxy)) { warned.add(proxy); console.log(`[!] Proxy ${new URL(proxy).host} unreachable; using another.`); }
        await sleepMs(300 * attempt);
        continue;
      }
      if (RETRY_STATUS.has(res.status) && ++statusTries < STATUS_ATTEMPTS) {
        try { if (res.body) await res.body.cancel(); } catch (_) {}
        await sleepMs(500 * statusTries);
        continue;
      }
      return res;
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
const ONCE = process.argv.includes('--once');
const FORCE_TRENDING = process.argv.includes('--force-trending');
const FORCE_FEED = process.argv.includes('--force-feed');
const FORCE_FIRST_RUN = process.argv.includes('--force-first-run');
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

// ============ PATHS ============
const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');
const STATE_FILE = path.join(ROOT_DIR, '.audius_tastemaker_state.json');
const TARGET_ADDRESS = 'qringgreen@gmail.com';

// ============ CONFIG ============
const CFG = {
  timezone: process.env.RESET_TIMEZONE || 'America/Los_Angeles',
  resetHour: Number(process.env.RESET_HOUR ?? 12),
  dayTimezone: process.env.DAY_TIMEZONE || 'Africa/Lagos',
  trendingCheckMs: Number(process.env.TRENDING_CHECK_HOURS || DEFAULT_TRENDING_HOURS) * 3600000,
  trendingMin: Number(process.env.TRENDING_MIN || DEFAULT_TRENDING_MIN),
  trendingMax: Number(process.env.TRENDING_MAX || DEFAULT_TRENDING_MAX),
  trendingTime: process.env.TRENDING_TIME || 'week',
  helperCount: Number(process.env.HELPER_COUNT || DEFAULT_HELPER_COUNT),
  feedLimit: Number(process.env.FEED_LIMIT || DEFAULT_FEED_LIMIT),
  maxTracksPerRun: Number(process.env.MAX_TRACKS_PER_RUN || DEFAULT_MAX_TRACKS_PER_RUN),
  firstRunTracks: Number(process.env.FIRST_RUN_TRACKS || DEFAULT_FIRST_RUN_TRACKS),
  rateLimitCooldownMs: Number(process.env.RATE_LIMIT_COOLDOWN_MINUTES || 3) * 60000,
  lockTtlMs: Number(process.env.LOCK_TTL_MINUTES || 120) * 60000,
  lockStaleMs: Number(process.env.LOCK_STALE_SECONDS || 120) * 1000,
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  verifyDelayMs: Number(process.env.VERIFY_DELAY_MS || 300),
  failStopAfter: Number(process.env.FAIL_STOP_AFTER || 15),
  actionDelayMs: Number(process.env.ACTION_DELAY_MS || 50),
  followDelayMs: Number(process.env.FOLLOW_DELAY_MS || 150),
  concurrency: Number(process.env.CONCURRENCY || 12),
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_SECONDS || 20) * 1000,
  feedTimeoutMs: Number(process.env.FEED_TIMEOUT_SECONDS || 15) * 1000,
  maxRunMs: Number(process.env.MAX_RUN_MINUTES || 0) * 60000,
  rateWaitMs: Number(process.env.RATE_WAIT_MS || 3000),
  loopIntervalMs: Number(process.env.LOOP_INTERVAL_SECONDS || 60) * 1000,
  feedBackoffBaseMs: Number(process.env.FEED_BACKOFF_BASE_MS || 10000),
  feedBackoffMaxMs: Number(process.env.FEED_BACKOFF_MAX_MS || 60000),
<<<<<<< HEAD
  skipAtCount: Number(process.env.SKIP_AT_COUNT || 5),
  skipWhen: /^either$/i.test(process.env.SKIP_WHEN || '') ? 'either' : 'both',
  commentsPerTrack: Number(process.env.COMMENTS_PER_TRACK || DEFAULT_COMMENTS_PER_TRACK),
  focusMaxTracks: Number(process.env.FOCUS_MAX_TRACKS || 0),
  _feedTarget: null,
=======
>>>>>>> 4dd8ce1 (Add files via upload)
};

// ============ CLI ARGS ============
const HANDLE_RE = /^[A-Za-z0-9_.]{1,30}$/;

// NEW: parse "1000", "10k", "1m", "1.5k" etc.
function parseCount(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim().toLowerCase();
  const m = s.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : m[2] === 'b' ? 1000000000 : 1;
  const result = Math.floor(n * mult);
  return Number.isInteger(result) && result > 0 ? result : null;
}

function parseCliFocus() {
  const args = process.argv.slice(2);
  const handleArg = args.find(a => /^handle=/i.test(a));
  const targetArg = args.find(a => /^target=/i.test(a));
  const streamArg = args.find(a => /^stream=/i.test(a));

  let focus = null;
  if (handleArg) {
    const raw = handleArg.slice(handleArg.indexOf('=') + 1).trim().replace(/^@/, '');
    if (!HANDLE_RE.test(raw)) {
      log(`[!] Ignoring invalid handle=${raw} (must match ${HANDLE_RE}).`);
    } else {
      focus = {
        handle: raw,
        target: FOCUS_DEFAULT_TARGET,
        commentTarget: CFG.commentsPerTrack,
        streamTarget: 0,
        excludeUser: null,
      };
      const cmt = focus.commentTarget > 0 ? ` + ${focus.commentTarget} comments/track` : '';
      log(`[*] Focus mode: handle=@${raw} (target ${FOCUS_DEFAULT_TARGET} favs/reposts${cmt} per track, today's uploads only).`);
    }
  }

  if (targetArg) {
    const raw = targetArg.slice(targetArg.indexOf('=') + 1).trim();
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      log(`[!] Ignoring invalid target=${raw} (must be a non-negative integer).`);
    } else if (focus) {
      focus.target = n;
      if (n === 0) log('[*] Focus: fav/repost disabled (target=0).');
      else log(`[*] Focus target set to ${n} favs/reposts per track.`);
    } else {
      if (n === 0) log('[!] target=0 is only valid with handle= in focus mode; ignoring.');
      else { CFG._feedTarget = n; log(`[*] Feed target set to ${n} favs/reposts per track.`); }
    }
  }

  if (streamArg) {
    const raw = streamArg.slice(streamArg.indexOf('=') + 1).trim();
    const n = parseCount(raw);
    if (n === null) {
      log(`[!] Ignoring invalid stream=${raw} (must be positive, e.g. 1000, 10k, 1m).`);
    } else if (focus) {
      focus.streamTarget = n;
      log(`[*] Focus: stream target set to ${n} streams per track (via ./stream.js).`);
      if (n >= 5000) log(`[!] Note: ${n} streams/track with ~${CFG.streamDurationMs / 1000}s/stream and 10 workers ≈ ${Math.ceil((n * CFG.streamDurationMs) / 1000 / 10 / 3600)}h per track. Set MAX_RUN_MINUTES to cap.`);
    } else {
      log('[!] stream= is only supported with handle= (focus mode); ignoring.');
    }
  }

  return focus;
}

// ============ UTILITIES ============
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
    /fetch failed|network|timeout|timed out|socket hang up|temporar|bad gateway|service unavailable|gateway|aborted/.test(msg);
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

function ymdInTz(iso, tz) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day}`;
  } catch (_) {
    return null;
  }
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

// ============ SUPABASE ============
class LockLostError extends Error {}

function connectSupabase() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`db.txt not found at: ${DB_FILE}`);
  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
  return createClient(urlMatch[1], keyMatch[1]);
}

const hasCreds = r => !!(r && r.user_id && r.app_data && r.app_data.api_key && r.app_data.api_secret && r.app_data.bearer_token);

function makeSdk(acct) {
  return sdkFactory({
    apiKey: acct.app_data.api_key,
    apiSecret: acct.app_data.api_secret,
    bearerToken: acct.app_data.bearer_token,
  });
}

async function fetchPrimary(sb) {
  const { data, error } = await withRetry(async () => {
    const { data, error } = await sb.from('audius')
      .select('address, handle, user_id, app_data, t_maker')
      .eq('address', TARGET_ADDRESS).limit(1);
    if (error) {
      const e = new Error(/t_maker/i.test(error.message) && /column|exist|schema/i.test(error.message)
        ? 'audius.t_maker column is missing - run: ALTER TABLE audius ADD COLUMN t_maker jsonb;' : error.message);
      e.fatal = true;
      throw e;
    }
    return { data, error };
  }, e => !e.fatal);
  if (!data || !data[0]) throw new Error(`row not found in audius table: ${TARGET_ADDRESS}`);
  return data[0];
}

async function fetchHelperPool(sb, primaryAddress) {
  const out = [];
  const page = 200;
  for (let from = 0; from < 10 * page; from += page) {
    const data = await withRetry(async () => {
      const { data, error } = await sb.from('audius')
        .select('address, handle, user_id, app_data')
        .neq('address', primaryAddress)
        .not('user_id', 'is', null)
        .not('app_data', 'is', null)
        .order('address', { ascending: true })
        .range(from, from + page - 1);
      if (error) { const e = new Error(error.message); e.fatal = true; throw e; }
      return data || [];
    }, e => !e.fatal);
    out.push(...data);
    if (data.length < page) break;
  }
  return out.filter(hasCreds);
}

// ============ STATE ============
function sameWeek(raw, weekStart) {
  if (!isObj(raw)) return false;
  return raw.week_start === weekStart;
}

function normalizeTmaker(raw, weekStart) {
  if (sameWeek(raw, weekStart) && isObj(raw)) {
    const h = JSON.parse(JSON.stringify(raw));
    h.week_start = weekStart;
    if (!isObj(h.followed)) h.followed = {};
    if (!isObj(h.fed_tracks)) h.fed_tracks = {};
    if (!isObj(h.cooldowns)) h.cooldowns = {};
    if (typeof h.first_run_done !== 'boolean') h.first_run_done = false;
    for (const e of Object.values(h.fed_tracks)) {
      if (!Array.isArray(e.favorited_by)) e.favorited_by = [];
      if (!Array.isArray(e.reposted_by)) e.reposted_by = [];
    }
    return h;
  }
  const h = {
    week_start: weekStart,
    followed: {},
    fed_tracks: {},
    cooldowns: {},
    first_run_done: false,
    last_trend_check: null,
    feed_fail_count: 0,
    feed_retry_at: null,
  };
  if (isObj(raw) && raw.lock) h.lock = raw.lock;
  if (isObj(raw) && isObj(raw.cooldowns)) {
    const now = Date.now();
    for (const [addr, exp] of Object.entries(raw.cooldowns)) {
      const t = Date.parse(exp);
      if (Number.isFinite(t) && t > now) h.cooldowns[addr] = exp;
    }
  }
  return h;
}

let HELD_LOCK = null;

async function updateTmaker(sb, address, weekStart, mutate) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const { data, error } = await sb.from('audius').select('address, t_maker').eq('address', address).limit(1);
      if (error) throw new Error(error.message);
      if (!data || !data[0]) throw Object.assign(new Error(`account row not found: ${address}`), { fatal: true });
      const raw = data[0].t_maker;
      const hist = normalizeTmaker(raw, weekStart);
      if (address === TARGET_ADDRESS && HELD_LOCK && !(hist.lock && hist.lock.token === HELD_LOCK.token)) {
        throw new LockLostError('tastemaker lock was taken over by another run');
      }
      if (mutate(hist) === false) return hist;
      const prevV = isObj(raw) && Number.isInteger(raw.v) ? raw.v : null;
      hist.v = (prevV || 0) + 1;
      let q = sb.from('audius').update({ t_maker: hist }).eq('address', address);
      q = prevV === null ? q.is('t_maker->>v', null) : q.eq('t_maker->>v', String(prevV));
      const res = await q.select('address, t_maker');
      if (res.error) throw new Error(res.error.message);
      if (res.data && res.data.length === 1) return normalizeTmaker(res.data[0].t_maker, weekStart);
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

function lockStaleReason(lock) {
  if (!(Date.parse(lock.expires_at) > Date.now())) return 'it expired';
  const beat = Date.parse(lock.beat || lock.acquired_at);
  if (!Number.isFinite(beat) || Date.now() - beat > CFG.lockStaleMs) return 'its owner stopped responding';
  if (lock.pid && lock.host === os.hostname()) {
    try { process.kill(lock.pid, 0); } catch (e) { if (e.code !== 'EPERM') return 'its owner process is no longer running'; }
  }
  return null;
}

async function acquireLock(sb, ctx) {
  const token = crypto.randomUUID();
  let blocked = null;
  await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
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
  if (blocked) { log('[!] Another tastemaker run is active. Exiting.'); return null; }
  return { token };
}

let LOCK_LOST = null;

function startHeartbeat(sb, ctx) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || LOCK_LOST) return;
    busy = true;
    try {
      await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
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
    await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.lock || h.lock.token !== lock.token) return false;
      delete h.lock;
      return true;
    });
  } catch (e) {
    console.error(`[!] Could not release lock (expires on its own): ${e.message}`);
  }
}

async function saveState(sb, ctx, state) {
  await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
    const lock = h.lock;
    Object.assign(h, state);
    if (lock) h.lock = lock;
    return true;
  });
}

// ============ COOLDOWNS ============
function pruneCooldowns(state) {
  const now = Date.now();
  for (const [addr, exp] of Object.entries(state.cooldowns)) {
    if (Date.parse(exp) <= now) delete state.cooldowns[addr];
  }
}

function isOnCooldown(state, address) {
  const exp = state.cooldowns[address];
  if (!exp) return false;
  return Date.parse(exp) > Date.now();
}

function markCooldown(state, address, ms = CFG.rateLimitCooldownMs) {
  state.cooldowns[address] = new Date(Date.now() + ms).toISOString();
}

// ============ PROXIED FETCH ============
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
          await sleep(CFG.rateWaitMs * i);
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

// ============ TRENDING ============
async function fetchTrending() {
  const path = `/v1/tracks/trending?time=${CFG.trendingTime}&limit=${CFG.trendingMax}`;
  return audiusGet(path, 'trending', CFG.callTimeoutMs);
}

async function isFollowing(sdk, followerId, targetId) {
  try {
    const res = await readRetry(() => sdk.users.getUser({ id: targetId, userId: followerId }));
    const d = res && res.data;
    const flag = d && (d.doesCurrentUserFollow !== undefined ? d.doesCurrentUserFollow : d.does_current_user_follow);
    if (typeof flag === 'boolean') return flag;
  } catch (_) { /* fall through */ }
  return false;
}

const FOLLOW_STYLES = [
  (f, t) => ({ id: t, userId: f, followeeUserId: t }),
  (f, t) => ({ id: f, userId: f, followeeUserId: t }),
];

async function followUser(sdk, followerId, targetId, styleRef) {
  let lastErr = null;
  for (const i of styleRef.style === null ? [0, 1] : [styleRef.style]) {
    lastErr = null;
    try {
      await withTimeout(sdk.users.followUser(FOLLOW_STYLES[i](followerId, targetId)), CFG.callTimeoutMs, 'followUser');
      if (styleRef.style === null) styleRef.style = i;
      return true;
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e)) throw e;
      if (!statusOf(e) && /required parameter|invalid/i.test(String(e.message))) continue;
    }
  }
  throw lastErr || new Error('follow failed');
}

async function doTrendingFollow(sb, ctx, state, primary) {
  const trending = await fetchTrending();
  if (!trending.length) {
    log('[!] Trending fetch returned empty; will retry next cycle.');
    return;
  }

  const artists = [];
  const seen = new Set();
  for (let i = 0; i < trending.length; i++) {
    const rank = i + 1;
    if (rank < CFG.trendingMin || rank > CFG.trendingMax) continue;
    const u = trending[i].user || {};
    const id = u.id;
    if (id === undefined || id === null) continue;
    const sid = String(id);
    if (seen.has(sid)) continue;
    seen.add(sid);
    artists.push({ id: sid, handle: typeof u.handle === 'string' ? u.handle : null, rank });
  }
  if (!artists.length) {
    log('[!] No trending artists in target range.');
    state.last_trend_check = new Date().toISOString();
    await saveState(sb, ctx, state);
    return;
  }
  log(`[*] Trending check: ${artists.length} unique artist(s) in positions ${CFG.trendingMin}-${CFG.trendingMax}.`);

  const sdk = makeSdk(primary);
  const styleRef = { style: null };
  let followed = 0;
  let already = 0;
  let failed = 0;
  let rateLimitHit = false;

  for (const artist of artists) {
    if (state.followed[artist.id]) { already++; continue; }
    if (rateLimitHit) break;
    try {
      const isAlready = await isFollowing(sdk, primary.user_id, artist.id);
      if (isAlready) {
        state.followed[artist.id] = { handle: artist.handle, at: new Date().toISOString(), already: true };
        already++;
        await saveState(sb, ctx, state);
        continue;
      }
      await followUser(sdk, primary.user_id, artist.id, styleRef);
      state.followed[artist.id] = { handle: artist.handle, at: new Date().toISOString() };
      followed++;
      log(`[*] Followed @${artist.handle || artist.id} (#${artist.rank})`);
      await saveState(sb, ctx, state);
    } catch (e) {
      if (isRateLimit(e)) {
        log('[!] Rate limited on follow; will resume next cycle.');
        rateLimitHit = true;
        break;
      }
      failed++;
      if (VERBOSE) log(`[!] Follow @${artist.handle || artist.id} failed: ${errMsg(e).slice(0, 60)}`);
    }
    if (CFG.followDelayMs) await sleep(CFG.followDelayMs);
  }

  if (!rateLimitHit) {
    state.last_trend_check = new Date().toISOString();
  }
  await saveState(sb, ctx, state);
  log(`[*] Trending follow: ${followed} new, ${already} already, ${failed} failed${rateLimitHit ? ' (rate-limited, will resume)' : ''}.`);
}

function isTrendingDue(state) {
  if (FORCE_TRENDING) return true;
  if (!state.last_trend_check) return true;
  const last = Date.parse(state.last_trend_check);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= CFG.trendingCheckMs;
}

// ============ FEED / FOCUS TRACK SOURCES ============
async function fetchFeed(userId, limit = CFG.feedLimit) {
  const path = `/v1/users/${encodeURIComponent(userId)}/feed?limit=${limit}&app_name=tastemaker`;
  return audiusGet(path, 'feed', CFG.feedTimeoutMs);
}

async function fetchUserByHandle(handle) {
  const data = await audiusGet(`/v1/users/handle/${encodeURIComponent(handle)}?app_name=tastemaker`, 'user lookup', CFG.callTimeoutMs);
  const user = Array.isArray(data) ? data[0] : data;
  if (!user || !user.id) throw new Error(`user not found: @${handle}`);
  return user;
}

async function fetchUserTracks(userId) {
  const out = [];
  const seen = new Set();
  const page = 100;
  for (let offset = 0; offset < 2000; offset += page) {
    const data = await audiusGet(`/v1/users/${encodeURIComponent(userId)}/tracks?limit=${page}&offset=${offset}&sort=date&app_name=tastemaker`, 'user tracks', CFG.callTimeoutMs);
    const list = Array.isArray(data) ? data : [];
    for (const t of list) {
      const id = String(t.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        user: t.user || { id: userId },
        title: t.title || '',
        created_at: t.created_at || t.release_date || null,
      });
    }
    if (list.length < page) break;
  }
  return out;
}

function extractTracks(feedItems) {
  const out = [];
  const seen = new Set();
  for (const it of feedItems) {
    if (!it) continue;
    let t = null;
    if (it.id && it.user) t = it;
    else if (it.item && it.item.id) t = it.item;
    else if (it.item_id) t = { id: it.item_id, user: it.user || {} };
    else if (it.track_id) t = { id: it.track_id, user: it.user || {} };
    if (!t) continue;
    const id = String(t.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, user: t.user || {}, title: t.title || '', created_at: t.created_at || t.release_date || null });
  }
  return out;
}

function pruneFedTracks(state) {
  const cutoff = Date.now() - FEED_TRACK_MAX_AGE_MS;
  const entries = Object.entries(state.fed_tracks || {});
  const kept = entries.filter(([, v]) => {
    const t = Date.parse(v && v.seen_at);
    return Number.isFinite(t) && t >= cutoff;
  });
  if (kept.length > STATE_VERSION_MAX_TRACKS) {
    kept.sort((a, b) => Date.parse(b[1].seen_at) - Date.parse(a[1].seen_at));
    kept.length = STATE_VERSION_MAX_TRACKS;
  }
  state.fed_tracks = Object.fromEntries(kept);
}

<<<<<<< HEAD
// ============ TRACK DETAILS PRE-CHECK (feed mode only) ============
async function fetchTrackCounts(trackId) {
  const data = await audiusGet(`/v1/tracks/${encodeURIComponent(trackId)}?app_name=tastemaker`, 'track details', CFG.callTimeoutMs);
  const t = Array.isArray(data) ? data[0] : data;
  if (!t || typeof t !== 'object') throw new Error('track details missing');
  const favs = Number(t.favorite_count);
  const reps = Number(t.repost_count);
  if (!Number.isFinite(favs) || !Number.isFinite(reps)) throw new Error('track details have no favorite/repost counts');
  return { favs, reps };
}

function isAlreadyPopular({ favs, reps }) {
  const n = CFG.skipAtCount;
  return CFG.skipWhen === 'either' ? (favs >= n || reps >= n) : (favs >= n && reps >= n);
}

// ============ INTERACTIONS (favs + reposts only) ============
=======
>>>>>>> 4dd8ce1 (Add files via upload)
async function interactTask(state, trackId, kind, acct) {
  const entry = state.fed_tracks[trackId];
  if (!entry) return { status: 'skip' };
  const list = entry[kind];
  if (list.includes(acct.address)) return { status: 'skip' };
  try {
    let sdk = acct._sdk;
    if (!sdk) { sdk = makeSdk(acct); acct._sdk = sdk; }
    if (kind === 'favorited_by') {
      await withTimeout(sdk.tracks.favoriteTrack({ userId: acct.user_id, trackId }), CFG.callTimeoutMs, 'favoriteTrack');
    } else {
      await withTimeout(sdk.tracks.repostTrack({ userId: acct.user_id, trackId }), CFG.callTimeoutMs, 'repostTrack');
    }
    list.push(acct.address);
    return { status: 'ok' };
  } catch (e) {
    if (isRateLimit(e)) return { status: 'rate', error: e };
    if (classify(e) === 'permanent') {
      list.push(acct.address);
      return { status: 'perm', error: e };
    }
    return { status: 'retry', error: e };
  }
}

async function runBatch(tasks, concurrency) {
  for (let i = 0; i < tasks.length; i += concurrency) {
    const chunk = tasks.slice(i, i + concurrency).map(fn => fn());
    await Promise.all(chunk);
  }
}

async function interactTrackKind(state, trackId, kind, pool, targetCount) {
  const entry = state.fed_tracks[trackId];
  if (!entry) return { done: false, reason: 'no-entry' };
  if (!Array.isArray(entry[kind])) entry[kind] = [];
  const triedForThisTrack = new Set();
  let batchCount = 0;
  const MAX_BATCHES = 60;

  while (entry[kind].length < targetCount) {
    if (LOCK_LOST) return { done: false, reason: 'lock-lost' };
    if (++batchCount > MAX_BATCHES) return { done: false, reason: 'batch-cap', partial: entry[kind].length };

    pruneCooldowns(state);

    const doneSet = new Set(entry[kind]);
    const available = pool.filter(a =>
      !doneSet.has(a.address) &&
      !triedForThisTrack.has(a.address) &&
      !isOnCooldown(state, a.address)
    );

    if (!available.length) {
      return { done: false, reason: 'pool-exhausted', partial: entry[kind].length };
    }

    const need = targetCount - entry[kind].length;
    const batch = available.slice(0, Math.min(need, CFG.concurrency));

    let batchRateLimits = 0;
    const tasks = batch.map(acct => async () => {
      triedForThisTrack.add(acct.address);
      const result = await interactTask(state, trackId, kind, acct);
      if (result.status === 'rate') {
        markCooldown(state, acct.address);
        batchRateLimits++;
        if (VERBOSE) log(`[!] ${acct.address.slice(0, 8)}… rate-limited on ${kind} for ${trackId}; cooldown ${Math.round(CFG.rateLimitCooldownMs / 60000)}min.`);
      }
    });

    await runBatch(tasks, CFG.concurrency);

    if (batchRateLimits > 0) {
      await sleep(CFG.rateWaitMs);
    }
  }

  return { done: true, partial: entry[kind].length };
}

// ============ FEED BACKOFF ============
function shouldSkipFeed(state) {
  if (FORCE_FEED) return false;
  if (!state.feed_retry_at) return false;
  const t = Date.parse(state.feed_retry_at);
  if (!Number.isFinite(t)) return false;
  return Date.now() < t;
}

function recordFeedFailure(state) {
  state.feed_fail_count = (state.feed_fail_count || 0) + 1;
  const backoff = Math.min(
    CFG.feedBackoffBaseMs * 2 ** (state.feed_fail_count - 1),
    CFG.feedBackoffMaxMs
  );
  state.feed_retry_at = new Date(Date.now() + backoff).toISOString();
  return backoff;
}

function recordFeedSuccess(state) {
  state.feed_fail_count = 0;
  state.feed_retry_at = null;
}

// ============ DELEGATE TO comment.js ============
async function delegateComments(focus, tracks) {
  if (!focus || !focus.commentTarget || focus.commentTarget <= 0) return null;
  if (!tracks || !tracks.length) return null;

  let commentMod;
  try {
    commentMod = require('./comment');
  } catch (e) {
    log(`[!] Focus: cannot load ./comment.js (${e.message}); skipping comment step.`);
    return null;
  }
  if (!commentMod || typeof commentMod.runComments !== 'function') {
    log('[!] Focus: ./comment.js does not export runComments(); skipping comment step.');
    return null;
  }

  try {
    const result = await commentMod.runComments({
      handle: focus.handle,
      tracks: tracks.map(t => ({ id: t.id, title: t.title || '' })),
      target: focus.commentTarget,
    });
    return result && result.status;
  } catch (e) {
    log(`[!] Focus: comment step failed: ${errMsg(e).slice(0, 100)}`);
    return 'ERROR';
  }
}

// ============ NEW: DELEGATE TO stream.js ============
async function delegateStreams(focus, tracks) {
  if (!focus || !focus.streamTarget || focus.streamTarget <= 0) return null;
  if (!tracks || !tracks.length) return null;

  let streamMod;
  try {
    streamMod = require('./stream');
  } catch (e) {
    log(`[!] Focus: cannot load ./stream.js (${e.message}); skipping stream step.`);
    return null;
  }
  if (!streamMod || typeof streamMod.runStreams !== 'function') {
    log('[!] Focus: ./stream.js does not export runStreams(); skipping stream step.');
    return null;
  }

  try {
    const result = await streamMod.runStreams({
      tracks: tracks.map(t => ({ id: t.id, title: t.title || '' })),
      target: focus.streamTarget,
      excludeUser: focus.excludeUser || null,
    });
    return result && result.status;
  } catch (e) {
    log(`[!] Focus: stream step failed: ${errMsg(e).slice(0, 100)}`);
    return 'ERROR';
  }
}

// ============ FEED / FOCUS WORKER ============
async function doFeedInteract(sb, ctx, state, pool, primary, focus) {
  let tracks;
  let trackSource;

  if (focus) {
    let user;
    try {
      user = await fetchUserByHandle(focus.handle);
    } catch (e) {
      log(`[!] Could not look up @${focus.handle}: ${errMsg(e).slice(0, 80)}`);
      return;
    }
    log(`[*] Focus: @${user.handle || focus.handle} (${user.id}).`);
    // Remember the target user so delegateStreams can exclude their alts from the pool.
    focus.excludeUser = String(user.id);

    try {
      tracks = await fetchUserTracks(user.id);
    } catch (e) {
      log(`[!] Could not fetch tracks for @${focus.handle}: ${errMsg(e).slice(0, 80)}`);
      return;
    }
    log(`[*] Focus: ${tracks.length} total track(s) found.`);

    // Only process today's uploads.
    const today = ctx.today;
    const tz = CFG.dayTimezone;
    const todayTracks = tracks.filter(t => t.created_at && ymdInTz(t.created_at, tz) === today);

    if (!todayTracks.length) {
      log(`[!] Focus: no latest tracks found — @${user.handle || focus.handle} has no tracks uploaded today (${today} ${tz}). Exiting.`);
      return;
    }

    todayTracks.sort((a, b) => {
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      return bt - at;
    });
    log(`[*] Focus: ${todayTracks.length} of ${tracks.length} track(s) uploaded today (${today} ${tz}).`);
    tracks = todayTracks;

    const before = pool.length;
    pool = pool.filter(a => String(a.user_id) !== String(user.id));
    if (pool.length !== before) {
      log(`[*] Focus: removed ${before - pool.length} account(s) matching the target from the pool.`);
    }

    if (CFG.focusMaxTracks > 0 && tracks.length > CFG.focusMaxTracks) {
      const cap = tracks.slice(0, CFG.focusMaxTracks);
      log(`[*] Focus: capping to ${cap.length} of ${tracks.length} today-track(s) (newest first, FOCUS_MAX_TRACKS=${CFG.focusMaxTracks}).`);
      tracks = cap;
    }

    trackSource = `@${user.handle || focus.handle} (today)`;
  } else {
    let feedItems;
    try {
      feedItems = await fetchFeed(primary.user_id, CFG.feedLimit);
    } catch (e) {
      const backoff = recordFeedFailure(state);
      await saveState(sb, ctx, state);
      log(`[!] Feed fetch failed (attempt ${state.feed_fail_count}, retry in ${Math.round(backoff / 1000)}s): ${errMsg(e).slice(0, 60)}`);
      return;
    }
    recordFeedSuccess(state);
    tracks = extractTracks(feedItems);
    trackSource = 'feed';
  }

  if (!tracks.length) {
    log(`[*] ${trackSource}: no tracks.`);
    await saveState(sb, ctx, state);
    return;
  }

  const targetFavRep = focus ? focus.target : (CFG._feedTarget || TARGET_INTERACTIONS);
  const skipFavRep = focus && targetFavRep === 0;

  let pending = [];
  if (!skipFavRep) {
    for (const t of tracks) {
      const entry = state.fed_tracks[t.id];
      if (!entry) { pending.push(t); continue; }
      if (entry.skipped) continue;
      const favs = (entry.favorited_by || []).length;
      const reps = (entry.reposted_by || []).length;
      if (favs < targetFavRep || reps < targetFavRep) pending.push(t);
    }
  }

  const isFirstRun = focus ? false : (FORCE_FIRST_RUN || !state.first_run_done);
  if (isFirstRun) {
    const sorted = [...pending].sort((a, b) => {
      const at = a.created_at ? Date.parse(a.created_at) : 0;
      const bt = b.created_at ? Date.parse(b.created_at) : 0;
      if (at && bt) return bt - at;
      return 0;
    });
    const keep = sorted.slice(0, CFG.firstRunTracks);
    const skip = sorted.slice(CFG.firstRunTracks);
    for (const t of skip) {
      state.fed_tracks[t.id] = {
        seen_at: new Date().toISOString(),
        favorited_by: [],
        reposted_by: [],
        skipped: true,
        skip_reason: 'first-run-backlog',
      };
    }
    pending = keep;
    state.first_run_done = true;
    log(`[*] First run: taking latest ${keep.length}, skipping ${skip.length} older track(s) from backlog.`);
  }

  // Nothing to do for favs/reposts → still delegate comments/streams on ALL tracks.
  if (!pending.length) {
    log(`[*] ${trackSource}: ${tracks.length} track(s), nothing to do for fav/repost.`);
    await saveState(sb, ctx, state);
    if (focus) {
      const cmtStatus = await delegateComments(focus, tracks);
      if (cmtStatus) log(`[*] Focus: comment step ${cmtStatus}.`);
      const strStatus = await delegateStreams(focus, tracks);
      if (strStatus) log(`[*] Focus: stream step ${strStatus}.`);
    }
    return;
  }

<<<<<<< HEAD
  const limit = focus
    ? Infinity
    : (isFirstRun ? Infinity : CFG.maxTracksPerRun);
  const actionWord = skipFavRep ? 'skipping fav/repost' : `${targetFavRep} favs + ${targetFavRep} reposts per track`;
  log(`[*] ${trackSource}: ${tracks.length} track(s), ${pending.length} pending. Target: ${actionWord}. Processing up to ${Number.isFinite(limit) ? limit : pending.length} this run.`);

  let processed = 0;
  for (const t of pending) {
    if (LOCK_LOST) break;
    if (processed >= limit) break;
    const titlePart = t.title ? ` "${t.title.slice(0, 40)}"` : '';
    const existing = state.fed_tracks[t.id];

    if (!focus) {
      const started = existing && (((existing.favorited_by || []).length + (existing.reposted_by || []).length) > 0);
      if (!started) {
        let counts;
        try {
          counts = await fetchTrackCounts(t.id);
        } catch (e) {
          log(`[!] Track ${t.id}${titlePart} | could not read track details (${errMsg(e).slice(0, 60)}); not interacting now, will retry.`);
          continue;
        }
        if (isAlreadyPopular(counts)) {
          state.fed_tracks[t.id] = {
            seen_at: new Date().toISOString(),
            favorited_by: [],
            reposted_by: [],
            skipped: true,
            skip_reason: 'already-popular',
            favorite_count: counts.favs,
            repost_count: counts.reps,
          };
          await saveState(sb, ctx, state);
          log(`[*] Track ${t.id}${titlePart} | FAV ${counts.favs} | REP ${counts.reps} | skipped (${CFG.skipWhen === 'either' ? 'either count' : 'both counts'} already >= ${CFG.skipAtCount}).`);
          continue;
        }
        if (VERBOSE) log(`[*] Track ${t.id}${titlePart} | FAV ${counts.favs} | REP ${counts.reps} | below ${CFG.skipAtCount}, interacting.`);
      }
    }

    processed++;
=======
  const toProcess = isFirstRun ? newTracks : newTracks.slice(0, CFG.maxTracksPerRun);
  log(`[*] Feed: ${tracks.length} tracks, ${newTracks.length} pending, processing ${toProcess.length} this run.`);

  for (const t of toProcess) {
    if (LOCK_LOST) break;
>>>>>>> 4dd8ce1 (Add files via upload)
    if (!state.fed_tracks[t.id]) {
      state.fed_tracks[t.id] = {
        seen_at: new Date().toISOString(),
        favorited_by: [],
        reposted_by: [],
        title: t.title || '',
      };
    }
    const entry = state.fed_tracks[t.id];
    if (!entry.title && t.title) entry.title = t.title;

    const favResult = await interactTrackKind(state, t.id, 'favorited_by', pool, targetFavRep);
    await saveState(sb, ctx, state);
    if (!favResult.done && favResult.reason === 'lock-lost') break;

    const repResult = await interactTrackKind(state, t.id, 'reposted_by', pool, targetFavRep);
    await saveState(sb, ctx, state);
    if (!repResult.done && repResult.reason === 'lock-lost') break;

    const tags = [];
    if (!favResult.done) tags.push(`fav:${favResult.reason}`);
    if (!repResult.done) tags.push(`rep:${repResult.reason}`);
    const suffix = tags.length ? ` (${tags.join(', ')})` : '';
<<<<<<< HEAD
    log(`[*] Track ${t.id}${titlePart} | FAV ${(entry.favorited_by || []).length}/${targetFavRep} | REP ${(entry.reposted_by || []).length}/${targetFavRep}${suffix}`);
=======
    const titlePart = t.title ? ` "${t.title.slice(0, 40)}"` : '';
    log(`[*] Track ${t.id}${titlePart} | FAV ${entry.favorited_by.length}/${TARGET_INTERACTIONS} | REP ${entry.reposted_by.length}/${TARGET_INTERACTIONS}${suffix}`);
>>>>>>> 4dd8ce1 (Add files via upload)

    if (CFG.actionDelayMs) await sleep(CFG.actionDelayMs);
  }

  if (focus) {
    if (LOCK_LOST) {
      log('[!] Focus: tastemaker lock lost; skipping comment/stream delegation.');
    } else {
      const forDelegation = processed > 0 ? pending.slice(0, processed) : tracks;
      if (!forDelegation.length) {
        log('[*] Focus: no tracks to delegate this run.');
      } else {
        log(`[*] Focus: handing ${forDelegation.length} track(s) to comment.js (target ${focus.commentTarget} per track).`);
        const cmtStatus = await delegateComments(focus, forDelegation);
        if (cmtStatus === 'LOCKED') {
          log('[!] Focus: comment lock held by another run; skipping comment step this cycle.');
        } else if (cmtStatus) {
          log(`[*] Focus: comment step ${cmtStatus}.`);
        }

        if (focus.streamTarget > 0) {
          log(`[*] Focus: handing ${forDelegation.length} track(s) to stream.js (target ${focus.streamTarget} streams per track).`);
          const strStatus = await delegateStreams(focus, forDelegation);
          if (strStatus === 'LOCKED') {
            log('[!] Focus: stream lock held by another run; skipping stream step this cycle.');
          } else if (strStatus) {
            log(`[*] Focus: stream step ${strStatus}.`);
          }
        }
      }
    }
  }
}

// ============ MAIN ============
async function runTastemaker({ now = new Date(), focus = null } = {}) {
  const ctx = buildContext(now);
  const sb = connectSupabase();

  const primary = await fetchPrimary(sb);
  if (!hasCreds(primary)) throw new Error(`primary account ${TARGET_ADDRESS} has no complete credentials (need user_id + app_data.api_key + api_secret + bearer_token)`);

  const lock = await acquireLock(sb, ctx);
  if (!lock) return { status: 'LOCKED' };
  HELD_LOCK = lock;
  LOCK_LOST = null;
  const stopHeartbeat = startHeartbeat(sb, ctx);

  try {
    const { data: primaryRow } = await sb.from('audius')
      .select('t_maker').eq('address', TARGET_ADDRESS).limit(1);
    const state = normalizeTmaker(primaryRow && primaryRow[0] && primaryRow[0].t_maker, ctx.weekStart);

    pruneCooldowns(state);

    const helpers = await fetchHelperPool(sb, TARGET_ADDRESS);
    if (!helpers.length) {
      log('[!] No helper accounts with creds available.');
    }
    const pool = [primary, ...shuffle(helpers)];
    const availableNow = pool.filter(a => !isOnCooldown(state, a.address)).length;
    log(`[*] Pool: ${pool.length} accounts (${availableNow} available, ${pool.length - availableNow} cooling down).`);

    pruneFedTracks(state);

    if (focus) {
      log('[*] Focus mode: skipping trending follow.');
    } else if (isTrendingDue(state)) {
      log(`[*] Trending follow cycle due (last: ${state.last_trend_check || 'never'}).`);
      try {
        await doTrendingFollow(sb, ctx, state, primary);
      } catch (e) {
        log(`[!] Trending cycle failed; will retry next run: ${errMsg(e).slice(0, 80)}`);
      }
    } else {
      const next = new Date(Date.parse(state.last_trend_check) + CFG.trendingCheckMs);
      if (VERBOSE) log(`[*] Trending cycle next due: ${next.toISOString()}.`);
    }

    if (LOCK_LOST) throw LOCK_LOST;

    if (!focus && shouldSkipFeed(state)) {
      const remain = Math.round((Date.parse(state.feed_retry_at) - Date.now()) / 1000);
      log(`[*] Feed backoff active (${remain}s remaining, ${state.feed_fail_count} consecutive failures). Skipping feed.`);
    } else {
      await doFeedInteract(sb, ctx, state, pool, primary, focus);
    }

    await saveState(sb, ctx, state);
    return { status: 'OK', pool: pool.length };
  } finally {
    stopHeartbeat();
    HELD_LOCK = null;
    await releaseLock(sb, ctx, lock);
  }
}

// ============ LOOP CONTROL ============
let shuttingDown = false;
let shutdownSignal = null;

function installSignalHandlers() {
  const handler = sig => {
    if (shuttingDown) {
      log(`[!] ${sig} received again; forcing exit.`);
      process.exit(1);
    }
    shuttingDown = true;
    shutdownSignal = sig;
    log(`[*] ${sig} received; will exit after current cycle.`);
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

async function sleepInterruptible(ms) {
  const deadline = Date.now() + ms;
  while (!shuttingDown && Date.now() < deadline) {
    await sleep(Math.min(1000, deadline - Date.now()));
  }
}

async function loopForever(focus) {
  installSignalHandlers();

  if (focus) {
    log('[*] Focus mode: running a single cycle then exiting.');
    try {
      await runTastemaker({ focus });
    } catch (e) {
      if (e instanceof LockLostError) log('[!] Lock lost.');
      else log(`[!] Focus cycle failed: ${errMsg(e).slice(0, 100)}`);
      process.exit(1);
    }
    return;
  }

  const waitSec = Math.round(CFG.loopIntervalMs / 1000);
  log(`[*] Loop mode active (interval ${waitSec}s). Press Ctrl+C to stop.`);

  let cycle = 0;
  while (!shuttingDown) {
    cycle++;
    const started = Date.now();
    if (cycle > 1) log(`[*] ─── Cycle ${cycle} ───`);
    try {
      await runTastemaker();
    } catch (e) {
      if (e instanceof LockLostError) {
        log(`[!] Lock lost; will retry next cycle.`);
      } else {
        log(`[!] Cycle failed: ${errMsg(e).slice(0, 100)}`);
      }
    }
    const elapsed = Math.round((Date.now() - started) / 1000);
    if (shuttingDown) break;
    log(`[*] Cycle ${cycle} complete in ${elapsed}s. Next scan in ${waitSec}s.`);
    await sleepInterruptible(CFG.loopIntervalMs);
  }
  log(`[*] Tastemaker stopped${shutdownSignal ? ` (${shutdownSignal})` : ''}.`);
}

// ============ ENTRY ============
if (require.main === module) {
  const focus = parseCliFocus();

  if (ONCE) {
    runTastemaker({ focus })
      .then(() => process.exit(0))
      .catch(err => {
        console.error('[!] Fatal error:', err.message || err);
        process.exit(1);
      });
  } else if (focus) {
    loopForever(focus).catch(err => {
      console.error('[!] Fatal error:', err.message || err);
      process.exit(1);
    });
  } else {
    loopForever(null).catch(err => {
      console.error('[!] Fatal error:', err.message || err);
      process.exit(1);
    });
  }
}

<<<<<<< HEAD
module.exports = {
  runTastemaker,
  buildContext,
  CFG,
  TARGET_INTERACTIONS,
  fetchTrackCounts,
  isAlreadyPopular,
  doFeedInteract,
  fetchUserByHandle,
  fetchUserTracks,
  parseCliFocus,
  parseCount,
  delegateComments,
  delegateStreams,
  ymdInTz,
};
=======
module.exports = { runTastemaker, buildContext, CFG, TARGET_INTERACTIONS };
>>>>>>> 4dd8ce1 (Add files via upload)
