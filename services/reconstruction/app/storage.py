"""Presigned-URL I/O.

The service holds no storage credentials. Every read and write goes through a
URL the orchestrator signed, which is what lets this process run on rented
hardware we do not fully trust with the bucket.
"""

from __future__ import annotations

import io
import logging

import cv2
import httpx
import numpy as np
from PIL import Image

from .errors import storage_error

log = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(120.0, connect=15.0)


def fetch_bytes(url: str) -> bytes:
    try:
        with httpx.Client(timeout=_TIMEOUT, follow_redirects=True) as client:
            res = client.get(url)
            res.raise_for_status()
            return res.content
    except httpx.HTTPError as exc:
        raise storage_error(f"fetch failed: {exc}") from exc


def put_bytes(url: str, data: bytes, content_type: str) -> None:
    try:
        with httpx.Client(timeout=_TIMEOUT) as client:
            res = client.put(url, content=data, headers={"content-type": content_type})
            res.raise_for_status()
    except httpx.HTTPError as exc:
        raise storage_error(f"upload failed: {exc}") from exc


def fetch_image(url: str) -> np.ndarray:
    """Fetch and decode to BGR uint8 (OpenCV convention)."""
    raw = fetch_bytes(url)
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        # HEIC and some phone formats aren't in OpenCV's decoder set.
        try:
            pil = Image.open(io.BytesIO(raw)).convert("RGB")
            img = cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception as exc:  # noqa: BLE001
            raise storage_error(f"could not decode image: {exc}") from exc
    return img


def fetch_image_rgba(url: str) -> np.ndarray:
    """Fetch a mask/texture preserving alpha."""
    raw = fetch_bytes(url)
    buf = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise storage_error("could not decode image")
    return img


def put_image(url: str, image: np.ndarray, fmt: str = ".png") -> int:
    ok, buf = cv2.imencode(fmt, image)
    if not ok:
        raise storage_error(f"could not encode {fmt}")
    data = buf.tobytes()
    content_type = "image/png" if fmt == ".png" else "image/jpeg"
    put_bytes(url, data, content_type)
    return len(data)


