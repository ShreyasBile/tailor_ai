"""Convert a body GLB to binary FBX 7.4 (plus OBJ), with no Autodesk SDK.

Writes a single mesh with smooth per-vertex normals and one skin-tone
material, in centimetres, Y-up — the conventions Maya, 3ds Max, Unity, Unreal
and Blender all import without rescaling. The file is re-parsed after writing
to check its structure.

    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\glb-to-fbx.py body.glb [out.fbx]
"""

from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

import numpy as np
import trimesh

# Fixed header/footer identifiers. FBX ties FileId, CreationTime and the footer
# together with a checksum; using the well-known fixed triple (as Blender's
# exporter does) keeps strict readers such as the Autodesk SDK happy.
_HEAD_MAGIC = b"Kaydara FBX Binary  \x00\x1a\x00"
_TIME_ID = "1970-01-01 10:00:00:000"
_FILE_ID = b"\x28\xb3\x2a\xeb\xb6\x24\xcc\xc2\xbf\xc8\xb0\x2a\xa9\x2b\xfc\xf1"
_FOOT_ID = b"\xfa\xbc\xab\x09\xd0\xc8\xd4\x66\xb1\x76\xfb\x83\x1c\xf7\x26\x7e"
_FOOT_MAGIC = b"\xf8\x5a\x8c\x6a\xde\xf5\xd9\x7e\xec\xe9\x0c\xe3\x75\x8f\x29\x0b"
VERSION = 7400
SENTINEL = b"\x00" * 13


class Node:
    def __init__(self, name: str, *props, children: list[Node] | None = None):
        self.name, self.props, self.children = name, list(props), children or []

    def add(self, name: str, *props, children=None) -> Node:
        n = Node(name, *props, children=children)
        self.children.append(n)
        return n


def _prop(p) -> bytes:
    if isinstance(p, bool):
        return b"C" + struct.pack("<?", p)
    if isinstance(p, int):
        return (b"I" + struct.pack("<i", p)) if -2**31 <= p < 2**31 else (b"L" + struct.pack("<q", p))
    if isinstance(p, float):
        return b"D" + struct.pack("<d", p)
    if isinstance(p, bytes):
        return b"R" + struct.pack("<I", len(p)) + p
    if isinstance(p, str):
        b = p.encode("utf-8")
        return b"S" + struct.pack("<I", len(b)) + b
    if isinstance(p, np.ndarray):
        if p.dtype.kind == "f":
            code, dt = b"d", "<f8"
        elif p.dtype.itemsize == 8:
            code, dt = b"l", "<i8"
        else:
            code, dt = b"i", "<i4"
        raw = np.ascontiguousarray(p, dtype=dt).tobytes()
        comp = zlib.compress(raw, 9)
        return code + struct.pack("<III", len(p), 1, len(comp)) + comp
    if isinstance(p, tuple) and p and p[0] == "L":  # explicit int64 (object ids)
        return b"L" + struct.pack("<q", p[1])
    raise TypeError(type(p))


def _write(node: Node, offset: int) -> bytes:
    props = b"".join(_prop(p) for p in node.props)
    name = node.name.encode()
    head_len = 13 + len(name)
    body = bytearray()
    pos = offset + head_len + len(props)
    for ch in node.children:
        b = _write(ch, pos)
        body += b
        pos += len(b)
    if node.children or not node.props:
        body += SENTINEL
    end = offset + head_len + len(props) + len(body)
    return (struct.pack("<III", end, len(node.props), len(props)) + bytes([len(name)]) + name
            + props + bytes(body))


def P(name: str, typ: str, label: str, flags: str, *vals) -> Node:
    return Node("P", name, typ, label, flags, *vals)


def build_fbx(vertices_cm: np.ndarray, faces: np.ndarray, normals: np.ndarray, name: str) -> bytes:
    geom_id, model_id, mat_id = ("L", 2_000_001), ("L", 2_000_002), ("L", 2_000_003)

    header = Node("FBXHeaderExtension")
    header.add("FBXHeaderVersion", 1003)
    header.add("FBXVersion", VERSION)
    header.add("EncryptionType", 0)
    ts = header.add("CreationTimeStamp")
    for k, v in (("Version", 1000), ("Year", 1970), ("Month", 1), ("Day", 1), ("Hour", 10),
                 ("Minute", 0), ("Second", 0), ("Millisecond", 0)):
        ts.add(k, v)
    header.add("Creator", "TailorAI body exporter")

    gs = Node("GlobalSettings")
    gs.add("Version", 1000)
    p70 = gs.add("Properties70")
    for nm, val in (("UpAxis", 1), ("UpAxisSign", 1), ("FrontAxis", 2), ("FrontAxisSign", 1),
                    ("CoordAxis", 0), ("CoordAxisSign", 1), ("OriginalUpAxis", 1), ("OriginalUpAxisSign", 1)):
        p70.children.append(P(nm, "int", "Integer", "", val))
    p70.children.append(P("UnitScaleFactor", "double", "Number", "", 1.0))
    p70.children.append(P("OriginalUnitScaleFactor", "double", "Number", "", 1.0))

    defs = Node("Definitions")
    defs.add("Version", 100)
    defs.add("Count", 4)
    for t, n in (("GlobalSettings", 1), ("Model", 1), ("Geometry", 1), ("Material", 1)):
        defs.add("ObjectType", t, children=[Node("Count", n)])

    # Polygon index list: last index of each polygon is stored as ~index.
    poly = faces.astype(np.int32).copy()
    poly[:, 2] = ~poly[:, 2]
    # Normals by polygon-vertex (the mapping every importer supports).
    pv_normals = normals[faces.reshape(-1)].reshape(-1)

    objects = Node("Objects")
    g = objects.add("Geometry", geom_id, f"{name}\x00\x01Geometry", "Mesh")
    g.add("Properties70")
    g.add("GeometryVersion", 124)
    g.add("Vertices", vertices_cm.reshape(-1).astype(np.float64))
    g.add("PolygonVertexIndex", poly.reshape(-1))
    ln = g.add("LayerElementNormal", 0)
    ln.add("Version", 101)
    ln.add("Name", "")
    ln.add("MappingInformationType", "ByPolygonVertex")
    ln.add("ReferenceInformationType", "Direct")
    ln.add("Normals", pv_normals.astype(np.float64))
    lm = g.add("LayerElementMaterial", 0)
    lm.add("Version", 101)
    lm.add("Name", "")
    lm.add("MappingInformationType", "AllSame")
    lm.add("ReferenceInformationType", "IndexToDirect")
    lm.add("Materials", np.zeros(1, dtype=np.int32))
    layer = g.add("Layer", 0)
    layer.add("Version", 100)
    for t in ("LayerElementNormal", "LayerElementMaterial"):
        layer.add("LayerElement", children=[Node("Type", t), Node("TypedIndex", 0)])

    m = objects.add("Model", model_id, f"{name}\x00\x01Model", "Mesh")
    m.add("Version", 232)
    mp = m.add("Properties70")
    mp.children.append(P("DefaultAttributeIndex", "int", "Integer", "", 0))
    m.add("Shading", True)
    m.add("Culling", "CullingOff")

    mat = objects.add("Material", mat_id, "Skin\x00\x01Material", "")
    mat.add("Version", 102)
    mat.add("ShadingModel", "phong")
    mat.add("MultiLayer", 0)
    matp = mat.add("Properties70")
    matp.children.append(P("DiffuseColor", "Color", "", "A", 0.85, 0.79, 0.72))
    matp.children.append(P("SpecularFactor", "Number", "", "A", 0.05))
    matp.children.append(P("Shininess", "Number", "", "A", 8.0))

    conns = Node("Connections")
    conns.add("C", "OO", model_id, ("L", 0))
    conns.add("C", "OO", geom_id, model_id)
    conns.add("C", "OO", mat_id, model_id)

    takes = Node("Takes")
    takes.add("Current", "")

    roots = [header, Node("FileId", _FILE_ID), Node("CreationTime", _TIME_ID),
             Node("Creator", "TailorAI body exporter"), gs,
             Node("Documents", children=[Node("Count", 0)]),
             Node("References"), defs, objects, conns, takes]

    out = bytearray(_HEAD_MAGIC + struct.pack("<I", VERSION))
    for r in roots:
        out += _write(r, len(out))
    out += SENTINEL
    out += _FOOT_ID + b"\x00" * 4
    pad = ((len(out) + 15) & ~15) - len(out)
    out += b"\x00" * (pad or 16)
    out += struct.pack("<I", VERSION) + b"\x00" * 120 + _FOOT_MAGIC
    return bytes(out)


# ── verification: a minimal reader ──


def _read_node(buf: bytes, pos: int):
    end, nprops, plen, nlen = struct.unpack_from("<IIIB", buf, pos)
    if end == 0:
        return None, pos + 13
    name = buf[pos + 13 : pos + 13 + nlen].decode()
    p = pos + 13 + nlen
    props = []
    for _ in range(nprops):
        t = chr(buf[p]); p += 1
        if t in "CYIFDL":
            fmt = {"C": "<?", "Y": "<h", "I": "<i", "F": "<f", "D": "<d", "L": "<q"}[t]
            props.append(struct.unpack_from(fmt, buf, p)[0]); p += struct.calcsize(fmt)
        elif t in "SR":
            n = struct.unpack_from("<I", buf, p)[0]; props.append(buf[p + 4 : p + 4 + n]); p += 4 + n
        else:
            n, enc, clen = struct.unpack_from("<III", buf, p); p += 12
            raw = buf[p : p + clen]; p += clen
            data = zlib.decompress(raw) if enc else raw
            props.append(np.frombuffer(data, {"d": "<f8", "f": "<f4", "i": "<i4", "l": "<i8", "b": "u1"}[t]))
    children = []
    while p < end:
        ch, p = _read_node(buf, p)
        if ch is None:
            break
        children.append(ch)
    assert p == end, f"{name}: end offset mismatch ({p} != {end})"
    return (name, props, children), end


def verify(data: bytes) -> dict:
    assert data[:23] == _HEAD_MAGIC and struct.unpack_from("<I", data, 23)[0] == VERSION
    pos, roots = 27, {}
    while True:
        node, pos = _read_node(data, pos)
        if node is None:
            break
        roots[node[0]] = node
    geom = next(c for c in roots["Objects"][2] if c[0] == "Geometry")
    verts = next(c for c in geom[2] if c[0] == "Vertices")[1][0]
    polys = next(c for c in geom[2] if c[0] == "PolygonVertexIndex")[1][0]
    return {"roots": list(roots), "vertices": len(verts) // 3, "triangles": int((polys < 0).sum()),
            "height_cm": float(verts.reshape(-1, 3)[:, 1].max() - verts.reshape(-1, 3)[:, 1].min())}


def main() -> None:
    src = Path(sys.argv[1])
    dst = Path(sys.argv[2]) if len(sys.argv) > 2 else src.with_suffix(".fbx")
    mesh = trimesh.load(src, file_type="glb", force="mesh")
    mesh.merge_vertices()  # weld per-face vertices so normals are smooth
    verts_cm = np.asarray(mesh.vertices, dtype=np.float64) * 100.0
    data = build_fbx(verts_cm, np.asarray(mesh.faces), np.asarray(mesh.vertex_normals), "TailorAI_Body")
    dst.write_bytes(data)
    mesh.export(dst.with_suffix(".obj"))
    info = verify(data)
    print(f"wrote {dst} ({len(data) // 1024} KB): {info['vertices']} verts, {info['triangles']} tris, "
          f"{info['height_cm']:.1f} cm tall; sections {info['roots']}")
    print(f"wrote {dst.with_suffix('.obj')}")


if __name__ == "__main__":
    main()
