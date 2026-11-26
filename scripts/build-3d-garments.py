"""Builds the shop's 3D garments from MakeHuman community clothes (CC0).

Every garment in apps/api/prisma/catalog.json names a MakeHuman clothing
asset (an .mhclo + .obj + textures, from the CC0 asset packs downloaded to
.data/vendor/mh-assets/<pack>/x/clothes/<asset>/). MakeHuman clothes are made
to fit *any* MakeHuman body: each garment vertex is a weighted point on three
base-mesh vertices plus an offset, scaled by the body's proportions. The
shopper's 3D body (Anny) is built from the same MakeHuman base mesh, so the
real garment can be wrapped onto their own scanned body in the browser.

One wrinkle: most garments hang off MakeHuman's invisible *helper* geometry
(a tights layer, a skirt layer), which Anny drops. Anny can keep it, and
helpers move with the same shape parameters as the body, so each helper
vertex is learned once, here, as a fixed affine blend of nearby body
vertices (fitted over a few hundred random body shapes). The browser then
rebuilds the helpers from the body alone.

Writes apps/web/public/garments/3d/:
    helpers.json                 helper vertices as blends of body vertices
    <slug>.json + <slug>.jpg|png the fitted-garment recipe and its texture
    mannequin-male.json / -female.json   default bodies (for product shots)
and fills colorHex into catalog.json.

    services/reconstruction/.venv/Scripts/python.exe scripts/build-3d-garments.py
"""

from __future__ import annotations

import base64
import dataclasses
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))

import cv2  # noqa: E402
import torch  # noqa: E402
from scipy.spatial import cKDTree  # noqa: E402

from app.bodymodel import anny_body as ab  # noqa: E402

ASSETS = ROOT / ".data" / "vendor" / "mh-assets"
CATALOG = ROOT / "apps" / "api" / "prisma" / "catalog.json"
OUT = ROOT / "apps" / "web" / "public" / "garments" / "3d"
K_NEIGHBOURS = 32
SAMPLES = 240
TEX_MAX = 1024


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode("ascii")


# ── Anny with and without helpers ──


def models():
    import anny
    from anny.models.model_data import TopologyConfig

    std = ab._model()
    tc = dataclasses.replace(TopologyConfig.from_string("anny"), remove_unattached_vertices=False)
    full = anny.Anny(local_changes=ab.LOCAL_CHANGES, topology=tc)
    return std, full


def rest(model, p: np.ndarray) -> np.ndarray:
    phen = {n: float(np.clip(p[i], 0, 1)) for i, n in enumerate(ab.PHENOTYPES)}
    lc = {n: float(np.clip(p[len(ab.PHENOTYPES) + i], -1, 1)) for i, n in enumerate(ab.LOCAL_CHANGES)}
    with torch.no_grad():
        out = model(phenotype_kwargs=phen, local_changes_kwargs=lc)
    return out["rest_vertices"][0].double().numpy()


def learn_helpers(std, full):
    """Each base-mesh vertex Anny drops, as an affine blend of K body vertices."""
    bidx = std.base_mesh_vertex_indices.numpy()  # Anny vertex → base vertex
    fidx = full.base_mesh_vertex_indices.numpy()
    row_of = np.full(int(fidx.max()) + 1, -1)
    row_of[fidx] = np.arange(len(fidx))
    body_rows = row_of[bidx]
    n_base = int(fidx.max()) + 1
    in_body = np.zeros(n_base, bool)
    in_body[bidx] = True
    extra_base = np.nonzero(~in_body)[0]  # helper slots, in base order
    extra_rows = row_of[extra_base]

    rng = np.random.default_rng(7)
    P = [ab.default_params()]
    for _ in range(SAMPLES):
        p = np.zeros_like(P[0])
        p[: len(ab.PHENOTYPES)] = rng.uniform(0.0, 1.0, len(ab.PHENOTYPES))
        p[len(ab.PHENOTYPES):] = rng.uniform(-0.8, 0.8, len(ab.LOCAL_CHANGES))
        P.append(p)
    B, E = [], []
    for p in P:
        v = rest(full, p)
        B.append(v[body_rows])
        E.append(v[extra_rows])
    B = np.stack(B)  # (S, nb, 3)
    E = np.stack(E)  # (S, ne, 3)
    hold = slice(SAMPLES - 20, None)  # held out for the error report
    fit = slice(0, SAMPLES - 20)

    tmpl_body = B[0]
    tree = cKDTree(tmpl_body)
    _, nbr = tree.query(E[0], k=K_NEIGHBOURS)
    weights = np.zeros((len(extra_base), K_NEIGHBOURS))
    errs = []
    for e in range(len(extra_base)):
        n = nbr[e]
        X = B[:, n, :]  # (S, K, 3)
        D = X[:, 1:, :] - X[:, :1, :]  # (S, K-1, 3)
        y = E[:, e, :] - X[:, 0, :]  # (S, 3)
        A = D[fit].transpose(0, 2, 1).reshape(-1, K_NEIGHBOURS - 1)
        t = y[fit].reshape(-1)
        lam = 1e-6 * np.trace(A.T @ A) / (K_NEIGHBOURS - 1)
        a = np.linalg.solve(A.T @ A + lam * np.eye(K_NEIGHBOURS - 1), A.T @ t)
        w = np.concatenate([[1 - a.sum()], a])
        weights[e] = w
        pred = np.einsum("k,skc->sc", w, X[hold])
        errs.append(np.linalg.norm(pred - E[hold, e, :], axis=1).max())
    errs = np.array(errs)
    for gname, lo, hi in (("tights", 15328, 18002), ("skirt", 18002, 18722), ("other", 0, 15328)):
        sel = (extra_base >= lo) & (extra_base < hi)
        if sel.any():
            print(f"  {gname:7s} n={sel.sum():5d} median {np.median(errs[sel]) * 1000:.1f} mm  "
                  f"p95 {np.percentile(errs[sel], 95) * 1000:.1f} mm  max {errs[sel].max() * 1000:.1f} mm")
    print(f"helpers: {len(extra_base)} vertices, held-out error median {np.median(errs) * 1000:.2f} mm, "
          f"p99 {np.percentile(errs, 99) * 1000:.2f} mm, max {errs.max() * 1000:.2f} mm")
    # base vertex → extended index (body: Anny index; helper: n_body + slot)
    ext_of_base = np.full(n_base, -1)
    ext_of_base[bidx] = np.arange(len(bidx))
    ext_of_base[extra_base] = len(bidx) + np.arange(len(extra_base))
    return ext_of_base, nbr.astype(np.int32), weights.astype(np.float32), len(bidx)


# ── MakeHuman assets ──


def parse_mhclo(path: Path):
    header, refs, weights, offsets, delete = {}, [], [], [], []
    mode = None
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if raw.startswith("#"):
            c = raw.lstrip("#").strip().replace(":", " ", 1).split(None, 1)
            if len(c) == 2 and c[0] in ("author", "license"):
                header.setdefault(c[0], []).append([c[1].strip()])
            continue
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        p = line.split()
        if p[0] == "verts":
            mode = "verts"
            continue
        if p[0] == "delete_verts":
            mode = "delete"
            continue
        if mode == "verts" and len(p) in (1, 9) and p[0].lstrip("-").isdigit():
            if len(p) == 1:
                refs.append([int(p[0])] * 3)
                weights.append([1.0, 0.0, 0.0])
                offsets.append([0.0, 0.0, 0.0])
            else:
                refs.append([int(x) for x in p[:3]])
                weights.append([float(x) for x in p[3:6]])
                offsets.append([float(x) for x in p[6:9]])
            continue
        if mode == "delete":
            i = 0
            while i < len(p):
                if i + 2 < len(p) and p[i + 1] == "-":
                    delete.extend(range(int(p[i]), int(p[i + 2]) + 1))
                    i += 3
                else:
                    if p[i].isdigit():
                        delete.append(int(p[i]))
                    i += 1
            continue
        mode = None if p[0] not in ("verts", "delete_verts") else mode
        header.setdefault(p[0], []).append(p[1:])
    return header, np.array(refs), np.array(weights), np.array(offsets), delete


def parse_obj(path: Path):
    V, VT, faces = [], [], []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        if line.startswith("v "):
            V.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("vt "):
            VT.append([float(x) for x in line.split()[1:3]])
        elif line.startswith("f "):
            corners = []
            for c in line.split()[1:]:
                s = c.split("/")
                vi = int(s[0]) - 1
                ti = int(s[1]) - 1 if len(s) > 1 and s[1] else -1
                corners.append((vi, ti))
            for k in range(1, len(corners) - 1):  # fan-triangulate quads/ngons
                faces.append([corners[0], corners[k], corners[k + 1]])
    return np.array(V), np.array(VT) if VT else np.zeros((1, 2)), faces


def parse_mhmat(path: Path) -> dict:
    out = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        p = line.strip().split(None, 1)
        if len(p) == 2:
            out[p[0]] = p[1].strip()
    return out


def texture(src: Path, dst_base: Path) -> tuple[str, bool, np.ndarray | None]:
    img = cv2.imread(str(src), cv2.IMREAD_UNCHANGED)
    if img is None:
        return "", False, None
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    h, w = img.shape[:2]
    s = min(1.0, TEX_MAX / max(h, w))
    if s < 1:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    alpha = img.shape[2] == 4 and float(img[..., 3].min()) < 250
    if alpha:
        name = dst_base.name + ".png"
        cv2.imwrite(str(dst_base.with_suffix(".png")), img)
    else:
        name = dst_base.name + ".jpg"
        cv2.imwrite(str(dst_base.with_suffix(".jpg")), img[..., :3], [cv2.IMWRITE_JPEG_QUALITY, 88])
    return name, alpha, img


def garment_colour(img: np.ndarray | None, uv: np.ndarray, fallback: str) -> str:
    if img is None:
        return fallback
    h, w = img.shape[:2]
    xs = np.clip((uv[:, 0] % 1.0) * (w - 1), 0, w - 1).astype(int)
    ys = np.clip((1 - uv[:, 1] % 1.0) * (h - 1), 0, h - 1).astype(int)
    px = img[ys, xs, :3].astype(np.float32)
    if img.shape[2] == 4:
        px = px[img[ys, xs, 3] > 128]
    if len(px) == 0:
        return fallback
    b, g, r = np.median(px, axis=0)
    return f"#{int(r):02x}{int(g):02x}{int(b):02x}"


def rays_hit(origins: np.ndarray, dirs: np.ndarray, verts: np.ndarray, tri: np.ndarray, reach: float) -> np.ndarray:
    """Which rays hit the triangle mesh within `reach` (Moller-Trumbore,
    testing only triangles near each origin)."""
    cent = verts[tri].mean(axis=1)
    cand = cKDTree(cent).query_ball_point(origins, r=reach + 0.03)
    pv = np.repeat(np.arange(len(origins)), [len(c) for c in cand])
    pt = np.fromiter((t for c in cand for t in c), dtype=np.int64, count=len(pv))
    hit = np.zeros(len(origins), bool)
    if len(pv) == 0:
        return hit
    O, D = origins[pv], dirs[pv]
    v0, v1, v2 = verts[tri[pt, 0]], verts[tri[pt, 1]], verts[tri[pt, 2]]
    e1, e2 = v1 - v0, v2 - v0
    pvec = np.cross(D, e2)
    det = np.sum(e1 * pvec, axis=1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    tvec = O - v0
    u = np.sum(tvec * pvec, axis=1) * inv
    qvec = np.cross(tvec, e1)
    v = np.sum(D * qvec, axis=1) * inv
    t = np.sum(e2 * qvec, axis=1) * inv
    good = ok & (u >= 0) & (v >= 0) & (u + v <= 1) & (t > 0) & (t < reach)
    hit[pv[good]] = True
    return hit


_NORMALS: dict[int, np.ndarray] = {}


def body_normals(body: np.ndarray) -> np.ndarray:
    key = id(body)
    if key not in _NORMALS:
        f = ab.faces()
        fn = np.cross(body[f[:, 1]] - body[f[:, 0]], body[f[:, 2]] - body[f[:, 0]])
        vn = np.zeros_like(body)
        for k in range(3):
            np.add.at(vn, f[:, k], fn)
        vn /= np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)
        if float(np.mean(np.sum(vn * (body - body.mean(axis=0)), axis=1))) < 0:
            vn = -vn  # faces wound inward: point the normals out
        _NORMALS[key] = vn
    return _NORMALS[key]


def convert(item: dict, ext_of_base: np.ndarray, n_body: int, tmpl_ext: np.ndarray) -> dict:
    pack, name = item["asset"].split("/")
    d = ASSETS / pack / "x" / "clothes" / name
    mhclo = next(d.glob("*.mhclo"))
    header, refs, weights, offsets, delete = parse_mhclo(mhclo)
    # Licence: the pack's own index is the authority; refuse anything the
    # asset file itself marks otherwise.
    pack_index = json.loads(next((ASSETS / pack / "x" / "packs").glob("*.json")).read_text(encoding="utf-8"))
    meta = pack_index.get(name, {})
    licence = meta.get("license", "")
    text = mhclo.read_text(encoding="utf-8", errors="ignore")
    if licence != "CC0" or "license AGPL" in text:
        raise ValueError(f"{name}: not CC0 ({licence})")
    obj = d / header["obj_file"][0][0]
    V, VT, faces = parse_obj(obj)
    if len(V) != len(refs):
        raise ValueError(f"{name}: {len(V)} obj vertices but {len(refs)} fitting lines")
    ext = ext_of_base[refs]
    if (ext < 0).any():
        raise ValueError(f"{name}: references vertices outside the base mesh")
    scale = {}
    for ax in ("x", "y", "z"):
        if f"{ax}_scale" in header:
            a, b, dist = header[f"{ax}_scale"][0]
            dist = float(dist)
        else:  # shear_<ax> v1 v2 x1 x2: scale = (y1 - y2) / (x1 - x2)
            a, b, x1, x2 = header[f"shear_{ax}"][0]
            dist = abs(float(x1) - float(x2))
        scale[ax] = [int(ext_of_base[int(a)]), int(ext_of_base[int(b)]), dist]

    # One web vertex per distinct (vertex, uv) corner.
    key_to_new: dict[tuple[int, int], int] = {}
    orig, uvs, index = [], [], []
    for tri in faces:
        for vi, ti in tri:
            k = (vi, ti)
            if k not in key_to_new:
                key_to_new[k] = len(orig)
                orig.append(vi)
                uvs.append(VT[ti] if ti >= 0 else [0.0, 0.0])
            index.append(key_to_new[k])
    orig = np.array(orig, np.int32)
    uvs = np.array(uvs, np.float32)

    mat = parse_mhmat(d / header.get("material", [[""]])[0][0])
    tex_name, alpha, img = "", False, None
    if mat.get("diffuseTexture"):
        tex_name, alpha, img = texture(d / Path(mat["diffuseTexture"]).name, OUT / item["slug"])
    diffuse = mat.get("diffuseColor", "0.7 0.7 0.7").split()
    fallback = "#%02x%02x%02x" % tuple(int(float(c) * 255) for c in diffuse[:3])
    colour = garment_colour(img, uvs, fallback)

    # Where it sits on the body: torso, legs, or both (template, metres).
    anchor = np.einsum("nk,nkc->nc", weights, tmpl_ext[ext])
    y = anchor[:, 1]
    hide = {int(ext_of_base[v]) for v in delete if 0 <= v < len(ext_of_base) and ext_of_base[v] < n_body}
    # Skin under the cloth: body vertices with garment just out along their
    # normal. Hidden in the fitting room, so a tight size never shows skin
    # through — while necklines and cuffs (garment beside, not over, the skin)
    # stay open.
    sc = {ax: abs(tmpl_ext[a, i] - tmpl_ext[b, i]) / (dd or 1) for i, (ax, (a, b, dd)) in enumerate(sorted(scale.items()))}
    garment_pos = anchor + offsets * np.array([sc["x"], sc["y"], sc["z"]])
    body = tmpl_ext[:n_body]
    bn = body_normals(body)
    tri = np.array([[c[0] for c in t] for t in faces], np.int64)
    under = rays_hit(body - bn * 0.003, bn, garment_pos, tri, reach=0.045)
    # Keep a ring of skin at every edge of the covered area: necklines, cuffs
    # and hems stay closed even where the cloth stands off the body.
    f = ab.faces()
    for _ in range(2):
        edge = np.zeros(n_body, bool)
        open_face = ~under[f].all(axis=1)
        edge[f[open_face].reshape(-1)] = True
        under &= ~edge
    hide = sorted(hide | set(np.nonzero(under)[0].tolist()))
    covers = {
        "torso": bool(((y > 1.15) & (y < 1.35)).mean() > 0.05),
        "legs": bool((y < 0.78).mean() > 0.05),  # below the crotch
    }
    return {
        "slug": item["slug"],
        "asset": item["asset"],
        "author": meta.get("author", ""),
        "license": licence,
        "source": meta.get("source", ""),
        "count": int(len(orig)),
        "refs": b64(ext[orig].astype(np.int32).reshape(-1)),
        "weights": b64(weights[orig].astype(np.float32).reshape(-1)),
        "offsets": b64(offsets[orig].astype(np.float32).reshape(-1)),
        "orig": b64(orig),
        "uv": b64(uvs.reshape(-1)),
        "index": b64(np.array(index, np.uint32)),
        "hide": b64(np.array(hide, np.int32)),
        "hidden": len(hide),
        "scale": scale,
        "texture": tex_name,
        "alpha": bool(alpha),
        "color": colour,
        "covers": covers,
        # A whole outfit (dress, suit): worn without a companion piece.
        "full": item["subcategory"] in ("Dresses", "Suits"),
    }, colour


def place_like_glb(v_raw: np.ndarray, body_rows_raw: np.ndarray) -> np.ndarray:
    """The avatar GLB's frame: pipeline axes, grounded and centred on the body."""
    v = ab._to_pipeline_frame(v_raw)
    b = v[body_rows_raw]
    lo, hi = b.min(axis=0), b.max(axis=0)
    t = np.array([-(lo[0] + hi[0]) / 2, -lo[1], -(lo[2] + hi[2]) / 2])
    return v + t


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    std, full = models()
    ext_of_base, nbr, hw, n_body = learn_helpers(std, full)
    (OUT / "helpers.json").write_text(json.dumps({
        "body": n_body, "count": len(hw), "k": K_NEIGHBOURS, "neighbours": b64(nbr.reshape(-1)),
        "weights": b64(hw.reshape(-1)),
        "about": "MakeHuman helper vertices (tights, skirt) as affine blends of Anny body vertices",
    }))

    # Template body + helpers in the GLB frame, for coverage tests and mannequins.
    fidx = full.base_mesh_vertex_indices.numpy()
    row_of = np.full(int(fidx.max()) + 1, -1)
    row_of[fidx] = np.arange(len(fidx))
    ext_rows = np.empty(len(ext_of_base), int)
    ext_rows[ext_of_base] = row_of[np.arange(len(ext_of_base))]
    bidx = std.base_mesh_vertex_indices.numpy()
    body_rows = row_of[bidx]

    def body_ext(p):
        v = place_like_glb(rest(full, p), body_rows)
        return v[ext_rows]

    tmpl = body_ext(ab.default_params())
    for sex, gender in (("male", 0.0), ("female", 1.0)):  # Anny: 0 = male, 1 = female
        p = ab.default_params()
        p[ab.PHENOTYPES.index("gender")] = gender
        v = body_ext(p)[:n_body].astype(np.float32)
        (OUT / f"mannequin-{sex}.json").write_text(json.dumps({"count": n_body, "positions": b64(v.reshape(-1))}))

    cat = json.loads(CATALOG.read_text(encoding="utf-8"))
    for item in cat["garments"]:
        out, colour = convert(item, ext_of_base, n_body, tmpl)
        (OUT / f"{item['slug']}.json").write_text(json.dumps(out))
        item["colorHex"] = colour
        print(f"  {item['slug']:36s} {out['count']:6d} verts  {colour}  torso={out['covers']['torso']} "
              f"legs={out['covers']['legs']}  skin hidden {out['hidden']}")
    CATALOG.write_text(json.dumps(cat, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"{len(cat['garments'])} garments -> {OUT}")


if __name__ == "__main__":
    main()
