"""Re-dress a parsed photo: one garment, one size.

Layers, back to front: background plate → what's under the garment (belly,
waistband) → torso panel → bare arms → sleeves → hands → head.

The torso panel is a dense inverse warp. For every output pixel we know the
source row (the hem moves, the chest stays put) and the source column (each
half of the garment is scaled about the body's centre line), so the cloth —
its print, stripes, badges and folds — moves with the outline instead of being
redrawn. Sleeves are warped the same way in the arm's own frame
(along the arm × across it).

`sampler` decides what the cloth looks like: the photo itself (size preview of
the outfit you're wearing) or a catalogue product's photo lit by the folds and
light of yours (try-on).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter1d, median_filter

from ..scan import pose as P
from .fit import FitGeometry
from .parse import Arm, Parsed

log = logging.getLogger(__name__)


@dataclass
class Rendered:
    image: np.ndarray  # BGR, cropped to the person
    zones: list[dict]  # caption anchors, x/y as fractions of the image
    summary: str
    box: tuple[int, int, int, int] = (0, 0, 0, 0)  # crop in working px: x0, y0, x1, y1


# ── small helpers ──


def _disk(r: int) -> np.ndarray:
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _line_map(shape, polylines, width: float, sigma: float) -> np.ndarray:
    """Soft lines (0..1) along polylines: the raw material of creases and folds."""
    m = np.zeros(shape[:2], np.float32)
    for pts in polylines:
        cv2.polylines(m, [np.round(np.asarray(pts)).astype(np.int32)], False, 1.0,
                      max(1, int(round(width))), cv2.LINE_AA)
    if sigma > 0:
        m = cv2.GaussianBlur(m, (0, 0), sigma)
        mx = float(m.max())
        if mx > 0:
            m /= mx
    return m


def _bezier(p0, p1, p2, n=24):
    t = np.linspace(0, 1, n)[:, None]
    return (1 - t) ** 2 * np.asarray(p0) + 2 * (1 - t) * t * np.asarray(p1) + t ** 2 * np.asarray(p2)


def _skin_tone(p: Parsed) -> np.ndarray:
    """The person's arm skin colour (BGR), lit like their arms."""
    pix = []
    for arm in p.arms:
        m = arm.skin > 0
        if m.sum() > 50:
            pix.append(p.image[m])
    if not pix:
        mean = p.skin_lab[0]
        lab = np.uint8([[np.clip(mean, 0, 255)]])
        return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)[0, 0].astype(np.float32)
    allpix = np.concatenate(pix).astype(np.float32)
    lum = allpix.mean(axis=1)
    keep = (lum > np.percentile(lum, 30)) & (lum < np.percentile(lum, 90))
    return np.median(allpix[keep], axis=0)


class Profile:
    """The photo garment's torso outline, smoothed, as functions of y."""

    def __init__(self, p: Parsed):
        ys = np.array(sorted(p.torso_rows), dtype=np.float64)
        x0 = np.array([p.torso_rows[int(y)][0] for y in ys], np.float64)
        x1 = np.array([p.torso_rows[int(y)][1] for y in ys], np.float64)
        Y = np.arange(int(ys[0]), int(ys[-1]) + 1, dtype=np.float64)
        x0 = np.interp(Y, ys, x0)
        x1 = np.interp(Y, ys, x1)
        # The hem curves up at the sides: hold the width of the body through it
        # rather than letting the outline pinch to a point.
        wd = x1 - x0
        lower = wd[int(0.6 * len(wd)):]
        if len(lower) > 5:
            ref = np.median(lower)
            ok = np.nonzero(wd >= 0.85 * ref)[0]
            if len(ok):
                ye = int(ok[-1])
                x0[ye:] = x0[ye]
                x1[ye:] = x1[ye]
        x0 = gaussian_filter1d(median_filter(x0, size=9, mode="nearest"), 2.0)
        x1 = gaussian_filter1d(median_filter(x1, size=9, mode="nearest"), 2.0)
        self.Y, self.x0, self.x1 = Y, x0 + 1.0, x1 - 1.0  # stay inside the cloth
        ms, mh = p.mid_shoulder, p.mid_hip
        self._ms, self._mh = ms, mh

    def xc(self, y):
        ms, mh = self._ms, self._mh
        t = (np.asarray(y, np.float64) - ms[1]) / max(mh[1] - ms[1], 1.0)
        return ms[0] + t * (mh[0] - ms[0])

    def edges(self, y):
        return np.interp(y, self.Y, self.x0), np.interp(y, self.Y, self.x1)


# ── the torso panel ──


@dataclass
class TorsoWarp:
    y0: int
    y1: int
    map_x: np.ndarray  # source x in the photo (own-garment space)
    map_y: np.ndarray
    alpha: np.ndarray  # 0..1 coverage
    t: np.ndarray  # 0 collar .. 1 photo hem (can exceed 1 for longer garments)
    u: np.ndarray  # −1 left edge .. 0 centre .. +1 right edge
    hem_t: float
    edges_t: dict  # y -> (left, right) target edges, for fills and captions


def cloth_bottom(p: Parsed) -> np.ndarray:
    """Per column, the lowest row of the top's torso (inf where none)."""
    h, w = p.top.shape
    m = p.torso_top > 0
    rows = np.where(m, np.arange(h)[:, None], -1).max(axis=0).astype(np.float64)
    rows[rows < 0] = np.inf
    finite = np.isfinite(rows)
    if finite.any():
        rows[finite] = median_filter(rows[finite], size=7, mode="nearest") - 1.5
    return rows.astype(np.float32)


def torso_warp(p: Parsed, prof: Profile, g: FitGeometry, length_px: float | None = None,
               bottom_of: np.ndarray | None = None, flare=None) -> TorsoWarp:
    h, w = p.image.shape[:2]
    cm = p.cm_per_px
    tl = p.torso_len
    collar, hem = float(prof.Y[0]), float(prof.Y[-1])
    armpit = p.armpit_y
    chest_y = p.shoulder_y + 0.32 * tl
    waist_y = p.shoulder_y + 0.62 * tl

    hem_t = hem + (length_px if length_px is not None else g.length_cm / cm)
    hem_t = float(np.clip(hem_t, chest_y + 0.25 * tl, h - 2))
    y_fix = min(chest_y, hem - 10)
    k_v = (hem_t - y_fix) / max(hem - y_fix, 1.0)

    Yt = np.arange(int(collar), int(np.ceil(hem_t)) + 2, dtype=np.float64)
    Ys = np.where(Yt <= y_fix, Yt, y_fix + (Yt - y_fix) / k_v)
    Ys_c = np.clip(Ys, collar, hem)

    # Ease per side (cm) down the body: chest → waist → hip.
    def ease_at(y):
        e = np.interp(y, [armpit, chest_y, waist_y, hem], [0.0, g.chest_ease, g.waist_ease, g.hip_ease])
        return np.where(y < armpit, 0.0, e)

    slack = np.interp(Ys_c, [armpit, chest_y, waist_y, hem], [0.4, 1.0, 2.2, 2.6])  # cm/side
    dw = 0.16 * ease_at(Ys_c)
    dw = np.maximum(dw, -slack)  # can't pull in past the body
    # A loose garment hangs straight from the chest: extra width low down.
    dw += g.looseness * np.clip((Ys_c - chest_y) / max(hem - chest_y, 1), 0, 1) * 1.6
    ramp = np.clip((Ys_c - armpit) / max(0.06 * tl, 1), 0, 1)
    dw_px = dw * ramp / cm

    x0s, x1s = prof.edges(Ys_c)
    xcs = prof.xc(Ys_c)
    xct = prof.xc(Yt)
    hl_s = np.maximum(xcs - x0s, 2.0)
    hr_s = np.maximum(x1s - xcs, 2.0)
    hl_t = np.maximum(hl_s + dw_px, 2.0)
    hr_t = np.maximum(hr_s + dw_px, 2.0)
    if flare is not None:  # below the photo's hem a long garment takes its own shape
        f = np.where(Yt > hem, flare(Yt), 1.0)
        hl_t = hl_t * f
        hr_t = hr_t * f

    X = np.arange(w, dtype=np.float64)[None, :]
    left = X < xct[:, None]
    map_x = np.where(
        left,
        xcs[:, None] - (xct[:, None] - X) * (hl_s / hl_t)[:, None],
        xcs[:, None] + (X - xct[:, None]) * (hr_s / hr_t)[:, None],
    )
    map_y = np.repeat(Ys_c[:, None], w, axis=1)
    if bottom_of is not None:
        cols = np.clip(np.round(map_x).astype(np.int32), 0, w - 1)
        map_y = np.minimum(map_y, bottom_of[cols])
    cov = np.minimum(X - (xct - hl_t)[:, None], (xct + hr_t)[:, None] - X) + 0.5
    alpha = np.clip(cov, 0, 1)
    # Hem: antialiased, a little wavy when the cloth hangs loose.
    wave = g.looseness * 3.5 * np.sin(X / max(0.09 * tl, 4.0) * np.pi)
    alpha *= np.clip(hem_t + wave - Yt[:, None] + 0.5, 0, 1)
    u = np.where(left, -(xct[:, None] - X) / hl_t[:, None], (X - xct[:, None]) / hr_t[:, None])
    t = np.repeat(((Ys - collar) / max(hem - collar, 1.0))[:, None], w, axis=1)
    edges_t = {int(y): (float(a - b), float(a + c)) for y, a, b, c in zip(Yt, xct, hl_t, hr_t, strict=True)}
    return TorsoWarp(int(Yt[0]), int(Yt[-1]), map_x.astype(np.float32), map_y.astype(np.float32),
                     alpha.astype(np.float32), t.astype(np.float32), u.astype(np.float32), hem_t, edges_t)


def strain_and_drape(p: Parsed, tw: TorsoWarp, g: FitGeometry) -> np.ndarray:
    """Multiplicative shading for the torso panel: creases when tight, folds when loose."""
    shape = (tw.y1 - tw.y0 + 1, p.image.shape[1])
    S = np.ones(shape, np.float32)
    tl = p.torso_len
    oy = tw.y0

    def E(y):
        return tw.edges_t.get(int(np.clip(y, tw.y0, tw.y1)), (0.0, 0.0))

    if g.tightness > 0.05:
        tau = g.tightness
        rng = np.random.default_rng(11)
        lines = []  # (points, per-point strength)
        # Pull lines fanning in from each armpit: strongest at the seam, fading
        # towards the middle of the chest, each a little different.
        for side in (-1, 1):
            for k in range(4):
                y = p.armpit_y + (0.015 + 0.075 * k + rng.uniform(-0.01, 0.01)) * tl
                if y > tw.hem_t - 0.05 * tl:
                    continue
                lx, rx = E(y)
                half = (rx - lx) / 2
                c = (lx + rx) / 2
                start_x = rx - 0.02 * half if side > 0 else lx + 0.02 * half
                reach = (0.42 - 0.06 * k + rng.uniform(-0.05, 0.05)) * half
                end = (start_x - side * reach, y + (0.05 + 0.02 * k) * tl)
                ctrl = (start_x - side * reach * 0.5, y + 0.005 * tl)
                pts = _bezier((start_x, y), ctrl, end, 20)
                lines.append((pts, np.linspace(1.0, 0.0, len(pts)) ** 0.8 * (1.0 - 0.12 * k)))
        # Tension across the belly and the hem rolling as it rides up.
        for frac in (0.62, 0.74):
            y = p.shoulder_y + frac * tl
            if y > tw.hem_t - 0.05 * tl:
                continue
            ly, ry = E(y)
            c, half = (ly + ry) / 2, (ry - ly) * 0.36
            pts = _bezier((c - half, y + 0.01 * tl), (c, y + 0.035 * tl), (c + half, y + 0.01 * tl), 24)
            lines.append((pts, 0.55 * np.sin(np.linspace(0, np.pi, len(pts)))))
        valley = np.zeros(shape, np.float32)
        ridge = np.zeros(shape, np.float32)
        for pts, wgt in lines:
            pts = np.asarray(pts) - [0, oy]
            for (a0, a1, wv) in zip(pts[:-1], pts[1:], wgt[:-1], strict=False):
                cv2.line(valley, tuple(np.round(a0).astype(int)), tuple(np.round(a1).astype(int)),
                         float(wv), 2, cv2.LINE_AA)
                cv2.line(ridge, tuple(np.round(a0 + [0, 3]).astype(int)),
                         tuple(np.round(a1 + [0, 3]).astype(int)), float(wv), 3, cv2.LINE_AA)
        valley = cv2.GaussianBlur(valley, (0, 0), 1.6)
        ridge = cv2.GaussianBlur(ridge, (0, 0), 2.4)
        valley /= max(float(valley.max()), 1e-6)
        ridge /= max(float(ridge.max()), 1e-6)
        S *= (1 - 0.34 * tau * valley) * (1 + 0.14 * tau * ridge)
        # Taut cloth catches the light over the chest.
        yy = np.arange(shape[0])[:, None] + oy
        chest = np.exp(-(((yy - (p.armpit_y + 0.12 * tl)) / (0.10 * tl)) ** 2))
        S *= (1 + 0.05 * tau * chest).astype(np.float32)

    if g.looseness > 0.05:
        lam = g.looseness
        top_y = p.shoulder_y + 0.38 * tl
        lines_v, lines_r = [], []
        for u_, drift in ((-0.78, -0.05), (-0.42, -0.02), (0.38, 0.02), (0.74, 0.05)):
            pts = []
            for y in np.linspace(top_y, tw.hem_t - 2, 30):
                lx, rx = E(y)
                c = (lx + rx) / 2
                half = (rx - lx) / 2
                f = (y - top_y) / max(tw.hem_t - top_y, 1)
                pts.append((c + (u_ + drift * f) * half + np.sin(f * 3.1 + u_ * 5) * 3, y - oy))
            pts = np.asarray(pts)
            lines_v.append(pts)
            lines_r.append(pts + [5.0, 0])
        valley = _line_map(shape, lines_v, 3.0, 4.5)
        ridge = _line_map(shape, lines_r, 3.0, 5.5)
        # Folds deepen towards the hem, where the spare cloth collects.
        yy = (np.arange(shape[0])[:, None] + oy - top_y) / max(tw.hem_t - top_y, 1)
        depth = np.clip(yy, 0, 1).astype(np.float32)
        S *= (1 - 0.30 * lam * valley * depth) * (1 + 0.12 * lam * ridge * depth)
    return S


# ── sleeves ──


@dataclass
class SleeveWarp:
    x0: int
    y0: int
    map_x: np.ndarray
    map_y: np.ndarray
    alpha: np.ndarray
    reveal: np.ndarray  # arm skin uncovered by a shorter sleeve (full-image mask)
    reveal_src: tuple[np.ndarray, np.ndarray]  # where to copy that skin from (full-image maps)
    end_pt: np.ndarray  # middle of the new sleeve hem, for captions
    s_t: np.ndarray | None = None  # along the sleeve, 0 shoulder .. 1 its end


def _arm_frame(p: Parsed, arm: Arm):
    o = arm.shoulder
    a = arm.elbow - o
    a = a / (np.linalg.norm(a) or 1.0)
    n = np.array([-a[1], a[0]])
    if n @ (o - p.mid_shoulder) < 0:
        n = -n
    return o, a, n


def sleeve_warp(p: Parsed, arm: Arm, g: FitGeometry, remove: bool = False) -> SleeveWarp | None:
    ys, xs = np.nonzero(arm.sleeve)
    if len(ys) < 40:
        return None
    h, w = p.image.shape[:2]
    cm = p.cm_per_px
    o, a, n = _arm_frame(p, arm)
    s = (xs - o[0]) * a[0] + (ys - o[1]) * a[1]
    d = (xs - o[0]) * n[0] + (ys - o[1]) * n[1]
    s0, s1 = float(np.percentile(s, 1)), float(np.percentile(s, 99.6)) + 1.0
    if s1 - s0 < 6:
        return None
    nb = 24
    edges = np.linspace(s0, s1, nb + 1)
    centres = (edges[:-1] + edges[1:]) / 2
    lo, hi = np.full(nb, np.nan), np.full(nb, np.nan)
    for i in range(nb):
        sel = (s >= edges[i]) & (s < edges[i + 1])
        if sel.sum() > 3:
            lo[i], hi[i] = np.percentile(d[sel], 2), np.percentile(d[sel], 98)
    ok = ~np.isnan(lo)
    if ok.sum() < 3:
        return None
    lo = gaussian_filter1d(np.interp(centres, centres[ok], lo[ok]), 1.2)
    hi = gaussian_filter1d(np.interp(centres, centres[ok], hi[ok]), 1.2)

    # The bare arm just below the sleeve: its width is the tightest a sleeve can get.
    sk_y, sk_x = np.nonzero(arm.skin)
    ss = (sk_x - o[0]) * a[0] + (sk_y - o[1]) * a[1]
    sd = (sk_x - o[0]) * n[0] + (sk_y - o[1]) * n[1]
    band = (ss > s1 + 2) & (ss < s1 + 0.08 * p.torso_len + 4)
    if band.sum() > 10:
        arm_c = float(np.median((np.percentile(sd[band], 3) + np.percentile(sd[band], 97)) / 2))
        arm_half = float((np.percentile(sd[band], 97) - np.percentile(sd[band], 3)) / 2)
    else:
        arm_c, arm_half = float(np.median((lo + hi) / 2)), float(np.median(hi - lo) / 2 * 0.8)

    sleeve_half = float(np.median(hi - lo) / 2)
    d_half_cm = 0.035 * g.chest_ease + 0.5 * g.looseness - 0.25 * g.tightness
    k_w = (sleeve_half + d_half_cm / cm) / max(sleeve_half, 1.0)
    k_w = float(np.clip(k_w, (arm_half + 1.0) / max(sleeve_half, 1.0), 1.8))
    s1_t = s1 + g.sleeve_len_cm / cm
    s1_t = float(np.clip(s1_t, s0 + 0.35 * (s1 - s0), s1 + 0.45 * np.linalg.norm(arm.wrist - arm.shoulder)))
    if remove:
        s1_t = max(s0, float(p.shoulder_y - arm.shoulder[1]) + 2)

    # Target bounding box in the image.
    corners = []
    for sv in (s0, s1_t):
        for dv in (lo.min() * 1.9 - 4, hi.max() * 1.9 + 4):
            corners.append(o + sv * a + dv * n)
    corners = np.asarray(corners)
    bx0, by0 = np.floor(corners.min(axis=0)).astype(int) - 4
    bx1, by1 = np.ceil(corners.max(axis=0)).astype(int) + 4
    bx0, by0 = max(bx0, 0), max(by0, 0)
    bx1, by1 = min(bx1, w - 1), min(by1, h - 1)
    if bx1 <= bx0 or by1 <= by0:
        return None
    GX, GY = np.meshgrid(np.arange(bx0, bx1 + 1, dtype=np.float64), np.arange(by0, by1 + 1, dtype=np.float64))
    st = (GX - o[0]) * a[0] + (GY - o[1]) * a[1]
    dt = (GX - o[0]) * n[0] + (GY - o[1]) * n[1]
    ssrc = s0 + (st - s0) * (s1 - s0) / max(s1_t - s0, 1.0)
    lo_s = np.interp(ssrc, centres, lo)
    hi_s = np.interp(ssrc, centres, hi)
    c = (lo_s + hi_s) / 2
    half = (hi_s - lo_s) / 2
    if k_w > 1:  # a wider sleeve flares towards its hem, not at the shoulder
        kk = 1 + (k_w - 1) * np.clip((st - s0) / max(s1_t - s0, 1.0), 0, 1) ** 0.8
    else:
        kk = np.full_like(st, k_w)
    half_t = half * kk
    dsrc = c + (dt - c) / kk
    cov = np.minimum(half_t - np.abs(dt - c), np.minimum(st - s0, s1_t - st)) + 0.5
    alpha = np.clip(cov, 0, 1)
    # Only below the shoulder line: the cap belongs to the torso panel.
    alpha *= np.clip((GY - (p.shoulder_y - 0.05 * p.torso_len)), 0, 1)
    mx = o[0] + ssrc * a[0] + dsrc * n[0]
    my = o[1] + ssrc * a[1] + dsrc * n[1]

    # Skin uncovered by a shorter sleeve, copied from just below the old hem.
    reveal = np.zeros((h, w), np.uint8)
    rx_map = np.zeros((h, w), np.float32)
    ry_map = np.zeros((h, w), np.float32)
    if s1_t < s1 - 1:
        Gx, Gy = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
        S_ = (Gx - o[0]) * a[0] + (Gy - o[1]) * a[1]
        D_ = (Gx - o[0]) * n[0] + (Gy - o[1]) * n[1]
        zone = (S_ > s1_t - 3) & (S_ <= s1 + 6) & (np.abs(D_ - arm_c) <= arm_half + 1) & (p.person > 0)
        reveal[zone] = 255
        src_s = s1 + 9 + (s1 - S_) * 0.45
        rx_map = (o[0] + src_s * a[0] + D_ * n[0]).astype(np.float32)
        ry_map = (o[1] + src_s * a[1] + D_ * n[1]).astype(np.float32)
    end_pt = o + s1_t * a + arm_c * n
    s_norm = np.clip((ssrc - s0) / max(s1 - s0, 1.0), 0, 1).astype(np.float32)
    return SleeveWarp(bx0, by0, mx.astype(np.float32), my.astype(np.float32), alpha.astype(np.float32),
                      reveal, (rx_map, ry_map), end_pt, s_norm)


def sleeve_creases(sw: SleeveWarp, p: Parsed, arm: Arm, g: FitGeometry) -> np.ndarray:
    S = np.ones(sw.alpha.shape, np.float32)
    if g.tightness < 0.05:
        return S
    o, a, n = _arm_frame(p, arm)
    lines = []
    for k, back in enumerate((5.0, 13.0)):
        c = sw.end_pt - a * back - np.array([sw.x0, sw.y0])
        half = 0.03 * p.torso_len * 4
        lines.append(np.array([c - n * half * 0.6, c + a * (1.5 + k), c + n * half * 0.6]))
    valley = _line_map(S.shape, lines, 1.5, 1.4)
    S *= 1 - 0.35 * g.tightness * valley
    return S


# ── fills for what a smaller garment uncovers ──


def fill_under(p: Parsed, canvas: np.ndarray, tw: TorsoWarp, pad: int = 4) -> None:
    """What a top that rides up uncovers: belly skin above the waistband,
    the trousers' waistband below it."""
    hem = float(p.hem_y)
    if tw.hem_t >= hem - 1:
        return
    h, w = canvas.shape[:2]
    tone = np.clip(_skin_tone(p) * 1.04, 0, 255)  # a belly sees less sun than forearms
    rng = np.random.default_rng(3)
    wb = p.waistband_y
    band_h = max(4, int(3.4 / p.cm_per_px))
    # How wide the trousers are where they meet the top.
    spans = []
    for y in range(int(hem) + 4, min(int(hem + 0.08 * p.torso_len), h - 1)):
        xs = np.nonzero(p.bottom[y])[0]
        if len(xs) > 10:
            spans.append((np.percentile(xs, 1), np.percentile(xs, 99)))
    if spans:
        pl, pr = float(np.median([s[0] for s in spans])), float(np.median([s[1] for s in spans]))
    else:
        pl, pr = 0.0, float(w - 1)
    pants_tone = np.median(p.image[p.bottom > 0].reshape(-1, 3), axis=0).astype(np.float32)
    keys = sorted(tw.edges_t)
    for y in range(max(int(tw.hem_t) - 2, 0), min(int(hem) + pad, h)):
        k = keys[min(int(np.searchsorted(keys, min(y, tw.hem_t - 3))), len(keys) - 1)]
        lx, rx = tw.edges_t[k]
        if y >= wb:  # trousers: as wide as they are at the mirrored row below
            sy = int(min(2 * (hem + 10) - y, h - 1))
            bx = np.nonzero(p.bottom[sy])[0]
            lx, rx = (float(bx[0]) - 1, float(bx[-1]) + 1) if len(bx) > 10 else (pl - 1, pr + 1)
        else:  # the waist curves in a little above the hips
            f = np.clip((wb - y) / max(wb - tw.hem_t, 1), 0, 1)
            inset = 0.035 * (rx - lx) * np.sin(f * np.pi / 2)
            lx, rx = lx + inset, rx - inset
        x0, x1 = int(np.floor(lx)), int(np.ceil(rx))
        if x1 <= x0:
            continue
        xs = np.arange(x0, x1 + 1)
        u = (xs - (lx + rx) / 2) / max((rx - lx) / 2, 1)
        edge = np.clip(np.minimum(xs - lx, rx - xs) / 2.0, 0, 1)[:, None]
        if y < wb:
            shade = 0.58 + 0.42 * np.clip(1 - u ** 2, 0, 1) ** 0.6
            if y > tw.hem_t:  # the hem's shadow on the skin
                shade = shade * (1 - 0.45 * np.exp(-(y - tw.hem_t) / 5.0))
            # a soft navel, a third of the way down the strip
            ny = tw.hem_t + 0.45 * (wb - tw.hem_t)
            if wb - tw.hem_t > 2.5 / p.cm_per_px:
                r = 0.55 / p.cm_per_px
                nav = np.exp(-(((xs - (lx + rx) / 2) / r) ** 2 + ((y - ny) / (1.4 * r)) ** 2))
                shade = shade * (1 - 0.38 * nav)
            col = tone[None, :] * shade[:, None] + rng.normal(0, 1.4, (len(xs), 1))
        else:
            src_y = int(min(2 * (hem + 10) - y, h - 1))  # mirror about a row clear of the old hem
            col = p.image[src_y, x0: x1 + 1].astype(np.float32)
            bad = (p.bottom[src_y, x0: x1 + 1] == 0)[:, None]
            col = np.where(bad, pants_tone[None, :], col)
            if y - wb < band_h:  # the waistband: a darker band, stitched top and bottom
                col = col * 0.84
                if y - wb < 2 or band_h - 2 <= y - wb < band_h - 1:
                    col = col * 0.7 + 28
                # the button
                bx = (pl + pr) / 2
                br = 0.55 * band_h / 2
                d = np.hypot(xs - bx, y - (wb + band_h / 2))
                metal = np.clip(br - d + 0.5, 0, 1)[:, None]
                col = col * (1 - metal) + np.array([150, 160, 168], np.float32) * (1.15 - 0.5 * np.clip(d / br, 0, 1))[:, None] * metal
            shade = 0.84 + 0.16 * np.sqrt(np.clip(1 - u ** 2, 0, 1))
            col = col * shade[:, None]
        cur = canvas[y, x0: x1 + 1].astype(np.float32)
        canvas[y, x0: x1 + 1] = np.clip(cur * (1 - edge) + col * edge, 0, 255).astype(np.uint8)


# ── compose ──


def render(p: Parsed, g: FitGeometry, sampler=None) -> Rendered:
    """`sampler(tw)` → (BGR image of the panel, alpha) for a catalogue garment;
    None keeps the photo's own garment."""
    h, w = p.image.shape[:2]
    prof = Profile(p)
    canvas = p.image.copy()
    style = getattr(sampler, "style", None)
    layer = style is not None and style.layer
    # Generous: a phone photo's cloth edge bleeds a few pixels past the matte.
    old_top = p.top.copy()
    if sampler is not None:
        # A different garment replaces every scrap of the old one, including
        # cloth the matte was unsure of: anything of the person between the
        # collar and the hem that isn't skin, hands or head.
        band = np.zeros((h, w), bool)
        band[p.collar_y: p.hem_y + 3] = True
        scraps = band & (p.person > 0) & (p.skin == 0) & (p.hands == 0) & (p.head == 0) & (p.bottom == 0)
        old_top = np.where((old_top > 0) | scraps, 255, 0).astype(np.uint8)
    erase = cv2.dilate(old_top, _disk(max(3, int(0.0045 * h)))) > 0
    # Sleeve cuffs often have a pale trim the matte leaves outside the person.
    for arm in p.arms:
        erase |= (cv2.dilate(arm.sleeve, _disk(int(0.012 * h))) > 0) & (p.skin == 0) & (p.head == 0)
    if layer:  # worn over the photo's top: nothing of it goes
        erase[:] = False
    canvas[erase] = p.background[erase]

    length_px, flare = None, None
    if style is not None:
        from .product import hem_target

        length_px = hem_target(p, style, g) - float(prof.Y[-1])
        flare = sampler.flare(p, prof, float(prof.Y[-1]) + length_px)
    tw = torso_warp(p, prof, g, length_px=length_px,
                    bottom_of=cloth_bottom(p) if sampler is None else None, flare=flare)
    if not layer:
        fill_under(p, canvas, tw, pad=int(0.0045 * h) + 3)

    # Torso panel.
    if sampler is None:
        panel = cv2.remap(p.image, tw.map_x, tw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        # Only ever paint cloth: where the warp samples past the photo's top
        # (its curved hem), keep what's behind.
        cloth = cv2.remap((p.top > 0).astype(np.float32), tw.map_x, tw.map_y, cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        pal = tw.alpha * cloth
        # A tight size smooths the photo's own folds away (the cloth is taut);
        # a loose one deepens them.
        if p.shade is not None and (g.tightness > 0.05 or g.looseness > 0.05):
            sh = cv2.remap(p.shade, tw.map_x, tw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            sm = cv2.remap(p.shade_smooth, tw.map_x, tw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            ratio = np.clip(sm / np.maximum(sh, 0.2), 0.6, 1.8)
            expo = 0.7 * g.tightness - 0.35 * g.looseness
            panel = np.clip(panel.astype(np.float32) * (ratio ** expo)[..., None], 0, 255)
    else:
        # Plain cloth under the product panel wherever the old top was, so a
        # product whose outline is a little narrower leaves no holes.
        base, bal = sampler.base(p, tw, g)
        bal = bal * (old_top[tw.y0: tw.y0 + bal.shape[0]] > 0)
        _blend(canvas, tw.y0, 0, base, bal)
        panel, pal = sampler.torso(p, tw, g)
    S = strain_and_drape(p, tw, g)
    panel = np.clip(panel.astype(np.float32) * S[..., None], 0, 255)
    _blend(canvas, tw.y0, 0, panel, pal)
    covered = np.zeros((h, w), bool)
    covered[tw.y0: tw.y0 + pal.shape[0]] |= pal[: h - tw.y0] > 0.5

    # Bare arms (forearms, and upper arms a shorter sleeve uncovers).
    arm_layer = np.zeros((h, w), bool)
    for arm in p.arms:
        arm_layer |= arm.skin > 0
    canvas[arm_layer] = p.image[arm_layer]
    sleeve_kind = "short" if style is None else ("keep" if layer else style.sleeve)
    if sleeve_kind == "keep":
        sleeves = [(arm, None) for arm in p.arms]
    else:
        sleeves = [(arm, sleeve_warp(p, arm, g, remove=sleeve_kind != "short")) for arm in p.arms]
    for _arm, sw in sleeves:
        if sw is None or not sw.reveal.any():
            continue
        skin_fill = cv2.remap(p.image, sw.reveal_src[0], sw.reveal_src[1], cv2.INTER_LINEAR,
                              borderMode=cv2.BORDER_REPLICATE)
        m = sw.reveal > 0
        canvas[m] = skin_fill[m]
    # Sleeves.
    if sleeve_kind in ("long", "three_quarter"):
        from .product import arm_sleeve, render_arm_sleeve

        long_sleeves = []
        for arm, _sw in sleeves:
            sl = arm_sleeve(p, arm, 1.0 if sleeve_kind == "long" else 0.62, 1.3, g)
            if sl is None:
                continue
            patch = render_arm_sleeve(sampler, p, sl, g)
            _blend(canvas, sl.y0, sl.x0, patch, sl.alpha)
            ph, pw = sl.alpha.shape
            covered[sl.y0: sl.y0 + ph, sl.x0: sl.x0 + pw] |= sl.alpha[: h - sl.y0, : w - sl.x0] > 0.5
            long_sleeves.append((arm, sl))
        sleeves = [(a, _EndOnly(sl.end_pt)) for a, sl in long_sleeves]
    for arm, sw in sleeves:
        if sw is None or sleeve_kind != "short":
            continue
        if sampler is None:
            patch = cv2.remap(p.image, sw.map_x, sw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            pa = sw.alpha
        else:
            patch, pa = sampler.sleeve(p, arm, sw, g)
        patch = np.clip(patch.astype(np.float32) * sleeve_creases(sw, p, arm, g)[..., None], 0, 255)
        _blend(canvas, sw.y0, sw.x0, patch, pa)
        ph, pw = pa.shape
        covered[sw.y0: sw.y0 + ph, sw.x0: sw.x0 + pw] |= pa[: h - sw.y0, : w - sw.x0] > 0.5
    # Hairline cracks where garment pieces meet: close them from their neighbours.
    closed = cv2.morphologyEx(covered.astype(np.uint8) * 255, cv2.MORPH_CLOSE, _disk(4)) > 0
    cracks = (closed & ~covered & erase).astype(np.uint8) * 255
    if cracks.any():
        canvas = cv2.inpaint(canvas, cracks, 3, cv2.INPAINT_TELEA)

    # Hands and head stay exactly as photographed, in front of the cloth.
    # Hands (and a watch) — not the jeans or wall around them.
    light = cv2.cvtColor(p.image, cv2.COLOR_BGR2LAB)[..., 0] > 95
    at_wrist = np.zeros((h, w), np.uint8)
    for arm in p.arms:  # a watch or bracelet — not the wall seen between arm and hip
        cv2.circle(at_wrist, tuple(np.round(arm.wrist).astype(int)), int(0.9 * arm.radius), 255, -1)
    hands = (p.hands > 0) & (p.person > 0) & (p.top == 0) & ((p.skin > 0) | (light & (at_wrist > 0)))
    hands = cv2.morphologyEx(hands.astype(np.uint8), cv2.MORPH_OPEN, _disk(1)) > 0
    canvas[hands] = p.image[hands]
    head = p.head > 0
    canvas[head] = p.image[head]
    if sampler is None:
        neck = (p.skin > 0) & (np.arange(h)[:, None] < p.armpit_y)
        canvas[neck] = p.image[neck]

    return _finish(p, canvas, tw, sleeves, g)


@dataclass
class _EndOnly:
    end_pt: np.ndarray


def _blend(canvas: np.ndarray, y0: int, x0: int, patch: np.ndarray, alpha: np.ndarray) -> None:
    ph, pw = alpha.shape
    y1, x1 = min(canvas.shape[0], y0 + ph), min(canvas.shape[1], x0 + pw)
    if y1 <= y0 or x1 <= x0:
        return
    a = alpha[: y1 - y0, : x1 - x0, None]
    region = canvas[y0:y1, x0:x1].astype(np.float32)
    canvas[y0:y1, x0:x1] = (region * (1 - a) + patch[: y1 - y0, : x1 - x0] * a).astype(np.uint8)


def _finish(p: Parsed, canvas: np.ndarray, tw: TorsoWarp, sleeves, g: FitGeometry) -> Rendered:
    h, w = canvas.shape[:2]
    ys, xs = np.nonzero(p.person)
    pad_x = int(0.22 * (xs.max() - xs.min()))
    pad_y = int(0.035 * (ys.max() - ys.min()))
    x0, x1 = max(0, xs.min() - pad_x), min(w, xs.max() + pad_x)
    y0, y1 = max(0, ys.min() - pad_y), min(h, ys.max() + pad_y)
    # Head to mid-thigh (or a little past a long garment's hem): the part
    # that shows how the garment fits, big enough to see.
    y1 = min(y1, int(max(tw.hem_t, p.hip_y) + 0.55 * p.torso_len))
    crop = canvas[y0:y1, x0:x1]
    cw, ch = x1 - x0, y1 - y0

    tl = p.torso_len

    def at(x, y):
        return {"x": round(float((x - x0) / cw), 4), "y": round(float((y - y0) / ch), 4)}

    def edge(y, side):
        e = tw.edges_t.get(int(y))
        if e is None:
            return None
        return e[1] if side > 0 else e[0]

    anchors = {}
    cy = p.armpit_y + 0.1 * tl
    if edge(cy, 1) is not None:
        anchors["chest"] = at(edge(cy, 1) - 4, cy)
    wy = p.shoulder_y + 0.6 * tl
    if edge(wy, -1) is not None and wy < tw.hem_t:
        anchors["waist"] = at(edge(wy, -1) + 4, wy)
    anchors["hip"] = anchors.get("waist")
    ls, rs = p.pt(P.L_SHOULDER), p.pt(P.R_SHOULDER)
    right_sh = ls if ls[0] > rs[0] else rs
    anchors["shoulders"] = at(right_sh[0], right_sh[1] - 0.02 * tl)
    for arm, sw in sleeves:
        if sw is not None and arm.shoulder[0] < p.mid_shoulder[0]:
            anchors["sleeves"] = at(*sw.end_pt)
    anchors["length"] = at(float(prof_x(tw)), tw.hem_t - 2)
    zones = []
    for z in g.zones:
        a = anchors.get(z.name)
        if a is None:
            continue
        zones.append({"name": z.name, "label": z.label, "tone": z.tone, "text": z.text, **a})
    return Rendered(crop, zones, g.summary, (int(x0), int(y0), int(x1), int(y1)))


def prof_x(tw: TorsoWarp) -> float:
    e = tw.edges_t.get(int(tw.hem_t) - 2) or next(iter(tw.edges_t.values()))
    return (e[0] + e[1]) / 2
