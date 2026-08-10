"""Mesh assembly and export (S11/S12).

Produces the GLB the mobile viewer loads, plus OBJ for interoperability and a
thumbnail for list screens.

Budget: under 5 MB GLB, because that is what renders smoothly on a mid-range
Android (docs/05 §5).
"""

from __future__ import annotations

import io
import logging
import time
import zipfile

import numpy as np
import trimesh
from PIL import Image

from ..bodymodel.humanoid import apply_cylindrical_uv, build as build_humanoid
from ..errors import mesh_invalid
from ..schemas import BuildMeshRequest, BuildMeshResponse
from ..storage import fetch_bytes, put_bytes

log = logging.getLogger(__name__)

THUMBNAIL_SIZE = 512


def build_mesh(req: BuildMeshRequest) -> BuildMeshResponse:
    started = time.perf_counter()

    mesh = build_humanoid(req.shape, req.metricScale)

    if len(mesh.vertices) == 0 or len(mesh.faces) == 0:
        raise mesh_invalid("generated mesh is empty")

    uvs = apply_cylindrical_uv(mesh)

    texture_image: Image.Image | None = None
    if req.textureUrl:
        try:
            texture_image = Image.open(io.BytesIO(fetch_bytes(req.textureUrl))).convert("RGB")
        except Exception as exc:  # noqa: BLE001
            # Degrade rather than fail — an untextured avatar beats no avatar,
            # and the orchestrator records the degradation.
            log.warning("texture fetch failed, exporting untextured: %s", exc)

    if texture_image is not None:
        material = trimesh.visual.material.PBRMaterial(
            baseColorTexture=texture_image,
            metallicFactor=0.0,
            roughnessFactor=0.85,
        )
        mesh.visual = trimesh.visual.TextureVisuals(uv=uvs, material=material)
    else:
        mesh.visual = trimesh.visual.TextureVisuals(
            uv=uvs,
            material=trimesh.visual.material.PBRMaterial(
                baseColorFactor=[0.72, 0.74, 0.78, 1.0],
                metallicFactor=0.0,
                roughnessFactor=0.9,
            ),
        )

    glb_bytes = _export_glb(mesh)
    put_bytes(req.outputGlbUrl, glb_bytes, "model/gltf-binary")

    obj_bytes: int | None = None
    if req.outputObjUrl:
        try:
            archive = _export_obj_zip(mesh, texture_image)
            put_bytes(req.outputObjUrl, archive, "application/zip")
            obj_bytes = len(archive)
        except Exception as exc:  # noqa: BLE001
            log.warning("OBJ export failed (GLB unaffected): %s", exc)

    try:
        put_bytes(req.outputThumbnailUrl, _render_thumbnail(mesh, texture_image), "image/png")
    except Exception as exc:  # noqa: BLE001
        log.warning("thumbnail render failed: %s", exc)

    log.info(
        "built mesh: %d verts, %d tris, glb %.2f MB",
        len(mesh.vertices),
        len(mesh.faces),
        len(glb_bytes) / 1024 / 1024,
    )

    return BuildMeshResponse(
        vertexCount=int(len(mesh.vertices)),
        triangleCount=int(len(mesh.faces)),
        glbBytes=len(glb_bytes),
        objBytes=obj_bytes,
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


def _export_glb(mesh: trimesh.Trimesh) -> bytes:
    scene = trimesh.Scene(mesh)
    data = scene.export(file_type="glb")
    if not isinstance(data, bytes):
        data = bytes(data)
    if len(data) == 0:
        raise mesh_invalid("GLB export produced no bytes")
    return data


def _export_obj_zip(mesh: trimesh.Trimesh, texture: Image.Image | None) -> bytes:
    """OBJ + MTL + texture, zipped.

    OBJ is the lowest common denominator — it opens in Blender, Maya, and
    anything a tailor or manufacturer is likely to run.
    """
    buffer = io.BytesIO()

    obj_text = trimesh.exchange.obj.export_obj(
        mesh, include_texture=texture is not None, mtl_name="avatar.mtl"
    )
    if isinstance(obj_text, bytes):
        obj_text = obj_text.decode("utf-8")

    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("avatar.obj", obj_text)

        if texture is not None:
            tex_buf = io.BytesIO()
            texture.save(tex_buf, format="PNG", optimize=True)
            archive.writestr("avatar_texture.png", tex_buf.getvalue())
            archive.writestr(
                "avatar.mtl",
                "newmtl material_0\n"
                "Ka 1.000 1.000 1.000\n"
                "Kd 1.000 1.000 1.000\n"
                "Ks 0.000 0.000 0.000\n"
                "d 1.0\n"
                "illum 2\n"
                "map_Kd avatar_texture.png\n",
            )
        else:
            archive.writestr(
                "avatar.mtl",
                "newmtl material_0\nKa 0.7 0.7 0.7\nKd 0.72 0.74 0.78\nKs 0.0 0.0 0.0\nd 1.0\nillum 2\n",
            )

        archive.writestr(
            "README.txt",
            "TailorAI avatar export\n\n"
            "avatar.obj  — geometry, metres, Y-up\n"
            "avatar.mtl  — material\n"
            "avatar_texture.png — colour map (if textured)\n\n"
            "Units are metres. The model is grounded at y=0 and faces +Z.\n",
        )

    return buffer.getvalue()


def _render_thumbnail(mesh: trimesh.Trimesh, texture: Image.Image | None) -> bytes:
    """Orthographic silhouette thumbnail.

    Deliberately not a real render: offscreen GL on a headless worker is a
    reliability liability for a list-screen image. A clean silhouette with the
    average texture tone reads well at 100 px and never fails.
    """
    size = THUMBNAIL_SIZE
    canvas = np.zeros((size, size, 4), dtype=np.uint8)

    verts = mesh.vertices
    x_min, x_max = float(verts[:, 0].min()), float(verts[:, 0].max())
    y_min, y_max = float(verts[:, 1].min()), float(verts[:, 1].max())

    span = max(x_max - x_min, y_max - y_min, 1e-6) * 1.12
    cx, cy = (x_min + x_max) / 2.0, (y_min + y_max) / 2.0

    def to_px(p: np.ndarray) -> np.ndarray:
        u = (p[:, 0] - cx) / span + 0.5
        v = 1.0 - ((p[:, 1] - cy) / span + 0.5)
        return np.stack([u * size, v * size], axis=1).astype(np.int32)

    if texture is not None:
        tint = np.array(texture.resize((16, 16))).reshape(-1, 3).mean(axis=0)
        colour = (int(tint[2]), int(tint[1]), int(tint[0]), 255)
    else:
        colour = (200, 190, 184, 255)

    import cv2  # noqa: PLC0415

    # Front-facing triangles only, painted back to front for a solid silhouette.
    front = mesh.face_normals[:, 2] > 0
    faces = mesh.faces[front]
    depths = mesh.vertices[faces][:, :, 2].mean(axis=1)
    order = np.argsort(depths)

    points = to_px(mesh.vertices)
    for idx in order:
        cv2.fillConvexPoly(canvas, points[faces[idx]], colour)

    image = Image.fromarray(canvas, mode="RGBA")
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()
