"""Frame quality scoring and selection (S3).

This is the highest-leverage cheap stage in the pipeline. Frame selection
affects the final result more than any hyperparameter downstream, and it costs
milliseconds of CPU.

The non-obvious part: we do not simply take the N sharpest frames. Eight
excellent frontal frames are worth far less than eight mediocre frames spanning
360°, because the reconstruction needs *coverage*. Selection therefore
maximises angular spread subject to a quality floor.
"""

from __future__ import annotations

import logging
import time

import cv2
import numpy as np

from ..errors import insufficient_frames
from ..schemas import ScoredFrame, SelectRequest, SelectResponse
from ..storage import fetch_image

log = logging.getLogger(__name__)

# Below this, the frame is too soft to contribute useful detail.
SHARPNESS_FLOOR = 12.0
# Fraction of pixels allowed to clip at either end before we call it unusable.
CLIP_LIMIT = 0.28
# Perceptual-hash Hamming distance under which two frames are near-duplicates.
DUPLICATE_DISTANCE = 6


def _sharpness(gray: np.ndarray) -> float:
    """Variance of the Laplacian. Higher is sharper."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def _exposure(gray: np.ndarray) -> float:
    """1.0 = well exposed, 0.0 = badly clipped."""
    hist = cv2.calcHist([gray], [0], None, [256], [0, 256]).flatten()
    total = hist.sum()
    if total == 0:
        return 0.0
    shadows = hist[:8].sum() / total
    highlights = hist[248:].sum() / total
    clipped = shadows + highlights
    return float(max(0.0, 1.0 - clipped / CLIP_LIMIT))


def _phash(gray: np.ndarray) -> np.ndarray:
    """64-bit perceptual hash via DCT, for near-duplicate rejection."""
    small = cv2.resize(gray, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
    dct = cv2.dct(small)[:8, :8]
    return (dct > np.median(dct)).flatten()


def _hamming(a: np.ndarray, b: np.ndarray) -> int:
    return int(np.count_nonzero(a != b))


def _subject_coverage(gray: np.ndarray) -> float:
    """Rough fraction of the frame occupied by a foreground subject.

    Cheap stand-in for a detector: high-gradient regions concentrate on the
    subject against a plain background, which is the capture we ask for.
    """
    edges = cv2.Canny(gray, 60, 160)
    return float(np.count_nonzero(edges) / edges.size)


def select_frames(req: SelectRequest) -> SelectResponse:
    started = time.perf_counter()

    scored: list[dict] = []
    hashes: list[np.ndarray] = []

    for cand in req.frames:
        img = fetch_image(cand.imageUrl)
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

        sharp = _sharpness(gray)
        expo = _exposure(gray)
        cover = _subject_coverage(gray)
        phash = _phash(gray)

        reject: str | None = None
        if sharp < SHARPNESS_FLOOR:
            reject = "blurry"
        elif expo <= 0.0:
            reject = "exposure"
        elif any(_hamming(phash, h) < DUPLICATE_DISTANCE for h in hashes):
            reject = "duplicate"

        if reject is None:
            hashes.append(phash)

        # Normalise sharpness with a soft saturation — beyond a point, sharper
        # stops helping, and a linear term would let one crisp frame dominate.
        sharp_norm = float(sharp / (sharp + 60.0))
        quality = 0.5 * sharp_norm + 0.3 * expo + 0.2 * min(1.0, cover * 8.0)

        scored.append(
            {
                "index": cand.index,
                "key": cand.key,
                "sharpness": sharp,
                "exposure": expo,
                "quality": quality,
                "reject": reject,
            }
        )

    usable = [s for s in scored if s["reject"] is None]
    if not usable:
        # Report the dominant failure so the user gets a specific instruction.
        reasons = [s["reject"] for s in scored]
        if reasons.count("blurry") >= len(reasons) / 2:
            from ..errors import input_too_blurry

            raise input_too_blurry("all frames below sharpness floor")
        if reasons.count("exposure") >= len(reasons) / 2:
            from ..errors import input_too_dark

            raise input_too_dark("all frames badly exposed")
        raise insufficient_frames("no usable frames after quality filtering")

    selected_indices = _spread_select(usable, req.targetCount)

    frames = [
        ScoredFrame(
            index=s["index"],
            key=s["key"],
            sharpness=s["sharpness"],
            exposure=s["exposure"],
            qualityScore=s["quality"],
            selected=s["index"] in selected_indices,
            rejectReason=s["reject"],
        )
        for s in scored
    ]

    log.info(
        "selected %d of %d candidates (%d usable)",
        len(selected_indices),
        len(scored),
        len(usable),
    )

    return SelectResponse(
        frames=frames,
        selectedCount=len(selected_indices),
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


def _spread_select(usable: list[dict], target: int) -> set[int]:
    """Pick `target` frames spread evenly across the capture, best-in-bucket.

    Temporal position stands in for viewing angle: in a 360° capture the
    subject rotates roughly uniformly with time, so even temporal spread
    approximates even angular coverage. When S5 returns real per-frame yaw we
    can replace this proxy with the measured angle — the interface does not
    change.
    """
    if len(usable) <= target:
        return {s["index"] for s in usable}

    ordered = sorted(usable, key=lambda s: s["index"])
    buckets: list[list[dict]] = [[] for _ in range(target)]
    for position, frame in enumerate(ordered):
        bucket = min(target - 1, position * target // len(ordered))
        buckets[bucket].append(frame)

    chosen: set[int] = set()
    for bucket in buckets:
        if bucket:
            best = max(bucket, key=lambda s: s["quality"])
            chosen.add(best["index"])

    return chosen
