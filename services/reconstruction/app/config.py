"""Service configuration, validated at import time."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# services/reconstruction/app/config.py -> <repo>/.data
_DATA_ROOT = Path(__file__).resolve().parents[3] / ".data"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    host: str = "0.0.0.0"
    port: int = 8000
    log_level: str = "info"

    api_key: str = "dev_internal_key"

    # cuda | cpu | auto
    device: str = "auto"
    # Hard ceiling. The dev GPU has 8 GB; leaving ~1 GB headroom avoids the
    # allocator thrashing right before it OOMs.
    max_vram_mb: int = 7168
    batch_size: int = 2

    # mock | sam3dbody | remote
    body_adapter: str = "mock"
    # mock | birefnet
    segmentation_adapter: str = "mock"

    # production refuses to load models marked commercial_ok:false (ADR-2)
    model_tier: str = "production"

    weights_dir: Path = _DATA_ROOT / "weights"
    texture_resolution: int = 2048
    target_frame_count: int = 16

    @property
    def resolved_device(self) -> str:
        """The device actually in use — never merely the one requested.

        `RECON_DEVICE=cuda` with no torch installed must not report "cuda":
        health output that overstates capability is how a CPU-bound box gets
        scheduled GPU work.
        """
        try:
            import torch  # noqa: PLC0415
        except ImportError:
            return "cpu"

        if not torch.cuda.is_available():
            return "cpu"

        return "cpu" if self.device == "cpu" else "cuda"


@lru_cache(maxsize=1)
def settings() -> Settings:
    import os

    return Settings(
        host=os.getenv("RECON_HOST", "0.0.0.0"),
        port=int(os.getenv("RECON_PORT", "8000")),
        log_level=os.getenv("LOG_LEVEL", "info"),
        api_key=os.getenv("RECONSTRUCTION_API_KEY", "dev_internal_key"),
        device=os.getenv("RECON_DEVICE", "auto"),
        max_vram_mb=int(os.getenv("RECON_MAX_VRAM_MB", "7168")),
        batch_size=int(os.getenv("RECON_BATCH_SIZE", "2")),
        body_adapter=os.getenv("RECONSTRUCTION_ADAPTER", "mock"),
        segmentation_adapter=os.getenv("SEGMENTATION_ADAPTER", "mock"),
        model_tier=os.getenv("MODEL_TIER", "production"),
        weights_dir=Path(os.getenv("WEIGHTS_DIR", str(_DATA_ROOT / "weights"))),
        texture_resolution=int(os.getenv("TEXTURE_RESOLUTION", "2048")),
        target_frame_count=int(os.getenv("TARGET_FRAME_COUNT", "16")),
    )
