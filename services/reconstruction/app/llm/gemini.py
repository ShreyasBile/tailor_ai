"""Gemini features — optional, off unless GEMINI_API_KEY is set.

1. Fit explanations: rewrites the rules engine's explanation in friendlier,
   tailor-like language. Only numbers leave the service (size labels,
   centimetres, verdicts, cut and stretch) — never photos or identity.
2. Photo clothing check (GEMINI_PHOTO_CHECK=true): flags loose clothing, hair
   over the neck or arms against the body — the things that inflate girths
   and that the pixel-level quality gate can't see. Off by default: body
   photos are biometric data, and sending them to a third party must be in
   the consent the user gave (docs/06 §6).

Every call has a short timeout and returns None on any failure, so the caller
keeps its rules-based result. A Gemini outage can never fail a scan or a
size recommendation.
"""

from __future__ import annotations

import io
import json
import logging
import os
from functools import lru_cache

import numpy as np

log = logging.getLogger(__name__)

TEXT_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
# Flash-Lite answers the four-photo check in ~4 s; 3.8 Flash took ~40 s for
# the same verdicts.
VISION_MODEL = os.getenv("GEMINI_VISION_MODEL", "gemini-3.5-flash-lite")
# The API refuses deadlines under 10 s (400 INVALID_ARGUMENT).
TIMEOUT_MS = max(10_000, int(os.getenv("GEMINI_TIMEOUT_MS", "12000")))
# Four photos on the vision model take ~15–30 s; the scan around it takes
# over a minute, so this costs little.
PHOTO_TIMEOUT_MS = max(10_000, int(os.getenv("GEMINI_PHOTO_TIMEOUT_MS", "45000")))


def enabled() -> bool:
    return bool(os.getenv("GEMINI_API_KEY", "").strip())


def photo_check_enabled() -> bool:
    return enabled() and os.getenv("GEMINI_PHOTO_CHECK", "false").lower() in ("1", "true", "yes")


@lru_cache(maxsize=1)
def _client():
    from google import genai  # noqa: PLC0415
    from google.genai import types  # noqa: PLC0415

    return genai.Client(
        api_key=os.environ["GEMINI_API_KEY"].strip(),
        http_options=types.HttpOptions(timeout=TIMEOUT_MS),
    )


# ── 1. fit explanations ──

_EXPLAIN_SYSTEM = (
    "You are a friendly, precise tailor explaining a clothing size recommendation. "
    "Use ONLY the facts in the JSON you are given — never invent measurements, sizes, brands or fabrics. "
    "Write 2–4 short sentences of plain English, no markdown, no lists, no emojis. "
    "Lead with the recommended size and why. Mention the tightest or loosest area if it matters, "
    "in centimetres as given. If betweenSizes is true, say which way to go for a closer or looser fit. "
    "Talk to the shopper as 'you'. Never quote the JSON field names. outsideSizeRangeCm is how far "
    "the shopper's measurement falls outside this size's range: positive = the garment is that much "
    "too small (or too short for sleeve/inseam), negative = that much too big (or too long), 0 = "
    "inside the range. Say it naturally, e.g. 'about 6 cm bigger than you at the chest'. "
    "If smallerSizesTooTight is not empty, say briefly why the next size down won't work. "
    "If noSizeFits is true, say plainly that even this largest size will be too small. "
    "Don't mention differences under 1 cm."
)


def _explain_facts(result: dict, garment: dict, preference: str) -> dict:
    """The only data sent for an explanation: numbers and labels."""
    return {
        "recommendedSize": result.get("recommendedSize"),
        "alternativeSize": result.get("alternativeSize"),
        "betweenSizes": result.get("betweenSizes"),
        "fitScore": result.get("fitScore"),
        "fitLabel": result.get("fitLabel"),
        "garment": {
            "category": garment.get("category"),
            "cut": garment.get("fitIntent"),
            "stretch": garment.get("stretch"),
        },
        "shopperPreference": preference,
        "noSizeFits": result.get("noSizeFits", False),
        "smallerSizesTooTight": result.get("smallerSizesTooTight", []),
        "dimensions": [
            {
                "area": d.get("label"),
                "yourMeasurementCm": d.get("body"),
                "sizeRangeCm": d.get("range"),
                "verdict": d.get("verdict"),
                "outsideSizeRangeCm": d.get("outsideCm", 0),
            }
            for d in result.get("dimensions", [])
        ],
    }


def explain_fit(result: dict, garment: dict, preference: str, client=None) -> str | None:
    """A friendlier explanation, or None to keep the rules engine's."""
    if client is None and not enabled():
        return None
    try:
        from google.genai import types  # noqa: PLC0415

        c = client or _client()
        resp = c.models.generate_content(
            model=TEXT_MODEL,
            contents=json.dumps(_explain_facts(result, garment, preference)),
            config=types.GenerateContentConfig(
                system_instruction=_EXPLAIN_SYSTEM,
                temperature=0.3,
                max_output_tokens=400,
            ),
        )
        text = " ".join((resp.text or "").split())
    except Exception as exc:  # noqa: BLE001 — never fail a recommendation over prose
        log.warning("gemini explain failed: %s", exc)
        return None
    # Must name the size it is explaining, and stay short; else keep the rules text.
    size = str(result.get("recommendedSize", ""))
    if not text or size not in text or len(text) > 700:
        log.info("gemini explanation rejected (size missing or too long)")
        return None
    return text


# ── 2. photo clothing check ──

_PHOTO_SYSTEM = (
    "You check photos taken for a body-measurement scan. For each photo, judge only what is visible. "
    "loose_clothing: clothing hangs away from the body (baggy tops, wide trousers, jackets, skirts) "
    "so the body outline is hidden. hair_over_neck: hair covers the neck or shoulders. "
    "arms_against_body: in a front or back photo, an arm touches or overlaps the torso; in a side "
    "photo (left/right) the arm always overlaps the torso, so answer false. "
    "Be conservative: only flag clear cases."
)

_PHOTO_SCHEMA = {
    "type": "object",
    "properties": {
        "views": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "view": {"type": "string", "enum": ["front", "back", "left", "right"]},
                    "loose_clothing": {"type": "boolean"},
                    "hair_over_neck": {"type": "boolean"},
                    "arms_against_body": {"type": "boolean"},
                },
                "required": ["view", "loose_clothing", "hair_over_neck", "arms_against_body"],
            },
        }
    },
    "required": ["views"],
}

_PHOTO_MESSAGES = {
    "loose_clothing": ("LOOSE_CLOTHING", "Your clothes look loose here — loose clothing makes us measure you larger. "
                                         "Wear fitted clothes for the most accurate sizes."),
    "hair_over_neck": ("HAIR_OVER_NECK", "Hair covers your neck or shoulders here — tie it up for a better neck and "
                                         "shoulder measurement."),
    "arms_against_body": ("ARMS_TOUCHING", "Your arm touches your body here — hold your arms slightly away so we can "
                                           "see your chest and waist outline."),
}


# ── 3. images: product photos and photo try-on ──

# Product photos: fast, single-image text-to-image. Try-on combines two
# reference images (person + garment), which the main model is built for.
PRODUCT_IMAGE_MODEL = os.getenv("GEMINI_PRODUCT_IMAGE_MODEL", "gemini-3.1-flash-lite-image")
TRYON_IMAGE_MODEL = os.getenv("GEMINI_TRYON_IMAGE_MODEL", "gemini-nano-banana-2.1")
# A real photo can take a minute. generate_content honours this deadline; the
# Interactions API cut every image call off at ~13 s (504 DEADLINE_EXCEEDED).
IMAGE_TIMEOUT_MS = int(float(os.getenv("GEMINI_IMAGE_TIMEOUT_S", "120")) * 1000)


def _generate_image(client, model: str, contents: list, aspect: str) -> tuple[bytes, str]:
    """One image from generate_content; one retry on a transient server error."""
    from google.genai import types  # noqa: PLC0415

    config = types.GenerateContentConfig(
        response_modalities=["IMAGE"],
        image_config=types.ImageConfig(aspect_ratio=aspect, image_size="1K"),
        http_options=types.HttpOptions(timeout=IMAGE_TIMEOUT_MS),
    )
    last: Exception | None = None
    for _attempt in range(2):
        try:
            resp = client.models.generate_content(model=model, contents=contents, config=config)
            for part in resp.candidates[0].content.parts:
                if part.inline_data and part.inline_data.data:
                    return part.inline_data.data, part.inline_data.mime_type or "image/jpeg"
            raise RuntimeError("no image in the response (it may have been blocked)")
        except Exception as exc:  # noqa: BLE001
            last = exc
            if not any(code in str(exc) for code in ("500", "502", "503", "504", "DEADLINE", "UNAVAILABLE")):
                break
    raise last  # type: ignore[misc]


def product_photo_prompt(g: dict) -> str:
    who = {"men": "men's", "women": "women's"}.get(g.get("gender", ""), "unisex")
    return (
        f"Studio e-commerce product photo of a {who} {g.get('subcategory', 'garment').lower().rstrip('s')}: "
        f"\"{g.get('name', '')}\". {g.get('description', '')} Material: {g.get('material', '')}. "
        f"Colour: {g.get('colorName', '')} ({g.get('colorHex', '')}). {str(g.get('fitIntent', 'regular')).lower()} fit. "
        "Shown flat-lay, the whole garment in frame, on a plain light grey background, soft even lighting, "
        "true-to-life colour. No person, no mannequin, no text, no logo, no watermark."
    )


def product_photo(garment: dict, client=None) -> tuple[bytes, str] | None:
    """A product photo matching the garment's type, colour and description."""
    if client is None and not enabled():
        return None
    try:
        return _generate_image(client or _client(), PRODUCT_IMAGE_MODEL, [product_photo_prompt(garment)], "1:1")
    except Exception as exc:  # noqa: BLE001
        log.warning("gemini product photo failed: %s", exc)
        return None


_TRYON_PROMPT = (
    "Image 1 is a person. Image 2 is a garment ({what}). Create a realistic photo of the SAME person from "
    "image 1 wearing the garment from image 2. Keep their face, hair, skin tone, body shape and proportions, "
    "pose and the background exactly as in image 1 — do not make them slimmer, taller or more muscular. "
    "Replace only the clothing the garment covers; keep everything else. The garment keeps its exact colour, "
    "fabric, collar, sleeves and length from image 2, and drapes naturally on this body. "
    "Never replace the person with someone else and never invent a face: if image 1 shows a mannequin, "
    "a 3D figure or a face that is hidden, keep it exactly as it is. "
    "Same framing and lighting as image 1, no text."
)


def photo_tryon(person: bytes, garment: bytes, garment_mime: str, what: str, client=None) -> tuple[bytes, str] | None:
    """The person's own photo, wearing the garment. A style preview only: the
    image model always makes clothes look good, so fit comes from the fit map."""
    if client is None and not enabled():
        return None
    try:
        from google.genai import types  # noqa: PLC0415
        from PIL import Image, ImageOps  # noqa: PLC0415

        # Upright (phone EXIF) and downscaled: detail beyond ~1 MP adds upload
        # and generation time, not quality.
        img = ImageOps.exif_transpose(Image.open(io.BytesIO(person))).convert("RGB")
        img.thumbnail((1024, 1024))
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        aspect = "3:4" if img.height >= img.width else "4:3"
        contents = [
            _TRYON_PROMPT.format(what=what),
            types.Part.from_bytes(data=buf.getvalue(), mime_type="image/jpeg"),
            types.Part.from_bytes(data=garment, mime_type=garment_mime),
        ]
        return _generate_image(client or _client(), TRYON_IMAGE_MODEL, contents, aspect)
    except Exception as exc:  # noqa: BLE001
        log.warning("gemini photo try-on failed: %s", exc)
        return None


# ── 4. size-chart reading (admin) ──

DIMENSIONS = ["chest", "waist", "hip", "shoulder_width", "neck", "arm_length", "inseam", "thigh"]

_CHART_SYSTEM = (
    "You read clothing size charts from images and transcribe them exactly. Never invent numbers: "
    "if a cell is empty or unreadable, leave it out. Map each column to one of these dimensions: "
    "chest (also called bust), waist, hip (hips, seat), shoulder_width (shoulder, across shoulder), "
    "neck (collar), arm_length (sleeve, sleeve length), inseam (inside leg), thigh. Use 'other' for "
    "anything else (length, height, weight, rise, cup, etc.). A cell like '86-90' or '86–90' is a range "
    "(min 86, max 90); a single number has max null. Say whether the numbers are in cm or inches, and "
    "whether the chart lists BODY measurements (what the person measures) or GARMENT measurements "
    "(flat/laid-out garment dimensions). Keep size labels exactly as printed, smallest first."
)

_CHART_SCHEMA = {
    "type": "object",
    "properties": {
        "unit": {"type": "string", "enum": ["cm", "in"]},
        "chartKind": {"type": "string", "enum": ["body", "garment", "unknown"]},
        "categoryGuess": {"type": "string", "enum": ["TOPS", "BOTTOMS", "DRESSES", "OUTERWEAR", "unknown"]},
        "sizes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string"},
                    "values": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "dimension": {"type": "string", "enum": DIMENSIONS + ["other"]},
                                "min": {"type": "number"},
                                "max": {"type": ["number", "null"]},
                            },
                            "required": ["dimension", "min"],
                        },
                    },
                },
                "required": ["label", "values"],
            },
        },
        "notes": {"type": "string"},
    },
    "required": ["unit", "chartKind", "sizes"],
}


def normalise_chart(raw: dict) -> dict:
    """Gemini's transcription → the shop's size-chart form: cm, [min, max]
    ranges per dimension, sizes in order. Plain code, so it is checkable.

    Single values (a chart listing "Chest 96" per size) become ranges that
    meet halfway to the neighbouring sizes — how brands mean them.
    """
    factor = 2.54 if raw.get("unit") == "in" else 1.0
    sizes = []
    for s in raw.get("sizes", []):
        label = str(s.get("label", "")).strip()
        if not label:
            continue
        vals: dict[str, list[float | None]] = {}
        for v in s.get("values", []):
            dim = v.get("dimension")
            if dim not in DIMENSIONS or not isinstance(v.get("min"), (int, float)):
                continue
            lo = float(v["min"]) * factor
            hi = float(v["max"]) * factor if isinstance(v.get("max"), (int, float)) else None
            if hi is not None and hi < lo:
                lo, hi = hi, lo
            vals[dim] = [lo, hi]
        if vals:
            sizes.append({"label": label, "values": vals})

    warnings: list[str] = []
    for dim in DIMENSIONS:
        points = [(i, s["values"][dim]) for i, s in enumerate(sizes) if dim in s["values"]]
        singles = [(i, v) for i, v in points if v[1] is None]
        if not singles:
            continue
        centres = [v[0] for _, v in points]
        for k, (i, v) in enumerate(points):
            if v[1] is not None:
                continue
            c = v[0]
            prev_c = centres[k - 1] if k > 0 else None
            next_c = centres[k + 1] if k + 1 < len(centres) else None
            half_lo = (c - prev_c) / 2 if prev_c is not None else ((next_c - c) / 2 if next_c is not None else 2.0)
            half_hi = (next_c - c) / 2 if next_c is not None else half_lo
            sizes[i]["values"][dim] = [c - abs(half_lo), c + abs(half_hi)]
        warnings.append(f"{dim}: single values turned into ranges between neighbouring sizes.")

    # Many charts give sleeve from the centre back of the neck (~75–85 cm);
    # the shop's arm length is shoulder → wrist (~55–65 cm). Those numbers
    # would size every sleeve as "too long", so leave them out and say why.
    arms = [s["values"]["arm_length"][0] for s in sizes if "arm_length" in s["values"]]
    if arms and float(np.median(arms)) > 68:
        for s in sizes:
            s["values"].pop("arm_length", None)
        sizes = [s for s in sizes if s["values"]]
        warnings.append("Sleeve looks measured from the centre back of the neck, not shoulder to wrist "
                        "— left out. Add arm length by hand if the brand gives it from the shoulder.")

    out_sizes = [
        {"label": s["label"], "measurements": {d: [round(v[0], 1), round(v[1], 1)] for d, v in s["values"].items()}}
        for s in sizes
    ]
    kind = raw.get("chartKind", "unknown")
    if kind == "garment":
        warnings.append("This looks like a GARMENT chart (the clothes' own size). The shop expects BODY "
                        "measurements — garment numbers already include ease, so sizes may come out too small.")
    if factor != 1.0:
        warnings.append("Converted from inches to centimetres.")
    dims = [d for d in DIMENSIONS if any(d in s["measurements"] for s in out_sizes)]
    cat = raw.get("categoryGuess")
    return {
        "unit": "cm",
        "chartKind": kind,
        "categoryGuess": cat if cat in ("TOPS", "BOTTOMS", "DRESSES", "OUTERWEAR") else None,
        "dimensions": dims,
        "sizes": out_sizes,
        "warnings": warnings,
        "notes": raw.get("notes") or "",
    }


def read_size_chart(image: bytes, mime_type: str, client=None) -> dict | None:
    """Transcribe a size-chart image, or None if Gemini is off or fails."""
    if client is None and not enabled():
        return None
    try:
        from google.genai import types  # noqa: PLC0415

        c = client or _client()
        resp = c.models.generate_content(
            model=VISION_MODEL,
            contents=["Transcribe this size chart.", types.Part.from_bytes(data=image, mime_type=mime_type)],
            config=types.GenerateContentConfig(
                system_instruction=_CHART_SYSTEM,
                response_mime_type="application/json",
                response_json_schema=_CHART_SCHEMA,
                temperature=0.0,
                http_options=types.HttpOptions(timeout=PHOTO_TIMEOUT_MS),
            ),
        )
        raw = json.loads(resp.text or "{}")
    except Exception as exc:  # noqa: BLE001
        log.warning("gemini size-chart read failed: %s", exc)
        return None
    result = normalise_chart(raw)
    result["model"] = VISION_MODEL
    return result


def _jpeg(image_bgr: np.ndarray, long_side: int = 768) -> bytes:
    from PIL import Image  # noqa: PLC0415

    rgb = image_bgr[:, :, ::-1]
    img = Image.fromarray(rgb)
    img.thumbnail((long_side, long_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def check_photos(images: dict[str, np.ndarray], client=None) -> list[dict] | None:
    """Advisory issues (severity "warning") per view, or None if not run."""
    if client is None and not photo_check_enabled():
        return None
    try:
        from google.genai import types  # noqa: PLC0415

        c = client or _client()
        parts: list = []
        for view in ("front", "back", "left", "right"):
            if view in images:
                parts.append(f"Photo: {view}")
                parts.append(types.Part.from_bytes(data=_jpeg(images[view]), mime_type="image/jpeg"))
        resp = c.models.generate_content(
            model=VISION_MODEL,
            contents=parts,
            config=types.GenerateContentConfig(
                system_instruction=_PHOTO_SYSTEM,
                response_mime_type="application/json",
                response_json_schema=_PHOTO_SCHEMA,
                temperature=0.0,
                http_options=types.HttpOptions(timeout=PHOTO_TIMEOUT_MS),
            ),
        )
        data = json.loads(resp.text or "{}")
    except Exception as exc:  # noqa: BLE001 — advisory only
        log.warning("gemini photo check failed: %s", exc)
        return None

    issues: list[dict] = []
    for v in data.get("views", []):
        for flag, (code, message) in _PHOTO_MESSAGES.items():
            # From the side an arm always overlaps the torso — not a fault.
            if flag == "arms_against_body" and v.get("view") in ("left", "right"):
                continue
            if v.get(flag) is True and v.get("view") in images:
                issues.append({"view": v["view"], "code": code, "severity": "warning",
                               "message": message, "source": "gemini"})
    return issues
