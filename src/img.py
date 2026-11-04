#!/usr/bin/env python3
"""
img.py - download a single random profile image from picsum.photos.

- random square-ish dimensions per run
- /seed/<uuid>/ endpoint so each call returns a different picture
- random browser User-Agent on the request
- unique filename (timestamp + uuid suffix) so two runs in the same
  second still produce two files
- 3-attempt retry with timeout

Prints: Image saved as: <relative path>
"""

import os
import random
import sys
import uuid
from datetime import datetime

import requests


# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
# Profile-friendly sizes: squares are the safest for Audius avatars, plus a
# few portrait / landscape alternatives for variety.
SIZES = [
    (400, 400),
    (450, 450),
    (500, 500),
    (512, 512),
    (600, 600),
    (640, 640),
    (720, 720),
    (800, 800),
    (900, 900),
    (1024, 1024),
    (512, 640),
    (640, 512),
    (600, 800),
    (800, 600),
]

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
]

MAX_ATTEMPTS = 3
TIMEOUT_SECONDS = 30


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
def main() -> int:
    os.makedirs("images", exist_ok=True)

    width, height = random.choice(SIZES)

    # A fresh seed per run -> picsum serves a different photo each time.
    # (The bare /W/H path is CDN-cached and can repeat back-to-back.)
    seed = uuid.uuid4().hex

    url = f"https://picsum.photos/seed/{seed}/{width}/{height}"

    # Unique filename: timestamp + short uuid, so two runs in the same
    # second never collide.
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"images/image_{stamp}_{uuid.uuid4().hex[:8]}.png"

    headers = {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

    last_error = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            response = requests.get(
                url, headers=headers, timeout=TIMEOUT_SECONDS
            )
            response.raise_for_status()

            if not response.content:
                raise RuntimeError("empty response body")

            with open(filename, "wb") as f:
                f.write(response.content)

            print(f"Image saved as: {filename}")
            return 0

        except Exception as e:
            last_error = e
            print(
                f"[!] Attempt {attempt}/{MAX_ATTEMPTS} failed: {e}",
                file=sys.stderr,
            )

    print(f"[!] All {MAX_ATTEMPTS} attempts failed: {last_error}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())