"""Synthetic training-data engine for commercially-licensed body measurement.

Generates (image, 14-measurements) pairs from the parametric humanoid — the
foundation of the paper's core claim: a measurement model trained on ZERO
non-commercially-licensed data (no SMPL, no BodyM, no SHAPY), yet evaluable
against them because the label schema is identical.

Each sample yields BodyM-style frontal + lateral silhouettes (BodyM's input
modality), an optional shaded RGB, and the exact ground-truth measurements
computed from the same mesh. Body shapes are sampled to match real adult
anthropometric ranges so the synthetic distribution transfers.
"""

from __future__ import annotations

import numpy as np
import trimesh

from ..bodymodel.humanoid import SHAPE_DIMS, build
from . import measurements as M

# Target adult anthropometry (mixed-sex, approximate population means/SDs drawn
# from public ANSUR-II / WHO-style ranges). Used only to CALIBRATE the sampling
# distribution so synthetic measurements land in realistic ranges — no external
# dataset is ingested.
_HEIGHT = {"FEMALE": (163.0, 6.5), "MALE": (176.5, 7.0), "UNSPECIFIED": (170.0, 9.0)}
# Mean/SD of the interpretable shape coefficients, chosen so extracted girths
# match real means (verified in calibrate()). Indices follow BodyProportions:
# 0 height(unused here), 1 girth, 2 shoulder, 3 hip, 4 chest_depth, 5 waist,
# 6 limb_length, 7 neck.
_COEFF_MEAN = np.array([0.0, 0.88, 0.18, 0.72, 0.38, 0.12, 0.0, 0.0])
_COEFF_SD = np.array([0.0, 0.85, 0.55, 0.6, 0.5, 0.7, 0.35, 0.4])
# Sex shifts the build (males broader-chested, females wider-hipped).
_SEX_SHIFT = {
    "FEMALE": np.array([0, -0.15, -0.2, 0.45, -0.1, 0.1, 0, 0]),
    "MALE": np.array([0, 0.25, 0.35, -0.2, 0.2, -0.05, 0, 0]),
    "UNSPECIFIED": np.zeros(8),
}
CANONICAL_HEIGHT_CM = 175.0


def sample_shape(rng: np.random.Generator, sex: str) -> tuple[np.ndarray, float]:
    """Return (shape_vector[45], metric_scale) for one realistic body."""
    hmean, hsd = _HEIGHT.get(sex, _HEIGHT["UNSPECIFIED"])
    height_cm = float(np.clip(rng.normal(hmean, hsd), 140.0, 205.0))

    shape = np.zeros(SHAPE_DIMS, dtype=np.float32)
    core = _COEFF_MEAN + _SEX_SHIFT.get(sex, _SEX_SHIFT["UNSPECIFIED"]) + rng.normal(
        0.0, _COEFF_SD
    )
    # Correlate girth-family coefficients so a heavy person is heavy everywhere
    # (avoids implausible chest-huge / waist-tiny bodies).
    build_factor = rng.normal(0.0, 0.6)
    core[1] += build_factor       # girth
    core[4] += build_factor * 0.5  # chest depth
    core[5] += build_factor * 0.9  # waist
    shape[:8] = np.clip(core, -2.2, 2.6)
    shape[8:] = rng.normal(0.0, 0.15, SHAPE_DIMS - 8)

    return shape, height_cm / CANONICAL_HEIGHT_CM


# ── rendering ──


def _project(mesh: trimesh.Trimesh, yaw_deg: float, size: int, pad: float = 1.12):
    """Orthographic projection of vertices to image pixels (BodyM normalises
    framing, so we do too: fit the body height with a fixed pad)."""
    yaw = np.deg2rad(yaw_deg)
    c, s = np.cos(yaw), np.sin(yaw)
    v = mesh.vertices.copy()
    r = v.copy()
    r[:, 0] = v[:, 0] * c - v[:, 2] * s
    r[:, 2] = v[:, 0] * s + v[:, 2] * c
    ymin, ymax = r[:, 1].min(), r[:, 1].max()
    span = (ymax - ymin) * pad
    cx = (r[:, 0].min() + r[:, 0].max()) / 2
    cyy = (ymin + ymax) / 2
    px = ((r[:, 0] - cx) / span + 0.5) * size
    py = (1 - ((r[:, 1] - cyy) / span + 0.5)) * size
    return np.stack([px, py], axis=1), r


def render_silhouette(mesh: trimesh.Trimesh, yaw_deg: float, size: int = 256) -> np.ndarray:
    """Binary silhouette (uint8 0/255), BodyM's input modality."""
    import cv2

    pts, _ = _project(mesh, yaw_deg, size)
    canvas = np.zeros((size, size), np.uint8)
    for tri in mesh.faces:
        cv2.fillConvexPoly(canvas, pts[tri].astype(np.int32), 255)
    # match BodyM's segmentation-artefact look: tiny morphological closing
    canvas = cv2.morphologyEx(canvas, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    return canvas


def render_shaded(mesh: trimesh.Trimesh, yaw_deg: float, size: int = 256) -> np.ndarray:
    """Lambert-shaded grey RGB (uint8), for RGB-input experiments."""
    import cv2

    pts, r = _project(mesh, yaw_deg, size)
    canvas = np.full((size, size, 3), (16, 16, 22), np.uint8)
    n = mesh.face_normals.copy()
    yaw = np.deg2rad(yaw_deg)
    c, s = np.cos(yaw), np.sin(yaw)
    rn = n.copy()
    rn[:, 0] = n[:, 0] * c - n[:, 2] * s
    rn[:, 2] = n[:, 0] * s + n[:, 2] * c
    light = np.array([-0.3, 0.4, 0.85]); light /= np.linalg.norm(light)
    front = rn[:, 2] > 0
    idx = np.nonzero(front)[0]
    order = idx[np.argsort(r[mesh.faces[idx]][:, :, 2].mean(1))]
    for f in order:
        lam = float(np.clip(np.dot(rn[f], light), 0, 1)) * 0.7 + 0.3
        col = int(200 * lam)
        cv2.fillConvexPoly(canvas, pts[mesh.faces[f]].astype(np.int32), (col, col, int(col * 1.05)))
    return canvas


def make_sample(rng: np.random.Generator, sex: str, size: int = 256) -> dict:
    """Generate one full sample: images + ground-truth measurements."""
    shape, ms = sample_shape(rng, sex)
    mesh, info = build(shape, metric_scale=ms, return_landmarks=True)
    meas = M.extract(mesh, info)
    return {
        "sex": sex,
        "metric_scale": round(ms, 5),
        "shape": [round(float(x), 4) for x in shape],
        "measurements": meas.to_dict(),
        "frontal": render_silhouette(mesh, 0.0, size),
        "lateral": render_silhouette(mesh, 90.0, size),
        "shaded": render_shaded(mesh, 0.0, size),
    }
