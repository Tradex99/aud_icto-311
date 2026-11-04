#!/usr/bin/env python3
"""
login.py - Audius login + wallet-API credential capture.
"""

import asyncio
import random
import re
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from playwright.async_api import async_playwright
from supabase import create_client

import rpc


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR   = SCRIPT_DIR.parent
DB_FILE         = ROOT_DIR / "db.txt"
UA_FILE         = ROOT_DIR / "user_agents.txt"
TEMPMAIL_SCRIPT = SCRIPT_DIR / "tempmail.py"

MAX_RUNS = 10
API_PATTERN = re.compile(
    r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)"
)

LOGIN_BUTTON_SELECTORS = [
    'button[type="submit"].harmony-1e68p2w',
    'button[type="submit"]:has-text("Log In")',
    'button:has-text("Log In")',
    'button.harmony-1e68p2w',
    'xpath=/html/body/div[1]/div[1]/div[4]/div/form/div[3]/button',
]

OTP_BUTTON_SELECTORS = [
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
]


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def load_supabase_creds() -> tuple[str, str]:
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    return m_url.group(1), m_key.group(1)

def read_user_agent() -> str:
    uas = [u.strip() for u in UA_FILE.read_text().splitlines() if u.strip()]
    return random.choice(uas)

async def run_tempmail_inbox(address: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "python3", str(TEMPMAIL_SCRIPT), "inbox", address,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    return stdout.decode()

async def click_first_match(page, selectors: list[str], per_selector_timeout: int = 10_000) -> str:
    last_err = None
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.click()
            print(f"   -> clicked via: {sel}")
            return sel
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"None matched: {selectors} (err: {last_err})")

def _shorten(value: str, head: int = 20, tail: int = 6) -> str:
    return f"{value[:head]}...{value[-tail:]}" if len(value) > head+tail+3 else value

def build_request_handler(captured: dict):
    def handler(request):
        if captured or not API_PATTERN.search(request.url):
            return
        qs = parse_qs(urlparse(request.url).query)
        api_key = qs.get("api_key", [None])[0]
        hdrs = {k.lower(): v for k, v in request.headers.items()}
        enc_dm = hdrs.get("encoded-data-message")
        enc_ds = hdrs.get("encoded-data-signature")
        if not (api_key and enc_dm and enc_ds):
            return
        captured.update({"api_key": api_key, "encoded_dm": enc_dm, "encoded_ds": enc_ds})
        print("[*] Wallet API credentials captured")
        print(f"    api_key          : {api_key}")
        print(f"    Encoded-Data-Msg : {enc_dm}")
        print(f"    Encoded-Data-Sig : {_shorten(enc_ds)}")
    return handler

async def heartbeat_loop(supabase, address: str):
    """Silently pings the DB every 30s to keep the lease alive."""
    while True:
        await asyncio.sleep(30)
        try:
            await asyncio.to_thread(
                supabase.rpc("ping_audius_account", {"p_address": address}).execute
            )
        except Exception:
            pass


# --------------------------------------------------------------------------
# Main worker
# --------------------------------------------------------------------------
async def run_one(pw, supabase, tried: set[str]) -> tuple[bool, str | None]:
    # 1. Ask rpc.py for an account
    account = rpc.claim("login")
    while account and account["address"] in tried:
        # Already tried this session, put it back and grab another
        rpc.release(account["address"])
        account = rpc.claim("login")
        
    if account is None:
        return False, None

    address, password = account["address"], account["password"]
    print(f"[*] Claimed account: {address}")

    user_agent = read_user_agent()
    print(f"[*] User agent: {user_agent}")

    captured = {}
    browser = await pw.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled",
              "--disable-features=IsolateOrigins,site-per-process",
              "--no-sandbox", "--disable-dev-shm-usage"],
    )
    success = False
    ping_task = None

    try:
        context = await browser.new_context(
            user_agent=user_agent, viewport={"width": 1280, "height": 720},
            java_script_enabled=True, bypass_csp=True,
            extra_http_headers={
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            },
        )
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });")
        page = await context.new_page()

        async def handle_route(route):
            try:
                await asyncio.sleep(random.random() * 0.1)
                await route.continue_()
            except Exception:
                pass
        await page.route("**/*", handle_route)
        page.on("request", build_request_handler(captured))

        # 2. Start heartbeat for this specific account
        ping_task = asyncio.create_task(heartbeat_loop(supabase, address))

        # --- Login flow ---
        await page.goto("https://audius.co/signin", wait_until="load", timeout=60_000)
        await page.fill('input[aria-label="Email"]', address)
        await page.fill('input[aria-label="Password"]', password)
        await page.wait_for_timeout(1000)

        try:
            await click_first_match(page, LOGIN_BUTTON_SELECTORS)
        except RuntimeError as e:
            print("[!] Could not click Log In:", e)
            return False, address

        try:
            await page.wait_for_url("https://audius.co/signin/confirm-email", wait_until="load", timeout=60_000)
            await page.wait_for_timeout(2000)
        except Exception:
            pass

        try:
            stdout = await run_tempmail_inbox(address)
            m = re.search(r"\d{3}\s\d{3}", stdout)
            if not m: raise RuntimeError(f"OTP not found: {stdout!r}")
            otp = m.group(0)
            print("[*] OTP:", otp)
        except Exception as e:
            print("[!] tempmail inbox failed:", e)
            return False, address

        await page.fill('input[aria-label="Code"]', otp)
        await page.wait_for_timeout(1000)
        
        try:
            await click_first_match(page, OTP_BUTTON_SELECTORS)
        except RuntimeError as e:
            print("[!] Could not click OTP submit:", e)
            return False, address

        try:
            await page.wait_for_url("https://audius.co/feed", wait_until="load", timeout=60_000)
            print("[+] Login success - feed loaded")
        except Exception:
            if "https://audius.co/feed" not in page.url:
                print("[!] Failed to reach feed. URL:", page.url)
                return False, address

        # --- Wallet capture ---
        print("[*] Opening https://audius.co/wallet ...")
        await page.goto("https://audius.co/wallet", wait_until="domcontentloaded", timeout=60_000)
        for _ in range(60):
            if captured: break
            await page.wait_for_timeout(500)

        if captured:
            # 3. Save credentials directly to the assigned row
            supabase.table("audius").update({
                "api_key": captured["api_key"],
                "encoded_dm": captured["encoded_dm"],
                "encoded_ds": captured["encoded_ds"],
            }).eq("address", address).execute()
            print("[+] Saved credentials to DB")
            success = True
        else:
            print("[!] No target API captured within 30 s")

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
        # 4. Stop heartbeat
        if ping_task:
            ping_task.cancel()
        try:
            await browser.close()
        except Exception:
            pass

    if not success:
        print(f"[*] Released {address} back to the pool")
        rpc.release(address)

    return success, address


async def main() -> None:
    url, key = load_supabase_creds()
    supabase = create_client(url, key)

    tried = set()
    ok = 0
    failed = 0
    exhausted = False

    for i in range(1, MAX_RUNS + 1):
        print(f"\n{'='*60}\n[*] Run {i}/{MAX_RUNS}\n{'='*60}")
        async with async_playwright() as pw:
            success, address = await run_one(pw, supabase, tried)

        if address is None:
            print("[*] No fresh eligible account left.")
            exhausted = True
            break

        tried.add(address)
        if success: ok += 1
        else: failed += 1
        print(f"[*] Run {i} finished")

    print(f"\n{'='*60}\n[*] Summary: {ok} ok, {failed} failed, {len(tried)} tried\n{'='*60}")
    if exhausted:
        print("[*] Stopped early - pool exhausted.")

if __name__ == "__main__":
    asyncio.run(main())