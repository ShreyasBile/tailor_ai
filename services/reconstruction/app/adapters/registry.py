"""Adapter construction and the runtime licence gate.

Mirrors packages/model-registry (ADR-2). The TypeScript gate blocks the build;
this one blocks the process. Both are needed: CI cannot catch a MODEL_TIER
that is set wrong at deploy time.
"""

from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

log = logging.getLogger(__name__)

# packages/model-registry/licenses.json, resolved from this file's location.
_REGISTRY_PATH = (
    Path(__file__).resolve().parents[4] / "packages" / "model-registry" / "licenses.json"
)

# Adapter name → registry model id.
ADAPTER_MODEL_IDS = {
    "mock": "mock-v1",
    "sam3dbody": "sam3dbody-vith-v1",
    "sam3dbody-dinov3": "sam3dbody-dinov3-v1",
    "birefnet": "birefnet-v1",
    "pshuman": "pshuman-v1",
    "lhm": "lhm-0.5b",
    "sifu": "sifu-v1",
}


@lru_cache(maxsize=1)
def _registry() -> dict[str, dict]:
    if not _REGISTRY_PATH.exists():
        log.warning("licence registry not found at %s", _REGISTRY_PATH)
        return {}
    data = json.loads(_REGISTRY_PATH.read_text(encoding="utf-8"))
    return {m["id"]: m for m in data.get("models", []) if "id" in m}


def assert_loadable(adapter_name: str, model_tier: str) -> None:
    """Refuse to load a model not cleared for the configured tier.

    Raises rather than warning. A warning in a log nobody reads is exactly how
    non-commercial weights reach production.
    """
    model_id = ADAPTER_MODEL_IDS.get(adapter_name, adapter_name)
    entry = _registry().get(model_id)

    if entry is None:
        raise RuntimeError(
            f'Model "{model_id}" is not declared in packages/model-registry/licenses.json. '
            f"Every loadable model needs an entry with a reviewed licence."
        )

    if model_tier == "production" and not entry.get("commercial_ok", False):
        raise RuntimeError(
            f'Refusing to load "{model_id}" ({entry.get("name")}).\n'
            f'Licence: {entry.get("license")} — not cleared for commercial use.\n'
            f'{entry.get("commercialNote", "")}\n\n'
            f"MODEL_TIER=production forbids this model. Set MODEL_TIER=research "
            f"for local experiments only — never point that build at real users."
        )


def build_body_adapter(name: str, model_tier: str):
    assert_loadable(name, model_tier)

    if name == "mock":
        from .mock import MockBodyAdapter

        return MockBodyAdapter()

    if name in ("sam3dbody", "sam3dbody-dinov3"):
        from .sam3dbody import Sam3DBodyAdapter

        return Sam3DBodyAdapter(variant=name)

    raise RuntimeError(
        f'Unknown body adapter "{name}". Available: mock, sam3dbody, sam3dbody-dinov3.'
    )


def build_segmentation_adapter(name: str, model_tier: str):
    assert_loadable(name, model_tier)

    if name == "mock":
        from .mock import MockSegmentationAdapter

        return MockSegmentationAdapter()

    if name == "birefnet":
        from .birefnet import BiRefNetAdapter

        return BiRefNetAdapter()

    raise RuntimeError(f'Unknown segmentation adapter "{name}". Available: mock, birefnet.')
