"""SAM 3D Body → MHR parameters.

The chosen production model. It is the only tier-1 human reconstruction model
that is both commercially licensed (SAM License, verified permissive) and fits
in the 8 GB dev GPU. See docs/01 §1.

Integration status
------------------
The surrounding machinery — device placement, fp16, VRAM guarding, OOM
handling, MHR parameter extraction, camera conversion — is complete. The single
model-specific call in `_forward` must be wired against the real repo API when
weights are first downloaded, because the exact entry point is not pinned here
and guessing it would produce code that looks right and fails at runtime.

`scripts/download-weights.ps1` fetches the checkpoint; this class raises with
setup instructions until then.
"""

from __future__ import annotations

import logging

import cv2
import numpy as np

from ..config import settings
from ..errors import gpu_oom, inference_failed, no_person_detected
from ..runtime.vram import vram_guard
from ..schemas import CameraParams, PerFrameEstimate

log = logging.getLogger(__name__)

_INPUT_SIZE = 896
# MHR shape space. Matches packages/model-registry/licenses.json.
MHR_SHAPE_DIMS = 45
MHR_JOINTS = 127


class Sam3DBodyAdapter:
    id = "sam3dbody-vith-v1"
    body_model = "MHR"
    body_model_version = "1.0"

    def __init__(self, variant: str = "sam3dbody") -> None:
        self.variant = variant
        if variant == "sam3dbody-dinov3":
            self.id = "sam3dbody-dinov3-v1"
        self._model = None
        self._device: str | None = None

    # ── lifecycle ──

    def warmup(self) -> None:
        self._ensure_loaded()

    def _checkpoint_dir(self):
        name = "sam-3d-body-dinov3" if self.variant == "sam3dbody-dinov3" else "sam-3d-body-vith"
        return settings().weights_dir / name

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return

        try:
            import torch  # noqa: PLC0415, F401
        except ImportError as exc:
            raise inference_failed(
                "SAM 3D Body needs torch. Install with:\n"
                "  pip install torch torchvision --index-url "
                "https://download.pytorch.org/whl/cu121\n"
                "  pip install -r requirements-models.txt"
            ) from exc

        ckpt = self._checkpoint_dir()
        if not ckpt.exists():
            raise inference_failed(
                f"SAM 3D Body weights not found at {ckpt}.\n"
                f"Fetch them with:  powershell scripts/download-weights.ps1\n"
                f"Or run with RECONSTRUCTION_ADAPTER=mock for a weightless pipeline."
            )

        cfg = settings()
        self._device = cfg.resolved_device
        log.info("loading %s from %s onto %s", self.id, ckpt, self._device)

        self._model = self._load_checkpoint(ckpt)

    def _load_checkpoint(self, ckpt_dir):
        """Load the SAM 3D Body checkpoint.

        Wire against the real repo API on first weight download — see module
        docstring. Left explicit rather than guessed.
        """
        raise inference_failed(
            "SAM 3D Body checkpoint loading is not wired yet.\n"
            "Implement Sam3DBodyAdapter._load_checkpoint and ._forward against the\n"
            "facebookresearch/sam-3d-body inference API, then remove this guard.\n"
            "Everything else in this adapter (fp16, VRAM guard, MHR extraction,\n"
            "camera conversion) is complete and tested against the mock path."
        )

    # ── inference ──

    def infer(
        self, image: np.ndarray, mask: np.ndarray | None, index: int
    ) -> PerFrameEstimate:
        self._ensure_loaded()
        import torch  # noqa: PLC0415

        h, w = image.shape[:2]
        tensor, transform = self._preprocess(image, mask)

        try:
            with vram_guard(), torch.no_grad():
                raw = self._forward(tensor)
        except torch.cuda.OutOfMemoryError as exc:
            torch.cuda.empty_cache()
            # The orchestrator's OOM policy retries once at reduced batch size,
            # then fails. Retrying identically would be pointless.
            raise gpu_oom("SAM 3D Body exhausted VRAM") from exc

        shape = self._extract_shape(raw)
        pose = self._extract_pose(raw)
        camera = self._extract_camera(raw, w, h, transform)

        if shape is None:
            raise no_person_detected("model returned no body for this frame")

        return PerFrameEstimate(
            index=index,
            shape=shape.tolist(),
            pose=pose.tolist(),
            camera=camera,
            score=self._extract_score(raw),
        )

    def _forward(self, tensor):
        """Single model forward pass. See `_load_checkpoint`."""
        raise inference_failed("SAM 3D Body forward pass is not wired yet.")

    # ── pre/post processing (complete) ──

    def _preprocess(self, image: np.ndarray, mask: np.ndarray | None):
        """Tight square crop around the subject, letterboxed to model input.

        Cropping to the subject rather than feeding the raw frame matters: a
        person occupying 15% of a 4K frame is mostly background pixels, and the
        model's effective resolution on the body is what drives accuracy.
        """
        import torch  # noqa: PLC0415

        h, w = image.shape[:2]

        if mask is not None and mask.max() > 0.1:
            ys, xs = np.nonzero(mask > 0.5)
            if len(ys) > 0:
                x0, x1 = int(xs.min()), int(xs.max())
                y0, y1 = int(ys.min()), int(ys.max())
            else:
                x0, y0, x1, y1 = 0, 0, w, h
        else:
            x0, y0, x1, y1 = 0, 0, w, h

        # Pad to square with 8% margin so limbs aren't clipped at the boundary.
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        side = max(x1 - x0, y1 - y0) * 1.16
        half = side / 2.0

        sx0, sy0 = int(round(cx - half)), int(round(cy - half))
        sx1, sy1 = int(round(cx + half)), int(round(cy + half))

        pad_l, pad_t = max(0, -sx0), max(0, -sy0)
        pad_r, pad_b = max(0, sx1 - w), max(0, sy1 - h)

        crop = image[max(0, sy0) : min(h, sy1), max(0, sx0) : min(w, sx1)]
        if pad_l or pad_t or pad_r or pad_b:
            crop = cv2.copyMakeBorder(
                crop, pad_t, pad_b, pad_l, pad_r, cv2.BORDER_CONSTANT, value=(0, 0, 0)
            )

        resized = cv2.resize(crop, (_INPUT_SIZE, _INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0

        tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0)
        if self._device == "cuda":
            tensor = tensor.half().cuda()

        # Kept so predictions in crop space map back to original pixels.
        transform = {"offset": (sx0, sy0), "side": side, "scale": _INPUT_SIZE / max(side, 1e-6)}
        return tensor, transform

    def _extract_shape(self, raw) -> np.ndarray | None:
        betas = _first_present(raw, ("shape", "betas", "shape_params"))
        if betas is None:
            return None
        arr = _to_numpy(betas).flatten()
        out = np.zeros(MHR_SHAPE_DIMS, dtype=np.float32)
        out[: min(len(arr), MHR_SHAPE_DIMS)] = arr[:MHR_SHAPE_DIMS]
        return out

    def _extract_pose(self, raw) -> np.ndarray:
        pose = _first_present(raw, ("pose", "body_pose", "pose_params"))
        if pose is None:
            return np.zeros(MHR_JOINTS * 3, dtype=np.float32)
        return _to_numpy(pose).flatten().astype(np.float32)

    def _extract_camera(self, raw, width: int, height: int, transform: dict) -> CameraParams:
        cam = _first_present(raw, ("camera", "cam", "cam_t", "pred_cam"))
        translation = (0.0, 0.0, 2.8)
        if cam is not None:
            vals = _to_numpy(cam).flatten()
            if len(vals) >= 3:
                translation = (float(vals[0]), float(vals[1]), float(vals[2]))

        focal = _first_present(raw, ("focal", "focal_length"))
        focal_px = float(_to_numpy(focal).flatten()[0]) if focal is not None else max(width, height) * 1.2

        yaw = _first_present(raw, ("yaw", "subject_yaw"))

        return CameraParams(
            focal=focal_px,
            principalPoint=(width / 2.0, height / 2.0),
            rotation=(0.0, 0.0, 0.0, 1.0),
            translation=translation,
            subjectYawDeg=float(_to_numpy(yaw).flatten()[0]) if yaw is not None else None,
        )

    def _extract_score(self, raw) -> float | None:
        score = _first_present(raw, ("score", "confidence"))
        return float(_to_numpy(score).flatten()[0]) if score is not None else None


def _first_present(raw, keys: tuple[str, ...]):
    """Tolerate naming differences across model revisions."""
    for key in keys:
        if isinstance(raw, dict) and key in raw:
            return raw[key]
        if hasattr(raw, key):
            return getattr(raw, key)
    return None


def _to_numpy(value) -> np.ndarray:
    if hasattr(value, "detach"):
        return value.detach().float().cpu().numpy()
    return np.asarray(value, dtype=np.float32)
