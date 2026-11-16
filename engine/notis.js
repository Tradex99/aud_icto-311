#!/usr/bin/env node
'use strict';

const NOTIFICATIONS_PER_ACCOUNT = 10;
const TEXT_MATCHES = ['audio', 'is now trending thanks to you.'];
const TYPE_MATCHES = { tastemaker: 'is now trending thanks to you.' };
const DISPLAY_TIMEZONE = 'Africa/Lagos';
const AMOUNT_DECIMALS = 0;
const REWARDS_PER_ACCOUNT = 100;

const fs = require('fs');
const path = require('path');
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

const log = console.log.bind(console);
const VERBOSE = /^(1|true|yes)$/i.test(process.env.VERBOSE || '') || process.argv.includes('--verbose') || process.argv.includes('-v');

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');

const CFG = {
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  timeoutMs: Number(process.env.CALL_TIMEOUT_SECONDS || 20) * 1000,
  concurrency: Number(process.env.CONCURRENCY || 5),
  apiBase: process.env.AUDIUS_API_BASE || 'https://api.audius.co/v1',
  rateWaitMs: Number(process.env.RATE_WAIT_MS || 3000),
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const statusOf = e => e && ((e.response && e.response.status) || e.status);

function isRateLimit(e) {
  return statusOf(e) === 429 || /rate.?limit|too many requests|\b429\b/i.test(String((e && e.message) || e));
}

function isTransient(e) {
  const s = statusOf(e);
  if (s) return s === 408 || s >= 500;
  const msg = String((e && e.message) || e).toLowerCase();
  const code = String((e && (e.code || (e.cause && e.cause.code))) || '').toUpperCase();
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/.test(code) ||
    /fetch failed|network|timeout|timed out|aborted|socket hang up|temporar|bad gateway|service unavailable|gateway/.test(msg);
}

function connectSupabase() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`db.txt not found at: ${DB_FILE}`);
  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
  return createClient(urlMatch[1], keyMatch[1]);
}

async function fetchAccounts(sb) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    let data;
    for (let i = 1; ; i++) {
      const res = await sb.from('audius').select('address, handle, user_id, app_data')
        .order('address', { ascending: true }).range(from, from + page - 1);
      if (!res.error) { data = res.data || []; break; }
      if (i >= CFG.retries) throw new Error(res.error.message);
      await sleep(CFG.retryBaseMs * i);
    }
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

const hasCreds = r => !!(r.user_id && r.app_data && r.app_data.api_key && r.app_data.bearer_token);

async function apiJson(pathname, params, acct) {
  const qs = new URLSearchParams({ ...params, api_key: acct.app_data.api_key, app_name: 'notis' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  try {
    const res = await fetch(`${CFG.apiBase}${pathname}?${qs}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${acct.app_data.bearer_token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return await res.json();
  } catch (e) {
    if (controller.signal.aborted) throw new Error('timeout');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetries(fn) {
  let lastErr;
  for (let attempt = 0; attempt <= CFG.retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (isRateLimit(e)) { await sleep(CFG.rateWaitMs * (attempt + 1)); continue; }
      if (!isTransient(e)) break;
      await sleep(CFG.retryBaseMs * (attempt + 1));
    }
  }
  throw lastErr;
}

async function loadNotifications(acct) {
  const json = await withRetries(() => apiJson(`/notifications/${acct.user_id}`, { limit: String(NOTIFICATIONS_PER_ACCOUNT), user_id: acct.user_id }, acct));
  const list = (json && json.data && json.data.notifications) || (json && json.notifications) || [];
  return list.slice(0, NOTIFICATIONS_PER_ACCOUNT);
}

async function loadRewards(acct) {
  const json = await withRetries(() => apiJson(`/challenges/undisbursed/${acct.user_id}`, { limit: String(REWARDS_PER_ACCOUNT) }, acct));
  const list = (json && json.data) || [];
  return Array.isArray(list) ? list : [];
}

const DAY_MS = 86400000;

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function amountOf(raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n / 10 ** AMOUNT_DECIMALS : 0;
}

function plainAmount(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtAmount(n) {
  return `${plainAmount(n)} $AUDIO`;
}

function fmtLeft(ms) {
  const hours = Math.max(1, Math.ceil(ms / 3600000));
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return d ? (h ? `${d}d ${h}h` : `${d}d`) : `${h}h`;
}

function classifyRewards(list, now) {
  const out = { ready: [], pending: [] };
  for (const r of list) {
    const amount = amountOf(r.amount);
    const done = toMs(r.completed_at) ?? toMs(r.created_at);
    const cooldown = Number(r.cooldown_days) || 0;
    const readyAt = done === null ? null : done + cooldown * DAY_MS;
    if (readyAt !== null && readyAt > now) out.pending.push({ amount, left: readyAt - now, readyAt, r });
    else out.ready.push({ amount, r });
  }
  out.pending.sort((a, b) => a.left - b.left);
  return out;
}

function matchNotification(n) {
  const text = JSON.stringify(n).toLowerCase();
  const hits = TEXT_MATCHES.filter(m => text.includes(m.toLowerCase()));
  const typeText = TYPE_MATCHES[n && n.type];
  if (typeText && !hits.includes(typeText)) hits.push(typeText);
  return hits;
}

const titleCache = new Map();

function titleOf(id, itemType) {
  const key = `${itemType}:${id}`;
  if (!titleCache.has(key)) {
    const pathPart = itemType === 'playlist' || itemType === 'album' ? 'playlists' : 'tracks';
    titleCache.set(key, (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
        try {
          const res = await fetch(`${CFG.apiBase}/${pathPart}/${id}?app_name=notis`, { headers: { Accept: 'application/json' }, signal: controller.signal });
          if (!res.ok) return null;
          const data = (await res.json()).data;
          const item = Array.isArray(data) ? data[0] : data;
          return (item && (item.title || item.playlist_name)) || null;
        } finally {
          clearTimeout(timer);
        }
      } catch (_) {
        return null;
      }
    })());
  }
  return titleCache.get(key);
}

const dateFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TIMEZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function whenOf(n) {
  const ts = n && n.actions && n.actions[0] && Number(n.actions[0].timestamp);
  return Number.isFinite(ts) && ts > 0 ? dateFormat.format(new Date(ts * 1000)).replace(',', '') : null;
}

async function describe(n) {
  const when = whenOf(n);
  const data = n && n.actions && n.actions[0] && n.actions[0].data;
  if (n && n.type === 'tastemaker' && data) {
    const verb = data.action === 'save' ? 'favorite' : (data.action || 'activity');
    const kind = data.tastemaker_item_type || 'track';
    const title = await titleOf(data.tastemaker_item_id, kind);
    const what = title ? `"${title}"` : `${kind} ${data.tastemaker_item_id}`;
    return { label: 'Tastemaker', trackId: data.tastemaker_item_id, title: what, text: `Tastemaker: your ${verb} of ${what} is now trending thanks to you${when ? ` (${when})` : ''}` };
  }
  return { label: n && n.type ? n.type : 'notification', text: `${n && n.type ? n.type : 'notification'} notification${when ? ` (${when})` : ''}` };
}

function reason(e) {
  if (isRateLimit(e)) return '429';
  const s = statusOf(e);
  if (s) return `HTTP ${s}`;
  return String((e && e.message) || e).slice(0, 40);
}

async function reportRewards(entries) {
  const now = Date.now();
  const queue = [...entries];
  const results = [];
  let errors = 0;
  const reasons = new Map();
  const worker = async () => {
    while (queue.length) {
      const { acct, who } = queue.shift();
      try {
        results.push({ who, ...classifyRewards(await loadRewards(acct), now) });
      } catch (e) {
        errors++;
        const r = reason(e);
        reasons.set(r, (reasons.get(r) || 0) + 1);
        if (VERBOSE) log(`[!] ${who} | rewards: ${r}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, worker));

  const sum = list => list.reduce((n, x) => n + x.amount, 0);
  const withRewards = results.filter(x => x.ready.length || x.pending.length);
  withRewards.sort((a, b) => sum(b.ready) - sum(a.ready) || (a.pending[0] ? a.pending[0].left : Infinity) - (b.pending[0] ? b.pending[0].left : Infinity));
  log(`[*] Rewards for the ${entries.length} accounts above:`);
  for (const x of withRewards) {
    const parts = [];
    if (x.ready.length) parts.push(`ready to claim ${fmtAmount(sum(x.ready))}`);
    if (x.pending.length === 1) parts.push(`pending ${fmtAmount(x.pending[0].amount)}, ${fmtLeft(x.pending[0].left)} left`);
    else if (x.pending.length) parts.push(`pending ${fmtAmount(sum(x.pending))} (${x.pending.map(p => `${plainAmount(p.amount)} in ${fmtLeft(p.left)}`).join(', ')})`);
    log(`[*]   ${x.who} | ${parts.join(' | ')}`);
    if (VERBOSE) for (const p of [...x.ready, ...x.pending]) log(`[*]     ${p.r.challenge_id} ${p.r.specifier} | completed ${p.r.completed_at} | cooldown ${p.r.cooldown_days} days`);
  }
  const allReady = results.flatMap(x => x.ready);
  const allPending = results.flatMap(x => x.pending);
  const none = results.length - withRewards.length;
  const parts = [`ready to claim ${fmtAmount(sum(allReady))} in ${results.filter(x => x.ready.length).length} accounts`,
    `pending ${fmtAmount(sum(allPending))} in ${results.filter(x => x.pending.length).length} accounts`];
  if (none) parts.push(`${none} with nothing to claim`);
  if (errors) parts.push(`${errors} errors (${[...reasons.entries()].map(([k, n]) => `${k} x${n}`).join(', ')})`);
  log(`[*] Rewards total: ${parts.join(' | ')}.`);
}

async function runNotis() {
  const sb = connectSupabase();
  const accounts = await fetchAccounts(sb);
  const usable = accounts.filter(hasCreds);
  const queue = [...usable];
  const stats = { matches: 0, accounts: 0, errors: 0, none: accounts.length - usable.length };
  const reasons = new Map();
  const byLabel = new Map();
  const perTrack = new Map();
  const matched = new Map();

  const worker = async () => {
    while (queue.length) {
      const acct = queue.shift();
      const who = acct.handle ? `@${String(acct.handle).replace(/^@/, '')}` : acct.address;
      try {
        const list = await loadNotifications(acct);
        let found = false;
        for (const n of list) {
          const hits = matchNotification(n);
          if (!hits.length) continue;
          found = true;
          stats.matches++;
          const d = await describe(n);
          byLabel.set(d.label, (byLabel.get(d.label) || 0) + 1);
          if (d.trackId) {
            if (!perTrack.has(d.trackId)) perTrack.set(d.trackId, { title: d.title, accounts: new Set() });
            perTrack.get(d.trackId).accounts.add(acct.address);
          }
          log(`[*] ${who} | ${d.text}`);
          if (VERBOSE) log(`[*]   matched: ${hits.join(', ')} | ${JSON.stringify(n)}`);
        }
        if (found) { stats.accounts++; matched.set(acct.address, { acct, who }); }
      } catch (e) {
        stats.errors++;
        const r = reason(e);
        reasons.set(r, (reasons.get(r) || 0) + 1);
        if (VERBOSE) log(`[!] ${who} | ${r}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, worker));

  if (perTrack.size) {
    log('[*] Tastemaker per track:');
    for (const t of [...perTrack.values()].sort((a, b) => b.accounts.size - a.accounts.size || a.title.localeCompare(b.title))) {
      log(`[*]   ${t.title} | ${t.accounts.size} ${t.accounts.size === 1 ? 'account' : 'accounts'}`);
    }
  }
  if (matched.size) await reportRewards([...matched.values()]);
  const kinds = [...byLabel.entries()].map(([k, n]) => `${k} x${n}`).join(', ');
  const parts = [`${usable.length} accounts checked`, stats.matches ? `${stats.matches} matches in ${stats.accounts} accounts (${kinds})` : 'no matches'];
  if (stats.errors) parts.push(`${stats.errors} errors (${[...reasons.entries()].map(([k, n]) => `${k} x${n}`).join(', ')})`);
  if (stats.none) parts.push(`${stats.none} without credentials`);
  log(`[*] Done: ${parts.join(', ')}.`);
  return stats;
}

if (require.main === module) {
  runNotis().catch(err => {
    console.error('[!] Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { runNotis, matchNotification };
