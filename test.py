#!/usr/bin/env python3
"""
seed_audius.py — load tempmail_accounts.json into public.audius
Uses the Supabase REST client (reads SUPABASE_URL / SUPABASE_KEY from db.txt).
Safe to re-run — existing addresses are skipped.
"""
import argparse
import json
import re
import sys
from pathlib import Path

from supabase import create_client

HERE = Path(__file__).resolve().parent
DB_FILE = HERE / "db.txt"


def load_supabase_creds() -> tuple[str, str]:
    if not DB_FILE.exists():
        sys.exit(f"❌ {DB_FILE} not found")
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    if not m_url or not m_key:
        sys.exit("❌ db.txt must contain SUPABASE_URL and SUPABASE_KEY")
    return m_url.group(1), m_key.group(1)


def load_accounts(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"❌ {path} not found")
    raw = json.loads(path.read_text())
    values = raw.values() if isinstance(raw, dict) else raw

    rows, seen = [], set()
    for a in values:
        addr = (a.get("address") or "").strip()
        pwd  = (a.get("password") or "").strip()
        reg  = (a.get("register") or "yes").strip()
        if not addr or not pwd or addr in seen:
            continue
        seen.add(addr)
        rows.append({"address": addr, "password": pwd, "register": reg})
    return rows


def chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=str(HERE / "tempmail_accounts.json"))
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()

    rows = load_accounts(Path(args.file))
    if not rows:
        sys.exit("❌ No valid accounts found")

    print(f"📦 Loaded {len(rows)} unique accounts from {args.file}")

    url, key = load_supabase_creds()
    print(f"🔌 Connecting to Supabase: {url}")
    supabase = create_client(url, key)

    inserted = 0
    for i, batch in enumerate(chunked(rows, args.batch), 1):
        # ignore_duplicates=True  →  ON CONFLICT (address) DO NOTHING
        resp = (
            supabase.table("audius")
            .upsert(batch, on_conflict="address", ignore_duplicates=True)
            .execute()
        )
        n = len(resp.data or [])
        inserted += n
        print(f"   batch {i}: sent {len(batch):>3} rows → {n} actually inserted")

    # Final count
    count = (
        supabase.table("audius")
        .select("address", count="exact")
        .limit(1)
        .execute()
        .count
    )
    print(f"✅ Done. Inserted {inserted} new rows.")
    print(f"📊 Table now contains {count} rows total.")


if __name__ == "__main__":
    main()