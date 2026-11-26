#!/usr/bin/env node
'use strict';

// ============ CONSTANTS ============
const DEFAULT_STREAM_TARGET = 1000;
const DEFAULT_STREAM_CONCURRENCY = 10;
const DEFAULT_STREAM_DURATION_SEC = 30;
const FEED_TRACK_MAX_AGE_MS = 24 * 3600 * 1000;
const STATE_VERSION_MAX_TRACKS = 1000;

// ============ IMPORTS ============
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ============ PROXY (same pattern as tastemaker.js) ============
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

// ============ LOG / FLAGS ============
const log = console.log.bind(console);
const VERBOSE = /^(1|true|yes)$/i.test(process.env.VERBOSE || '') || process.argv.includes('--verbose') || process.argv.includes('-v');
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
const TARGET_ADDRESS = 'qringgreen@gmail.com';

// ============ CONFIG ============
const CFG = {
  timezone: process.env.RESET_TIMEZONE || 'America/Los_Angeles',
  resetHour: Number(process.env.RESET_HOUR ?? 12),
  streamConcurrency: Number(process.env.STREAM_CONCURRENCY || DEFAULT_STREAM_CONCURRENCY),
  streamDurationMs: Number(process.env.STREAM_DURATION_SECONDS || DEFAULT_STREAM_DURATION_SEC) * 1000,
  callTimeoutMs: Number(process.env.CALL_TIMEOUT_SECONDS || 20) * 1000,
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  rateLimitCooldownMs: Number(process.env.RATE_LIMIT_COOLDOWN_MINUTES || 3) * 60000,
  rateWaitMs: Number(process.env.RATE_WAIT_MS || 3000),
  lockTtlMs: Number(process.env.STREAM_LOCK_TTL_MINUTES || 60) * 60000,
  lockStaleMs: Number(process.env.LOCK_STALE_SECONDS || 120) * 1000,
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

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function buildContext(now) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: CFG.timezone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
    }).formatToParts(new Date(now.getTime() - CFG.resetHour * 3600000));
  } catch (e) {
    throw new Error(`Invalid timezone (RESET_TIMEZONE "${CFG.timezone}"): ${e.message}`);
  }
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const weekDay = `${p.year}-${p.month}-${p.day}`;
  const dayIndex = ['Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].indexOf(p.weekday);
  return { weekStart: addDays(weekDay, -dayIndex), tz: CFG.timezone };
}

// ============ SUPABASE ============
class StreamLockLostError extends Error {}

function connectSupabase() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`db.txt not found at: ${DB_FILE}`);
  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
  return createClient(urlMatch[1], keyMatch[1]);
}

const hasCreds = r => !!(r && r.user_id && r.app_data && r.app_data.api_key && r.app_data.api_secret && r.app_data.bearer_token);

// ============ STATE (stream-only fields) ============
function normalizeStreamState(raw, weekStart) {
  if (isObj(raw) && raw.week_start === weekStart) {
    const h = JSON.parse(JSON.stringify(raw));
    h.week_start = weekStart;
    if (!isObj(h.streams)) h.streams = {};
    if (!isObj(h.cooldowns)) h.cooldowns = {};
    // preserve week-scoped fields tastemaker owns — we won't touch them
    return h;
  }
  const h = { week_start: weekStart, streams: {}, cooldowns: {} };
  if (isObj(raw)) {
    if (raw.lock) h.lock = raw.lock;
    if (raw.stream_lock) h.stream_lock = raw.stream_lock;
    if (isObj(raw.cooldowns)) {
      const now = Date.now();
      for (const [addr, exp] of Object.entries(raw.cooldowns)) {
        const t = Date.parse(exp);
        if (Number.isFinite(t) && t > now) h.cooldowns[addr] = exp;
      }
    }
  }
  return h;
}

let HELD_STREAM_LOCK = null;
let STREAM_LOCK_LOST = null;

async function updateTmaker(sb, address, weekStart, mutate) {
  let lastErr;
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      const { data, error } = await sb.from('audius').select('address, t_maker').eq('address', address).limit(1);
      if (error) throw new Error(error.message);
      if (!data || !data[0]) throw Object.assign(new Error(`account row not found: ${address}`), { fatal: true });
      const raw = data[0].t_maker;
      const hist = normalizeStreamState(raw, weekStart);

      if (address === TARGET_ADDRESS && HELD_STREAM_LOCK &&
          !(hist.stream_lock && hist.stream_lock.token === HELD_STREAM_LOCK.token)) {
        throw new StreamLockLostError('stream lock was taken over by another run');
      }

      if (mutate(hist) === false) return hist;

      const prevV = isObj(raw) && Number.isInteger(raw.v) ? raw.v : null;
      hist.v = (prevV || 0) + 1;
      let q = sb.from('audius').update({ t_maker: hist }).eq('address', address);
      q = prevV === null ? q.is('t_maker->>v', null) : q.eq('t_maker->>v', String(prevV));
      const res = await q.select('address, t_maker');
      if (res.error) throw new Error(res.error.message);
      if (res.data && res.data.length === 1) return normalizeStreamState(res.data[0].t_maker, weekStart);

      lastErr = new Error(`update conflict for ${address}`);
      await sleep(100 + Math.random() * 300);
    } catch (e) {
      if (e instanceof StreamLockLostError || e.fatal) throw e;
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

async function acquireStreamLock(sb, ctx) {
  const token = crypto.randomUUID();
  let blocked = null;
  await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
    blocked = null;
    if (h.stream_lock && h.stream_lock.token) {
      const why = lockStaleReason(h.stream_lock);
      if (!why) { blocked = h.stream_lock; return false; }
      log('[*] Stream: took over stream lock from a stopped run.');
    }
    h.stream_lock = {
      token, acquired_at: new Date().toISOString(), beat: new Date().toISOString(),
      expires_at: new Date(Date.now() + CFG.lockTtlMs).toISOString(),
      pid: process.pid, host: os.hostname(),
    };
    return true;
  });
  if (blocked) return null;
  return { token };
}

function startHeartbeat(sb, ctx) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || STREAM_LOCK_LOST) return;
    busy = true;
    try {
      await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
        if (!h.stream_lock) return false;
        h.stream_lock.beat = new Date().toISOString();
        h.stream_lock.expires_at = new Date(Date.now() + CFG.lockTtlMs).toISOString();
        return true;
      });
    } catch (e) { if (e instanceof StreamLockLostError) STREAM_LOCK_LOST = e; }
    finally { busy = false; }
  }, Math.max(5000, CFG.lockStaleMs / 4));
  timer.unref();
  return () => clearInterval(timer);
}

async function releaseStreamLock(sb, ctx, lock) {
  if (!lock) return;
  try {
    await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
      if (!h.stream_lock || h.stream_lock.token !== lock.token) return false;
      delete h.stream_lock;
      return true;
    });
  } catch (e) {
    console.error(`[!] Stream: could not release lock (expires on its own): ${e.message}`);
  }
}

// Only write stream.js-owned fields; leave tastemaker's alone.
async function saveStreamState(sb, ctx, streams, cooldowns) {
  await updateTmaker(sb, TARGET_ADDRESS, ctx.weekStart, h => {
    if (streams !== undefined) h.streams = streams;
    if (cooldowns !== undefined) {
      const merged = { ...(h.cooldowns || {}) };
      const now = Date.now();
      for (const [k, v] of Object.entries(cooldowns)) {
        const t = Date.parse(v);
        if (Number.isFinite(t) && t > now) {
          if (!merged[k] || Date.parse(v) > Date.parse(merged[k])) merged[k] = v;
        }
      }
      h.cooldowns = merged;
    }
    return true;
  });
}

// ============ COOLDOWNS ============
function pruneCooldowns(state) {
  const now = Date.now();
  for (const [addr, exp] of Object.entries(state.cooldowns || {})) {
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

function pruneStreams(state, focus) {
  const entries = Object.entries(state.streams || {});
  let kept;
  if (focus) {
    kept = entries.slice();
  } else {
    const cutoff = Date.now() - FEED_TRACK_MAX_AGE_MS;
    kept = entries.filter(([, v]) => {
      const t = Date.parse(v && v.updated_at);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  if (kept.length > STATE_VERSION_MAX_TRACKS) {
    kept.sort((a, b) => Date.parse(b[1].updated_at) - Date.parse(a[1].updated_at));
    kept.length = STATE_VERSION_MAX_TRACKS;
  }
  state.streams = Object.fromEntries(kept);
}

// ============ HELPER POOL ============
async function fetchPrimary(sb) {
  const { data, error } = await withRetry(async () => {
    const { data, error } = await sb.from('audius')
      .select('address, handle, user_id, app_data, t_maker')
      .eq('address', TARGET_ADDRESS).limit(1);
    if (error) { const e = new Error(error.message); e.fatal = true; throw e; }
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

// ============ STREAM ACTION ============
// Hits /v1/tracks/{id}/stream with the helper's user_id and pulls the first
// chunk of audio so the discovery node registers the play, then disconnects.
async function streamOnce(acct, trackId) {
  const url = `https://api.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?user_id=${encodeURIComponent(acct.user_id)}&app_name=tastemaker`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.callTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { Accept: '*/*', Range: 'bytes=0-4095' },
    });
    if (!res.ok && res.status !== 206) {
      throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    }
    // Read a single chunk to register the play, then cancel the body.
    if (res.body) {
      try {
        const reader = res.body.getReader();
        await reader.read();
        try { await reader.cancel(); } catch (_) {}
      } catch (_) {}
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

// ============ RUN ============
async function runStreams({ tracks, target, excludeUser } = {}) {
  if (!Array.isArray(tracks) || !tracks.length) {
    return { status: 'OK', streams: 0 };
  }
  const n = Number(target);
  if (!Number.isInteger(n) || n <= 0) {
    return { status: 'OK', streams: 0 };
  }

  let sb;
  try { sb = connectSupabase(); }
  catch (e) { log(`[!] Stream: ${e.message}`); return { status: 'ERROR' }; }

  const ctx = buildContext(new Date());
  const lock = await acquireStreamLock(sb, ctx);
  if (!lock) return { status: 'LOCKED' };

  HELD_STREAM_LOCK = lock;
  STREAM_LOCK_LOST = null;
  const stopHeartbeat = startHeartbeat(sb, ctx);

  try {
    const primary = await fetchPrimary(sb);
    if (!hasCreds(primary)) {
      log('[!] Stream: primary account has no complete credentials.');
      return { status: 'ERROR' };
    }
    const helpers = await fetchHelperPool(sb, TARGET_ADDRESS);
    let pool = [primary, ...shuffle(helpers)].filter(hasCreds);
    if (excludeUser) {
      const before = pool.length;
      pool = pool.filter(a => String(a.user_id) !== String(excludeUser));
      if (pool.length !== before) {
        log(`[*] Stream: excluded ${before - pool.length} account(s) matching target user.`);
      }
    }
    if (!pool.length) {
      log('[!] Stream: no accounts available.');
      return { status: 'ERROR' };
    }

    const { data: row } = await sb.from('audius').select('t_maker').eq('address', TARGET_ADDRESS).limit(1);
    const state = normalizeStreamState(row && row[0] && row[0].t_maker, ctx.weekStart);
    pruneCooldowns(state);
    pruneStreams(state, true);

    log(`[*] Stream: pool=${pool.length} accounts | ${tracks.length} track(s) | target ${n} streams each | concurrency ${CFG.streamConcurrency}.`);

    const saveFn = () => saveStreamState(sb, ctx, state.streams, state.cooldowns);
    let totalDone = 0;
    let totalFailed = 0;

    for (const t of tracks) {
      if (STREAM_LOCK_LOST) break;
      const trackId = String(t.id);
      const titlePart = t.title ? ` "${String(t.title).slice(0, 40)}"` : '';

      if (!state.streams[trackId]) {
        state.streams[trackId] = { count: 0, updated_at: new Date().toISOString() };
      }
      const entry = state.streams[trackId];

      if (entry.count >= n) {
        log(`[*] Stream: track ${trackId}${titlePart} already complete (${entry.count}/${n}).`);
        continue;
      }

      let iterations = 0;
      let consecutiveWaits = 0;
      const MAX_ITERATIONS = 60;

      while (entry.count < n) {
        if (STREAM_LOCK_LOST) break;
        if (++iterations > MAX_ITERATIONS) {
          log(`[!] Stream: track ${trackId}${titlePart} hit batch cap (${entry.count}/${n}).`);
          break;
        }

        pruneCooldowns(state);
        const available = pool.filter(a => !isOnCooldown(state, a.address));
        if (!available.length) {
          if (++consecutiveWaits > 10) {
            log(`[!] Stream: track ${trackId}${titlePart} — all accounts stuck on cooldown; stopping.`);
            break;
          }
          await sleep(CFG.rateWaitMs);
          continue;
        }
        consecutiveWaits = 0;

        const need = n - entry.count;
        const batch = shuffle(available).slice(0, Math.min(need, CFG.streamConcurrency));

        let rateLimited = 0;
        await Promise.all(batch.map(async acct => {
          try {
            await streamOnce(acct, trackId);
            entry.count++;
            entry.updated_at = new Date().toISOString();
            totalDone++;
          } catch (e) {
            totalFailed++;
            if (isRateLimit(e)) {
              markCooldown(state, acct.address);
              rateLimited++;
            } else if (VERBOSE) {
              log(`[!] Stream: ${acct.address.slice(0, 8)}… failed on ${trackId}: ${errMsg(e).slice(0, 60)}`);
            }
          }
        }));

        await saveFn();

        if (rateLimited > 0) await sleep(CFG.rateWaitMs);
      }

      log(`[*] Stream: track ${trackId}${titlePart} → ${entry.count}/${n}.`);
    }

    await saveFn();
    return { status: 'OK', streams: totalDone, failed: totalFailed };
  } catch (e) {
    if (e instanceof StreamLockLostError) return { status: 'LOCKED' };
    log(`[!] Stream: ${errMsg(e).slice(0, 120)}`);
    return { status: 'ERROR' };
  } finally {
    stopHeartbeat();
    HELD_STREAM_LOCK = null;
    await releaseStreamLock(sb, ctx, lock);
  }
}

// ============ CLI ============
// Usage: ./stream.js track=id1,id2 target=1000 [--verbose]
if (require.main === module) {
  const args = process.argv.slice(2);
  const trackArg = args.find(a => /^track=/i.test(a));
  const targetArg = args.find(a => /^target=/i.test(a));

  if (!trackArg) {
    console.error('[!] Usage: ./stream.js track=id1,id2 [target=1000] [--verbose]');
    process.exit(1);
  }

  const trackIds = trackArg.slice(trackArg.indexOf('=') + 1).split(',')
    .map(s => s.trim()).filter(Boolean);
  if (!trackIds.length) {
    console.error('[!] No track IDs supplied.');
    process.exit(1);
  }

  let target = DEFAULT_STREAM_TARGET;
  if (targetArg) {
    const raw = targetArg.slice(targetArg.indexOf('=') + 1).trim().toLowerCase();
    const m = raw.match(/^(\d+(?:\.\d+)?)([kmb])?$/);
    if (m) {
      const mult = m[2] === 'k' ? 1000 : m[2] === 'm' ? 1000000 : m[2] === 'b' ? 1000000000 : 1;
      target = Math.floor(parseFloat(m[1]) * mult) || DEFAULT_STREAM_TARGET;
    }
  }

  log(`[*] Stream CLI: ${trackIds.length} track(s) × ${target} stream(s) each.`);
  runStreams({ tracks: trackIds.map(id => ({ id })), target, excludeUser: null })
    .then(r => {
      log(`[*] Stream CLI finished: ${JSON.stringify(r)}`);
      process.exit(r.status === 'OK' ? 0 : 1);
    })
    .catch(e => {
      console.error('[!] Stream CLI failed:', errMsg(e));
      process.exit(1);
    });
}

module.exports = {
  runStreams,
  buildContext,
  CFG,
  streamOnce,
};