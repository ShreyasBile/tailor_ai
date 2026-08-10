"""BiRefNet person matting (MIT licence).

Chosen over RMBG-2.0 (non-commercial) and SAM2 (needs prompts; we want zero
user input). Produces a soft alpha, which matters for hair and loose clothing.
"""

from __future__ import annotations

import logging
from pathlib import Path

import cv2
import numpy as np

from ..config import settings
from ..errors import gpu_oom, inference_failed
from ..runtime.vram import vram_guard

log = logging.getLogger(__name__)

_INPUT_SIZE = 1024
_IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


class BiRefNetAdapter:
    id = "birefnet-v1"

    def __init__(self) -> None:
        self._model = None
        self._device: str | None = None

    def warmup(self) -> None:
        self._ensure_loaded()

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return

        try:
            import torch  # noqa: PLC0415
            from transformers import AutoModelForImageSegmentation  # noqa: PLC0415
        except ImportError as exc:
            raise inference_failed(
                "BiRefNet needs the model extras. Install them with:\n"
                "  pip install -r requirements-models.txt transformers"
            ) from exc

        cfg = settings()
        self._device = cfg.resolved_device

        local = cfg.weights_dir / "birefnet"
        source = str(local) if local.exists() else "ZhengPeng7/BiRefNet"

        log.info("loading BiRefNet from %s onto %s", source, self._device)

        model = AutoModelForImageSegmentation.from_pretrained(source, trust_remote_code=True)
        model.eval()

        if self._device == "cuda":
            # fp16 halves resident weights, which is the difference between
            # fitting alongside the body model in 8 GB and not.
            model = model.half().to("cuda")
        else:
            model = model.to("cpu")

        self._model = model

    def segment(self, image: np.ndarray) -> np.ndarray:
        self._ensure_loaded()
        import torch  # noqa: PLC0415

        h, w = image.shape[:2]

        rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        resized = cv2.resize(rgb, (_INPUT_SIZE, _INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
        norm = (resized.astype(np.float32) / 255.0 - _IMAGENET_MEAN) / _IMAGENET_STD
        tensor = torch.from_numpy(norm).permute(2, 0, 1).unsqueeze(0)

        if self._device == "cuda":
            tensor = tensor.half().cuda()

        try:
            with vram_guard(), torch.no_grad():
                output = self._model(tensor)
                logits = output[-1] if isinstance(output, (list, tuple)) else output
                if isinstance(logits, (list, tuple)):
                    logits = logits[-1]
                alpha = torch.sigmoid(logits).float().squeeze().cpu().numpy()
        except torch.cuda.OutOfMemoryError as exc:
            torch.cuda.empty_cache()
            raise gpu_oom("BiRefNet exhausted VRAM") from exc

        alpha = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_LINEAR)
        return np.clip(alpha, 0.0, 1.0).astype(np.float32)


def weights_present() -> bool:
    return (settings().weights_dir / "birefnet").exists()


def expected_weights_path() -> Path:
    return settings().weights_dir / "birefnet"
