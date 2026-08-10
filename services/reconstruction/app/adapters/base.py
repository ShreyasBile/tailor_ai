"""Adapter contracts.

Every model sits behind one of these. No pipeline code imports a model
directly, which is what makes swapping SAM 3D Body for its successor a config
change rather than a refactor (docs/01 §4).
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

import numpy as np

from ..schemas import PerFrameEstimate


@runtime_checkable
class SegmentationAdapter(Protocol):
    """Person matting. Produces a soft alpha, which matters for hair and
    loose clothing — a hard binary mask visibly clips both."""

    id: str

    def warmup(self) -> None: ...

    def segment(self, image: np.ndarray) -> np.ndarray:
        """Return a float32 alpha matte in [0,1], same HxW as `image`."""
        ...


@runtime_checkable
class BodyAdapter(Protocol):
    """Single-image human mesh recovery."""

    id: str
    body_model: str
    body_model_version: str

    def warmup(self) -> None: ...

    def infer(self, image: np.ndarray, mask: np.ndarray | None, index: int) -> PerFrameEstimate:
        """Estimate shape, pose and camera for one frame."""
        ...
