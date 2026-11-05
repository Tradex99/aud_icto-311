#!/usr/bin/env python3
"""
login.py - Audius login + developer app creation + localStorage capture.
"""

import asyncio
import json
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

# --- Desktop Chrome UA pool ---
DESKTOP_CHROME_UAS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
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
    'img.harmony-70oscu', 'div.harmony-3ptp8e',
    'img[src^="data:image"]', 'img[src^="blob:"]',
    'button[aria-label="Upload a profile photo"]', 'label:has(img)',
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
# Developer Settings & App Creation
# --------------------------------------------------------------------------
async def create_app_and_extract_credentials(page, captured: dict) -> dict:
    """Navigates settings -> Manage apps -> Create app -> extracts credentials via network."""
    print("[*] Navigating to settings...")
    await page.goto("https://audius.co/settings", wait_until="domcontentloaded", timeout=60_000)
    await page.wait_for_timeout(3000)

    # Click "Manage your apps"
    manage_apps_xpath = "/html/body/div[1]/div[1]/div[2]/div[3]/div/div[2]/div/div[1]/div[15]/button"
    print("  -> clicking 'Manage your apps'")
    await page.locator(f"xpath={manage_apps_xpath}").click()
    await page.wait_for_timeout(2000)

    # Click "New"
    new_btn_xpath = "/html/body/div[5]/div/div/div/div[2]/div/div/div[1]/div/div/div/div/button"
    print("  -> clicking 'New'")
    await page.locator(f"xpath={new_btn_xpath}").click()
    await page.wait_for_timeout(2000)

    app_name = generate_handle()

    # Fill App Name
    print(f"  -> filling app name: {app_name}")
    await page.fill('input[aria-label="App Name"]', app_name)

    # Wait for "Create key" button to be ready
    create_key_xpath = "/html/body/div[5]/div/div/div/div[2]/div/div/div[1]/div/form/div[4]/button[2]"
    print("  -> waiting for 'Create key' button")
    await page.locator(f"xpath={create_key_xpath}").wait_for(state="visible", timeout=15_000)

    # Setup network interception listeners *before* clicking Create Key
    def on_request(request):
        # 1. Extract API Key & Secret from register-api-key
        if "/register-api-key" in request.url:
            m = re.search(r"/developer-apps/0x([a-fA-F0-9]+)/register-api-key", request.url)
            if m:
                captured["app_api_key"] = m.group(1)
                print(f"  -> [NETWORK] Captured app_api_key: {captured['app_api_key']}")

            if request.post_data:
                try:
                    body = json.loads(request.post_data)
                    if "api_secret" in body:
                        captured["app_api_secret"] = body["api_secret"]
                        print(f"  -> [NETWORK] Captured app_api_secret: {_shorten(captured['app_api_secret'])}")
                except Exception:
                    pass

    async def on_response(response):
        # 2. Extract Bearer Token from access-keys
        if "/access-keys" in response.url:
            try:
                data = await response.json()
                if "api_access_key" in data:
                    captured["app_bearer_token"] = data["api_access_key"]
                    print(f"  -> [NETWORK] Captured app_bearer_token: {_shorten(captured['app_bearer_token'])}")
            except Exception:
                pass

    page.on("request", on_request)
    page.on("response", on_response)

    # Click "Create key"
    print("  -> clicking 'Create key'")
    await page.locator(f"xpath={create_key_xpath}").click()

    # Wait for the network requests to populate the captured data
    print("  -> waiting for network requests to finish...")
    for _ in range(30):  # up to 15 seconds
        if all(k in captured for k in ("app_api_key", "app_api_secret", "app_bearer_token")):
            break
        await page.wait_for_timeout(500)

    return {
        "api_key": captured.get("app_api_key", ""),
        "api_secret": captured.get("app_api_secret", ""),
        "bearer_token": captured.get("app_bearer_token", "")
    }


async def extract_local_storage(page) -> dict:
    """Returns all localStorage data as a dictionary."""
    print("[*] Extracting localStorage...")
    try:
        raw = await page.evaluate("() => JSON.stringify(localStorage)")
        data = json.loads(raw) if raw else {}
        print(f"  -> extracted {len(data)} localStorage keys")
        return data
    except Exception as e:
        print(f"[!] Failed to extract localStorage: {e}")
        return {}


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

        # --- Developer App Creation & Credentials (via Network) ---
        app_data = await create_app_and_extract_credentials(page, captured)

        # --- Validate Credentials ---
        if not (app_data.get("api_key") and app_data.get("api_secret") and app_data.get("bearer_token")):
            print("[!] Missing one or more app credentials (api_key, api_secret, bearer_token).")
            print("[!] Skipping database update and releasing account.")
            return False, address

        # --- Local Storage Extraction ---
        local_db = await extract_local_storage(page)

        # --- Save to DB ---
        update_payload = {
            "app_data": app_data,
            "local_db": local_db
        }

        supabase.table("audius").update(update_payload).eq("address", address).execute()
        print("[+] Saved app_data and local_db to DB")
        success = True

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