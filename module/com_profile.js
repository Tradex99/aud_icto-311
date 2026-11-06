#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

let sdkPkg;
try {
  sdkPkg = require('@audius/sdk');
} catch (e) {
  console.error(`[!] Failed to require @audius/sdk:`, e.message);
  process.exit(1);
}

let sdkFactory;
if (typeof sdkPkg === 'function') {
  sdkFactory = sdkPkg;
} else if (typeof sdkPkg.sdk === 'function') {
  sdkFactory = sdkPkg.sdk;
} else if (typeof sdkPkg.default === 'function') {
  sdkFactory = sdkPkg.default;
} else if (sdkPkg.default && typeof sdkPkg.default.sdk === 'function') {
  sdkFactory = sdkPkg.default.sdk;
} else {
  sdkFactory = Object.values(sdkPkg).find(v => typeof v === 'function' && v.name.toLowerCase().includes('sdk'));
}

if (!sdkFactory) {
  console.error(`[!] Could not find SDK factory function in @audius/sdk exports.`);
  process.exit(1);
}

// Keep our own output (log) and silence the SDK's chatty console output.
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

const WORDS = {
  role: ["producer", "beatmaker", "DJ", "songwriter", "vocalist", "sound designer", "musician", "artist", "listener", "creator"],
  genre: ["lofi", "house", "techno", "hip-hop", "ambient", "trap", "indie", "synthwave", "drum and bass", "soul", "jazz", "electronic", "chillhop", "R&B"],
  adj: ["late-night", "dreamy", "deep", "raw", "smooth", "experimental", "groovy", "moody", "bass-heavy", "melodic", "atmospheric", "underground"],
  noun: ["vibes", "rhythms", "textures", "melodies", "loops", "basslines", "soundscapes", "grooves", "harmonies", "beats"],
  verb: ["Chasing", "Making", "Exploring", "Building", "Collecting", "Crafting", "Mixing", "Hunting for", "Lost in", "Obsessed with"],
  place: ["the studio", "my bedroom", "the city", "the dance floor", "headphones", "the late hours", "the underground"],
  extra: ["Always listening.", "New music soon.", "Turn it up.", "Let the music talk.", "Press play.", "Open to collabs.", "Stay tuned."]
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateBio() {
  const templates = [
    () => `${cap(pick(WORDS.genre))} ${pick(WORDS.role)}. ${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)}.`,
    () => `${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)} in ${pick(WORDS.place)}.`,
    () => `${cap(pick(WORDS.adj))} ${pick(WORDS.genre)} ${pick(WORDS.role)}. ${pick(WORDS.extra)}`,
    () => {
      const [g1, g2] = [...WORDS.genre].sort(() => Math.random() - 0.5);
      return `${cap(g1)} + ${g2}. ${pick(WORDS.verb)} ${pick(WORDS.noun)}. ${pick(WORDS.extra)}`;
    },
    () => `${cap(pick(WORDS.role))} from ${pick(WORDS.place)}. ${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)}.`,
  ];
  return pick(templates)();
}

const hasBio = u => !!(u.bio && u.bio.trim());
const hasCover = u => !!u.coverPhoto;
const hasPhoto = u => !!u.profilePicture;

// Downloads a random image and uploads it to Audius, returning the CID.
// Profile photo = square image, cover photo = wide "backdrop" image.
async function uploadImage(sdk, { width, height, isBackdrop, name }) {
  const res = await fetch(`https://picsum.photos/seed/${Math.random()}/${width}/${height}`);
  if (!res.ok) throw new Error(`image download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());

  // Node needs a plain { buffer, name } object, not a web File.
  const file = { buffer, name, type: 'image/jpeg' };

  // createImageUpload() returns { abort, start }; start() uploads and gives the CID.
  const cid = await sdk.uploads.createImageUpload({ file, isBackdrop }).start();
  if (!cid || typeof cid !== 'string') throw new Error('upload returned no CID');
  return cid;
}

const uploadPhoto = sdk => uploadImage(sdk, { width: 600, height: 600, isBackdrop: false, name: 'profile.jpg' });
const uploadCover = sdk => uploadImage(sdk, { width: 800, height: 600, isBackdrop: true, name: 'cover.jpg' });

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [3000, 8000, 15000];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Short, readable error text (includes the HTTP status when the API gave one).
async function describeError(err) {
  const res = err && err.response;
  const step = err && err.step ? `${err.step}: ` : '';
  if (res && res.status) {
    let body = '';
    try {
      body = await res.clone().text();
    } catch (_) {}
    if (res.status === 401 || res.status === 403) {
      const w = (body.match(/authedWallet=(0x[0-9a-fA-F]+)/) || [])[1];
      const wallet = w ? `, wallet ${w.slice(0, 6)}...${w.slice(-4)}` : '';
      return `${step}not authorized (HTTP ${res.status}${wallet})`;
    }
    return `${step}HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 80)}`.trim();
  }
  return (step + String((err && err.message) || err)).replace(/\s+/g, ' ').slice(0, 120);
}

// Retrying only helps for temporary problems (rate limit, server error, network).
// Other 4xx responses (e.g. 403 not authorized) will fail the same way every time.
function isRetryable(err) {
  const status = err && err.response && err.response.status;
  if (!status) return true;
  return status === 408 || status === 429 || status >= 500;
}

// One attempt: checks the live profile first, then fills in only what's missing.
// Throws on errors so the caller can decide whether to retry; otherwise returns a status.
async function attemptAccount(account, tag) {
  const { user_id: userId, app_data: appData } = account;

  const sdk = sdkFactory({
    apiKey: appData.api_key,
    apiSecret: appData.api_secret,
    bearerToken: appData.bearer_token,
  });

  // Tag errors with the step they came from, so the log says where it broke.
  let step = 'check';
  try {
    // 1. Request the current profile (fresh on every attempt, so a retry never
    //    re-adds something that a previous attempt already saved)
    const user = (await sdk.users.getUser({ id: userId })).data;
    if (!user) {
      log(`${tag}  failed: user not found`);
      return 'failed';
    }

    const missing = {
      bio: !hasBio(user),
      photo: !hasPhoto(user),
      cover: !hasCover(user),
    };
    const have = Object.keys(missing).filter(k => !missing[k]);
    const need = Object.keys(missing).filter(k => missing[k]);

    // 2. Everything exists -> skip
    if (need.length === 0) {
      log(`${tag}  skipped (has bio + photo + cover)`);
      return 'skipped';
    }

    // 3. Only generate/upload what is missing
    step = 'upload';
    const metadata = {};
    if (missing.bio) metadata.bio = generateBio();
    if (missing.photo) metadata.profilePicture = await uploadPhoto(sdk);
    if (missing.cover) metadata.coverPhoto = await uploadCover(sdk);

    step = 'update';
    await sdk.users.updateUser({ id: userId, userId, metadata });

    log(`${tag}  added ${need.join(' + ')}${have.length ? ` (already had ${have.join(' + ')})` : ''}`);
    return 'updated';
  } catch (err) {
    if (err && typeof err === 'object' && !err.step) err.step = step;
    throw err;
  }
}

// On a 403, work out WHY using two read-only checks (nothing is written):
//  1. is this app (api_key) among the apps the user has authorized?
//  2. does the bearer_token actually belong to this user?
async function diagnose403(account) {
  const { user_id: userId, app_data: a } = account;
  const sdk = sdkFactory({ apiKey: a.api_key, apiSecret: a.api_secret, bearerToken: a.bearer_token });
  const out = [];

  try {
    const res = await sdk.users.getAuthorizedApps({ id: userId });
    const apps = res && res.data;
    const key = String(a.api_key).toLowerCase().replace(/^0x/, '');
    const found = JSON.stringify(apps || []).toLowerCase().includes(key);
    const n = Array.isArray(apps) ? apps.length : '?';
    out.push(found ? `app is authorized by user (${n} apps)` : `app NOT in user's authorized apps (${n} apps)`);
  } catch (e) {
    out.push(`authorized-apps check failed (HTTP ${(e && e.response && e.response.status) || '?'})`);
  }

  try {
    const me = await sdk.users.getMe();
    const text = JSON.stringify((me && me.data) || {});
    out.push(text.includes(userId) ? 'token belongs to this user' : 'token belongs to a DIFFERENT user');
  } catch (e) {
    out.push(`token check failed (HTTP ${(e && e.response && e.response.status) || '?'})`);
  }

  return out.join('; ');
}

// Accounts that failed, listed again at the end so they're easy to find.
const failures = [];

// Runs an account, retrying only temporary errors (up to MAX_RETRIES times).
async function processAccount(account, label) {
  const { address, user_id: userId, app_data: appData } = account;
  const tag = `${label} ${address}`;

  if (!appData || !appData.api_key || !appData.api_secret || !appData.bearer_token || !userId) {
    log(`${tag}  skipped (missing credentials)`);
    return 'nocreds';
  }

  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptAccount(account, tag);
    } catch (err) {
      const reason = await describeError(err);

      if (!isRetryable(err)) {
        log(`${tag}  failed: ${reason}`);
        let full = reason;
        if (err.response && err.response.status === 403) {
          const why = await diagnose403(account).catch(e => `diagnosis failed: ${e.message || e}`);
          log(`      -> ${why}`);
          full = `${reason} -> ${why}`;
        }
        failures.push(`${address}  ${full}`);
        return 'failed';
      }
      if (attempt >= MAX_RETRIES) {
        log(`${tag}  failed after ${MAX_RETRIES} retries: ${reason}`);
        failures.push(`${address}  ${reason}`);
        return 'failed';
      }
      log(`${tag}  retry ${attempt + 1}/${MAX_RETRIES} (${reason})`);
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error('db.txt not found');
    process.exit(1);
  }

  const dbText = fs.readFileSync(DB_FILE, 'utf8');
  const urlMatch = dbText.match(/SUPABASE_URL\s*=\s*["']([^"']+)["']/);
  const keyMatch = dbText.match(/SUPABASE_KEY\s*=\s*["']([^"']+)["']/);
  if (!urlMatch || !keyMatch) {
    console.error('Could not read SUPABASE_URL / SUPABASE_KEY from db.txt');
    process.exit(1);
  }

  const supabase = createClient(urlMatch[1], keyMatch[1]);
  const { data: accounts, error } = await supabase
    .from('audius')
    .select('address, user_id, app_data')
    .not('app_data', 'is', null);

  if (error) {
    console.error('Failed to load accounts:', error.message || error);
    process.exit(1);
  }

  log(`Checking ${accounts.length} accounts\n`);

  const counts = { updated: 0, skipped: 0, failed: 0, nocreds: 0 };
  for (let i = 0; i < accounts.length; i++) {
    counts[await processAccount(accounts[i], `[${i + 1}/${accounts.length}]`)]++;
  }

  const parts = [
    `${counts.updated} updated`,
    `${counts.skipped} skipped`,
    counts.failed && `${counts.failed} failed`,
    counts.nocreds && `${counts.nocreds} missing credentials`,
  ].filter(Boolean);
  log(`\nDone: ${parts.join(', ')}`);
  if (failures.length) {
    log(`\nFailed accounts:\n${failures.map(f => `  ${f}`).join('\n')}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
