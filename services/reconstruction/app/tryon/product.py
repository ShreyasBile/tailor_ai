"""Try-on: a catalogue garment, on the shopper's photo.

The product photo gives the garment's look — its colour, weave, collar,
buttons, pockets, print — and its silhouette below the hip; the shopper's
photo gives everything that makes it look *worn*: where the body is, the
light, and the folds. So:

* torso: the product's torso panel is mapped onto the body's outline (collar
  to hem, centre line to each side seam) and multiplied by the photo's own
  shading (the old top's print removed — see `parse.garment_shading`);
* sleeves: built along the arm (shoulder → elbow → wrist) from the product's
  own fabric, as long as this style's sleeves are;
* length: as long as this style is — hip, knee, calf — widening below the hip
  the way the product does (an anarkali flares, a kurta falls straight).

A layering piece (a sleeveless Nehru jacket) goes *over* what the shopper is
wearing: their own sleeves stay.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import cv2
import numpy as np

from ..scan import pose as P
from .fit import FitGeometry
from .garment import Garment
from .parse import Arm, Parsed


@dataclass
class Style:
    sleeve: str  # "short" | "three_quarter" | "long" | "none"
    length: str  # "hip" | "knee" | "calf" | "midi" | "floor"
    offset_cm: float = 0.0  # for hip length: hem below (+) / above (−) the photo's
    layer: bool = False  # worn over the photo's top (keep its sleeves)
    cuff: str = "plain"  # "plain" | "rib" | "shirt"
    plain_sides: float = 0.62  # |u| beyond which the torso is plain cloth (no pockets there)
    plain_front: bool = False  # no buttons/zip/placket: the back looks like the front


# The seeded catalogue, by slug; anything else falls back to keywords.
STYLES: dict[str, Style] = {
    "northline-oxford-shirt": Style("long", "hip", 3, cuff="shirt", plain_sides=0.42),
    "northline-essential-tee": Style("short", "hip", 0, plain_front=True),
    "northline-merino-crew": Style("long", "hip", -1, cuff="rib", plain_sides=0.42, plain_front=True),
    "northline-fitted-tee": Style("short", "hip", -2, plain_front=True),
    "northline-poplin-blouse": Style("long", "hip", 3, cuff="shirt", plain_sides=0.42),
    "northline-field-jacket": Style("long", "hip", 5),
    "northline-wool-overcoat": Style("long", "knee", 4),
    "northline-pique-polo": Style("short", "hip", 1),
    "atelier-nove-dress-shirt": Style("long", "hip", 3, cuff="shirt", plain_sides=0.42),
    "atelier-nove-linen-shirt": Style("short", "hip", 1),
    "atelier-nove-wool-blazer": Style("long", "hip", 8),
    "atelier-nove-womens-blazer": Style("long", "hip", 6),
    "atelier-nove-wrap-dress": Style("long", "midi"),
    "atelier-nove-sheath-dress": Style("none", "knee"),
    "denim-theory-trucker": Style("long", "hip", -1, cuff="shirt"),
    "kinfolk-heavy-tee": Style("short", "hip", 2, plain_front=True),
    "kinfolk-shirt-dress": Style("short", "midi"),
    "desi-loom-cotton-kurta": Style("three_quarter", "knee"),
    "desi-loom-linen-kurta": Style("short", "hip", 12),
    "desi-loom-nehru-jacket": Style("none", "hip", 5, layer=True),
    "desi-loom-anarkali": Style("three_quarter", "floor"),
    "desi-loom-straight-kurta": Style("three_quarter", "calf"),
    "stride-training-tee": Style("short", "hip", -1, plain_front=True),
    "stride-zip-hoodie": Style("long", "hip", 2, cuff="rib", plain_sides=0.42),
    "stride-crop-hoodie": Style("long", "hip", -9, cuff="rib", plain_sides=0.42),
    "stride-football-jersey": Style("short", "hip", 0, plain_front=True),
}


def style_for(slug: str, subcategory: str, name: str, description: str, category: str) -> Style:
    if slug in STYLES:
        return STYLES[slug]
    text = f"{subcategory} {name} {description}".lower()
    sleeve = "long"
    if re.search(r"sleeveless|vest|nehru|waistcoat|tank", text):
        sleeve = "none"
    elif re.search(r"three-quarter|3/4|elbow", text):
        sleeve = "three_quarter"
    elif re.search(r"\b(t-?shirt|tee|polo|jersey|camp|short[- ]sleeve)", text):
        sleeve = "short"
    length, offset = "hip", 0.0
    if re.search(r"floor|maxi|anarkali", text):
        length = "floor"
    elif re.search(r"calf|midi", text):
        length = "calf" if "calf" in text else "midi"
    elif re.search(r"knee|overcoat|kurta|coat|dress", text):
        length = "knee"
    elif re.search(r"crop", text):
        offset = -9
    elif re.search(r"jacket|blazer", text):
        offset = 6
    cuff = "rib" if re.search(r"hoodie|sweater|knit|merino|crew", text) else (
        "shirt" if re.search(r"shirt|oxford|blouse", text) else "plain")
    return Style(sleeve, length, offset, layer=sleeve == "none" and re.search(r"jacket|vest|nehru", text) is not None,
                 cuff=cuff, plain_front=re.search(r"(t-?shirt|tee|jersey|crew|sweater)", text) is not None)


def hem_target(p: Parsed, style: Style, g: FitGeometry) -> float:
    """Where this style's hem falls on this body (working px)."""
    H = p.height_px
    knee = (p.lm[P.L_KNEE, 1] + p.lm[P.R_KNEE, 1]) / 2
    ankle = (p.lm[P.L_ANKLE, 1] + p.lm[P.R_ANKLE, 1]) / 2
    size = g.length_cm / p.cm_per_px
    if style.length == "knee":
        y = knee + 0.02 * H
    elif style.length == "midi":
        y = knee + 0.3 * (ankle - knee)
    elif style.length == "calf":
        y = knee + 0.5 * (ankle - knee)
    elif style.length == "floor":
        y = ankle - 0.01 * H
        return float(min(y, ankle + 0.005 * H))
    else:
        y = p.hem_y + style.offset_cm / p.cm_per_px
    return float(y + size * (1.6 if style.length != "hip" else 1.0))


# ── fabric ──


def fabric_patch(gar: Garment) -> np.ndarray:
    """A plain piece of the garment's cloth (no buttons or pockets), for sleeves."""
    img = gar.image
    h, w = img.shape[:2]
    y = gar.y_armpit + 0.55 * (gar.y_hem - gar.y_armpit) if gar.y_hem > gar.y_armpit else (gar.y_top + gar.y_hem) / 2
    size = int(max(24, 0.42 * gar.body_half))
    best, best_var = None, None
    for fx in (0.55, -0.55, 0.3, -0.3):
        for fy in (0.0, -0.15, 0.15):
            cx = int(gar.cx + fx * gar.body_half)
            cy = int(y + fy * (gar.y_hem - gar.y_top))
            x0, y0 = cx - size // 2, cy - size // 2
            if x0 < 0 or y0 < 0 or x0 + size >= w or y0 + size >= h:
                continue
            if (gar.mask[y0: y0 + size, x0: x0 + size] == 0).any():
                continue
            patch = img[y0: y0 + size, x0: x0 + size]
            var = float(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY).std())  # least busy = plainest cloth
            if best is None or var < best_var:
                best, best_var = patch, var
    # Best of all: the middle of a sleeve — plain cloth on almost any garment.
    if gar.sleeves:
        torso = np.zeros_like(gar.mask)
        for y, a, b in zip(gar.rows, gar.x0, gar.x1, strict=True):
            torso[int(y), int(a): int(b) + 1] = 255
        rest = ((gar.mask > 0) & (cv2.dilate(torso, np.ones((9, 9), np.uint8)) == 0)).astype(np.uint8)
        dist = cv2.distanceTransform(rest, cv2.DIST_L2, 5)
        r = float(dist.max())
        if r > 12:
            yy, xx = np.unravel_index(int(np.argmax(dist)), dist.shape)
            half_s = int(min(r * 0.7, size / 2))
            cand = img[yy - half_s: yy + half_s, xx - half_s: xx + half_s]
            if cand.shape[0] > 16 and cand.shape[1] > 16:
                var = float(cv2.cvtColor(cand, cv2.COLOR_BGR2GRAY).std())
                if best is None or var <= best_var * 1.3:
                    best = cand
    if best is None:
        best = np.full((32, 32, 3), gar.tone, np.uint8)
    # Mirror-tile so it repeats without seams.
    return np.vstack([np.hstack([best, best[:, ::-1]]), np.hstack([best[::-1], best[::-1, ::-1]])])


def _tile(patch: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    ph, pw = patch.shape[:2]
    mx = np.mod(u, pw).astype(np.float32)
    my = np.mod(v, ph).astype(np.float32)
    return cv2.remap(patch, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_WRAP)


# ── sampler ──


class ProductSampler:
    def __init__(self, gar: Garment, style: Style, p: Parsed):
        self.gar = gar
        self.style = style
        self.patch = fabric_patch(gar)
        # product px per body px, across the torso
        prof_w = np.median([b - a for a, b in p.torso_rows.values()]) if p.torso_rows else 200
        self.k = (2 * gar.body_half) / max(prof_w, 1.0)
        # Overall exposure: the photo's well-lit cloth is ~0.9 of its brightest.
        sh = p.shade[p.top > 0] if p.shade is not None else np.array([0.9])
        self.gain = 0.98 / max(float(np.percentile(sh, 75)), 0.5)

    def flare(self, p: Parsed, prof, hem_target_y: float):
        """Width factor below the photo's hem: follow the product's own outline
        relative to its width at the same point of its length."""
        gar = self.gar
        photo_hem = float(prof.Y[-1])
        if hem_target_y <= photo_hem + 4:
            return None
        sh = float(p.shoulder_top_y)
        span = max(hem_target_y - sh, 1.0)

        def half_at(yt):
            tt = np.clip((np.asarray(yt, np.float64) - sh) / span, 0, 1)
            yp = gar.y_shoulder + tt * (gar.y_hem - gar.y_shoulder)
            a, b = gar.edges(yp)
            return (b - a) / 2

        ref = max(float(half_at(photo_hem)), 1.0)

        def f(yt):
            return np.clip(half_at(yt) / ref, 0.9, 2.2)

        return f

    def torso(self, p: Parsed, tw, g: FitGeometry):
        gar = self.gar
        k = self.k
        hgt, w = tw.alpha.shape
        Yt = np.arange(tw.y0, tw.y0 + hgt, dtype=np.float64)
        X = np.arange(w, dtype=np.float64)[None, :]
        tl = p.torso_len
        u = tw.u
        # The collar hangs from the shoulder joints; the shoulder tips follow
        # the outline of the shoulders, which sits higher.
        mix = np.clip((np.abs(u) - 0.3) / 0.4, 0, 1)
        sh = float(p.shoulder_y) * (1 - mix) + float(p.shoulder_top_y) * mix
        Yc = Yt[:, None]
        yp_n = gar.y_shoulder + (Yc - sh) / np.maximum(tw.hem_t - sh, 1.0) * (gar.y_hem - gar.y_shoulder)
        yp_n = np.where(Yc < sh, gar.y_shoulder + (Yc - sh) * k, yp_n)
        yp_n = np.clip(yp_n, gar.y_top, gar.y_hem)
        x0p, x1p = gar.edges(yp_n)
        xp_n = np.where(u < 0, gar.cx + u * (gar.cx - x0p), gar.cx + u * (x1p - gar.cx))
        # Collar at true scale: a collar is the size it is, not as wide as the
        # shoulders it sits between.
        centre = np.array([float(np.mean(tw.edges_t[int(y)])) if int(y) in tw.edges_t else w / 2 for y in Yt])
        yp_a = gar.y_shoulder + (Yc - float(p.shoulder_y)) * k
        xp_a = gar.cx + (X - centre[:, None]) * k
        wa = np.clip((float(p.shoulder_y) + 0.06 * tl - Yc) / (0.09 * tl), 0, 1)
        wa = wa * np.clip((0.75 - np.abs(u)) / 0.35, 0, 1)
        if p.view == "back":
            # A product photo shows the front: its collar, placket and buttons
            # don't belong on the back — plain cloth there instead.
            wa_back = np.clip((float(p.shoulder_y) + 0.12 * tl - Yc) / (0.08 * tl), 0, 1) * np.ones_like(u)
        else:
            wa_back = None
        xp = wa * xp_a + (1 - wa) * xp_n
        yp = wa * yp_a + (1 - wa) * yp_n
        mapx = xp.astype(np.float32)
        mapy = np.ascontiguousarray(np.broadcast_to(yp, xp.shape)).astype(np.float32)
        albedo = cv2.remap(gar.image, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        inside = cv2.remap((gar.mask > 0).astype(np.float32), mapx, mapy, cv2.INTER_LINEAR,
                           borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        # The outer edge of the torso in the plain cloth: a flat lay's sleeves
        # often lie folded against its sides and must not be worn on the body.
        tile = _tile(self.patch, X.repeat(hgt, 0) * k, np.repeat(Yt[:, None], w, axis=1) * k).astype(np.float32)
        side = np.clip((np.abs(u) - self.style.plain_sides) / 0.14, 0, 1) * (1 - wa)
        below_arm = np.clip((Yt - (p.armpit_y + 0.02 * tl)) / (0.05 * tl), 0, 1)[:, None]
        side = side * below_arm
        if wa_back is not None:
            # back view: plain cloth up top, and the front's buttons/placket
            # softened everywhere (the back of a shirt is plain)
            side = np.maximum(side, wa_back)
            if not (self.style.layer or self.style.plain_front):
                side = np.maximum(side, np.clip(0.35 - np.abs(u), 0, 0.35) / 0.35 * 0.6)
        albedo = albedo * (1 - side[..., None]) + tile * side[..., None]
        inside = np.maximum(inside, side)
        shade = self._shade(p, tw, g, u)
        panel = np.clip(albedo * shade[..., None] * self.gain, 0, 255)
        return panel, tw.alpha * np.clip((inside - 0.15) * 1.5, 0, 1)

    def base(self, p: Parsed, tw, g: FitGeometry):
        hgt, w = tw.alpha.shape
        X = np.arange(w, dtype=np.float64)[None, :].repeat(hgt, 0)
        Y = np.arange(tw.y0, tw.y0 + hgt, dtype=np.float64)[:, None].repeat(w, 1)
        cloth = _tile(self.patch, X * self.k, Y * self.k).astype(np.float32)
        shade = self._shade(p, tw, g, tw.u)
        return np.clip(cloth * shade[..., None] * self.gain, 0, 255), tw.alpha

    def _shade(self, p: Parsed, tw, g: FitGeometry, u: np.ndarray) -> np.ndarray:
        """The photo's light and folds where the photo had cloth; a soft
        cylinder below its hem (over the trousers)."""
        sh = cv2.remap(p.shade, tw.map_x, tw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        sm = cv2.remap(p.shade_smooth, tw.map_x, tw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        tau = g.tightness
        sh = sh ** (1 - 0.7 * tau) * sm ** (0.7 * tau)
        cyl = 0.80 + 0.20 * np.sqrt(np.clip(1 - u ** 2, 0, 1))
        Yt = np.arange(tw.y0, tw.y0 + sh.shape[0])[:, None]
        below = np.clip((Yt - (p.hem_y - 6)) / 12.0, 0, 1)
        ref = float(np.median(p.shade_smooth[p.top > 0])) if (p.top > 0).any() else 0.9
        return (sh * (1 - below) + cyl * ref * below).astype(np.float32)

    def sleeve(self, p: Parsed, arm: Arm, sw, g: FitGeometry):
        """Short sleeves: the photo's sleeve geometry (sized), in this fabric."""
        ph, pw = sw.alpha.shape
        GX, GY = np.meshgrid(np.arange(sw.x0, sw.x0 + pw, dtype=np.float32),
                             np.arange(sw.y0, sw.y0 + ph, dtype=np.float32))
        o, a = arm.shoulder, (arm.elbow - arm.shoulder) / (np.linalg.norm(arm.elbow - arm.shoulder) or 1)
        n = np.array([-a[1], a[0]])
        s = (GX - o[0]) * a[0] + (GY - o[1]) * a[1]
        d = (GX - o[0]) * n[0] + (GY - o[1]) * n[1]
        cloth = _tile(self.patch, d * self.k, s * self.k).astype(np.float32)
        shade = cv2.remap(p.shade, sw.map_x, sw.map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
        out = cloth * shade[..., None] * self.gain
        # hem: a turned-up edge reads as a slightly darker band
        if sw.s_t is not None:
            band = np.clip((sw.s_t - 0.86) / 0.05, 0, 1) * np.clip((1.0 - sw.s_t) / 0.02, 0, 1)
            out *= (1 - 0.10 * band)[..., None]
        return np.clip(out, 0, 255), sw.alpha


# ── long sleeves along the arm ──


@dataclass
class ArmSleeve:
    x0: int
    y0: int
    alpha: np.ndarray
    s: np.ndarray  # arclength from the shoulder, px
    d: np.ndarray  # signed distance across, px
    half: np.ndarray  # sleeve half-width at s
    end: float
    end_pt: np.ndarray


def arm_sleeve(p: Parsed, arm: Arm, end_frac: float, ease_cm: float, g: FitGeometry) -> ArmSleeve | None:
    """A sleeve from the shoulder down the arm to `end_frac` of the way to the wrist."""
    h, w = p.image.shape[:2]
    cm = p.cm_per_px
    pts = [arm.shoulder, arm.elbow, arm.wrist]
    seg_len = [np.linalg.norm(pts[1] - pts[0]), np.linalg.norm(pts[2] - pts[1])]
    total = sum(seg_len)
    if total < 10:
        return None
    end = float(np.clip(end_frac, 0.2, 1.02)) * total + g.sleeve_len_cm / cm

    # Arm half-widths along the arm: the photo's sleeve near the top, the bare
    # skin further down (projected across the arm, robust percentiles).
    def half_width(mask: np.ndarray, s_lo: float, s_hi: float):
        ys, xs = np.nonzero(mask)
        if len(ys) < 20:
            return None
        best = None
        acc = 0.0
        for i in range(2):
            a0, a1 = pts[i], pts[i + 1]
            av = (a1 - a0) / (seg_len[i] or 1.0)
            nv = np.array([-av[1], av[0]])
            tt = (xs - a0[0]) * av[0] + (ys - a0[1]) * av[1] + acc
            dd = (xs - a0[0]) * nv[0] + (ys - a0[1]) * nv[1]
            sel = (tt >= s_lo) & (tt <= s_hi) & (tt >= acc) & (tt <= acc + seg_len[i])
            if sel.sum() > 15:
                v = (np.percentile(dd[sel], 95) - np.percentile(dd[sel], 5)) / 2
                best = v if best is None else max(best, v)
            acc += seg_len[i]
        return best

    sleeve_mask = arm.sleeve
    upper = half_width(sleeve_mask, 0.15 * total, 0.35 * total) or arm.radius
    upper = min(upper, 1.15 * arm.radius)
    elbow = half_width(arm.skin, 0.5 * total, 0.62 * total) or 0.8 * arm.radius
    wrist = half_width(arm.skin, 0.85 * total, 0.97 * total) or 0.55 * arm.radius
    ease = ease_cm / cm + 0.05 * g.chest_ease / cm + g.looseness * 0.8 / cm
    widths = np.array([upper + 0.4 * ease + 1, max(elbow, 0.6 * upper) + ease, max(wrist, 0.4 * upper) + 0.7 * ease + 1])

    # Bounding box around the arm.
    allp = np.array(pts)
    bx0, by0 = np.floor(allp.min(axis=0) - 2.5 * arm.radius).astype(int)
    bx1, by1 = np.ceil(allp.max(axis=0) + 2.5 * arm.radius).astype(int)
    bx0, by0, bx1, by1 = max(bx0, 0), max(int(p.shoulder_y - 0.08 * p.torso_len), 0), min(bx1, w - 1), min(by1, h - 1)
    GX, GY = np.meshgrid(np.arange(bx0, bx1 + 1, dtype=np.float64), np.arange(by0, by1 + 1, dtype=np.float64))
    best_d = np.full(GX.shape, np.inf)
    S = np.zeros(GX.shape)
    D = np.zeros(GX.shape)
    acc = 0.0
    for i in range(2):
        a0, a1 = pts[i], pts[i + 1]
        av = a1 - a0
        L = np.linalg.norm(av) or 1.0
        au = av / L
        nu = np.array([-au[1], au[0]])
        if nu @ (a0 - p.mid_shoulder) < 0:
            nu = -nu
        tt = (GX - a0[0]) * au[0] + (GY - a0[1]) * au[1]
        dd = (GX - a0[0]) * nu[0] + (GY - a0[1]) * nu[1]
        ext_lo = -0.25 * arm.radius if i == 0 else 0.0
        ext_hi = L if i == 0 else L + 0.4 * arm.radius
        tc = np.clip(tt, ext_lo, ext_hi)
        dist = np.hypot(tt - tc, dd)
        sel = dist < best_d
        best_d = np.where(sel, dist, best_d)
        S = np.where(sel, acc + tt, S)
        D = np.where(sel, dd, D)
        acc += L
    half = np.interp(S, [0, 0.55 * total, total], widths)
    # Round the sleeve head into the shoulder instead of a square end.
    half = half * np.sqrt(np.clip((S + 0.25 * arm.radius) / (0.9 * arm.radius), 0.15, 1.0))
    s_start = -0.25 * arm.radius
    cov = np.minimum(half - np.abs(D), np.minimum(S - s_start, end - S)) + 0.5
    alpha = np.clip(cov, 0, 1).astype(np.float32)
    alpha *= np.clip(GY - (p.shoulder_y - 0.05 * p.torso_len), 0, 1).astype(np.float32)
    frac = min(end / total, 1.0)
    if frac <= seg_len[0] / total:
        end_pt = pts[0] + (pts[1] - pts[0]) * (end / seg_len[0])
    else:
        end_pt = pts[1] + (pts[2] - pts[1]) * min((end - seg_len[0]) / seg_len[1], 1.0)
    return ArmSleeve(bx0, by0, alpha, S.astype(np.float32), D.astype(np.float32), half.astype(np.float32),
                     end, end_pt)


def render_arm_sleeve(sampler: ProductSampler, p: Parsed, sl: ArmSleeve, g: FitGeometry) -> np.ndarray:
    k = sampler.k
    cloth = _tile(sampler.patch, sl.d * k, sl.s * k).astype(np.float32)
    u = np.clip(sl.d / np.maximum(sl.half, 1), -1, 1)
    shade = 0.74 + 0.26 * np.sqrt(np.clip(1 - (u - 0.15) ** 2, 0, 1))  # lit from the front-left
    # Soft folds at the elbow, where a sleeve bunches.
    total = sl.end
    fold = np.zeros_like(shade)
    for c, amp in ((0.52, 1.0), (0.6, 0.7), (0.45, 0.5)):
        fold += amp * np.exp(-(((sl.s / max(total, 1)) - c) / 0.018) ** 2) * np.exp(-(u / 0.8) ** 2)
    shade *= 1 - 0.12 * np.clip(fold, 0, 1.5)
    # Cuff.
    cuff_len = (2.2 if sampler.style.cuff == "plain" else 5.5) / p.cm_per_px
    in_cuff = np.clip((sl.s - (sl.end - cuff_len)) / 1.5, 0, 1)
    if sampler.style.cuff == "rib":
        rib = 0.9 + 0.1 * np.sin(sl.d * 1.4)
        shade *= 1 - in_cuff * (1 - rib)
    elif sampler.style.cuff == "shirt":
        seam = np.exp(-((sl.s - (sl.end - cuff_len)) / 1.2) ** 2)
        shade *= 1 - 0.25 * seam
    else:
        seam = np.exp(-((sl.s - (sl.end - cuff_len)) / 1.0) ** 2)
        shade *= 1 - 0.12 * seam
    ref = float(np.median(p.shade_smooth[p.top > 0])) if (p.top > 0).any() else 0.9
    return np.clip(cloth * (shade * ref * sampler.gain)[..., None], 0, 255)
