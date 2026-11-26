"""The `/tryon/preview` endpoint's work: fetch, parse (cached), render (cached)."""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import threading
import time
from collections import OrderedDict

import cv2

from ..storage import fetch_image
from . import parse as parse_mod
from .fit import geometry
from .garment import read_cached
from .product import ProductSampler, style_for
from .render import render

log = logging.getLogger(__name__)

TOP_CATEGORIES = {"tops", "outerwear", "dresses"}
MAX_OUT_H = 1100

_results: OrderedDict[str, dict] = OrderedDict()
_lock = threading.Lock()


class Unsupported(ValueError):
    pass


def _parsed(person_key: str, url: str, height_cm: float, view: str) -> parse_mod.Parsed:
    key = f"{person_key}|{height_cm:.1f}|{view}"
    with parse_mod._lock:  # noqa: SLF001 — shared cache
        hit = parse_mod._cache.get(key)  # noqa: SLF001
    if hit is not None:
        return hit
    return parse_mod.parse_cached(key, fetch_image(url), height_cm, view)


def preview(req) -> dict:
    started = time.perf_counter()
    cat = req.garment.category.lower()
    if cat not in TOP_CATEGORIES:
        raise Unsupported("Seeing trousers, shorts and skirts on your photo isn't available yet — "
                          "the size details below still apply.")
    sizes_sig = hashlib.sha1(json.dumps(req.sizes, sort_keys=True, default=str).encode()).hexdigest()[:12]
    rkey = "|".join([req.personKey, f"{req.heightCm:.1f}", req.view, req.mode, req.garment.slug,
                     req.garment.imageUrl or "", req.size, req.recommended, sizes_sig, f"{req.amplify:.2f}"])
    with _lock:
        hit = _results.get(rkey)
        if hit is not None:
            _results.move_to_end(rkey)
            return {**hit, "cached": True, "elapsedMs": int((time.perf_counter() - started) * 1000)}

    p = _parsed(req.personKey, req.personImageUrl, req.heightCm, req.view)
    g = geometry(req.size, req.sizes, req.recommended, cat, amplify=req.amplify)
    sampler = None
    if req.mode == "product":
        if not req.garment.imageUrl:
            raise Unsupported("This item has no product photo to try on yet.")
        gar = read_cached(f"{req.garment.slug}|{req.garment.imageUrl}", fetch_image(req.garment.imageUrl), "top")
        style = style_for(req.garment.slug, req.garment.subcategory, req.garment.name,
                          req.garment.description, cat)
        sampler = ProductSampler(gar, style, p)
    out = render(p, g, sampler)

    img = out.image
    if img.shape[0] > MAX_OUT_H:
        s = MAX_OUT_H / img.shape[0]
        img = cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    if not ok:
        raise RuntimeError("could not encode the preview")
    result = {
        "imageBase64": base64.b64encode(buf.tobytes()).decode(),
        "mimeType": "image/jpeg",
        "width": int(img.shape[1]),
        "height": int(img.shape[0]),
        "zones": out.zones,
        "summary": out.summary,
        "size": req.size,
        "tightness": round(g.tightness, 2),
        "looseness": round(g.looseness, 2),
    }
    with _lock:
        _results[rkey] = result
        while len(_results) > 120:
            _results.popitem(last=False)
    log.info("try-on %s %s %s %s: %d ms", req.mode, req.garment.slug, req.size, req.view,
             int((time.perf_counter() - started) * 1000))
    return {**result, "cached": False, "elapsedMs": int((time.perf_counter() - started) * 1000)}
