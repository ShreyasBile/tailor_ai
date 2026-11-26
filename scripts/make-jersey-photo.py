"""Make the product photo for the Sky Stripe Football Jersey, locally.

Re-dyes the Essential Tee's flat-lay into a sky-blue and white striped
football jersey with black trims, keeping the photo's own folds and light —
the same albedo/shading split the try-on uses. No generative model, no
third-party photography, no team crest or brand marks.

    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\make-jersey-photo.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))

from app.tryon.garment import garment_mask  # noqa: E402

SRC = ROOT / "apps" / "web" / "public" / "garments" / "northline-essential-tee.jpg"
OUT = ROOT / "apps" / "web" / "public" / "garments" / "stride-football-jersey.jpg"

SKY = np.array([219, 178, 116], np.float32)  # BGR — Pantone-ish sky blue
WHITE = np.array([246, 246, 244], np.float32)
BLACK = np.array([38, 36, 34], np.float32)


def main() -> None:
    img = cv2.imread(str(SRC))
    mask = garment_mask(img) > 0
    h, w = mask.shape
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0]
    lit = np.percentile(L[mask], 90)
    shade = np.clip(L / lit, 0.45, 1.1)
    shade = cv2.GaussianBlur(shade, (0, 0), 1.0)

    ys, xs = np.nonzero(mask)
    cx = float(np.median(xs))
    top, bot = ys.min(), ys.max()
    # Body width from the lower half (sleeves stick out above).
    lower = ys > top + 0.55 * (bot - top)
    body_w = float(np.percentile(xs[lower], 98) - np.percentile(xs[lower], 2))

    X = np.arange(w)[None, :].repeat(h, 0).astype(np.float32)
    Y = np.arange(h)[:, None].repeat(w, 1).astype(np.float32)
    # Five-stripe front: sky / white / sky (centre) / white / sky, softly edged.
    stripe_w = body_w / 7.0
    phase = (X - cx) / stripe_w
    sky = 0.5 + 0.5 * np.cos(phase * np.pi * 2 / 2.0)  # 1 at the centre, period 2 stripes
    sky = np.clip((sky - 0.5) * 6 + 0.5, 0, 1)
    albedo = WHITE * (1 - sky[..., None]) + SKY * sky[..., None]

    # Black collar band: a ring just inside the neckline.
    neck = (~mask).astype(np.uint8)
    neck[: top + 2, :] = 0  # only the opening, not the backdrop above
    n, lbl, stats, _ = cv2.connectedComponentsWithStats(((~mask) & (Y < top + 0.25 * (bot - top)) & (np.abs(X - cx) < body_w * 0.3)).astype(np.uint8), 8)
    ring = np.zeros((h, w), bool)
    for i in range(1, n):
        x, y, ww, hh, area = stats[i]
        if y > top - 2 and ww < body_w * 0.6:
            hole = (lbl == i).astype(np.uint8) * 255
            ring |= (cv2.dilate(hole, np.ones((17, 17), np.uint8)) > 0) & mask
    # Top edge of the garment around the collar also gets the band.
    col_top = np.zeros((h, w), bool)
    for x in range(int(cx - body_w * 0.22), int(cx + body_w * 0.22)):
        r = np.nonzero(mask[:, x])[0]
        if len(r):
            col_top[r[0]: r[0] + 12, x] = True
    ring |= col_top & mask
    albedo[ring] = BLACK

    # Sleeve cuffs: a black band with a sky edge, across each sleeve's end
    # (perpendicular to the sleeve's own axis).
    sleeves = mask & ((X < cx - body_w * 0.52) | (X > cx + body_w * 0.52)) & (Y < top + 0.5 * (bot - top))
    for side in (-1, 1):
        sm = sleeves & ((X < cx) if side < 0 else (X > cx))
        sy, sx = np.nonzero(sm)
        if len(sx) < 50:
            continue
        c = np.array([sx.mean(), sy.mean()])
        # The opening of a flat-laid sleeve is its outer, lower edge.
        ax = np.array([side * 1.0, 0.9]) / np.hypot(1.0, 0.9)
        proj = (X - c[0]) * ax[0] + (Y - c[1]) * ax[1]
        pmax = float(proj[sm].max())
        dist = cv2.distanceTransform(mask.astype(np.uint8), cv2.DIST_L2, 5)
        outer = sm & (proj > 0.15 * pmax)
        albedo[outer & (dist < 16)] = BLACK
        albedo[outer & (dist >= 16) & (dist < 22)] = SKY

    out = img.astype(np.float32).copy()
    jersey = np.clip(albedo * shade[..., None], 0, 255)
    soft = cv2.GaussianBlur(mask.astype(np.float32), (0, 0), 1.0)[..., None]
    out = out * (1 - soft) + jersey * soft
    cv2.imwrite(str(OUT), out.astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
