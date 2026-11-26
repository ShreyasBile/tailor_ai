"""Fitting room: fit → geometry, product photos, rendering, AI engines' plumbing."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace as NS

import cv2
import pytest

from app.fit.engine import recommend
from app.tryon import ai, service
from app.tryon.fit import geometry
from app.tryon.garment import read
from app.tryon.product import style_for

ROOT = Path(__file__).resolve().parents[3]
GARMENTS = ROOT / "apps" / "web" / "public" / "garments"
PERSON = ROOT / ".data" / "user-scan" / "front.png"  # a real photo, local only (not in git)

CHART = [{"label": lab, "measurements": {"chest": rng}} for lab, rng in
         [("XS", [80, 88]), ("S", [88, 95]), ("M", [95, 106]), ("L", [106, 114]), ("XL", [114, 122])]]
BODY = {"chest": {"value": 101.0, "confidence": 0.8}}


@pytest.fixture(scope="module")
def sizes():
    rec = recommend(BODY, {"category": "tops", "fitIntent": "regular", "stretch": "medium",
                           "subcategory": "Jerseys"}, CHART, "regular")
    assert rec["recommendedSize"] == "M"
    return rec


def test_smaller_sizes_are_tighter_and_shorter(sizes):
    g = {s: geometry(s, sizes["sizes"], "M", "tops") for s in ("XS", "S", "M", "L", "XL")}
    assert g["XS"].tightness > g["S"].tightness >= g["M"].tightness
    assert g["XL"].looseness > g["L"].looseness >= g["M"].looseness
    assert g["XS"].length_cm < g["M"].length_cm < g["XL"].length_cm
    assert g["XS"].summary == "Very tight" and g["M"].summary == "True to size"
    chest = next(z for z in g["XS"].zones if z.name == "chest")
    assert chest.tone == "bad" and "too small" in chest.text


def test_fit_description_is_honest(sizes):
    tight = ai.describe_fit(geometry("XS", sizes["sizes"], "M", "tops"), "XS")
    assert "too small" in tight and "rides up" in tight
    good = ai.describe_fit(geometry("M", sizes["sizes"], "M", "tops"), "M")
    assert "fits this person well" in good


@pytest.mark.parametrize("slug", ["northline-essential-tee", "northline-oxford-shirt", "desi-loom-cotton-kurta",
                                  "stride-football-jersey", "northline-field-jacket"])
def test_product_photos_are_read(slug):
    g = read(cv2.imread(str(GARMENTS / f"{slug}.jpg")), "top")
    assert g.y_top < g.y_shoulder < g.y_armpit < g.y_hem
    assert g.body_half > 50
    assert (g.mask > 0).mean() > 0.15


def test_bottoms_product_photo_has_two_legs():
    g = read(cv2.imread(str(GARMENTS / "denim-theory-slim-chino.jpg")), "bottom")
    assert g.kind == "bottom" and g.y_top < g.y_shoulder < g.y_hem  # y_shoulder holds the crotch


def test_styles():
    assert style_for("desi-loom-nehru-jacket", "", "", "", "outerwear").layer
    assert style_for("northline-wool-overcoat", "", "", "", "outerwear").length == "knee"
    assert style_for("x", "T-shirts", "Tee", "", "tops").sleeve == "short"
    assert style_for("x", "Kurtas", "Kurta", "three-quarter sleeves", "tops").sleeve == "three_quarter"


def _req(sizes, **kw):
    base = dict(personImageUrl="person", personKey=f"test-{kw.get('mode', 'own')}", heightCm=172.0, view="front",
                mode="own", garment=NS(slug="stride-football-jersey", name="Jersey", category="tops",
                                       subcategory="Jerseys", description="",
                                       imageUrl=str(GARMENTS / "stride-football-jersey.jpg")),
                sizes=sizes["sizes"], size="XS", recommended="M", amplify=1.0, engine="fast")
    base.update(kw)
    return NS(**base)


@pytest.fixture
def photo(monkeypatch):
    if not PERSON.exists():
        pytest.skip("needs a local scan photo at .data/user-scan/front.png")
    monkeypatch.setattr(service, "fetch_image", lambda u: cv2.imread(str(PERSON)) if u == "person" else cv2.imread(u))
    monkeypatch.setattr(ai, "CACHE_DIR", Path(__file__).parent / ".tryon-cache-test")


def test_own_outfit_renders_every_size(sizes, photo):
    out = {s: service.preview(_req(sizes, size=s)) for s in ("XS", "M", "XL")}
    assert out["XS"]["summary"] == "Very tight" and out["M"]["summary"] == "True to size"
    assert all(r["width"] > 200 and r["height"] > 300 for r in out.values())
    assert {z["name"] for z in out["XS"]["zones"]} >= {"chest", "length"}


def test_product_tryon_renders(sizes, photo):
    r = service.preview(_req(sizes, mode="product", size="M"))
    assert r["engine"] == "fast" and r["imageBase64"]


def test_gemini_engine_gets_the_draft_and_the_numbers(sizes, photo, monkeypatch):
    seen = {}

    def fake(original, draft, product, what, size, fit, own):
        seen.update(original=original.shape, draft=draft.shape, product=product, size=size, fit=fit, own=own)
        ok, buf = cv2.imencode(".jpg", draft)
        return buf.tobytes(), "fake-image-model"

    monkeypatch.setattr(ai, "gemini_enabled", lambda: True)
    monkeypatch.setattr(ai, "gemini_photo", fake)
    for f in ai.CACHE_DIR.glob("*.jpg") if ai.CACHE_DIR.exists() else []:
        f.unlink()
    r = service.preview(_req(sizes, engine="gemini"))
    assert r["engine"] == "gemini" and r["model"] == "fake-image-model"
    assert seen["size"] == "XS" and seen["own"] is True and seen["product"] is None
    assert "too small" in seen["fit"]
    assert seen["original"][:2] == seen["draft"][:2]  # same framing
    # second time: from the disk cache, no model call
    seen.clear()
    r2 = service.preview(_req(sizes, engine="gemini"))
    assert r2["model"] == "cache" and not seen


def test_unavailable_engine_says_why(sizes, photo, monkeypatch):
    monkeypatch.setattr(ai, "local_enabled", lambda: False)
    with pytest.raises(service.EngineUnavailable, match="on-device"):
        service.preview(_req(sizes, engine="local"))


def teardown_module(_m):
    d = Path(__file__).parent / ".tryon-cache-test"
    if d.exists():
        for f in d.glob("*"):
            f.unlink()
        d.rmdir()


def _lum(hex_colour: str) -> float:
    r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
    return 0.299 * r + 0.587 * g + 0.114 * b


def test_texture_atlas_for_the_3d_fitting_room():
    from app.tryon.texture import SIZE, atlas

    tex, meta = atlas(read(cv2.imread(str(GARMENTS / "stride-football-jersey.jpg")), "top"))
    assert tex.shape == (SIZE, SIZE, 3)
    assert meta["pattern"] == "vertical"  # its stripes carry round to the back
    assert _lum(meta["collar"]) < 80 and _lum(meta["cuff"]) < 80  # black collar and cuffs
    assert _lum(meta["tone"]) > 150
    tee, m2 = atlas(read(cv2.imread(str(GARMENTS / "northline-essential-tee.jpg")), "top"))
    assert m2["pattern"] == "plain"
    back = tee[100:700, 512:].reshape(-1, 3).astype(float)
    assert back.std(axis=0).max() < 12  # a plain back, no ghost of the front's collar
