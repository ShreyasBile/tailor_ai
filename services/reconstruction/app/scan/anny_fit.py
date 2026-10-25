"""Fit the Anny body to the scan's measurements.

The measurements are the source of truth; the mesh is their visualisation —
and, for try-on, the body clothes are wrapped around. So the mesh is measured
exactly the way the scan measured the person (same heights, tape-style convex
girths, joint-chain lengths) and Anny's sliders are solved until the two agree.

1. Phenotypes: gender from the profile; the height slider is set so the body's
   natural proportions suit the stature (a 155 cm body is not a scaled-down
   190 cm one); the weight slider matches overall torso girth.
2. Twelve tape-measure local changes (bust, waist, hips, neck, thigh, calf,
   shoulder, leg and arm lengths, nape-to-waist) by damped Gauss–Newton,
   weighted by each measurement's confidence. Local changes are linear
   blendshapes, so their basis is built once and every solver step is a
   matrix product plus a few mesh slices.

The final mesh is uniformly scaled to the user's exact height.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass

import numpy as np
import trimesh
from scipy.spatial import ConvexHull

from ..bodymodel import anny_body as A
from ..bodymodel.humanoid import CANONICAL_HEIGHT_M

log = logging.getLogger(__name__)

FIT_VERSION = f"{A.ANNY_VERSION}+fit-v1"

# Same constants as the scan engine (app/scan/measure.py).
ACROMION_OFFSET = 0.012
DEFAULT_FRACTIONS = {"neck": 0.85, "chest": 0.72, "waist": 0.63, "hip": 0.53, "thigh": 0.44, "calf": 0.25}
GIRTHS = ["chest", "waist", "hip", "neck", "thigh", "calf"]
MIN_CONFIDENCE = 0.25
LEG_GIRTHS = {"thigh", "calf"}

# Which local change mainly drives each measurement (for the starting guess).
DRIVER = {
    "chest": "measure-bust-circ-incr",
    "waist": "measure-waist-circ-incr",
    "hip": "measure-hips-circ-incr",
    "neck": "measure-neck-circ-incr",
    "thigh": "measure-thigh-circ-incr",
    "calf": "measure-calf-circ-incr",
    "shoulder_width": "measure-shoulder-dist-incr",
    "inseam": "measure-upperleg-height-incr",
    "arm_length": "measure-upperarm-length-incr",
    "torso_length": "measure-napetowaist-dist-incr",
}


@dataclass
class Target:
    value: float
    confidence: float = 0.7
    frac: float | None = None  # measurement height, fraction of stature


@dataclass
class AnnyFit:
    params: np.ndarray
    metric_scale: float
    residual_cm: dict[str, float]
    iterations: int
    elapsed_ms: int

    def to_dict(self) -> dict:
        return {
            "shape": A.to_shape(self.params),
            "metricScale": self.metric_scale,
            "bodyModel": "ANNY",
            "bodyModelVersion": FIT_VERSION,
            "residualCm": self.residual_cm,
            "iterations": self.iterations,
            "elapsedMs": self.elapsed_ms,
        }


# ── measuring the mesh like the scan measures a person ──


def _loops(mesh: trimesh.Trimesh, y: float) -> list[np.ndarray]:
    """Closed cross-section outlines at height y, as (n,2) arrays in (x, z)."""
    try:
        path = mesh.section(plane_origin=[0.0, y, 0.0], plane_normal=[0.0, 1.0, 0.0])
    except Exception:  # noqa: BLE001
        return []
    if path is None:
        return []
    return [d[:, [0, 2]] for d in path.discrete if len(d) >= 4]


def _hull_perimeter_cm(pts: np.ndarray) -> float:
    hull = ConvexHull(pts)
    ring = pts[hull.vertices]
    return float(np.sum(np.linalg.norm(np.roll(ring, -1, axis=0) - ring, axis=1)) * 100.0)


def _torso_loop(loops: list[np.ndarray]) -> np.ndarray | None:
    spanning = [lp for lp in loops if lp[:, 0].min() < 0.0 < lp[:, 0].max()]
    if not spanning:
        return None
    return max(spanning, key=lambda lp: np.ptp(lp[:, 0]))


def _leg_loop(loops: list[np.ndarray]) -> np.ndarray | None:
    """The +x leg: of the loops right of centre, the one nearest it (the hand
    hangs further out)."""
    right = [lp for lp in loops if lp[:, 0].mean() > 0.01 and lp[:, 0].min() > -0.005]
    if not right:
        return None
    return min(right, key=lambda lp: lp[:, 0].mean())


def _crotch_y(mesh: trimesh.Trimesh, H: float) -> float:
    """Highest height at which no surface crosses the body's midline."""
    lo, hi = 0.30 * H, 0.60 * H
    for _ in range(14):
        mid = (lo + hi) / 2
        if _torso_loop(_loops(mesh, mid)) is None:
            lo = mid
        else:
            hi = mid
    return lo


def measure(body: A.Body, fracs: dict[str, float], want: set[str]) -> dict[str, float]:
    """The scan's measurements, taken on the mesh (cm)."""
    mesh = body.mesh()
    H = float(body.vertices[:, 1].max())
    out: dict[str, float] = {}
    for name in GIRTHS:
        if name not in want:
            continue
        y = fracs.get(name, DEFAULT_FRACTIONS[name]) * H
        loops = _loops(mesh, y)
        lp = _leg_loop(loops) if name in LEG_GIRTHS else _torso_loop(loops)
        if lp is not None and len(lp) >= 3:
            out[name] = _hull_perimeter_cm(lp)

    j = body.joints
    if "shoulder_width" in want:
        joint = abs(j["upperarm01.L"][0] - j["upperarm01.R"][0])
        out["shoulder_width"] = (joint + 2 * ACROMION_OFFSET * H) * 100.0
    if "arm_length" in want:
        # Front-view joint chain, as the scan sees it.
        s, e, w = (j[k][:2] for k in ("upperarm01.L", "lowerarm01.L", "wrist.L"))
        out["arm_length"] = float(np.linalg.norm(e - s) + np.linalg.norm(w - e)) * 100.0
    if want & {"inseam", "torso_length"}:
        crotch = _crotch_y(mesh, H)
        out["inseam"] = crotch * 100.0
        if "torso_length" in want:
            out["torso_length"] = (_hps_y(body, H) - crotch) * 100.0
    return out


def _hps_y(body: A.Body, H: float) -> float:
    """High point of the shoulder: top of the trapezius just outside the neck."""
    v = body.vertices
    neck = body.joints["neck01"]
    near = (np.abs(np.abs(v[:, 0]) - 0.065 * H / CANONICAL_HEIGHT_M) < 0.012) & (np.abs(v[:, 2] - neck[2]) < 0.06)
    near &= (v[:, 1] > neck[1] - 0.12) & (v[:, 1] < neck[1] + 0.05)
    return float(v[near, 1].max()) if near.any() else float(neck[1])


# ── fitting ──


def fit(targets: dict[str, Target], height_cm: float, sex: str | None = None,
        max_iter: int = 6) -> AnnyFit:
    started = time.perf_counter()
    H = height_cm / 100.0
    fracs = {k: t.frac for k, t in targets.items() if t.frac}
    # A reading the scan itself doubts (e.g. a thigh measured through loose
    # trousers) would only distort the body: leave it to Anny's own
    # proportions, which already suit this height, sex and build.
    names = [n for n in DRIVER if n in targets and targets[n].confidence >= MIN_CONFIDENCE]
    want = set(names)

    p = A.default_params()
    p[A.PHENOTYPES.index("gender")] = {"MALE": 0.0, "FEMALE": 1.0}.get((sex or "").upper(), 0.5)
    n_ph = len(A.PHENOTYPES)

    def body_for(params: np.ndarray, scale: bool = True) -> A.Body:
        v, j = A.rest_vertices(params)
        return A.place(v, j, H if scale else None)

    # 1. height slider: natural stature closest to the user's.
    ih = A.PHENOTYPES.index("height")
    statures = []
    for hv in (0.0, 1.0):
        q = p.copy(); q[ih] = hv
        b = body_for(q, scale=False)
        statures.append(float(b.vertices[:, 1].max()))
    p[ih] = float(np.clip((H - statures[0]) / max(1e-6, statures[1] - statures[0]), 0.0, 1.0))

    # 2. weight slider: mean torso girth.
    iw = A.PHENOTYPES.index("weight")
    torso = [n for n in ("chest", "waist", "hip") if n in names]
    if torso:
        goal = np.mean([targets[n].value for n in torso])

        def mean_girth(wv: float) -> float:
            q = p.copy(); q[iw] = wv
            m = measure(body_for(q), fracs, set(torso))
            return float(np.mean([m[n] for n in torso if n in m])) if m else goal

        x0, g0 = 0.5, mean_girth(0.5)
        x1 = float(np.clip(0.5 + (goal - g0) / 40.0, 0.0, 1.0))
        for _ in range(3):
            g1 = mean_girth(x1)
            if abs(g1 - goal) < 0.8 or abs(g1 - g0) < 1e-6:
                break
            x0, x1, g0 = x1, float(np.clip(x1 + (goal - g1) * (x1 - x0) / (g1 - g0), 0.0, 1.0)), g1
        p[iw] = x1

    # 3. local changes: linear basis, then damped Gauss–Newton.
    v0, j0 = A.rest_vertices(p)
    basis_v, basis_j = [], []
    for k in range(len(A.LOCAL_CHANGES)):
        q = p.copy(); q[n_ph + k] = 1.0
        vk, jk = A.rest_vertices(q)
        basis_v.append(vk - v0)
        basis_j.append({n: jk[n] - j0[n] for n in j0})
    Bv = np.stack(basis_v)  # (K, V, 3)

    def body_lc(c: np.ndarray) -> A.Body:
        v = v0 + np.tensordot(c, Bv, axes=1)
        j = {n: j0[n] + sum(c[k] * basis_j[k][n] for k in range(len(c))) for n in j0}
        return A.place(v, j, H)

    tgt = np.array([targets[n].value for n in names])
    # Residuals in cm, weighted by confidence (a shaky reading pulls less).
    w = np.array([targets[n].confidence for n in names])

    def resid(c: np.ndarray) -> np.ndarray:
        m = measure(body_lc(c), fracs, want)
        return np.array([m.get(n, tgt[i]) - tgt[i] for i, n in enumerate(names)])

    K = len(A.LOCAL_CHANGES)
    c = np.zeros(K)
    r = resid(c)
    it = 0
    lam = 1.0  # cm² per unit² of slider — keeps sliders near neutral
    for it in range(1, max_iter + 1):
        if np.max(np.abs(r)) < 0.6:
            break
        step = 0.3
        J = np.zeros((len(names), K))
        for k in range(K):
            ck = c.copy(); ck[k] += step
            J[:, k] = (resid(ck) - r) / step
        Jw = J * w[:, None]
        rw = r * w
        delta = np.linalg.solve(Jw.T @ Jw + lam * np.eye(K), -(Jw.T @ rw + lam * c))
        c_new = np.clip(c + delta, -1.0, 1.0)
        r_new = resid(c_new)
        if np.sum((r_new * w) ** 2) < np.sum((r * w) ** 2):
            c, r = c_new, r_new
            lam *= 0.5
        else:
            lam *= 4.0
    p[n_ph:] = c

    residual = {n: round(float(r[i]), 2) for i, n in enumerate(names)}
    elapsed = int((time.perf_counter() - started) * 1000)
    log.info("anny fit: %d iters, residual %s, %d ms", it, residual, elapsed)
    return AnnyFit(p, H / CANONICAL_HEIGHT_M, residual, it, elapsed)
