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
  let msg = String((err && err.message) || err).replace(/\s+/g, ' ');
  const res = err && err.response;
  if (res && res.status) {
    let detail = '';
    try {
      detail = (await res.clone().text()).replace(/\s+/g, ' ').slice(0, 80);
    } catch (_) {}
    msg = `HTTP ${res.status}${detail ? ` ${detail}` : ''}`;
  }
  return msg.slice(0, 120);
}

// One attempt: checks the live profile first, then fills in only what's missing.
// Throws on errors so the caller can retry; returns a status string otherwise.
async function attemptAccount(account, tag) {
  const { user_id: userId, app_data: appData } = account;

  const sdk = sdkFactory({
    apiKey: appData.api_key,
    apiSecret: appData.api_secret,
    bearerToken: appData.bearer_token,
  });

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
  const metadata = {};
  if (missing.bio) metadata.bio = generateBio();
  if (missing.photo) metadata.profilePicture = await uploadPhoto(sdk);
  if (missing.cover) metadata.coverPhoto = await uploadCover(sdk);

  await sdk.users.updateUser({ id: userId, userId, metadata });

  log(`${tag}  added ${need.join(' + ')}${have.length ? ` (already had ${have.join(' + ')})` : ''}`);
  return 'updated';
}

// Runs an account, retrying up to MAX_RETRIES times if a request fails.
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
      if (attempt >= MAX_RETRIES) {
        log(`${tag}  failed after ${MAX_RETRIES} retries: ${reason}`);
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
}

main().catch(err => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
