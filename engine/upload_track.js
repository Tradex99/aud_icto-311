#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// --- Safely resolve SDK ---
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

// --- Silence SDK noise ---
const log = console.log.bind(console);
for (const level of ['log', 'info', 'debug', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[audius-sdk]')) return;
    orig(...args);
  };
}

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');
const MUSIC_DIR = path.join(ROOT_DIR, 'music');
const IMAGES_DIR = path.join(MUSIC_DIR, 'images');
// Local crash-recovery journal (not a database object).
const STATE_FILE = path.join(ROOT_DIR, '.audius_daily_state.json');

// All publishing history (and the batch lock) lives ONLY in this row's up_tracks column,
// the same row music/login.py writes ms_cookie to. No other account row is ever written.
const TARGET_ADDRESS = 'qringgreen@gmail.com';

const CFG = {
  timezone: process.env.RESET_TIMEZONE || 'America/Los_Angeles', // Audius trending resets weekly on Pacific time
  resetHour: Number(process.env.RESET_HOUR ?? 12), // the weekly reset happens on Friday at 12:00 PM Pacific
  accountsPerDay: 10,            // accounts published per batch (one track each)
  tracksPerDay: 10,              // tracks generated per batch: one unique track per account
  trackBatchSize: 3,             // generated as 3 + 3 + 3 + 1; each batch is downloaded before the next starts
  // One batch per week. A week runs from Friday 12:00 PM Pacific to the next Friday 11:59 AM, and the
  // batch is published whenever the script runs at or after the reset time and the week has no batch yet.
  forceRun: process.env.FORCE_RUN === '1', // start another batch even though this week's batch exists
  lockTtlMs: Number(process.env.LOCK_TTL_MINUTES || 120) * 60000,
  // A lock of unknown ownership with no data recorded for today is treated as stale after this long (0 = off).
  lockIdleMs: Number(process.env.LOCK_IDLE_MINUTES ?? 10) * 60000,
  genTimeoutMs: Number(process.env.GEN_TIMEOUT_MINUTES || 60) * 60000,
  genTopUpAttempts: Number(process.env.GEN_TOPUP_ATTEMPTS ?? 1),
  retries: Number(process.env.RETRY_ATTEMPTS || 3),
  retryBaseMs: Number(process.env.RETRY_BASE_MS || 2000),
  verifyTries: 5,
  verifyDelayMs: Number(process.env.VERIFY_DELAY_MS || 3000),
  uploadDelayMs: Number(process.env.UPLOAD_DELAY_MS || 1500),
};

const ALREADY_DONE_MSG = "[!] This week's publishing batch has already been completed. Exiting.";

// ---------------------------------------------------------------------------
// Description generator (unchanged from the working implementation)
// ---------------------------------------------------------------------------
const DESC = {
  opener: [
    "A late-night journey called", "Meet", "Introducing", "Say hello to", "Press play on", "Dive into", "Step inside",
    "Turn it up for", "Hit play and get lost in", "Fresh out of the studio:", "Straight from the lab,", "Something new:",
    "Headphones on for", "Pure energy in", "An experiment in sound,", "Brand new vibes with", "Feel the pulse of",
    "Welcome to", "Get ready for", "Enter the world of", "Out now:", "Listen closely to", "Crafted for the night:"
  ],
  genre: [
    "electronic", "synth-driven", "bass-heavy", "melodic", "ambient", "downtempo", "hyperpop", "house", "techno", "lo-fi",
    "chillwave", "synthwave", "future-bass", "drum and bass", "breakbeat", "trap-inspired", "electro", "indie electronic",
    "deep house", "progressive", "trip-hop", "glitchy", "cinematic", "retro-futuristic", "garage", "dance",
    "experimental", "club-ready", "minimal", "ethereal"
  ],
  vibe: [
    "late-night", "dreamy", "moody", "hypnotic", "nostalgic", "euphoric", "melancholic", "energetic", "atmospheric", "driving",
    "dark and smooth", "warm", "cold and crisp", "raw", "glossy", "gritty", "floating", "restless", "peaceful", "intense",
    "bittersweet", "spacey", "playful", "cinematic", "futuristic", "rain-soaked", "neon-lit", "sun-drenched", "introspective", "wild"
  ],
  element: [
    "pulsing synths", "deep sub-bass", "crisp drums", "shimmering pads", "chopped vocal samples", "warm analog textures",
    "razor-sharp hi-hats", "rolling basslines", "glitchy percussion", "lush chords", "tape-saturated drums", "ringing arpeggios",
    "layered harmonies", "distorted 808s", "soft piano", "vintage keys", "echoing vocals", "punchy kicks", "airy atmospheres",
    "swirling reverbs", "detuned leads", "sidechained pads", "vinyl crackle", "filtered breakbeats", "wide stereo textures",
    "stuttering vocal cuts", "slow-building risers", "warped bass hits", "metallic percussion", "gentle guitar plucks"
  ],
  scene: [
    "a midnight drive", "a rooftop at sunrise", "an empty dance floor", "a long train ride", "a rainy city window", "the last hour of a party",
    "a quiet study session", "a neon-lit street", "an early morning run", "a road trip at dusk", "a dimly lit studio", "a solo walk home",
    "a summer night", "a deep focus session", "a crowded club", "a lonely highway", "the edge of a dream", "a slow Sunday",
    "a late-night coding session", "a sleepless city", "a beach at midnight", "a workout that won't quit", "a foggy morning", "a space-station window"
  ],
  feeling: [
    "wonder", "nostalgia", "freedom", "tension", "calm", "adrenaline", "longing", "hope", "mystery", "momentum", "release",
    "focus", "melancholy", "joy", "restlessness", "confidence", "serenity", "chaos", "warmth", "curiosity", "power", "escape"
  ],
  closer: [
    "Best enjoyed on good headphones.", "Turn it up.", "Let it loop.", "Press repeat.", "Play it loud.", "More music coming soon.",
    "Thanks for listening.", "Hope it moves you.", "Feel free to share.", "Made for late nights.", "Stay tuned for more.",
    "Hit repeat and drift away.", "Best played at full volume.", "Let me know what you think.", "Enjoy the ride.", "Close your eyes and listen.",
    "Add it to your playlist.", "Perfect for headphones and night drives.", "Take it in from start to finish.", "Fresh sounds, more on the way."
  ],
  action: [
    "blends", "stacks", "balances", "weaves together", "plays with", "leans on", "builds around", "mixes",
    "pairs", "fuses", "pushes forward with", "drifts through", "layers up", "plays off"
  ]
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Builds a 2-3 sentence description that uses the track title and its words.
// Optional extras (from the audio analysis) are folded in when available.
function generateDescription(title, extras = {}) {
  const words = title.split(/\s+/).filter(w => w.length > 2);
  const keyWord = words.length ? pick(words).toLowerCase() : title.toLowerCase();
  const T = `"${title}"`;

  const templates = [
    () => `${pick(DESC.opener)} ${T}: ${an(pick(DESC.vibe))} ${pick(DESC.genre)} track with ${pick(DESC.element)} and ${pick(DESC.element)}. ${pick(DESC.closer)}`,
    () => `${T} is ${an(pick(DESC.vibe))} ${pick(DESC.genre)} track built for ${pick(DESC.scene)}. It ${pick(DESC.action)} ${pick(DESC.element)} and ${pick(DESC.element)}. ${pick(DESC.closer)}`,
    () => {
      const [v1, v2] = [...DESC.vibe].sort(() => Math.random() - 0.5);
      return `Think ${keyWord}, ${v1} and ${v2}. ${T} ${pick(DESC.action)} ${pick(DESC.element)}, leaving a feeling of ${pick(DESC.feeling)}. ${pick(DESC.closer)}`;
    },
    () => `${pick(DESC.opener)} ${T}. ${cap(an(pick(DESC.genre)))} track with ${pick(DESC.element)}, made for ${pick(DESC.scene)}. ${pick(DESC.closer)}`,
    () => `${T}: ${pick(DESC.feeling)}, ${pick(DESC.feeling)} and a little ${pick(DESC.feeling)}. ${cap(an(pick(DESC.vibe)))} ${pick(DESC.genre)} ride through ${pick(DESC.element)} and ${pick(DESC.element)}. ${pick(DESC.closer)}`,
    () => `If ${keyWord} had a sound, it might be ${T}. ${cap(an(pick(DESC.vibe)))} ${pick(DESC.genre)} track with ${pick(DESC.element)} and ${pick(DESC.element)}, perfect for ${pick(DESC.scene)}. ${pick(DESC.closer)}`,
    () => `${pick(DESC.opener)} ${T}. It ${pick(DESC.action)} ${pick(DESC.element)} until the ${keyWord} takes over. ${cap(pick(DESC.feeling))} from the first beat to the last. ${pick(DESC.closer)}`,
  ];

  let text = pick(templates)();

  const facts = [];
  if (extras.bpm) facts.push(`${Math.round(extras.bpm)} BPM`);
  if (extras.musicalKey) facts.push(extras.musicalKey);
  if (facts.length) text += ` ${facts.join(', ')}.`;

  return text;
}

function an(word) {
  return (/^[aeiou]/i.test(word) ? 'an ' : 'a ') + word;
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Description that is unique within the batch (the audio analysis extras are reused).
function uniqueDescription(title, extras, used) {
  let d = generateDescription(title, extras);
  for (let i = 0; i < 30 && used.has(d); i++) d = generateDescription(title, extras);
  while (used.has(d)) d += ` ${pick(DESC.closer)}`;
  used.add(d);
  return d;
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

function shuffle(arr, rnd = Math.random) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function isTransient(err) {
  const status = err && ((err.response && err.response.status) || err.status);
  if (status) return status === 408 || status === 429 || status >= 500;
  const msg = String((err && err.message) || err).toLowerCase();
  const code = String((err && (err.code || (err.cause && err.cause.code))) || '').toUpperCase();
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR/.test(code) ||
    /fetch failed|network|timeout|timed out|socket hang up|econnreset|temporar|rate limit|too many requests|bad gateway|service unavailable|gateway/.test(msg);
}

async function withRetry(label, fn, { tries = CFG.retries, retryIf = isTransient } = {}) {
  let lastErr;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (i === tries || !retryIf(e)) break;
      const wait = CFG.retryBaseMs * 2 ** (i - 1);
      log(`[~] ${label} failed (${e.message || e}); retry ${i}/${tries - 1} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Reads the body of an SDK error (it carries a fetch Response) like the original script did.
async function describeError(err) {
  let detail = '';
  try {
    if (err && err.response && typeof err.response.clone === 'function') {
      detail = `HTTP ${err.response.status} ${(await err.response.clone().text()).slice(0, 300)}`;
    }
  } catch (_) {}
  return detail || (err && err.message) || String(err);
}

// ---------------------------------------------------------------------------
// Date / week helpers (week starts Friday at 12:00 PM Pacific; the clock is shifted back by resetHour)
// ---------------------------------------------------------------------------
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
    throw new Error(`Invalid RESET_TIMEZONE "${CFG.timezone}": ${e.message}`);
  }
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const today = `${p.year}-${p.month}-${p.day}`;
  const dayIndex = ['Friday', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'].indexOf(p.weekday);
  return { today, dayName: p.weekday, dayIndex, weekStart: addDays(today, -dayIndex), tz: CFG.timezone };
}

// ---------------------------------------------------------------------------
// up_tracks history (stored once, on the TARGET_ADDRESS row only)
//   { week_start, days: [ {date, day, address, handle, track_id, original_title,
//                          published_title, generated_track, status, ...} ] }
//   One flat list for all accounts; each entry carries the account's "address".
//   status: reserved -> publishing -> success | failed   (only "success" counts)
//   The same object additionally carries a temporary "lock" key.
// ---------------------------------------------------------------------------
const isCurrentWeek = (raw, weekStart) => isObj(raw) && raw.week_start === weekStart && Array.isArray(raw.days);

function normalizeHistory(raw, weekStart) {
  if (isCurrentWeek(raw, weekStart)) return { ...raw, days: raw.days.map(d => ({ ...d })) };
  if (isObj(raw) && Array.isArray(raw.days) && raw.days.length) {
    const end = addDays(weekStart, 7);
    if (raw.days.every(d => d.date >= weekStart && d.date < end)) return { ...raw, week_start: weekStart, days: raw.days.map(d => ({ ...d })) };
  }
  const h = { week_start: weekStart, days: [] }; // new week (or default []): previous history dropped
  if (isObj(raw) && raw.lock) h.lock = raw.lock;
  if (isObj(raw) && Array.isArray(raw.used_accounts)) h.used_accounts = [...raw.used_accounts]; // kept across weeks
  if (isObj(raw) && Array.isArray(raw.has_tracks)) h.has_tracks = [...raw.has_tracks];         // kept across weeks
  return h;
}

function cleanEntry(e) {
  const out = {
    address: e.address, date: e.date, day: e.day, handle: e.handle == null ? null : e.handle,
    track_id: e.track_id == null ? null : e.track_id,
    original_title: e.original_title, published_title: e.published_title,
    generated_track: e.generated_track, status: e.status,
  };
  if (e.attempt_started_at) out.attempt_started_at = e.attempt_started_at;
  if (e.error) out.error = e.error;
  return out;
}

// ---------------------------------------------------------------------------
// Supabase access
// ---------------------------------------------------------------------------
function connectSupabase() {
  if (!fs.existsSync(DB_FILE)) throw new Error(`db.txt not found at: ${DB_FILE}`);
  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) throw new Error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
  return createClient(urlMatch[1], keyMatch[1]);
}

const anyErr = () => true;

async function fetchAllRows(sb) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const data = await withRetry('load accounts', async () => {
      const { data, error } = await sb.from('audius').select('*').order('address', { ascending: true }).range(from, from + page - 1);
      if (error) throw new Error(error.message);
      return data || [];
    }, { retryIf: anyErr });
    out.push(...data);
    if (data.length < page) break;
  }
  return out;
}

async function readRow(sb, address) {
  const { data, error } = await sb.from('audius').select('address, up_tracks').eq('address', address).limit(1);
  if (error) throw new Error(error.message);
  return data && data[0];
}

// Lock currently held by this run (set in runDaily). While set, every write to the
// history row is conditional on that lock token, so a run whose lock was taken over
// can never overwrite the new owner's data.
let HELD_LOCK = null;

// Read-modify-write of the single history row (TARGET_ADDRESS).
async function updateHistory(sb, weekStart, mutate) {
  return withRetry(`db update ${TARGET_ADDRESS}`, async () => {
    const row = await readRow(sb, TARGET_ADDRESS);
    if (!row) throw new Error(`history row not found: ${TARGET_ADDRESS}`);
    const hist = normalizeHistory(row.up_tracks, weekStart);
    if (HELD_LOCK && !(hist.lock && hist.lock.token === HELD_LOCK.token)) {
      throw new LockLostError('batch lock was taken over by another run');
    }
    if (mutate(hist) === false) return hist;
    let q = sb.from('audius').update({ up_tracks: hist }).eq('address', TARGET_ADDRESS);
    if (HELD_LOCK) q = q.eq('up_tracks->lock->>token', HELD_LOCK.token);
    const { data, error } = await q.select('address, up_tracks');
    if (error) throw new Error(error.message);
    if (!data || data.length !== 1) {
      if (HELD_LOCK) throw new LockLostError('batch lock was taken over by another run');
      throw new Error(`update affected ${data ? data.length : 0} rows`);
    }
    return normalizeHistory(data[0].up_tracks, weekStart); // value as stored by the database
  }, { retryIf: e => !(e instanceof LockLostError) });
}

// Insert/update today's record for an account and verify what the database stored.
async function upsertEntry(sb, ctx, address, patch) {
  const sameEntry = d => d.date === patch.date && d.address === address;
  const stored = await updateHistory(sb, ctx.weekStart, hist => {
    const i = hist.days.findIndex(sameEntry);
    if (i >= 0) {
      if (hist.days[i].status === 'success' && patch.status !== 'success') return false; // never downgrade
      hist.days[i] = cleanEntry({ ...hist.days[i], ...patch, address });
    } else {
      hist.days.push(cleanEntry({ ...patch, address }));
    }
    if (!(hist.used_accounts || []).includes(address)) hist.used_accounts = [...(hist.used_accounts || []), address];
    return true;
  });
  const saved = stored.days.find(sameEntry);
  if (saved && saved.status === 'success' && patch.status !== 'success') return saved;
  if (!saved || saved.status !== patch.status || (patch.track_id !== undefined && (saved.track_id || null) !== (patch.track_id || null))) {
    throw new Error(`database verification failed for ${address} (${patch.date})`);
  }
  return saved;
}

// Weekly reset (Friday 12:00 PM Pacific): if the history row is not for the current week it is re-initialised
// (days emptied, lock kept). A row already holding the current week is left untouched.
async function weeklyResetPass(sb, rows, ctx) {
  const row = rows.find(r => r.address === TARGET_ADDRESS);
  if (row && isCurrentWeek(row.up_tracks, ctx.weekStart)) return 0;
  log(`[*] Week ${ctx.weekStart}: initialising weekly history on ${TARGET_ADDRESS}...`);
  await updateHistory(sb, ctx.weekStart, () => true);
  return 1;
}

// ---------------------------------------------------------------------------
// Batch lock (atomic compare-and-set on one coordinator row's up_tracks.lock)
// ---------------------------------------------------------------------------
class LockLostError extends Error {}

// true = owner process is alive on this host, false = it is gone, null = cannot tell
// (lock written by an older version without pid/host, or by another machine).
function lockOwnerAlive(lock) {
  if (!lock.pid || lock.host !== os.hostname()) return null;
  try { process.kill(lock.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Does the stored history hold ANY entry for today? ("days": [] => no.)
function adoptWeekBatch(rows, ctx) {
  if (CFG.forceRun) return;
  const row = rows.find(r => r.address === TARGET_ADDRESS);
  const days = normalizeHistory(row && row.up_tracks, ctx.weekStart).days.filter(d => d.date);
  if (!days.length) return;
  const first = days.reduce((a, d) => (d.date < a.date ? d : a), days[0]);
  ctx.today = first.date;
  if (first.day) ctx.dayName = first.day;
}

function hasDataForToday(rows, ctx) {
  const row = rows.find(r => r.address === TARGET_ADDRESS);
  return normalizeHistory(row && row.up_tracks, ctx.weekStart).days.some(d => d.date === ctx.today);
}

// Returns why an existing lock may be taken over, or null if it must be respected.
function staleLockReason(lock, rows, ctx) {
  if (!(Date.parse(lock.expires_at) > Date.now())) return 'it expired';
  const alive = lockOwnerAlive(lock);
  if (alive === true) return null;                      // live owner on this machine: never take over
  if (alive === false) return 'its owner process is no longer running';
  // Owner unknown: look at the data. Nothing recorded for today ("days": []) means no work
  // to protect, so a lock that old is a leftover of a run that died before saving anything.
  const age = Date.now() - Date.parse(lock.acquired_at);
  if (CFG.lockIdleMs > 0 && age >= CFG.lockIdleMs && !hasDataForToday(rows, ctx)) {
    return `no data is recorded for ${ctx.today} ("days" is empty)`;
  }
  return null;
}

async function acquireLock(sb, rows, ctx) {
  const coordAddress = TARGET_ADDRESS; // the one history row (see TARGET_ADDRESS)
  const fresh = await readRow(sb, coordAddress);
  const raw = fresh ? fresh.up_tracks : null;
  const existing = isObj(raw) && isObj(raw.lock) ? raw.lock : null;
  if (existing && existing.token) {
    const why = staleLockReason(existing, rows, ctx);
    if (!why) {
      log(`[!] Another run holds the batch lock (since ${existing.acquired_at}). Exiting.`);
      return null;
    }
    log(`[~] Taking over batch lock from ${existing.acquired_at}: ${why}.`);
  }

  const token = crypto.randomUUID();
  const lock = {
    token, acquired_at: new Date().toISOString(), expires_at: new Date(Date.now() + CFG.lockTtlMs).toISOString(),
    pid: process.pid, host: os.hostname(),
  };
  const next = isObj(raw) ? { ...raw, lock } : { week_start: ctx.weekStart, days: [], lock };

  let q = sb.from('audius').update({ up_tracks: next }).eq('address', coordAddress);
  q = existing && existing.token
    ? q.eq('up_tracks->lock->>token', existing.token).eq('up_tracks->lock->>expires_at', existing.expires_at)
    : q.is('up_tracks->lock->>token', null);
  const { data, error } = await q.select('address');
  if (error) throw new Error(`lock acquisition failed: ${error.message}`);
  if (!data || data.length !== 1) {
    log('[!] Lost the race for the batch lock to another run. Exiting.');
    return null;
  }
  log('[+] Batch lock acquired.');
  return { token, address: coordAddress };
}

async function renewLock(sb, lock) {
  await withRetry('renew lock', async () => {
    const row = await readRow(sb, lock.address);
    const raw = row && row.up_tracks;
    const cur = isObj(raw) && isObj(raw.lock) ? raw.lock : null;
    if (!cur || cur.token !== lock.token) throw new LockLostError('batch lock was taken over by another run');
    const next = { ...raw, lock: { ...cur, expires_at: new Date(Date.now() + CFG.lockTtlMs).toISOString() } };
    const { data, error } = await sb.from('audius').update({ up_tracks: next })
      .eq('address', lock.address).eq('up_tracks->lock->>token', lock.token).select('address');
    if (error) throw new Error(error.message);
    if (!data || data.length !== 1) throw new LockLostError('batch lock was taken over by another run');
  }, { retryIf: e => !(e instanceof LockLostError) });
}

async function releaseLock(sb, lock) {
  if (!lock) return;
  try {
    const row = await readRow(sb, lock.address);
    const raw = row && row.up_tracks;
    if (!isObj(raw) || !isObj(raw.lock) || raw.lock.token !== lock.token) return;
    const { lock: _drop, ...rest } = raw;
    await sb.from('audius').update({ up_tracks: rest }).eq('address', lock.address).eq('up_tracks->lock->>token', lock.token);
    log('[+] Batch lock released.');
  } catch (e) {
    console.error(`[!] Could not release batch lock (it will expire on its own): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Accounts & selection
// ---------------------------------------------------------------------------
const hasCreds = r => !!(r.user_id && r.app_data && r.app_data.api_key && r.app_data.api_secret && r.app_data.bearer_token);

// The Audius handle is stored in the audius.handle column.
function detectHandle(row) {
  return typeof row.handle === 'string' && row.handle.trim() ? row.handle.trim().replace(/^@/, '') : null;
}

function buildAccounts(rows, ctx) {
  const row = rows.find(r => r.address === TARGET_ADDRESS);
  const allDays = normalizeHistory(row && row.up_tracks, ctx.weekStart).days;
  return rows.map(r => {
    const history = { week_start: ctx.weekStart, days: allDays.filter(d => d.address === r.address) };
    const handle = detectHandle(r);
    return {
      address: r.address, user_id: r.user_id, app_data: r.app_data, handle,
      hasCreds: hasCreds(r), history,
      todayEntry: history.days.find(d => d.date === ctx.today) || null,
      successCount: history.days.filter(d => d.status === 'success').length,
    };
  });
}

const isBatchComplete = accounts => {
  const today = accounts.filter(a => a.todayEntry);
  return today.length >= CFG.accountsPerDay && today.every(a => a.todayEntry.status === 'success' && a.todayEntry.track_id);
};

function makeSdk(acct) {
  return sdkFactory({
    apiKey: acct.app_data.api_key,
    apiSecret: acct.app_data.api_secret,
    bearerToken: acct.app_data.bearer_token,
  });
}

// Does this account already have tracks on Audius? (any public track counts)
async function hasUploadedTracks(acct) {
  const res = await withRetry(`check uploads ${acct.handle || acct.address}`, () => makeSdk(acct).users.getTracksByUser({ id: acct.user_id, limit: 1 }));
  return !!(res && Array.isArray(res.data) && res.data.length);
}

// 100% random selection. An account is never picked if it was selected in a previous week (used_accounts)
// or is known to have uploaded tracks (has_tracks). Each randomly drawn account is then checked on Audius:
// accounts that already have tracks are dropped (and remembered), the rest are used. Drawing continues
// until `need` accounts without any uploaded track are found.
async function chooseAccounts(sb, accounts, ctx, need, blocked, hist) {
  const used = new Set([...(hist.used_accounts || []), ...accounts.filter(a => a.history.days.length).map(a => a.address)]);
  const hasTracks = new Set(hist.has_tracks || []);
  const pool = shuffle(accounts.filter(a => a.hasCreds && !a.todayEntry && a.successCount === 0 && !blocked.has(a.address) && !used.has(a.address) && !hasTracks.has(a.address)));
  const picked = [];
  const dropped = [];
  let unchecked = 0;
  let i = 0;
  while (picked.length < need && i < pool.length) {
    const chunk = pool.slice(i, i + (need - picked.length));
    i += chunk.length;
    for (const acct of chunk) {
      try {
        if (await hasUploadedTracks(acct)) dropped.push(acct); else picked.push(acct);
      } catch (e) {
        unchecked++;
        log(`[!] Could not check uploaded tracks for ${acct.handle || acct.address}; skipping it: ${e.message || e}`);
      }
    }
  }
  if (dropped.length) {
    await updateHistory(sb, ctx.weekStart, h => {
      const known = new Set(h.has_tracks || []);
      dropped.forEach(a => known.add(a.address));
      h.has_tracks = [...known];
    });
    log(`[*] Dropped ${dropped.length} randomly drawn account(s) that already have uploaded tracks.`);
  }
  if (picked.length < need) {
    throw new Error(`Not enough eligible accounts: need ${need} more account(s) without uploaded tracks, found ${picked.length} (${dropped.length} had tracks, ${unchecked} could not be checked, ${pool.length - i} left unchecked).`);
  }
  return picked;
}

// One unique track per account, always with the track's original title.
function assignNewAccounts(newAccounts, todayAccounts, tracks) {
  const taken = new Set(todayAccounts.map(a => a.todayEntry.generated_track));
  const free = shuffle(tracks.filter(t => !taken.has(t.slot)));
  if (free.length < newAccounts.length) {
    throw new Error(`Only ${free.length} unassigned track(s) for ${newAccounts.length} account(s).`);
  }
  return newAccounts.map((acct, i) => ({ acct, slot: free[i].slot, track: free[i], title: free[i].title }));
}

// ---------------------------------------------------------------------------
// Local recovery journal
// ---------------------------------------------------------------------------
function loadJournal() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { date: j.date || null, tracks: Array.isArray(j.tracks) ? j.tracks : [], uploads: isObj(j.uploads) ? j.uploads : {} };
  } catch (_) {
    return { date: null, tracks: [], uploads: {} };
  }
}

function saveJournal(j) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------------------------------------------------------------------------
// Music generation (music/create_track.py in batches of 3, 3, 3 and 1)
// ---------------------------------------------------------------------------
function snapshotDir(dir, ext) {
  const m = new Map();
  if (!fs.existsSync(dir)) return m;
  for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) m.set(f, fs.statSync(path.join(dir, f)).mtimeMs);
  return m;
}

function newFiles(dir, ext, snap) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(ext)) continue;
    const st = fs.statSync(path.join(dir, f));
    const prev = snap.get(f);
    if (st.size > 0 && (prev === undefined || st.mtimeMs > prev)) out.push({ name: f, path: path.join(dir, f), mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
}

// tracks_dl.py saves {safe_title}.mp3 and images/{safe_title}.jpg, so a complete track
// is an mp3 with a cover of the exact same base name. An mp3 without its cover is skipped
// (the cover is optional in the downloader) and made up by the top-up run.
function pairFiles(mp3s, jpgs) {
  const base = f => f.name.replace(/\.[^.]+$/, '');
  const pairs = [];
  for (const m of mp3s) {
    const j = jpgs.find(x => base(x) === base(m));
    if (j) pairs.push({ mp3: m, jpg: j });
    else log(`[~] ${m.name} has no cover image; not counted as a complete track.`);
  }
  return pairs;
}

function titleFromFilename(audioFilename) {
  const rawTitle = audioFilename.replace('.mp3', '').replace(/-/g, ' ');
  return rawTitle.replace(/\b\w/g, c => c.toUpperCase());
}

function batchSizes(n) {
  const sizes = [];
  for (let left = n; left > 0; left -= CFG.trackBatchSize) sizes.push(Math.min(CFG.trackBatchSize, left));
  return sizes;
}

function nextSlot(tracks) {
  const used = new Set(tracks.map(t => t.slot));
  let i = 1;
  while (used.has(`track_${i}`)) i++;
  return `track_${i}`;
}

// One create_track.py run. It queues `count` songs, then calls tracks_dl.download_tracks()
// itself and blocks until they are downloaded (audio + cover) and removed from AceMusic,
// so the next batch always starts from a clean slate.
function runGenerationBatch(count, label) {
  const snapA = snapshotDir(MUSIC_DIR, '.mp3');
  const snapJ = snapshotDir(IMAGES_DIR, '.jpg');
  log(`[*] ${label}: generating ${count} track(s); tracks_dl.py will download them (MAX_TRACKS=${count})...`);
  try {
    execSync('python3 music/create_track.py', {
      cwd: ROOT_DIR, stdio: 'inherit', timeout: CFG.genTimeoutMs,
      env: { ...process.env, MAX_TRACKS: String(count) },
    });
  } catch (e) {
    console.error(`[!] Python script failed: ${e.message}`);
  }
  return pairFiles(newFiles(MUSIC_DIR, '.mp3', snapA), newFiles(IMAGES_DIR, '.jpg', snapJ));
}

// Generates (or finishes generating) the day's tracks batch by batch: 3, then 3, then 3,
// then the final 1 = 10. `afterBatch(tracks)` runs after every batch (journal + lock renewal).
async function generateTracks(existing, afterBatch) {
  const total = CFG.tracksPerDay;
  const tracks = [...existing];
  const seen = new Set(tracks.map(t => t.audioPath));
  const sizes = batchSizes(total - tracks.length);

  for (let b = 0; b < sizes.length; b++) {
    let need = sizes[b];
    for (let attempt = 0; attempt <= CFG.genTopUpAttempts && need > 0; attempt++) {
      const label = `Batch ${b + 1}/${sizes.length}${attempt ? ` (top-up ${attempt})` : ''}`;
      const fresh = runGenerationBatch(need, label).filter(p => !seen.has(p.mp3.path)).slice(-need);
      for (const p of fresh) {
        seen.add(p.mp3.path);
        tracks.push({ slot: nextSlot(tracks), title: titleFromFilename(p.mp3.name), audioPath: p.mp3.path, coverPath: p.jpg.path });
      }
      need -= fresh.length;
      log(`[*] ${label}: ${fresh.length} new track(s) downloaded; ${tracks.length}/${total} total.`);
    }
    await afterBatch(tracks);
    if (need > 0) break; // still short after the top-up: stop; a re-run resumes from here
  }

  if (tracks.length < total) throw new Error(`Only ${tracks.length}/${total} tracks were generated`);
  return tracks.slice(0, total);
}

async function ensureTracks(ctx, journal, afterBatch) {
  const total = CFG.tracksPerDay;
  const existing = journal.date === ctx.today
    ? journal.tracks.filter(t => fs.existsSync(t.audioPath) && fs.existsSync(t.coverPath))
    : [];
  if (existing.length >= total) {
    log(`[*] Reusing the ${total} tracks already generated for today.`);
    return existing.slice(0, total);
  }
  if (existing.length) log(`[*] Resuming generation: ${existing.length}/${total} tracks already downloaded.`);
  journal.date = ctx.today;
  journal.tracks = existing;
  saveJournal(journal);
  const tracks = await generateTracks(existing, async list => {
    journal.tracks = list;
    saveJournal(journal);
    await afterBatch();
  });
  journal.tracks = tracks;
  saveJournal(journal);
  return tracks;
}

// ---------------------------------------------------------------------------
// Audius helpers
// ---------------------------------------------------------------------------
const extractTrackId = r => {
  const id = r?.data?.id || r?.data?.trackId || r?.trackId || r?.id;
  return id ? String(id) : null;
};

async function resolveHandle(sdk, userId) {
  const res = await withRetry('resolve handle', () => sdk.users.getUser({ id: userId }));
  return (res && res.data && res.data.handle) || null;
}

// Looks for a track this user already published with that title (duplicate protection).
async function findExistingTrack(sdk, userId, title, sinceIso) {
  const res = await withRetry('check existing tracks', () => sdk.users.getTracksByUser({ id: userId, limit: 100 }));
  const since = sinceIso ? Date.parse(sinceIso) - 10 * 60000 : 0;
  const hit = ((res && res.data) || []).find(t => {
    if (t.title !== title) return false;
    const ts = Date.parse(t.createdAt || t.created_at || t.releaseDate || '');
    return !(since && Number.isFinite(ts) && ts < since);
  });
  return hit ? String(hit.id) : null;
}

async function verifyTrack(sdk, trackId) {
  for (let i = 1; i <= CFG.verifyTries; i++) {
    try {
      const t = await sdk.tracks.getTrack({ trackId });
      if (t && t.data && String(t.data.id) === String(trackId)) return t.data;
    } catch (_) {}
    if (i < CFG.verifyTries) await sleep(CFG.verifyDelayMs);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recovery of ambiguous ("publishing") records from an interrupted run
// ---------------------------------------------------------------------------
async function reconcileAmbiguous(sb, accounts, ctx, journal) {
  const blocked = new Set();
  for (const acct of accounts) {
    if (!acct.hasCreds) continue;
    for (const entry of acct.history.days) {
      const jr = journal.uploads[acct.address];
      const journaled = jr && jr.date === entry.date && entry.status !== 'success';
      if (entry.status !== 'publishing' && !journaled) continue;
      const sdk = makeSdk(acct);
      try {
        const known = entry.track_id || (journaled && jr.track_id);
        let id = null;
        if (known) id = (await verifyTrack(sdk, known)) ? String(known) : null;
        if (!id) id = await findExistingTrack(sdk, acct.user_id, entry.published_title, entry.attempt_started_at);
        if (id) {
          await upsertEntry(sb, ctx, acct.address, { ...entry, track_id: id, status: 'success', error: undefined });
          log(`[+] Recovered ${entry.date} publication for ${acct.handle || acct.address}: track ${id} (no re-upload).`);
          delete journal.uploads[acct.address]; saveJournal(journal);
        } else if (entry.date !== ctx.today) {
          await upsertEntry(sb, ctx, acct.address, { ...entry, track_id: null, status: 'failed', error: 'unconfirmed publication; no track found on Audius' });
        } else {
          await upsertEntry(sb, ctx, acct.address, { ...entry, track_id: null, status: 'reserved', attempt_started_at: undefined, error: undefined });
        }
      } catch (e) {
        blocked.add(acct.address);
        log(`[!] Cannot confirm earlier publication for ${acct.handle || acct.address}; skipping it this run: ${e.message || e}`);
      }
    }
  }
  return blocked;
}

// ---------------------------------------------------------------------------
// Upload one account (existing SDK flow, per-account credentials)
// ---------------------------------------------------------------------------
async function publishOne(sb, ctx, acct, entry, track, usedDescriptions, journal) {
  const userId = acct.user_id;
  const sdk = makeSdk(acct); // this account's own api_key / api_secret / bearer_token
  if (!entry.handle) {
    try { entry.handle = await resolveHandle(sdk, userId); } catch (_) {}
  }

  // In Node the SDK expects plain { buffer, name, type } file objects.
  const trackFile = { buffer: fs.readFileSync(track.audioPath), name: path.basename(track.audioPath), type: 'audio/mpeg' };
  const coverArtFile = { buffer: fs.readFileSync(track.coverPath), name: path.basename(track.coverPath), type: 'image/jpeg' };

  // createTrack() only publishes metadata. The files must be uploaded to the
  // storage nodes first, and createTrack gets the resulting CIDs.
  log(`    [*] Uploading audio...`);
  const audio = await withRetry('audio upload', async () => {
    const a = await sdk.uploads.createAudioUpload({ file: trackFile, userId }).start();
    if (!a || !a.trackCid) throw new Error(`audio upload returned no trackCid: ${JSON.stringify(a)}`);
    return a;
  });

  log(`    [*] Uploading cover...`);
  const coverCid = await withRetry('cover upload', async () => {
    const c = await sdk.uploads.createImageUpload({ file: coverArtFile, isBackdrop: false }).start();
    if (!c || typeof c !== 'string') throw new Error(`cover upload returned no CID: ${JSON.stringify(c)}`);
    return c;
  });

  const description = uniqueDescription(entry.published_title, { bpm: audio.bpm, musicalKey: audio.musicalKey }, usedDescriptions);
  log(`    [+] Title: ${entry.published_title}`);
  log(`    [+] Description: ${description}`);

  // Intent marker: if we crash after this point the next run checks Audius before uploading again.
  const attemptAt = new Date().toISOString();
  Object.assign(entry, await upsertEntry(sb, ctx, acct.address, { ...entry, status: 'publishing', attempt_started_at: attemptAt, error: undefined }));

  const payload = {
    userId,
    metadata: {
      title: entry.published_title,
      genre: 'Electronic',
      mood: 'Energizing',
      description,
      // Must be a Date object (the SDK calls .toISOString() on it).
      releaseDate: new Date(),
      isStreamGated: false,
      isDownloadGated: false,
      isUnlisted: false,
      trackCid: audio.trackCid,
      origFileCid: audio.origFileCid,
      origFilename: audio.origFilename,
      duration: audio.duration,
      // Audius stores the artwork CID as coverArtSizes; coverArt is kept as a
      // fallback name. Unknown fields are ignored by the SDK, so this is safe.
      coverArtSizes: coverCid,
      coverArt: coverCid,
    },
  };

  log(`    [*] Publishing track...`);
  let trackId = null;
  for (let attempt = 1; !trackId; attempt++) {
    let resp, createErr = null;
    try { resp = await sdk.tracks.createTrack(payload); } catch (e) { createErr = e; }
    trackId = createErr ? null : extractTrackId(resp);
    if (trackId) break;
    // Not confirmed. Never retry blindly: first check whether the track actually landed.
    await sleep(CFG.verifyDelayMs);
    try {
      trackId = await findExistingTrack(sdk, userId, entry.published_title, attemptAt);
    } catch (lookupErr) {
      lookupErr.ambiguous = true;
      lookupErr.message = `publish outcome unknown (${lookupErr.message}); will be checked on next run`;
      throw lookupErr;
    }
    if (trackId) { log(`    [+] Track had already been published; reusing its ID.`); break; }
    if (!createErr) throw new Error('createTrack returned no track ID and no matching track was found');
    if (attempt >= CFG.retries || !isTransient(createErr)) throw createErr;
    await sleep(CFG.retryBaseMs * 2 ** (attempt - 1));
  }

  // Keep the ID locally first, so a database failure can never lead to a duplicate upload.
  journal.uploads[acct.address] = { date: ctx.today, track_id: trackId, published_title: entry.published_title, handle: entry.handle || null };
  saveJournal(journal);
  entry.track_id = trackId;
  try { await upsertEntry(sb, ctx, acct.address, { ...entry, status: 'publishing', track_id: trackId }); } catch (_) {}

  const verified = await verifyTrack(sdk, trackId);
  if (!verified) {
    const e = new Error(`track ${trackId} was created but could not be verified on Audius yet`);
    e.ambiguous = true;
    throw e;
  }
  // Confirm the cover actually attached (unknown metadata fields are silently
  // dropped by the SDK, which is how a track can publish without artwork).
  const art = verified.artwork;
  log(art && Object.keys(art).length > 0 ? `    [+] Cover art attached.` : `    [!] Track published, but no cover art detected (it may still be indexing).`);

  try {
    await upsertEntry(sb, ctx, acct.address, { ...entry, status: 'success', track_id: trackId, error: undefined });
  } catch (e) {
    e.ambiguous = true;
    e.message = `published on Audius as ${trackId} but the database update failed (${e.message}); saved in the local journal for recovery`;
    throw e;
  }
  delete journal.uploads[acct.address];
  saveJournal(journal);
  return trackId;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
function printSummary(ctx, accounts, tracksCount, status, failures) {
  const today = accounts.filter(a => a.todayEntry);
  const ok = today.filter(a => a.todayEntry.status === 'success');
  const bad = today.filter(a => a.todayEntry.status !== 'success');
  log('\n==============================');
  log('AUDIUS PUBLISHING SUMMARY');
  log('==============================');
  log(`Date: ${ctx.today} (${ctx.dayName}, ${ctx.tz})`);
  log(`Week start (Friday 12:00 PM ${ctx.tz}): ${ctx.weekStart}\n`);
  log(`Accounts selected: ${today.length}`);
  log(`Tracks generated: ${tracksCount}`);
  log(`Tracks published: ${ok.length}\n`);
  log(`Successful uploads: ${ok.length}`);
  log(`Failed uploads: ${bad.length}\n`);
  if (bad.length) {
    log('\nFailed accounts:');
    for (const a of bad) {
      log(`- ${a.handle || a.address}: ${(failures.get(a.address)) || a.todayEntry.error || a.todayEntry.status}`);
    }
  }
  log(`\nBatch status: ${status}\n`);
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------
async function runDaily({ now = new Date() } = {}) {
  const ctx = buildContext(now);
  const sb = connectSupabase();
  // 1. Duplicate-run check against the database BEFORE generating or selecting anything.
  let rows = await fetchAllRows(sb);
  if (!rows.length) throw new Error('audius table returned no accounts');
  if (!rows.some(r => r.address === TARGET_ADDRESS)) throw new Error(`history row not found in audius table: ${TARGET_ADDRESS}`);
  adoptWeekBatch(rows, ctx);
  log(`[*] Publishing date ${ctx.today} (${ctx.dayName}, ${ctx.tz}); week starts Friday 12:00 PM ${ctx.weekStart}.`);
  if (isBatchComplete(buildAccounts(rows, ctx))) {
    log(ALREADY_DONE_MSG);
    return { status: 'ALREADY_COMPLETED' };
  }

  // 2. Take the database-backed batch lock.
  const lock = await acquireLock(sb, rows, ctx);
  if (!lock) return { status: 'LOCKED' };
  HELD_LOCK = lock;

  try {
    // 3. Re-check under the lock, then handle the weekly reset and interrupted runs.
    rows = await fetchAllRows(sb);
    adoptWeekBatch(rows, ctx);
    if (isBatchComplete(buildAccounts(rows, ctx))) {
      log(ALREADY_DONE_MSG);
      return { status: 'ALREADY_COMPLETED' };
    }
    if (await weeklyResetPass(sb, rows, ctx)) rows = await fetchAllRows(sb);

    const journal = loadJournal();
    let accounts = buildAccounts(rows, ctx);
    const blocked = await reconcileAmbiguous(sb, accounts, ctx, journal);
    rows = await fetchAllRows(sb);
    adoptWeekBatch(rows, ctx);
    accounts = buildAccounts(rows, ctx);
    if (isBatchComplete(accounts)) {
      log(ALREADY_DONE_MSG);
      return { status: 'ALREADY_COMPLETED' };
    }
    // 4. Work out who still has to be published today.
    const todayAccounts = accounts.filter(a => a.todayEntry);
    const pending = todayAccounts.filter(a => a.todayEntry.status !== 'success' && !blocked.has(a.address));
    const needMore = CFG.accountsPerDay - todayAccounts.length;
    let selected = [];
    try {
      const hist = normalizeHistory((rows.find(r => r.address === TARGET_ADDRESS) || {}).up_tracks, ctx.weekStart);
      selected = needMore > 0 ? await chooseAccounts(sb, accounts, ctx, needMore, blocked, hist) : [];
    } catch (e) {
      console.error(`[!] ${e.message}`);
      return { status: 'ABORTED' };
    }
    if (todayAccounts.length) {
      log(`[*] Resuming today's batch: ${todayAccounts.length - pending.length - blocked.size} done, ${pending.length} pending, ${selected.length} still to select.`);
    }
    if (!pending.length && !selected.length) {
      log('[!] Nothing left to publish, but the batch could not be confirmed complete (see warnings above).');
      return { status: 'INCOMPLETE' };
    }

    // 5. Generate the 10 tracks (batches of 3, 3, 3, then 1; each downloaded via tracks_dl.py
    //    before the next starts) or reuse today's, before touching Audius.
    let tracks;
    try {
      tracks = await ensureTracks(ctx, journal, () => renewLock(sb, lock));
    } catch (e) {
      if (e instanceof LockLostError) throw e;
      console.error(`[!] Music generation failed: ${e.message}. Nothing was published; exiting safely.`);
      return { status: 'GENERATION_FAILED' };
    }
    log('\n[+] Generated tracks:');
    tracks.forEach(t => log(`    ${t.slot}: "${t.title}"  (${path.basename(t.audioPath)} + ${path.basename(t.coverPath)})`));

    // 6. Re-point pending records at today's files if their track no longer matches
    //    (each account keeps its own unique track, never shared).
    const validSlot = e => tracks.some(t => t.slot === e.generated_track && t.title === e.original_title);
    const taken = new Set(todayAccounts.filter(a => a.todayEntry.status === 'success' || validSlot(a.todayEntry)).map(a => a.todayEntry.generated_track));
    const free = shuffle(tracks.filter(t => !taken.has(t.slot)));
    for (const a of pending) {
      const e = a.todayEntry;
      if (validSlot(e)) continue;
      const t = free.pop();
      if (!t) throw new Error(`No unassigned track left for ${a.handle || a.address}`);
      Object.assign(e, await upsertEntry(sb, ctx, a.address, { ...e, generated_track: t.slot, original_title: t.title, published_title: t.title }));
    }

    // 7. Assign one unique track (original title) to each newly selected account and reserve them in the database.
    const queue = pending.map(a => ({ acct: a, entry: a.todayEntry }));
    if (selected.length) {
      for (const a of selected) {
        if (!a.handle) {
          try { a.handle = await resolveHandle(makeSdk(a), a.user_id); } catch (_) {}
        }
      }
      const assignments = assignNewAccounts(selected, todayAccounts, tracks);
      for (const { acct, slot, track, title } of assignments) {
        const entry = await upsertEntry(sb, ctx, acct.address, {
          date: ctx.today, day: ctx.dayName, handle: acct.handle || null, track_id: null,
          original_title: track.title, published_title: title, generated_track: slot, status: 'reserved',
        });
        queue.push({ acct, entry });
      }
    }

    log(`\n[+] Today's accounts to publish (${queue.length}):`);
    queue.forEach(({ acct, entry }, i) => log(
      `    ${String(i + 1).padStart(2)}. ${acct.handle || acct.address}  -> ${entry.generated_track}  "${entry.published_title}"`));

    // 8. Publish sequentially, each account with its own credentials.
    const usedDescriptions = new Set();
    const failures = new Map();
    let n = 0;
    for (const { acct, entry } of queue) {
      n++;
      log(`\n[*] (${n}/${queue.length}) Publishing for ${acct.handle || acct.address}...`);
      try {
        await renewLock(sb, lock);
        const track = tracks.find(t => t.slot === entry.generated_track);
        const id = await publishOne(sb, ctx, acct, entry, track, usedDescriptions, journal);
        log(`    [+] SUCCESS! Track ID: ${id}`);
      } catch (err) {
        if (err instanceof LockLostError) throw err;
        const detail = await describeError(err);
        failures.set(acct.address, detail);
        console.error(`    [!] Audius upload failed for ${acct.handle || acct.address}: ${detail}`);
        if (!err.ambiguous) {
          try { await upsertEntry(sb, ctx, acct.address, { ...entry, track_id: null, status: 'failed', error: String(detail).slice(0, 300) }); } catch (_) {}
        }
      }
      if (CFG.uploadDelayMs && n < queue.length) await sleep(CFG.uploadDelayMs);
    }

    // 9. Final verification straight from the database.
    accounts = buildAccounts(await fetchAllRows(sb), ctx);
    const complete = isBatchComplete(accounts);
    printSummary(ctx, accounts, tracks.length, complete ? 'COMPLETED' : 'INCOMPLETE (re-run to recover)', failures);
    return { status: complete ? 'COMPLETED' : 'INCOMPLETE' };
  } finally {
    HELD_LOCK = null;
    await releaseLock(sb, lock);
  }
}

async function main() {
  const result = await runDaily();
  if (['INCOMPLETE', 'GENERATION_FAILED', 'ABORTED'].includes(result.status)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[!] Fatal error:', err.message || err);
    process.exit(1);
  });
}

module.exports = { runDaily, buildContext, chooseAccounts, assignNewAccounts, batchSizes, normalizeHistory, upsertEntry };
