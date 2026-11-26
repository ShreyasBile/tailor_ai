"""On-device AI try-on worker: FASHN VTON v1.5 on this PC's GPU.

FASHN VTON v1.5 (fashn-ai, Apache-2.0 code and weights) puts a garment photo
onto a person photo with no masks, in ~8 GB of VRAM. The reconstruction
service sends it TailorAI's *sized draft* as the person, so the result keeps
the fit (tight, cropped, roomy) our engine measured.

Kept in its own process and venv (CUDA PyTorch) so the main service keeps its
CPU-only stack. Set up with scripts/setup-tryon-ai.ps1; the launcher starts it
when it's installed.

    .data/vendor/venv-ai/Scripts/python.exe -m uvicorn app:app --port 8002
"""

from __future__ import annotations

import base64
import io
import logging
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[2]
WEIGHTS = Path(os.getenv("FASHN_WEIGHTS_DIR", ROOT / ".data" / "vendor" / "fashn-weights"))
MODEL = "fashn-vton-1.5"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("tryon-ai")
app = FastAPI(title="TailorAI on-device try-on")

_pipe = None
_error: str | None = None
_lock = threading.Lock()


def _load() -> None:
    global _pipe, _error
    try:
        import torch

        if not torch.cuda.is_available():
            raise RuntimeError("no CUDA GPU visible to PyTorch")
        try:  # let onnxruntime (pose detector) use PyTorch's CUDA/cuDNN DLLs
            import onnxruntime as ort

            if hasattr(ort, "preload_dlls"):
                ort.preload_dlls()
        except Exception:  # noqa: BLE001
            pass
        from fashn_vton import TryOnPipeline

        t = time.time()
        _pipe = TryOnPipeline(weights_dir=str(WEIGHTS))
        log.info("FASHN VTON ready on %s in %.0f s", torch.cuda.get_device_name(0), time.time() - t)
    except Exception as exc:  # noqa: BLE001
        _error = f"{type(exc).__name__}: {exc}"
        log.exception("couldn't load the try-on model")


@app.on_event("startup")
def _startup() -> None:
    threading.Thread(target=_load, daemon=True).start()


@app.get("/health")
def health() -> dict:
    gpu = None
    try:
        import torch

        gpu = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:  # noqa: BLE001
        pass
    return {"ready": _pipe is not None, "error": _error, "gpu": gpu, "model": MODEL}


class TryOn(BaseModel):
    person: str  # base64 image
    garment: str  # base64 image
    category: str = Field(default="tops", pattern="^(tops|bottoms|one-pieces)$")
    garmentPhotoType: str = Field(default="flat-lay", pattern="^(flat-lay|model)$")
    timesteps: int = Field(default=30, ge=10, le=50)
    seed: int = 42


def _img(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


@app.post("/tryon")
def tryon(req: TryOn) -> dict:
    if _pipe is None:
        raise HTTPException(503, detail={"code": "LOADING", "message": _error or "The try-on model is still loading."})
    started = time.time()
    with _lock:  # one at a time: 8 GB of VRAM holds one generation
        try:
            out = _pipe(
                person_image=_img(req.person),
                garment_image=_img(req.garment),
                category=req.category,
                garment_photo_type=req.garmentPhotoType,
                num_timesteps=req.timesteps,
                seed=req.seed,
            )
        except Exception as exc:  # noqa: BLE001
            log.exception("try-on failed")
            raise HTTPException(500, detail={"code": "TRYON_FAILED", "message": str(exc)[:300]}) from exc
        finally:
            try:
                import torch

                torch.cuda.empty_cache()
            except Exception:  # noqa: BLE001
                pass
    buf = io.BytesIO()
    out.images[0].save(buf, format="PNG")
    log.info("try-on %s in %.1f s", req.category, time.time() - started)
    return {"imageBase64": base64.b64encode(buf.getvalue()).decode(), "model": MODEL,
            "elapsedMs": int((time.time() - started) * 1000)}
