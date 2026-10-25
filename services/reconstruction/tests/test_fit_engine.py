"""Fit engine behaviour: the recommendations a person would expect."""

from __future__ import annotations

import pytest

from app.fit.engine import recommend

TOPS = [
    {"label": "S", "measurements": {"chest": (86, 94), "waist": (72, 80), "shoulder_width": (40, 43)}},
    {"label": "M", "measurements": {"chest": (94, 102), "waist": (80, 88), "shoulder_width": (43, 46)}},
    {"label": "L", "measurements": {"chest": (102, 110), "waist": (88, 96), "shoulder_width": (46, 49)}},
    {"label": "XL", "measurements": {"chest": (110, 118), "waist": (96, 104), "shoulder_width": (49, 52)}},
]
JEANS = [
    {"label": "30", "measurements": {"waist": (74, 79), "hip": (92, 97), "inseam": (78, 82)}},
    {"label": "32", "measurements": {"waist": (79, 84), "hip": (97, 102), "inseam": (79, 83)}},
    {"label": "34", "measurements": {"waist": (84, 89), "hip": (102, 107), "inseam": (80, 84)}},
]
TEE = {"category": "tops", "fitIntent": "regular", "stretch": "low"}


def test_mid_range_body_gets_the_obvious_size():
    r = recommend({"chest": 98, "waist": 84, "shoulder_width": 44.5}, TEE, TOPS)
    assert r["recommendedSize"] == "M"
    assert r["fitScore"] >= 85
    assert r["fitLabel"] == "Great fit"
    assert "M" in r["explanation"]


def test_loose_preference_sizes_up_near_a_boundary():
    body = {"chest": 101, "waist": 87, "shoulder_width": 45.8}
    regular = recommend(body, TEE, TOPS, "regular")
    loose = recommend(body, TEE, TOPS, "loose")
    assert regular["recommendedSize"] == "M"
    assert loose["recommendedSize"] == "L"


def test_snug_preference_sizes_down_near_a_boundary():
    body = {"chest": 95, "waist": 81, "shoulder_width": 43.3}
    assert recommend(body, TEE, TOPS, "regular")["recommendedSize"] == "M"
    assert recommend(body, TEE, TOPS, "snug")["recommendedSize"] == "S"


def test_slim_cut_sizes_up_and_oversized_sizes_down():
    body = {"chest": 100.5, "waist": 86, "shoulder_width": 45.5}
    slim = recommend(body, {**TEE, "fitIntent": "slim"}, TOPS)
    oversized = recommend({"chest": 103, "waist": 89, "shoulder_width": 46.3},
                          {**TEE, "fitIntent": "oversized"}, TOPS)
    assert slim["recommendedSize"] == "L"
    assert oversized["recommendedSize"] == "M"


def test_body_beyond_the_chart_is_a_poor_fit_not_a_confident_one():
    r = recommend({"chest": 130, "waist": 120, "shoulder_width": 55}, TEE, TOPS)
    assert r["recommendedSize"] == "XL"
    assert r["fitScore"] < 50
    assert any(d["verdict"] == "too tight" for d in r["dimensions"])


def test_bottoms_weight_waist_and_hip_and_report_inseam():
    r = recommend({"waist": 81, "hip": 99, "inseam": 81, "chest": 100},
                  {"category": "jeans", "fitIntent": "regular", "stretch": "medium"}, JEANS)
    assert r["recommendedSize"] == "32"
    names = [d["name"] for d in r["dimensions"]]
    assert names[0] == "waist" and "inseam" in names and "chest" not in names
    inseam = next(d for d in r["dimensions"] if d["name"] == "inseam")
    assert inseam["verdict"] == "good length"


@pytest.mark.parametrize("preference", ["snug", "regular", "loose"])
def test_a_size_whose_waist_wont_close_never_wins(preference):
    # Waist fits only 34; hip fits 32. A 32 that won't close must not win on
    # hip — not even under a loose preference, where 34's waist scores lower.
    body = {"waist": 87.1, "hip": 97.8, "inseam": 80.5}
    jeans = {"category": "bottoms", "fitIntent": "regular", "stretch": "low"}
    r = recommend(body, jeans, JEANS, preference)
    assert r["recommendedSize"] == "34"
    # ...and it isn't offered as the "closer fit" alternative either.
    assert not r["betweenSizes"]


def test_low_measurement_confidence_lowers_recommendation_confidence():
    sure = recommend({k: {"value": v, "confidence": 0.9} for k, v in
                      {"chest": 98, "waist": 84, "shoulder_width": 44.5}.items()}, TEE, TOPS)
    unsure = recommend({k: {"value": v, "confidence": 0.3} for k, v in
                        {"chest": 98, "waist": 84, "shoulder_width": 44.5}.items()}, TEE, TOPS)
    assert sure["confidence"]["value"] > unsure["confidence"]["value"]
    assert sure["recommendedSize"] == unsure["recommendedSize"]


def test_between_sizes_is_flagged_and_explained():
    r = recommend({"chest": 102, "waist": 88, "shoulder_width": 46}, TEE, TOPS)
    assert r["betweenSizes"]
    assert "between" in r["explanation"]
    assert r["alternativeSize"] in ("M", "L")


def test_no_overlapping_dimensions_is_an_error():
    with pytest.raises(ValueError):
        recommend({"inseam": 80}, TEE, TOPS)


# ── a girth that can't close rules a size out, whatever its weight ──

APPLE = {  # chest fits M, waist only fits XL (a real scan)
    "chest": {"value": 98.7, "confidence": 0.82},
    "waist": {"value": 100.6, "confidence": 0.75},
    "shoulder_width": {"value": 37.7, "confidence": 0.7},
}


def test_waist_that_cannot_close_rules_out_smaller_sizes():
    r = recommend(APPLE, TEE, TOPS)
    assert r["recommendedSize"] == "XL"  # not M: M is 12.6 cm too small at the waist
    blocked = {s["label"] for s in r["sizes"] if s["blocked"]}
    assert {"S", "M", "L"} <= blocked
    # A size that won't close never out-scores the recommendation.
    best = next(s for s in r["sizes"] if s["label"] == "XL")["score"]
    assert all(s["score"] <= best for s in r["sizes"] if s["blocked"])
    assert r["smallerSizesTooTight"][-1]["size"] == "L"
    assert "L would be" in r["explanation"] and "waist" in r["explanation"]
    assert not r["betweenSizes"]  # XL is already loose at the chest — no "size up" advice


def test_low_confidence_girth_cannot_block():
    # A thigh read through loose trousers (confidence 0.14) must not force a size.
    body = {"waist": 81, "hip": 99, "inseam": 81, "thigh": {"value": 74.0, "confidence": 0.14}}
    jeans = [{"label": l, "measurements": {**s["measurements"], "thigh": (54 + 2 * i, 57 + 2 * i)}}
             for i, (l, s) in enumerate((x["label"], x) for x in JEANS)]
    r = recommend(body, {"category": "bottoms", "fitIntent": "regular", "stretch": "low"}, jeans)
    assert r["recommendedSize"] == "32"


def test_nothing_fits_is_said_plainly():
    r = recommend({"chest": 125, "waist": 118}, TEE, TOPS)
    assert r["noSizeFits"] and r["recommendedSize"] == "XL"
    assert r["explanation"].startswith("Even the largest size")


def test_outside_cm_is_the_distance_from_the_range():
    r = recommend(APPLE, TEE, TOPS)
    xl = {d["name"]: d for d in r["dimensions"]}
    assert xl["chest"]["outsideCm"] == pytest.approx(98.7 - 110, abs=0.05)  # under the range: too big
    assert xl["waist"]["outsideCm"] == 0
