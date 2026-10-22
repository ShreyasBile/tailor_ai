"""Anthropometric measurement extraction from a body mesh.

A tape measure follows the *convex* perimeter of a body cross-section, not the
concave folds — so a girth is the circumference of the convex hull of the
mesh's intersection with a horizontal plane at the right anatomical height.
Lengths are landmark-to-landmark distances. This mirrors how BodyM and CALVIS
define their ground truth (curves along mesh vertex paths), which is what lets
our synthetic labels be compared against those datasets.

The 14 measurements match BodyM's schema exactly, so a model trained on our
synthetic data can be evaluated on BodyM without relabelling:
    ankle, arm-length, bicep, calf, chest, forearm, height, hip,
    leg-length, shoulder-breadth, shoulder-to-crotch, thigh, waist, wrist
(all girths are circumferences; all in centimetres).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict

import numpy as np
import trimesh


# Anatomical measurement heights as a fraction of stature, measured from the
# ground. Standard anthropometric landmarks; the arm-girth heights are used to
# locate the slice plane centre, but arm girths are sliced perpendicular to the
# limb axis (see `_limb_girth`).
LANDMARKS = {
    "neck": 0.870,
    "chest": 0.720,
    "waist": 0.630,
    "hip": 0.530,
    "thigh": 0.470,   # upper thigh, just below the crotch
    "calf": 0.250,
    "ankle": 0.055,
}


@dataclass
class BodyMeasurements:
    """The 14 BodyM measurements, centimetres. `None` where not extractable."""

    height: float
    chest: float
    waist: float
    hip: float
    thigh: float
    calf: float
    ankle: float
    shoulder_breadth: float
    arm_length: float
    leg_length: float
    shoulder_to_crotch: float
    bicep: float | None = None
    forearm: float | None = None
    wrist: float | None = None

    def to_dict(self) -> dict:
        return {k: (round(v, 2) if isinstance(v, float) else v) for k, v in asdict(self).items()}


# ── girth via convex cross-section perimeter ──


def _horizontal_girth(mesh: trimesh.Trimesh, y: float) -> float | None:
    """Circumference (cm) of the body at world-height `y` (metres), tape-measure
    style: convex-hull perimeter of the horizontal cross-section.

    When the plane cuts multiple components (e.g. two legs, or a leg plus an
    arm), the largest component is taken — that is what a tape around the torso
    or a single limb would enclose.
    """
    try:
        segs = trimesh.intersections.mesh_plane(
            mesh, plane_normal=[0.0, 1.0, 0.0], plane_origin=[0.0, y, 0.0]
        )
    except Exception:
        return None
    if segs is None or len(segs) == 0:
        return None

    pts = segs.reshape(-1, 3)[:, [0, 2]]  # project to the X-Z (horizontal) plane
    return _largest_component_hull_perimeter(pts)


def _largest_component_hull_perimeter(pts: np.ndarray) -> float | None:
    """Convex-hull perimeter (cm) of the dominant blob of 2-D points (metres)."""
    if len(pts) < 3:
        return None
    # Split into spatial clusters so two legs don't get hulled together.
    clusters = _cluster(pts, eps=0.06)
    best = max(clusters, key=len) if clusters else pts
    if len(best) < 3:
        return None
    try:
        from scipy.spatial import ConvexHull

        hull = ConvexHull(best)
        verts = best[hull.vertices]
        per = np.sum(np.linalg.norm(np.diff(np.vstack([verts, verts[0]]), axis=0), axis=1))
        return float(per * 100.0)  # m → cm
    except Exception:
        return None


def _cluster(pts: np.ndarray, eps: float) -> list[np.ndarray]:
    """Cheap grid-based connected clustering — enough to separate limbs."""
    if len(pts) == 0:
        return []
    keys = np.floor(pts / eps).astype(np.int64)
    buckets: dict[tuple[int, int], list[int]] = {}
    for i, k in enumerate(map(tuple, keys)):
        buckets.setdefault(k, []).append(i)

    seen: set[tuple[int, int]] = set()
    clusters: list[np.ndarray] = []
    for start in list(buckets):
        if start in seen:
            continue
        stack = [start]
        idx: list[int] = []
        while stack:
            cell = stack.pop()
            if cell in seen or cell not in buckets:
                continue
            seen.add(cell)
            idx.extend(buckets[cell])
            cx, cy = cell
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    stack.append((cx + dx, cy + dy))
        clusters.append(pts[idx])
    return clusters


def _limb_girth(mesh: trimesh.Trimesh, centre: np.ndarray, axis: np.ndarray) -> float | None:
    """Girth of a limb sliced perpendicular to its `axis` at point `centre`.

    Used for bicep/forearm/wrist, whose limbs are angled in the A-pose so a
    horizontal cut would be wrong. Requires the caller to supply the limb axis
    (the mesh builder knows it); returns None if unavailable.
    """
    axis = axis / (np.linalg.norm(axis) + 1e-9)
    try:
        segs = trimesh.intersections.mesh_plane(mesh, plane_normal=axis, plane_origin=centre)
    except Exception:
        return None
    if segs is None or len(segs) == 0:
        return None
    pts = segs.reshape(-1, 3)
    # Project onto the plane's local 2-D frame.
    ref = np.array([0.0, 0.0, 1.0]) if abs(axis[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(axis, ref); u /= np.linalg.norm(u) + 1e-9
    v = np.cross(axis, u)
    local = np.stack([(pts - centre) @ u, (pts - centre) @ v], axis=1)
    # keep points near the requested centre (drop the far limb / torso)
    d = np.linalg.norm(local, axis=1)
    local = local[d < 0.18]
    return _largest_component_hull_perimeter(local)


def extract(mesh: trimesh.Trimesh, info: dict | None = None) -> BodyMeasurements:
    """Extract the 14 measurements from a grounded, Y-up mesh (metres).

    `info` from the mesh builder (`humanoid.build(..., return_landmarks=True)`):
        {"landmarks": {shoulder,elbow,wrist,hip,ankle,crotch_y},
         "torso_mesh": trimesh (torso only, final frame),
         "limb_girths": {thigh,calf,ankle,bicep,forearm,wrist} in cm}

    Torso girths are sliced from `torso_mesh` (no arms → clean cross-section);
    limb girths come from the analytic tube radii. Without `info` it falls back
    to slicing the fused mesh (used for real reconstructed meshes, where the
    caller should first isolate body parts).
    """
    b = mesh.bounds
    y0, y1 = float(b[0][1]), float(b[1][1])
    height_cm = (y1 - y0) * 100.0

    torso = (info or {}).get("torso_mesh", mesh)
    tb = torso.bounds
    ty0, tH = float(tb[0][1]), float(tb[1][1] - tb[0][1])

    def torso_at(frac: float) -> float:
        # Measurement heights are fractions of *stature*; locate them on the
        # torso submesh, which spans crotch→neck, by mapping through world Y.
        return y0 + frac * (y1 - y0)

    chest = _horizontal_girth(torso, torso_at(LANDMARKS["chest"]))
    waist = _horizontal_girth(torso, torso_at(LANDMARKS["waist"]))
    hip = _horizontal_girth(torso, torso_at(LANDMARKS["hip"]))
    shoulder_breadth = _shoulder_breadth(torso, torso_at(0.820)) or 0.0
    _ = (ty0, tH)  # (kept for clarity; torso spans a subset of stature)

    lg = (info or {}).get("limb_girths", {})
    thigh = lg.get("thigh") or _horizontal_girth(mesh, torso_at(LANDMARKS["thigh"])) or 0.0
    calf = lg.get("calf") or _horizontal_girth(mesh, torso_at(LANDMARKS["calf"])) or 0.0
    ankle = lg.get("ankle") or _horizontal_girth(mesh, torso_at(LANDMARKS["ankle"])) or 0.0
    bicep = lg.get("bicep")
    forearm = lg.get("forearm")
    wrist = lg.get("wrist")

    # Lengths from landmarks when available, else population-ratio fallbacks.
    lm = (info or {}).get("landmarks")
    if lm:
        sh = np.asarray(lm["shoulder"]); el = np.asarray(lm["elbow"])
        wr = np.asarray(lm["wrist"]); hip_pt = np.asarray(lm["hip"])
        ank = np.asarray(lm["ankle"]); crotch_y = float(lm["crotch_y"])
        arm_length = float((np.linalg.norm(el - sh) + np.linalg.norm(wr - el)) * 100.0)
        leg_length = float(np.linalg.norm(ank - hip_pt) * 100.0)
        shoulder_to_crotch = float((sh[1] - crotch_y) * 100.0)
    else:
        arm_length = height_cm * 0.44
        leg_length = height_cm * 0.47
        shoulder_to_crotch = height_cm * 0.30

    return BodyMeasurements(
        height=round(height_cm, 2),
        chest=round(chest or 0.0, 2),
        waist=round(waist or 0.0, 2),
        hip=round(hip or 0.0, 2),
        thigh=round(thigh or 0.0, 2),
        calf=round(calf or 0.0, 2),
        ankle=round(ankle or 0.0, 2),
        shoulder_breadth=round(shoulder_breadth, 2),
        arm_length=round(arm_length, 2),
        leg_length=round(leg_length, 2),
        shoulder_to_crotch=round(shoulder_to_crotch, 2),
        bicep=round(bicep, 2) if bicep else None,
        forearm=round(forearm, 2) if forearm else None,
        wrist=round(wrist, 2) if wrist else None,
    )


def _shoulder_breadth(mesh: trimesh.Trimesh, y: float) -> float | None:
    """Straight-line shoulder width (cm) at height `y`: the X-extent of the
    torso cross-section, ignoring the separated arm blobs."""
    try:
        segs = trimesh.intersections.mesh_plane(
            mesh, plane_normal=[0.0, 1.0, 0.0], plane_origin=[0.0, y, 0.0]
        )
    except Exception:
        return None
    if segs is None or len(segs) == 0:
        return None
    pts = segs.reshape(-1, 3)[:, [0, 2]]
    clusters = _cluster(pts, eps=0.06)
    if not clusters:
        return None
    torso = max(clusters, key=len)
    return float((torso[:, 0].max() - torso[:, 0].min()) * 100.0)


# Where each measurement sits on the body, as fractions of stature from the
# ground (0 = feet, 1 = head). Drives the app's highlight overlay. `kind`:
# girth = horizontal band, width = horizontal span, length = vertical span.
REGION_MAP = {
    "chest": {"kind": "girth", "y": 0.720, "side": "torso"},
    "waist": {"kind": "girth", "y": 0.630, "side": "torso"},
    "hip": {"kind": "girth", "y": 0.530, "side": "torso"},
    "thigh": {"kind": "girth", "y": 0.470, "side": "leg"},
    "calf": {"kind": "girth", "y": 0.250, "side": "leg"},
    "ankle": {"kind": "girth", "y": 0.055, "side": "leg"},
    "bicep": {"kind": "girth", "y": 0.690, "side": "arm"},
    "forearm": {"kind": "girth", "y": 0.600, "side": "arm"},
    "wrist": {"kind": "girth", "y": 0.520, "side": "arm"},
    "shoulder_breadth": {"kind": "width", "y": 0.820, "side": "torso"},
    "height": {"kind": "length", "y0": 0.0, "y1": 1.0, "side": "full"},
    "arm_length": {"kind": "length", "y0": 0.53, "y1": 0.81, "side": "arm"},
    "leg_length": {"kind": "length", "y0": 0.05, "y1": 0.53, "side": "leg"},
    "shoulder_to_crotch": {"kind": "length", "y0": 0.50, "y1": 0.82, "side": "torso"},
}


def regions_for(meas: "BodyMeasurements") -> dict:
    """Build the region descriptors (value + placement) for every measurement."""
    d = meas.to_dict()
    out: dict[str, dict] = {}
    for name, region in REGION_MAP.items():
        val = d.get(name)
        if val is None:
            continue
        out[name] = {"value": val, "unit": "cm", **region}
    return out
