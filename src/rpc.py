#!/usr/bin/env python3
"""
rpc.py - Central account broker.

Only two jobs:
  claim(job_type)   -> assigns a free account to the caller
  release(address)  -> puts the account back into the pool
"""

import re
from pathlib import Path
from supabase import create_client

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR   = SCRIPT_DIR.parent
DB_FILE    = ROOT_DIR / "db.txt"

_client = None

def _get_client():
    global _client
    if _client is None:
        if not DB_FILE.exists():
            raise FileNotFoundError(f"db.txt not found at {DB_FILE}")
        text = DB_FILE.read_text()
        m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
        m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
        if not m_url or not m_key:
            raise RuntimeError("db.txt must contain SUPABASE_URL and SUPABASE_KEY")
        _client = create_client(m_url.group(1), m_key.group(1))
    return _client


def claim(job_type: str) -> dict | None:
    """
    Ask the database to assign a free account for this job type.
    Automatically releases crashed accounts (no heartbeat > 3 mins).
    
    Returns {"address": "...", "password": "..."} or None if the pool is empty.
    """
    resp = _get_client().rpc("claim_audius_account", {"p_job_type": job_type}).execute()
    if not resp.data:
        return None
    return resp.data[0]


def release(address: str) -> None:
    """Release the account back into the pool (sets active=FALSE)."""
    try:
        _get_client().table("audius").update({"active": False}).eq("address", address).execute()
    except Exception as e:
        print(f"[!] rpc.release failed for {address}: {e}")
