"""Product photos for the catalogue, made with Gemini from each garment's own
description (type, colour, material, cut) — no third-party photography, so
nothing to license.

Writes apps/web/public/garments/<slug>.jpg (900 px JPEG). Existing files are
kept; delete one to regenerate it. Then `npm run db:seed` links them.

    $env:GEMINI_API_KEY="..."   # or have it in .env
    services/reconstruction/.venv/Scripts/python.exe scripts/make-product-photos.py
"""

from __future__ import annotations

import io
import os
import re
import sys
import time
from pathlib import Path

import httpx
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))
sys.stdout.reconfigure(encoding="utf-8")

env = (ROOT / ".env").read_text(encoding="utf-8") if (ROOT / ".env").exists() else ""
if not os.getenv("GEMINI_API_KEY"):
    m = re.search(r"^GEMINI_API_KEY=(\S+)", env, re.M)
    if m:
        os.environ["GEMINI_API_KEY"] = m.group(1)
port = (re.search(r"^API_PORT=(\d+)", env, re.M) or [None, "3000"])[1]
API = os.getenv("TAILORAI_API", f"http://127.0.0.1:{port}/v1")

from app.llm import gemini  # noqa: E402

OUT = ROOT / "apps" / "web" / "public" / "garments"


def main() -> None:
    if not gemini.enabled():
        sys.exit("GEMINI_API_KEY is not set (in the environment or .env).")
    OUT.mkdir(parents=True, exist_ok=True)
    garments = httpx.get(f"{API}/garments", timeout=30).raise_for_status().json()
    made = 0
    for g in garments:
        path = OUT / f"{g['slug']}.jpg"
        if path.exists():
            continue
        detail = httpx.get(f"{API}/garments/{g['slug']}", timeout=30).raise_for_status().json()
        t = time.perf_counter()
        out = None
        for _attempt in range(3):
            out = gemini.product_photo(detail)
            if out:
                break
            time.sleep(5)
        if not out:
            print(f"  ✘ {g['slug']}: failed")
            continue
        img = Image.open(io.BytesIO(out[0])).convert("RGB")
        img.thumbnail((900, 900))
        img.save(path, format="JPEG", quality=85, optimize=True)
        made += 1
        print(f"  ✔ {g['slug']}  ({time.perf_counter() - t:.1f}s, {path.stat().st_size // 1024} KB)")
    print(f"{made} made, {len(garments) - made} already present or failed → {OUT}")


if __name__ == "__main__":
    main()
