"""Silhouette anthropometry from four calibrated views.

Method
------
Each photo yields a binary person silhouette. The user's stated height fixes
the scale of each view independently (cm per pixel = height / silhouette
height), so the four photos need not be taken from the same distance.

Measurement *heights* (chest line, natural waist, hip, upper thigh, …) are
located on the body from detected joints — shoulder, hip and knee keypoints —
not from fixed population ratios, so a long-torsoed person gets their chest
measured at their chest. Ratios are only the fallback when a joint is missing.

At each height:
  * front & back views give the body's **width**  (averaged: two observations)
  * left & right views give its **depth**         (averaged: two observations)
and the girth is the perimeter of a superellipse with those axes. The
exponent per region encodes how boxy that cross-section is (a chest is
squarer than an ellipse, a thigh is close to one). Lengths come from joint
positions (arm) or silhouette landmarks (crotch → floor for the inseam).

This is the classical two-view photogrammetric approach. Its known failure
modes — loose clothing, arms touching the torso, long hair over the neck —
are exactly what the quality checks look for, and what the confidence score
is built to reflect. Nothing here is fitted to the evaluation data; see
scripts/validate-bodym.py and docs/validation/ for measured accuracy.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import pose as P

VIEWS = ("front", "back", "left", "right")

# Fallback landmark heights as fractions of stature from the floor (ANSUR II
# population means). Used only when the joint detector misses a joint.
DEFAULT_FRACTIONS = {
    "shoulder": 0.818,
    "hip_joint": 0.525,
    "knee": 0.285,
    "crotch": 0.467,
}

# Cross-section shape factor: true girth ÷ perimeter of the ellipse with the
# same breadth and depth. Torso sections are boxier than ellipses, so a pure
# ellipse under-reads them. Values are ANSUR II population means (circumference
# vs. breadth/depth pairs: chest ≈ 1.10, waist ≈ 1.065, buttock ≈ 1.065);
# limbs and neck are close to elliptical. Not fitted to any evaluation set.
SHAPE_FACTOR = {
    "chest": 1.10,
    "waist": 1.065,
    "hip": 1.065,
    "thigh": 1.0,
    "calf": 1.0,
    "neck": 1.0,
}

# The detector's shoulder keypoint sits at the shoulder joint centre; the
# acromion (shoulder-seam point) lies ~1.2% of stature further out each side.
ACROMION_OFFSET = 0.012

MEASUREMENT_ORDER = [
    "height",
    "chest",
    "waist",
    "hip",
    "shoulder_width",
    "inseam",
    "thigh",
    "arm_length",
    "neck",
    "torso_length",
    "calf",
]

LABELS = {
    "height": "Height",
    "chest": "Chest",
    "waist": "Waist",
    "hip": "Hip",
    "shoulder_width": "Shoulder width",
    "inseam": "Inseam",
    "thigh": "Thigh",
    "arm_length": "Arm length",
    "neck": "Neck",
    "torso_length": "Torso length",
    "calf": "Calf",
}

KIND = {
    "height": "length",
    "chest": "girth",
    "waist": "girth",
    "hip": "girth",
    "shoulder_width": "width",
    "inseam": "length",
    "thigh": "girth",
    "arm_length": "length",
    "neck": "girth",
    "torso_length": "length",
    "calf": "girth",
}

# Prior reliability of each *method*, before any per-scan evidence.
METHOD_PRIOR = {
    "height": 1.0,  # user-supplied calibration anchor
    "chest": 0.85,
    "waist": 0.85,
    "hip": 0.85,
    "shoulder_width": 0.78,
    "inseam": 0.85,
    "thigh": 0.75,
    "arm_length": 0.85,
    "neck": 0.65,
    "torso_length": 0.85,
    "calf": 0.72,
}

_ACCURACY_FILE = Path(__file__).with_name("accuracy.json")


@dataclass
class ViewData:
    view: str
    mask: np.ndarray  # uint8, 255 = person
    pose: P.PoseResult | None = None
    quality: float = 1.0
    top: int = 0
    bottom: int = 0

    def __post_init__(self) -> None:
        rows = np.nonzero((self.mask > 0).any(axis=1))[0]
        if len(rows) == 0:
            raise ValueError(f"{self.view}: empty silhouette")
        self.top, self.bottom = int(rows[0]), int(rows[-1])

    @property
    def height_px(self) -> int:
        return max(1, self.bottom - self.top)

    def row_at(self, frac: float) -> int:
        """Image row at `frac` of stature above the floor."""
        r = int(round(self.bottom - frac * self.height_px))
        return int(np.clip(r, 0, self.mask.shape[0] - 1))

    def frac_of(self, y: float) -> float:
        return (self.bottom - y) / self.height_px

    def has_pose(self) -> bool:
        return self.pose is not None and self.pose.detected


@dataclass
class Measurement:
    name: str
    value: float
    confidence: float
    method: str
    sources: list[str]
    kind: str
    region: dict = field(default_factory=dict)
    typical_error_cm: float | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "label": LABELS[self.name],
            "value": round(self.value, 1),
            "unit": "cm",
            "confidence": round(self.confidence, 2),
            "method": self.method,
            "sources": self.sources,
            "kind": self.kind,
            "region": self.region,
            "typicalErrorCm": self.typical_error_cm,
        }


# ─────────────────────────── geometry helpers ───────────────────────────


def runs(mask: np.ndarray, row: int) -> list[tuple[int, int]]:
    """Foreground runs [x0, x1] (inclusive) on one image row."""
    line = (mask[row] > 0).astype(np.int8)
    if not line.any():
        return []
    d = np.diff(np.concatenate([[0], line, [0]]))
    starts = np.nonzero(d == 1)[0]
    ends = np.nonzero(d == -1)[0] - 1
    return list(zip(starts.tolist(), ends.tolist(), strict=True))


def _centre_x(v: ViewData, row: int) -> float:
    """Body centre line at a row: hip-midpoint from pose, else mask centroid."""
    if v.has_pose():
        lh, rh = v.pose.point(P.L_HIP), v.pose.point(P.R_HIP)
        ls, rs = v.pose.point(P.L_SHOULDER), v.pose.point(P.R_SHOULDER)
        return float((lh[0] + rh[0] + ls[0] + rs[0]) / 4.0)
    xs = np.nonzero(v.mask[v.top : v.bottom + 1].any(axis=0))[0]
    cols = np.nonzero(v.mask[row] > 0)[0]
    return float(cols.mean()) if len(cols) else float(xs.mean())


def _arm_x_at(v: ViewData, y: float) -> list[float]:
    """x positions where each arm's centre-line crosses row `y` (front/back).

    The chain runs shoulder → elbow → wrist → fingertip: with arms hanging at
    the sides the hands sit at hip height, and without the hand segment they
    would be measured as hip.
    """
    if not v.has_pose():
        return []
    out = []
    for s, e, w, f in ((P.L_SHOULDER, P.L_ELBOW, P.L_WRIST, P.L_INDEX),
                       (P.R_SHOULDER, P.R_ELBOW, P.R_WRIST, P.R_INDEX)):
        pts = [v.pose.point(s), v.pose.point(e), v.pose.point(w), v.pose.point(f)]
        for a, b in ((pts[0], pts[1]), (pts[1], pts[2]), (pts[2], pts[3])):
            lo, hi = sorted((a[1], b[1]))
            if lo <= y <= hi and hi - lo > 1e-3:
                t = (y - a[1]) / (b[1] - a[1])
                out.append(float(a[0] + t * (b[0] - a[0])))
                break
    return out


def torso_span(v: ViewData, frac: float, clip_arms: bool) -> tuple[float, int] | None:
    """Width (px) of the body's central run at `frac`, with merged arms cut off."""
    row = v.row_at(frac)
    rr = runs(v.mask, row)
    if not rr:
        return None
    cx = _centre_x(v, row)
    run = min(rr, key=lambda r: 0 if r[0] <= cx <= r[1] else min(abs(r[0] - cx), abs(r[1] - cx)))
    x0, x1 = float(run[0]), float(run[1])

    if clip_arms:
        # An arm resting against the torso merges into the same run. Where the
        # arm's centre-line falls inside the run, cut at its inner edge.
        arm_r = 0.022 * v.height_px
        for ax in _arm_x_at(v, row):
            if x0 < ax < x1:
                if ax < cx:
                    x0 = max(x0, ax + arm_r)
                else:
                    x1 = min(x1, ax - arm_r)
    width = x1 - x0 + 1.0
    return (width, row) if width > 2 else None


def _arms_separate(v: ViewData, frac: float) -> bool:
    """True when, at this height, the torso run has a separate run (an arm)
    on each side of it."""
    row = v.row_at(frac)
    rr = runs(v.mask, row)
    cx = _centre_x(v, row)
    centre = [r for r in rr if r[0] <= cx <= r[1]]
    if not centre:
        return False
    c = centre[0]
    return any(r[1] < c[0] for r in rr) and any(r[0] > c[1] for r in rr)


def leg_spans(v: ViewData, frac: float) -> list[float]:
    """Widths (px) of the separate leg runs at `frac` (front/back view)."""
    row = v.row_at(frac)
    cx = _centre_x(v, row)
    rr = runs(v.mask, row)
    # Legs are the two runs nearest the centre line, one each side.
    left = [r for r in rr if r[1] < cx]
    right = [r for r in rr if r[0] > cx]
    out = []
    if left:
        r = max(left, key=lambda r: r[1])
        out.append(float(r[1] - r[0] + 1))
    if right:
        r = min(right, key=lambda r: r[0])
        out.append(float(r[1] - r[0] + 1))
    if not out:
        merged = [r for r in rr if r[0] <= cx <= r[1]]
        if merged:  # legs together / skirt: half the merged run
            out.append(float(merged[0][1] - merged[0][0] + 1) / 2.0)
    return out


def ellipse_perimeter(a: float, b: float) -> float:
    """Ramanujan's second approximation (error < 1e-4 for body proportions)."""
    h = ((a - b) / (a + b)) ** 2
    return float(math.pi * (a + b) * (1 + 3 * h / (10 + math.sqrt(4 - 3 * h))))


def girth(width: float, depth: float, region: str) -> float:
    return ellipse_perimeter(width / 2, depth / 2) * SHAPE_FACTOR[region]


def crotch_frac(v: ViewData, knee_f: float, hip_f: float) -> float | None:
    """Height (stature fraction) of the crotch: where the gap between the legs
    begins, found by walking *down* the body centre line from the hip joint.

    Walking up from the knee instead stops wherever touching inner thighs
    close the gap and reads the inseam ~10 cm short. When the thighs touch
    right up to the crotch there is no visible notch at all; the first gap is
    then far below the hips, fails the anatomical check, and the caller falls
    back to the population crotch-height ratio rather than trust it.
    """
    for frac in np.arange(hip_f, knee_f, -0.002):
        row = v.row_at(float(frac))
        cx = int(np.clip(round(_centre_x(v, row)), 0, v.mask.shape[1] - 1))
        # Look at a small window: the notch at the crotch can be 1–2 px wide.
        lo, hi = max(0, cx - 2), min(v.mask.shape[1], cx + 3)
        if (v.mask[row, lo:hi] == 0).any():
            # Anatomical sanity: the crotch sits just below the hip joint.
            # Further down, the "gap" is mid-thigh (thighs touching above it),
            # clothing, or a segmentation hole.
            if 0.005 <= hip_f - frac <= 0.06:
                return float(frac)
            return None
    return None


def shoulder_line_frac(v: ViewData, rise: float = 0.5) -> float | None:
    """Shoulder height read straight off the silhouette: the level where the
    outline widens from neck to shoulders. `rise` picks the point on that
    slope: 0.5 ≈ the acromion (shoulder seam), 0.15 ≈ the high point of the
    shoulder where it meets the neck (HPS, the garment industry's origin for
    torso length). Independent of the joint detector, whose shoulder keypoint
    is the joint centre — several cm below the shoulder line people measure from.
    """
    def w(f: float) -> float:
        s = torso_span(v, f, clip_arms=False)
        return s[0] / v.height_px if s else 0.0

    neck = min(w(float(f)) for f in np.linspace(0.84, 0.90, 13))
    full = max(w(float(f)) for f in np.linspace(0.74, 0.80, 13))
    if not (0.03 < neck < 0.16 and full > neck * 1.8):
        return None
    threshold = neck + rise * (full - neck)
    for f in np.arange(0.90, 0.74, -0.002):
        if w(float(f)) >= threshold:
            return float(f)
    return None


# ─────────────────────────── landmark levels ───────────────────────────


@dataclass
class Levels:
    shoulder: float
    hip_joint: float
    knee: float
    from_pose: bool
    visibility: float

    @property
    def chest(self) -> float:
        return self.shoulder - 0.33 * (self.shoulder - self.hip_joint)

    @property
    def waist_window(self) -> tuple[float, float]:
        span = self.shoulder - self.hip_joint
        return self.hip_joint + 0.22 * span, self.hip_joint + 0.55 * span

    @property
    def hip_window(self) -> tuple[float, float]:
        return self.hip_joint - 0.06, self.hip_joint + 0.02


def find_levels(front: ViewData | None, back: ViewData | None) -> Levels:
    lv = _pose_levels(front, back)
    ref = front or back
    line = shoulder_line_frac(ref) if ref is not None else None
    if line is not None:
        lv.shoulder = line
    return lv


def _pose_levels(front: ViewData | None, back: ViewData | None) -> Levels:
    for v in (front, back):
        if v is None or not v.has_pose():
            continue
        p = v.pose
        idx = (P.L_SHOULDER, P.R_SHOULDER, P.L_HIP, P.R_HIP, P.L_KNEE, P.R_KNEE)
        vis = float(np.mean([p.vis(i) for i in idx]))
        if vis < 0.5:
            continue
        sh = v.frac_of((p.point(P.L_SHOULDER)[1] + p.point(P.R_SHOULDER)[1]) / 2)
        hp = v.frac_of((p.point(P.L_HIP)[1] + p.point(P.R_HIP)[1]) / 2)
        kn = v.frac_of((p.point(P.L_KNEE)[1] + p.point(P.R_KNEE)[1]) / 2)
        # Reject anatomically impossible detections rather than measure them.
        if 0.7 < sh < 0.9 and 0.42 < hp < 0.62 and 0.18 < kn < 0.38:
            return Levels(sh, hp, kn, True, vis)
    d = DEFAULT_FRACTIONS
    return Levels(d["shoulder"], d["hip_joint"], d["knee"], False, 0.0)


# ─────────────────────────── the extractor ───────────────────────────


def _load_accuracy() -> dict[str, float]:
    try:
        data = json.loads(_ACCURACY_FILE.read_text(encoding="utf-8"))
        return {k: float(v["mae_cm"]) for k, v in data.get("measurements", {}).items()}
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def _pair_mean(values: list[float]) -> tuple[float | None, float]:
    """Mean of up to two observations + their agreement (1 = identical)."""
    vals = [x for x in values if x is not None and x > 0]
    if not vals:
        return None, 0.0
    if len(vals) == 1:
        return vals[0], 0.8
    m = float(np.mean(vals))
    rel = abs(vals[0] - vals[1]) / m
    return m, float(np.clip(1.0 - 2.5 * rel, 0.3, 1.0))


def extract(views: dict[str, ViewData], height_cm: float) -> dict[str, Measurement]:
    """Measure a body from up to four silhouettes. Front + one side is the
    minimum for girths; all four make every girth a two-observation average."""
    front, back = views.get("front"), views.get("back")
    sides = [views[k] for k in ("left", "right") if k in views]
    fb = [v for v in (front, back) if v is not None]
    if not fb or not sides:
        raise ValueError("need at least one front/back view and one side view")

    cm = {k: height_cm / v.height_px for k, v in views.items()}  # cm per px
    lv = find_levels(front, back)
    accuracy = _load_accuracy()
    pose_factor = lv.visibility if lv.from_pose else 0.7
    q_fb = min(v.quality for v in fb)
    q_side = min(v.quality for v in sides)
    out: dict[str, Measurement] = {}

    def add(name: str, value: float | None, agree: float, quality: float, method: str,
            sources: list[str], region: dict, pose_used: bool = True) -> None:
        if value is None or not math.isfinite(value) or value <= 0:
            return
        conf = METHOD_PRIOR[name] * agree * quality * (pose_factor if pose_used else 1.0)
        out[name] = Measurement(
            name=name,
            value=float(value),
            confidence=float(np.clip(conf, 0.05, 0.99)),
            method=method,
            sources=sources,
            kind=KIND[name],
            region=region,
            typical_error_cm=accuracy.get(name),
        )

    # Height is the calibration anchor, so it is exact by construction.
    add("height", height_cm, 1.0, 1.0, "user-provided (scale anchor)", [],
        {"kind": "length", "y0": 0.0, "y1": 1.0, "side": "full"}, pose_used=False)

    # ── torso girths: width (front/back) × depth (sides) ──
    def girth_at(frac: float, region: str) -> tuple[float | None, float]:
        widths = []
        for v in fb:
            s = torso_span(v, frac, clip_arms=True)
            widths.append(s[0] * cm[v.view] if s else None)
        depths = []
        for v in sides:
            s = torso_span(v, frac, clip_arms=False)
            depths.append(s[0] * cm[v.view] if s else None)
        w, aw = _pair_mean(widths)
        d, ad = _pair_mean(depths)
        if w is None or d is None:
            return None, 0.0
        return girth(w, d, region), min(aw, ad)

    def scan_window(lo: float, hi: float, pick) -> float:
        """Stature fraction in [lo, hi] where front width is min/max."""
        ref = front or back
        best_f, best_w = (lo + hi) / 2, None
        for f in np.linspace(lo, hi, 25):
            s = torso_span(ref, float(f), clip_arms=True)
            if s and (best_w is None or pick(s[0], best_w)):
                best_f, best_w = float(f), s[0]
        return best_f

    # Chest girth is taken at the armpit line: the highest level where both
    # arms are separate from the torso in the front view. Higher than that the
    # arms merge into the outline; the clipped estimate is the fallback.
    # Crotch first: the hip window must stay above it, or a low hip keypoint
    # lets the "widest point" search land on the upper thighs (and on loose
    # trousers, which are widest there).
    ref = front or back
    cf_found = crotch_frac(ref, lv.knee, lv.hip_joint)

    chest_f = lv.chest
    span = lv.shoulder - lv.hip_joint
    for f in np.arange(lv.hip_joint + 0.78 * span, lv.hip_joint + 0.50 * span, -0.003):
        if _arms_separate(front or back, float(f)):
            chest_f = float(f) - 0.005
            break
    waist_f = scan_window(*lv.waist_window, pick=lambda a, b: a < b)
    crotch_ref = cf_found if cf_found is not None else DEFAULT_FRACTIONS["crotch"]
    hip_lo, hip_hi = lv.hip_window
    hip_lo = max(hip_lo, crotch_ref + 0.015)
    hip_f = scan_window(hip_lo, max(hip_hi, hip_lo + 0.02), pick=lambda a, b: a > b)
    method_girth = "front/back width × side depth, elliptical section × ANSUR shape factor"
    for name, f in (("chest", chest_f), ("waist", waist_f), ("hip", hip_f)):
        g, agree = girth_at(f, name)
        add(name, g, agree, min(q_fb, q_side), method_girth, [v.view for v in fb + sides],
            {"kind": "girth", "y": round(f, 3), "side": "torso"})

    # ── neck: narrowest point just above the shoulder line ──
    # The band is kept tight: any higher and the narrowest "neck" is the chin
    # or face (and, from the side, the beard), which reads several cm large.
    neck_f = scan_window(lv.shoulder + 0.012, lv.shoulder + 0.032, pick=lambda a, b: a < b)
    g, agree = girth_at(neck_f, "neck")
    add("neck", g, agree, min(q_fb, q_side), method_girth, [v.view for v in fb + sides],
        {"kind": "girth", "y": round(neck_f, 3), "side": "torso"})

    # ── crotch → inseam, torso length ──
    cf = cf_found
    crotch_found = cf is not None
    if cf is None:
        cf = DEFAULT_FRACTIONS["crotch"]
    add("inseam", cf * height_cm, 1.0 if crotch_found else 0.6, q_fb,
        "crotch-to-floor from silhouette leg gap" if crotch_found else "population ratio (leg gap not visible)",
        [ref.view], {"kind": "length", "y0": 0.0, "y1": round(cf, 3), "side": "leg"},
        pose_used=False)
    hps = shoulder_line_frac(ref, rise=0.15) or (lv.shoulder + 0.015)
    add("torso_length", (hps - cf) * height_cm, 1.0 if crotch_found else 0.7, q_fb,
        "high shoulder point to crotch", [ref.view],
        {"kind": "length", "y0": round(cf, 3), "y1": round(hps, 3), "side": "torso"})

    # ── legs: per-leg width (front/back) × leg depth (sides) ──
    def leg_girth(frac: float, region: str) -> tuple[float | None, float]:
        widths = []
        for v in fb:
            spans = leg_spans(v, frac)
            widths.append(float(np.mean(spans)) * cm[v.view] if spans else None)
        depths = []
        for v in sides:
            s = torso_span(v, frac, clip_arms=False)
            depths.append(s[0] * cm[v.view] if s else None)
        w, aw = _pair_mean(widths)
        d, ad = _pair_mean(depths)
        if w is None or d is None:
            return None, 0.0
        return girth(w, d, region), min(aw, ad)

    thigh_f = cf - 0.02
    g, agree = leg_girth(thigh_f, "thigh")
    add("thigh", g, agree * (1.0 if crotch_found else 0.6), min(q_fb, q_side),
        "upper-thigh width × depth, ellipse", [v.view for v in fb + sides],
        {"kind": "girth", "y": round(thigh_f, 3), "side": "leg"})

    calf_best, calf_f = None, lv.knee - 0.08
    for f in np.linspace(lv.knee - 0.13, lv.knee - 0.04, 12):
        spans = leg_spans(ref, float(f))
        if spans and (calf_best is None or np.mean(spans) > calf_best):
            calf_best, calf_f = float(np.mean(spans)), float(f)
    g, agree = leg_girth(calf_f, "calf")
    add("calf", g, agree, min(q_fb, q_side), "calf width × depth, ellipse",
        [v.view for v in fb + sides], {"kind": "girth", "y": round(calf_f, 3), "side": "leg"})

    # ── shoulder width: joint-to-joint distance + acromion offset ──
    widths = []
    for v in fb:
        if v.has_pose() and min(v.pose.vis(P.L_SHOULDER), v.pose.vis(P.R_SHOULDER)) > 0.5:
            joint = abs(v.pose.point(P.L_SHOULDER)[0] - v.pose.point(P.R_SHOULDER)[0]) * cm[v.view]
            widths.append(joint + 2 * ACROMION_OFFSET * height_cm)
    w, agree = _pair_mean(widths)
    if w is not None:
        add("shoulder_width", w, agree, q_fb, "shoulder joints + acromion offset",
            [v.view for v in fb], {"kind": "width", "y": round(lv.shoulder, 3), "side": "torso"})
    else:
        add("shoulder_width", 0.232 * height_cm, 0.5, q_fb, "population ratio (shoulders not detected)",
            [], {"kind": "width", "y": 0.818, "side": "torso"}, pose_used=False)

    # ── arm length: shoulder → elbow → wrist along the joints ──
    arm_vals, arm_vis = [], []
    for v in fb:
        if not v.has_pose():
            continue
        p = v.pose
        for s_, e_, w_ in ((P.L_SHOULDER, P.L_ELBOW, P.L_WRIST), (P.R_SHOULDER, P.R_ELBOW, P.R_WRIST)):
            vis = min(p.vis(s_), p.vis(e_), p.vis(w_))
            if vis < 0.5:
                continue
            length = (np.linalg.norm(p.point(e_) - p.point(s_))
                      + np.linalg.norm(p.point(w_) - p.point(e_))) * cm[v.view]
            arm_vals.append(float(length))
            arm_vis.append(vis)
    if arm_vals:
        spread = (max(arm_vals) - min(arm_vals)) / float(np.mean(arm_vals)) if len(arm_vals) > 1 else 0.1
        add("arm_length", float(np.median(arm_vals)), float(np.clip(1 - 2 * spread, 0.4, 1.0)),
            q_fb, "shoulder–elbow–wrist joint chain", [v.view for v in fb],
            {"kind": "length", "y0": round(lv.hip_joint, 3), "y1": round(lv.shoulder, 3), "side": "arm"})
    else:
        add("arm_length", 0.272 * height_cm, 0.5, q_fb, "population ratio (arms not detected)",
            [], {"kind": "length", "y0": 0.53, "y1": 0.81, "side": "arm"}, pose_used=False)

    _flag_implausible(out, height_cm)
    return {k: out[k] for k in MEASUREMENT_ORDER if k in out}


# Plausible range of each girth as a fraction of stature (≈ ANSUR II 1st–99th
# percentile, widened). Outside it, the outline is almost certainly clothing,
# hair or a merged limb rather than body — say so instead of reporting it
# with the same confidence as a clean reading.
PLAUSIBLE = {
    "chest": (0.42, 0.75),
    "waist": (0.33, 0.72),
    "hip": (0.47, 0.78),
    "thigh": (0.26, 0.45),
    "calf": (0.18, 0.28),
    "neck": (0.17, 0.25),
}


def _flag_implausible(out: dict[str, Measurement], height_cm: float) -> None:
    for name, (lo, hi) in PLAUSIBLE.items():
        m = out.get(name)
        if m is None:
            continue
        r = m.value / height_cm
        if r > hi:
            m.confidence = max(0.05, m.confidence * 0.4)
            m.method += " — unusually large for your height; likely loose clothing or hair"
        elif r < lo:
            m.confidence = max(0.05, m.confidence * 0.4)
            m.method += " — unusually small for your height; likely occluded"


def overall_confidence(meas: dict[str, Measurement]) -> float:
    """Mean confidence of the measurements a fit decision actually leans on."""
    core = [m.confidence for k, m in meas.items() if k in ("chest", "waist", "hip", "inseam", "shoulder_width")]
    return float(np.mean(core)) if core else 0.0
