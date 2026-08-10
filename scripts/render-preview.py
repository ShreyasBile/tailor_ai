"""Renders a multi-view preview of a produced avatar.

Diagnostic only — the mobile app uses Filament for real rendering. This exists
so the output of a headless pipeline run can be eyeballed without a device.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image

VIEWS = [("front", 0), ("right", 90), ("back", 180), ("left", 270)]
SIZE = 420
BG = (14, 14, 16)


def render(mesh: trimesh.Trimesh, yaw_deg: float, size: int) -> np.ndarray:
    import cv2

    canvas = np.zeros((size, size, 3), dtype=np.uint8)
    canvas[:] = BG

    yaw = np.deg2rad(yaw_deg)
    cos_y, sin_y = np.cos(yaw), np.sin(yaw)

    v = mesh.vertices.copy()
    rot = v.copy()
    rot[:, 0] = v[:, 0] * cos_y - v[:, 2] * sin_y
    rot[:, 2] = v[:, 0] * sin_y + v[:, 2] * cos_y

    n = mesh.face_normals.copy()
    rn = n.copy()
    rn[:, 0] = n[:, 0] * cos_y - n[:, 2] * sin_y
    rn[:, 2] = n[:, 0] * sin_y + n[:, 2] * cos_y

    y_min, y_max = float(rot[:, 1].min()), float(rot[:, 1].max())
    span = (y_max - y_min) * 1.15
    cx = (float(rot[:, 0].min()) + float(rot[:, 0].max())) / 2
    cy = (y_min + y_max) / 2

    px = ((rot[:, 0] - cx) / span + 0.5) * size
    py = (1.0 - ((rot[:, 1] - cy) / span + 0.5)) * size
    pts = np.stack([px, py], axis=1).astype(np.int32)

    # Painter's algorithm, front faces only, lambert shading from upper-left.
    light = np.array([-0.4, 0.5, 0.75])
    light /= np.linalg.norm(light)

    facing = rn[:, 2] > 0
    idx = np.nonzero(facing)[0]
    depth = rot[mesh.faces[idx]][:, :, 2].mean(axis=1)
    order = idx[np.argsort(depth)]

    for f in order:
        lam = float(np.clip(np.dot(rn[f], light), 0.0, 1.0))
        shade = 0.22 + 0.78 * lam
        colour = (int(150 * shade), int(160 * shade), int(178 * shade))
        cv2.fillConvexPoly(canvas, pts[mesh.faces[f]], colour)

    cv2.putText(
        canvas, f"{yaw_deg:.0f}", (12, size - 14),
        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (110, 110, 120), 1, cv2.LINE_AA,
    )
    return canvas


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "D:/tailorai/.data/smoke-avatar.glb")
    out = Path(sys.argv[2] if len(sys.argv) > 2 else "D:/tailorai/.data/avatar-preview.png")

    data = src.read_bytes()
    mesh = trimesh.load(io.BytesIO(data), file_type="glb", force="mesh")
    if not isinstance(mesh, trimesh.Trimesh):
        raise SystemExit("not a mesh")

    height_cm = (mesh.bounds[1][1] - mesh.bounds[0][1]) * 100
    print(f"  source     {src.name}  ({len(data) / 1024:.0f} KB)")
    print(f"  geometry   {len(mesh.vertices)} verts, {len(mesh.faces)} tris")
    print(f"  height     {height_cm:.1f} cm")
    print(f"  width      {(mesh.bounds[1][0] - mesh.bounds[0][0]) * 100:.1f} cm (A-pose span)")
    print(f"  depth      {(mesh.bounds[1][2] - mesh.bounds[0][2]) * 100:.1f} cm")
    print(f"  grounded   y={mesh.bounds[0][1]:.4f}")
    print(f"  watertight {mesh.is_watertight}")

    tiles = [render(mesh, yaw, SIZE) for _, yaw in VIEWS]
    strip = np.concatenate(tiles, axis=1)

    Image.fromarray(strip[:, :, ::-1]).save(out, optimize=True)
    print(f"\n  preview    {out}")


if __name__ == "__main__":
    main()
