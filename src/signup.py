#!/usr/bin/env python3
"""
signup.py - Audius signup flow + complete-incomplete recovery mode.

Two modes (controlled by COMPLETE_INCOMPLETE_MODE below):

  COMPLETE_INCOMPLETE_MODE = False
      Original behavior: claim fresh accounts from the pool, run the full
      signup wizard, capture wallet API credentials, and store
      {register, handle, encoded_dm, encoded_ds, user_id} in the audius table.

  COMPLETE_INCOMPLETE_MODE = True
      Recovery behavior: for every target email (or, if the list is empty,
      every row with register='no'), LOG IN (instead of signing up), finish
      whatever part of the signup wizard is still pending, capture user_id,
      and save {register, handle, user_id} to the DB. Handles are stored
      with spaces removed (e.g. "Luna Rose" -> "LunaRose").
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

# ---------------------------------------------------------------------------
# Complete-incomplete mode toggle
#   True  -> LOG IN to the accounts below and finish their pending signup
#   False -> normal signup flow (claim fresh accounts from the pool)
# ---------------------------------------------------------------------------
COMPLETE_INCOMPLETE_MODE = True

# Emails to process when COMPLETE_INCOMPLETE_MODE is True.
# Leave empty ([]) to auto-discover every row with register='no'.
COMPLETE_TARGETS = []

# ---------------------------------------------------------------------------
# Handle name source toggle
#   True  -> use the CUSTOM_NAMES list below (ignores name.txt)
#   False -> read random names from name.txt
# ---------------------------------------------------------------------------
USE_CUSTOM_NAMES = True

CUSTOM_NAMES = [
    "Luna Rose",
    "Jayden Blake",
    "Nova Skye",
    "Zay Carter",
    "Mila Storm",
    "Kairo James",
    "Ariana Lux",
    "Dante King",
    "Bella Moon",
    "Ryder Cole",
]

API_PATTERN = re.compile(
    r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)"
)
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

LOGIN_BUTTON_SELECTORS = [
    'button[type="submit"]:has-text("Log In")',
    'button:has-text("Log In")',
    'button[type="submit"]',
]

OTP_BUTTON_SELECTORS = [
    'button[type="submit"]',
    'button:has-text("Verify")',
    'button:has-text("Continue")',
    'button:has-text("Submit")',
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

DESKTOP_FALLBACK_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0",
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
    uas = []
    if UA_FILE.exists():
        uas = [u.strip() for u in UA_FILE.read_text().splitlines() if u.strip()]

    allowed = []
    for ua in uas:
        ua_lower = ua.lower()
        if any(mob in ua_lower for mob in ("android", "mobile", "iphone", "ipad", "ipod")):
            continue
        if any(browser in ua_lower for browser in ("chrome", "firefox", "edg")):
            allowed.append(ua)

    if not allowed:
        return random.choice(DESKTOP_FALLBACK_UAS)
    return random.choice(allowed)


def generate_handle() -> str:
    if USE_CUSTOM_NAMES:
        return random.choice(CUSTOM_NAMES)
    names = [n.strip() for n in NAME_FILE.read_text().splitlines() if n.strip()]
    return random.choice(names)


def handle_for_db(handle: str) -> str:
    """Strip spaces so 'Luna Rose' -> 'LunaRose' before saving to the DB."""
    return re.sub(r"\s+", "", handle)


async def run_py(script: Path, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "python3", str(script), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{script.name} exited {proc.returncode}: {stderr.decode().strip()}")
    return stdout.decode()


async def run_tempmail_inbox(address: str) -> str:
    """
    Fetch the inbox for <address> via `python3 tempmail.py inbox <address>`.
    Mirrors login.py: does NOT raise on non-zero exit — returns whatever
    stdout we got, so the OTP retry loop can just retry on empty output.
    """
    proc = await asyncio.create_subprocess_exec(
        "python3", str(TEMPMAIL_SCRIPT), "inbox", address,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
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
        if i % 5 == 0 or i == steps:
            print(f"    [{i}/{steps}] {page.url}")


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
    """Captures wallet API creds + user_id from /v1/users/<id>/(coins|connected_wallets)."""
    def handler(request):
        if not API_PATTERN.search(request.url):
            return

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
                "encoded_ds": enc_ds,
            })
            print("  captured wallet API credentials")
            print(f"    user_id          : {captured.get('user_id', 'Unknown')}")
    return handler


def build_me_response_handler(captured: dict):
    """Fallback: capture user_id from /v1/(full/)?users/me responses."""
    async def on_response(response):
        url = response.url
        if "/users/me" not in url and "/users/self" not in url:
            return
        if response.status != 200:
            return
        try:
            data = await response.json()
            node = data.get("data", data) if isinstance(data, dict) else None
            if isinstance(node, dict):
                uid = node.get("id") or node.get("user_id")
                if uid and "user_id" not in captured:
                    captured["user_id"] = uid
                    print(f"  [me] captured user_id: {uid}")
        except Exception:
            pass
    return on_response


async def capture_wallet_apis(page, captured: dict) -> bool:
    for attempt in (1, 2):
        if attempt == 1:
            await page.goto("https://audius.co/wallet",
                            wait_until="domcontentloaded", timeout=60_000)
        else:
            await page.reload(wait_until="domcontentloaded", timeout=60_000)
        for _ in range(30):
            if captured.get("api_key"):
                return True
            await page.wait_for_timeout(500)
    return False


async def extract_user_id_from_localstorage(page) -> str | None:
    try:
        return await page.evaluate("""() => {
            const keys = ['audius-user', 'audius-account-user', 'audius-user-id',
                          'audius:user', 'audius-user-data', 'user', 'user_id'];
            for (const k of keys) {
                const v = localStorage.getItem(k);
                if (!v) continue;
                try {
                    const obj = JSON.parse(v);
                    if (obj && typeof obj === 'object') {
                        const uid = obj.user_id || obj.id || obj.userId;
                        if (uid) return uid;
                    }
                } catch {
                    if (v.length < 50) return v;
                }
            }
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (!k || !k.toLowerCase().includes('user')) continue;
                const v = localStorage.getItem(k);
                try {
                    const obj = JSON.parse(v);
                    if (obj && typeof obj === 'object') {
                        if (obj.user_id) return obj.user_id;
                        if (obj.id && typeof obj.id === 'string') return obj.id;
                    }
                } catch {}
            }
            return null;
        }""")
    except Exception:
        return None


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
            await asyncio.to_thread(
                supabase.rpc("ping_audius_account", {"p_address": address}).execute
            )
        except Exception:
            pass


def save_payload(supabase, email: str, payload: dict) -> None:
    """Update the DB row, dropping columns that don't exist in the schema."""
    while True:
        try:
            supabase.table("audius").update(payload).eq("address", email).execute()
            return
        except Exception as e:
            m = re.search(r"Could not find the '([^']+)' column", str(e))
            if not m:
                raise
            missing = m.group(1)
            if missing not in payload:
                raise
            print(f"  [!] column '{missing}' does not exist in DB - dropping it and retrying")
            payload.pop(missing)


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


# --------------------------------------------------------------------------
# Complete-incomplete mode: generic wizard completion helper
# --------------------------------------------------------------------------
async def complete_wizard(page, handle_with_spaces: str, image_path: str) -> bool:
    """
    Walk the signup wizard from wherever the account is currently stuck.
    Returns True when the URL leaves /signup (typically onto /feed).
    """
    for iteration in range(6):
        if "/signup" not in page.url:
            print(f"  -> left /signup: {page.url}")
            return True

        url = page.url
        print(f"  [wizard {iteration+1}] at: {url}")

        try:
            await page.wait_for_load_state("domcontentloaded", timeout=60_000)
        except Exception:
            pass

        if "pick-handle" in url:
            await fill_first_match(
                page, ['input[aria-label="Handle"]', 'input[name="handle"]'],
                handle_with_spaces, "handle",
            )
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False

        elif "finish-profile" in url:
            try:
                await upload_profile_image(page, image_path)
            except RuntimeError as e:
                print(f"  [!] image upload failed: {e}")
            await fill_first_match(
                page, ['input[aria-label="Display Name"]', 'input[name="displayName"]'],
                handle_with_spaces, "display name",
            )
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False

        elif "select-genres" in url:
            await page.wait_for_timeout(3000)
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False

        elif "select-artists" in url:
            await page.wait_for_timeout(3000)
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False

        elif "create-email" in url or "create-password" in url:
            print(f"  [!] Unexpected early signup step: {url}")
            return False

        else:
            print(f"  [?] Unknown signup step: {url}")
            await page.wait_for_timeout(3000)

    return "/signup" not in page.url


# --------------------------------------------------------------------------
# Normal signup worker (original behavior, updated to strip spaces on save)
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

    account = rpc.claim("signup")
    while account and account["address"] in tried:
        rpc.release(account["address"])
        account = rpc.claim("signup")

    if account is None:
        print("  creating new tempmail account ...")
        await run_py(TEMPMAIL_SCRIPT, "new")
        account = rpc.claim("signup")

    if account is None:
        print("[!] No account available.")
        return False, None

    email, password = account["address"], account["password"]
    print(f"  email    : {email}")
    print(f"  password : {password}")

    handle = generate_handle()
    handle_db = handle_for_db(handle)
    print(f"  handle   : {handle}  (DB will store: {handle_db})")

    try:
        img_out = (await run_py(IMG_SCRIPT)).strip()
        m = re.search(r"Image saved as:\s*(.+)", img_out)
        if not m:
            raise RuntimeError(f"Image path not found in output: {img_out!r}")
        image_path = m.group(1).strip()
    except Exception as e:
        print(f"[!] {e}")
        rpc.release(email)
        return False, email
    print(f"  image    : {image_path}")

    browser = await pw.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled",
              "--disable-features=IsolateOrigins,site-per-process",
              "--no-sandbox", "--disable-dev-shm-usage"],
    )
    context = None
    page = None
    try:
        context = await browser.new_context(
            user_agent=user_agent, viewport={"width": 1280, "height": 720},
            java_script_enabled=True, bypass_csp=True,
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )
        page = await context.new_page()

        async def handle_route(route):
            try:
                await asyncio.sleep(random.random() * 0.1)
                await route.continue_()
            except Exception:
                pass
        await page.route("**/*", handle_route)
        page.on("request", build_request_handler(captured))
        page.on("response", build_me_response_handler(captured))

        ping_task = asyncio.create_task(heartbeat_loop(supabase, email))

        # --- Wizard flow ---
        step_header(2, TOTAL, "Email")
        await page.goto("https://audius.co/signup/create-email",
                        wait_until="load", timeout=60_000)
        await fill_first_match(page, ['input[aria-label="Email"]'], email, "email")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before):
            return False, email

        step_header(3, TOTAL, "Password")
        await page.wait_for_load_state("domcontentloaded")
        await fill_first_match(page, ['input[aria-label="Password"]'], password, "password")
        await fill_first_match(page, ['input[aria-label="Confirm Password"]'], password, "confirm password")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before):
            return False, email

        step_header(4, TOTAL, "Handle")
        await page.wait_for_load_state("domcontentloaded")
        await fill_first_match(page, ['input[aria-label="Handle"]'], handle, "handle")
        url_before = page.url
        await click_first_match(page, CONTINUE_SELECTORS)
        if not await wait_for_redirect(page, url_before):
            return False, email

        step_header(5, TOTAL, "Profile")
        await page.wait_for_load_state("domcontentloaded")
        await upload_profile_image(page, image_path)
        await fill_first_match(page, ['input[aria-label="Display Name"]'], handle, "display name")

        step_header(6, TOTAL, "Intermediate pages")
        if not await advance_post_profile_steps(page, POST_PROFILE_STEPS):
            return False, email

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

        payload = {
            "register": "yes",
            "handle": handle_db,        # <-- stripped for DB
        }
        if captured:
            payload["encoded_dm"] = captured["encoded_dm"]
            payload["encoded_ds"] = captured["encoded_ds"]
            if "user_id" in captured:
                payload["user_id"] = captured["user_id"]

        save_payload(supabase, email, payload)

        if captured:
            print("  saved wallet credentials + handle to DB")
        else:
            print("  saved handle to DB (no wallet credentials)")
        print(f"  marked {email} register='yes'")
        signup_done = True

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
        if ping_task:
            ping_task.cancel()
        if page is not None and context is not None:
            await shutdown_browser(page, context, browser)

    rpc.release(email)
    if not signup_done:
        print(f"\n[!] Signup failed for {email} - released for retry")

    return signup_done, email


# --------------------------------------------------------------------------
# Complete-incomplete worker: LOG IN + finish wizard + save user_id + handle
# --------------------------------------------------------------------------
async def run_complete_incomplete(pw, supabase, email: str) -> bool:
    TOTAL = 6
    captured = {}
    ping_task = None
    success = False

    # ---- 1. Fetch the row from DB ----
    step_header(1, TOTAL, f"Lookup {email}")
    try:
        res = await asyncio.to_thread(
            lambda: supabase.table("audius")
                            .select("password, register, handle, user_id")
                            .eq("address", email)
                            .execute()
        )
    except Exception as e:
        print(f"[!] DB lookup failed: {e}")
        return False

    if not res.data:
        print(f"[!] {email} not found in audius table")
        return False

    row = res.data[0]
    password = row.get("password")
    if not password:
        print(f"[!] {email} has no password stored - cannot log in")
        return False

    current_register = row.get("register")
    print(f"  register : {current_register}")
    print(f"  handle   : {row.get('handle')}")
    print(f"  user_id  : {row.get('user_id')}")
    if current_register == "yes":
        print("  [!] register already 'yes' - will still try to refresh user_id/handle")

    handle = generate_handle()
    handle_db = handle_for_db(handle)
    print(f"  generated handle: {handle}  ->  DB will store: {handle_db}")

    # ---- Generate profile image ----
    try:
        img_out = (await run_py(IMG_SCRIPT)).strip()
        m = re.search(r"Image saved as:\s*(.+)", img_out)
        if not m:
            raise RuntimeError(f"Image path not found: {img_out!r}")
        image_path = m.group(1).strip()
    except Exception as e:
        print(f"[!] image generation failed: {e}")
        return False
    print(f"  image    : {image_path}")

    user_agent = read_user_agent()
    print(f"[*] user agent: {user_agent}")

    browser = await pw.chromium.launch(
        headless=False,
        args=["--disable-blink-features=AutomationControlled",
              "--disable-features=IsolateOrigins,site-per-process",
              "--no-sandbox", "--disable-dev-shm-usage"],
    )
    context = None
    page = None
    try:
        context = await browser.new_context(
            user_agent=user_agent, viewport={"width": 1280, "height": 720},
            java_script_enabled=True, bypass_csp=True,
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        await context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )
        page = await context.new_page()

        async def handle_route(route):
            try:
                await asyncio.sleep(random.random() * 0.1)
                await route.continue_()
            except Exception:
                pass
        await page.route("**/*", handle_route)
        page.on("request", build_request_handler(captured))
        page.on("response", build_me_response_handler(captured))

        ping_task = asyncio.create_task(heartbeat_loop(supabase, email))

        # ---- 2. LOG IN ----
        step_header(2, TOTAL, "Log in")
        await page.goto("https://audius.co/signin", wait_until="load", timeout=60_000)
        await page.fill('input[aria-label="Email"]', email)
        await page.fill('input[aria-label="Password"]', password)
        await page.wait_for_timeout(1000)
        await click_first_match(page, LOGIN_BUTTON_SELECTORS)

        # Wait for either confirm-email or a redirect
        try:
            await page.wait_for_url(
                "**/signin/confirm-email**",
                wait_until="load", timeout=60_000,
            )
            await page.wait_for_timeout(2000)
        except Exception:
            print(f"  [!] no confirm-email redirect (url: {page.url})")

        # Some flows land on confirm-email a bit later even after the wait
        # timed out — re-check once more.
        if "confirm-email" not in page.url and "/signin" in page.url:
            for _ in range(5):
                await page.wait_for_timeout(1000)
                if "confirm-email" in page.url:
                    break

        if "confirm-email" in page.url:
            # ---- 3. OTP ----
            step_header(3, TOTAL, "OTP")
            otp = None
            for attempt in range(1, 11):
                try:
                    stdout = await run_tempmail_inbox(email)
                    m = re.search(r"\d{3}\s\d{3}", stdout)
                    if m:
                        otp = m.group(0)
                        print(f"  OTP: {otp}")
                        break
                    print(f"  attempt {attempt}/10: no OTP yet")
                except Exception as e:
                    print(f"  attempt {attempt}/10: tempmail inbox failed: {e}")
                if attempt < 10:
                    print("    -> waiting 5s for email to arrive...")
                    await page.wait_for_timeout(5000)

            if not otp:
                print("[!] OTP not received after 10 attempts")
                return False

            await page.fill('input[aria-label="Code"]', otp)
            await page.wait_for_timeout(1000)
            await click_first_match(page, OTP_BUTTON_SELECTORS)

            for _ in range(60):
                if "/feed" in page.url or "/signup" in page.url:
                    break
                await page.wait_for_timeout(1000)

        # ---- 4. Decide current state ----
        step_header(4, TOTAL, "Post-login state")
        print(f"  url      : {page.url}")

        # Give the SPA a moment to settle and possibly bounce us to /signup/*
        for _ in range(30):
            if "/feed" in page.url or "/signup" in page.url:
                break
            await page.wait_for_timeout(1000)
        print(f"  settled  : {page.url}")

        if "/signin" in page.url:
            print("[!] Login failed (still on /signin)")
            return False

        if "/signup" in page.url:
            # ---- 5. Complete whatever wizard step is pending ----
            step_header(5, TOTAL, "Complete signup wizard")
            if not await complete_wizard(page, handle, image_path):
                print(f"[!] Wizard did not complete (still at {page.url})")
                return False

            # Wait for /feed after wizard
            if "/feed" not in page.url:
                if not await wait_for_leave_signup(page, REDIRECT_TIMEOUT_S):
                    print(f"[!] Still on signup: {page.url}")
                    return False
            await page.wait_for_timeout(2000)
            print(f"  wizard done -> {page.url}")
        else:
            # Account appears already complete - we'll try to grab an existing handle
            print("  account already complete (no wizard)")
            existing_handle = row.get("handle")
            if existing_handle:
                handle_db = handle_for_db(existing_handle)
                print(f"  reusing existing handle from DB: {handle_db}")

        # ---- 6. Capture user_id + save to DB ----
        step_header(6, TOTAL, "Capture user_id + save")
        await capture_wallet_apis(page, captured)

        if "user_id" not in captured:
            uid = await extract_user_id_from_localstorage(page)
            if uid:
                captured["user_id"] = uid
                print(f"  [localStorage] user_id: {uid}")

        if "user_id" not in captured:
            print("  [!] could not capture user_id - will save without it")

        payload = {
            "register": "yes",
            "handle": handle_db,
        }
        if "user_id" in captured:
            payload["user_id"] = captured["user_id"]
        if "encoded_dm" in captured:
            payload["encoded_dm"] = captured["encoded_dm"]
        if "encoded_ds" in captured:
            payload["encoded_ds"] = captured["encoded_ds"]

        save_payload(supabase, email, payload)
        print(f"  saved columns: {', '.join(payload.keys())}")
        success = True

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
        if ping_task:
            ping_task.cancel()
        if page is not None and context is not None:
            await shutdown_browser(page, context, browser)

    return success


# --------------------------------------------------------------------------
# Entry points
# --------------------------------------------------------------------------
async def run_signup_mode(supabase) -> None:
    tried = set()
    ok = 0
    failed = 0
    exhausted = False

    src = "CUSTOM_NAMES list" if USE_CUSTOM_NAMES else "name.txt"
    print("[*] Audius signup")
    print(f"[*] Handle source: {src}")

    for i in range(1, MAX_RUNS + 1):
        print(f"\n{'='*60}\n[*] Run {i}/{MAX_RUNS}\n{'='*60}")
        async with async_playwright() as pw:
            success, address = await run_signup(pw, supabase, tried)

        if address is None:
            print("[*] No account available (creation failed).")
            exhausted = True
            break

        tried.add(address)
        if success:
            ok += 1
        else:
            failed += 1
        print(f"[*] Run {i} finished")

    print(f"\n{'='*60}\n[*] Summary: {ok} ok, {failed} failed, {len(tried)} tried\n{'='*60}")
    if exhausted:
        print("[*] Stopped early - no account available.")


async def run_complete_mode(supabase) -> None:
    # Build target list
    targets = list(dict.fromkeys(COMPLETE_TARGETS))
    if not targets:
        print("[*] No explicit targets - querying rows with register='no' ...")
        try:
            res = await asyncio.to_thread(
                lambda: supabase.table("audius")
                                .select("address")
                                .eq("register", "no")
                                .execute()
            )
            targets = [r["address"] for r in (res.data or [])]
        except Exception as e:
            print(f"[!] DB query failed: {e}")
            return

    total = len(targets)
    print(f"\n{'='*60}")
    print(f"[*] Complete-incomplete mode: {total} account(s)")
    for t in targets:
        print(f"    - {t}")
    print(f"{'='*60}")

    if not total:
        print("[*] Nothing to do.")
        return

    succeeded: list[str] = []
    failed: list[str] = []

    for i, email in enumerate(targets, 1):
        print(f"\n{'='*60}")
        print(f"[*] [{i}/{total}] {email}")
        print(f"{'='*60}")

        ok = False
        for attempt in (1, 2):
            try:
                async with async_playwright() as pw:
                    ok = await run_complete_incomplete(pw, supabase, email)
            except Exception as e:
                print(f"[!] Attempt {attempt} fatal: {e}")

            if ok:
                break
            if attempt == 1:
                print("  [!] First attempt failed - retrying once...")

        if ok:
            succeeded.append(email)
            print(f"[+] DONE: {email}")
        else:
            failed.append(email)
            print(f"[!] GAVE UP: {email}")

    print(f"\n{'='*60}")
    print(f"[*] SUMMARY: {len(succeeded)} succeeded, {len(failed)} failed")
    print(f"{'='*60}")
    if succeeded:
        print(f"[+] Succeeded ({len(succeeded)}):")
        for a in succeeded:
            print(f"    ✓ {a}")
    if failed:
        print(f"[!] Failed ({len(failed)}):")
        for a in failed:
            print(f"    ✗ {a}")


async def main() -> None:
    url, key = load_supabase_creds()
    supabase = create_client(url, key)

    print(f"[*] Mode: {'COMPLETE-INCOMPLETE (login + finish wizard)' if COMPLETE_INCOMPLETE_MODE else 'SIGNUP (fresh accounts)'}")

    if COMPLETE_INCOMPLETE_MODE:
        await run_complete_mode(supabase)
    else:
        await run_signup_mode(supabase)


if __name__ == "__main__":
    asyncio.run(main())