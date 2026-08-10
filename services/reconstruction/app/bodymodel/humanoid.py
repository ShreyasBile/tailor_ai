"""Parametric humanoid body model.

Serves two purposes:

1. It is the mesh the mock adapter produces, so the entire pipeline — texture
   bake, GLB export, viewer, download — is exercisable with no weights and no
   GPU. A mock that emits a cube would validate none of that.
2. It defines the topology contract the real MHR mesh slots into. `build()`
   takes shape coefficients and returns a mesh; swapping in MHR changes the
   implementation, not the signature.

Geometry is a loft of elliptical cross-sections along the body axis for the
torso, plus tapered limbs and a head — which yields a genuinely human
silhouette rather than a stack of primitives.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np
import trimesh

log = logging.getLogger(__name__)

# Canonical model height in metres before metric scaling is applied.
CANONICAL_HEIGHT_M = 1.75

# Number of coefficients. Matches MHR's 45 so the contract is identical.
SHAPE_DIMS = 45

# Radial samples per cross-section. 24 reads smooth at viewer distance while
# keeping the mesh under the 5 MB GLB budget (docs/05 §5).
RADIAL_SEGMENTS = 24


@dataclass(frozen=True)
class BodyProportions:
    """Interpretable projection of the shape vector.

    The first eight coefficients carry semantic meaning; the remainder act as
    fine detail. This mirrors how MHR/Anny expose a small interpretable core
    plus a larger residual, and keeps the mock's behaviour explainable.
    """

    height: float
    girth: float
    shoulder_width: float
    hip_width: float
    chest_depth: float
    waist: float
    limb_length: float
    neck: float

    @staticmethod
    def from_shape(shape: list[float] | np.ndarray) -> BodyProportions:
        vec = np.zeros(SHAPE_DIMS, dtype=np.float32)
        supplied = np.asarray(shape, dtype=np.float32).flatten()
        vec[: min(len(supplied), SHAPE_DIMS)] = supplied[:SHAPE_DIMS]

        # Coefficients are ~N(0,1); squash to a bounded multiplier so an
        # outlier estimate cannot produce a grotesque mesh.
        def scaled(i: int, spread: float) -> float:
            return float(1.0 + spread * np.tanh(vec[i]))

        return BodyProportions(
            height=scaled(0, 0.12),
            girth=scaled(1, 0.30),
            shoulder_width=scaled(2, 0.18),
            hip_width=scaled(3, 0.18),
            chest_depth=scaled(4, 0.22),
            waist=scaled(5, 0.28),
            limb_length=scaled(6, 0.10),
            neck=scaled(7, 0.15),
        )


# Every landmark below is a fraction of TOTAL body height, measured from the
# ground. Using one consistent frame — rather than mixing absolute lengths with
# height fractions — is what keeps the model correctly proportioned at any
# stature. Values follow standard anthropometric ratios (head ≈ H/7.7,
# inseam ≈ 0.47H, shoulder ≈ 0.82H).
#
# (height fraction, half-width fraction, half-depth fraction)
_TORSO_SECTIONS: list[tuple[float, float, float]] = [
    # Tapered stub below the crotch. Without it the torso's flat bottom cap is
    # exposed as a visible slab at the hips; narrowing it lets the cap tuck
    # between the thigh cylinders where nothing sees it.
    (0.430, 0.038, 0.034),
    (0.470, 0.066, 0.049),  # crotch
    (0.500, 0.077, 0.056),  # low hip
    (0.530, 0.081, 0.060),  # hip / seat
    (0.620, 0.071, 0.053),  # waist
    (0.680, 0.077, 0.057),  # lower ribs
    (0.730, 0.087, 0.064),  # chest
    (0.780, 0.090, 0.062),  # upper chest
    (0.820, 0.080, 0.053),  # shoulder girdle
    (0.855, 0.035, 0.033),  # neck base
]

# Landmarks, also as fractions of total height.
_NECK_TOP = 0.878
_HEAD_CENTRE = 0.932
_HEAD_RADIUS = 0.062
_SHOULDER_Y = 0.810
# Must be *inside* the torso surface (half-width 0.080 at the shoulder girdle),
# or the arms render as detached limbs floating beside the body.
_SHOULDER_X = 0.068
_UPPER_ARM = 0.175
_FOREARM = 0.157
_HIP_JOINT_Y = 0.530
_HIP_JOINT_X = 0.047
_THIGH = 0.245
_SHIN = 0.245
# Arms held away from the torso: separates limbs from the body, which
# materially improves segmentation and shape fitting (docs/05 §3).
_ARM_ANGLE_DEG = 30.0


def _ellipse_ring(cx: float, cy: float, cz: float, half_w: float, half_d: float) -> np.ndarray:
    theta = np.linspace(0.0, 2.0 * np.pi, RADIAL_SEGMENTS, endpoint=False)
    x = cx + half_w * np.cos(theta)
    z = cz + half_d * np.sin(theta)
    y = np.full_like(theta, cy)
    return np.stack([x, y, z], axis=1)


def _loft(rings: list[np.ndarray], cap_bottom: bool = True, cap_top: bool = True) -> trimesh.Trimesh:
    """Stitch consecutive rings into a closed tube."""
    vertices = np.concatenate(rings, axis=0)
    faces: list[tuple[int, int, int]] = []
    n = RADIAL_SEGMENTS

    for level in range(len(rings) - 1):
        base = level * n
        nxt = base + n
        for i in range(n):
            j = (i + 1) % n
            faces.append((base + i, nxt + i, nxt + j))
            faces.append((base + i, nxt + j, base + j))

    verts = list(map(tuple, vertices))

    if cap_bottom:
        centre_idx = len(verts)
        verts.append(tuple(rings[0].mean(axis=0)))
        for i in range(n):
            j = (i + 1) % n
            faces.append((centre_idx, j, i))

    if cap_top:
        centre_idx = len(verts)
        verts.append(tuple(rings[-1].mean(axis=0)))
        base = (len(rings) - 1) * n
        for i in range(n):
            j = (i + 1) % n
            faces.append((centre_idx, base + i, base + j))

    return trimesh.Trimesh(
        vertices=np.array(verts, dtype=np.float64),
        faces=np.array(faces, dtype=np.int64),
        process=False,
    )


def _tapered_limb(
    start: np.ndarray,
    end: np.ndarray,
    r_start: float,
    r_end: float,
    segments: int = 6,
) -> trimesh.Trimesh:
    """A limb as a tapered tube between two points."""
    axis = end - start
    length = float(np.linalg.norm(axis))
    if length < 1e-6:
        return trimesh.Trimesh()

    direction = axis / length

    # Orthonormal frame around the limb axis.
    reference = np.array([0.0, 0.0, 1.0]) if abs(direction[2]) < 0.9 else np.array([1.0, 0.0, 0.0])
    u = np.cross(direction, reference)
    u /= np.linalg.norm(u)
    v = np.cross(direction, u)

    rings: list[np.ndarray] = []
    for s in range(segments + 1):
        t = s / segments
        centre = start + axis * t
        radius = r_start + (r_end - r_start) * t
        theta = np.linspace(0.0, 2.0 * np.pi, RADIAL_SEGMENTS, endpoint=False)
        ring = (
            centre[None, :]
            + radius * np.cos(theta)[:, None] * u[None, :]
            + radius * np.sin(theta)[:, None] * v[None, :]
        )
        rings.append(ring)

    return _loft(rings)


def build(shape: list[float] | np.ndarray, metric_scale: float = 1.0) -> trimesh.Trimesh:
    """Build a humanoid mesh from shape coefficients.

    Args:
        shape: coefficient vector (MHR-compatible, 45 dims).
        metric_scale: multiplier taking the canonical mesh to real-world size.

    Returns:
        A watertight-ish trimesh in metres, Y-up, facing +Z.
    """
    p = BodyProportions.from_shape(shape)

    # One height, one frame of reference. Every landmark derives from H.
    h = CANONICAL_HEIGHT_M * p.height

    # ── Torso ──
    torso_rings: list[np.ndarray] = []
    for frac, half_w, half_d in _TORSO_SECTIONS:
        width_mult = p.girth
        depth_mult = p.girth * p.chest_depth

        if frac <= 0.535:  # crotch through seat
            width_mult *= p.hip_width
        elif frac <= 0.625:  # waist
            width_mult *= p.waist
            depth_mult *= p.waist
        elif frac >= 0.775:  # shoulder girdle
            width_mult *= p.shoulder_width

        torso_rings.append(
            _ellipse_ring(0.0, frac * h, 0.0, half_w * h * width_mult, half_d * h * depth_mult)
        )

    torso = _loft(torso_rings)

    # ── Neck and head ──
    neck = _tapered_limb(
        np.array([0.0, _TORSO_SECTIONS[-1][0] * h - 0.005 * h, 0.0]),
        np.array([0.0, _NECK_TOP * h, 0.0]),
        0.036 * h * p.neck,
        0.033 * h * p.neck,
        segments=2,
    )

    head = trimesh.creation.icosphere(subdivisions=2, radius=_HEAD_RADIUS * h)
    head.apply_scale([0.88, 1.18, 0.96])
    head.apply_translation([0.0, _HEAD_CENTRE * h, 0.0])

    # ── Arms ──
    shoulder_y = _SHOULDER_Y * h
    shoulder_x = _SHOULDER_X * h * p.shoulder_width
    upper_len = _UPPER_ARM * h * p.limb_length
    fore_len = _FOREARM * h * p.limb_length
    angle = np.deg2rad(_ARM_ANGLE_DEG)
    fore_angle = angle * 0.8

    limbs: list[trimesh.Trimesh] = []
    for side in (-1.0, 1.0):
        shoulder = np.array([side * shoulder_x, shoulder_y, 0.0])
        elbow = shoulder + np.array(
            [side * upper_len * np.sin(angle), -upper_len * np.cos(angle), 0.0]
        )
        wrist = elbow + np.array(
            [side * fore_len * np.sin(fore_angle), -fore_len * np.cos(fore_angle), 0.0]
        )
        limbs.append(_tapered_limb(shoulder, elbow, 0.030 * h * p.girth, 0.024 * h * p.girth))
        limbs.append(_tapered_limb(elbow, wrist, 0.024 * h * p.girth, 0.018 * h * p.girth))

        hand = trimesh.creation.icosphere(subdivisions=1, radius=0.024 * h * p.girth)
        hand.apply_scale([0.7, 1.35, 0.45])
        hand.apply_translation(wrist + np.array([0.0, -0.022 * h, 0.0]))
        limbs.append(hand)

    # ── Legs ──
    hip_y = _HIP_JOINT_Y * h
    hip_x = _HIP_JOINT_X * h * p.hip_width
    thigh_len = _THIGH * h * p.limb_length
    shin_len = _SHIN * h * p.limb_length

    for side in (-1.0, 1.0):
        hip = np.array([side * hip_x, hip_y, 0.0])
        knee = np.array([side * hip_x * 0.90, hip_y - thigh_len, 0.0])
        ankle = np.array([side * hip_x * 0.82, knee[1] - shin_len, 0.0])
        limbs.append(_tapered_limb(hip, knee, 0.050 * h * p.girth, 0.033 * h * p.girth))
        limbs.append(_tapered_limb(knee, ankle, 0.033 * h * p.girth, 0.022 * h * p.girth))

        # Foot extends forward in +Z, which sets the model's facing direction.
        foot = trimesh.creation.box(extents=[0.048 * h * p.girth, 0.030 * h, 0.145 * h])
        foot.apply_translation(ankle + np.array([0.0, -0.012 * h, 0.042 * h]))
        limbs.append(foot)

    mesh = trimesh.util.concatenate([torso, neck, head, *limbs])

    # Ground at y=0 and centre horizontally, so the viewer's grid and contact
    # shadow line up without per-model fiddling.
    bounds = mesh.bounds
    mesh.apply_translation(
        [
            -(bounds[0][0] + bounds[1][0]) / 2.0,
            -bounds[0][1],
            -(bounds[0][2] + bounds[1][2]) / 2.0,
        ]
    )

    # Normalise to the exact requested stature.
    #
    # Landmark fractions do not sum to precisely 1.0 (the head sphere's top
    # depends on its scaling), leaving ~1% error. When a user states their
    # height, the delivered model must be that height — an avatar 1.5 cm off
    # would poison every measurement derived from it later.
    if metric_scale and metric_scale > 0:
        target_height = CANONICAL_HEIGHT_M * float(metric_scale)
        current_height = float(mesh.bounds[1][1] - mesh.bounds[0][1])
        if current_height > 1e-6:
            mesh.apply_scale(target_height / current_height)
            mesh.apply_translation([0.0, -float(mesh.bounds[0][1]), 0.0])

    mesh.merge_vertices()
    # multibody=True: the model is a concatenation of separate closed parts
    # (torso, head, four limbs), so winding must be fixed per component.
    mesh.fix_normals(multibody=True)

    return mesh


def apply_cylindrical_uv(mesh: trimesh.Trimesh) -> np.ndarray:
    """Cylindrical UV projection around the body axis.

    A proper xatlas parameterisation is better and is what the real pipeline
    uses (cached per topology, never per job). This keeps the mock path free of
    the xatlas dependency while still giving the texture bake a valid mapping.
    """
    verts = mesh.vertices
    centre_x = float((verts[:, 0].min() + verts[:, 0].max()) / 2.0)
    centre_z = float((verts[:, 2].min() + verts[:, 2].max()) / 2.0)

    dx = verts[:, 0] - centre_x
    dz = verts[:, 2] - centre_z

    # u from angle around the axis; v from normalised height.
    u = (np.arctan2(dz, dx) + np.pi) / (2.0 * np.pi)
    y_min, y_max = float(verts[:, 1].min()), float(verts[:, 1].max())
    v = (verts[:, 1] - y_min) / max(1e-6, y_max - y_min)

    return np.stack([u, v], axis=1)
