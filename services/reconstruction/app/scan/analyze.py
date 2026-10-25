"""Four-view scan analysis: validate → measure → fit the 3D body."""

from __future__ import annotations

import logging
import time

import cv2
import numpy as np

from . import body_fit, measure, quality
from . import pose as P

log = logging.getLogger(__name__)

REQUIRED_VIEWS = ("front", "back", "left", "right")
ENGINE_VERSION = "scan-v1 (mediapipe-pose-heavy + silhouette anthropometry)"

# Small photos are enlarged before analysis. On the sample scan, girths drift
# up as the person's pixel height falls (the matte's soft edge becomes a larger
# share of every width): a cubic upscale first roughly halves that drift for
# people 350–700 px tall. It adds no detail, so the quality gate still judges
# the photo at its original size.
UPSCALE_BELOW = 1280  # long side
UPSCALE_TO = 2048  # the web app's upload cap, so every photo is analysed alike


def _for_analysis(image: np.ndarray) -> tuple[np.ndarray, float]:
    """The image to analyse, and how much it was enlarged."""
    h, w = image.shape[:2]
    long_side = max(h, w)
    if long_side >= UPSCALE_BELOW or long_side < quality.MIN_IMAGE_SIDE:
        return image, 1.0
    s = UPSCALE_TO / long_side
    return cv2.resize(image, (round(w * s), round(h * s)), interpolation=cv2.INTER_CUBIC), s


def use_anny() -> bool:
    """The Anny body unless switched off (SCAN_BODY_MODEL=humanoid) or not
    installed — then the parametric humanoid, as before."""
    import os  # noqa: PLC0415

    if os.getenv("SCAN_BODY_MODEL", "anny").lower() == "humanoid":
        return False
    from ..bodymodel import anny_body  # noqa: PLC0415

    return anny_body.available()


def _fit_anny(meas: dict, height_cm: float, sex: str | None) -> dict:
    from . import anny_fit  # noqa: PLC0415

    targets = {
        k: anny_fit.Target(m.value, m.confidence, m.region.get("y"))
        for k, m in meas.items()
        if k != "height"
    }
    return anny_fit.fit(targets, height_cm, sex=sex).to_dict()


def analyze(images: dict[str, np.ndarray], height_cm: float, fit_body: bool = True,
            sex: str | None = None) -> dict:
    started = time.perf_counter()
    missing = [v for v in REQUIRED_VIEWS if v not in images]

    per_view: dict[str, quality.ViewQuality] = {}
    detections: dict[str, P.PoseResult] = {}
    for view, image in images.items():
        work, scale = _for_analysis(image)
        det = P.detect(work)
        detections[view] = det
        per_view[view] = quality.assess(view, work, det, source_scale=scale)

    issues = [
        {"view": v, **i.to_dict()} for v, q in per_view.items() for i in q.issues
    ]
    for v in missing:
        issues.append({
            "view": v,
            "code": "MISSING_VIEW",
            "severity": "error",
            "message": f"The {v} photo is missing.",
        })

    accepted = not missing and all(q.ok for q in per_view.values())
    result: dict = {
        "status": "accepted" if accepted else "rejected",
        "engineVersion": ENGINE_VERSION,
        "views": [per_view[v].to_dict() for v in REQUIRED_VIEWS if v in per_view],
        "issues": issues,
        "measurements": [],
        "confidence": {"overall": 0.0},
        "body": None,
    }
    if not accepted:
        result["elapsedMs"] = int((time.perf_counter() - started) * 1000)
        return _plain(result)

    views = {
        v: measure.ViewData(v, detections[v].mask, detections[v], quality=per_view[v].score)
        for v in REQUIRED_VIEWS
    }
    meas = measure.extract(views, height_cm)
    overall = measure.overall_confidence(meas)
    scan_quality = float(np.mean([q.score for q in per_view.values()]))
    result["measurements"] = [m.to_dict() for m in meas.values()]
    result["confidence"] = {
        "overall": round(overall, 2),
        "scanQuality": round(scan_quality, 2),
        "label": _label(overall),
    }

    if fit_body:
        body = None
        if use_anny():
            try:
                body = _fit_anny(meas, height_cm, sex)
            except Exception as exc:  # noqa: BLE001 — a body is still owed
                log.warning("Anny fit failed, using the parametric humanoid: %s", exc)
        if body is None:
            body = body_fit.fit({k: m.value for k, m in meas.items()}, height_cm).to_dict()
        result["body"] = body

    result["elapsedMs"] = int((time.perf_counter() - started) * 1000)
    result = _plain(result)
    log.info(
        "scan analysed: %d measurements, confidence %.2f, %d ms",
        len(meas), overall, result["elapsedMs"],
    )
    return result


def _label(conf: float) -> str:
    # Words, not a false-precision percentage, for the headline indicator.
    if conf >= 0.75:
        return "high"
    if conf >= 0.55:
        return "medium"
    return "low"


def _plain(obj):
    """numpy scalars/arrays → Python types, so the result serialises as JSON."""
    if isinstance(obj, dict):
        return {k: _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    if isinstance(obj, np.generic):
        return obj.item()
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    return obj
