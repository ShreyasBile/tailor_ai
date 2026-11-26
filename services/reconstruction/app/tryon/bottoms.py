"""Try-on for trousers, shorts and skirts.

Trousers are matched to the legs row by row: the product's waistband to the
body's waistband, its crotch to the body's crotch, each product leg to each
body leg — and lit by the folds of whatever the shopper is wearing in the
photo (dark jeans included: the fold pattern is relative, so it survives).

Shorts end above the knee; below them the legs are drawn bare (skin tone
learnt from the shopper's own arms). Skirts are one panel from the waist,
flaring as the product does.

Fit by size: a smaller size pulls the legs in towards the body and adds
strain across the hips; a bigger one stands away and hangs in folds.
"""

from __future__ import annotations

import cv2
import numpy as np

from ..scan import pose as P
from .fit import FitGeometry
from .garment import Garment
from .parse import Parsed


def _runs(line: np.ndarray, min_len: int = 6):
    d = np.diff(np.concatenate([[0], line.astype(np.int8), [0]]))
    rr = list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0] - 1, strict=True))
    return [r for r in rr if r[1] - r[0] >= min_len]


def _skin_tone(p: Parsed) -> np.ndarray:
    pix = [p.image[a.skin > 0] for a in p.arms if (a.skin > 0).sum() > 50]
    if not pix:
        return np.array([120, 150, 190], np.float32)
    allp = np.concatenate(pix).astype(np.float32)
    lum = allp.mean(axis=1)
    keep = (lum > np.percentile(lum, 30)) & (lum < np.percentile(lum, 90))
    return np.median(allp[keep], axis=0)


def kind_of(slug: str, subcategory: str, name: str) -> str:
    text = f"{slug} {subcategory} {name}".lower()
    if "skirt" in text:
        return "skirt"
    if "short" in text:
        return "shorts"
    return "trousers"


def _leg_rows(p: Parsed, y0: int, y1: int):
    """Per row: the trouser runs (1 above the crotch, 2 below)."""
    rows = {}
    for y in range(max(y0, 0), min(y1, p.image.shape[0] - 1)):
        rr = _runs(p._pants[y] > 0)
        if rr:
            rows[y] = rr
    return rows


def _smooth_legs(rows: dict, crotch: float) -> dict:
    """A clean leg outline from noisy per-row runs (hands, watch and shadows
    cut into them): outer edges and, below the crotch, the inner edges,
    median-filtered down the leg."""
    from scipy.ndimage import median_filter

    ys = np.array(sorted(rows))
    L = np.array([rows[y][0][0] for y in ys], np.float64)
    R = np.array([rows[y][-1][1] for y in ys], np.float64)
    IL = np.array([rows[y][0][1] if len(rows[y]) >= 2 and y > crotch else np.nan for y in ys])
    IR = np.array([rows[y][-1][0] if len(rows[y]) >= 2 and y > crotch else np.nan for y in ys])
    L = median_filter(L, size=21, mode="nearest")
    R = median_filter(R, size=21, mode="nearest")
    out = {}
    ok = ~np.isnan(IL)
    if ok.sum() > 5:
        IL = median_filter(np.interp(ys, ys[ok], IL[ok]), size=21, mode="nearest")
        IR = median_filter(np.interp(ys, ys[ok], IR[ok]), size=21, mode="nearest")
    for i, y in enumerate(ys):
        if y > crotch and ok.sum() > 5 and IL[i] - L[i] > 4 and R[i] - IR[i] > 4 and IR[i] > IL[i]:
            out[int(y)] = [(int(L[i]), int(IL[i])), (int(IR[i]), int(R[i]))]
        else:
            out[int(y)] = [(int(L[i]), int(R[i]))]
    return out


def _crotch_y(p: Parsed, rows: dict) -> float:
    for y in sorted(rows):
        if len(rows[y]) >= 2 and y > p.hip_y:
            return float(y)
    knee = (p.lm[P.L_KNEE, 1] + p.lm[P.R_KNEE, 1]) / 2
    return float(p.hip_y + 0.35 * (knee - p.hip_y))


def _bare_legs(p: Parsed, canvas: np.ndarray, from_y: float) -> None:
    """Skin legs from `from_y` down to the shoes, in place of trousers."""
    h, w = canvas.shape[:2]
    cm = p.cm_per_px
    tone = _skin_tone(p)
    shoes_top = np.nonzero(p.shoes.any(axis=1))[0]
    stop_y = float(shoes_top[0]) + 4 if len(shoes_top) else float(h - 1)
    # Clear the old trousers below the hem first.
    old = (p.person > 0) & (p.skin == 0) & (p.shoes == 0) & (np.arange(h)[:, None] >= from_y - 1) &         (np.arange(h)[:, None] < stop_y)
    old = cv2.dilate(old.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    canvas[old] = p.background[old]
    for hip_i, knee_i, ankle_i in ((P.L_HIP, P.L_KNEE, P.L_ANKLE), (P.R_HIP, P.R_KNEE, P.R_ANKLE)):
        pts = [p.lm[hip_i, :2], p.lm[knee_i, :2], p.lm[ankle_i, :2]]
        radii = [8.2 / cm, 5.4 / cm, 3.9 / cm]  # thigh, knee, ankle half-widths
        Y = np.arange(int(from_y), int(stop_y))
        if len(Y) == 0:
            continue
        ys = np.array([pts[0][1], pts[1][1], pts[2][1] + 0.02 * p.height_px])
        xs = np.array([pts[0][0], pts[1][0], pts[2][0]])
        rs = np.array(radii)
        cx = np.interp(Y, ys, xs)
        r = np.interp(Y, ys, rs)
        # a calf bulge below the knee
        r = r * (1 + 0.12 * np.exp(-(((Y - (ys[1] + 0.3 * (ys[2] - ys[1]))) / (0.12 * (ys[2] - ys[1]) + 1)) ** 2)))
        for y, c, rad in zip(Y, cx, r, strict=True):
            x0, x1 = int(np.floor(c - rad)), int(np.ceil(c + rad))
            if x1 <= x0 or y >= h:
                continue
            xx = np.arange(max(x0, 0), min(x1 + 1, w))
            u = (xx - c) / max(rad, 1.0)
            inside = np.clip(1.0 - np.abs(u), 0, 1)
            shade = 0.68 + 0.32 * np.sqrt(np.clip(1 - (u - 0.15) ** 2, 0, 1))
            knee_d = abs(y - ys[1]) / max(0.05 * p.height_px, 1)
            shade *= 1 - 0.08 * np.exp(-knee_d ** 2)
            if y < from_y + 6:  # the hem's shadow
                shade *= 0.75 + 0.25 * (y - from_y) / 6
            col = tone[None, :] * shade[:, None]
            a = np.clip(inside * rad / 1.5, 0, 1)[:, None]
            cur = canvas[y, xx].astype(np.float32)
            canvas[y, xx] = np.clip(cur * (1 - a) + col * a, 0, 255).astype(np.uint8)


def _pants_mask(p: Parsed) -> np.ndarray:
    """The trousers in the photo, including the bits beside the hands that
    the parse files under "hand zone" (everything below the top that isn't
    skin, shoes or head)."""
    h = p.image.shape[0]
    m = (p.person > 0) & (p.top == 0) & (p.skin == 0) & (p.shoes == 0) & (p.head == 0)
    m &= np.arange(h)[:, None] >= p.hem_y - 2
    m = cv2.morphologyEx(m.astype(np.uint8) * 255, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    return m


def render_bottoms(p: Parsed, g: FitGeometry, gar: Garment, kind: str, patch: np.ndarray, k: float):
    """Returns the re-dressed canvas (full working image)."""
    h, w = p.image.shape[:2]
    canvas = p.image.copy()
    pants = _pants_mask(p)
    # Clear the old trousers first (a little generously: their anti-aliased
    # edge isn't in the matte), so narrower legs leave wall, not a halo.
    clear = cv2.dilate(pants, np.ones((5, 5), np.uint8)) > 0
    clear &= (p.skin == 0) & (p.shoes == 0) & (p.top == 0)
    canvas[clear] = p.background[clear]
    knee = (p.lm[P.L_KNEE, 1] + p.lm[P.R_KNEE, 1]) / 2
    p._pants = pants
    rows_all = _leg_rows(p, p.hem_y - 2, h)
    if not rows_all:
        raise ValueError("couldn't find your trousers in the photo")
    bottom_y = float(max(rows_all))
    crotch = _crotch_y(p, rows_all)
    wb = float(p.waistband_y)
    rows_all = _smooth_legs(rows_all, crotch)

    # Product geometry.
    y_top, y_hem, y_cr = gar.y_top, gar.y_hem, gar.y_shoulder  # y_shoulder holds the crotch for bottoms
    gmask = gar.mask > 0

    if kind == "skirt":
        length = (y_hem - y_top) / max(2 * gar.body_half, 1)
        hip_w = np.median([r[-1][1] - r[0][0] for y, r in rows_all.items() if y < crotch]) if rows_all else 200
        hem_target = wb + length * hip_w * 0.95 + g.length_cm / p.cm_per_px
        target_bottom = min(hem_target, bottom_y)
    elif kind == "shorts":
        target_bottom = min(knee - 0.03 * p.height_px + 1.2 * g.inseam_cm / p.cm_per_px, bottom_y)
    else:
        target_bottom = bottom_y + 0.6 * g.inseam_cm / p.cm_per_px
        target_bottom = min(target_bottom, h - 1)

    if kind in ("shorts", "skirt"):
        _bare_legs(p, canvas, target_bottom - 2)

    # Ease: a smaller size pulls each leg in, a bigger one lets it out (px per side).
    ease_px = float(np.clip(0.14 * g.leg_ease / p.cm_per_px, -0.35 * 8 / p.cm_per_px, 6 / p.cm_per_px))

    Y = np.arange(int(wb), int(np.ceil(target_bottom)) + 1)
    X = np.arange(w, dtype=np.float32)
    map_x = np.zeros((len(Y), w), np.float32)
    map_y = np.zeros((len(Y), w), np.float32)
    alpha = np.zeros((len(Y), w), np.float32)
    shade_src_x = np.zeros((len(Y), w), np.float32)
    shade_src_y = np.zeros((len(Y), w), np.float32)
    ref_rows = sorted(rows_all)
    for i, y in enumerate(Y):
        # Source row in the photo (for the outline): clamp into the visible trousers.
        sy = int(np.clip(y, ref_rows[0], ref_rows[-1]))
        rr = rows_all.get(sy) or rows_all[ref_rows[min(np.searchsorted(ref_rows, sy), len(ref_rows) - 1)]]
        # product row
        if kind == "skirt":
            yp = y_top + (y - wb) / max(target_bottom - wb, 1) * (y_hem - y_top)
        elif y < crotch:
            yp = y_top + (y - wb) / max(crotch - wb, 1) * (y_cr - y_top)
        else:
            yp = y_cr + (y - crotch) / max(target_bottom - crotch, 1) * (y_hem - y_cr)
        yp = float(np.clip(yp, y_top, y_hem - 1))
        prr = _runs(gmask[int(yp)], 3)
        if not prr:
            continue
        if kind == "skirt":
            # one panel, as wide as the product says relative to its waist
            pw0 = (prr[-1][1] - prr[0][0]) / max(2 * gar.body_half, 1)
            body = (rr[0][0], rr[-1][1]) if y < crotch else (rr[0][0], rr[-1][1])
            c = (body[0] + body[1]) / 2
            half = max((body[1] - body[0]) / 2, pw0 * (rr[-1][1] - rr[0][0]) / 2 * 0.5) + max(ease_px, 0)
            half = max(half, pw0 * np.median([r[-1][1] - r[0][0] for r in rows_all.values()]) / 2)
            targets = [(c - half, c + half, prr[0][0], prr[-1][1])]
        else:
            # pair person runs with product runs (1↔1 above the crotch, legs below)
            if len(rr) >= 2 and len(prr) >= 2:
                pairs = [(rr[0], prr[0]), (rr[-1], prr[-1])]
            elif len(rr) >= 2:
                mid = (prr[0][0] + prr[0][1]) / 2
                pairs = [(rr[0], (prr[0][0], mid)), (rr[-1], (mid, prr[0][1]))]
            elif len(prr) >= 2:
                mid = (rr[0][0] + rr[0][1]) / 2
                pairs = [((rr[0][0], mid), prr[0]), ((mid, rr[0][1]), prr[-1])]
            else:
                pairs = [(rr[0], prr[0])]
            targets = []
            n = len(pairs)
            for j, (a, b) in enumerate(pairs):
                # Ease on the outer sides only (the inseam stays put).
                lo = a[0] - (ease_px if j == 0 else 0)
                hi = a[1] + (ease_px if j == n - 1 else 0)
                targets.append((lo, hi, b[0], b[1]))
        for lo, hi, plo, phi in targets:
            sel = (X >= lo - 0.5) & (X <= hi + 0.5)
            u = (X[sel] - lo) / max(hi - lo, 1.0)
            map_x[i, sel] = plo + u * (phi - plo)
            map_y[i, sel] = yp
            alpha[i, sel] = np.clip(np.minimum(X[sel] - lo, hi - X[sel]) + 0.5, 0, 1)
            # shading from the photo's own trousers at the matching place
            src_lo, src_hi = (rr[0][0], rr[-1][1]) if kind == "skirt" else (lo + (ease_px if lo < rr[0][0] else 0), hi)
            shade_src_x[i, sel] = np.clip(X[sel], src_lo, src_hi)
            shade_src_y[i, sel] = sy
    alpha *= np.clip(target_bottom - Y[:, None] + 0.5, 0, 1)

    albedo = cv2.remap(gar.image, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
    inside = cv2.remap(gmask.astype(np.float32), map_x, map_y, cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    # Where the product run and the leg run disagree in shape, fall back to
    # plain cloth rather than background.
    tile_x = np.mod(np.repeat(X[None, :], len(Y), 0) * k, patch.shape[1]).astype(np.float32)
    tile_y = np.mod(np.repeat(Y[:, None].astype(np.float32), w, 1) * k, patch.shape[0]).astype(np.float32)
    cloth = cv2.remap(patch, tile_x, tile_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP).astype(np.float32)
    inside = np.clip(inside, 0, 1)[..., None]
    albedo = albedo * inside + cloth * (1 - inside)

    # The photo's own fold pattern (relative: works on black jeans too).
    gray = cv2.cvtColor(p.image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    m = (pants > 0).astype(np.float32)
    sig = 0.02 * h
    smooth = cv2.GaussianBlur(gray * m, (0, 0), sig) / np.maximum(cv2.GaussianBlur(m, (0, 0), sig), 1e-3)
    fine = cv2.GaussianBlur(gray, (0, 0), 1.2)
    ratio = np.clip(fine / np.maximum(smooth, 4.0), 0.55, 1.6) ** 0.7
    sh = cv2.remap(ratio.astype(np.float32), shade_src_x, shade_src_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    # cylindrical light across each leg
    panel = np.clip(albedo * sh[..., None] * 0.97, 0, 255)

    y0 = int(Y[0])
    hh = len(Y)
    sub = canvas[y0: y0 + hh]
    a = alpha[..., None]
    canvas[y0: y0 + hh] = (sub.astype(np.float32) * (1 - a) + panel * a).astype(np.uint8)

    # The top, hands and shoes stay in front.
    front = (p.top > 0) | (p.skin > 0) | (p.head > 0)
    shoes = p.shoes > 0
    canvas[front] = p.image[front]
    if kind != "skirt" or target_bottom < np.nonzero(p.shoes.any(axis=1))[0][0]:
        canvas[shoes] = p.image[shoes]
    return canvas, float(target_bottom), crotch
