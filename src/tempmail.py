#!/usr/bin/env python3
"""
tempmail.py — Minimal Mail.tm client backed by the Supabase `audius` table.

File layout assumed:
    botnet/audius/db.txt               <-- ROOT
    botnet/audius/src/tempmail.py      <-- this file

Commands:
  python3 tempmail.py new
  python3 tempmail.py list
  python3 tempmail.py inbox <email>
"""
import json
import re
import sys
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path

from supabase import create_client

BASE = "https://api.mail.tm"

SCRIPT_DIR = Path(__file__).resolve().parent      # .../src
ROOT_DIR   = SCRIPT_DIR.parent                    # .../audius
DB_FILE    = ROOT_DIR / "db.txt"


def load_supabase():
    if not DB_FILE.exists():
        sys.exit(f"❌ db.txt not found at {DB_FILE}")
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    if not m_url or not m_key:
        sys.exit("❌ db.txt must contain SUPABASE_URL and SUPABASE_KEY")
    return create_client(m_url.group(1), m_key.group(1))


def db_get_password(supabase, address: str) -> str | None:
    resp = (
        supabase.table("audius")
        .select("password")
        .eq("address", address)
        .limit(1)
        .execute()
    )
    if not resp.data:
        return None
    return resp.data[0]["password"]


def req(url, data=None, headers=None):
    if headers is None:
        headers = {"Content-Type": "application/json"}
    r = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read().decode())


def new_email(supabase) -> None:
    domains = req(f"{BASE}/domains")
    domain = domains["hydra:member"][0]["domain"]
    local = str(uuid.uuid4())[:8]
    address = f"{local}@{domain}"
    password = str(uuid.uuid4())

    payload = json.dumps({"address": address, "password": password}).encode()
    try:
        req(f"{BASE}/accounts", payload)
    except urllib.error.HTTPError as e:
        print("❌ Failed to create account:", e)
        return

    supabase.table("audius").upsert(
        {
            "address":  address,
            "password": password,
            "register": "no",
            "active":   False,
        },
        on_conflict="address",
    ).execute()

    print(address)
    print(password)


def list_emails(supabase) -> None:
    resp = (
        supabase.table("audius")
        .select("address,password,register,active")
        .order("address")
        .execute()
    )
    if not resp.data:
        print("⚠️ No accounts in DB.")
        return
    for row in resp.data:
        print(f"{row['address']}\n{row['password']}")
        print(f"register={row.get('register')} active={row.get('active')}\n")


def _extract_code_from_text(text: str) -> str | None:
    if not text:
        return None
    m = re.search(r"\b(\d{3}\s?\d{3})\b", text)
    if m:
        digits = re.sub(r"\D", "", m.group(1))
        if len(digits) == 6:
            return f"{digits[:3]} {digits[3:]}"
    return None


def _parse_created_at(ts: str):
    if not ts:
        return None
    try:
        if ts.endswith("Z"):
            ts = ts[:-1] + "+00:00"
        return datetime.fromisoformat(ts)
    except Exception:
        try:
            return datetime.strptime(ts, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        except Exception:
            return None


def inbox(supabase, address: str, max_age_seconds: int = 180) -> None:
    password = db_get_password(supabase, address)
    if not password:
        print("❌ Email not found in DB.")
        return

    login_payload = json.dumps({"address": address, "password": password}).encode()
    auth = req(f"{BASE}/token", login_payload)
    headers = {"Authorization": f"Bearer {auth['token']}"}

    messages = req(f"{BASE}/messages?page=1", headers=headers)
    mails = messages.get("hydra:member", [])
    if not mails:
        print("")
        return

    now = datetime.now(timezone.utc)
    recent = []
    for m in mails:
        created = _parse_created_at(m.get("createdAt") or m.get("created_at") or "")
        if created is None:
            continue
        if created.tzinfo is None:
            created = created.replace(tzinfo=timezone.utc)
        age = (now - created).total_seconds()
        if 0 <= age <= max_age_seconds:
            recent.append((age, m))

    if not recent:
        print("")
        return

    recent.sort(key=lambda x: x[0])
    latest = recent[0][1]
    content = req(f"{BASE}/messages/{latest['id']}", headers=headers)
    body = content.get("text") or content.get("html") or ""

    code = _extract_code_from_text(body)
    print(code if code else body.strip()[:500])


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return

    supabase = load_supabase()
    cmd = sys.argv[1].lower()

    if cmd == "new":
        new_email(supabase)
    elif cmd == "list":
        list_emails(supabase)
    elif cmd == "inbox" and len(sys.argv) == 3:
        inbox(supabase, sys.argv[2])
    else:
        print("❌ Invalid command. Use: new | list | inbox <email>")


if __name__ == "__main__":
    main()