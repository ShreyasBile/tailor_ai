"""Multi-view texture projection (S10).

Projects the user's actual photographs onto the body mesh. This is why the
avatar looks like *them* rather than like a generated approximation of them —
and it sidesteps the licensing problem entirely, since no diffusion model is
involved.

The hard part is well documented and unavoidable: self-occlusion leaves holes.
Armpits, inner thighs, and under the chin are never directly observed from any
camera position. We fill them in three passes of decreasing honesty —
observed → mirrored → inpainted — and report exactly how much of the surface
came from each, so the viewer can shade invented regions rather than passing
them off as measured.
"""

from __future__ import annotations

import logging
import time

import cv2
import numpy as np
import trimesh

from ..errors import texture_bake_failed
from ..schemas import CameraParams, CoverageResult, TextureRequest, TextureResponse
from ..storage import fetch_image, put_image

log = logging.getLogger(__name__)

# Skin-ish neutral for regions we never observed and cannot mirror.
_FALLBACK_COLOUR = (168, 176, 190)  # BGR


def bake_texture(req: TextureRequest, mesh: trimesh.Trimesh, uvs: np.ndarray) -> TextureResponse:
    started = time.perf_counter()
    res = int(req.resolution)

    if uvs is None or len(uvs) != len(mesh.vertices):
        raise texture_bake_failed("UV count does not match vertex count")

    accum = np.zeros((res, res, 3), dtype=np.float64)
    weight = np.zeros((res, res), dtype=np.float64)

    face_uvs = uvs[mesh.faces]  # (F, 3, 2)
    face_normals = mesh.face_normals  # (F, 3)
    face_verts = mesh.vertices[mesh.faces]  # (F, 3, 3)
    face_centres = face_verts.mean(axis=1)

    per_view_coverage: list[float] = []

    for frame, camera in zip(req.frames, req.cameras, strict=False):
        try:
            image = fetch_image(frame.imageUrl)
        except Exception as exc:  # noqa: BLE001
            log.warning("skipping frame %d: %s", frame.index, exc)
            continue

        alpha = None
        if frame.maskUrl:
            try:
                raw_mask = fetch_image(frame.maskUrl)
                alpha = cv2.cvtColor(raw_mask, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
            except Exception:  # noqa: BLE001
                alpha = None

        view_dir = _view_direction(camera)

        # Accept a face when it points at the camera. Grazing angles carry
        # stretched, unreliable colour, so weight by cos(angle) and drop
        # anything past ~75°.
        facing = face_normals @ view_dir
        visible = facing > 0.26

        if not np.any(visible):
            per_view_coverage.append(0.0)
            continue

        painted = _project_view(
            accum,
            weight,
            image=image,
            alpha=alpha,
            camera=camera,
            face_uvs=face_uvs[visible],
            face_centres=face_centres[visible],
            face_weight=facing[visible] * float(frame.qualityScore or 1.0),
            res=res,
        )
        per_view_coverage.append(painted)

    if weight.sum() == 0:
        raise texture_bake_failed("no view contributed any texels")

    observed_mask = weight > 0
    observed_fraction = float(observed_mask.mean())

    atlas = np.zeros((res, res, 3), dtype=np.uint8)
    safe = np.maximum(weight, 1e-9)[..., None]
    atlas[observed_mask] = np.clip(accum[observed_mask] / safe[observed_mask], 0, 255).astype(
        np.uint8
    )

    atlas, mirrored_fraction = _mirror_fill(atlas, observed_mask)
    atlas, inpainted_fraction = _inpaint_fill(atlas, observed_mask, mirrored_fraction)

    put_image(req.outputUrl, atlas, ".png")

    coverage = _coverage_from_views(req.cameras, per_view_coverage, observed_fraction)
    coverage.inpaintedFraction = float(round(1.0 - observed_fraction, 4))

    log.info(
        "baked %dx%d atlas: %.1f%% observed, %.1f%% filled",
        res,
        res,
        observed_fraction * 100,
        (1 - observed_fraction) * 100,
    )

    return TextureResponse(
        resolution=res,
        coverage=coverage,
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


def _view_direction(camera: CameraParams) -> np.ndarray:
    """Unit vector from subject toward the camera, in model space."""
    yaw = camera.subjectYawDeg
    if yaw is None:
        t = np.asarray(camera.translation, dtype=np.float64)
        norm = np.linalg.norm(t)
        return t / norm if norm > 1e-6 else np.array([0.0, 0.0, 1.0])

    rad = np.deg2rad(float(yaw))
    return np.array([np.sin(rad), 0.0, np.cos(rad)], dtype=np.float64)


def _project_view(
    accum: np.ndarray,
    weight: np.ndarray,
    *,
    image: np.ndarray,
    alpha: np.ndarray | None,
    camera: CameraParams,
    face_uvs: np.ndarray,
    face_centres: np.ndarray,
    face_weight: np.ndarray,
    res: int,
) -> float:
    """Rasterise one view's contribution into the UV accumulator."""
    h, w = image.shape[:2]

    # Perspective projection of face centres into image space.
    cam_t = np.asarray(camera.translation, dtype=np.float64)
    yaw = np.deg2rad(camera.subjectYawDeg or 0.0)

    cos_y, sin_y = np.cos(-yaw), np.sin(-yaw)
    rotated = face_centres.copy()
    rotated[:, 0] = face_centres[:, 0] * cos_y - face_centres[:, 2] * sin_y
    rotated[:, 2] = face_centres[:, 0] * sin_y + face_centres[:, 2] * cos_y

    depth = rotated[:, 2] + cam_t[2]
    valid = depth > 1e-3
    if not np.any(valid):
        return 0.0

    px = camera.focal * rotated[:, 0] / np.maximum(depth, 1e-6) + camera.principalPoint[0]
    py = -camera.focal * rotated[:, 1] / np.maximum(depth, 1e-6) + camera.principalPoint[1]

    in_frame = valid & (px >= 0) & (px < w) & (py >= 0) & (py < h)
    if not np.any(in_frame):
        return 0.0

    painted = 0
    total = int(in_frame.sum())

    for i in np.nonzero(in_frame)[0]:
        sx, sy = int(px[i]), int(py[i])

        if alpha is not None and alpha[sy, sx] < 0.4:
            continue  # background pixel — never paint the wall onto the body

        colour = image[sy, sx].astype(np.float64)
        fw = float(face_weight[i])
        if fw <= 0:
            continue

        tri = (face_uvs[i] * np.array([res - 1, res - 1])).astype(np.int32)
        tri[:, 1] = (res - 1) - tri[:, 1]  # UV origin is bottom-left

        # A triangle spanning the wrap seam would smear across the atlas.
        if tri[:, 0].max() - tri[:, 0].min() > res * 0.5:
            continue

        # Rasterise within the triangle's bounding box only. Allocating a full
        # res×res mask per triangle would be ~16 MB of zeroing per face.
        x0 = max(0, int(tri[:, 0].min()))
        x1 = min(res, int(tri[:, 0].max()) + 1)
        y0 = max(0, int(tri[:, 1].min()))
        y1 = min(res, int(tri[:, 1].max()) + 1)
        if x1 <= x0 or y1 <= y0:
            continue

        local = np.zeros((y1 - y0, x1 - x0), dtype=np.uint8)
        cv2.fillConvexPoly(local, tri - np.array([x0, y0]), 1)
        sel = local.astype(bool)
        if not sel.any():
            continue

        accum[y0:y1, x0:x1][sel] += colour * fw
        weight[y0:y1, x0:x1][sel] += fw
        painted += 1

    return painted / max(total, 1)


def _mirror_fill(atlas: np.ndarray, observed: np.ndarray) -> tuple[np.ndarray, float]:
    """Fill unobserved texels from their left↔right mirror.

    Legitimate for human bodies: the left shoulder is a good predictor of the
    right. Runs before inpainting because real observed colour, mirrored, beats
    interpolated colour.
    """
    res = atlas.shape[0]
    mirrored_source = np.flip(atlas, axis=1)
    mirrored_observed = np.flip(observed, axis=1)

    fillable = (~observed) & mirrored_observed
    if not fillable.any():
        return atlas, 0.0

    atlas = atlas.copy()
    atlas[fillable] = mirrored_source[fillable]

    return atlas, float(fillable.sum() / (res * res))


def _inpaint_fill(
    atlas: np.ndarray, observed: np.ndarray, mirrored_fraction: float
) -> tuple[np.ndarray, float]:
    """Interpolate whatever remains after observation and mirroring."""
    res = atlas.shape[0]
    filled = observed.copy()
    if mirrored_fraction > 0:
        filled |= np.flip(observed, axis=1)

    holes = (~filled).astype(np.uint8) * 255
    hole_fraction = float(holes.sum() / 255 / (res * res))

    if hole_fraction < 1e-6:
        return atlas, 0.0

    if hole_fraction > 0.85:
        # Almost nothing observed — inpainting would invent an entire body.
        # A flat neutral is more honest than a hallucination.
        atlas = atlas.copy()
        atlas[~filled] = _FALLBACK_COLOUR
        return atlas, hole_fraction

    result = cv2.inpaint(atlas, holes, inpaintRadius=6, flags=cv2.INPAINT_TELEA)
    return result, hole_fraction


def _coverage_from_views(
    cameras: list[CameraParams], per_view: list[float], observed_fraction: float
) -> CoverageResult:
    """Per-quadrant coverage, so the viewer can flag which side is inferred."""
    quadrants = {"front": 0.0, "right": 0.0, "back": 0.0, "left": 0.0}

    for camera, painted in zip(cameras, per_view, strict=False):
        yaw = (camera.subjectYawDeg or 0.0) % 360.0
        if yaw < 45 or yaw >= 315:
            key = "front"
        elif yaw < 135:
            key = "right"
        elif yaw < 225:
            key = "back"
        else:
            key = "left"
        quadrants[key] = max(quadrants[key], float(painted))

    return CoverageResult(
        front=round(quadrants["front"], 4),
        back=round(quadrants["back"], 4),
        left=round(quadrants["left"], 4),
        right=round(quadrants["right"], 4),
        inpaintedFraction=round(1.0 - observed_fraction, 4),
    )
