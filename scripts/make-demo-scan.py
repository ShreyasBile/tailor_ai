"""Render a synthetic four-view scan from the parametric body.

Produces front/back/left/right JPEGs of a shaded figure against a wall, plus
`truth.json` with the height used. The body is our own parametric model
(commercially clean), so these images can ship as the web app's sample scan.

They exercise the real pipeline end to end — detector, quality gate,
measurement, body fit — but they are renders, not people: use them for demos
and integration tests, never as accuracy evidence (see validate-bodym.py).

Usage:
    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\make-demo-scan.py [out_dir]
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))

from app.bodymodel.humanoid import SHAPE_DIMS, build  # noqa: E402

W, H = 1080, 1440
HEIGHT_CM = 172.0
LIGHT = np.array([0.45, 0.55, 0.70])
LIGHT /= np.linalg.norm(LIGHT)

YAW = {"front": 0.0, "left": -90.0, "back": 180.0, "right": 90.0}


def render(mesh, yaw_deg: float, rng: np.random.Generator) -> np.ndarray:
    a = np.deg2rad(yaw_deg)
    rot = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    v = mesh.vertices @ rot.T
    y0, y1 = v[:, 1].min(), v[:, 1].max()
    s = 0.78 * H / (y1 - y0)
    px = np.stack([W / 2 + v[:, 0] * s, H * 0.90 - (v[:, 1] - y0) * s], axis=1)

    # Wall-and-floor backdrop with a soft vignette.
    yy = np.linspace(0, 1, H)[:, None]
    wall = (228 - 18 * yy) * np.ones((1, W))
    img = np.dstack([wall * 0.98, wall * 0.97, wall * 0.93]).astype(np.float32)
    floor = int(H * 0.905)
    img[floor:] = (196, 192, 186)

    # Painter's algorithm: far faces first, Lambert shading per face.
    normals = mesh.face_normals @ rot.T
    depth = v[mesh.faces][:, :, 2].mean(axis=1)
    order = np.argsort(depth)
    base = np.array([62, 66, 74], np.float32)  # dark fitted clothing (BGR)
    for f in order:
        n = normals[f]
        if n[2] < -0.05:  # back-facing
            continue
        shade = 0.45 + 0.55 * max(0.0, float(n @ LIGHT))
        cv2.fillConvexPoly(img, px[mesh.faces[f]].astype(np.int32), (base * shade * 1.9).tolist(), lineType=cv2.LINE_AA)

    # Soft contact shadow, then sensor noise so it reads like a photo.
    shadow = np.zeros((H, W), np.float32)
    cv2.ellipse(shadow, (W // 2, floor + 4), (int(W * 0.16), 14), 0, 0, 360, 1.0, -1)
    shadow = cv2.GaussianBlur(shadow, (0, 0), 9)
    img *= (1 - 0.25 * shadow)[..., None]
    img += rng.normal(0, 3.0, img.shape).astype(np.float32)
    return np.clip(img, 0, 255).astype(np.uint8)


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "apps" / "web" / "public" / "demo-scan"
    out.mkdir(parents=True, exist_ok=True)
    shape = np.zeros(SHAPE_DIMS)
    # Average-to-full build with realistic shoulder breadth and arm length (the
    # parametric defaults are narrow-shouldered and short-armed for 172 cm).
    shape[1], shape[3], shape[5] = 0.45, 0.3, 0.2
    shape[2], shape[6] = 1.8, 0.9
    mesh = build(shape.tolist(), metric_scale=HEIGHT_CM / 175.0)
    rng = np.random.default_rng(7)
    for view, yaw in YAW.items():
        cv2.imwrite(str(out / f"{view}.jpg"), render(mesh, yaw, rng), [cv2.IMWRITE_JPEG_QUALITY, 90])
    (out / "truth.json").write_text(json.dumps({"heightCm": HEIGHT_CM, "synthetic": True}, indent=2))
    print(f"wrote 4 views to {out}")


if __name__ == "__main__":
    main()
