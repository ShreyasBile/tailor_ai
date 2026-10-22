"""Software-rasterize a textured GLB to PNGs (front/back/left) with UV texture
sampling. No OpenGL — pure numpy — so it works headless and reliably.

Shows the real baked texture, including which regions are observed vs inpainted.
"""
from __future__ import annotations
import io, sys
from pathlib import Path
import numpy as np
import trimesh
from PIL import Image

SIZE = 500
BG = (12, 12, 18)

def load(path):
    data = open(path, "rb").read()
    m = trimesh.load(io.BytesIO(data), file_type="glb", force="mesh", process=False)
    uv = None
    tex = None
    vis = getattr(m, "visual", None)
    if vis is not None and hasattr(vis, "uv") and vis.uv is not None:
        uv = np.asarray(vis.uv, dtype=np.float64)
        mat = getattr(vis, "material", None)
        img = getattr(mat, "baseColorTexture", None) if mat else None
        if img is not None:
            tex = np.asarray(img.convert("RGB"))
    return m, uv, tex

def render(m, uv, tex, yaw_deg, size=SIZE):
    import cv2
    canvas = np.full((size, size, 3), BG, np.uint8)
    yaw = np.deg2rad(yaw_deg); cy_, sy_ = np.cos(yaw), np.sin(yaw)
    v = m.vertices.copy()
    r = v.copy(); r[:, 0] = v[:, 0]*cy_ - v[:, 2]*sy_; r[:, 2] = v[:, 0]*sy_ + v[:, 2]*cy_
    n = m.face_normals.copy()
    rn = n.copy(); rn[:, 0] = n[:, 0]*cy_ - n[:, 2]*sy_; rn[:, 2] = n[:, 0]*sy_ + n[:, 2]*cy_
    ymin, ymax = r[:, 1].min(), r[:, 1].max()
    span = (ymax - ymin) * 1.12
    cx = (r[:, 0].min() + r[:, 0].max())/2; cyy = (ymin+ymax)/2
    px = ((r[:, 0]-cx)/span + 0.5)*size
    py = (1 - ((r[:, 1]-cyy)/span + 0.5))*size
    pts = np.stack([px, py], 1)
    light = np.array([-0.3, 0.4, 0.85]); light /= np.linalg.norm(light)
    faces = m.faces
    front = rn[:, 2] > 0
    idx = np.nonzero(front)[0]
    order = idx[np.argsort(r[faces[idx]][:, :, 2].mean(1))]
    th, tw = (tex.shape[0], tex.shape[1]) if tex is not None else (0, 0)
    for f in order:
        tri = faces[f]
        p = pts[tri].astype(np.int32)
        x0, y0 = p[:, 0].min(), p[:, 1].min(); x1, y1 = p[:, 0].max(), p[:, 1].max()
        x0 = max(0, x0); y0 = max(0, y0); x1 = min(size-1, x1); y1 = min(size-1, y1)
        if x1 <= x0 or y1 <= y0: continue
        lam = float(np.clip(np.dot(rn[f], light), 0, 1))*0.6 + 0.4
        if tex is not None and uv is not None:
            fuv = uv[tri]
            u = np.clip(fuv[:, 0].mean(), 0, 1); vv = np.clip(1-fuv[:, 1].mean(), 0, 1)
            col = tex[int(vv*(th-1)), int(u*(tw-1))].astype(float)
        else:
            col = np.array([150, 160, 178], float)
        col = np.clip(col*lam, 0, 255).astype(np.uint8)
        cv2.fillConvexPoly(canvas, p, (int(col[0]), int(col[1]), int(col[2])))
    return canvas

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parents[1] / ".data") + "/real-test/real-avatar.glb"
    out = sys.argv[2] if len(sys.argv) > 2 else str(Path(__file__).resolve().parents[1] / ".data") + "/real-test/real-avatar-render.png"
    m, uv, tex = load(path)
    hgt = (m.bounds[1][1]-m.bounds[0][1])*100
    print(f"  mesh: {len(m.vertices)} verts, {len(m.faces)} tris, height {hgt:.1f} cm")
    print(f"  texture: {'yes '+str(tex.shape) if tex is not None else 'none'}, uv: {'yes' if uv is not None else 'no'}")
    views = [("front", 0), ("3/4", 35), ("side", 90), ("back", 180)]
    tiles = [render(m, uv, tex, d) for _, d in views]
    strip = np.concatenate(tiles, 1)
    # labels
    import cv2
    for i, (name, _) in enumerate(views):
        cv2.putText(strip, name, (i*SIZE+12, SIZE-14), cv2.FONT_HERSHEY_SIMPLEX,
                    0.5, (140, 140, 150), 1, cv2.LINE_AA)
    Image.fromarray(strip[:, :, ::-1]).save(out)
    print(f"  saved {out}")

if __name__ == "__main__":
    main()
