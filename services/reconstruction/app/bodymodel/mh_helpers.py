"""MakeHuman helper geometry for a shopper's Anny body.

MakeHuman clothes (the shop's 3D garments) are fitted to the MakeHuman base
mesh, and most of them hang off its invisible helper layers — a tights layer
close to the skin, a skirt layer from the hips — rather than the skin itself.
Anny is built from that base mesh but drops the helpers; built with them kept,
they move with the same shape parameters as the body. This returns them for a
stored shape vector, in the avatar GLB's frame (`anny_body.build`), so the
browser can wrap any garment onto the shopper's own body exactly.

Order: every base-mesh vertex the body mesh doesn't have, by base index —
the same order scripts/build-3d-garments.py uses for its "extended" indices.
"""

from __future__ import annotations

import dataclasses
import threading
from functools import lru_cache

import numpy as np

from . import anny_body as ab

_lock = threading.Lock()


@lru_cache(maxsize=1)
def _full():
    import anny  # noqa: PLC0415
    from anny.models.model_data import TopologyConfig  # noqa: PLC0415

    tc = dataclasses.replace(TopologyConfig.from_string("anny"), remove_unattached_vertices=False)
    return anny.Anny(local_changes=ab.LOCAL_CHANGES, topology=tc)


@lru_cache(maxsize=1)
def _rows() -> tuple[np.ndarray, np.ndarray]:
    """Rows of the full model: the body's vertices (Anny order), the helpers'."""
    bidx = ab._model().base_mesh_vertex_indices.numpy()
    fidx = _full().base_mesh_vertex_indices.numpy()
    row_of = np.full(int(fidx.max()) + 1, -1)
    row_of[fidx] = np.arange(len(fidx))
    in_body = np.zeros(len(row_of), bool)
    in_body[bidx] = True
    return row_of[bidx], row_of[np.nonzero(~in_body)[0]]


def _rest(params: np.ndarray) -> np.ndarray:
    import torch  # noqa: PLC0415

    phen = {n: float(np.clip(params[i], 0.0, 1.0)) for i, n in enumerate(ab.PHENOTYPES)}
    lc = {n: float(np.clip(params[len(ab.PHENOTYPES) + i], -1.0, 1.0)) for i, n in enumerate(ab.LOCAL_CHANGES)}
    with _lock, torch.no_grad():
        out = _full()(phenotype_kwargs=phen, local_changes_kwargs=lc)
    return out["rest_vertices"][0].double().numpy()


@lru_cache(maxsize=64)
def _helpers_cached(shape: tuple[float, ...], metric_scale: float) -> np.ndarray:
    v = ab._to_pipeline_frame(_rest(ab.from_shape(list(shape))))
    body_rows, extra_rows = _rows()
    b = v[body_rows]
    lo, hi = b.min(axis=0), b.max(axis=0)
    t = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    s = ab.CANONICAL_HEIGHT_M * float(metric_scale or 1.0) / float(hi[1] - lo[1])
    return ((v[extra_rows] + t) * s).astype(np.float32)


def helpers(shape: list[float], metric_scale: float = 1.0) -> np.ndarray:
    """(n_helpers, 3) float32, metres, avatar GLB frame."""
    return _helpers_cached(tuple(round(float(x), 6) for x in shape), round(float(metric_scale or 1.0), 6))
