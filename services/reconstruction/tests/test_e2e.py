"""End-to-end pipeline test.

Drives the real FastAPI service through the full sequence the orchestrator
uses — select → segment → body → fuse → build → texture → rebuild — and
asserts a genuine, loadable, correctly-scaled GLB comes out the other end.

Storage is stood up as a real local HTTP server rather than mocked, because
presigned-URL I/O is exactly the kind of thing that passes as a mock and fails
in production. The service code path is identical to the one that talks to
MinIO or R2.
"""

from __future__ import annotations

import io
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np
import pytest
import trimesh
from fastapi.testclient import TestClient

API_KEY = "test_key"


# ─────────────────────────── local storage server ───────────────────────────


class _StorageHandler(BaseHTTPRequestHandler):
    root: Path = Path()

    def _path(self) -> Path:
        return self.root / self.path.lstrip("/").split("?")[0]

    def do_GET(self) -> None:  # noqa: N802
        target = self._path()
        if not target.exists():
            self.send_response(404)
            self.end_headers()
            return
        data = target.read_bytes()

        # Honour ranged reads — magic-byte sniffing depends on them.
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            start, _, end = rng[6:].partition("-")
            data = data[int(start) : (int(end) + 1 if end else None)]
            self.send_response(206)
        else:
            self.send_response(200)

        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self) -> None:  # noqa: N802
        target = self._path()
        target.parent.mkdir(parents=True, exist_ok=True)
        length = int(self.headers.get("Content-Length", "0"))
        target.write_bytes(self.rfile.read(length))
        self.send_response(200)
        self.send_header("ETag", f'"{abs(hash(str(target))):x}"')
        self.end_headers()

    def log_message(self, *_args) -> None:
        pass  # keep test output readable


@pytest.fixture(scope="module")
def storage():
    root = Path(tempfile.mkdtemp(prefix="tailorai-e2e-"))
    _StorageHandler.root = root

    server = ThreadingHTTPServer(("127.0.0.1", 0), _StorageHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield {"root": root, "base": f"http://127.0.0.1:{port}"}

    server.shutdown()
    shutil.rmtree(root, ignore_errors=True)


@pytest.fixture(scope="module")
def client(monkeypatch_module):
    from app.config import settings

    settings.cache_clear()
    monkeypatch_module.setenv("RECONSTRUCTION_API_KEY", API_KEY)
    monkeypatch_module.setenv("RECONSTRUCTION_ADAPTER", "mock")
    monkeypatch_module.setenv("SEGMENTATION_ADAPTER", "mock")
    monkeypatch_module.setenv("MODEL_TIER", "production")
    monkeypatch_module.setenv("RECON_DEVICE", "cpu")

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="module")
def monkeypatch_module():
    from _pytest.monkeypatch import MonkeyPatch

    mp = MonkeyPatch()
    yield mp
    mp.undo()


# ─────────────────────────── synthetic capture ───────────────────────────


def _synthetic_person(width: int, height: int, yaw_deg: float) -> np.ndarray:
    """A crude but structurally honest stand-in for a captured frame.

    A plain light background with a darker centred humanoid silhouette — which
    is what the capture guidance asks the user to produce, and enough for the
    mock adapter's silhouette-driven shape estimation to do real work.
    """
    img = np.full((height, width, 3), 205, dtype=np.uint8)
    img += np.random.default_rng(int(yaw_deg)).integers(-6, 6, img.shape, dtype=np.int16).astype(
        np.uint8
    )

    cx = width // 2
    top = int(height * 0.08)
    body_h = int(height * 0.84)

    # Narrower when seen from the side.
    side_factor = 0.55 + 0.45 * abs(np.cos(np.deg2rad(yaw_deg)))

    # Shade increases monotonically with yaw so every angle is genuinely
    # distinct. A sinusoid would not do: sin(45°) == sin(135°), leaving those
    # frames near-identical, and the pipeline's duplicate rejection would
    # (correctly) discard them. Real subjects are not symmetric front-to-back
    # or left-to-right; the fixture has to reflect that.
    shade = int(55 + (yaw_deg % 360) * (70 / 360))
    colour = (shade, shade - 5, shade - 10)

    head_r = int(body_h * 0.062)
    cv2.circle(img, (cx, top + head_r), head_r, colour, -1)

    # Face marker, front hemisphere only — breaks front/back hash symmetry.
    if abs(((yaw_deg + 180) % 360) - 180) < 80:
        cv2.circle(img, (cx, top + head_r), int(head_r * 0.45), (150, 140, 130), -1)

    shoulder_y = top + int(body_h * 0.20)
    hip_y = top + int(body_h * 0.53)
    half_shoulder = int(body_h * 0.105 * side_factor)
    half_hip = int(body_h * 0.088 * side_factor)

    cv2.fillPoly(
        img,
        [
            np.array(
                [
                    (cx - half_shoulder, shoulder_y),
                    (cx + half_shoulder, shoulder_y),
                    (cx + half_hip, hip_y),
                    (cx - half_hip, hip_y),
                ],
                dtype=np.int32,
            )
        ],
        colour,
    )

    # Neck
    cv2.rectangle(
        img,
        (cx - int(head_r * 0.4), top + head_r),
        (cx + int(head_r * 0.4), shoulder_y),
        colour,
        -1,
    )

    limb = max(2, int(body_h * 0.026 * side_factor))
    # A-pose arms
    cv2.line(img, (cx - half_shoulder, shoulder_y), (cx - int(half_shoulder * 1.9), hip_y), colour, limb)
    cv2.line(img, (cx + half_shoulder, shoulder_y), (cx + int(half_shoulder * 1.9), hip_y), colour, limb)
    # Legs
    foot_y = top + body_h
    cv2.line(img, (cx - int(half_hip * 0.5), hip_y), (cx - int(half_hip * 0.7), foot_y), colour, limb * 2)
    cv2.line(img, (cx + int(half_hip * 0.5), hip_y), (cx + int(half_hip * 0.7), foot_y), colour, limb * 2)

    return img


# ─────────────────────────── the test ───────────────────────────


@pytest.mark.parametrize("user_height_cm", [172.0])
def test_full_pipeline_produces_a_real_avatar(client, storage, user_height_cm: float) -> None:
    base = storage["base"]
    root: Path = storage["root"]
    headers = {"x-api-key": API_KEY}

    frame_count = 8
    yaws = [i * (360 / frame_count) for i in range(frame_count)]

    # Seed the "capture" into storage.
    for i, yaw in enumerate(yaws):
        img = _synthetic_person(720, 1280, yaw)
        path = root / f"frames/frame_{i:04d}.jpg"
        path.parent.mkdir(parents=True, exist_ok=True)
        ok, buf = cv2.imencode(".jpg", img)
        assert ok
        path.write_bytes(buf.tobytes())

    # ── S3 select ──
    select = client.post(
        "/media/select",
        headers=headers,
        json={
            "jobId": "e2e",
            "targetCount": frame_count,
            "frames": [
                {"index": i, "imageUrl": f"{base}/frames/frame_{i:04d}.jpg", "key": f"frames/frame_{i:04d}.jpg"}
                for i in range(frame_count)
            ],
        },
    )
    assert select.status_code == 200, select.text
    selected = [f for f in select.json()["frames"] if f["selected"]]
    assert len(selected) >= 4, "selection discarded too many usable frames"

    prepared = [
        {
            "index": f["index"],
            "imageUrl": f"{base}/{f['key']}",
            "width": 720,
            "height": 1280,
            "qualityScore": f["qualityScore"],
        }
        for f in selected
    ]

    # ── S4 segment ──
    segment = client.post(
        "/infer/segment",
        headers=headers,
        json={
            "jobId": "e2e",
            "frames": prepared,
            "outputUrls": [f"{base}/masks/mask_{f['index']:04d}.png" for f in prepared],
        },
    )
    assert segment.status_code == 200, segment.text
    assert segment.json()["personCount"] == 1

    for frame in prepared:
        frame["maskUrl"] = f"{base}/masks/mask_{frame['index']:04d}.png"

    # ── S5 body inference ──
    body = client.post(
        "/infer/body", headers=headers, json={"jobId": "e2e", "frames": prepared}
    )
    assert body.status_code == 200, body.text
    per_frame = body.json()["perFrame"]
    assert len(per_frame) == len(prepared)
    assert body.json()["bodyModel"] == "MHR"

    # ── S6/S7 fuse and resolve scale ──
    fuse = client.post(
        "/infer/fuse",
        headers=headers,
        json={
            "jobId": "e2e",
            "perFrame": per_frame,
            "userHeightCm": user_height_cm,
            "sexAtBirth": "UNSPECIFIED",
        },
    )
    assert fuse.status_code == 200, fuse.text
    fused = fuse.json()

    assert fused["scale"]["source"] == "USER_HEIGHT"
    assert fused["coverageDegrees"] > 250, "a full turn should register wide coverage"
    assert 0.0 <= fused["overallQuality"] <= 1.0
    assert len(fused["shapeConfidence"]) == len(fused["shape"])

    # ── S11 build untextured geometry ──
    build = client.post(
        "/mesh/build",
        headers=headers,
        json={
            "jobId": "e2e",
            "shape": fused["shape"],
            "metricScale": fused["scale"]["metricScale"],
            "textureUrl": None,
            "outputGlbUrl": f"{base}/out/avatar.glb",
            "outputObjUrl": f"{base}/out/avatar.obj.zip",
            "outputThumbnailUrl": f"{base}/out/thumb.png",
        },
    )
    assert build.status_code == 200, build.text
    stats = build.json()
    assert stats["vertexCount"] > 500
    assert stats["triangleCount"] > 1000

    # ── S10 texture bake from the real frames ──
    texture = client.post(
        "/infer/texture",
        headers=headers,
        json={
            "jobId": "e2e",
            "meshUrl": f"{base}/out/avatar.glb",
            "frames": prepared,
            "cameras": [f["camera"] for f in per_frame],
            "resolution": 1024,
            "outputUrl": f"{base}/out/atlas.png",
        },
    )
    assert texture.status_code == 200, texture.text
    coverage = texture.json()["coverage"]
    assert 0.0 <= coverage["inpaintedFraction"] <= 1.0

    # ── S11 rebuild with the texture applied ──
    final = client.post(
        "/mesh/build",
        headers=headers,
        json={
            "jobId": "e2e",
            "shape": fused["shape"],
            "metricScale": fused["scale"]["metricScale"],
            "textureUrl": f"{base}/out/atlas.png",
            "outputGlbUrl": f"{base}/out/avatar_textured.glb",
            "outputObjUrl": f"{base}/out/avatar_textured.obj.zip",
            "outputThumbnailUrl": f"{base}/out/thumb2.png",
        },
    )
    assert final.status_code == 200, final.text

    # ── Assert the delivered artifact is real ──
    glb_path = root / "out/avatar_textured.glb"
    assert glb_path.exists(), "no GLB was written"

    glb_bytes = glb_path.read_bytes()
    assert glb_bytes[:4] == b"glTF", "output is not a valid GLB container"
    # Budget for smooth mobile rendering (docs/05 §5).
    assert len(glb_bytes) < 5 * 1024 * 1024

    mesh = trimesh.load(io.BytesIO(glb_bytes), file_type="glb", force="mesh")
    assert isinstance(mesh, trimesh.Trimesh)

    # The whole point of the scale ladder: a stated height must survive the
    # entire pipeline and arrive intact in the delivered mesh.
    delivered_cm = (mesh.bounds[1][1] - mesh.bounds[0][1]) * 100
    assert abs(delivered_cm - user_height_cm) < 0.5, (
        f"stated {user_height_cm} cm, delivered {delivered_cm:.1f} cm"
    )

    # Supporting artifacts
    assert (root / "out/atlas.png").exists()
    assert (root / "out/thumb2.png").exists()
    assert (root / "out/avatar_textured.obj.zip").exists()

    print(
        f"\n  ✔ avatar: {stats['vertexCount']} verts, {stats['triangleCount']} tris, "
        f"{len(glb_bytes) / 1024:.0f} KB, {delivered_cm:.1f} cm, "
        f"{coverage['inpaintedFraction'] * 100:.0f}% inferred"
    )


def test_no_person_frames_are_rejected(client, storage) -> None:
    """A blank wall must fail with a specific, actionable code — never produce
    a confident reconstruction of nothing."""
    base = storage["base"]
    root: Path = storage["root"]
    headers = {"x-api-key": API_KEY}

    blank = np.full((640, 480, 3), 250, dtype=np.uint8)
    path = root / "blank/blank.jpg"
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".jpg", blank)
    assert ok
    path.write_bytes(buf.tobytes())

    res = client.post(
        "/infer/segment",
        headers=headers,
        json={
            "jobId": "blank",
            "frames": [
                {
                    "index": 0,
                    "imageUrl": f"{base}/blank/blank.jpg",
                    "width": 480,
                    "height": 640,
                    "qualityScore": 1.0,
                }
            ],
            "outputUrls": [f"{base}/blank/mask.png"],
        },
    )

    assert res.status_code == 422
    assert res.json()["code"] == "NO_PERSON_DETECTED"


def test_requests_without_the_api_key_are_refused(client) -> None:
    res = client.post("/infer/fuse", json={"jobId": "x", "perFrame": []})
    assert res.status_code == 401
