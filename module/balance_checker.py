#!/usr/bin/env python3
"""
balance_checker.py - Checks AUDIO balances and history for accounts in the DB.
"""

import asyncio
import random
import re
from pathlib import Path

import httpx
from supabase import create_client

# File layout
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR   = SCRIPT_DIR.parent
DB_FILE    = ROOT_DIR / "db.txt"

MAX_CONCURRENCY = 10

# Fallback UAs
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
]


def load_supabase_creds() -> tuple[str, str]:
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    return m_url.group(1), m_key.group(1)


async def check_account(client: httpx.AsyncClient, sem: asyncio.Semaphore,
                        supabase, account: dict):
    async with sem:
        user_id = account["user_id"]
        api_key = account["api_key"]
        enc_dm  = account["encoded_dm"]
        enc_ds  = account["encoded_ds"]
        address = account["address"]
        old_balance = float(account.get("balance") or 0)

        headers = {
            "User-Agent": random.choice(USER_AGENTS),
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://audius.co/",
            "Encoded-Data-Message": enc_dm,
            "Encoded-Data-Signature": enc_ds,
            "Origin": "https://audius.co",
        }

        logs = []
        new_balance = old_balance
        balance_usd = 0.0
        wallet_found = False

        # --- API 1: Coins / Balance ---
        url_coins = (
            f"https://api.audius.co/v1/users/{user_id}/coins"
            f"?api_key={api_key}&app_name=audius-client"
        )
        try:
            resp = await client.get(url_coins, headers=headers, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data and isinstance(data, list):
                    inner_accounts = data[0].get("accounts", [])
                    if inner_accounts:
                        wallet_found = True
                        new_balance = float(inner_accounts[0].get("balance", 0))
                        balance_usd = float(inner_accounts[0].get("balance_usd", 0))
        except Exception:
            pass  # Ignore network errors

        # --- API 2: Balance History ---
        url_history = (
            f"https://api.audius.co/v1/users/{user_id}/balance/history"
            f"?granularity=daily&api_key={api_key}&app_name=audius-client"
        )
        try:
            resp = await client.get(url_history, headers=headers, timeout=15.0)
            if resp.status_code == 200:
                data = resp.json().get("data", [])
                if data:
                    logs.append(f"History: {len(data)} items")
        except Exception:
            pass

        # --- Decide what to log (still 1 line per account) ---
        if wallet_found:
            if new_balance != old_balance:
                logs.insert(0, f"Balance: {old_balance} -> {new_balance} (${balance_usd})")
            else:
                logs.insert(0, f"Wallet found: balance={new_balance} (${balance_usd})")

        # --- Update DB if balance changed ---
        if wallet_found and new_balance != old_balance:
            try:
                supabase.table("audius").update(
                    {"balance": new_balance}
                ).eq("address", address).execute()
            except Exception as e:
                logs.append(f"DB update failed: {e}")

        # --- Emit one line if anything noteworthy ---
        if logs:
            print(f"[{address}] " + " | ".join(logs))


async def run():
    url, key = load_supabase_creds()
    supabase = create_client(url, key)

    print("[*] Fetching eligible accounts from DB...")
    resp = (
        supabase.table("audius")
        .select("address, user_id, api_key, encoded_dm, encoded_ds, balance")
        .neq("user_id", "null")
        .neq("api_key", "null")
        .neq("encoded_dm", "null")
        .neq("encoded_ds", "null")
        .execute()
    )

    accounts = resp.data
    if not accounts:
        print("[!] No eligible accounts found.")
        return

    print(f"[*] Checking {len(accounts)} accounts with concurrency={MAX_CONCURRENCY}...")

    sem = asyncio.Semaphore(MAX_CONCURRENCY)

    async with httpx.AsyncClient() as client:
        tasks = [check_account(client, sem, supabase, acc) for acc in accounts]
        await asyncio.gather(*tasks)

    print("[*] Balance check complete.")