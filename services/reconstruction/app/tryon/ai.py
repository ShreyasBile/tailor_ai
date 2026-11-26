"""AI photo engines for the fitting room.

Our renderer (render.py) knows exactly how a size sits on this body — tight,
cropped, roomy — but draws it with 2-D warps. An image model draws beautiful
cloth but, left alone, makes every size look like a perfect fit. So the AI
engines are given *our draft* as the layout to follow, plus the numbers:

* **Gemini** (cloud, needs GEMINI_API_KEY): the original photo, our sized
  draft and the product photo, with a prompt that spells out the fit in
  centimetres ("11 cm too small at the chest, rides up 10 cm") and forbids
  flattering it.
* **Local** (FASHN VTON v1.5, Apache-2.0, on this PC's GPU via the
  `services/tryon-ai` worker): the product photo put onto our sized draft.

Both results are cached on disk, so a demo can be prepared in advance and
survives restarts.
"""

from __future__ import annotations

import base64
import hashlib
import io
import logging
import os
from pathlib import Path

import cv2
import httpx
import numpy as np

from .fit import FitGeometry

log = logging.getLogger(__name__)

LOCAL_URL = os.getenv("TRYON_AI_URL", "http://127.0.0.1:8002").rstrip("/")
CACHE_DIR = Path(os.getenv("TRYON_CACHE_DIR", Path(__file__).resolve().parents[4] / ".data" / "tryon-cache"))


# ── availability ──


def gemini_enabled() -> bool:
    from ..llm import gemini

    return gemini.enabled()


def local_enabled() -> bool:
    try:
        r = httpx.get(f"{LOCAL_URL}/health", timeout=1.5)
        return r.status_code == 200 and bool(r.json().get("ready"))
    except Exception:  # noqa: BLE001
        return False


def engines() -> dict:
    return {"gemini": gemini_enabled(), "local": local_enabled()}


# ── disk cache ──


def cache_get(key: str) -> bytes | None:
    f = CACHE_DIR / f"{hashlib.sha1(key.encode()).hexdigest()}.jpg"
    return f.read_bytes() if f.exists() else None


def cache_put(key: str, data: bytes) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        (CACHE_DIR / f"{hashlib.sha1(key.encode()).hexdigest()}.jpg").write_bytes(data)
    except OSError as exc:
        log.warning("try-on cache write failed: %s", exc)


# ── the fit, in words ──


def describe_fit(g: FitGeometry, size: str) -> str:
    """What the picture must show, from the fit engine's numbers. No flattery."""
    parts: list[str] = []
    chest = next((z for z in g.zones if z.name in ("chest", "waist")), None)
    if g.tightness > 0.75:
        parts.append(f"Size {size} is far too small for this person"
                     + (f" ({chest.text} at the {chest.name})" if chest else "") + ".")
        parts.append("The fabric is stretched tight and clings to the body, with strain lines pulling from the "
                     "armpits across the chest and stomach.")
    elif g.tightness > 0.3:
        parts.append(f"Size {size} is snug on this person" + (f" ({chest.text} at the {chest.name})" if chest else "")
                     + ": close to the body with slight pulling across the chest.")
    elif g.looseness > 0.75:
        parts.append(f"Size {size} is far too big for this person"
                     + (f" ({chest.text} at the {chest.name})" if chest else "") + ".")
        parts.append("The fabric hangs wide and baggy away from the body with soft vertical folds; the shoulder "
                     "seams drop past the shoulders.")
    elif g.looseness > 0.3:
        parts.append(f"Size {size} is relaxed on this person: a little roomy with gentle folds.")
    else:
        parts.append(f"Size {size} fits this person well: natural drape, neither tight nor baggy.")
    if g.length_cm < -3:
        parts.append(f"It is about {abs(g.length_cm):.0f} cm too short: the hem rides up above the trouser "
                     "waistband, showing a strip of the stomach.")
    elif g.length_cm > 3:
        parts.append(f"It is about {g.length_cm:.0f} cm longer than ideal: the hem falls well below the waistband.")
    if g.sleeve_len_cm < -2:
        parts.append("The sleeves sit higher on the arm and grip it.")
    elif g.sleeve_len_cm > 2:
        parts.append("The sleeves are wider and longer than ideal.")
    return " ".join(parts)


# ── Gemini ──

_PROMPT = (
    "You are the photo engine of a virtual fitting room. "
    "Image 1 is a real photo of a shopper. Image 2 is our fit engine's draft of {what} on them in size {size}: "
    "its outline, length and tightness are measured, but it looks digitally drawn. {product}"
    "Create ONE photorealistic photo of the SAME person as image 1 — identical face, hair, glasses, skin tone, "
    "body shape and proportions, pose, hands, trousers, shoes, background, lighting and framing — wearing {what}. "
    "The garment's fit must match image 2 and this description exactly: {fit} "
    "Do not make the garment fit better or look more flattering than described; the shopper needs to see the "
    "real fit of this size. Do not change the person's body. No text, labels or watermarks."
)


def _jpeg(img: np.ndarray, long_side: int = 1024, q: int = 90) -> bytes:
    h, w = img.shape[:2]
    s = min(1.0, long_side / max(h, w))
    if s < 1:
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def gemini_photo(original: np.ndarray, draft: np.ndarray, product: bytes | None, what: str, size: str,
                 fit: str, own: bool) -> tuple[bytes, str]:
    from google.genai import types

    from ..llm import gemini

    product_line = ("Image 3 is the garment's product photo: match its exact colour, fabric, collar, buttons, "
                    "pockets and print. " if product else
                    "The garment is the top the shopper already wears in image 1: keep its exact colours, "
                    "stripes, badges and logos. " if own else "")
    prompt = _PROMPT.format(what=what, size=size, product=product_line, fit=fit)
    contents = [
        prompt,
        types.Part.from_bytes(data=_jpeg(original), mime_type="image/jpeg"),
        types.Part.from_bytes(data=_jpeg(draft), mime_type="image/jpeg"),
    ]
    if product:
        mime = "image/png" if product[:4] == b"\x89PNG" else "image/jpeg"
        contents.append(types.Part.from_bytes(data=product, mime_type=mime))
    h, w = draft.shape[:2]
    aspect = "3:4" if h >= w else "4:3"
    data, _mime, model = gemini._generate_image(  # noqa: SLF001 — same retry/fallback as photo try-on
        gemini._client(),  # noqa: SLF001
        [gemini.TRYON_IMAGE_MODEL, gemini.TRYON_IMAGE_MODEL, gemini.TRYON_FALLBACK_MODEL],
        contents, aspect, thinking=gemini.TRYON_THINKING,
    )
    return _to_jpeg(data), model


# ── local (FASHN VTON on this PC's GPU) ──


def local_photo(draft: np.ndarray, garment: np.ndarray, category: str, flat_lay: bool) -> tuple[bytes, str]:
    body = {
        "person": base64.b64encode(_jpeg(draft, 1024)).decode(),
        "garment": base64.b64encode(_jpeg(garment, 1024)).decode(),
        "category": {"bottoms": "bottoms", "dresses": "one-pieces"}.get(category, "tops"),
        "garmentPhotoType": "flat-lay" if flat_lay else "model",
    }
    r = httpx.post(f"{LOCAL_URL}/tryon", json=body, timeout=240)
    if r.status_code != 200:
        raise RuntimeError(f"local try-on engine: {r.status_code} {r.text[:200]}")
    d = r.json()
    return _to_jpeg(base64.b64decode(d["imageBase64"])), d.get("model", "fashn-vton-1.5")


def _to_jpeg(data: bytes) -> bytes:
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        from PIL import Image

        img = cv2.cvtColor(np.array(Image.open(io.BytesIO(data)).convert("RGB")), cv2.COLOR_RGB2BGR)
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
