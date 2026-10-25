"""Anny body model: a realistic, rigged human mesh fitted to the scan.

Anny (NAVER LABS Europe, Apache-2.0 code, CC0 MakeHuman assets) gives a
13.7k-vertex body with a 104-bone skeleton, six phenotype sliders and a set of
tape-measure "local changes". We fit those to the scan's measurements so the
3D body the user rotates — and tries clothes on — has their proportions, not a
mannequin's.

Shape-vector layout (``bodyModel == "ANNY"``), padded to SHAPE_DIMS:
    [0:6]   phenotypes  gender, age, muscle, weight, height, proportions (0..1)
    [6:18]  local changes in LOCAL_CHANGES order (-1..1)
The vector is the identity; the mesh is regenerated from it on demand, scaled
to the user's exact stature.

Anny's rest pose is an A-pose (arms ~43° from the body), Z-up, facing -Y. The
pipeline's frame is Y-up facing +Z, metres, grounded at y=0 — converted here.
"""

from __future__ import annotations

import logging
import threading
import time
import warnings
from dataclasses import dataclass
from functools import lru_cache

import numpy as np
import trimesh

from .humanoid import CANONICAL_HEIGHT_M, SHAPE_DIMS

log = logging.getLogger(__name__)

ANNY_VERSION = "anny-0.6.1"

PHENOTYPES = ["gender", "age", "muscle", "weight", "height", "proportions"]
# Neutral defaults: gender 0.5 (androgynous), age 0.667 (MakeHuman "young"
# adult anchor — its age axis runs newborn −1/3 … old 1).
PHENOTYPE_DEFAULTS = {"gender": 0.5, "age": 0.667, "muscle": 0.5, "weight": 0.5, "height": 0.5, "proportions": 0.5}

LOCAL_CHANGES = [
    "measure-bust-circ-incr",
    "measure-waist-circ-incr",
    "measure-hips-circ-incr",
    "measure-neck-circ-incr",
    "measure-thigh-circ-incr",
    "measure-calf-circ-incr",
    "measure-shoulder-dist-incr",
    "measure-upperleg-height-incr",
    "measure-lowerleg-height-incr",
    "measure-upperarm-length-incr",
    "measure-lowerarm-length-incr",
    "measure-napetowaist-dist-incr",
]
N_PARAMS = len(PHENOTYPES) + len(LOCAL_CHANGES)

_lock = threading.Lock()


@lru_cache(maxsize=1)
def _model():
    """Load Anny once per process. The first load ever builds Anny's on-disk
    cache (~90 s); later loads take under a second."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        import anny  # noqa: PLC0415 — torch + warp are heavy; import lazily

        started = time.perf_counter()
        model = anny.Anny(local_changes=LOCAL_CHANGES, topology="anny")
        model.eval()
        log.info("Anny loaded in %.1fs (%d verts)", time.perf_counter() - started, int(model.template_vertices.shape[-2]) if hasattr(model, "template_vertices") else -1)
        return model


def warmup() -> None:
    """Load the model and compile the skinning kernel off the request path."""
    try:
        rest_vertices(default_params())
    except Exception as exc:  # noqa: BLE001 — warmup must never kill the service
        log.warning("Anny warmup failed: %s", exc)


def available() -> bool:
    try:
        import anny  # noqa: F401, PLC0415
    except Exception:  # noqa: BLE001
        return False
    return True


def default_params() -> np.ndarray:
    p = np.zeros(N_PARAMS)
    for i, name in enumerate(PHENOTYPES):
        p[i] = PHENOTYPE_DEFAULTS[name]
    return p


def to_shape(params: np.ndarray) -> list[float]:
    shape = np.zeros(SHAPE_DIMS)
    shape[:N_PARAMS] = params
    return [round(float(x), 5) for x in shape]


def from_shape(shape: list[float] | np.ndarray) -> np.ndarray:
    v = np.asarray(shape, dtype=np.float64).flatten()
    p = default_params()
    p[: min(len(v), N_PARAMS)] = v[:N_PARAMS]
    return p


def _raw(params: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Rest vertices (Anny frame, metres) and bone heads for these params."""
    import torch  # noqa: PLC0415

    model = _model()
    phen = {name: float(np.clip(params[i], 0.0, 1.0)) for i, name in enumerate(PHENOTYPES)}
    lc = {name: float(np.clip(params[len(PHENOTYPES) + i], -1.0, 1.0)) for i, name in enumerate(LOCAL_CHANGES)}
    with _lock, torch.no_grad():
        out = model(phenotype_kwargs=phen, local_changes_kwargs=lc)
    return out["rest_vertices"][0].double().numpy(), out["rest_bone_heads"][0].double().numpy()


def _to_pipeline_frame(v: np.ndarray) -> np.ndarray:
    """Anny (Z-up, facing −Y) → pipeline (Y-up, facing +Z). A proper rotation."""
    return np.stack([v[..., 0], v[..., 2], -v[..., 1]], axis=-1)


@dataclass
class Body:
    vertices: np.ndarray  # (V,3) pipeline frame, grounded, centred, metres
    faces: np.ndarray
    joints: dict[str, np.ndarray]  # pipeline frame, same transform

    def mesh(self) -> trimesh.Trimesh:
        return trimesh.Trimesh(vertices=self.vertices, faces=self.faces, process=False)


_JOINTS = ["upperarm01.L", "upperarm01.R", "lowerarm01.L", "lowerarm01.R", "wrist.L", "wrist.R",
           "upperleg01.L", "upperleg01.R", "neck01"]


def rest_vertices(params: np.ndarray) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    v, heads = _raw(params)
    labels = _model().bone_labels
    joints = {j: heads[labels.index(j)] for j in _JOINTS}
    return v, joints


@lru_cache(maxsize=1)
def faces() -> np.ndarray:
    f = _model().faces
    return f.detach().cpu().numpy().astype(np.int64) if hasattr(f, "detach") else np.asarray(f, dtype=np.int64)


def place(v_raw: np.ndarray, joints_raw: dict[str, np.ndarray], height_m: float | None) -> Body:
    """Convert to the pipeline frame, ground, centre, and optionally scale to
    an exact stature."""
    v = _to_pipeline_frame(v_raw)
    j = {k: _to_pipeline_frame(p) for k, p in joints_raw.items()}
    lo, hi = v.min(axis=0), v.max(axis=0)
    t = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    s = 1.0 if not height_m else height_m / float(hi[1] - lo[1])
    v = (v + t) * s
    j = {k: (p + t) * s for k, p in j.items()}
    return Body(v, faces(), j)


def build(shape: list[float] | np.ndarray, metric_scale: float = 1.0) -> trimesh.Trimesh:
    """The Anny mesh for a stored shape vector at the stature metric_scale
    encodes (height = 1.75 m × metric_scale, as for the humanoid)."""
    v, j = rest_vertices(from_shape(shape))
    body = place(v, j, CANONICAL_HEIGHT_M * float(metric_scale or 1.0))
    mesh = body.mesh()
    mesh.fix_normals()
    return mesh
