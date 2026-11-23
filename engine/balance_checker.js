#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// --- Proxy Configuration ---
const DEFAULT_PROXIES = [
  'https://audius-v2.qringgreen.workers.dev',
  'https://audius-v2.qring99.workers.dev',
  'https://audius.henrygreen311.workers.dev',
  'https://audius-v2.henrygreen311.workers.dev',
  'https://audius.qring99.workers.dev',
  'https://audius.qringgreen.workers.dev',
];
const PROXY_URLS = [...new Set(
  (process.env.AUDIUS_PROXY_URLS || DEFAULT_PROXIES.join(','))
    .split(',').map(x => x.trim().replace(/\/+$/, '')).filter(Boolean)
)];
const PROXY_KEY = process.env.AUDIUS_PROXY_KEY || '';

// --- Telegram Configuration ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8560965744:AAFQA2ZQveGui9WMjVl3Krzx5o39ibFHuNs';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '6807387667';
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED !== '0';

// --- Solana RPC (for payer balance checks) ---
const SOLANA_RPC_URLS = (process.env.SOLANA_RPC_URLS || process.env.SOLANA_RPC_URL
  || 'https://api.mainnet-beta.solana.com,https://solana-rpc.publicnode.com')
  .split(',').map(x => x.trim()).filter(Boolean);
const PAYER_NOTIFY_THRESHOLD_SOL = Number(process.env.PAYER_NOTIFY_THRESHOLD_SOL || 0.069);

// --- Intercept Fetch for Proxies ---
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
      const proxy = pick(lastProxy);
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

// --- Safely resolve SDK ---
let sdkPkg;
try {
  sdkPkg = require('@audius/sdk');
} catch (e) {
  console.error(`[!] Failed to require @audius/sdk:`, e.message);
  process.exit(1);
}

let sdkFactory;
if (typeof sdkPkg === 'function') sdkFactory = sdkPkg;
else if (typeof sdkPkg.sdk === 'function') sdkFactory = sdkPkg.sdk;
else if (typeof sdkPkg.default === 'function') sdkFactory = sdkPkg.default;
else if (sdkPkg.default && typeof sdkPkg.default.sdk === 'function') sdkFactory = sdkPkg.default.sdk;
else sdkFactory = Object.values(sdkPkg).find(v => typeof v === 'function' && v.name.toLowerCase().includes('sdk'));

if (!sdkFactory) {
  console.error(`[!] Could not find SDK factory function in @audius/sdk exports.`);
  process.exit(1);
}

// --- Silence SDK noise ---
const log = console.log.bind(console);
for (const level of ['log', 'info', 'debug', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[audius-sdk]')) return;
    orig(...args);
  };
}

process.on('unhandledRejection', (reason) => {
  log(`[!] Background error: ${describeError(reason)}`);
});
process.on('uncaughtException', (err) => {
  log(`[!] Background error: ${describeError(err)}`);
});

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');
const MAX_RETRIES = 5;
const PENDING_MODE = process.argv.includes('--pending');
const CLAIM_MODE = process.argv.includes('--claim');
const DEBUG = process.argv.includes('--debug') || process.env.DEBUG === '1';
const VERBOSE = process.argv.includes('--verbose') || process.env.VERBOSE === '1';

// --- Account filter (--address=, --email=, --user-id=, or positional) ---
const KNOWN_FLAGS = new Set(['--pending', '--claim', '--debug', '--verbose']);
function parseFilterArg() {
  let m = process.argv.find(a => a.startsWith('--address='));
  if (m) return { label: 'address', field: 'address', value: m.slice('--address='.length) };

  m = process.argv.find(a => a.startsWith('--email='));
  if (m) return { label: 'email', field: 'email', value: m.slice('--email='.length) };

  m = process.argv.find(a => a.startsWith('--user-id='));
  if (m) return { label: 'user id', field: 'user_id', value: m.slice('--user-id='.length) };

  for (let i = 2; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (a.startsWith('-')) continue;
    if (KNOWN_FLAGS.has(a)) continue;
    return { label: 'search', field: null, value: a };
  }
  return null;
}
const FILTER = parseFilterArg();
const ID_FIELDS = ['address', 'user_id', 'email', 'handle', 'username', 'name'];

function matchesFilter(acc) {
  if (!FILTER) return true;
  const target = String(FILTER.value).trim().toLowerCase();
  if (!target) return true;
  const fields = FILTER.field ? [FILTER.field] : ID_FIELDS;
  return fields.some(f => {
    const v = acc?.[f];
    return v !== undefined && v !== null && String(v).toLowerCase() === target;
  });
}

function applyFilter(accounts) {
  if (!FILTER) return accounts;
  const filtered = accounts.filter(matchesFilter);
  if (filtered.length === 0) {
    log(`[!] No accounts matched ${FILTER.label} "${FILTER.value}".`);
    log(`[!] Fields searched: ${FILTER.field || ID_FIELDS.join(', ')}.`);
  } else {
    log(`[*] Filter (${FILTER.label}="${FILTER.value}") matched ${filtered.length} account(s).`);
  }
  return filtered;
}

const PENDING_CONCURRENCY = Number(process.env.PENDING_CONCURRENCY || 5);
const API_BASE = process.env.AUDIUS_API_BASE || 'https://api.audius.co/v1';
const BASE_DELAY_MS = 1000;
const PAGE_SIZE = Number(process.env.UNDISBURSED_PAGE_SIZE || 100);
const MAX_PAGES = Number(process.env.UNDISBURSED_MAX_PAGES || 20);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getStatus(e) {
  return e?.status ?? e?.response?.status ?? e?.cause?.status ?? null;
}

const STATUS_NAMES = {
  400: 'bad request', 401: 'unauthorized', 403: 'forbidden', 404: 'not found', 408: 'request timeout',
  409: 'conflict', 422: 'unprocessable', 429: 'rate limited',
};

function describeError(e) {
  const status = getStatus(e);
  if (status) return `HTTP ${status} ${STATUS_NAMES[status] || (status >= 500 ? 'server error' : status >= 400 ? 'client error' : 'unexpected status')}`;
  const msg = String((e && e.message) || e).replace(/\s+/g, ' ');
  if (/abort|timeout|timed out/i.test(msg)) return 'timed out';
  if (/fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket/i.test(msg)) return 'network error';
  return msg.slice(0, 40);
}

async function withRetry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const status = getStatus(e);
      const retryable = status === 429 || (status !== null && status >= 500) || status === null;
      if (!retryable || attempt >= MAX_RETRIES) throw e;

      const retryAfter = parseInt(e?.response?.headers?.get?.('retry-after'), 10);
      const delay = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : BASE_DELAY_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
      await sleep(delay);
    }
  }
}

const DAY_MS = 86400000;

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function pickField(obj, ...names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    if (obj[name] !== undefined && obj[name] !== null) return obj[name];
  }
  return undefined;
}

// --- Telegram ---
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function sendTelegram(text) {
  if (!TELEGRAM_ENABLED) return false;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (DEBUG || VERBOSE) {
        const body = await res.text().catch(() => '');
        log(`  [debug] telegram send failed: HTTP ${res.status} ${String(body).slice(0, 120)}`);
      }
      return false;
    }
    return true;
  } catch (e) {
    if (DEBUG || VERBOSE) log(`  [debug] telegram send error: ${describeError(e)}`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// --- Solana RPC: getBalance (lamports) ---
async function solanaGetBalanceLamports(address) {
  let lastErr;
  for (const rpc of SOLANA_RPC_URLS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      let res;
      try {
        res = await fetch(rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [address],
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json && json.error) throw new Error(json.error.message || 'rpc error');
      const lamports = json?.result?.value;
      if (typeof lamports !== 'number') throw new Error('no lamports value');
      return lamports;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('no rpc endpoint reachable');
}

// --- Solana Base58 Encoder (for fee payer address) ---
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buffer) {
  const digits = [0];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let string = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    string += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    string += ALPHABET[digits[i]];
  }
  return string;
}

// --- ShortVec Reader ---
function readShortVec(buffer, offset) {
  let len = 0;
  let size = 0;
  while (true) {
    if (offset + size >= buffer.length) return null;
    const elem = buffer[offset + size];
    len |= (elem & 0x7f) << (size * 7);
    size += 1;
    if ((elem & 0x80) === 0) break;
  }
  return { len, size };
}

// --- Parse Solana Error Response (legacy 500 body with embedded transaction) ---
function parseSolanaTxError(responseText) {
  try {
    const json = JSON.parse(responseText);
    const errorStrings = [];
    if (typeof json.error === 'string') errorStrings.push(json.error);
    if (Array.isArray(json.data)) {
      for (const d of json.data) {
        if (d && typeof d.error === 'string') errorStrings.push(d.error);
      }
    }
    if (errorStrings.length === 0) return null;

    const combined = errorStrings.join(' ');
    const lamportsMatch = combined.match(/insufficient lamports (\d+)/i);
    const lamports = lamportsMatch ? parseInt(lamportsMatch[1], 10) : 0;

    const txMatch = combined.match(/transaction: ([A-Za-z0-9+/=]+)/i);
    if (!txMatch) return null;

    const txBuffer = Buffer.from(txMatch[1], 'base64');
    const sigInfo = readShortVec(txBuffer, 0);
    if (!sigInfo) return null;

    const msgStart = sigInfo.size + (sigInfo.len * 64);
    const keysInfo = readShortVec(txBuffer, msgStart + 3);
    if (!keysInfo) return null;

    const feePayerOffset = msgStart + 3 + keysInfo.size;
    const feePayerBytes = txBuffer.subarray(feePayerOffset, feePayerOffset + 32);
    if (feePayerBytes.length < 32) return null;

    return { feePayer: base58Encode(feePayerBytes), lamports };
  } catch (e) {
    return null;
  }
}

// --- Claim response validation (must have real signatures, no error) ---
function hasValidSignatures(sigs) {
  if (sigs === null || sigs === undefined) return false;
  if (Array.isArray(sigs)) {
    return sigs.length > 0 && sigs.every(s => s !== null && s !== undefined && s !== '');
  }
  if (typeof sigs === 'object') {
    const values = Object.values(sigs);
    return values.length > 0 && values.every(s => s !== null && s !== undefined && s !== '');
  }
  if (typeof sigs === 'string') return sigs.length > 0;
  return false;
}

function shortenClaimError(s) {
  if (!s) return 'unknown';
  if (/InsufficientFundsForRent/i.test(s)) return 'InsufficientFundsForRent';
  if (/InsufficientFunds/i.test(s)) return 'InsufficientFunds';
  if (/AccountNotFound/i.test(s)) return 'AccountNotFound';
  if (/BlockhashNotFound/i.test(s)) return 'BlockhashNotFound';
  if (/rate.?limit/i.test(s)) return 'rate limited';
  if (/try again|busy/i.test(s)) return 'server busy';
  if (/timeout/i.test(s)) return 'timed out';
  return s.replace(/\s+/g, ' ').slice(0, 40);
}

function claimResponseValid(json, challengeId, specifier) {
  if (!json || typeof json !== 'object') {
    return { ok: false, reason: 'invalid response', error: 'empty or non-object' };
  }

  if (Array.isArray(json.data)) {
    const entry = json.data.find(d => d && d.specifier === specifier)
      || json.data.find(d => d && d.challengeId === challengeId)
      || json.data[0];
    if (!entry) {
      return { ok: false, reason: 'empty response data', error: 'no claim entry in response' };
    }
    if (entry.error) {
      let errStr;
      try {
        errStr = typeof entry.error === 'string' ? entry.error : JSON.stringify(entry.error);
      } catch (_) {
        errStr = String(entry.error);
      }
      return { ok: false, reason: shortenClaimError(errStr), error: errStr, entry };
    }
    if (!hasValidSignatures(entry.signatures)) {
      return {
        ok: false,
        reason: 'missing signatures',
        error: `signatures=${JSON.stringify(entry.signatures)}`,
        entry,
      };
    }
    return { ok: true, entry };
  }

  if (json.success === false) {
    const e = json.error
      ? (typeof json.error === 'string' ? json.error : JSON.stringify(json.error))
      : 'success=false';
    return { ok: false, reason: shortenClaimError(e), error: e };
  }
  if (json.success === true) return { ok: true };
  if (json.error) {
    const e = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
    return { ok: false, reason: shortenClaimError(e), error: e };
  }
  if (Object.prototype.hasOwnProperty.call(json, 'signatures')) {
    return hasValidSignatures(json.signatures)
      ? { ok: true }
      : { ok: false, reason: 'missing signatures', error: `signatures=${JSON.stringify(json.signatures)}` };
  }

  if (DEBUG) log(`  [debug] unrecognized claim response format: ${JSON.stringify(json).slice(0, 200)}`);
  return { ok: false, reason: 'unrecognized response', error: JSON.stringify(json).slice(0, 200) };
}

const AMOUNT_DECIMALS = Number(process.env.AMOUNT_DECIMALS || 0);

function amountOf(raw) {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'string' ? parseFloat(raw) : Number(raw);
  if (!Number.isFinite(n)) return 0;
  return n / Math.pow(10, AMOUNT_DECIMALS);
}

const plainAmount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
const fmtAmount = (n) => `${plainAmount(n)} $AUDIO`;

function fmtLeft(ms) {
  const hours = Math.max(1, Math.ceil(ms / 3600000));
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return d ? (h ? `${d}d ${h}h` : `${d}d`) : `${h}h`;
}

async function fetchUndisbursedPage(appData, userId, offset, limit) {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    api_key: appData.api_key,
    app_name: 'balance_checker',
  });
  const headers = { Accept: 'application/json' };
  if (appData.bearer_token) headers.Authorization = `Bearer ${appData.bearer_token}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API_BASE}/challenges/undisbursed/${userId}?${qs}`, {
      headers,
      signal: controller.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const json = await res.json();
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.data)) return json.data;
    if (json && Array.isArray(json.challenges)) return json.challenges;
    if (json && json.data && Array.isArray(json.data.challenges)) return json.data.challenges;
    if (json && json.data && Array.isArray(json.data.items)) return json.data.items;
    if (json && json.data && Array.isArray(json.data.results)) return json.data.results;
    if (DEBUG) log(`  [debug] unrecognized response shape for user ${userId}: ${JSON.stringify(json).slice(0, 200)}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUndisbursed(appData, userId) {
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    let items;
    try {
      items = await withRetry(() => fetchUndisbursedPage(appData, userId, offset, PAGE_SIZE));
    } catch (e) {
      if (page === 0) throw e;
      if (DEBUG) log(`  [debug] user ${userId} page ${page + 1} (offset ${offset}) failed: ${describeError(e)}`);
      break;
    }
    if (DEBUG) log(`  [debug] user ${userId} page ${page + 1} (offset ${offset}): ${items.length} record(s)`);
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

function classifyRewards(list, now) {
  const out = { ready: [], pending: [] };
  for (const r of list) {
    let amount = amountOf(pickField(r, 'amount', 'reward_amount', 'rewardAmount'));
    const multiplier = Number(pickField(r, 'multiplier', 'reward_multiplier', 'payout_multiplier') || 1);
    if (multiplier > 1) amount *= multiplier;
    const total = pickField(r, 'total_amount', 'totalAmount');
    if (total !== undefined) {
      const t = amountOf(total);
      if (t > 0) amount = t;
    }
    const done = toMs(pickField(r, 'completed_at', 'completedAt', 'completed_date'))
      ?? toMs(pickField(r, 'created_at', 'createdAt', 'date_created'));
    const cooldown = Number(pickField(r, 'cooldown_days', 'cooldownDays', 'cooldown')) || 0;
    const readyAt = done === null ? null : done + cooldown * DAY_MS;
    if (readyAt !== null && readyAt > now) {
      out.pending.push({ amount, left: readyAt - now, raw: r });
    } else {
      out.ready.push({ amount, raw: r });
    }
  }
  out.pending.sort((a, b) => a.left - b.left);
  return out;
}

async function claimReward(appData, userId, challengeId, specifier) {
  const body = { userId, challengeId, specifier };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (appData.bearer_token) headers.Authorization = `Bearer ${appData.bearer_token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`${API_BASE}/rewards/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.responseText = text;
      throw err;
    }
    return { json, text, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function claimAllReady(acc, readyList) {
  const results = { claimed: 0, claimedAmount: 0, fatalFailed: 0, reasons: new Map(), solanaErrors: [] };

  const fail = (why) => {
    results.reasons.set(why, (results.reasons.get(why) || 0) + 1);
    results.fatalFailed++;
  };

  for (const item of readyList) {
    const r = item.raw;
    const challengeId = pickField(r, 'challenge_id', 'challengeId', 'id') || null;
    const specifier = pickField(r, 'specifier', 'spec') || null;

    if (!challengeId || !specifier) {
      fail('missing challenge data');
      if (VERBOSE) log(`  [claim] ${acc.address} ✗ missing challenge data`);
      continue;
    }

    try {
      const result = await withRetry(() => claimReward(acc.app_data, acc.user_id, challengeId, specifier));
      const json = result.json;

      // Show raw 2xx response before deciding if it's actually a success.
      log(`  [api-2xx] ${acc.address} ${challengeId} ${specifier} -> HTTP ${result.status} | Response: ${result.text}`);

      const validation = claimResponseValid(json, challengeId, specifier);
      if (!validation.ok) {
        const isRetryable = /try again|busy|timeout|rate.?limit/i.test(String(validation.error || ''));
        const err = new Error(validation.reason);
        err.status = isRetryable ? 500 : 400;
        err.responseText = result.text;
        err.claimReason = validation.reason;
        err.claimError = validation.error;
        throw err;
      }

      // Only count as claimed once we've positively validated a signature.
      results.claimed++;
      results.claimedAmount += item.amount;

      if (VERBOSE) log(`  [claim] ${acc.address} ✓ ${challengeId} ${fmtAmount(item.amount)}`);

      // Telegram notification: successful claim with a valid signature.
      await sendTelegram(
        `✅ <b>Claim Successful</b>\n\n` +
        `Account: <code>${escapeHtml(acc.address)}</code>\n` +
        `Challenge: <code>${escapeHtml(challengeId)}</code>\n` +
        `Specifier: <code>${escapeHtml(specifier)}</code>\n` +
        `Amount: <b>${escapeHtml(fmtAmount(item.amount))}</b>`
      );
    } catch (e) {
      const status = getStatus(e);
      const why = e.claimReason || describeError(e);
      fail(why);

      if (e.claimError || VERBOSE) {
        log(`  [claim] ${acc.address} ✗ ${challengeId}: ${why}`);
      }

      if (e.responseText && status !== 400 && status !== 500) {
        log(`          response: ${e.responseText.slice(0, 500)}`);
      }

      // Only the legacy 500 path carries an embedded base64 transaction we can
      // decode to resolve a fee payer. The new 200-with-error envelope has no
      // transaction, so we can't attribute a payer — just record the reason.
      if (status === 500 && e.responseText) {
        const solInfo = parseSolanaTxError(e.responseText);
        if (solInfo) {
          results.solanaErrors.push({ address: acc.address, ...solInfo });
        }
      }
    }
  }
  return results;
}

async function checkPending(accounts) {
  const now = Date.now();
  const filtered = applyFilter(accounts);
  if (FILTER && filtered.length === 0) return;

  const queue = filtered.filter(a => a.user_id && a.app_data && a.app_data.api_key);
  const skipped = filtered.length - queue.length;
  const results = [];
  const reasons = new Map();
  let errors = 0;

  if (CLAIM_MODE) log(`[*] Claim mode active: will attempt to claim ready rewards.`);

  const sum = (list) => list.reduce((n, x) => n + x.amount, 0);

  const describeRewards = (x) => {
    const parts = [];
    if (x.ready.length) {
      parts.push(`ready to claim ${fmtAmount(sum(x.ready))} (${x.ready.length} reward${x.ready.length > 1 ? 's' : ''})`);
    }
    if (x.pending.length === 1) {
      parts.push(`pending ${fmtAmount(x.pending[0].amount)}, ${fmtLeft(x.pending[0].left)} left`);
    } else if (x.pending.length) {
      parts.push(`pending ${fmtAmount(sum(x.pending))} (${x.pending.map(p => `${plainAmount(p.amount)} in ${fmtLeft(p.left)}`).join(', ')})`);
    }
    return parts.join(' | ');
  };

  let accountsWithReady = [];

  const worker = async () => {
    while (queue.length) {
      const acc = queue.shift();
      try {
        const list = await withRetry(() => fetchUndisbursed(acc.app_data, acc.user_id));
        const classified = classifyRewards(list, now);
        const result = { address: acc.address, records: list, ...classified };
        results.push(result);

        if (!CLAIM_MODE && (result.ready.length || result.pending.length)) {
          log(`[${acc.address}] ${describeRewards(result)}`);
        }

        if (CLAIM_MODE && result.ready.length) {
          accountsWithReady.push({ acc, readyList: result.ready });
        }
      } catch (e) {
        errors++;
        const why = describeError(e);
        reasons.set(why, (reasons.get(why) || 0) + 1);
        log(`[!] [${acc.address}] check failed: ${why}`);
      }
    }
  };
  await Promise.all(Array.from({ length: PENDING_CONCURRENCY }, worker));

  const withRewards = results.filter(x => x.ready.length || x.pending.length);
  const none = results.length - withRewards.length;
  const errorText = `${errors} errors (${[...reasons.entries()].map(([k, n]) => `${k} x${n}`).join(', ')})`;

  if (!CLAIM_MODE) {
    const allReady = results.flatMap(x => x.ready);
    const allPending = results.flatMap(x => x.pending);
    const summary = [
      `ready to claim ${fmtAmount(sum(allReady))} in ${results.filter(x => x.ready.length).length} accounts (${allReady.length} rewards)`,
      `pending ${fmtAmount(sum(allPending))} in ${results.filter(x => x.pending.length).length} accounts (${allPending.length} rewards)`,
    ];
    if (allPending.length) summary.push(`next unlock in ${fmtLeft(allPending.reduce((m, p) => Math.min(m, p.left), Infinity))}`);
    if (none) summary.push(`${none} with nothing to claim`);
    if (errors) summary.push(errorText);
    if (skipped) summary.push(`${skipped} without credentials`);
    log(`[*] Pending rewards: ${summary.join(' | ')}.`);
    return;
  }

  let totalClaimed = 0;
  let totalClaimedAmount = 0;
  let totalFatalFailed = 0;
  let accountsWithSuccessfulClaims = 0;
  const claimReasons = new Map();
  const payerStats = new Map();

  const claimQueue = [...accountsWithReady];

  const claimWorker = async () => {
    while (claimQueue.length) {
      const { acc, readyList } = claimQueue.shift();

      log(`[${acc.address}] claiming ${fmtAmount(sum(readyList))} (${readyList.length} reward${readyList.length > 1 ? 's' : ''})...`);

      const claim = await claimAllReady(acc, readyList);
      totalClaimed += claim.claimed;
      totalClaimedAmount += claim.claimedAmount;
      totalFatalFailed += claim.fatalFailed;
      if (claim.claimed > 0) accountsWithSuccessfulClaims++;

      for (const [why, n] of claim.reasons) {
        claimReasons.set(why, (claimReasons.get(why) || 0) + n);
      }

      if (claim.solanaErrors && claim.solanaErrors.length) {
        for (const err of claim.solanaErrors) {
          if (!payerStats.has(err.feePayer)) payerStats.set(err.feePayer, { lamports: 0, accounts: new Set() });
          const stat = payerStats.get(err.feePayer);
          stat.lamports += err.lamports;
          stat.accounts.add(err.address);
        }
      }

      const done = [];
      if (claim.claimed) done.push(`claimed ${claim.claimed} (${fmtAmount(claim.claimedAmount)})`);
      if (claim.fatalFailed) done.push(`${claim.fatalFailed} fails`);

      if (done.length) log(`[${acc.address}] ${done.join(' | ')}`);
    }
  };

  await Promise.all(Array.from({ length: PENDING_CONCURRENCY }, claimWorker));

  const claimSummaryStr = [
    `claimed ${totalClaimed} reward${totalClaimed === 1 ? '' : 's'} (${fmtAmount(totalClaimedAmount)}) in ${accountsWithSuccessfulClaims} accounts`
  ];

  if (totalFatalFailed) claimSummaryStr.push(`${totalFatalFailed} failed (${[...claimReasons.entries()].map(([k, n]) => `${k} x${n}`).join(', ')})`);

  const accountsWithZeroReady = results.filter(x => !x.ready.length).length;
  if (accountsWithZeroReady) claimSummaryStr.push(`${accountsWithZeroReady} with nothing ready to claim`);
  if (errors) claimSummaryStr.push(errorText);
  if (skipped) claimSummaryStr.push(`${skipped} without credentials`);

  log(`[*] Claim complete: ${claimSummaryStr.join(' | ')}.`);

  if (payerStats.size > 0) {
    log(`\n[!] --- Solana Fee Payer Analysis ---`);
    if (payerStats.size === 1) {
      const [payer, stat] = [...payerStats.entries()][0];
      log(`[!] All failed accounts use 1 payer address: ${payer}`);
      log(`[!] Accounts: ${stat.accounts.size}`);
      log(`[!] Total Lamports needed: ${stat.lamports} (approx ${(stat.lamports / 1e9).toFixed(4)} SOL)`);
    } else {
      log(`[!] Found ${payerStats.size} distinct payer addresses:`);
      for (const [payer, stat] of payerStats.entries()) {
        log(`    - Payer: ${payer}`);
        log(`      Accounts: ${stat.accounts.size}`);
        log(`      Total Lamports: ${stat.lamports}`);
      }
      const grandTotal = [...payerStats.values()].reduce((sum, s) => sum + s.lamports, 0);
      log(`[!] Grand Total Lamports needed: ${grandTotal} (approx ${(grandTotal / 1e9).toFixed(4)} SOL)`);
    }
    log(`[!] ---------------------------------\n`);

    // --- Check on-chain SOL balance for each payer, notify Telegram if funded ---
    log(`[*] Checking on-chain SOL balance for ${payerStats.size} payer address(es) (threshold ${PAYER_NOTIFY_THRESHOLD_SOL} SOL)...`);
    for (const [payer, stat] of payerStats.entries()) {
      try {
        const lamports = await withRetry(() => solanaGetBalanceLamports(payer));
        const sol = lamports / 1e9;
        const funded = sol >= PAYER_NOTIFY_THRESHOLD_SOL;

        log(`[*] Payer ${payer}: ${sol.toFixed(6)} SOL${funded ? ' — funded (notifying)' : ''}`);

        if (funded) {
          await sendTelegram(
            `💰 <b>Funded Payer Detected</b>\n\n` +
            `Payer: <code>${escapeHtml(payer)}</code>\n` +
            `Balance: <b>${sol.toFixed(6)} SOL</b>\n` +
            `Threshold: ${PAYER_NOTIFY_THRESHOLD_SOL} SOL\n` +
            `Accounts affected: ${stat.accounts.size}\n` +
            `Lamports needed: ${stat.lamports}`
          );
        }
      } catch (e) {
        log(`[!] Payer ${payer} balance check failed: ${describeError(e)}`);
      }
    }
  }
}

async function checkAccount(supabase, account) {
  const address = account.address;
  const userId = account.user_id;
  const oldBalance = parseFloat(account.balance || 0);
  const appData = account.app_data;

  if (!userId || !appData || !appData.api_key) return;

  try {
    const sdk = sdkFactory({
      apiKey: appData.api_key,
      apiSecret: appData.api_secret,
      bearerToken: appData.bearer_token,
    });

    let totalAudioBalance = null;
    let ethBalance = null;
    let totalBalance = null;
    let waudioBalance = null;

    let coinBalance = 0.0;
    let coinBalanceUsd = 0.0;
    let historyCount = 0;
    let historyFailed = false;
    const issues = [];
    let historyIssue = '';

    try {
      const userRes = await withRetry(() => sdk.users.getUser({ id: userId }));
      const user = userRes?.data;
      if (user) {
        totalAudioBalance = user.totalAudioBalance ?? null;
        ethBalance = user.balance ?? null;
        totalBalance = user.totalBalance ?? null;
        waudioBalance = user.waudioBalance ?? null;
      }
    } catch (e) {
      issues.push(`profile fetch failed: ${describeError(e)}`);
    }

    try {
      const coinsRes = await withRetry(() => sdk.users.getUserCoins({ id: userId }));
      const coins = coinsRes?.data;
      if (Array.isArray(coins)) {
        const audioCoin = coins.find(c => c.ticker === '$AUDIO');
        if (audioCoin) {
          const decimals = audioCoin.decimals ?? 8;
          const accountsArr = Array.isArray(audioCoin.accounts) && audioCoin.accounts.length > 0
            ? audioCoin.accounts
            : [audioCoin];

          let rawTotal = 0;
          let usdTotal = 0;
          for (const acct of accountsArr) {
            rawTotal += parseFloat(acct.balance || 0);
            usdTotal += parseFloat(acct.balance_usd || 0);
          }
          coinBalance = rawTotal / Math.pow(10, decimals);
          coinBalanceUsd = usdTotal;
        }
      }
    } catch (e) {
      issues.push(`coin fetch failed: ${describeError(e)}`);
    }

    try {
      const historyRes = await withRetry(() => sdk.users.getUserBalanceHistory({ id: userId, granularity: 'daily' }));
      const data = historyRes?.data;
      if (Array.isArray(data)) {
        historyCount = data.length;
      }
    } catch (e) {
      const status = getStatus(e);
      if (status === 404) {
        historyCount = 0;
      } else {
        historyFailed = true;
        historyIssue = describeError(e);
      }
    }

    const logs = [];
    if (totalAudioBalance !== null) logs.push(`Total Audio: ${totalAudioBalance}`);
    if (ethBalance !== null) logs.push(`Balance: ${ethBalance}`);
    if (totalBalance !== null) logs.push(`Total Balance: ${totalBalance}`);
    if (waudioBalance !== null) logs.push(`WAudio: ${waudioBalance}`);
    if (coinBalance > 0) logs.push(`$AUDIO Coin: ${coinBalance} ($${coinBalanceUsd})`);
    if (historyCount > 0) logs.push(`History: ${historyCount} items`);
    else if (historyFailed) logs.push(`History: fetch failed, ${historyIssue}`);

    logs.push(...issues);

    const updates = {};
    const resolvedBalance = totalAudioBalance !== null ? totalAudioBalance : (coinBalance > 0 ? coinBalance : null);

    if (resolvedBalance !== null && resolvedBalance !== oldBalance) {
      updates.balance = resolvedBalance;
    }

    if (Object.keys(updates).length > 0) {
      try {
        const { error } = await supabase.from('audius').update(updates).eq('address', address);
        if (error) logs.push('DB update failed');
      } catch (e) {
        logs.push('DB update failed');
      }
    }

    if (logs.length > 0) log(`[${address}] ${logs.join(' | ')}`);

  } catch (err) {
    log(`[${address}] failed: ${describeError(err)}`);
  }
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`[!] DB file not found.`);
    process.exit(1);
  }

  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) {
    console.error(`[!] Could not parse SUPABASE_URL or SUPABASE_KEY from db.txt`);
    process.exit(1);
  }

  const supabase = createClient(urlMatch[1], keyMatch[1]);

  if (FILTER) log(`[*] Filter active: ${FILTER.label}="${FILTER.value}"`);

  log(`[*] Fetching eligible accounts from DB...`);
  const { data: accounts, error } = await supabase
    .from('audius')
    .select('*')
    .not('app_data', 'is', null)
    .not('user_id', 'is', null);

  if (error) {
    console.error(`[!] Failed to fetch accounts: ${error.message || error}`);
    process.exit(1);
  }

  if (!accounts || accounts.length === 0) {
    log(`[!] No eligible accounts found.`);
    return;
  }

  if (PENDING_MODE || CLAIM_MODE) {
    const modeLabel = CLAIM_MODE ? 'claim' : 'pending';
    log(`[*] Checking ${modeLabel} rewards for ${accounts.length} account(s) (page size ${PAGE_SIZE})...`);
    await checkPending(accounts);
    log(`[*] ${modeLabel.charAt(0).toUpperCase() + modeLabel.slice(1)} check complete.`);
    return;
  }

  const targets = applyFilter(accounts);
  if (FILTER && targets.length === 0) return;

  log(`[*] Checking ${targets.length} account${targets.length === 1 ? '' : 's'} one at a time...`);
  for (const acc of targets) {
    await checkAccount(supabase, acc);
  }
  log(`[*] Balance check complete.`);
}

main().catch(err => {
  console.error(`[!] Fatal: ${describeError(err)}`);
  process.exit(1);
});
