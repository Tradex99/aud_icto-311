
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

let sdkPkg;

try {
  sdkPkg = require('@audius/sdk');
} catch (e) {
  console.error('[!] Failed to require @audius/sdk:', e.message);
  process.exit(1);
}

// Support common Audius SDK export formats.
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
  sdkFactory = Object.values(sdkPkg).find(
    value =>
      typeof value === 'function' &&
      typeof value.name === 'string' &&
      value.name.toLowerCase().includes('sdk')
  );
}

if (!sdkFactory) {
  console.error('[!] Could not find SDK factory function.');
  process.exit(1);
}

// Suppress noisy SDK logs while keeping our own logs.
const log = console.log.bind(console);

for (const level of ['log', 'info', 'debug', 'warn']) {
  const original = console[level].bind(console);

  console[level] = (...args) => {
    if (
      typeof args[0] === 'string' &&
      args[0].startsWith('[audius-sdk]')
    ) return;

    original(...args);
  };
}

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');

// Bio generation words.
const WORDS = {
  role: [
    'producer', 'beatmaker', 'DJ', 'songwriter',
    'vocalist', 'sound designer', 'musician',
    'artist', 'listener', 'creator'
  ],

  genre: [
    'lofi', 'house', 'techno', 'hip-hop',
    'ambient', 'trap', 'indie', 'synthwave',
    'drum and bass', 'soul', 'jazz',
    'electronic', 'chillhop', 'R&B'
  ],

  adj: [
    'late-night', 'dreamy', 'deep', 'raw',
    'smooth', 'experimental', 'groovy', 'moody',
    'bass-heavy', 'melodic', 'atmospheric',
    'underground'
  ],

  noun: [
    'vibes', 'rhythms', 'textures', 'melodies',
    'loops', 'basslines', 'soundscapes',
    'grooves', 'harmonies', 'beats'
  ],

  verb: [
    'Chasing', 'Making', 'Exploring', 'Building',
    'Collecting', 'Crafting', 'Mixing',
    'Hunting for', 'Lost in', 'Obsessed with'
  ],

  place: [
    'the studio', 'my bedroom', 'the city',
    'the dance floor', 'headphones',
    'the late hours', 'the underground'
  ],

  extra: [
    'Always listening.', 'New music soon.',
    'Turn it up.', 'Let the music talk.',
    'Press play.', 'Open to collabs.', 'Stay tuned.'
  ]
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function cap(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function generateBio() {
  const templates = [
    () =>
      `${cap(pick(WORDS.genre))} ${pick(WORDS.role)}. ${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)}.`,

    () =>
      `${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)} in ${pick(WORDS.place)}.`,

    () =>
      `${cap(pick(WORDS.adj))} ${pick(WORDS.genre)} ${pick(WORDS.role)}. ${pick(WORDS.extra)}`,

    () => {
      const [g1, g2] = [...WORDS.genre].sort(
        () => Math.random() - 0.5
      );

      return `${cap(g1)} + ${g2}. ${pick(WORDS.verb)} ${pick(WORDS.noun)}. ${pick(WORDS.extra)}`;
    },

    () =>
      `${cap(pick(WORDS.role))} from ${pick(WORDS.place)}. ${pick(WORDS.verb)} ${pick(WORDS.adj)} ${pick(WORDS.noun)}.`
  ];

  return pick(templates)();
}

const hasBio = user => !!(user.bio && user.bio.trim());
const hasCover = user => !!user.coverPhoto;
const hasPhoto = user => !!user.profilePicture;

// Image upload.
async function uploadImage(sdk, {
  width,
  height,
  isBackdrop,
  name
}) {
  const imageUrl =
    `https://picsum.photos/seed/${Math.random()}/${width}/${height}`;

  const response = await fetch(imageUrl);

  if (!response.ok) {
    const error = new Error(
      `Image download failed (HTTP ${response.status})`
    );

    error.status = response.status;
    throw error;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  const file = {
    buffer,
    name,
    type: 'image/jpeg'
  };

  const cid = await sdk.uploads
    .createImageUpload({ file, isBackdrop })
    .start();

  if (!cid || typeof cid !== 'string') {
    throw new Error('Audius image upload returned no valid CID');
  }

  return cid;
}

const uploadPhoto = sdk => uploadImage(sdk, {
  width: 600,
  height: 600,
  isBackdrop: false,
  name: 'profile.jpg'
});

const uploadCover = sdk => uploadImage(sdk, {
  width: 800,
  height: 600,
  isBackdrop: true,
  name: 'cover.jpg'
});

// Retry configuration.
const MAX_RETRIES = 3;

const RETRY_DELAYS_MS = [
  3000,
  8000,
  15000
];

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

// Extract HTTP status from different SDK error formats.
function getHttpStatus(err) {
  const candidates = [
    err?.status,
    err?.statusCode,
    err?.response?.status,
    err?.cause?.status,
    err?.cause?.statusCode,
    err?.cause?.response?.status
  ];

  for (const value of candidates) {
    const status = Number(value);

    if (
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      return status;
    }
  }

  return null;
}

// Read response body when available.
async function getResponseBody(err) {
  const response =
    err?.response || err?.cause?.response;

  if (!response) return '';

  try {
    if (typeof response.clone === 'function') {
      return (
        await response.clone().text()
      ).replace(/\s+/g, ' ').slice(0, 1000);
    }

    if (typeof response.text === 'function') {
      return (
        await response.text()
      ).replace(/\s+/g, ' ').slice(0, 1000);
    }
  } catch (_) {
    // Response body may not be readable.
  }

  return '';
}

// Format error message.
async function describeError(err) {
  const status = getHttpStatus(err);

  const message = String(
    err?.message || err || 'Unknown error'
  ).replace(/\s+/g, ' ').slice(0, 300);

  const body = await getResponseBody(err);

  if (status) {
    return `HTTP ${status}: ${body || message}`;
  }

  return message;
}

// Retry temporary errors only.
function isRetryableError(err) {
  const status = getHttpStatus(err);

  if (status !== null) {
    return (
      status === 408 ||
      status === 425 ||
      status === 429 ||
      status >= 500
    );
  }

  // Network and transport errors may be temporary.
  return true;
}

// Detailed error logging.
function logDetailedError(tag, stage, err, reason) {
  console.error('\n[PROFILE ERROR]', tag);
  console.error('Failed stage:', stage);
  console.error('Reason:', reason);
  console.error('Error name:', err?.name || 'Error');

  const status = getHttpStatus(err);

  if (status !== null) {
    console.error('HTTP status:', status);
  }

  if (err?.response?.statusText) {
    console.error(
      'HTTP status text:',
      err.response.statusText
    );
  }

  if (err?.cause) {
    console.error(
      'Underlying cause:',
      err.cause.message || err.cause
    );
  }

  if (err?.stack) {
    console.error('Stack:', err.stack);
  }

  console.error('');
}

// Process one account attempt.
async function attemptAccount(account, tag) {
  const {
    user_id: userId,
    app_data: appData
  } = account;

  let stage = 'SDK initialization';

  try {
    const sdk = sdkFactory({
      apiKey: appData.api_key,
      apiSecret: appData.api_secret,
      bearerToken: appData.bearer_token
    });

    // 1. Fetch current profile.
    stage = 'Fetching Audius user profile';

    const profileResponse = await sdk.users.getUser({
      id: userId
    });

    const user = profileResponse?.data;

    if (!user) {
      log(
        `${tag} failed: Audius returned no user profile for user_id ${userId}`
      );

      return 'failed';
    }

    // 2. Determine missing profile fields.
    const missing = {
      bio: !hasBio(user),
      photo: !hasPhoto(user),
      cover: !hasCover(user)
    };

    const have = Object.keys(missing).filter(
      key => !missing[key]
    );

    const need = Object.keys(missing).filter(
      key => missing[key]
    );

    // 3. Skip completed profiles.
    if (need.length === 0) {
      log(`${tag} skipped (has bio + photo + cover)`);
      return 'skipped';
    }

    const metadata = {};

    // 4. Generate missing bio.
    if (missing.bio) {
      stage = 'Generating bio';
      metadata.bio = generateBio();
    }

    // 5. Upload missing profile photo.
    if (missing.photo) {
      stage = 'Downloading/uploading profile photo';
      metadata.profilePicture = await uploadPhoto(sdk);
    }

    // 6. Upload missing cover.
    if (missing.cover) {
      stage = 'Downloading/uploading cover photo';
      metadata.coverPhoto = await uploadCover(sdk);
    }

    // 7. Update profile.
    stage = 'Updating Audius user profile';

    await sdk.users.updateUser({
      id: userId,
      userId,
      metadata
    });

    log(
      `${tag} added ${need.join(' + ')}` +
      (have.length
        ? ` (already had ${have.join(' + ')})`
        : '')
    );

    return 'updated';

  } catch (err) {
    // Preserve original error information.
    if (err && typeof err === 'object') {
      err.profileStage = stage;
    }

    const reason = await describeError(err);

    logDetailedError(
      tag,
      stage,
      err,
      reason
    );

    throw err;
  }
}

// Process account with retries.
async function processAccount(account, label) {
  const {
    address,
    user_id: userId,
    app_data: appData
  } = account;

  const tag = `${label} ${address || '(no address)'}`;

  // Validate required data.
  if (
    !appData ||
    !appData.api_key ||
    !appData.api_secret ||
    !appData.bearer_token ||
    !userId
  ) {
    log(
      `${tag} skipped (missing API credentials or user_id)`
    );

    return 'nocreds';
  }

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt++
  ) {
    try {
      return await attemptAccount(account, tag);

    } catch (err) {
      const reason = await describeError(err);
      const retryable = isRetryableError(err);

      // Do not retry permanent HTTP errors.
      if (!retryable) {
        log(
          `${tag} failed (not retrying; permanent HTTP error): ${reason}`
        );

        return 'failed';
      }

      if (attempt >= MAX_RETRIES) {
        log(
          `${tag} failed after ${MAX_RETRIES} retries: ${reason}`
        );

        return 'failed';
      }

      const delay = RETRY_DELAYS_MS[attempt];

      log(
        `${tag} retry ${attempt + 1}/${MAX_RETRIES} in ${delay / 1000}s: ${reason}`
      );

      await sleep(delay);
    }
  }

  return 'failed';
}

// Main execution.
async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(
      `[!] db.txt not found at: ${DB_FILE}`
    );

    process.exit(1);
  }

  const dbText = fs.readFileSync(DB_FILE, 'utf8');

  const urlMatch = dbText.match(
    /SUPABASE_URL\s*=\s*["']([^"']+)["']/
  );

  const keyMatch = dbText.match(
    /SUPABASE_KEY\s*=\s*["']([^"']+)["']/
  );

  if (!urlMatch || !keyMatch) {
    console.error(
      '[!] Could not read SUPABASE_URL / SUPABASE_KEY from db.txt'
    );

    process.exit(1);
  }

  const supabase = createClient(
    urlMatch[1],
    keyMatch[1]
  );

  // Load accounts.
  const {
    data: accounts,
    error
  } = await supabase
    .from('audius')
    .select('address, user_id, app_data')
    .not('app_data', 'is', null);

  if (error) {
    console.error(
      '[!] Failed to load accounts:',
      error.message || error
    );

    process.exit(1);
  }

  if (!accounts || accounts.length === 0) {
    log('[!] No accounts found.');
    return;
  }

  log(`Checking ${accounts.length} accounts\n`);

  const counts = {
    updated: 0,
    skipped: 0,
    failed: 0,
    nocreds: 0
  };

  // Process accounts sequentially.
  for (let i = 0; i < accounts.length; i++) {
    const result = await processAccount(
      accounts[i],
      `[${i + 1}/${accounts.length}]`
    );

    counts[result] = (counts[result] || 0) + 1;
  }

  // Final summary.
  const parts = [
    `${counts.updated} updated`,
    `${counts.skipped} skipped`,
    counts.failed && `${counts.failed} failed`,
    counts.nocreds && `${counts.nocreds} missing credentials`
  ].filter(Boolean);

  log(`\nDone: ${parts.join(', ')}`);
}

main().catch(err => {
  console.error(
    '[!] Fatal error:',
    err?.message || err
  );

  if (err?.stack) {
    console.error(err.stack);
  }

  process.exit(1);
});
