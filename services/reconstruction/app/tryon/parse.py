"""Read a scan photo into the layers a try-on needs.

Everything here comes from one MediaPipe pass (33 joints + person matte) and
classical image processing:

* **skin** — a colour model learnt from *this* person's face (and forearms), so
  it works for every skin tone without a trained segmenter;
* **top** — GrabCut seeded by the body's own geometry: the chest is surely the
  top, the legs, face and skin are surely not;
* **bottoms / shoes / head** — what remains of the person, split at the hem and
  the ankles;
* **background plate** — the person painted out, so a garment that shrinks
  reveals wall, not a hole.

Working resolution is chosen so the person is ~1100 px tall: small phone
photos are enlarged (smoothly) and very large ones reduced.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from dataclasses import dataclass, field

import cv2
import numpy as np

from ..scan import pose as P

log = logging.getLogger(__name__)

TARGET_BODY_PX = 1100


@dataclass
class Arm:
    side: str  # "left" | "right" — the person's own side
    shoulder: np.ndarray
    elbow: np.ndarray
    wrist: np.ndarray
    hand: np.ndarray  # index fingertip
    radius: float  # upper-arm half-width, px
    corridor: np.ndarray  # mask: where this arm can be
    skin: np.ndarray  # visible arm skin (forearm, hand, bare upper arm)
    sleeve: np.ndarray  # the top's sleeve on this arm
    sleeve_end: float  # 0..1 along shoulder→wrist where the sleeve ends


@dataclass
class Parsed:
    image: np.ndarray  # working-resolution BGR
    scale: float  # working px per original px
    view: str
    lm: np.ndarray  # (33, 4) landmarks in working px
    person: np.ndarray
    skin: np.ndarray
    head: np.ndarray  # hair + face + neck
    top: np.ndarray
    torso_top: np.ndarray  # the top without its sleeves
    bottom: np.ndarray
    shoes: np.ndarray
    hands: np.ndarray
    arms: list[Arm]
    background: np.ndarray
    cm_per_px: float
    skin_lab: tuple[np.ndarray, np.ndarray]  # mean, inverse covariance (L, a, b)
    collar_y: int
    hem_y: int
    waistband_y: int
    shoulder_y: float = 0.0
    shoulder_top_y: float = 0.0  # the top of the shoulders' outline (the seam line)
    armpit_y: float = 0.0
    hip_y: float = 0.0
    torso_len: float = 1.0
    torso_rows: dict = field(default_factory=dict)  # y -> (x0, x1) of the torso top
    shade: np.ndarray | None = None  # light on the top, print removed (1 = fully lit)
    shade_smooth: np.ndarray | None = None  # the same without folds: body-scale light only

    def pt(self, idx: int) -> np.ndarray:
        return self.lm[idx, :2].astype(np.float64)

    @property
    def mid_shoulder(self) -> np.ndarray:
        return (self.pt(P.L_SHOULDER) + self.pt(P.R_SHOULDER)) / 2

    @property
    def mid_hip(self) -> np.ndarray:
        return (self.pt(P.L_HIP) + self.pt(P.R_HIP)) / 2

    @property
    def height_px(self) -> float:
        rows = np.nonzero(self.person.any(axis=1))[0]
        return float(rows[-1] - rows[0]) if len(rows) else 1.0


class ParseError(ValueError):
    pass


# ── cache: parsing costs ~1–2 s; a shopper flips through many sizes ──

_cache: OrderedDict[str, Parsed] = OrderedDict()
_lock = threading.Lock()


def parse_cached(key: str, image: np.ndarray, height_cm: float, view: str = "front") -> Parsed:
    with _lock:
        hit = _cache.get(key)
        if hit is not None:
            _cache.move_to_end(key)
            return hit
    parsed = parse(image, height_cm, view)
    with _lock:
        _cache[key] = parsed
        while len(_cache) > 12:
            _cache.popitem(last=False)
    return parsed


# ── helpers ──


def _disk(r: int) -> np.ndarray:
    r = max(1, int(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def _polyline_mask(shape, pts, radius) -> np.ndarray:
    m = np.zeros(shape[:2], np.uint8)
    pts = [tuple(int(round(v)) for v in p) for p in pts]
    for a, b in zip(pts[:-1], pts[1:], strict=False):
        cv2.line(m, a, b, 255, max(1, int(2 * radius)), cv2.LINE_AA)
    for p in pts:
        cv2.circle(m, p, int(radius), 255, -1, cv2.LINE_AA)
    return np.where(m > 127, 255, 0).astype(np.uint8)


def _keep_touching(mask: np.ndarray, seed: np.ndarray) -> np.ndarray:
    """Connected components of `mask` that overlap `seed`."""
    n, labels = cv2.connectedComponents((mask > 0).astype(np.uint8), connectivity=8)
    if n <= 1:
        return mask
    hits = np.unique(labels[(seed > 0) & (mask > 0)])
    hits = hits[hits > 0]
    return np.where(np.isin(labels, hits), 255, 0).astype(np.uint8)


def background_plate(image: np.ndarray, person: np.ndarray) -> np.ndarray:
    """The photo with the person painted out.

    The scan asks for a plain wall, so each row is filled by interpolating the
    wall either side of the person (from a few pixels' median, so a stray
    hair doesn't streak), then softened vertically. Unlike a generic inpaint
    this keeps the wall's own brightness right up to the body's edge.
    """
    h, w = image.shape[:2]
    hp = max(4, int(0.004 * max(h, w)))
    bg = cv2.dilate(person, _disk(hp)) == 0
    med = cv2.medianBlur(image, 5).astype(np.float32)
    out = med.copy()
    xs_all = np.arange(w, dtype=np.float32)
    for y in range(h):
        row_bg = bg[y]
        if row_bg.all():
            continue
        xs = np.nonzero(row_bg)[0]
        if len(xs) < 2:
            continue
        for c in range(3):
            out[y, :, c] = np.interp(xs_all, xs.astype(np.float32), med[y, xs, c])
    fill = ~bg
    soft = cv2.GaussianBlur(out, (0, 0), 2.0 + 0.002 * h)
    out[fill] = soft[fill]
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 1.4, (h, w, 1)).astype(np.float32)
    plate = image.copy()
    plate[fill] = np.clip(out + grain, 0, 255).astype(np.uint8)[fill]
    return plate


# ── skin ──


def _skin_model(lab: np.ndarray, lm: np.ndarray, person: np.ndarray, h_px: float):
    """Mean/inverse covariance of this person's skin in Lab, from the cheeks."""
    nose = lm[P.NOSE, :2]
    ear_l, ear_r = lm[P.L_EAR, :2], lm[P.R_EAR, :2]
    face_w = max(np.linalg.norm(ear_l - ear_r), 0.05 * h_px)
    samples = []
    # cheeks + nose bridge, below the glasses line and above the beard
    for dx, dy in ((0.0, 0.0), (-0.22, 0.05), (0.22, 0.05), (-0.15, -0.06), (0.15, -0.06)):
        c = nose + np.array([dx * face_w, dy * face_w])
        r = max(2, int(0.07 * face_w))
        x0, y0 = int(c[0] - r), int(c[1] - r)
        patch = lab[max(0, y0) : y0 + 2 * r, max(0, x0) : x0 + 2 * r].reshape(-1, 3)
        pm = person[max(0, y0) : y0 + 2 * r, max(0, x0) : x0 + 2 * r].reshape(-1)
        samples.append(patch[pm > 0])
    pts = np.concatenate([s for s in samples if len(s)]) if samples else np.zeros((0, 3))
    if len(pts) < 30:
        raise ParseError("couldn't read skin colour from the face")
    pts = pts.astype(np.float64)
    # Drop glasses frames, beard and nostrils: keep the bright, typical half.
    L = pts[:, 0]
    pts = pts[(L > np.percentile(L, 35)) & (L < np.percentile(L, 99))]
    mean = np.median(pts, axis=0)
    cov = np.cov(pts.T) + np.diag([60.0, 6.0, 6.0])
    return mean, np.linalg.inv(cov)


def _skin_likelihood(lab: np.ndarray, mean: np.ndarray, icov: np.ndarray) -> np.ndarray:
    d = lab.reshape(-1, 3).astype(np.float64) - mean
    # Light and shadow change L a lot and chroma little: weigh L loosely.
    d[:, 0] *= 0.35
    m = np.einsum("ij,jk,ik->i", d, icov, d)
    return m.reshape(lab.shape[:2])


# ── main ──


def parse(image_bgr: np.ndarray, height_cm: float, view: str = "front") -> Parsed:
    h0, w0 = image_bgr.shape[:2]
    det0 = P.detect(image_bgr)
    if not det0.detected:
        raise ParseError("no person found in the photo")
    rows = np.nonzero((det0.mask > 0).any(axis=1))[0]
    body0 = float(rows[-1] - rows[0]) if len(rows) else h0
    scale = float(np.clip(TARGET_BODY_PX / max(body0, 1.0), 0.4, 3.5))
    work = cv2.resize(image_bgr, (round(w0 * scale), round(h0 * scale)),
                      interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA)
    if scale > 1.2:
        # Gentle unsharp mask: enlarged phone photos look soft otherwise.
        blur = cv2.GaussianBlur(work, (0, 0), 1.2 * scale / 2)
        work = cv2.addWeighted(work, 1.35, blur, -0.35, 0)
    cv2.setRNGSeed(0)
    det = P.detect(work)
    if not det.detected:
        raise ParseError("no person found in the photo")
    lm = det.landmarks.astype(np.float64)
    person = det.mask
    h, w = person.shape
    rows = np.nonzero(person.any(axis=1))[0]
    top_y, bot_y = int(rows[0]), int(rows[-1])
    H = float(bot_y - top_y)
    cm_per_px = height_cm / H

    lab = cv2.cvtColor(work, cv2.COLOR_BGR2LAB)
    ls, rs = lm[P.L_SHOULDER, :2], lm[P.R_SHOULDER, :2]
    lh, rh = lm[P.L_HIP, :2], lm[P.R_HIP, :2]
    sh_y = (ls[1] + rs[1]) / 2
    hip_y = (lh[1] + rh[1]) / 2
    torso_len = max(hip_y - sh_y, 0.15 * H)
    knee_y = (lm[P.L_KNEE, 1] + lm[P.R_KNEE, 1]) / 2
    ankle_y = (lm[P.L_ANKLE, 1] + lm[P.R_ANKLE, 1]) / 2

    # ── arms: corridors along the joint chain ──
    arm_r = 0.034 * H
    arms_geo = []
    for side, (s, e, wr, ix) in (
        ("left", (P.L_SHOULDER, P.L_ELBOW, P.L_WRIST, P.L_INDEX)),
        ("right", (P.R_SHOULDER, P.R_ELBOW, P.R_WRIST, P.R_INDEX)),
    ):
        pts = [lm[s, :2], lm[e, :2], lm[wr, :2], lm[ix, :2]]
        corridor = _polyline_mask(person.shape, pts, arm_r * 1.25) & person
        arms_geo.append((side, pts, corridor))
    hands = np.zeros_like(person)
    for _, pts, _ in arms_geo:
        hands |= _polyline_mask(person.shape, [pts[2], pts[3]], arm_r * 1.1)
    hands &= person

    # ── skin ──
    if view == "front":
        mean, icov = _skin_model(lab, lm, person, H)
    else:
        # Back view: no face. Learn from the forearms instead (between the
        # elbow and the wrist is skin for any top shorter than long-sleeve).
        samples = []
        for _, pts, _ in arms_geo:
            for t in (0.35, 0.55, 0.75):
                c = pts[1] + t * (pts[2] - pts[1])
                r = max(2, int(0.35 * arm_r))
                y0, x0 = int(c[1] - r), int(c[0] - r)
                samples.append(lab[max(0, y0): y0 + 2 * r, max(0, x0): x0 + 2 * r].reshape(-1, 3))
        pts_ = np.concatenate(samples).astype(np.float64)
        mean = np.median(pts_, axis=0)
        icov = np.linalg.inv(np.cov(pts_.T) + np.diag([60.0, 6.0, 6.0]))
    dist = _skin_likelihood(lab, mean, icov)
    skin_color = (dist < 9.0) & (lab[..., 0] > 0.3 * mean[0])
    head_zone = np.zeros_like(person)
    head_zone[: int(sh_y - 0.02 * H), :] = 255
    zones = head_zone.copy()
    for _, _, corridor in arms_geo:
        zones |= corridor
    zones |= hands
    skin = np.where(skin_color & (zones > 0) & (person > 0), 255, 0).astype(np.uint8)
    skin = cv2.morphologyEx(skin, cv2.MORPH_OPEN, _disk(2))
    skin = cv2.morphologyEx(skin, cv2.MORPH_CLOSE, _disk(3))

    # ── top: GrabCut seeded by the body ──
    gc = np.full((h, w), cv2.GC_BGD, np.uint8)
    band = (person > 0).copy()
    band[: int(sh_y - 0.06 * H), :] = False
    band[int(hip_y + 0.35 * (knee_y - hip_y)):, :] = False
    gc[band] = cv2.GC_PR_FGD
    lower = (person > 0).copy()
    lower[: int(hip_y - 0.05 * torso_len), :] = False
    gc[lower & (gc == cv2.GC_BGD)] = cv2.GC_PR_BGD
    gc[(person > 0) & ~band & ~lower] = cv2.GC_PR_BGD
    # sure top: the chest, between the shoulders, above the hips
    cx = (ls[0] + rs[0]) / 2
    half = abs(ls[0] - rs[0]) / 2
    y_a, y_b = int(sh_y + 0.12 * torso_len), int(sh_y + 0.70 * torso_len)
    core = np.zeros((h, w), bool)
    core[y_a:y_b, int(cx - 0.55 * half): int(cx + 0.55 * half)] = True
    gc[core & (person > 0) & (skin == 0)] = cv2.GC_FGD
    # sure not top: skin, legs, the head above the collar
    legs = (person > 0).copy()
    legs[: int(hip_y + 0.45 * (knee_y - hip_y)), :] = False
    gc[legs] = cv2.GC_BGD
    gc[skin > 0] = cv2.GC_BGD
    gc[: int(sh_y - 0.08 * H), :] = cv2.GC_BGD
    gc[person == 0] = cv2.GC_BGD

    ys, xs = np.nonzero(person)
    pad = 10
    y0c, y1c = max(0, ys.min() - pad), min(h, ys.max() + pad)
    x0c, x1c = max(0, xs.min() - pad), min(w, xs.max() + pad)
    sub = gc[y0c:y1c, x0c:x1c].copy()
    s = min(1.0, 520.0 / max(sub.shape))
    small_img = cv2.resize(work[y0c:y1c, x0c:x1c], None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    small_gc = cv2.resize(sub, (small_img.shape[1], small_img.shape[0]), interpolation=cv2.INTER_NEAREST)
    bgd, fgd = np.zeros((1, 65)), np.zeros((1, 65))
    try:
        cv2.grabCut(small_img, small_gc, None, bgd, fgd, 6, cv2.GC_INIT_WITH_MASK)
    except cv2.error as exc:  # pragma: no cover - degenerate photos
        raise ParseError(f"couldn't separate the top: {exc}") from exc
    res = np.where((small_gc == cv2.GC_FGD) | (small_gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    res = cv2.resize(res, (sub.shape[1], sub.shape[0]), interpolation=cv2.INTER_LINEAR)
    top = np.zeros((h, w), np.uint8)
    top[y0c:y1c, x0c:x1c] = np.where(res > 127, 255, 0)
    top &= person
    top[skin > 0] = 0
    top = cv2.morphologyEx(top, cv2.MORPH_OPEN, _disk(3))
    top = cv2.morphologyEx(top, cv2.MORPH_CLOSE, _disk(5))
    seed = np.zeros_like(top)
    seed[core] = 255
    top = _keep_touching(top, seed)
    if top.sum() < 0.02 * person.sum():
        raise ParseError("couldn't find the top in the photo")

    # Trims GrabCut gives to the trousers (a black collar band or sleeve cuff
    # looks like black jeans): non-skin pixels of the person on the upper
    # arms, and around the neck below the chin, belong to the top.
    trims = np.zeros_like(top)
    for _, pts, corridor in arms_geo:
        up = _polyline_mask(person.shape, [pts[0], pts[0] + 0.85 * (pts[1] - pts[0])], arm_r * 1.25)
        trims |= up & corridor
    mouth_y = (lm[9, 1] + lm[10, 1]) / 2
    chin_y = mouth_y + 0.9 * (mouth_y - lm[P.NOSE, 1])
    neck = np.zeros_like(top)
    x_l, x_r = sorted((ls[0], rs[0]))
    neck[int(chin_y): int(sh_y + 0.02 * H), int(x_l): int(x_r)] = 255
    trims |= neck
    extra = np.where((trims > 0) & (person > 0) & (skin == 0) & (top == 0), 255, 0).astype(np.uint8)
    # And anything else of the person between the chin and the hem that isn't
    # skin or a hand: shoulder stripes, piping, a logo GrabCut doubted.
    hem0 = np.nonzero(top[:, int((ls[0] + rs[0]) / 2) - 3: int((ls[0] + rs[0]) / 2) + 4].any(axis=1))[0]
    hem0 = int(hem0[-1]) if len(hem0) else int(hip_y)
    band = np.zeros_like(top)
    band[int(chin_y): int(hem0 - 0.05 * torso_len), :] = 255
    lower_arms = np.zeros_like(top)
    for _, pts, _c in arms_geo:
        lower_arms |= _polyline_mask(person.shape, [pts[1], pts[2], pts[3]], arm_r * 1.3)
    extra |= np.where((band > 0) & (person > 0) & (skin == 0) & (hands == 0) & (lower_arms == 0), 255, 0).astype(np.uint8)
    extra = cv2.morphologyEx(extra, cv2.MORPH_OPEN, _disk(1))
    top = _keep_touching(top | extra, top)

    # ── per-row torso extent (top minus sleeves) and key lines ──
    centre = (cx + (lh[0] + rh[0]) / 2) / 2
    top_rows = np.nonzero(top.any(axis=1))[0]
    collar_y = int(top_rows[0])
    col_c = top[:, int(cx) - 3: int(cx) + 4].any(axis=1)
    cr = np.nonzero(col_c)[0]
    hem_y = int(cr[-1]) if len(cr) else int(hip_y)

    arms: list[Arm] = []
    for side, pts, corridor in arms_geo:
        sh, el, wr, ix = (np.asarray(p, np.float64) for p in pts)
        arms.append(Arm(side, sh, el, wr, ix, arm_r, corridor, np.zeros_like(top), np.zeros_like(top), 0.0))

    # Torso rows: the run of the top containing the centre. Below the armpit
    # the arm hangs beside the torso, so clip at the arm's inner edge; between
    # the shoulder joint and the armpit the side seam is a straight line.
    armpit_y = sh_y + 0.21 * torso_len
    raw_rows: dict[int, tuple[int, int]] = {}
    for y in range(collar_y, hem_y + 1):
        line = top[y] > 0
        c = int(centre)
        if not line[c]:
            # Around a V-neck the centre is skin: take the top's extent
            # between the shoulders instead.
            if y > sh_y + 0.15 * torso_len:
                continue
            lo_x, hi_x = int(min(ls[0], rs[0])), int(max(ls[0], rs[0]))
            xs_ = np.nonzero(line[lo_x: hi_x + 1])[0]
            if len(xs_) < 2:
                continue
            x0, x1 = lo_x + int(xs_[0]), lo_x + int(xs_[-1])
            while x0 > 0 and line[x0 - 1]:
                x0 -= 1
            while x1 < w - 1 and line[x1 + 1]:
                x1 += 1
            raw_rows[y] = (x0, x1)
            continue
        x0 = x1 = c
        while x0 > 0 and line[x0 - 1]:
            x0 -= 1
        while x1 < w - 1 and line[x1 + 1]:
            x1 += 1
        if y > armpit_y:
            for arm in arms:
                ax = _arm_x(arm, y)
                if ax is not None and x0 < ax < x1:
                    step = 1 if ax < centre else -1
                    xi = int(ax)
                    if skin[y, xi]:
                        # Bare arm against the torso: clip at the skin's inner edge.
                        while 0 < xi < w - 1 and skin[y, xi] and abs(xi - ax) < 2.5 * arm.radius:
                            xi += step
                        edge = xi
                    else:
                        edge = int(ax + step * 0.9 * arm.radius)
                    if step > 0:
                        x0 = max(x0, edge)
                    else:
                        x1 = min(x1, edge)
        raw_rows[y] = (x0, x1)
    ref_y = min((y for y in raw_rows if y > armpit_y + 0.04 * torso_len), default=None)
    left_arm = min(arms, key=lambda a: a.shoulder[0])
    right_arm = max(arms, key=lambda a: a.shoulder[0])
    torso_rows: dict[int, tuple[int, int]] = {}
    for y, (x0, x1) in raw_rows.items():
        if ref_y is not None and sh_y <= y <= ref_y:
            t = (y - sh_y) / max(ref_y - sh_y, 1)
            lx = left_arm.shoulder[0] + t * (raw_rows[ref_y][0] - left_arm.shoulder[0])
            rx = right_arm.shoulder[0] + t * (raw_rows[ref_y][1] - right_arm.shoulder[0])
            x0, x1 = max(x0, int(lx)), min(x1, int(rx))
        torso_rows[y] = (x0, x1)
    torso_top = np.zeros_like(top)
    for y, (x0, x1) in torso_rows.items():
        torso_top[y, x0: x1 + 1] = top[y, x0: x1 + 1]
    sleeves_all = np.where((top > 0) & (torso_top == 0), 255, 0).astype(np.uint8)
    sleeves_all[: int(sh_y - 0.03 * H), :] = 0
    # Below the armpit, cloth beside the torso is the torso's side, not a sleeve
    # (unless it's on the arm itself).
    for arm in arms:
        below = np.zeros_like(top)
        below[int(armpit_y + 0.14 * torso_len):, :] = 255
        sleeves_all[(below > 0) & (arm.corridor == 0)] = 0
    torso_top |= np.where((top > 0) & (sleeves_all == 0), 255, 0).astype(np.uint8) & np.where(
        np.arange(h)[:, None] > armpit_y, 255, 0).astype(np.uint8)
    for arm in arms:
        side_mask = np.zeros_like(top)
        if arm is left_arm:
            side_mask[:, : int(centre)] = 255
        else:
            side_mask[:, int(centre):] = 255
        arm.sleeve = sleeves_all & side_mask
        arm.skin = np.where((skin > 0) & (arm.corridor > 0) & (head_zone == 0), 255, 0).astype(np.uint8)
        arm.sleeve_end = _sleeve_end(arm)

    # ── the rest of the person ──
    head = np.where((person > 0) & (top == 0) & (np.arange(h)[:, None] < collar_y + 0.04 * H), 255, 0).astype(np.uint8)
    head[int(sh_y + 0.05 * H):, :] = 0
    for arm in arms:
        head[arm.corridor > 0] = 0
    shoes_y = int(ankle_y + 0.012 * H)
    shoes = person.copy()
    shoes[:shoes_y, :] = 0
    bottom = np.where((person > 0) & (top == 0) & (skin == 0) & (hands == 0), 255, 0).astype(np.uint8)
    bottom[: int(hem_y - 0.02 * H), :] = 0
    bottom[shoes_y:, :] = 0
    bottom = cv2.morphologyEx(bottom, cv2.MORPH_OPEN, _disk(2))

    # Where a mid-rise waistband sits: ~6 cm above the hip joints.
    waistband_y = int(hip_y - 6.0 / cm_per_px)

    tops_ = []
    for sx in (ls[0], rs[0]):
        col = int(0.8 * sx + 0.2 * centre)
        r_ = np.nonzero(top[:, max(col - 2, 0): col + 3].any(axis=1))[0]
        if len(r_):
            tops_.append(float(r_[0]))
    shoulder_top_y = float(np.mean(tops_)) if tops_ else float(sh_y - 0.08 * torso_len)
    plate = background_plate(work, person)
    shade, shade_smooth = garment_shading(work, top)

    log.info("parsed %s photo: body %d px, top %d px, hem y=%d", view, int(H), int(top.sum() / 255), hem_y)
    return Parsed(
        image=work, scale=scale, view=view, lm=lm, person=person, skin=skin, head=head,
        top=top, torso_top=torso_top, bottom=bottom, shoes=shoes, hands=hands, arms=arms,
        background=plate, cm_per_px=cm_per_px, skin_lab=(mean, icov),
        collar_y=collar_y, hem_y=hem_y, waistband_y=waistband_y, torso_rows=torso_rows,
        shoulder_y=float(sh_y), shoulder_top_y=shoulder_top_y, armpit_y=float(armpit_y), hip_y=float(hip_y), torso_len=float(torso_len),
        shade=shade, shade_smooth=shade_smooth,
    )


def _arm_x(arm: Arm, y: float) -> float | None:
    """x where the arm's centre-line crosses row y."""
    for a, b in ((arm.shoulder, arm.elbow), (arm.elbow, arm.wrist), (arm.wrist, arm.hand)):
        lo, hi = sorted((a[1], b[1]))
        if lo <= y <= hi and hi - lo > 1e-3:
            t = (y - a[1]) / (b[1] - a[1])
            return float(a[0] + t * (b[0] - a[0]))
    return None


def _sleeve_end(arm: Arm) -> float:
    """How far down the arm (0 = shoulder, 1 = wrist) the sleeve reaches."""
    ys, xs = np.nonzero(arm.sleeve)
    if len(ys) == 0:
        return 0.0
    axis = arm.wrist - arm.shoulder
    L2 = float(axis @ axis) or 1.0
    t = ((xs - arm.shoulder[0]) * axis[0] + (ys - arm.shoulder[1]) * axis[1]) / L2
    return float(np.clip(np.percentile(t, 98), 0.0, 1.0))


def garment_shading(image: np.ndarray, mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Split the top's brightness into print and light.

    The top's colours are clustered (a striped jersey: white, sky blue, black
    trim, gold badge); within a cluster every pixel is the same cloth, so how
    much darker it is than that cloth's lit value is pure light and fold. The
    result re-lights a different garment with the folds and light of this
    photo, and lets a tight size smooth the folds away.
    """
    h, w = mask.shape
    S = np.ones((h, w), np.float32)
    sel = mask > 0
    if sel.sum() < 200:
        return S, S.copy()
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    px = lab[sel]
    feats = np.stack([px[:, 1], px[:, 2], px[:, 0] * 0.35], 1).astype(np.float32)
    k = 5
    cv2.setRNGSeed(0)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, _ = cv2.kmeans(feats, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    labels = labels.ravel()
    L = px[:, 0]
    alb = np.array([np.percentile(L[labels == i], 92) if (labels == i).any() else 255.0 for i in range(k)])
    counts = np.bincount(labels, minlength=k)
    major = counts >= 0.06 * len(labels)  # the cloth itself, not its badges and trims
    vals = np.clip(L / np.maximum(alb[labels], 1.0), 0.3, 1.15)
    good = np.zeros((h, w), bool)
    good[sel] = major[labels]
    S[sel] = vals
    # Body-scale light: a normalised blur over trustworthy cloth pixels only.
    m = good.astype(np.float32)
    sig = 0.012 * max(h, w)
    num = cv2.GaussianBlur(S * m, (0, 0), sig)
    den = cv2.GaussianBlur(m, (0, 0), sig)
    smooth = np.where(den > 1e-3, num / np.maximum(den, 1e-3), 1.0).astype(np.float32)
    # Badges, trims and the anti-aliased edges between print colours get the
    # local body light instead of a value that is mostly print.
    edges = cv2.morphologyEx(labels_img(labels, sel, h, w), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    S = np.where(good & ~edges, S, smooth)
    S = cv2.medianBlur(S.astype(np.float32), 5)
    S = cv2.GaussianBlur(S, (0, 0), 1.2)
    S[~sel] = 1.0
    smooth[~sel] = 1.0
    return S.astype(np.float32), smooth


def labels_img(labels: np.ndarray, sel: np.ndarray, h: int, w: int) -> np.ndarray:
    img = np.zeros((h, w), np.uint8)
    img[sel] = (labels + 1).astype(np.uint8) * 40
    return img
