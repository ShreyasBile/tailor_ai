"""Product textures for the 3D fitting room.

The catalogue photo of a garment, unwrapped the way a pattern cutter would
lay it out, so the 3D garment can wear the real product's cloth:

* front panel — the torso from collar to hem, each row stretched to the
  panel's width (its print, placket, crest, stripes);
* back panel — the photo has no back, so it is made from the front: vertical
  stripes and hoops carry round, a crest or buttons do not;
* sleeve strip — the cloth as a sleeve, root → cuff: hoops run round it,
  a striped body gets plain sleeves in its main colour, and a cuff of a
  different colour gets its band at the end;
* fabric — a plain tile of the cloth, for anything else.

Atlas (1024 x 1024, image rows top-down):

    rows   0-767   | front panel (cols 0-511) | back panel (cols 512-1023) |
    rows 768-1023  | sleeve strip (0-511)     | fabric tile (512-1023)     |

Panels run collar (row 0) → hem (row 767). The front panel is drawn as seen
from the front (the wearer's right on the left); the back panel as seen from
behind (the wearer's left on the left), so going round the body the two meet
at the side seams.
"""

from __future__ import annotations

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d

from .garment import Garment
from .product import fabric_patch

SIZE = 1024
PANEL_H = 768
PANEL_W = 512


def _hex(bgr) -> str:
    b, g, r = (int(round(float(c))) for c in bgr)
    return f"#{r:02x}{g:02x}{b:02x}"


def _fill_outside(img: np.ndarray, valid: np.ndarray) -> np.ndarray:
    """Pixels outside the garment take the colour of the nearest garment pixel
    (down-sampled inpaint: smooth, and fast on a whole panel)."""
    if valid.all():
        return img
    small = cv2.resize(img, (img.shape[1] // 4, img.shape[0] // 4), interpolation=cv2.INTER_AREA)
    vs = cv2.resize(valid.astype(np.uint8) * 255, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_AREA) > 200
    filled = cv2.inpaint(small, (~vs).astype(np.uint8) * 255, 5, cv2.INPAINT_TELEA)
    up = cv2.resize(filled, (img.shape[1], img.shape[0]), interpolation=cv2.INTER_LINEAR)
    out = img.copy()
    out[~valid] = up[~valid]
    return out


def _front_panel(gar: Garment) -> tuple[np.ndarray, np.ndarray]:
    """Collar → hem, each row of the torso stretched across the panel."""
    img = gar.image
    t = (np.arange(PANEL_H, dtype=np.float32) + 0.5) / PANEL_H
    ys = gar.y_top + t * (gar.y_hem - gar.y_top)
    # Above the shoulder line the outline narrows to the collar: use the
    # shoulders' width there, so the collar keeps its own size. Near the hem,
    # the width just above its rounded corners (or outer stripes would bow).
    x0, x1 = gar.edges(np.clip(ys, gar.y_shoulder, gar.y_top + 0.88 * (gar.y_hem - gar.y_top)))
    # The outline steps in where the sleeves join; unwrapped as-is, stripes
    # and plackets would jog sideways there. A smooth outline keeps them true.
    sig = 0.06 * PANEL_H
    x0 = gaussian_filter1d(x0, sig, mode="nearest")
    x1 = gaussian_filter1d(x1, sig, mode="nearest")
    # A sliver in from each side: the outline itself is edge pixels.
    s = 0.015 + 0.97 * (np.arange(PANEL_W, dtype=np.float32) + 0.5) / PANEL_W
    map_x = (x0[:, None] + s[None, :] * (x1 - x0)[:, None]).astype(np.float32)
    map_y = np.repeat(ys[:, None], PANEL_W, axis=1).astype(np.float32)
    panel = cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    valid = cv2.remap(gar.mask, map_x, map_y, cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT) > 0
    return panel, valid


def _fill_top_down(img: np.ndarray, valid: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Over the sloping shoulders the panel's top corners are background: give
    each column the colour of its first garment row, so stripes run on up."""
    out, ok = img.copy(), valid.copy()
    first = np.argmax(valid, axis=0)
    for x in np.nonzero(valid.any(axis=0))[0]:
        f = int(first[x])
        if 0 < f < 0.3 * img.shape[0]:
            out[:f, x] = img[min(img.shape[0] - 1, f + 4), x]
            ok[:f, x] = True
    return out, ok


def _pattern(panel: np.ndarray, valid: np.ndarray) -> str:
    """vertical (stripes) | horizontal (hoops) | plain | print."""
    lab = cv2.cvtColor(panel, cv2.COLOR_BGR2LAB).astype(np.float32)
    lo = slice(int(0.35 * PANEL_H), int(0.9 * PANEL_H))
    region, ok = lab[lo], valid[lo]
    if ok.mean() < 0.5:
        return "plain"
    region = np.where(ok[..., None], region, np.nan)
    total = float(np.nanvar(region.reshape(-1, 3), axis=0).sum())
    if total < 25.0:  # under ~5 Lab units: a plain cloth
        return "plain"
    with np.errstate(all="ignore"):
        cols = float(np.nansum(np.nanvar(np.nanmean(region, axis=0), axis=0)))
        rows = float(np.nansum(np.nanvar(np.nanmean(region, axis=1), axis=0)))
    if cols > 0.55 * total and cols > 2 * rows:
        return "vertical"
    if rows > 0.55 * total and rows > 2 * cols:
        return "horizontal"
    return "print"


def _tile(patch: np.ndarray, w: int, h: int, scale: float) -> np.ndarray:
    ph, pw = patch.shape[:2]
    p = cv2.resize(patch, (max(8, int(pw * scale)), max(8, int(ph * scale))), interpolation=cv2.INTER_AREA)
    reps = (h // p.shape[0] + 1, w // p.shape[1] + 1, 1)
    return np.tile(p, reps)[:h, :w]


def _grain(fabric: np.ndarray, w: int, h: int, scale: float) -> np.ndarray:
    """The cloth's fine texture only (weave, knit), zero-mean."""
    t = _tile(fabric, w, h, scale).astype(np.float32)
    # Clipped: an edge or seam caught in the swatch must not repeat as lines.
    return np.clip(t - cv2.GaussianBlur(t, (0, 0), 4), -7, 7)


def _plain(tone, w: int, h: int, fabric: np.ndarray, scale: float) -> np.ndarray:
    return np.clip(np.zeros((h, w, 3), np.float32) + np.asarray(tone, np.float32)
                   + 0.9 * _grain(fabric, w, h, scale), 0, 255).astype(np.uint8)


def _back_panel(front: np.ndarray, valid: np.ndarray, pattern: str, fabric: np.ndarray, scale: float) -> np.ndarray:
    body = slice(int(0.3 * PANEL_H), int(0.95 * PANEL_H))
    if pattern == "vertical":
        cols = np.median(front[body], axis=0)  # stripes run on, a crest does not
        back = np.repeat(cols[None], PANEL_H, axis=0)[:, ::-1]
    elif pattern == "horizontal":
        rows = np.median(front, axis=1)
        back = np.repeat(rows[:, None], PANEL_W, axis=1)
    elif pattern == "plain":
        tone = np.median(front[body][valid[body]], axis=0) if valid[body].any() else np.median(front[body], axis=(0, 1))
        back = _plain(tone, PANEL_W, PANEL_H, fabric, scale)
    else:
        back = _tile(fabric, PANEL_W, PANEL_H, scale)
    return np.clip(back, 0, 255).astype(np.uint8)


def _sleeve_strip(front: np.ndarray, pattern: str, tone, cuff, fabric: np.ndarray, scale: float) -> np.ndarray:
    """Root (left) → cuff (right); across = once round the arm.

    Stripes carry on down the sleeve, hoops run round it, plain cloth stays
    plain; a cuff of a different colour gets its band at the end. (Sleeves in
    a flat-lay photo are folded and foreshortened — too unreliable to unwrap.)"""
    h, w = SIZE - PANEL_H, PANEL_W
    body = slice(int(0.3 * PANEL_H), int(0.95 * PANEL_H))
    if pattern == "vertical":
        # Striped bodies mostly have plain sleeves: the main stripe's colour.
        cols = np.median(front[body], axis=0).astype(np.float32)
        lum = cols.mean(axis=1)
        light = lum >= lum.mean()
        main = light if light.sum() >= (~light).sum() else ~light
        strip = _plain(np.median(cols[main], axis=0), w, h, fabric, scale)
    elif pattern == "horizontal":
        prof = np.median(front, axis=1)[body][: int(0.5 * PANEL_H)]
        prof = cv2.resize(prof[:, None].astype(np.uint8), (1, w), interpolation=cv2.INTER_AREA)[:, 0]
        strip = np.repeat(prof[None], h, axis=0)
    elif pattern == "print":
        strip = _tile(fabric, w, h, scale)
    else:
        strip = _plain(tone, w, h, fabric, scale)
    strip = strip.astype(np.float32)
    if np.abs(np.asarray(cuff, np.float32) - np.asarray(tone, np.float32)).sum() > 45:
        c = int(0.93 * w)
        strip[:, c:] = np.asarray(cuff, np.float32) + 0.9 * _grain(fabric, w - c, h, scale)
    return np.clip(strip, 0, 255).astype(np.uint8)


def _cuff_colour(gar: Garment, tone) -> np.ndarray:
    """Sleeve pixels furthest from the shoulder: the cuff."""
    L = gar.y_hem - gar.y_top
    h, w = gar.mask.shape
    yy, xx = np.mgrid[0:h, 0:w]
    lo_y, hi_y = gar.y_shoulder, gar.y_armpit + 0.15 * L
    x0, x1 = gar.edges(np.clip(yy, gar.rows[0], gar.rows[-1]).astype(np.float64))
    best = None
    for side in (-1, 1):
        edge = x0 if side < 0 else x1
        sel = (gar.mask > 0) & (yy >= lo_y) & (yy <= hi_y) & ((xx - edge) * side > 6)
        if sel.sum() < 200:
            continue
        root = np.array([gar.edges(gar.y_shoulder)[0 if side < 0 else 1], gar.y_shoulder])
        d = np.hypot(xx[sel] - root[0], yy[sel] - root[1])
        far = d >= np.percentile(d, 94)
        c = np.median(gar.image[sel][far], axis=0)
        best = c if best is None else (best + c) / 2
    return np.asarray(tone, np.float32) if best is None else best


def _median_colour(img: np.ndarray, mask: np.ndarray, x0: float, x1: float, y0: float, y1: float, fallback) -> np.ndarray:
    h, w = img.shape[:2]
    xa, xb = int(max(0, x0)), int(min(w, x1))
    ya, yb = int(max(0, y0)), int(min(h, y1))
    if xb <= xa or yb <= ya:
        return np.asarray(fallback, np.float32)
    m = mask[ya:yb, xa:xb] > 0
    if m.sum() < 10:
        return np.asarray(fallback, np.float32)
    return np.median(img[ya:yb, xa:xb][m], axis=0)


def atlas(gar: Garment) -> tuple[np.ndarray, dict]:
    """The texture atlas and what the 3D builder needs to know about it."""
    if gar.kind != "top":
        raise ValueError("texture atlas: tops only")
    front, valid = _front_panel(gar)
    pattern = _pattern(front, valid)
    front, valid = _fill_top_down(front, valid)
    front = _fill_outside(front, valid)
    fabric = fabric_patch(gar)
    # Shading and a zip read as "print"; a plain swatch says it is plain cloth.
    if pattern == "print" and float(cv2.cvtColor(fabric, cv2.COLOR_BGR2GRAY).std()) < 9.0:
        pattern = "plain"
    # Fabric tiles at the photo's own scale (panel px per product px).
    scale = PANEL_W / max(2.0 * gar.body_half * 1.04, 1.0)
    back = _back_panel(front, valid, pattern, fabric, scale)
    tone = np.median(front[int(0.4 * PANEL_H):int(0.9 * PANEL_H)].reshape(-1, 3), axis=0)
    cuff = _cuff_colour(gar, tone)
    sleeve = _sleeve_strip(front, pattern, tone, cuff, fabric, scale)

    out = np.zeros((SIZE, SIZE, 3), np.uint8)
    out[:PANEL_H, :PANEL_W] = front
    out[:PANEL_H, PANEL_W:] = back
    out[PANEL_H:, :PANEL_W] = sleeve
    out[PANEL_H:, PANEL_W:] = _tile(fabric, SIZE - PANEL_W, SIZE - PANEL_H, scale)

    L = gar.y_hem - gar.y_top
    sh = (gar.edges(gar.y_shoulder)[1] - gar.edges(gar.y_shoulder)[0]) / 2
    # Collar: the band of cloth along the top edge near the centre line.
    collar = _median_colour(gar.image, gar.mask, gar.cx - 0.35 * sh, gar.cx + 0.35 * sh,
                            gar.y_top, gar.y_top + 0.035 * L, tone)
    meta = {
        "version": 1,
        "pattern": pattern,
        "tone": _hex(tone),
        "collar": _hex(collar),
        "cuff": _hex(cuff),
        "hasSleeves": bool(gar.sleeves),
        # Lengths as fractions of collar → hem, for placing seams in 3D.
        "shoulder": float((gar.y_shoulder - gar.y_top) / max(L, 1)),
        "armpit": float((gar.y_armpit - gar.y_top) / max(L, 1)),
        "sleeve": float(gar.sleeve_frac),
        "widthToLength": float(2 * gar.body_half / max(L, 1)),
    }
    return out, meta
