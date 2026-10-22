"""Person detection, 2-D pose and person matte from a single photo.

Backed by MediaPipe Pose (BlazePose GHUM, Apache-2.0): one CPU forward pass
returns 33 keypoints with per-point visibility *and* a person segmentation
mask. That covers the three things the scan needs from a pretrained model —
"is there a person", "where are their joints", "which pixels are them" — in
about a second per photo on a laptop CPU, with no GPU and no licence risk.

The matte is then refined with GrabCut seeded from MediaPipe's own confidence
bands. MediaPipe's mask is soft at the edges by design; measurement needs a
crisp boundary, because a 3-pixel halo on a 900-pixel-tall body is already a
~0.6 cm error on every width.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field

import cv2
import numpy as np

log = logging.getLogger(__name__)

# MediaPipe landmark indices used by the scan.
NOSE = 0
L_EAR, R_EAR = 7, 8
L_SHOULDER, R_SHOULDER = 11, 12
L_ELBOW, R_ELBOW = 13, 14
L_WRIST, R_WRIST = 15, 16
L_INDEX, R_INDEX = 19, 20  # index fingertips
L_HIP, R_HIP = 23, 24
L_KNEE, R_KNEE = 25, 26
L_ANKLE, R_ANKLE = 27, 28
L_HEEL, R_HEEL = 29, 30

# Work resolution. MediaPipe internally runs at 256 px, so feeding it a 12 MP
# phone photo only costs decode time; the mask is upsampled back afterwards.
_MAX_SIDE = 1280


@dataclass
class PoseResult:
    """Keypoints in pixel coordinates of the *original* image."""

    landmarks: np.ndarray | None  # (33, 4): x_px, y_px, z, visibility
    mask: np.ndarray  # (H, W) uint8, 255 = person
    image_shape: tuple[int, int]
    # Areas of every blob in the raw matte, largest first. A second large blob
    # usually means another person or a person-shaped object in frame.
    raw_components: list[int] = field(default_factory=list)

    @property
    def detected(self) -> bool:
        return self.landmarks is not None

    def point(self, idx: int) -> np.ndarray:
        assert self.landmarks is not None
        return self.landmarks[idx, :2]

    def vis(self, idx: int) -> float:
        return 0.0 if self.landmarks is None else float(self.landmarks[idx, 3])


class _Detector:
    """Process-wide MediaPipe instance. Not thread-safe, so calls are serialised."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pose = None

    def _ensure(self):
        if self._pose is None:
            import mediapipe as mp  # noqa: PLC0415 — heavy import, only when scanning

            complexity = int(os.getenv("SCAN_POSE_COMPLEXITY", "2"))
            self._pose = mp.solutions.pose.Pose(
                static_image_mode=True,
                model_complexity=complexity,
                enable_segmentation=True,
                min_detection_confidence=0.5,
            )
            log.info("MediaPipe pose ready (complexity=%d)", complexity)
        return self._pose

    def run(self, rgb: np.ndarray):
        with self._lock:
            return self._ensure().process(rgb)


_detector = _Detector()


def warmup() -> None:
    """Load the model now rather than on the first scan."""
    _detector.run(np.zeros((256, 256, 3), np.uint8))


def detect(image_bgr: np.ndarray, refine: bool = True) -> PoseResult:
    h, w = image_bgr.shape[:2]
    scale = min(1.0, _MAX_SIDE / max(h, w))
    work = (
        cv2.resize(image_bgr, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        if scale < 1.0
        else image_bgr
    )

    res = _detector.run(cv2.cvtColor(work, cv2.COLOR_BGR2RGB))

    landmarks = None
    if res.pose_landmarks is not None:
        landmarks = np.array(
            [[p.x * w, p.y * h, p.z, p.visibility] for p in res.pose_landmarks.landmark],
            dtype=np.float32,
        )

    if res.segmentation_mask is not None:
        soft = cv2.resize(res.segmentation_mask, (w, h), interpolation=cv2.INTER_LINEAR)
    else:
        soft = np.zeros((h, w), np.float32)

    raw = _binarise(soft)
    comps = component_stats(raw)
    mask = refine_mask(image_bgr, soft) if refine and landmarks is not None else raw
    if comps:
        mask = largest_component(mask)
    return PoseResult(landmarks=landmarks, mask=mask, image_shape=(h, w), raw_components=comps)


def _binarise(soft: np.ndarray) -> np.ndarray:
    return np.where(soft > 0.5, 255, 0).astype(np.uint8)


def refine_mask(image_bgr: np.ndarray, soft: np.ndarray) -> np.ndarray:
    """Sharpen MediaPipe's soft matte with GrabCut.

    Confident interior (>0.85) and confident background (<0.1) are fixed; only
    the uncertain band in between is re-labelled from colour statistics. Falls
    back to the plain threshold if GrabCut fails or wildly changes the area —
    a refinement step must never be the thing that ruins a scan.
    """
    base = _binarise(soft)
    h, w = base.shape
    s = min(1.0, 640 / max(h, w))
    small = cv2.resize(image_bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    ssoft = cv2.resize(soft, (small.shape[1], small.shape[0]), interpolation=cv2.INTER_LINEAR)

    gc = np.full(ssoft.shape, cv2.GC_PR_BGD, np.uint8)
    gc[ssoft > 0.5] = cv2.GC_PR_FGD
    gc[ssoft > 0.85] = cv2.GC_FGD
    gc[ssoft < 0.1] = cv2.GC_BGD
    if not (gc == cv2.GC_FGD).any() or not (gc == cv2.GC_BGD).any():
        return base

    try:
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)
        cv2.grabCut(small, gc, None, bgd, fgd, 3, cv2.GC_INIT_WITH_MASK)
    except cv2.error as exc:
        log.debug("grabCut refinement failed: %s", exc)
        return base

    refined = np.where((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    refined = cv2.resize(refined, (w, h), interpolation=cv2.INTER_NEAREST)
    refined = cv2.morphologyEx(refined, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    a0, a1 = int((base > 0).sum()), int((refined > 0).sum())
    if a0 == 0 or not (0.85 < a1 / a0 < 1.15):
        return base
    return largest_component(refined)


def largest_component(mask: np.ndarray) -> np.ndarray:
    """Keep the biggest connected blob — the person — and fill its holes."""
    n, labels, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    if n <= 1:
        return mask
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    out = np.where(labels == biggest, 255, 0).astype(np.uint8)
    # Fill interior holes (e.g. the gap under a bent arm) but not the gap
    # between the legs, which touches the image border via the floor.
    flood = out.copy()
    ff = np.zeros((out.shape[0] + 2, out.shape[1] + 2), np.uint8)
    cv2.floodFill(flood, ff, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    small_holes = np.zeros_like(out)
    n2, l2, s2, _ = cv2.connectedComponentsWithStats((holes > 0).astype(np.uint8), 8)
    body_area = int((out > 0).sum())
    for i in range(1, n2):
        if s2[i, cv2.CC_STAT_AREA] < 0.01 * body_area:
            small_holes[l2 == i] = 255
    return cv2.bitwise_or(out, small_holes)


def component_stats(mask: np.ndarray) -> list[int]:
    """Areas of every foreground blob, largest first."""
    n, _, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8), 8)
    return sorted((int(a) for a in stats[1:, cv2.CC_STAT_AREA]), reverse=True)
