#!/usr/bin/env python3
"""
signup.py - Audius signup flow.
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

DB_FILE     = ROOT_DIR / "db.txt"
UA_FILE     = ROOT_DIR / "user_agents.txt"
NAME_FILE   = ROOT_DIR / "name.txt"
IMG_SCRIPT  = SCRIPT_DIR / "img.py"
TEMPMAIL_SCRIPT = SCRIPT_DIR / "tempmail.py"

MAX_RUNS = 5

API_PATTERN = re.compile(r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)")
STEP_SETTLE_MS = 3_000
PRE_FINAL_WAIT_MS = 20_000
REDIRECT_TIMEOUT_S = 60

POST_PROFILE_STEPS = [
    ("finish-profile", "profile"),
    ("select-genres",  "genres"),
    ("select-artists", "artists"),
]

CONTINUE_SELECTORS = [
    'button[type="submit"]:has-text("Continue")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
]

IMAGE_INPUT_SELECTORS = [
    'xpath=/html/body/div[1]/div[1]/div[4]/div/form/div[1]/div[2]/div[1]/div[2]/div[1]/input',
    'input[type="file"][accept*="image/jpeg"]',
    'input[type="file"][accept*="image"]',
    'input[type="file"]',
]

IMAGE_CLICK_SELECTORS = [
    'img.harmony-70oscu', 'div.harmony-3ptp8e',
    'img[src^="data:image"]', 'img[src^="blob:"]',
    'button[aria-label="Upload a profile photo"]', 'label:has(img)',
]

# Fallback desktop UAs (Chrome, Firefox, Edge) in case user_agents.txt is empty/missing
DESKTOP_FALLBACK_UAS = [
    # Chrome
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    # Firefox
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    # Edge
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
]


def load_supabase_creds() -> tuple[str, str]:
    text = DB_FILE.read_text()
    m_url = re.search(r'SUPABASE_URL\s*=\s*["\']([^"\']+)["\']', text)
    m_key = re.search(r'SUPABASE_KEY\s*=\s*["\']([^"\']+)["\']', text)
    return m_url.group(1), m_key.group(1)


def read_user_agent() -> str:
    uas = []
    if UA_FILE.exists():
        uas = [u.strip() for u in UA_FILE.read_text().splitlines() if u.strip()]

    # Filter: must be Chrome/Firefox/Edge, AND must NOT be mobile
    allowed = []
    for ua in uas:
        ua_lower = ua.lower()
        # Exclude mobile
        if any(mob in ua_lower for mob in ("android", "mobile", "iphone", "ipad", "ipod")):
            continue
        # Include only Chrome, Firefox, Edge
        if any(browser in ua_lower for browser in ("chrome", "firefox", "edg")):
            allowed.append(ua)

    if not allowed:
        return random.choice(DESKTOP_FALLBACK_UAS)

    return random.choice(allowed)


def generate_handle() -> str:
    names = [n.strip() for n in NAME_FILE.read_text().splitlines() if n.strip()]
    return f"{random.choice(names)}{random.randint(100, 999)}"


async def run_py(script: Path, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "python3", str(script), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{script.name} exited {proc.returncode}: {stderr.decode().strip()}")
    return stdout.decode()


def step_header(n: int, total: int, title: str) -> None:
    print(f"\n[{n}/{total}] {title}")


async def wait_with_progress(page, total_ms: int, label: str) -> None:
    steps = total_ms // 1000
    print(f"  {label} ({steps}s) ...")
    if steps < 10:
        await page.wait_for_timeout(total_ms)
        print(f"  done -> {page.url}")
        return
    for i in range(1, steps + 1):
        await page.wait_for_timeout(1000)
        if i % 5 == 0 or i == steps: print(f"    [{i}/{steps}] {page.url}")


async def wait_for_redirect(page, from_url: str, max_seconds: int = 20) -> bool:
    for i in range(max_seconds):
        if page.url != from_url:
            print(f"  -> redirected ({i+1}s)")
            return True
        await page.wait_for_timeout(1000)
    print(f"  [!] no redirect ({page.url})")
    return False


async def wait_for_leave_signup(page, max_seconds: int = 60) -> bool:
    for i in range(max_seconds):
        if "/signup" not in page.url:
            print(f"  -> left /signup ({i+1}s)")
            return True
        await page.wait_for_timeout(1000)
    return False


async def click_first_match(page, selectors: list[str], per_selector_timeout: int = 15_000) -> str:
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.click()
            print(f"  clicked via: {sel}")
            return sel
        except Exception:
            continue
    raise RuntimeError(f"None matched: {selectors}")


async def fill_first_match(page, selectors: list[str], value: str, label: str = "field") -> str:
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=15_000)
            await loc.fill(value)
            print(f"  filled {label} via: {sel}")
            return sel
        except Exception:
            continue
    raise RuntimeError(f"Could not find input for {label}")


async def upload_profile_image(page, image_path: str) -> None:
    for sel in IMAGE_INPUT_SELECTORS:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="attached", timeout=8_000)
            await loc.set_input_files(image_path)
            print(f"  uploaded image via input: {sel}")
            return
        except Exception:
            continue
    for sel in IMAGE_CLICK_SELECTORS:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=5_000)
            async with page.expect_file_chooser(timeout=5_000) as fc_info:
                await loc.click()
            fc = await fc_info.value
            await fc.set_files(image_path)
            print(f"  uploaded image via click: {sel}")
            return
        except Exception:
            continue
    raise RuntimeError("Could not upload profile image")


def build_request_handler(captured: dict):
    def handler(request):
        if not API_PATTERN.search(request.url): 
            return
            
        # Extract user_id from URL (e.g., /v1/users/NzZa3b4/coins)
        if "user_id" not in captured:
            m = re.search(r"/users/([^/?]+)", request.url)
            if m:
                captured["user_id"] = m.group(1)

        if captured.get("api_key"): 
            return

        qs = parse_qs(urlparse(request.url).query)
        api_key = qs.get("api_key", [None])[0]
        hdrs = {k.lower(): v for k, v in request.headers.items()}
        enc_dm, enc_ds = hdrs.get("encoded-data-message"), hdrs.get("encoded-data-signature")
        
        if api_key and enc_dm and enc_ds:
            captured.update({
                "api_key": api_key, 
                "encoded_dm": enc_dm, 
                "encoded_ds": enc_ds
            })
            print("  captured wallet API credentials")
            print(f"    user_id          : {captured.get('user_id', 'Unknown')}")
    return handler


async def capture_wallet_apis(page, captured: dict) -> bool:
    for attempt in (1, 2):
        if attempt == 1:
            await page.goto("https://audius.co/wallet", wait_until="domcontentloaded", timeout=60_000)
        else:
            await page.reload(wait_until="domcontentloaded", timeout=60_000)
        for _ in range(30):
            if captured.get("api_key"): return True
            await page.wait_for_timeout(500)
    return False


async def advance_post_profile_steps(page, steps: list[tuple[str, str]]) -> bool:
    for path_frag, desc in steps:
        try:
            await page.wait_for_url(f"**/signup/{path_frag}**", timeout=20_000)
        except Exception:
            return False
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)
        await wait_with_progress(page, STEP_SETTLE_MS, f"settle on {path_frag}")
        url_before = page.url
        try:
            await click_first_match(page, CONTINUE_SELECTORS)
        except RuntimeError:
            return False
        if not await wait_for_redirect(page, url_before, max_seconds=20):
            return False
    return True


async def shutdown_browser(page, context, browser) -> None:
    try: await page.wait_for_timeout(500)
    except: pass
    try: await page.unroute("**/*")
    except: pass
    try: await context.close()
    except: pass
    try: await browser.close()
    except: pass


async def heartbeat_loop(supabase, address: str):
    while True:
        await asyncio.sleep(30)
        try:
            await asyncio.to_thread(supabase.rpc("ping_audius_account", {"p_address": address}).execute)
        except Exception:
            pass


# --------------------------------------------------------------------------
# Main worker
# --------------------------------------------------------------------------
async def run_signup(pw, supabase, tried: set[str]) -> tuple[bool, str | None]:
    TOTAL = 9
    captured = {}
    signup_done = False
    email = "<unknown>"
    ping_task = None

    user_agent = read_user_agent()
    print(f"[*] user agent: {user_agent}")

    step_header(1, TOTAL, "Resolve account + handle + image")

    # 1. Ask rpc.py for an account
    account = rpc.claim("signup")
    while account and account["address"] in tried:
        rpc.release(account["address"])
        account = rpc.claim("signup")
        
    if account is None:
        print("  creating new tempmail account ...")
        await run_py(TEMPMAIL_SCRIPT, "new")  # inserts into DB
        account = rpc.claim("signup")
        
    if account is None:
        print("[!] No account available.")
        return False, None

    email, password = account["address"], account["password"]
    print(f"  email    : {email}")
    print(f"  password : {password}")

    handle = generate_handle()
    print(f"  handle   : {handle}")

    try:
        img_out = (await run_py(IMG_SCRIPT)).strip()
        m = re.search(r"Image saved as:\s*(.+)", img_out)
        if not m: raise RuntimeError(f"Image path not found in output: {img_out!r}")
        image_path = m.group(1).strip()
    except Exception as e:
        print(f"[!] {e}")
        rpc.release(email)
        return False, email
    print(f"  image    : {image_path}")

    browser = await pw.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled", "--disable-features=IsolateOrigins,site-per-process", "--no-sandbox", "--disable-dev-shm-usage"],
    )
    context = None
    page = None
    try:
        context = await browser.new_context(
            user_agent=user_agent, viewport={"width": 1280, "height": 720},
            java_script_enabled=True, bypass_csp=True,
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
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
        ping_task = asyncio.create_task(heartbeat_loop(supabase, email))

        # --- Wizard flow ---
        step_header(2, TOTAL, "Email")
        await page.goto("https://audius.co/signup/create-email", wait_until="load", timeout=60_000)
        await fill_first_match(page, ['input[aria-label="Email"]'], email, "email")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before): return False, email

        step_header(3, TOTAL, "Password")
        await page.wait_for_load_state("domcontentloaded")
        await fill_first_match(page, ['input[aria-label="Password"]'], password, "password")
        await fill_first_match(page, ['input[aria-label="Confirm Password"]'], password, "confirm password")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before): return False, email

        step_header(4, TOTAL, "Handle")
        await page.wait_for_load_state("domcontentloaded")
        await fill_first_match(page, ['input[aria-label="Handle"]'], handle, "handle")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before): return False, email

        step_header(5, TOTAL, "Profile")
        await page.wait_for_load_state("domcontentloaded")
        await upload_profile_image(page, image_path)
        await fill_first_match(page, ['input[aria-label="Display Name"]'], handle, "display name")

        step_header(6, TOTAL, "Intermediate pages")
        if not await advance_post_profile_steps(page, POST_PROFILE_STEPS): return False, email

        step_header(7, TOTAL, "Final Settle")
        await wait_with_progress(page, PRE_FINAL_WAIT_MS, "settle on final page")

        step_header(8, TOTAL, "Wait for auto-redirect")
        if "/signup" not in page.url:
            signup_done = True
        else:
            if await wait_for_leave_signup(page, REDIRECT_TIMEOUT_S):
                signup_done = True
            else:
                return False, email

        step_header(9, TOTAL, "Wallet capture + DB update")
        await capture_wallet_apis(page, captured)

        # 3. Save credentials, handle, and user_id directly to the assigned row
        payload = {
            "register": "yes",
            "handle": handle
        }
        
        if captured:
            payload.update({
                "api_key": captured["api_key"], 
                "encoded_dm": captured["encoded_dm"], 
                "encoded_ds": captured["encoded_ds"]
            })
            if "user_id" in captured:
                payload["user_id"] = captured["user_id"]
            print(f"  saved credentials and handle to DB")
        else:
            print(f"  saved handle to DB (no wallet credentials)")
        
        supabase.table("audius").update(payload).eq("address", email).execute()
        print(f"  marked {email} register='yes'")
        signup_done = True

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
        # 4. Stop heartbeat
        if ping_task:
            ping_task.cancel()
        if page is not None and context is not None:
            await shutdown_browser(page, context, browser)

    # 5. Release back to pool
    rpc.release(email)
    if not signup_done:
        print(f"\n[!] Signup failed for {email} - released for retry")

    return signup_done, email


async def main() -> None:
    url, key = load_supabase_creds()
    supabase = create_client(url, key)
    
    tried = set()
    ok = 0
    failed = 0
    exhausted = False

    print("[*] Audius signup")
    for i in range(1, MAX_RUNS + 1):
        print(f"\n{'='*60}\n[*] Run {i}/{MAX_RUNS}\n{'='*60}")
        async with async_playwright() as pw:
            success, address = await run_signup(pw, supabase, tried)

        if address is None:
            print("[*] No account available (creation failed).")
            exhausted = True
            break

        tried.add(address)
        if success: ok += 1
        else: failed += 1
        print(f"[*] Run {i} finished")

    print(f"\n{'='*60}\n[*] Summary: {ok} ok, {failed} failed, {len(tried)} tried\n{'='*60}")
    if exhausted:
        print("[*] Stopped early - no account available.")

if __name__ == "__main__":
    asyncio.run(main())