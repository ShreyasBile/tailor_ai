"""VRAM guarding.

The dev GPU has 8 GB. Without a guard, a batch that overshoots takes the whole
process down with a CUDA OOM, which converts a recoverable job failure into a
service outage. This returns a clean 503 instead, which the orchestrator's OOM
policy retries once at reduced batch size.
"""

from __future__ import annotations

import contextlib
import logging
from collections.abc import Iterator

from ..config import settings

log = logging.getLogger(__name__)


def gpu_info() -> dict[str, object]:
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        return {"available": False, "name": None, "totalMb": None, "freeMb": None}

    if not torch.cuda.is_available():
        return {"available": False, "name": None, "totalMb": None, "freeMb": None}

    free_bytes, total_bytes = torch.cuda.mem_get_info()
    return {
        "available": True,
        "name": torch.cuda.get_device_name(0),
        "totalMb": int(total_bytes / 1024 / 1024),
        "freeMb": int(free_bytes / 1024 / 1024),
    }


def free_vram_mb() -> int | None:
    info = gpu_info()
    return info["freeMb"] if info["available"] else None  # type: ignore[return-value]


@contextlib.contextmanager
def vram_guard(required_mb: int = 1024) -> Iterator[None]:
    """Refuse to start work that clearly will not fit, and clean up after.

    Checking before allocating turns "the process died" into "try again in a
    moment", which is a materially different user experience.
    """
    try:
        import torch  # noqa: PLC0415
    except ImportError:
        yield
        return

    if not torch.cuda.is_available():
        yield
        return

    cfg = settings()
    free = free_vram_mb()

    if free is not None and free < required_mb:
        torch.cuda.empty_cache()
        free = free_vram_mb()
        if free is not None and free < required_mb:
            from ..errors import gpu_oom

            raise gpu_oom(f"only {free} MB VRAM free, need ~{required_mb} MB")

    allocated_before = torch.cuda.memory_allocated() / 1024 / 1024
    if allocated_before > cfg.max_vram_mb:
        torch.cuda.empty_cache()

    try:
        yield
    finally:
        # Release cached blocks between stages so the segmentation and body
        # models can coexist in 8 GB.
        torch.cuda.empty_cache()
