"""Builds the 3D fitting room's product textures from the catalogue photos.

For every garment photo in apps/web/public/garments/: tops (incl. dresses,
kurtas, outerwear) get a texture atlas (front panel, back panel, sleeve strip,
fabric tile — see app/tryon/texture.py), bottoms a tileable fabric swatch.
Written to apps/web/public/garments/tex/<slug>.png|.jpg + <slug>.json.

Categories come from the running API (GET /v1/garments).

    services/reconstruction/.venv/Scripts/python.exe scripts/make-garment-textures.py [slug ...]
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))

import cv2  # noqa: E402
import numpy as np  # noqa: E402

from app.tryon.garment import read  # noqa: E402
from app.tryon.texture import _hex, _plain, atlas  # noqa: E402

PHOTOS = ROOT / "apps" / "web" / "public" / "garments"
OUT = PHOTOS / "tex"
API = "http://127.0.0.1:3000/v1/garments?limit=200"


def fabric_swatch(img: np.ndarray, gar) -> tuple[np.ndarray, dict]:
    """A plain square of a trouser leg, mirror-tiled; and the waistband colour."""
    mask = gar.mask.copy()
    L = gar.y_hem - gar.y_top
    mask[: int(gar.y_top + 0.3 * L)] = 0  # below the pockets and fly
    dist = cv2.distanceTransform((mask > 0).astype(np.uint8), cv2.DIST_L2, 5)
    r = float(dist.max())
    yy, xx = np.unravel_index(int(np.argmax(dist)), dist.shape)
    half = int(max(8, min(r * 0.7, 0.12 * L)))
    patch = gar.image[yy - half: yy + half, xx - half: xx + half]
    if patch.size == 0:
        patch = np.full((32, 32, 3), gar.tone, np.uint8)
    tile = np.vstack([np.hstack([patch, patch[:, ::-1]]), np.hstack([patch[::-1], patch[::-1, ::-1]])])
    tone = np.median(gar.image[gar.mask > 0].reshape(-1, 3), axis=0)
    # The cloth's colour with its fine weave only: shading in the photo
    # would repeat as blotches all over the 3D trousers.
    tile = _plain(tone, 512, 512, tile, 512 / tile.shape[1])
    ys = int(gar.y_top + 0.02 * L)
    band = gar.image[max(0, ys - 3): ys + 3]
    bm = gar.mask[max(0, ys - 3): ys + 3] > 0
    waist = np.median(band[bm], axis=0) if bm.sum() > 10 else tone
    return tile, {"version": 1, "kind": "bottom", "tone": _hex(tone), "waistband": _hex(waist), "tileCm": 12.0}


def main(only: list[str]) -> None:
    with urllib.request.urlopen(API, timeout=10) as r:
        garments = json.load(r)
    OUT.mkdir(parents=True, exist_ok=True)
    done = failed = 0
    for g in garments:
        slug = g["slug"]
        if only and slug not in only:
            continue
        path = PHOTOS / f"{slug}.jpg"
        if not path.exists():
            continue
        img = cv2.imread(str(path))
        try:
            if g["category"] == "BOTTOMS":
                gar = read(img, "bottom")
                tile, meta = fabric_swatch(img, gar)
                cv2.imwrite(str(OUT / f"{slug}.jpg"), tile, [cv2.IMWRITE_JPEG_QUALITY, 88])
            else:
                gar = read(img, "top")
                tex, meta = atlas(gar)
                meta["kind"] = "top"
                cv2.imwrite(str(OUT / f"{slug}.jpg"), tex, [cv2.IMWRITE_JPEG_QUALITY, 90])
            (OUT / f"{slug}.json").write_text(json.dumps(meta, indent=1))
            done += 1
            print(f"  {slug:34s} {meta.get('pattern', meta['kind'])}")
        except Exception as e:  # one odd photo never stops the rest
            failed += 1
            print(f"  {slug:34s} FAILED: {e}")
    print(f"{done} textures, {failed} failed -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1:])
