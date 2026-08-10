"""Multi-frame shape fusion and metric scale resolution (S6/S7).

Fusion is where the accuracy comes from. Per-frame monocular estimates are
noisy; combining them well is worth more than a better single-frame model.

Two decisions carry most of the weight:

1. **Robust averaging, not the mean.** One badly-fit frame — a motion blur, a
   partial occlusion — moves a mean substantially. Median-seeded Huber
   weighting down-weights outliers instead of letting them vote.

2. **Pose is never fused.** It is a nuisance parameter: we want the body, not
   the stance. Fusing pose across frames of a rotating subject would be
   meaningless. It is retained per frame for the texture bake's camera solve.
"""

from __future__ import annotations

import logging
import time

import numpy as np

from ..errors import insufficient_frames
from ..schemas import FuseRequest, FuseResponse, PerFrameEstimate, ScaleResult

log = logging.getLogger(__name__)

# Huber threshold in units of scaled MAD. Beyond this a frame is down-weighted.
HUBER_DELTA = 1.345
HUBER_ITERATIONS = 6

# Population mean stature, used only when nothing better is available.
# Source: broad adult averages; deliberately coarse because this rung of the
# ladder is a last resort and should carry visible uncertainty.
_PRIOR_HEIGHT_CM = {"FEMALE": 164.0, "MALE": 177.0, "UNSPECIFIED": 170.5}

CANONICAL_HEIGHT_CM = 175.0


def fuse(req: FuseRequest) -> FuseResponse:
    started = time.perf_counter()

    if not req.perFrame:
        raise insufficient_frames("no per-frame estimates to fuse")

    matrix = _shape_matrix(req.perFrame)
    shape, confidence, outliers = _robust_average(matrix)

    coverage = _coverage_degrees(req.perFrame)
    scale = resolve_scale(req.userHeightCm, req.sexAtBirth)
    quality = _overall_quality(
        frame_count=len(req.perFrame),
        outlier_count=len(outliers),
        coverage_deg=coverage,
        confidence=confidence,
        scale=scale,
    )

    log.info(
        "fused %d frames: %d outliers, %.0f° coverage, scale=%s, quality=%.2f",
        len(req.perFrame),
        len(outliers),
        coverage,
        scale.source,
        quality,
    )

    return FuseResponse(
        shape=shape.tolist(),
        shapeConfidence=confidence.tolist(),
        outlierFrames=outliers,
        scale=scale,
        coverageDegrees=coverage,
        overallQuality=quality,
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


def _shape_matrix(per_frame: list[PerFrameEstimate]) -> np.ndarray:
    width = max(len(f.shape) for f in per_frame)
    matrix = np.zeros((len(per_frame), width), dtype=np.float64)
    for row, frame in enumerate(per_frame):
        vals = np.asarray(frame.shape, dtype=np.float64)
        matrix[row, : len(vals)] = vals
    return matrix


def _robust_average(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray, list[int]]:
    """Median-seeded, Huber-weighted per-coefficient average.

    Returns (shape, confidence, outlier_frame_indices). Confidence is derived
    from inter-frame agreement — storing uncertainty alongside the estimate is
    what separates a measurement from a guess (docs/03 §3).
    """
    n_frames, n_dims = matrix.shape

    if n_frames == 1:
        # A single frame cannot disagree with itself; confidence is capped low
        # to reflect that we have no corroboration, not high because variance
        # is zero.
        return matrix[0].copy(), np.full(n_dims, 0.35), []

    estimate = np.median(matrix, axis=0)
    weights = np.ones(n_frames, dtype=np.float64)

    for _ in range(HUBER_ITERATIONS):
        residuals = matrix - estimate[None, :]
        # Per-frame residual magnitude across all coefficients.
        magnitude = np.linalg.norm(residuals, axis=1)

        mad = np.median(np.abs(magnitude - np.median(magnitude)))
        scale = max(1.4826 * mad, 1e-6)
        normalised = magnitude / scale

        weights = np.where(
            normalised <= HUBER_DELTA,
            1.0,
            HUBER_DELTA / np.maximum(normalised, 1e-9),
        )

        total = weights.sum()
        if total < 1e-9:
            break
        estimate = (matrix * weights[:, None]).sum(axis=0) / total

    # A frame contributing under half the nominal weight is an outlier.
    outliers = [int(i) for i, w in enumerate(weights) if w < 0.5]

    # Confidence from per-coefficient spread, using weighted variance so an
    # outlier frame does not deflate confidence in the coefficients the good
    # frames agreed on.
    weight_sum = max(weights.sum(), 1e-9)
    weighted_var = (weights[:, None] * (matrix - estimate[None, :]) ** 2).sum(axis=0) / weight_sum
    spread = np.sqrt(weighted_var)

    # Map spread → confidence. 0 spread ⇒ ~1.0; spread of 1.0 (a full standard
    # deviation of the coefficient prior) ⇒ ~0.5.
    confidence = 1.0 / (1.0 + spread)

    # More agreeing frames is genuinely more evidence.
    corroboration = min(1.0, (n_frames - len(outliers)) / 8.0)
    confidence = np.clip(confidence * (0.55 + 0.45 * corroboration), 0.0, 1.0)

    return estimate, confidence, outliers


def resolve_scale(user_height_cm: float | None, sex: str | None) -> ScaleResult:
    """Resolve metric scale down the ladder in docs/01 §S7.

    Monocular reconstruction is scale-ambiguous — a tall person far away is
    pixel-identical to a short person nearby. No amount of model quality fixes
    this; it needs an external anchor. Scale is therefore returned with its
    provenance so downstream consumers can judge how much to trust it, rather
    than receiving a number that looks equally authoritative either way.
    """
    # Rung 1: the user told us. One number, reliable, and users know it.
    if user_height_cm is not None and 50.0 <= user_height_cm <= 260.0:
        return ScaleResult(
            source="USER_HEIGHT",
            heightCm=float(user_height_cm),
            confidence=0.92,
            metricScale=float(user_height_cm / CANONICAL_HEIGHT_CM),
        )

    # Rungs 2 and 3 (ARKit depth, reference object) are not implemented in v1.
    # ARKit is the largest single accuracy win available and is scheduled for
    # M5+ (docs/06 §8).

    # Rung 4: population prior. Wide error bars, and the confidence says so.
    prior = _PRIOR_HEIGHT_CM.get(sex or "UNSPECIFIED", _PRIOR_HEIGHT_CM["UNSPECIFIED"])
    return ScaleResult(
        source="STATISTICAL_PRIOR",
        heightCm=prior,
        confidence=0.35,
        metricScale=float(prior / CANONICAL_HEIGHT_CM),
    )


def _coverage_degrees(per_frame: list[PerFrameEstimate]) -> float:
    """Angular span actually observed.

    Eight excellent frontal frames give ~0° of coverage and a hallucinated
    back. This is the number that should drive how confident the UI sounds.
    """
    yaws = [f.camera.subjectYawDeg for f in per_frame if f.camera.subjectYawDeg is not None]
    if len(yaws) < 2:
        return 0.0

    # Sum the gaps between adjacent observed angles, capped at 360°, so eight
    # frames clustered at the front score low even though min/max is wide.
    ordered = sorted(float(y) % 360.0 for y in yaws)
    covered = 0.0
    # Each observation is treated as covering ±22.5°, a rough single-view span.
    half_span = 22.5
    intervals = [((y - half_span) % 360.0, (y + half_span) % 360.0) for y in ordered]

    marks = np.zeros(360, dtype=bool)
    for start, end in intervals:
        s, e = int(start), int(end)
        if s <= e:
            marks[s:e] = True
        else:
            marks[s:] = True
            marks[:e] = True
    covered = float(marks.sum())

    return min(360.0, covered)


def _overall_quality(
    *,
    frame_count: int,
    outlier_count: int,
    coverage_deg: float,
    confidence: np.ndarray,
    scale: ScaleResult,
) -> float:
    """A single 0..1 figure the app can use to set expectations honestly."""
    good_frames = max(0, frame_count - outlier_count)

    frame_term = min(1.0, good_frames / 12.0)
    coverage_term = min(1.0, coverage_deg / 300.0)
    confidence_term = float(np.mean(confidence)) if confidence.size else 0.0
    scale_term = float(scale.confidence or 0.3)

    return float(
        np.clip(
            0.30 * frame_term + 0.30 * coverage_term + 0.25 * confidence_term + 0.15 * scale_term,
            0.0,
            1.0,
        )
    )
