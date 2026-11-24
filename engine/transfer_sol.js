#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const {
  Keypair, Connection, PublicKey, SystemProgram,
  Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction,
} = require('@solana/web3.js');

const bs58Module = require('bs58');
const bs58 = bs58Module.default || bs58Module;

const AMOUNT_SOL = 0.0051;
const RPC_URL = 'https://api.mainnet-beta.solana.com';

// Reuse the private key that is already in create_userbank.js
function loadPrivateKey() {
  const file = path.join(__dirname, 'create_userbank.js');
  const src = fs.readFileSync(file, 'utf8');
  const m = src.match(/SOLANA_PRIVATE_KEY\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new Error(`Could not find SOLANA_PRIVATE_KEY in ${file}`);
  return m[1];
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}

async function main() {
  const keypair = Keypair.fromSecretKey(bs58.decode(loadPrivateKey()));
  const connection = new Connection(RPC_URL, 'confirmed');

  const balance = await connection.getBalance(keypair.publicKey);
  console.log(`[*] From:    ${keypair.publicKey.toBase58()}`);
  console.log(`[*] Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  console.log(`[*] Amount:  ${AMOUNT_SOL} SOL\n`);

  // Address can be given on the command line (works through wrappers like main.py):
  //   node transfer_sol.js <address>
  const argAddress = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (!argAddress && !process.stdin.isTTY) {
    console.error('[!] No interactive terminal (stdin) here, so I cannot prompt you.');
    console.error('    Pass the address as an argument instead:  transfer_sol.js <address>');
    process.exit(1);
  }
  const input = argAddress || await ask('Enter the address to send to: ');
  let to;
  try {
    to = new PublicKey(input);
  } catch {
    console.error('[!] That is not a valid Solana address.');
    process.exit(1);
  }

  const lamports = Math.round(AMOUNT_SOL * LAMPORTS_PER_SOL);
  const FEE_BUFFER = 5000; // base fee is 5000 lamports
  if (balance < lamports + FEE_BUFFER) {
    console.error('[!] Not enough balance to cover the amount plus the network fee.');
    process.exit(1);
  }

  console.log(`[*] To:      ${to.toBase58()}`);
  if (!argAddress) {
    // Interactive mode: confirm. Passing the address as an argument counts as your confirmation.
    const confirm = await ask(`Send ${AMOUNT_SOL} SOL to ${to.toBase58()}? (y/N): `);
    if (confirm.toLowerCase() !== 'y') {
      console.log('[*] Cancelled.');
      return;
    }
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: to, lamports })
  );
  const sig = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`\n SENT! https://solscan.io/tx/${sig}`);
}

main().catch(e => { console.error('[!] Failed:', e.message || e); process.exit(1); });
