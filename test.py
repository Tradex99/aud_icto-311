#!/usr/bin/env python3
"""Find the Audius user_id for a row in the `audius` table.

Audius has no email -> user_id lookup (emails are private). But each row
already has an API key, and GET /v1/developer_apps/{api_key} returns the
user_id of the account that owns that key.

Usage:
    python3 test.py                      # uses DEFAULT_EMAIL below
    python3 test.py someone@example.com  # look up a different email
    python3 test.py --save               # also write user_id back to the row
"""
import re
import sys
from pathlib import Path

import requests

DEFAULT_EMAIL = "obieze3905@gmail.com"
EMAIL_COLUMN = "address"  # column in the table that holds the email
TABLE = "audius"
AUDIUS_API = "https://api.audius.co/v1"
TIMEOUT = 20


def load_supabase_creds():
    here = Path(__file__).resolve().parent
    for folder in (here, here.parent):
        db_file = folder / "db.txt"
        if db_file.exists():
            text = db_file.read_text()
            url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
            key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
            if url and key:
                return url.group(1).rstrip("/"), key.group(1)
    sys.exit("[!] Could not find SUPABASE_URL / SUPABASE_KEY in db.txt")


def main():
    save = "--save" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    email = args[0] if args else DEFAULT_EMAIL

    supa_url, supa_key = load_supabase_creds()
    supa_headers = {"apikey": supa_key, "Authorization": f"Bearer {supa_key}"}

    # 1. Get the row (and its credentials) from the table
    r = requests.get(
        f"{supa_url}/rest/v1/{TABLE}",
        headers=supa_headers,
        params={EMAIL_COLUMN: f"eq.{email}", "select": f"{EMAIL_COLUMN},user_id,app_data"},
        timeout=TIMEOUT,
    )
    r.raise_for_status()
    rows = r.json()
    if not rows:
        sys.exit(f"[!] No row found where {EMAIL_COLUMN} = {email}")

    row = rows[0]
    app_data = row.get("app_data") or {}
    api_key = app_data.get("api_key")
    if not api_key:
        sys.exit("[!] Row has no app_data.api_key")

    print(f"[*] Row found: {row[EMAIL_COLUMN]}")
    print(f"[*] user_id currently in table: {row.get('user_id')}")

    # 2. Ask Audius which account owns this API key
    bearer = app_data.get("bearer_token")
    r = requests.get(
        f"{AUDIUS_API}/developer_apps/{api_key}",
        headers={"Authorization": f"Bearer {bearer}"} if bearer else {},
        timeout=TIMEOUT,
    )
    if r.status_code in (401, 403) and bearer:  # bad/expired token: retry anonymously
        r = requests.get(f"{AUDIUS_API}/developer_apps/{api_key}", timeout=TIMEOUT)
    if r.status_code == 404:
        sys.exit("[!] Audius has no developer app registered for this API key")
    r.raise_for_status()

    app = r.json()["data"]
    user_id = app["user_id"]
    print(f"[+] Developer app: {app.get('name')}")
    print(f"[+] Owner user_id: {user_id}")

    # 3. Sanity check: show who that user is
    r = requests.get(f"{AUDIUS_API}/users/{user_id}", timeout=TIMEOUT)
    if r.ok:
        user = r.json().get("data") or {}
        print(f"[+] Profile: @{user.get('handle')} ({user.get('name')})")

    # 4. Optionally save it
    if save:
        r = requests.patch(
            f"{supa_url}/rest/v1/{TABLE}",
            headers={**supa_headers, "Content-Type": "application/json", "Prefer": "return=minimal"},
            params={EMAIL_COLUMN: f"eq.{email}"},
            json={"user_id": user_id},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
        print("[+] Saved user_id to the table")


if __name__ == "__main__":
    main()
