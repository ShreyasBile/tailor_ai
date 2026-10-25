"""Gemini features: off without a key, privacy of what is sent, and that every
failure falls back to the rules-based result. A fake client stands in for the
API, so these run offline."""

import json
from types import SimpleNamespace

import numpy as np
import pytest

from app.fit.engine import recommend
from app.llm import gemini

CHART = [
    {"label": "M", "measurements": {"chest": [94, 102], "waist": [80, 88]}},
    {"label": "L", "measurements": {"chest": [102, 110], "waist": [88, 96]}},
]
GARMENT = {"category": "tops", "fitIntent": "regular", "stretch": "none"}


class FakeClient:
    def __init__(self, text=None, error=None):
        self.calls = []
        self._text, self._error = text, error
        self.models = self

    def generate_content(self, model, contents, config):
        self.calls.append({"model": model, "contents": contents, "config": config})
        if self._error:
            raise self._error
        return SimpleNamespace(text=self._text)


@pytest.fixture
def result():
    return recommend({"chest": {"value": 100, "confidence": 0.8}, "waist": 86}, GARMENT, CHART)


def test_off_without_a_key(monkeypatch, result):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert not gemini.enabled()
    assert gemini.explain_fit(result, GARMENT, "regular") is None
    assert gemini.check_photos({"front": np.zeros((8, 8, 3), np.uint8)}) is None


def test_explanation_sends_only_numbers(result):
    size = result["recommendedSize"]
    fake = FakeClient(text=f"We recommend size {size}: your chest sits comfortably in its range.")
    text = gemini.explain_fit(result, GARMENT, "regular", client=fake)
    assert text and size in text
    sent = json.loads(fake.calls[0]["contents"])
    assert set(sent) == {"recommendedSize", "alternativeSize", "betweenSizes", "fitScore", "fitLabel", "noSizeFits", "smallerSizesTooTight",
                         "garment", "shopperPreference", "dimensions"}
    for d in sent["dimensions"]:
        assert set(d) == {"area", "yourMeasurementCm", "sizeRangeCm", "verdict", "outsideSizeRangeCm"}
    assert fake.calls[0]["model"] == gemini.TEXT_MODEL


@pytest.mark.parametrize("bad", ["", "Looks great on you!", "Size " + "x" * 800])
def test_unusable_explanation_keeps_rules_text(result, bad):
    assert gemini.explain_fit(result, GARMENT, "regular", client=FakeClient(text=bad)) is None


def test_outage_keeps_rules_text(result):
    assert gemini.explain_fit(result, GARMENT, "regular", client=FakeClient(error=TimeoutError("slow"))) is None


def test_photo_flags_become_warnings_never_errors():
    reply = {"views": [
        {"view": "front", "loose_clothing": True, "hair_over_neck": False, "arms_against_body": True},
        # From the side the arm always overlaps the torso: never reported.
        {"view": "left", "loose_clothing": False, "hair_over_neck": False, "arms_against_body": True},
    ]}
    imgs = {v: np.full((64, 48, 3), 128, np.uint8) for v in ("front", "back", "left", "right")}
    fake = FakeClient(text=json.dumps(reply))
    issues = gemini.check_photos(imgs, client=fake)
    assert {(i["view"], i["code"]) for i in issues} == {("front", "LOOSE_CLOTHING"), ("front", "ARMS_TOUCHING")}
    assert all(i["severity"] == "warning" and i["message"] for i in issues)
    # four photos, each preceded by its label, sent as JPEG parts
    assert len(fake.calls[0]["contents"]) == 8
    assert fake.calls[0]["model"] == gemini.VISION_MODEL


def test_photo_check_failure_is_silent():
    imgs = {"front": np.zeros((32, 32, 3), np.uint8)}
    assert gemini.check_photos(imgs, client=FakeClient(text="not json")) is None
    assert gemini.check_photos(imgs, client=FakeClient(error=RuntimeError("down"))) is None


def test_chart_inches_and_single_values_become_cm_ranges():
    raw = {
        "unit": "in", "chartKind": "body", "categoryGuess": "TOPS",
        "sizes": [
            {"label": "S", "values": [{"dimension": "chest", "min": 36, "max": None},
                                      {"dimension": "waist", "min": 30, "max": 32},
                                      {"dimension": "other", "min": 27, "max": None}]},
            {"label": "M", "values": [{"dimension": "chest", "min": 40, "max": None},
                                      {"dimension": "waist", "min": 32, "max": 34}]},
            {"label": "L", "values": [{"dimension": "chest", "min": 44, "max": None}]},
        ],
    }
    out = gemini.normalise_chart(raw)
    m = {s["label"]: s["measurements"] for s in out["sizes"]}
    # 40 in = 101.6 cm; neighbours 36/44 in → ranges meet halfway (38/42 in).
    assert m["M"]["chest"] == [96.5, 106.7]
    assert m["S"]["chest"] == [86.4, 96.5] and m["L"]["chest"] == [106.7, 116.8]
    assert m["S"]["waist"] == [76.2, 81.3]
    assert "other" not in m["S"]
    assert out["dimensions"] == ["chest", "waist"] and out["categoryGuess"] == "TOPS"
    assert any("inches" in w for w in out["warnings"])


def test_centre_back_sleeve_is_left_out():
    raw = {"unit": "in", "chartKind": "body", "sizes": [
        {"label": "S", "values": [{"dimension": "chest", "min": 34, "max": 35}, {"dimension": "arm_length", "min": 31}]},
        {"label": "M", "values": [{"dimension": "chest", "min": 36, "max": 37}, {"dimension": "arm_length", "min": 31.5}]},
    ]}
    out = gemini.normalise_chart(raw)
    assert out["dimensions"] == ["chest"]
    assert any("centre back" in w for w in out["warnings"])


def test_garment_chart_is_flagged():
    raw = {"unit": "cm", "chartKind": "garment", "sizes": [{"label": "M", "values": [{"dimension": "chest", "min": 104, "max": 108}]}]}
    out = gemini.normalise_chart(raw)
    assert any("GARMENT" in w for w in out["warnings"])


def test_chart_read_sends_image_and_parses(monkeypatch):
    reply = {"unit": "cm", "chartKind": "body", "sizes": [{"label": "M", "values": [{"dimension": "hip", "min": 96, "max": 100}]}]}
    fake = FakeClient(text=json.dumps(reply))
    out = gemini.read_size_chart(b"\xff\xd8fakejpeg", "image/jpeg", client=fake)
    assert out["sizes"] == [{"label": "M", "measurements": {"hip": [96.0, 100.0]}}]
    assert gemini.read_size_chart(b"x", "image/jpeg", client=FakeClient(text="{bad")) is None


def test_photo_check_needs_explicit_opt_in(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "k")
    monkeypatch.delenv("GEMINI_PHOTO_CHECK", raising=False)
    assert gemini.enabled() and not gemini.photo_check_enabled()
    monkeypatch.setenv("GEMINI_PHOTO_CHECK", "true")
    assert gemini.photo_check_enabled()


# ── images ──


class FakeImages:
    """Stands in for client.interactions (the image API)."""

    def __init__(self, data=b"\xff\xd8jpeg", error=None):
        import base64

        self.calls = []
        self._out, self._error = base64.b64encode(data).decode(), error
        self.interactions = self

    def create(self, **kw):
        self.calls.append(kw)
        if self._error:
            raise self._error
        return SimpleNamespace(output_image=SimpleNamespace(data=self._out, mime_type="image/jpeg"))


KURTA = {"name": "Handloom Cotton Kurta", "subcategory": "Kurtas", "gender": "men", "fitIntent": "REGULAR",
         "material": "100% handloom cotton", "description": "A knee-length kurta.", "colorName": "Saffron",
         "colorHex": "#e08a2c"}


def test_product_photo_prompt_describes_the_garment_only():
    p = gemini.product_photo_prompt(KURTA)
    assert "Saffron" in p and "#e08a2c" in p and "men's" in p and "kurta" in p.lower()
    assert "No person" in p and "no logo" in p


def test_product_photo_uses_the_product_model():
    fake = FakeImages()
    data, mime = gemini.product_photo(KURTA, client=fake)
    assert data == b"\xff\xd8jpeg" and mime == "image/jpeg"
    assert fake.calls[0]["model"] == gemini.PRODUCT_IMAGE_MODEL
    assert fake.calls[0]["response_format"]["type"] == "image"


def test_photo_tryon_sends_person_then_garment_and_keeps_the_body():
    from io import BytesIO

    from PIL import Image

    buf = BytesIO()
    Image.new("RGB", (2000, 3000), "white").save(buf, format="JPEG")
    fake = FakeImages()
    out = gemini.photo_tryon(buf.getvalue(), b"\xff\xd8garment", "image/jpeg", "Saffron kurta", client=fake)
    assert out is not None
    parts = fake.calls[0]["input"]
    assert [p["type"] for p in parts] == ["text", "image", "image"]
    assert "do not make them slimmer" in parts[0]["text"]
    assert fake.calls[0]["model"] == gemini.TRYON_IMAGE_MODEL
    # The person photo is downscaled before it leaves the service.
    import base64

    sent = Image.open(BytesIO(base64.b64decode(parts[1]["data"])))
    assert max(sent.size) <= 1024


def test_image_failures_return_none():
    assert gemini.product_photo(KURTA, client=FakeImages(error=TimeoutError())) is None
    assert gemini.photo_tryon(b"not an image", b"x", "image/jpeg", "x", client=FakeImages()) is None
