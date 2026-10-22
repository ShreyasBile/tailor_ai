"""Fit the parametric body to measured girths → the 3D body model.

The measurements are the source of truth; the mesh is their visualisation. We
solve for the shape coefficients whose mesh reproduces the measured chest,
waist, hip and thigh, so what the user rotates in the viewer is consistent
with the numbers printed beside it.

A secant solve for overall girth, then Gauss–Newton on three regional
coefficients. Each mesh evaluation is ~0.3 s, so the fit is bounded to a few iterations; the
residual is returned so a poor fit is visible rather than silently shipped.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np

from ..bodymodel.humanoid import CANONICAL_HEIGHT_M, SHAPE_DIMS, build
from ..research import measurements as mesh_measure

log = logging.getLogger(__name__)

# Fitted girths. The thigh follows from the overall girth and is reported as a
# residual only — it is our least reliable measurement (see accuracy.json).
TARGETS = ["chest", "waist", "hip", "thigh"]
BOUND = 2.5


@dataclass
class FitResult:
    shape: list[float]
    metric_scale: float
    residual_cm: dict[str, float]
    iterations: int
    elapsed_ms: int

    def to_dict(self) -> dict:
        return {
            "shape": self.shape,
            "metricScale": self.metric_scale,
            "residualCm": self.residual_cm,
            "iterations": self.iterations,
            "elapsedMs": self.elapsed_ms,
        }


def _mesh_girths(shape: np.ndarray, metric_scale: float) -> np.ndarray:
    mesh, info = build(shape.tolist(), metric_scale=metric_scale, return_landmarks=True)
    m = mesh_measure.extract(mesh, info).to_dict()
    return np.array([m[k] for k in TARGETS], dtype=np.float64)


def fit(measured: dict[str, float], height_cm: float, max_iter: int = 4) -> FitResult:
    """Two stages, because the coefficients are not independent:

    1. Overall girth (coefficient 1) — a 1-D secant solve matching the mean of
       the torso girths. This coefficient also drives the limbs, so solving it
       jointly with the regional ones lets the solver push those into their
       bounds instead of moving the one that matters.
    2. Regional shape (waist, hip width, chest depth) — Gauss–Newton on the
       remaining torso residuals, with saturated coefficients held fixed.
    """
    started = time.perf_counter()
    scale = (height_cm / 100.0) / CANONICAL_HEIGHT_M
    targets = np.array([measured.get(k, np.nan) for k in TARGETS], dtype=np.float64)
    torso = np.isfinite(targets[:3])

    shape = np.zeros(SHAPE_DIMS, dtype=np.float64)
    if not torso.any():
        return FitResult(shape.tolist(), scale, {}, 0, 0)

    evals = 0

    def girths(v: np.ndarray) -> np.ndarray:
        nonlocal evals
        evals += 1
        return _mesh_girths(v, scale)

    # ── stage 1: overall girth ──
    goal = float(np.mean(targets[:3][torso]))
    x0, g0 = 0.0, float(np.mean(girths(shape)[:3][torso]))
    x1 = float(np.clip((goal / g0 - 1.0) / 0.3, -BOUND, BOUND))  # tanh-linear guess
    for _ in range(3):
        shape[1] = x1
        g1 = float(np.mean(girths(shape)[:3][torso]))
        if abs(g1 - goal) < 0.5 or abs(g1 - g0) < 1e-6:
            break
        x0, x1, g0 = x1, float(np.clip(x1 + (goal - g1) * (x1 - x0) / (g1 - g0), -BOUND, BOUND)), g1
    shape[1] = x1

    # ── stage 2: regional shape ──
    regional = [5, 3, 4]  # waist, hip width, chest depth
    current = girths(shape)
    it = 0
    for it in range(1, max_iter + 1):
        resid = (targets[:3] - current[:3])[torso]
        if np.max(np.abs(resid)) < 1.0:
            break
        free = [p for p in regional if abs(shape[p]) < BOUND - 1e-6]
        if not free:
            break
        step = 0.25
        jac = np.zeros((3, len(free)))
        for j, p in enumerate(free):
            probe = shape.copy()
            probe[p] += step
            jac[:, j] = (girths(probe)[:3] - current[:3]) / step
        delta, *_ = np.linalg.lstsq(jac[torso], resid, rcond=None)
        # Damp large steps: tanh saturation makes the model less linear far out.
        for j, p in enumerate(free):
            shape[p] = float(np.clip(shape[p] + np.clip(delta[j], -1.0, 1.0), -BOUND, BOUND))
        current = girths(shape)

    use = np.isfinite(targets)
    residual = {k: round(float(current[i] - targets[i]), 2) for i, k in enumerate(TARGETS) if use[i]}
    elapsed = int((time.perf_counter() - started) * 1000)
    log.info("body fit: %d evals, residual %s, %d ms", evals, residual, elapsed)
    return FitResult([round(float(x), 5) for x in shape], scale, residual, it, elapsed)
