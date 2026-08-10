"""Front-camera un-mirroring.

Worth its own test because the failure is silent. A laterally inverted body is
still a perfectly plausible body — nothing downstream would flag it — and the
error only surfaces much later as measurements applied to the wrong side.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np
import pytest

from app.media.extract import extract_frames
from app.schemas import ExtractRequest, FrameSlot


class _Handler(BaseHTTPRequestHandler):
    root: Path = Path()

    def _target(self) -> Path:
        return self.root / self.path.lstrip("/").split("?")[0]

    def do_GET(self) -> None:  # noqa: N802
        target = self._target()
        if not target.exists():
            self.send_response(404)
            self.end_headers()
            return
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_PUT(self) -> None:  # noqa: N802
        target = self._target()
        target.parent.mkdir(parents=True, exist_ok=True)
        length = int(self.headers.get("Content-Length", "0"))
        target.write_bytes(self.rfile.read(length))
        self.send_response(200)
        self.send_header("ETag", '"x"')
        self.end_headers()

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture(scope="module")
def storage():
    root = Path(tempfile.mkdtemp(prefix="tailorai-mirror-"))
    _Handler.root = root
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield {"root": root, "base": f"http://127.0.0.1:{port}"}
    server.shutdown()
    shutil.rmtree(root, ignore_errors=True)


def _asymmetric_video(path: Path, frames: int = 6) -> None:
    """A clip with an unmistakable left/right asymmetry.

    A bright block sits on the LEFT half of every frame. After correct
    un-mirroring it must still be on the left; if the flip is missing (or
    applied twice) it lands on the right.
    """
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10.0, (320, 240))
    for _ in range(frames):
        frame = np.full((240, 320, 3), 40, dtype=np.uint8)
        cv2.rectangle(frame, (20, 80), (110, 160), (240, 240, 240), -1)
        writer.write(frame)
    writer.release()


def _run_extract(storage, mirrored: bool) -> np.ndarray:
    root: Path = storage["root"]
    base = storage["base"]

    tag = "m" if mirrored else "n"
    video = root / f"src_{tag}.mp4"
    _asymmetric_video(video)

    slots = [
        FrameSlot(index=i, key=f"out_{tag}/f{i}.jpg", url=f"{base}/out_{tag}/f{i}.jpg")
        for i in range(8)
    ]

    res = extract_frames(
        ExtractRequest(
            jobId=f"mirror-{tag}",
            videoUrl=f"{base}/src_{tag}.mp4",
            sampleFps=10.0,
            maxDurationS=10,
            uploadSlots=slots,
            mirrored=mirrored,
        )
    )
    assert res.frames, "no frames extracted"

    written = root / res.frames[0].key
    assert written.exists(), "frame was not written to storage"
    image = cv2.imread(str(written))
    assert image is not None
    return image


def _brighter_half(image: np.ndarray) -> str:
    mid = image.shape[1] // 2
    left = float(image[:, :mid].mean())
    right = float(image[:, mid:].mean())
    return "left" if left > right else "right"


def test_unmirrored_video_is_left_untouched(storage) -> None:
    """A back-camera clip must pass through with its geometry unchanged."""
    image = _run_extract(storage, mirrored=False)
    assert _brighter_half(image) == "left"


def test_mirrored_video_is_flipped_back(storage) -> None:
    """A front-camera clip arrives mirrored; extraction must undo it.

    The source has its bright block on the left. Marked `mirrored`, the frame
    is flipped on write — so the stored frame has it on the right, which is
    what the true (un-mirrored) scene looked like before the camera mirrored it.
    """
    image = _run_extract(storage, mirrored=True)
    assert _brighter_half(image) == "right"


def test_flip_is_the_only_difference(storage) -> None:
    """Un-mirroring must change handedness and nothing else.

    Flipping the corrected frame back should reproduce the original, so the
    correction cannot be quietly cropping, rotating or rescaling.
    """
    plain = _run_extract(storage, mirrored=False)
    flipped = _run_extract(storage, mirrored=True)

    assert plain.shape == flipped.shape

    # JPEG is lossy, so compare with tolerance rather than exact equality.
    difference = np.abs(plain.astype(np.int16) - cv2.flip(flipped, 1).astype(np.int16))
    assert float(difference.mean()) < 6.0, "flip altered more than handedness"
