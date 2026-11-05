#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

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

// --- Guard against SDK background tasks (e.g. storage-node health checks)
// crashing the whole process. These run outside our own await chains, so
// per-account try/catch can't catch them; without this, a single flaky
// network timeout inside the SDK kills an otherwise-healthy 300+ account run.
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.message ? reason.message : String(reason);
  log(`[!] Unhandled rejection (likely SDK background task): ${msg}`);
});
process.on('uncaughtException', (err) => {
  log(`[!] Uncaught exception (likely SDK background task): ${err.message || err}`);
});

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');
const MAX_CONCURRENCY = 10;

// --- Concurrency Limiter ---
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

// --- Check Single Account ---
async function checkAccount(supabase, account) {
  const address = account.address;
  const userId = account.user_id;
  const oldBalance = parseFloat(account.balance || 0);
  const appData = account.app_data;

  if (!userId || !appData || !appData.api_key) {
    return; // Skip accounts without credentials
  }

  try {
    const sdk = sdkFactory({
      apiKey: appData.api_key,
      apiSecret: appData.api_secret,
      bearerToken: appData.bearer_token,
    });

    // Profile balance fields (REST: total_audio_balance, balance,
    // total_balance, waudio_balance -> SDK camelCase equivalents)
    let totalAudioBalance = null; // total_audio_balance (integer, whole AUDIO)
    let ethBalance = null;        // balance (string, wei-ish units)
    let totalBalance = null;      // total_balance (string)
    let waudioBalance = null;     // waudio_balance (string)

    let coinBalance = 0.0;
    let coinBalanceUsd = 0.0;
    let historyCount = 0;
    let historyFailed = false;

    // 1. Fetch Profile
    try {
      const userRes = await sdk.users.getUser({ id: userId });
      const user = userRes?.data;
      if (user) {
        totalAudioBalance = user.totalAudioBalance ?? null;
        ethBalance = user.balance ?? null;
        totalBalance = user.totalBalance ?? null;
        waudioBalance = user.waudioBalance ?? null;
      }
    } catch (e) {
      log(`[${address}] Profile fetch failed: ${e.message || e}`);
    }

    // 2. Fetch Coins (filter strictly for $AUDIO, sum across all accounts)
    try {
      const coinsRes = await sdk.users.getUserCoins({ id: userId });
      const coins = coinsRes?.data;
      if (Array.isArray(coins)) {
        const audioCoin = coins.find(c => c.ticker === '$AUDIO');
        if (audioCoin) {
          const decimals = audioCoin.decimals ?? 8;
          const accountsArr = Array.isArray(audioCoin.accounts) && audioCoin.accounts.length > 0
            ? audioCoin.accounts
            : [audioCoin]; // fall back to top-level balance if no accounts[]

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
      log(`[${address}] Coin fetch failed: ${e.message || e}`);
    }

    // 3. Fetch Balance History
    try {
      const historyRes = await sdk.users.getUserBalanceHistory({ id: userId, granularity: 'daily' });
      const data = historyRes?.data;
      if (Array.isArray(data)) {
        historyCount = data.length;
      }
    } catch (e) {
      // The SDK's generic error message hides the real HTTP status, so pull
      // it out of whatever shape the error actually has.
      const status = e?.status ?? e?.response?.status ?? e?.cause?.status ?? null;

      if (status === 404) {
        // No history exists for this user (common for empty/never-funded
        // accounts) — this is a legitimate zero, not a failure.
        historyCount = 0;
      } else {
        historyFailed = true;
        log(`[${address}] History fetch failed (status=${status ?? 'unknown'}): ${e.message || e}`);
      }
    }

    // 4. Decide what to log
    const logs = [];
    if (totalAudioBalance !== null) logs.push(`Total Audio: ${totalAudioBalance}`);
    if (ethBalance !== null) logs.push(`Balance: ${ethBalance}`);
    if (totalBalance !== null) logs.push(`Total Balance: ${totalBalance}`);
    if (waudioBalance !== null) logs.push(`WAudio: ${waudioBalance}`);
    if (coinBalance > 0) logs.push(`$AUDIO Coin: ${coinBalance} ($${coinBalanceUsd})`);
    if (historyCount > 0) logs.push(`History: ${historyCount} items`);
    else if (historyFailed) logs.push(`History: fetch failed (not confirmed empty)`);

    // 5. Update DB if balance changed — table only has a single 'balance'
    // column, so pick the best available source and write only that.
    // Preference: total_audio_balance (profile) -> $AUDIO coin balance
    // (fallback, e.g. if the profile call failed or the field was null).
    const updates = {};
    const resolvedBalance = totalAudioBalance !== null ? totalAudioBalance : (coinBalance > 0 ? coinBalance : null);

    if (resolvedBalance !== null && resolvedBalance !== oldBalance) {
      updates.balance = resolvedBalance;
    }

    if (Object.keys(updates).length > 0) {
      try {
        const { error } = await supabase
          .from('audius')
          .update(updates)
          .eq('address', address);

        if (error) {
          logs.push(`DB update failed: ${error.message}`);
        }
      } catch (e) {
        logs.push(`DB update failed: ${e.message}`);
      }
    }

    // 6. Output exactly 1 line if anything noteworthy happened
    if (logs.length > 0) {
      log(`[${address}] ${logs.join(' | ')}`);
    }

  } catch (err) {
    log(`[${address}] Error: ${err.message || err}`);
  }
}

// --- Main ---
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

  log(`[*] Fetching eligible accounts from DB...`);
  const { data: accounts, error } = await supabase
    .from('audius')
    .select('address, user_id, balance, app_data')
    .not('app_data', 'is', null)
    .not('user_id', 'is', null);

  if (error) {
    console.error(`[!] Failed to fetch accounts:`, error);
    process.exit(1);
  }

  if (!accounts || accounts.length === 0) {
    log(`[!] No eligible accounts found.`);
    return;
  }

  log(`[*] Checking ${accounts.length} accounts with concurrency=${MAX_CONCURRENCY}...`);

  await asyncPool(MAX_CONCURRENCY, accounts, (acc) => checkAccount(supabase, acc));

  log(`[*] Balance check complete.`);
}

main().catch(err => {
  console.error(`[!] Fatal:`, err);
  process.exit(1);
});
