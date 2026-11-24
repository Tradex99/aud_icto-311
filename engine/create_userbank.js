#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const audiusPkg = require('@audius/sdk');
const { sdk, createSdkWithServices } = audiusPkg;
const { Keypair, Connection, LAMPORTS_PER_SOL } = require('@solana/web3.js');

const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const SOLANA_PRIVATE_KEY = '5biTD34jiKfuRCAha2zQf3bvC5CajnpEnNKquoVTRfRTgENqZKAQqFntc9XkH2zH2ZgHC3v73eC7TQqC5YLsftLL';
const CRED_ADDRESS = 'qringgreen@gmail.com';
const TARGET_ADDRESS = process.argv.slice(2).find(a => !a.startsWith('--')) || CRED_ADDRESS; 
const MAX_ACCOUNTS_TO_PROCESS = 25; 

const ROOT_DIR = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT_DIR, 'db.txt');

// SDK v17 doesn't expose `.services` on the object, so look in the places it could live.
function findClaimableTokensClient(s) {
  const candidates = [
    s?.services?.claimableTokensClient,
    s?.claimableTokensClient,
    s?.claimableTokens,
    s?.solana?.claimableTokens,
    s?._services?.claimableTokensClient,
    s?.sdk?.services?.claimableTokensClient,
    s?.config?.services?.claimableTokensClient,
  ];
  return candidates.find(c => c && typeof c.getOrCreateUserBank === 'function');
}

const { Transaction } = require('@solana/web3.js');

function loadSpl() {
  try { return require('@audius/spl'); } catch (_) {}
  const p = require.resolve('@audius/spl', { paths: [require.resolve('@audius/sdk')] });
  return require(p);
}
const { ClaimableTokensProgram } = loadSpl();

// Fallback: build + sign the create-user-bank tx ourselves, paid by our own wallet,
// and send it straight to the Solana RPC (no Audius relay involved).
async function createUserBankWithOwnPayer(client, ethWallet, keypair, connection) {
  const userBank = await client.deriveUserBank({ ethWallet, mint: 'wAUDIO' });
  const existing = await connection.getAccountInfo(userBank);
  if (existing) return { userBank, didExist: true };

  const mint = client.preconfiguredMints.wAUDIO; // must be a PublicKey, not the string 'wAUDIO'
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');

  // createUserBankInstructions also adds a "set close authority" step that the SDK refuses
  // unless the SDK's own wallet equals ethWallet. We only need the create-account instruction.
  const ix = ClaimableTokensProgram.createAccountInstruction({
    ethAddress: ethWallet,
    payer: keypair.publicKey,
    mint,
    authority: client.deriveAuthority(mint),
    userBank,
    programId: client.programId,
  });
  const ixs = [ix];

  const tx = new Transaction().add(...ixs);
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(keypair);

  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  console.log(`[*] Tx: https://solscan.io/tx/${sig}`);
  return { userBank, didExist: false };
}

async function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`[!] DB file not found at ${DB_FILE}`);
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

  console.log(`[*] Fetching API credentials from ${CRED_ADDRESS}...`);
  const { data: coordData, error: coordErr } = await supabase
    .from('audius')
    .select('app_data')
    .eq('address', CRED_ADDRESS)
    .limit(1);

  if (coordErr || !coordData || !coordData[0] || !coordData[0].app_data) {
    console.error(`[!] Could not fetch app_data from ${CRED_ADDRESS}`);
    process.exit(1);
  }
  
  const appData = coordData[0].app_data;
  const sdkConfig = { apiKey: appData.api_key, apiSecret: appData.api_secret };
  const audiusSdk = sdk(sdkConfig);

  // v17 hides services on sdk(); createSdkWithServices exposes them.
  let withServices = null;
  if (typeof createSdkWithServices === 'function') {
    try {
      withServices = createSdkWithServices(sdkConfig);
    } catch (e) {
      console.error('[!] createSdkWithServices failed:', e.message);
    }
  }

  let targets = [];
  if (process.argv.includes('--all')) {
    console.log(`[*] Fetching up to ${MAX_ACCOUNTS_TO_PROCESS} accounts from DB...`);
    const { data: accounts, error: accErr } = await supabase
      .from('audius')
      .select('address, user_id')
      .not('user_id', 'is', null)
      .limit(MAX_ACCOUNTS_TO_PROCESS);
      
    if (accErr) {
      console.error('[!] Failed to fetch accounts:', accErr);
      process.exit(1);
    }
    targets = accounts;
  } else {
    const { data: account, error: accErr } = await supabase
      .from('audius')
      .select('address, user_id')
      .eq('address', TARGET_ADDRESS)
      .limit(1);
      
    if (accErr || !account || !account[0]) {
      console.error(`[!] Target account ${TARGET_ADDRESS} not found in DB.`);
      process.exit(1);
    }
    targets = [account[0]];
  }

  console.log('[*] Initializing Solana connection...');
  const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

  let keypair;
  try {
    const secretKey = bs58.decode(SOLANA_PRIVATE_KEY);
    keypair = Keypair.fromSecretKey(secretKey);
  } catch (e) {
    console.error('[!] Invalid Solana private key format. Error:', e.message);
    process.exit(1);
  }

  console.log(`[*] Fee payer wallet: ${keypair.publicKey.toBase58()}`);
  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`[*] Fee payer balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  
  if (balance < 0.005 * LAMPORTS_PER_SOL) {
    console.error('[!] Balance too low to create an account. Need at least 0.005 SOL.');
    process.exit(1);
  }

  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;

  for (const target of targets) {
    console.log(`\n----------------------------------------`);
    console.log(`[*] Processing target: ${target.address} (User ID: ${target.user_id})`);

    try {
      const userRes = await audiusSdk.users.getUser({ id: target.user_id });
      const ethWallet = userRes?.data?.wallet || userRes?.data?.erc_wallet;
      
      if (!ethWallet) {
        console.error(`[!] Could not find ETH wallet for ${target.address}. Skipping.`);
        failCount++;
        continue;
      }

      console.log(`[*] Deriving User Bank for ETH wallet: ${ethWallet}`);

      const client = findClaimableTokensClient(withServices) || findClaimableTokensClient(audiusSdk);
      if (!client) {
        throw new Error('No ClaimableTokens client found on this SDK build. Run probe_sdk2.js and send me its output.');
      }

      // The SDK's relay has no base URL configured here ("Failed to parse URL from /v1/feePayer"),
      // so pay with our own wallet and send straight to Solana RPC.
      const { userBank, didExist } = await createUserBankWithOwnPayer(client, ethWallet, keypair, connection);

      if (didExist) {
        console.log(`[*] User Bank already exists for ${target.address}: ${userBank.toBase58()}`);
        skipCount++;
        continue;
      }

      console.log(` SUCCESS! User Bank: ${userBank.toBase58()}`);
      console.log(`https://solscan.io/account/${userBank.toBase58()}`);
      successCount++;

    } catch (error) {
      const msg = String(error.message || error);
      if (msg.includes('already in use') || msg.includes('already exists')) {
        console.log(`[*] User Bank already exists for ${target.address}. No SOL spent.`);
        skipCount++;
      } else {
        console.error(` FAILED for ${target.address}:`, msg);
        failCount++;
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`[*] Batch Complete:`);
  console.log(`    - Created: ${successCount}`);
  console.log(`    - Already Existed (Skipped): ${skipCount}`);
  console.log(`    - Failed: ${failCount}`);
  console.log(`========================================\n`);
}

main().catch(console.error);