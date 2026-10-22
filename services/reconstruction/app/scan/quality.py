"""Per-view scan quality checks.

Each check returns an *issue* with a severity and a message written for the
person holding the phone — what is wrong and what to do about it. Errors block
the scan (measuring a cropped or empty photo would only produce confident
nonsense); warnings lower the confidence of the measurements that depend on
that view.

Thresholds are deliberately forgiving: the goal is to reject *obviously* bad
input, not to make a good scan hard to take.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from . import pose as P

FRONT_BACK = ("front", "back")
SIDES = ("left", "right")

# Resolution is judged by how many pixels tall the *person* is in the original
# photo, not by the photo's size: a 360×640 portrait the person fills is
# measurable; a 4000 px photo they stand small in is not. Measured on the sample
# scan (deviation from full resolution, after analyze's upscale): ~1–2 cm while
# the person is ≥ ~350 px tall, 3–6 cm below ~300 px.
MIN_IMAGE_SIDE = 300  # long side; nothing smaller can hold a measurable person
MIN_BODY_PX = 300  # below this: reject
LOW_BODY_PX = 600  # below this: accept, but warn and lower confidence


@dataclass
class Issue:
    code: str
    severity: str  # "error" | "warning"
    message: str

    def to_dict(self) -> dict:
        return {"code": self.code, "severity": self.severity, "message": self.message}


@dataclass
class ViewQuality:
    view: str
    score: float = 1.0
    issues: list[Issue] = field(default_factory=list)
    metrics: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not any(i.severity == "error" for i in self.issues)

    def error(self, code: str, message: str) -> None:
        self.issues.append(Issue(code, "error", message))
        self.score = 0.0

    def warn(self, code: str, message: str, penalty: float) -> None:
        self.issues.append(Issue(code, "warning", message))
        self.score = max(0.0, self.score * (1.0 - penalty))

    def to_dict(self) -> dict:
        return {
            "view": self.view,
            "ok": self.ok,
            "score": round(self.score, 2),
            "issues": [i.to_dict() for i in self.issues],
            "metrics": self.metrics,
        }


def assess(
    view: str, image: np.ndarray, det: P.PoseResult, source_scale: float = 1.0
) -> ViewQuality:
    """`source_scale`: how much `image` was enlarged from the uploaded photo
    (analyze upscales small photos). Resolution and sharpness are judged at
    the photo's original size — enlarging adds no detail."""
    q = ViewQuality(view)
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    ow, oh = round(w / source_scale), round(h / source_scale)
    q.metrics["resolution"] = [ow, oh]

    if max(ow, oh) < MIN_IMAGE_SIDE:
        q.error(
            "LOW_RESOLUTION",
            f"This photo is only {ow}×{oh} pixels — too small to measure. "
            "Use the original photo from your camera, not a screenshot or thumbnail.",
        )
        return q

    # ── exposure ──
    brightness = float(gray.mean())
    q.metrics["brightness"] = round(brightness, 1)
    if brightness < 35:
        q.error("TOO_DARK", "This photo is too dark. Turn on more lights or face a window.")
    elif brightness < 60:
        q.warn("DIM", "The lighting is a little dim — brighter light gives cleaner edges.", 0.15)
    elif brightness > 235:
        q.error("OVEREXPOSED", "This photo is washed out. Move away from direct light.")

    # ── person ──
    if not det.detected:
        q.error("NO_PERSON", "We couldn't find a person in this photo. Stand fully in frame.")
        return q

    mask = det.mask > 0
    rows = np.nonzero(mask.any(axis=1))[0]
    if len(rows) == 0:
        q.error("NO_PERSON", "We couldn't separate you from the background. Try a plainer wall.")
        return q
    top, bottom = int(rows[0]), int(rows[-1])
    body_h = bottom - top
    q.metrics["bodyHeightFraction"] = round(body_h / h, 3)

    # ── resolution: the person's height in original pixels ──
    body_px = body_h / source_scale
    q.metrics["bodyHeightPx"] = round(body_px)
    if body_px < MIN_BODY_PX:
        q.error(
            "LOW_RESOLUTION",
            f"This photo is too low-resolution to measure — you're only {body_px:.0f} pixels "
            "tall in it. Use the original photo from your camera (not a screenshot or a "
            "compressed copy), with you filling most of the frame.",
        )
    elif body_px < LOW_BODY_PX:
        q.warn(
            "LOW_DETAIL",
            "This photo is fairly low resolution, so measurements from it are less precise. "
            "The original photo from your camera works best.",
            0.2,
        )

    # ── sharpness, on the person only ──
    ys, xs = np.nonzero(mask)
    x0, x1 = int(xs.min()), int(xs.max())
    crop = gray[top : bottom + 1, x0 : x1 + 1]
    # At most 600 px, and never above the original resolution: an upscaled
    # copy is smoother than the photo it came from and would read as blurry.
    scale = min(600.0, max(crop.shape) / source_scale) / max(crop.shape)
    if scale < 1:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    sharpness = float(cv2.Laplacian(crop, cv2.CV_64F).var())
    q.metrics["sharpness"] = round(sharpness, 1)
    if sharpness < 15:
        q.error("BLURRY", "This photo is blurry. Hold the phone still or use the timer.")
    elif sharpness < 40:
        q.warn("SOFT", "This photo is slightly soft — a steadier shot will measure better.", 0.15)

    # ── framing ──
    margin = 0.005 * h
    if top <= margin:
        q.error("HEAD_CUT_OFF", "Your head is cut off. Step back so there's space above you.")
    if bottom >= h - 1 - margin:
        q.error("FEET_CUT_OFF", "Your feet are cut off. Step back or tilt the phone down.")
    if body_h / h < 0.35:
        q.error("TOO_FAR", "You're too far away. Fill at least half the photo's height.")
    elif body_h / h < 0.55:
        q.warn("SMALL_IN_FRAME", "Stand a little closer — you should fill most of the frame.", 0.1)

    lm = det.landmarks
    ankles_vis = min(det.vis(P.L_ANKLE), det.vis(P.R_ANKLE))
    if ankles_vis < 0.3:
        q.warn("FEET_HIDDEN", "We can't see your feet clearly. Make sure they're in the photo.", 0.2)

    # ── other people / clutter ──
    comps = det.raw_components
    if len(comps) > 1 and comps[1] > 0.25 * comps[0]:
        q.warn(
            "BACKGROUND_CLUTTER",
            "Something else in the photo looks like a person. Use a plain background.",
            0.2,
        )

    # ── orientation: is this the view the slot says it is? ──
    shoulder_w = abs(lm[P.L_SHOULDER, 0] - lm[P.R_SHOULDER, 0]) / max(body_h, 1)
    q.metrics["shoulderRatio"] = round(float(shoulder_w), 3)
    if view in FRONT_BACK and shoulder_w < 0.10:
        q.error(
            "WRONG_VIEW",
            f"This looks like a side view, but it's in the {view} slot. "
            f"Face {'the camera' if view == 'front' else 'away from the camera'}.",
        )
    elif view in SIDES and shoulder_w > 0.16:
        q.error(
            "WRONG_VIEW",
            f"This looks like a front or back view, but it's in the {view}-side slot. "
            "Turn 90° so your side faces the camera.",
        )

    # ── pose: arms away from the body in the front/back views ──
    if view in FRONT_BACK and q.ok:
        hip_l, hip_r = lm[P.L_HIP, 0], lm[P.R_HIP, 0]
        lo, hi = min(hip_l, hip_r), max(hip_l, hip_r)
        hip_w = hi - lo
        wl, wr = lm[P.L_WRIST, 0], lm[P.R_WRIST, 0]
        # Wrists should sit clearly outside the hips (A-pose).
        out_l = min(abs(wl - lo), abs(wl - hi)) if not (lo < wl < hi) else 0.0
        out_r = min(abs(wr - lo), abs(wr - hi)) if not (lo < wr < hi) else 0.0
        if min(out_l, out_r) < 0.25 * hip_w:
            q.warn(
                "ARMS_TOO_CLOSE",
                "Hold your arms slightly away from your body so we can see your waist.",
                0.2,
            )
        ankle_gap = abs(lm[P.L_ANKLE, 0] - lm[P.R_ANKLE, 0])
        if ankle_gap < 0.6 * hip_w:
            q.warn(
                "FEET_TOGETHER",
                "Stand with your feet about hip-width apart.",
                0.1,
            )

    return q
