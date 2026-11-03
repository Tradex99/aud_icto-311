#!/usr/bin/env python3
"""
login.py — DB-backed Audius login + wallet-API credential capture (Chromium).

Behaviour:
  * Up to 10 sequential, fully independent runs per invocation.
  * Each run:
      - starts a fresh async_playwright() server + fresh Chromium
      - picks a random UA from user_agents.txt
      - claims an account whose api_key / encoded_dm / encoded_ds are NULL
        (and that hasn't been tried in this session yet)
      - logs in, opens /wallet, captures the 3 values, saves them
      - closes the browser
  * On failure, the account is released (active=FALSE) but remembered in a
    local `tried` set so this session won't re-pick it.
  * Stops early when no fresh eligible account remains.

File layout assumed:
    botnet/audius/                 <-- ROOT (db.txt, user_agents.txt live here)
    botnet/audius/src/login.py     <-- this file
    botnet/audius/src/tempmail.py
"""

import asyncio
import random
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.async_api import async_playwright
from supabase import create_client


SCRIPT_DIR = Path(__file__).resolve().parent      # .../src
ROOT_DIR   = SCRIPT_DIR.parent                    # .../audius

DB_FILE         = ROOT_DIR / "db.txt"
UA_FILE         = ROOT_DIR / "user_agents.txt"
TEMPMAIL_SCRIPT = SCRIPT_DIR / "tempmail.py"

MAX_RUNS = 10
CLAIM_MAX_ATTEMPTS = 10   # how many times we re-roll if the RPC returns an already-tried address

API_PATTERN = re.compile(
    r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)"
)

LOGIN_BUTTON_SELECTORS = [
    'button[type="submit"].harmony-1e68p2w',
    'button[type="submit"]:has-text("Log In")',
    'button:has-text("Log In")',
    'button.harmony-1e68p2w',
    '/html/body/div[1]/div[1]/div[4]/div/form/div[3]/button',
]

OTP_BUTTON_SELECTORS = [
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
]


# --------------------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------------------
def load_supabase_creds() -> tuple[str, str]:
    if not DB_FILE.exists():
        raise FileNotFoundError(f"db.txt not found at {DB_FILE}")
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    if not m_url or not m_key:
        raise RuntimeError("db.txt must contain SUPABASE_URL and SUPABASE_KEY")
    return m_url.group(1), m_key.group(1)


# --------------------------------------------------------------------------
# User agent
# --------------------------------------------------------------------------
def read_user_agent() -> str:
    if not UA_FILE.exists():
        raise FileNotFoundError(f"user_agents.txt not found at {UA_FILE}")
    uas = [u.strip() for u in UA_FILE.read_text().splitlines() if u.strip()]
    if not uas:
        raise RuntimeError(f"No user agents found in {UA_FILE}")
    return random.choice(uas)


# --------------------------------------------------------------------------
# tempmail.py bridge
# --------------------------------------------------------------------------
async def run_tempmail_inbox(address: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "python3", str(TEMPMAIL_SCRIPT), "inbox", address,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    return stdout.decode()


# --------------------------------------------------------------------------
# Robust click helper
# --------------------------------------------------------------------------
async def click_first_match(page, selectors: list[str],
                            per_selector_timeout: int = 10_000) -> str:
    last_err = None
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.click()
            print(f"   → clicked via: {sel}")
            return sel
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(
        f"None of the selectors matched a visible element: {selectors} "
        f"(last error: {last_err})"
    )


# --------------------------------------------------------------------------
# Request capture handler
# --------------------------------------------------------------------------
def build_request_handler(captured: dict):
    def handler(request):
        if captured:
            return
        url = request.url
        if not API_PATTERN.search(url):
            return

        qs      = parse_qs(urlparse(url).query)
        api_key = qs.get("api_key", [None])[0]
        hdrs    = {k.lower(): v for k, v in request.headers.items()}
        enc_dm  = hdrs.get("encoded-data-message")
        enc_ds  = hdrs.get("encoded-data-signature")

        if api_key and enc_dm and enc_ds:
            captured["api_key"]    = api_key
            captured["encoded_dm"] = enc_dm
            captured["encoded_ds"] = enc_ds
            print(f"📡 Captured from: {url[:110]}")
            print(f"   api_key         : {api_key}")
            print(f"   Encoded-Data-Msg: {enc_dm}")
            print(f"   Encoded-Data-Sig: {enc_ds[:40]}…")
    return handler


# --------------------------------------------------------------------------
# Claim an account that has NOT been tried in this session
# --------------------------------------------------------------------------
def claim_fresh_account(supabase, tried: set[str]) -> dict | None:
    """
    Call the RPC repeatedly, releasing any address already in `tried`,
    until we get a fresh one. Returns the row dict or None if the pool
    is exhausted (or every remaining candidate has already been tried).
    """
    for _ in range(CLAIM_MAX_ATTEMPTS):
        resp = supabase.rpc("claim_audius_account").execute()
        if not resp.data:
            return None                       # RPC says: no eligible account at all
        cand = resp.data[0]
        if cand["address"] not in tried:
            return cand
        # This one was already attempted in this run → put it back and re-roll
        supabase.table("audius").update({"active": False}) \
            .eq("address", cand["address"]).execute()
    return None                               # every claim collided with `tried`


# --------------------------------------------------------------------------
# One full attempt (fresh browser, one account)
# --------------------------------------------------------------------------
async def run_one(pw, supabase, tried: set[str]) -> tuple[bool, str | None]:
    """
    Returns (success, address).
    address is None  →  no fresh account left (pool exhausted for this session).
    """
    # --- Claim ----------------------------------------------------------
    account = claim_fresh_account(supabase, tried)
    if account is None:
        return False, None

    address  = account["address"]
    password = account["password"]
    print(f"🎯 Claimed account: {address}")

    # --- Fresh random UA every run -------------------------------------
    user_agent = read_user_agent()
    print(f"🖥  User agent: {user_agent}")

    captured: dict = {}

    # --- Fresh browser --------------------------------------------------
    browser = await pw.chromium.launch(
        headless=False,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    )
    success = False
    try:
        context = await browser.new_context(
            user_agent=user_agent,
            viewport={"width": 1280, "height": 720},
            java_script_enabled=True,
            bypass_csp=True,
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": ("text/html,application/xhtml+xml,application/xml;"
                           "q=0.9,image/webp,*/*;q=0.8"),
            },
        )
        await context.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)

        page = await context.new_page()

        async def handle_route(route):
            await asyncio.sleep(random.random() * 0.1)
            await route.continue_()
        await page.route("**/*", handle_route)

        page.on("request", build_request_handler(captured))

        # --- Sign in ----------------------------------------------------
        await page.goto("https://audius.co/signin",
                        wait_until="load", timeout=60_000)
        await page.fill('input[aria-label="Email"]',    address)
        await page.fill('input[aria-label="Password"]', password)

        print("Waiting 1s before clicking Sign In…")
        await page.wait_for_timeout(1000)

        try:
            await click_first_match(page, LOGIN_BUTTON_SELECTORS)
        except RuntimeError as e:
            print("❌ Could not click Log In:", e)
            return False, address

        try:
            await page.wait_for_url(
                "https://audius.co/signin/confirm-email",
                wait_until="load", timeout=60_000,
            )
            await page.wait_for_timeout(2000)
        except Exception:
            pass

        # --- OTP --------------------------------------------------------
        try:
            stdout = await run_tempmail_inbox(address)
            m = re.search(r"\d{3}\s\d{3}", stdout)
            if not m:
                raise RuntimeError(f"OTP not found (stdout={stdout!r})")
            otp = m.group(0)
            print("🔑 OTP:", otp)
        except Exception as e:
            print("❌ tempmail inbox failed:", e)
            return False, address

        await page.fill('input[aria-label="Code"]', otp)
        await page.wait_for_timeout(1000)

        try:
            await click_first_match(page, OTP_BUTTON_SELECTORS)
        except RuntimeError as e:
            print("❌ Could not click OTP submit:", e)
            return False, address

        try:
            await page.wait_for_url("https://audius.co/feed",
                                    wait_until="load", timeout=60_000)
            print("✅ Login success — feed loaded")
        except Exception:
            if "https://audius.co/feed" not in page.url:
                print("❌ Failed to reach feed. URL:", page.url)
                return False, address

        # --- Wallet + capture -------------------------------------------
        print("🌐 Opening https://audius.co/wallet …")
        await page.goto("https://audius.co/wallet",
                        wait_until="domcontentloaded", timeout=60_000)

        for _ in range(60):
            if captured:
                break
            await page.wait_for_timeout(500)

        if captured:
            supabase.table("audius").update({
                "api_key":    captured["api_key"],
                "encoded_dm": captured["encoded_dm"],
                "encoded_ds": captured["encoded_ds"],
            }).eq("address", address).execute()
            print("💾 Saved api_key / Encoded-Data-Message / Encoded-Data-Signature")
            success = True
        else:
            print("⚠️  No target API captured within 30 s")

    except Exception as e:
        print("❌ Fatal:", e)
    finally:
        try:
            await browser.close()
        except Exception:
            pass

    # --- Release on failure --------------------------------------------
    if not success:
        supabase.table("audius").update({"active": False}).eq("address", address).execute()
        print(f"♻️  Released {address} back to the pool")

    return success, address


# --------------------------------------------------------------------------
# Driver: N sequential, fully independent runs
# --------------------------------------------------------------------------
async def main() -> None:
    url, key = load_supabase_creds()
    supabase = create_client(url, key)

    tried: set[str] = set()
    ok = 0
    failed = 0
    exhausted = False

    for i in range(1, MAX_RUNS + 1):
        print(f"\n{'=' * 60}")
        print(f"🔁 Run {i}/{MAX_RUNS}  —  launching fresh Playwright + Chromium")
        print('=' * 60)

        # Fresh Playwright server + browser per iteration
        async with async_playwright() as pw:
            success, address = await run_one(pw, supabase, tried)

        if address is None:
            print("🛑 No fresh eligible account left — pool exhausted for this session.")
            exhausted = True
            break

        tried.add(address)
        if success:
            ok += 1
        else:
            failed += 1
        print(f"🏁 Run {i} finished — browser closed")

    # --- Summary --------------------------------------------------------
    print(f"\n{'=' * 60}")
    print("📊 Session summary")
    print('=' * 60)
    print(f"  runs completed : {ok + failed}")
    print(f"  succeeded      : {ok}")
    print(f"  failed         : {failed}")
    print(f"  distinct tried : {len(tried)}")

    if exhausted:
        print("🛑 Stopped early — no fresh account left.")
    elif ok + failed >= MAX_RUNS:
        print(f"✅ Reached the {MAX_RUNS}-run cap.")
    else:
        print("ℹ️  Loop ended without hitting either cap (unexpected).")


if __name__ == "__main__":
    asyncio.run(main())