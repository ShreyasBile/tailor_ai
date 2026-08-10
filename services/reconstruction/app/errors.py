"""Error taxonomy, mirrored from packages/contracts/src/errors.ts.

The orchestrator maps these codes straight through to the user-facing message,
so a code emitted here becomes "It was too dark, try near a window" on a phone.
Keep the two lists in sync when adding a code.
"""

from __future__ import annotations

from fastapi import HTTPException


class ReconError(HTTPException):
    """Carries a taxonomy code the orchestrator can branch on."""

    def __init__(self, code: str, status: int = 500, detail: str | None = None) -> None:
        super().__init__(status_code=status, detail={"code": code, "detail": detail or code})
        self.code = code


# Input problems — the user can fix these
def no_person_detected(detail: str | None = None) -> ReconError:
    return ReconError("NO_PERSON_DETECTED", 422, detail)


def multiple_people(count: int) -> ReconError:
    return ReconError("MULTIPLE_PEOPLE", 422, f"{count} people detected")


def input_too_dark(detail: str | None = None) -> ReconError:
    return ReconError("INPUT_TOO_DARK", 422, detail)


def input_too_blurry(detail: str | None = None) -> ReconError:
    return ReconError("INPUT_TOO_BLURRY", 422, detail)


def insufficient_frames(detail: str | None = None) -> ReconError:
    return ReconError("INSUFFICIENT_FRAMES", 422, detail)


def insufficient_coverage(degrees: float) -> ReconError:
    return ReconError("INSUFFICIENT_COVERAGE", 422, f"only {degrees:.0f}° of yaw observed")


def corrupt_media(detail: str | None = None) -> ReconError:
    return ReconError("CORRUPT_MEDIA", 422, detail)


# System problems
def gpu_oom(detail: str | None = None) -> ReconError:
    return ReconError("GPU_OOM", 503, detail)


def inference_failed(detail: str | None = None) -> ReconError:
    return ReconError("INFERENCE_FAILED", 500, detail)


def texture_bake_failed(detail: str | None = None) -> ReconError:
    return ReconError("TEXTURE_BAKE_FAILED", 500, detail)


def mesh_invalid(detail: str | None = None) -> ReconError:
    return ReconError("MESH_INVALID", 500, detail)


def scale_unresolved(detail: str | None = None) -> ReconError:
    return ReconError("SCALE_UNRESOLVED", 422, detail)


def storage_error(detail: str | None = None) -> ReconError:
    return ReconError("STORAGE_ERROR", 503, detail)
