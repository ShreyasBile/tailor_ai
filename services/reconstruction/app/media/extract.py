"""Video decode and uniform frame sampling (S2).

Uses OpenCV's bundled ffmpeg rather than a system binary, so the service has no
external media dependency to install or version-match.
"""

from __future__ import annotations

import logging
import tempfile
import time
from pathlib import Path

import cv2

from ..errors import corrupt_media
from ..schemas import ExtractedFrame, ExtractRequest, ExtractResponse
from ..storage import fetch_bytes, put_image

log = logging.getLogger(__name__)


def extract_frames(req: ExtractRequest) -> ExtractResponse:
    started = time.perf_counter()

    raw = fetch_bytes(req.videoUrl)
    if len(raw) == 0:
        raise corrupt_media("empty video")

    # OpenCV needs a real file path for video; write to a temp file rather than
    # holding a 60 MB decode buffer in memory alongside model weights.
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        tmp.write(raw)
        tmp_path = Path(tmp.name)

    try:
        cap = cv2.VideoCapture(str(tmp_path))
        if not cap.isOpened():
            raise corrupt_media("could not open video stream")

        source_fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
        total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        duration_s = total_frames / source_fps if source_fps > 0 else 0.0

        if duration_s > req.maxDurationS:
            log.warning(
                "video longer than limit, truncating",
                extra={"duration_s": duration_s, "limit": req.maxDurationS},
            )
            duration_s = float(req.maxDurationS)
            total_frames = int(duration_s * source_fps)

        # Uniform temporal sampling. A 25 s clip at 4 fps gives ~100 candidates,
        # which S3 then narrows to the best 16 by quality *and* yaw coverage.
        stride = max(1, int(round(source_fps / max(req.sampleFps, 0.1))))
        capacity = len(req.uploadSlots)

        frames: list[ExtractedFrame] = []
        frame_no = 0
        out_index = 0

        while out_index < capacity:
            ok, frame = cap.read()
            if not ok:
                break

            if frame_no % stride == 0:
                slot = req.uploadSlots[out_index]

                # Undo front-camera mirroring before the frame is ever stored.
                # A mirrored body reconstructs laterally inverted — left-side
                # measurements applied to the right — and the result looks
                # entirely plausible, so no later stage would catch it.
                if req.mirrored:
                    frame = cv2.flip(frame, 1)

                height, width = frame.shape[:2]
                put_image(slot.url, frame, ".jpg")
                frames.append(
                    ExtractedFrame(
                        index=slot.index,
                        key=slot.key,
                        width=width,
                        height=height,
                        timestampMs=int((frame_no / source_fps) * 1000),
                    )
                )
                out_index += 1

            frame_no += 1
            if total_frames and frame_no >= total_frames:
                break

        cap.release()

        if not frames:
            raise corrupt_media("no decodable frames")

        log.info(
            "extracted %d frames (source %.1f fps, stride %d)", len(frames), source_fps, stride
        )

        return ExtractResponse(
            frames=frames,
            durationMs=int(duration_s * 1000),
            fps=source_fps,
            elapsedMs=int((time.perf_counter() - started) * 1000),
        )
    finally:
        tmp_path.unlink(missing_ok=True)
