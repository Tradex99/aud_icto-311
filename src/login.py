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
NAME_FILE       = ROOT_DIR / "name.txt"
TEMPMAIL_SCRIPT = SCRIPT_DIR / "tempmail.py"
IMG_SCRIPT      = SCRIPT_DIR / "img.py"

MAX_RUNS = 10
API_PATTERN = re.compile(
    r"https?://api\.audius\.co/(?:v1/)?users/[^/]+/(?:coins|connected_wallets)"
)

# --- Desktop Chrome UA pool (no file dependency) ---
DESKTOP_CHROME_UAS = [
    # Windows 10/11
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    # macOS (Intel)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    # Linux x86_64
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
]

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
    'img.harmony-70oscu',
    'div.harmony-3ptp8e',
    'img[src^="data:image"]',
    'img[src^="blob:"]',
    'button[aria-label="Upload a profile photo"]',
    'label:has(img)',
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
    return random.choice(DESKTOP_CHROME_UAS)


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
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raise RuntimeError(f"{script.name} exited {proc.returncode}: {stderr.decode().strip()}")
    return stdout.decode()


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


async def fill_first_match(page, selectors: list[str], value: str,
                           per_selector_timeout: int = 15_000,
                           label: str = "field") -> str:
    for sel in selectors:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="visible", timeout=per_selector_timeout)
            await loc.fill(value)
            print(f"   filled {label} via: {sel}")
            return sel
        except Exception:
            continue
    raise RuntimeError(f"Could not find input for {label}: {selectors}")


async def upload_profile_image(page, image_path: str) -> None:
    for sel in IMAGE_INPUT_SELECTORS:
        try:
            loc = page.locator(sel).first
            await loc.wait_for(state="attached", timeout=8_000)
            await loc.set_input_files(image_path)
            print(f"   uploaded image via input: {sel}")
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
            print(f"   uploaded image via click: {sel}")
            return
        except Exception:
            continue
    raise RuntimeError("Could not upload profile image via any selector")


async def wait_for_redirect(page, from_url: str, max_seconds: int = 20) -> bool:
    for i in range(max_seconds):
        if page.url != from_url:
            print(f"   -> redirected to {page.url} ({i + 1}s)")
            return True
        await page.wait_for_timeout(1000)
    print(f"   [!] no redirect after {max_seconds}s (still {page.url})")
    return False


async def wait_for_leave_signup(page, max_seconds: int = 60) -> bool:
    for i in range(max_seconds):
        if "/signup" not in page.url:
            print(f"   -> left /signup: {page.url} ({i + 1}s)")
            return True
        if i % 5 == 0 and i > 0:
            print(f"     [{i}s] still {page.url}")
        await page.wait_for_timeout(1000)
    print(f"   [!] still on /signup after {max_seconds}s: {page.url}")
    return False


def _shorten(value: str, head: int = 20, tail: int = 6) -> str:
    return f"{value[:head]}...{value[-tail:]}" if len(value) > head+tail+3 else value


def build_request_handler(captured: dict):
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
        enc_dm = hdrs.get("encoded-data-message")
        enc_ds = hdrs.get("encoded-data-signature")

        if api_key and enc_dm and enc_ds:
            captured.update({
                "api_key": api_key,
                "encoded_dm": enc_dm,
                "encoded_ds": enc_ds
            })
            print("[*] Wallet API credentials captured")
            print(f"    user_id          : {captured.get('user_id', 'Unknown')}")
            print(f"    api_key          : {api_key}")
            print(f"    Encoded-Data-Msg : {enc_dm}")
            print(f"    Encoded-Data-Sig : {_shorten(enc_ds)}")
    return handler


async def heartbeat_loop(supabase, address: str):
    while True:
        await asyncio.sleep(30)
        try:
            await asyncio.to_thread(
                supabase.rpc("ping_audius_account", {"p_address": address}).execute
            )
        except Exception:
            pass


# --------------------------------------------------------------------------
# Complete an incomplete signup wizard
# --------------------------------------------------------------------------
async def complete_incomplete_signup(page) -> bool:
    print("[*] Detected incomplete signup - completing wizard...")
    await page.wait_for_load_state("domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(2000)

    try:
        handle = generate_handle()
    except (FileNotFoundError, RuntimeError) as e:
        print(f"[!] {e}")
        return False
    print(f"  handle   : {handle}")

    if not IMG_SCRIPT.exists():
        print(f"[!] img.py not found at {IMG_SCRIPT}")
        return False
    try:
        img_out = (await run_py(IMG_SCRIPT)).strip()
        m = re.search(r"Image saved as:\s*(.+)", img_out)
        if not m:
            raise RuntimeError(f"Image path not found in img.py output: {img_out!r}")
        image_path = m.group(1).strip()
    except RuntimeError as e:
        print(f"[!] {e}")
        return False
    print(f"  image    : {image_path}")

    if "/signup/pick-handle" in page.url:
        print(f"  [handle] filling handle (current: {page.url})")
        try:
            await fill_first_match(page, ['input[aria-label="Handle"]', 'input[name="handle"]'], handle, label="handle")
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False
        except RuntimeError as e:
            print(f"  [!] {e}")
            return False
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)

    if "/signup/finish-profile" in page.url:
        print(f"  [profile] image + display name (current: {page.url})")
        try:
            await upload_profile_image(page, image_path)
            await fill_first_match(page, ['input[aria-label="Display Name"]', 'input[name="displayName"]'], handle, label="display name")
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False
        except RuntimeError as e:
            print(f"  [!] {e}")
            return False
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)

    if "/signup/select-genres" in page.url:
        print(f"  [genres] continuing (current: {page.url})")
        await page.wait_for_timeout(3000)
        try:
            url_before = page.url
            await click_first_match(page, CONTINUE_SELECTORS)
            if not await wait_for_redirect(page, url_before):
                return False
        except RuntimeError as e:
            print(f"  [!] {e}")
            return False
        await page.wait_for_load_state("domcontentloaded", timeout=60_000)

    if "/signup/select-artists" in page.url:
        print(f"  [artists] continuing (current: {page.url})")
        await page.wait_for_timeout(3000)
        try:
            await click_first_match(page, CONTINUE_SELECTORS)
        except RuntimeError as e:
            print(f"  [!] {e}")
            return False
        await page.wait_for_timeout(2000)

    print(f"  [final] waiting for auto-redirect (current: {page.url})")
    if not await wait_for_leave_signup(page, max_seconds=60):
        return False

    print(f"  [done] signed in: {page.url}")
    return True


# --------------------------------------------------------------------------
# Main worker
# --------------------------------------------------------------------------
async def run_one(pw, supabase, tried: set[str]) -> tuple[bool, str | None]:
    account = rpc.claim("login")
    while account and account["address"] in tried:
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
            await page.wait_for_url(
                "https://audius.co/signin/confirm-email",
                wait_until="load", timeout=60_000,
            )
            await page.wait_for_timeout(2000)
        except Exception:
            pass

        try:
            stdout = await run_tempmail_inbox(address)
            m = re.search(r"\d{3}\s\d{3}", stdout)
            if not m:
                raise RuntimeError(f"OTP not found: {stdout!r}")
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

        for _ in range(60):
            if "/feed" in page.url or "/signup" in page.url:
                break
            await page.wait_for_timeout(1000)

        if "/signup/pick-handle" in page.url:
            print(f"[*] Detected incomplete signup at {page.url}")
            if not await complete_incomplete_signup(page):
                print("[!] Failed to complete signup wizard")
                return False, address
            if "/feed" not in page.url:
                print(f"[!] Wizard completed but not on /feed: {page.url}")
                return False, address
            print("[+] Wizard completed - now on /feed")
            await page.wait_for_timeout(2000)
        elif "/signup" in page.url:
            print(f"[!] Unexpected signup URL: {page.url}")
            return False, address
        elif "/feed" in page.url:
            print("[+] Login success - feed loaded")
        else:
            print("[!] Unexpected URL:", page.url)
            return False, address

        # --- Wallet capture ---
        print("[*] Opening https://audius.co/wallet ...")
        await page.goto("https://audius.co/wallet", wait_until="domcontentloaded", timeout=60_000)

        for _ in range(60):
            if captured.get("api_key"):
                break
            await page.wait_for_timeout(500)

        # --- Extract Handle from DOM (wait up to 20s) ---
        print("[*] Extracting handle from wallet page ...")
        try:
            handle_locator = page.locator('a[data-discover="true"]').filter(has_text="@").first
            await handle_locator.wait_for(state="visible", timeout=20_000)
            text = await handle_locator.inner_text()
            captured["handle"] = text.replace("@", "").strip()
            print(f"[*] Extracted handle: {captured['handle']}")
        except Exception as e:
            print(f"[!] Could not extract handle after 20s: {e}")

        # --- Save to DB ---
        if captured.get("api_key"):
            update_payload = {
                "api_key": captured["api_key"],
                "encoded_dm": captured["encoded_dm"],
                "encoded_ds": captured["encoded_ds"],
            }
            if "user_id" in captured:
                update_payload["user_id"] = captured["user_id"]
            if "handle" in captured:
                update_payload["handle"] = captured["handle"]

            supabase.table("audius").update(update_payload).eq("address", address).execute()
            print("[+] Saved all credentials to DB")
            success = True
        else:
            print("[!] No target API captured within 30 s")

    except Exception as e:
        print("[!] Fatal:", e)
    finally:
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