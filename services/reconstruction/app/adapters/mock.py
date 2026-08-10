"""Deterministic adapters for development and CI.

These are not throwaway stubs. They derive a plausible body from actual image
content — silhouette proportions drive the shape vector — so the full pipeline
produces a real, viewable, downloadable avatar with no weights and no GPU.

That matters for three reasons: the mobile app has something to render on day
one, CI can assert end-to-end behaviour, and every stage downstream of
inference (fusion, scale, texture, export) gets exercised for real rather than
being taken on faith until weights arrive.
"""

from __future__ import annotations

import hashlib
import logging

import cv2
import numpy as np

from ..bodymodel.humanoid import SHAPE_DIMS
from ..schemas import CameraParams, PerFrameEstimate

log = logging.getLogger(__name__)


class MockSegmentationAdapter:
    """Foreground matte via saliency-ish heuristics.

    Real enough to produce a usable silhouette on a plain-background capture,
    which is the capture guided mode asks for.
    """

    id = "mock-v1"

    def warmup(self) -> None:
        return None

    def segment(self, image: np.ndarray) -> np.ndarray:
        h, w = image.shape[:2]

        # GrabCut seeded with a centre rectangle: the subject is centred by
        # construction because guided capture puts them in a silhouette overlay.
        rect = (int(w * 0.12), int(h * 0.04), int(w * 0.76), int(h * 0.92))
        mask = np.zeros((h, w), np.uint8)
        bgd = np.zeros((1, 65), np.float64)
        fgd = np.zeros((1, 65), np.float64)

        try:
            work = cv2.resize(image, (min(w, 320), min(h, 480)), interpolation=cv2.INTER_AREA)
            sh, sw = work.shape[:2]
            srect = (
                int(sw * 0.12),
                int(sh * 0.04),
                int(sw * 0.76),
                int(sh * 0.92),
            )
            smask = np.zeros((sh, sw), np.uint8)
            cv2.grabCut(work, smask, srect, bgd, fgd, 3, cv2.GC_INIT_WITH_RECT)
            binary = np.where((smask == cv2.GC_FGD) | (smask == cv2.GC_PR_FGD), 255, 0).astype(
                np.uint8
            )
            mask = cv2.resize(binary, (w, h), interpolation=cv2.INTER_LINEAR)
        except cv2.error as exc:  # noqa: BLE001
            log.warning("grabCut failed (%s), falling back to rect mask", exc)
            x, y, rw, rh = rect
            mask[y : y + rh, x : x + rw] = 255

        # Soften the edge — a hard binary matte visibly clips hair and clothing.
        alpha = cv2.GaussianBlur(mask, (9, 9), 0).astype(np.float32) / 255.0
        return np.clip(alpha, 0.0, 1.0)


class MockBodyAdapter:
    """Derives shape from the observed silhouette.

    Deliberately not random: the same person photographed twice should produce
    a similar body. Silhouette width profile drives girth/shoulder/hip
    coefficients, and a content hash supplies stable fine detail.
    """

    id = "mock-v1"
    body_model = "MHR"
    body_model_version = "1.0-mock"

    def warmup(self) -> None:
        return None

    def infer(
        self, image: np.ndarray, mask: np.ndarray | None, index: int
    ) -> PerFrameEstimate:
        h, w = image.shape[:2]

        if mask is None:
            gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
            _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            alpha = binary.astype(np.float32) / 255.0
        else:
            alpha = mask

        shape = self._shape_from_silhouette(alpha, image)

        # Yaw proxy: in a 360° capture the subject rotates roughly uniformly
        # with frame order. Real adapters return a measured angle here.
        yaw = float((index * 45.0) % 360.0)
        yaw_rad = np.deg2rad(yaw)

        camera = CameraParams(
            focal=float(max(w, h) * 1.2),
            principalPoint=(w / 2.0, h / 2.0),
            rotation=(0.0, float(np.sin(yaw_rad / 2)), 0.0, float(np.cos(yaw_rad / 2))),
            translation=(0.0, 0.0, 2.8),
            subjectYawDeg=yaw,
        )

        return PerFrameEstimate(
            index=index,
            shape=shape.tolist(),
            pose=[0.0] * 63,
            camera=camera,
            score=0.85,
        )

    def _shape_from_silhouette(self, alpha: np.ndarray, image: np.ndarray) -> np.ndarray:
        shape = np.zeros(SHAPE_DIMS, dtype=np.float32)

        ys, xs = np.nonzero(alpha > 0.5)
        if len(ys) < 100:
            return shape

        top, bottom = int(ys.min()), int(ys.max())
        body_h = max(1, bottom - top)

        # Sample silhouette width at anatomical heights, normalised by body
        # height so the result is scale-invariant.
        def width_at(frac: float) -> float:
            row = int(top + frac * body_h)
            row = int(np.clip(row, 0, alpha.shape[0] - 1))
            cols = np.nonzero(alpha[row] > 0.5)[0]
            return float(len(cols)) / body_h if len(cols) else 0.0

        shoulder_w = width_at(0.22)
        chest_w = width_at(0.32)
        waist_w = width_at(0.46)
        hip_w = width_at(0.55)

        mean_w = float(np.mean([shoulder_w, chest_w, waist_w, hip_w]) or 0.2)

        # Centre each ratio on a nominal and map into coefficient space.
        shape[0] = 0.0  # height comes from S7's scale ladder, not pixels
        shape[1] = float(np.clip((mean_w - 0.21) * 6.0, -2.0, 2.0))  # girth
        shape[2] = float(np.clip((shoulder_w - 0.22) * 7.0, -2.0, 2.0))  # shoulders
        shape[3] = float(np.clip((hip_w - 0.20) * 7.0, -2.0, 2.0))  # hips
        shape[4] = float(np.clip((chest_w - 0.21) * 6.0, -2.0, 2.0))  # chest depth
        shape[5] = float(np.clip((waist_w - 0.18) * 7.0, -2.0, 2.0))  # waist
        shape[6] = 0.0  # limb length
        shape[7] = float(np.clip((shoulder_w - 0.22) * 3.0, -1.5, 1.5))  # neck

        # Stable pseudo-random fine detail keyed on image content, so repeated
        # runs on the same input agree.
        digest = hashlib.sha256(cv2.resize(image, (32, 32)).tobytes()).digest()
        rng = np.random.default_rng(int.from_bytes(digest[:8], "little"))
        shape[8:] = rng.normal(0.0, 0.18, SHAPE_DIMS - 8).astype(np.float32)

        return shape
