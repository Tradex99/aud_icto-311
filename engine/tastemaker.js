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

  console.log(`[*] Route: Cloudflare proxy (${PROXY_URLS.length})`);
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
};

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
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
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

// ============ FEED ============
async function fetchFeed(userId, limit = CFG.feedLimit) {
  const path = `/v1/users/${encodeURIComponent(userId)}/feed?limit=${limit}&app_name=tastemaker`;
  return audiusGet(path, 'feed', CFG.feedTimeoutMs);
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
  const triedForThisTrack = new Set();
  let batchCount = 0;
  const MAX_BATCHES = 30;

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

async function doFeedInteract(sb, ctx, state, pool, primary) {
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

  const tracks = extractTracks(feedItems);
  if (!tracks.length) {
    log('[*] Feed: empty.');
    await saveState(sb, ctx, state);
    return;
  }

  let newTracks = [];
  for (const t of tracks) {
    const entry = state.fed_tracks[t.id];
    if (!entry) { newTracks.push(t); continue; }
    if (entry.skipped) continue;
    const favs = (entry.favorited_by || []).length;
    const reps = (entry.reposted_by || []).length;
    if (favs < TARGET_INTERACTIONS || reps < TARGET_INTERACTIONS) newTracks.push(t);
  }

  const isFirstRun = FORCE_FIRST_RUN || !state.first_run_done;
  if (isFirstRun) {
    const sorted = [...newTracks].sort((a, b) => {
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
    newTracks = keep;
    state.first_run_done = true;
    log(`[*] First run: taking latest ${keep.length}, skipping ${skip.length} older track(s) from backlog.`);
  }

  if (!newTracks.length) {
    log(`[*] Feed: ${tracks.length} track(s), nothing new to interact with.`);
    await saveState(sb, ctx, state);
    return;
  }

  const toProcess = isFirstRun ? newTracks : newTracks.slice(0, CFG.maxTracksPerRun);
  log(`[*] Feed: ${tracks.length} tracks, ${newTracks.length} pending, processing ${toProcess.length} this run.`);

  for (const t of toProcess) {
    if (LOCK_LOST) break;
    if (!state.fed_tracks[t.id]) {
      state.fed_tracks[t.id] = { seen_at: new Date().toISOString(), favorited_by: [], reposted_by: [] };
    }
    const entry = state.fed_tracks[t.id];

    const favResult = await interactTrackKind(state, t.id, 'favorited_by', pool, TARGET_INTERACTIONS);
    await saveState(sb, ctx, state);
    if (!favResult.done && favResult.reason === 'lock-lost') break;

    const repResult = await interactTrackKind(state, t.id, 'reposted_by', pool, TARGET_INTERACTIONS);
    await saveState(sb, ctx, state);
    if (!repResult.done && repResult.reason === 'lock-lost') break;

    const tags = [];
    if (!favResult.done) tags.push(`fav:${favResult.reason}`);
    if (!repResult.done) tags.push(`rep:${repResult.reason}`);
    const suffix = tags.length ? ` (${tags.join(', ')})` : '';
    const titlePart = t.title ? ` "${t.title.slice(0, 40)}"` : '';
    log(`[*] Track ${t.id}${titlePart} | FAV ${entry.favorited_by.length}/${TARGET_INTERACTIONS} | REP ${entry.reposted_by.length}/${TARGET_INTERACTIONS}${suffix}`);

    if (CFG.actionDelayMs) await sleep(CFG.actionDelayMs);
  }
}

// ============ MAIN ============
async function runTastemaker({ now = new Date() } = {}) {
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
    log(`[*] Pool: ${pool.length} accounts (${availableNow} available, ${pool.length - availableNow} cooling down). Target ${TARGET_INTERACTIONS} interactions per track per action.`);

    pruneFedTracks(state);

    if (isTrendingDue(state)) {
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

    if (shouldSkipFeed(state)) {
      const remain = Math.round((Date.parse(state.feed_retry_at) - Date.now()) / 1000);
      log(`[*] Feed backoff active (${remain}s remaining, ${state.feed_fail_count} consecutive failures). Skipping feed.`);
    } else {
      await doFeedInteract(sb, ctx, state, pool, primary);
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

async function loopForever() {
  installSignalHandlers();
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
  if (ONCE) {
    runTastemaker()
      .then(() => process.exit(0))
      .catch(err => {
        console.error('[!] Fatal error:', err.message || err);
        process.exit(1);
      });
  } else {
    loopForever().catch(err => {
      console.error('[!] Fatal error:', err.message || err);
      process.exit(1);
    });
  }
}

module.exports = { runTastemaker, buildContext, CFG, TARGET_INTERACTIONS };