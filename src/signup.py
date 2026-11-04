#!/usr/bin/env python3
"""
signup.py - Audius signup flow with automatic wizard advance detection.
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
NAME_FILE       = ROOT_DIR / "name.txt"
TEMPMAIL_SCRIPT = SCRIPT_DIR / "tempmail.py"
IMG_SCRIPT      = SCRIPT_DIR / "img.py"

API_PATTERN = re.compile(
    r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)"
)

# ---- timing ----
STEP_SETTLE_MS     =  3_000   # settle before each Continue on intermediate pages
PRE_FINAL_WAIT_MS  = 20_000   # settle on the final page BEFORE clicking Continue
POST_FINAL_WAIT_MS = 20_000   # settle AFTER final Continue (creation POST)

# ---- intermediate wizard pages (each requires one Continue) ----
POST_PROFILE_STEPS = [
    ("finish-profile", "profile / display name"),
    ("select-genres",  "select genres"),
    ("select-artists", "select artists"),
]

# ---- selector sets ----
CONTINUE_SELECTORS = [
    'button[type="submit"]:has-text("Continue")',
    'button[type="submit"]',
    'button:has-text("Continue")',
    'button:has-text("Next")',
]

FINAL_CONTINUE_SELECTORS = [
    'xpath=/html/body/div[1]/div[1]/div[4]/div/form/div[2]/div/button',
    'xpath=/html/body/div[1]/div[1]/div/div[1]/div[2]/div[2]/button',
    'button[type="submit"]:has-text("Continue")',
    'button[type="submit"]',
    'button:has-text("Done")',
    'button:has-text("Continue")',
]


# --------------------------------------------------------------------------
# Config / file helpers
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


def read_user_agent() -> str:
    if not UA_FILE.exists():
        raise FileNotFoundError(f"user_agents.txt not found at {UA_FILE}")
    uas = [u.strip() for u in UA_FILE.read_text().splitlines() if u.strip()]
    if not uas:
        raise RuntimeError(f"No user agents found in {UA_FILE}")
    return random.choice(uas)


def generate_handle() -> str:
    if not NAME_FILE.exists():
        raise FileNotFoundError(f"name.txt not found at {NAME_FILE}")
    names = [n.strip() for n in NAME_FILE.read_text().splitlines() if n.strip()]
    if not names:
        raise RuntimeError(f"No names found in {NAME_FILE}")
    return f"{random.choice(names)}{random.randint(100, 999)}"


async def run_py(script: Path, *args: str) -> str:
    proc = await asyncio.create_subprocess_exec(
        "python3", str(script), *args,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(
            f"{script.name} exited {proc.returncode}: {stderr.decode().strip()}"
        )
    return stdout.decode()


# --------------------------------------------------------------------------
# Logging helpers
# --------------------------------------------------------------------------
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
            print(f"  -> redirected to {page.url} ({i + 1}s)")
            return True
        await page.wait_for_timeout(1000)
    print(f"  [!] no redirect after {max_seconds}s (still {page.url})")
    return False


async def wait_for_leave_signup(page, max_seconds: int = 60) -> bool:
    for i in range(max_seconds):
        if "/signup" not in page.url:
            print(f"  -> left /signup: {page.url} ({i + 1}s)")
            return True
        if i % 5 == 0 and i > 0:
            print(f"    [{i}s] still {page.url}")
        await page.wait_for_timeout(1000)
    print(f"  [!] still on /signup after {max_seconds}s: {page.url}")
    return False


# --------------------------------------------------------------------------
# Interaction helpers
# --------------------------------------------------------------------------
async def click_first_match(page, selectors: list[str],
                            per_selector_timeout: int = 15_000) -> str:
    last_err = None
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.click()
            print(f"  clicked via: {sel}")
            return sel
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(
        f"None of the selectors matched a visible element: {selectors} "
        f"(last error: {last_err})"
    )


async def fill_first_match(page, selectors: list[str], value: str,
                           per_selector_timeout: int = 15_000,
                           label: str = "field") -> str:
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.fill(value)
            print(f"  filled {label} via: {sel}")
            return sel
        except Exception:
            continue
    raise RuntimeError(f"Could not find input for {label}: {selectors}")


async def upload_profile_image(page, image_path: str) -> None:
    # Path A: hidden input
    input_selectors = [
        'input[type="file"][accept*="image/jpeg"]',
        'input[type="file"][accept*="image"]',
        'input[type="file"]',
        'xpath=/html/body/div[1]/div[1]/div[4]/div/form/div[1]/div[2]/div[1]/div[2]/div[1]/input',
    ]
    for sel in input_selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="attached", timeout=8_000)
            await loc.set_input_files(image_path)
            print(f"  uploaded image via input: {sel}")
            return
        except Exception:
            continue

    # Path B: click visual preview
    click_candidates = [
        'img.harmony-70oscu',
        'div.harmony-3ptp8e',
        'img[src^="data:image"]',
        'img[src^="blob:"]',
        'button[aria-label="Upload a profile photo"]',
        'label:has(img)',
    ]
    for sel in click_candidates:
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

    raise RuntimeError("Could not upload profile image via any selector")


# --------------------------------------------------------------------------
# Wallet API capture
# --------------------------------------------------------------------------
def build_request_handler(captured: dict):
    def handler(request):
        if captured:
            return
        if not API_PATTERN.search(request.url):
            return

        qs      = parse_qs(urlparse(request.url).query)
        api_key = qs.get("api_key", [None])[0]
        hdrs    = {k.lower(): v for k, v in request.headers.items()}
        enc_dm  = hdrs.get("encoded-data-message")
        enc_ds  = hdrs.get("encoded-data-signature")

        if not (api_key and enc_dm and enc_ds):
            return

        captured["api_key"]    = api_key
        captured["encoded_dm"] = enc_dm
        captured["encoded_ds"] = enc_ds

        print("  captured wallet API credentials")
        print(f"    api_key          : {api_key}")
        print(f"    Encoded-Data-Msg : {enc_dm}")
        print(f"    Encoded-Data-Sig : {enc_ds[:24]}...{enc_ds[-6:]}")
    return handler


async def capture_wallet_apis(page, captured: dict) -> bool:
    wallet_url = "https://audius.co/wallet"

    for attempt in (1, 2):
        if attempt == 1:
            print(f"  opening {wallet_url} ...")
            await page.goto(wallet_url,
                            wait_until="domcontentloaded", timeout=60_000)
        else:
            print("  no API after 15s - reloading /wallet ...")
            await page.reload(wait_until="domcontentloaded", timeout=60_000)

        for _ in range(30):
            if captured:
                return True
            await page.wait_for_timeout(500)

    return False


# --------------------------------------------------------------------------
# Account sourcing
# --------------------------------------------------------------------------
def get_existing_pending_account(supabase) -> dict | None:
    try:
        resp = (
            supabase.table("audius")
            .select("address,password")
            .eq("register", "no")
            .order("created_at")
            .limit(1)
            .execute()
        )
        if resp.data:
            return resp.data[0]
    except Exception as e:
        print(f"[!] DB query for pending accounts failed: {e}")
    return None


async def get_or_create_account(supabase) -> tuple[str, str] | None:
    existing = get_existing_pending_account(supabase)
    if existing:
        print(f"  reusing pending account from DB: {existing['address']}")
        return existing["address"], existing["password"]

    print("  no pending account found - creating tempmail account ...")
    try:
        py_out = (await run_py(TEMPMAIL_SCRIPT, "new")).strip()
    except RuntimeError as e:
        print(f"[!] {e}")
        return None

    lines = [l.strip() for l in py_out.splitlines() if l.strip()]
    if len(lines) < 2:
        print(f"[!] Invalid output from tempmail.py: {py_out!r}")
        return None
    return lines[0], lines[1]


# --------------------------------------------------------------------------
# Wizard: advance through post-profile pages
# --------------------------------------------------------------------------
async def advance_post_profile_steps(page,
                                     steps: list[tuple[str, str]]) -> bool:
    for path_frag, desc in steps:
        print(f"  waiting for /signup/{path_frag} ({desc}) ...")
        try:
            await page.wait_for_url(f"**/signup/{path_frag}**", timeout=20_000)
        except Exception:
            print(f"  [!] never reached /signup/{path_frag} "
                  f"(current: {page.url})")
            return False
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)

        await wait_with_progress(page, STEP_SETTLE_MS, f"settle on {path_frag}")

        url_before = page.url
        try:
            await click_first_match(page, CONTINUE_SELECTORS)
        except RuntimeError as e:
            print(f"  [!] {e}")
            return False

        if not await wait_for_redirect(page, url_before, max_seconds=20):
            return False

    return True


# --------------------------------------------------------------------------
# Clean browser shutdown (avoids TargetClosedError noise)
# --------------------------------------------------------------------------
async def shutdown_browser(page, context, browser) -> None:
    """
    Drain in-flight request handlers before closing so the route handler
    stops cleanly instead of throwing TargetClosedError at process exit.
    """
    try:
        # Give any pending route handler a moment to finish its jitter sleep
        await page.wait_for_timeout(500)
    except Exception:
        pass

    try:
        await page.unroute("**/*")
    except Exception:
        pass

    try:
        await context.close()
    except Exception:
        pass

    try:
        await browser.close()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Single signup attempt
# --------------------------------------------------------------------------
async def run_signup(pw, supabase) -> bool:
    TOTAL = 10
    captured: dict = {}
    signup_done = False
    email = "<unknown>"

    user_agent = read_user_agent()
    print(f"[*] user agent: {user_agent}")

    if not IMG_SCRIPT.exists():
        print(f"[!] img.py not found at {IMG_SCRIPT}")
        return False

    # ------------------------------------------------------------------
    step_header(1, TOTAL, "Resolve account + handle + image")
    # ------------------------------------------------------------------
    account = await get_or_create_account(supabase)
    if account is None:
        return False
    email, password = account
    print(f"  email    : {email}")
    print(f"  password : {password}")

    try:
        handle = generate_handle()
    except (FileNotFoundError, RuntimeError) as e:
        print(f"[!] {e}")
        return False
    print(f"  handle   : {handle}")

    try:
        img_out = (await run_py(IMG_SCRIPT)).strip()
    except RuntimeError as e:
        print(f"[!] {e}")
        return False
    m = re.search(r"Image saved as:\s*(.+)", img_out)
    if not m:
        print(f"[!] Image path not found in img.py output: {img_out!r}")
        return False
    image_path = m.group(1).strip()
    print(f"  image    : {image_path}")

    # ------------------------------------------------------------------
    browser = await pw.chromium.launch(
        headless=False,
        args=[
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--no-sandbox",
            "--disable-dev-shm-usage",
        ],
    )
    context = None
    page = None
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
            # Wrap everything - browser may be closing while we sleep
            try:
                await asyncio.sleep(random.random() * 0.1)
                await route.continue_()
            except Exception:
                pass   # target closed mid-request - not an error

        await page.route("**/*", handle_route)
        page.on("request", build_request_handler(captured))

        # --------------------------------------------------------------
        step_header(2, TOTAL, "Email")
        # --------------------------------------------------------------
        signup_url = "https://audius.co/signup/create-email"
        print(f"  navigating to {signup_url}")
        await page.goto(signup_url, wait_until="load", timeout=60_000)

        await fill_first_match(
            page,
            [
                'input[aria-label="Email"][name="email"]',
                'input[aria-label="Email"]',
            ],
            email,
            label="email",
        )
        url_before = page.url
        await click_first_match(page, [
            'button[type="submit"]:has-text("Continue")',
            'button[type="submit"]',
            'button:has-text("Continue")',
            'button:has-text("Next")',
            'xpath=/html/body/div[1]/div[1]/div/div[1]/form/div[4]/button',
        ])
        if not await wait_for_redirect(page, url_before, max_seconds=20):
            return False

        # --------------------------------------------------------------
        step_header(3, TOTAL, "Password")
        # --------------------------------------------------------------
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)
        await fill_first_match(
            page,
            [
                'input[aria-label="Password"][name="password"]',
                'input[aria-label="Password"]',
            ],
            password,
            label="password",
        )
        await fill_first_match(
            page,
            [
                'input[aria-label="Confirm Password"][name="confirmPassword"]',
                'input[aria-label="Confirm Password"]',
            ],
            password,
            label="confirm password",
        )
        url_before = page.url
        await click_first_match(page, [
            'button[type="submit"]:has-text("Continue")',
            'button[type="submit"]',
            'button:has-text("Continue")',
            'button:has-text("Next")',
            'xpath=/html/body/div[1]/div[1]/div/div[1]/form/div[3]/button',
        ])
        if not await wait_for_redirect(page, url_before, max_seconds=20):
            return False

        # --------------------------------------------------------------
        step_header(4, TOTAL, "Handle")
        # --------------------------------------------------------------
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)
        await fill_first_match(
            page,
            [
                'input[aria-label="Handle"][name="handle"]',
                'input[aria-label="Handle"]',
            ],
            handle,
            label="handle",
        )
        url_before = page.url
        await click_first_match(page, [
            'button[type="submit"]:has-text("Continue")',
            'button[type="submit"]',
            'button:has-text("Continue")',
            'button:has-text("Next")',
            'xpath=/html/body/div[1]/div[1]/div/div[1]/form/div[2]/button',
        ])
        if not await wait_for_redirect(page, url_before, max_seconds=20):
            return False

        # --------------------------------------------------------------
        step_header(5, TOTAL, "Profile (image + display name)")
        # --------------------------------------------------------------
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)
        await upload_profile_image(page, image_path)
        await fill_first_match(
            page,
            [
                'input[aria-label="Display Name"][name="displayName"]',
                'input[aria-label="Display Name"]',
            ],
            handle,
            label="display name",
        )

        # --------------------------------------------------------------
        step_header(6, TOTAL, "Advance intermediate wizard pages")
        # --------------------------------------------------------------
        if not await advance_post_profile_steps(page, POST_PROFILE_STEPS):
            print("[!] Wizard did not advance through all intermediate steps")
            return False

        # --------------------------------------------------------------
        step_header(7, TOTAL, "Pre-final settle on final page")
        # --------------------------------------------------------------
        await wait_with_progress(
            page, PRE_FINAL_WAIT_MS,
            "settle before final Continue",
        )

        # --------------------------------------------------------------
        step_header(8, TOTAL, "Finalisation")
        # --------------------------------------------------------------
        print(f"  current url: {page.url}")
        clicked_final = False

        if "/signup" not in page.url:
            print("  already off /signup - skipping final Continue")
            signup_done = True
        else:
            print("  still on /signup - clicking final Continue ...")
            try:
                await click_first_match(page, FINAL_CONTINUE_SELECTORS)
                clicked_final = True
            except RuntimeError as e:
                print(f"  [!] {e}")
                return False

            if await wait_for_leave_signup(page, max_seconds=60):
                signup_done = True
            else:
                print("[!] never left /signup - account probably not created")
                return False

        # --------------------------------------------------------------
        step_header(9, TOTAL, "Post-final settle")
        # --------------------------------------------------------------
        if clicked_final:
            await wait_with_progress(
                page, POST_FINAL_WAIT_MS,
                "wait for account creation POST to finish",
            )
        else:
            print("  skipped (account already created during pre-final settle)")

        # --------------------------------------------------------------
        step_header(10, TOTAL, "Wallet capture + DB update")
        # --------------------------------------------------------------
        if await capture_wallet_apis(page, captured):
            print("  wallet API captured")
        else:
            print("  [!] no wallet API captured after 30s (with reload)")
            print(f"      current url: {page.url}")

        if captured:
            supabase.table("audius").update({
                "register":   "yes",
                "api_key":    captured["api_key"],
                "encoded_dm": captured["encoded_dm"],
                "encoded_ds": captured["encoded_ds"],
            }).eq("address", email).execute()
            print(f"  marked {email} register='yes' + wallet credentials")
        else:
            supabase.table("audius").update({
                "register": "yes",
            }).eq("address", email).execute()
            print(f"  marked {email} register='yes' (no wallet credentials)")

        print(f"    email    : {email}")
        print(f"    password : {password}")
        print(f"    handle   : {handle}")
        print(f"    image    : {image_path}")

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
        if page is not None and context is not None and browser is not None:
            await shutdown_browser(page, context, browser)

    if not signup_done:
        print(f"\n[!] Signup failed for {email} - left in DB as "
              f"register='no' for retry")

    return signup_done


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
async def main() -> None:
    url, key = load_supabase_creds()
    supabase = create_client(url, key)

    print("[*] Audius signup")
    async with async_playwright() as pw:
        ok = await run_signup(pw, supabase)

    print()
    if ok:
        print("[+] Signup finished successfully")
    else:
        print("[!] Signup failed - see log above")


if __name__ == "__main__":
    asyncio.run(main())