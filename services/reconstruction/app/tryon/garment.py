"""Read a catalogue product photo: the garment's outline and its parts.

Product photos are flat lays or ghost-mannequin shots on a plain background
(the catalogue's own are). From the outline alone we find what a try-on
needs to put the garment on a body:

* the **torso panel** — collar to hem, with its side seams (the run through
  the centre, clipped where the sleeves join);
* each **sleeve** — its root at the shoulder, its axis (PCA of its pixels),
  its length and width;
* for **bottoms**, the waistband, crotch and the two legs.

Everything is cached per image: catalogue photos don't change.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter

log = logging.getLogger(__name__)


@dataclass
class GSleeve:
    root: np.ndarray  # where the sleeve meets the shoulder (product px)
    axis: np.ndarray  # unit vector, root → cuff
    normal: np.ndarray  # unit, pointing away from the garment's centre
    length: float
    centres: np.ndarray  # positions along the axis (bins)
    lo: np.ndarray  # perpendicular extent per bin
    hi: np.ndarray


@dataclass
class Garment:
    kind: str  # "top" | "bottom"
    image: np.ndarray  # BGR, with the garment's own lighting evened out
    raw: np.ndarray
    mask: np.ndarray
    cx: float
    y_top: float  # collar (top) / waistband (bottom)
    y_hem: float
    y_shoulder: float
    y_armpit: float
    rows: np.ndarray  # y for the torso profile
    x0: np.ndarray
    x1: np.ndarray
    sleeves: list[GSleeve]
    body_half: float  # half width of the body at the waist
    sleeve_frac: float  # sleeve length / torso length (0 = sleeveless)
    length_frac: float  # torso length / body width — long garments are long
    tone: np.ndarray  # dominant colour (BGR)

    def edges(self, y):
        return np.interp(y, self.rows, self.x0), np.interp(y, self.rows, self.x1)


_cache: OrderedDict[str, Garment] = OrderedDict()
_lock = threading.Lock()


def read_cached(key: str, image: np.ndarray, kind: str) -> Garment:
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    g = read(image, kind)
    with _lock:
        _cache[key] = g
        while len(_cache) > 64:
            _cache.popitem(last=False)
    return g


def _disk(r: int) -> np.ndarray:
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def garment_mask(image: np.ndarray) -> np.ndarray:
    """Garment vs. plain backdrop: colour distance from the border, refined by GrabCut."""
    h, w = image.shape[:2]
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    border = np.concatenate([lab[:6].reshape(-1, 3), lab[-6:].reshape(-1, 3),
                             lab[:, :6].reshape(-1, 3), lab[:, -6:].reshape(-1, 3)])
    bg = np.median(border, axis=0)
    spread = np.percentile(np.linalg.norm(border - bg, axis=1), 95)
    d = np.linalg.norm(lab - bg, axis=2)
    # A light garment on a light wall differs mostly in texture: add local contrast.
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32)
    tex = cv2.GaussianBlur(np.abs(gray - cv2.GaussianBlur(gray, (0, 0), 2)), (0, 0), 3)
    score = d + 2.5 * tex
    thr = max(8.0, spread * 1.4)
    gc = np.full((h, w), cv2.GC_PR_BGD, np.uint8)
    gc[score > thr] = cv2.GC_PR_FGD
    gc[score > thr * 2.5] = cv2.GC_FGD
    # Catalogue shots are centred: the middle of the frame is surely garment,
    # a band around the edge surely backdrop.
    gc[int(0.38 * h): int(0.62 * h), int(0.44 * w): int(0.56 * w)] = cv2.GC_FGD
    b = int(0.025 * min(h, w))
    gc[:b, :] = gc[-b:, :] = cv2.GC_BGD
    gc[:, :b] = gc[:, -b:] = cv2.GC_BGD
    s = min(1.0, 480 / max(h, w))
    small = cv2.resize(image, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    sgc = cv2.resize(gc, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_NEAREST)
    if (sgc == cv2.GC_FGD).any():
        bgd, fgd = np.zeros((1, 65)), np.zeros((1, 65))
        cv2.grabCut(small, sgc, None, bgd, fgd, 5, cv2.GC_INIT_WITH_MASK)
    m = np.where((sgc == cv2.GC_FGD) | (sgc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    m = cv2.resize(m, (w, h), interpolation=cv2.INTER_LINEAR)
    m = np.where(m > 127, 255, 0).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, _disk(3))
    n, lab_, stats, _ = cv2.connectedComponentsWithStats(m, 8)
    if n > 1:
        big = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        m = np.where(lab_ == big, 255, 0).astype(np.uint8)
    # Close small holes (buttons, prints) but keep the neck opening.
    inv = cv2.bitwise_not(m)
    n2, l2, s2, _ = cv2.connectedComponentsWithStats(inv, 8)
    for i in range(1, n2):
        x, y, ww, hh, area = s2[i]
        touches = x == 0 or y == 0 or x + ww >= w or y + hh >= h
        if not touches and area < 0.004 * h * w:
            m[l2 == i] = 255
    return m


def _even_light(image: np.ndarray, mask: np.ndarray) -> np.ndarray:
    """Remove the product shot's broad lighting (keep texture and seams)."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = lab[..., 0]
    m = (mask > 0).astype(np.float32)
    sig = 0.06 * max(image.shape[:2])
    low = cv2.GaussianBlur(L * m, (0, 0), sig) / np.maximum(cv2.GaussianBlur(m, (0, 0), sig), 1e-3)
    ref = float(np.median(L[mask > 0])) if (mask > 0).any() else 128.0
    lab[..., 0] = np.clip(L * (ref / np.maximum(low, 1.0)) ** 0.85, 0, 255)
    return cv2.cvtColor(lab.astype(np.uint8), cv2.COLOR_LAB2BGR)


def _runs(line: np.ndarray):
    d = np.diff(np.concatenate([[0], line.astype(np.int8), [0]]))
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0] - 1, strict=True))


def read(image: np.ndarray, kind: str = "top") -> Garment:
    h, w = image.shape[:2]
    mask = garment_mask(image)
    ys, xs = np.nonzero(mask)
    if len(ys) < 500:
        raise ValueError("no garment found in the product photo")
    y_top, y_bot = float(ys.min()), float(ys.max())
    cx = float(np.median(xs))
    even = _even_light(image, mask)
    tone = np.median(image[mask > 0].reshape(-1, 3), axis=0).astype(np.float32)

    # Width of the run through the centre, per row.
    Y = np.arange(int(y_top), int(y_bot) + 1)
    xl = np.full(len(Y), np.nan)
    xr = np.full(len(Y), np.nan)
    for i, y in enumerate(Y):
        rr = _runs(mask[y] > 0)
        for a, b in rr:
            if a <= cx <= b:
                xl[i], xr[i] = a, b
                break
        else:
            # Neck opening on the centre line: the runs either side of it.
            left = [r for r in rr if r[1] < cx]
            right = [r for r in rr if r[0] > cx]
            if left and right:
                xl[i], xr[i] = left[-1][0], right[0][1]
    ok = ~np.isnan(xl)
    Y, xl, xr = Y[ok], xl[ok], xr[ok]
    half = np.maximum(cx - xl, xr - cx)
    L = float(Y[-1] - Y[0])

    if kind == "bottom":
        return _read_bottom(image, even, mask, cx, Y, xl, xr, tone)

    long_garment = L / max(2 * float(np.median(half)), 1.0) > 1.75
    # Body half-width: the narrowest typical rows of the lower-middle (a flat
    # lay's sleeves often lie against the body for part of its length).
    mid = (Y > Y[0] + 0.4 * L) & (Y < Y[0] + (0.6 if long_garment else 0.85) * L)
    body_half = float(np.percentile(half[mid], 20)) if mid.any() else float(np.median(half))
    # Shoulder line: where the outline has spread out to the shoulders (above
    # it: collar, or a hood).
    y_shoulder = Y[0] + 0.08 * L
    for i in range(len(Y)):
        if half[i] >= 0.9 * body_half:
            y_shoulder = float(Y[i])
            break
    # Armpit: below the shoulders, the first row no wider than the body + a
    # little — the sleeves have come away.
    y_armpit = y_shoulder + 0.22 * L
    for i in range(len(Y)):
        if Y[i] > y_shoulder + 0.06 * L and half[i] <= body_half * 1.12:
            y_armpit = float(Y[i])
            break
    y_armpit = float(np.clip(y_armpit, y_shoulder + 0.06 * L, y_shoulder + 0.35 * L))
    # Shoulder half-width: the outline's width at the shoulder line, capped.
    i_sh = int(np.searchsorted(Y, y_shoulder))
    sh_half = float(min(half[min(i_sh, len(half) - 1)], body_half * 1.22))

    # Torso edges: the centre run, clipped by the seam line shoulder→armpit.
    x0, x1 = xl.copy(), xr.copy()
    for i, y in enumerate(Y):
        if y >= y_shoulder:
            if y <= y_armpit:
                f = (y - y_shoulder) / max(y_armpit - y_shoulder, 1)
                lim = sh_half + f * (body_half * 1.04 - sh_half)
            else:
                # Long garments may flare below the sleeve zone; tops don't.
                flare_ok = long_garment and y > y_shoulder + 0.5 * L
                lim = max(body_half * 1.04, (xr[i] - xl[i]) / 2 if flare_ok else 0)
                lim = min(lim, body_half * 2.4)
            x0[i] = max(x0[i], cx - lim)
            x1[i] = min(x1[i], cx + lim)
    x0 = gaussian_filter1d(median_filter(x0, size=7, mode="nearest"), 1.5)
    x1 = gaussian_filter1d(median_filter(x1, size=7, mode="nearest"), 1.5)
    # Hem: where the centre run ends (long sleeves hanging past it don't count).
    y_hem = float(Y[-1])

    # Sleeves: garment pixels outside the torso edges, below the shoulder line.
    torso = np.zeros_like(mask)
    for y, a, b in zip(Y, x0, x1, strict=True):
        torso[int(y), int(a): int(b) + 1] = 255
    torso = cv2.dilate(torso, _disk(2))
    rest = (mask > 0) & (torso == 0)
    rest[: int(y_shoulder - 0.02 * L), :] = False
    sleeves = []
    for side in (-1, 1):
        sm = rest.copy()
        if side < 0:
            sm[:, int(cx):] = False
        else:
            sm[:, : int(cx)] = False
        sm = cv2.morphologyEx(sm.astype(np.uint8) * 255, cv2.MORPH_OPEN, _disk(3)) > 0
        sl = _sleeve(sm, cx, side, y_shoulder, sh_half, L)
        if sl is not None:
            sleeves.append(sl)
    sleeve_frac = float(np.mean([s.length for s in sleeves]) / L) if sleeves else 0.0
    log.info("garment: L=%d body=%d armpit=%.2f sleeves=%d (%.2f of length)", L, body_half,
             (y_armpit - Y[0]) / L, len(sleeves), sleeve_frac)
    mask = cv2.erode(mask, _disk(2))
    return Garment("top", even, image, mask, cx, float(Y[0]), y_hem, y_shoulder, y_armpit,
                   Y.astype(np.float64), x0, x1, sleeves, body_half, sleeve_frac,
                   L / max(2 * body_half, 1.0), tone)


def _sleeve(sm: np.ndarray, cx: float, side: int, y_shoulder: float, sh_half: float, L: float) -> GSleeve | None:
    ys, xs = np.nonzero(sm)
    if len(ys) < 0.002 * sm.size:
        return None
    root = np.array([cx + side * sh_half, y_shoulder], np.float64)
    pts = np.stack([xs, ys], 1).astype(np.float64)
    # Axis: from the root to the far end of the sleeve (robust PCA).
    c = pts.mean(axis=0)
    cov = np.cov((pts - c).T)
    evals, evecs = np.linalg.eigh(cov)
    axis = evecs[:, -1]
    if axis @ (c - root) < 0:
        axis = -axis
    normal = np.array([-axis[1], axis[0]])
    if normal[0] * side < 0:
        normal = -normal
    s = (pts - root) @ axis
    d = (pts - root) @ normal
    s_end = float(np.percentile(s, 99.5))
    if s_end < 0.08 * L:
        return None
    nb = 20
    edges = np.linspace(0, s_end, nb + 1)
    centres = (edges[:-1] + edges[1:]) / 2
    lo = np.full(nb, np.nan)
    hi = np.full(nb, np.nan)
    for i in range(nb):
        sel = (s >= edges[i]) & (s < edges[i + 1])
        if sel.sum() > 5:
            lo[i], hi[i] = np.percentile(d[sel], 3), np.percentile(d[sel], 97)
    ok = ~np.isnan(lo)
    if ok.sum() < 4:
        return None
    lo = gaussian_filter1d(np.interp(centres, centres[ok], lo[ok]), 1.0)
    hi = gaussian_filter1d(np.interp(centres, centres[ok], hi[ok]), 1.0)
    return GSleeve(root, axis, normal, s_end, centres, lo, hi)


def _read_bottom(raw, even, mask, cx, Y, xl, xr, tone) -> Garment:
    L = float(Y[-1] - Y[0])
    # Crotch: the first row where the centre column leaves the garment.
    y_crotch = Y[0] + 0.3 * L
    for y in range(int(Y[0] + 0.1 * L), int(Y[-1])):
        if mask[y, int(cx)] == 0:
            y_crotch = float(y)
            break
    half = (xr - xl) / 2
    waist_half = float(np.median(half[: max(3, int(0.06 * len(half)))]))
    return Garment("bottom", even, raw, mask, cx, float(Y[0]), float(Y[-1]), float(y_crotch), float(y_crotch),
                   Y.astype(np.float64), xl.astype(np.float64), xr.astype(np.float64), [], waist_half,
                   0.0, L / max(2 * waist_half, 1.0), tone)
