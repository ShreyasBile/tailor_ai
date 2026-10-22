"""Four-view scan: measurement geometry, quality gate, body fit."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
import pytest

from app.bodymodel.humanoid import SHAPE_DIMS, build
from app.research import measurements as mesh_measure
from app.scan import measure as M
from app.scan import quality
from app.scan.body_fit import fit

HEIGHT_CM = 175.0


def _render_mask(mesh, yaw_deg: float, size=(1200, 900)) -> np.ndarray:
    """Orthographic silhouette of the mesh seen from `yaw_deg` (0 = front)."""
    h, w = size
    a = np.deg2rad(yaw_deg)
    rot = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    v = mesh.vertices @ rot.T
    y0, y1 = v[:, 1].min(), v[:, 1].max()
    s = 0.8 * h / (y1 - y0)
    px = np.stack([w / 2 + v[:, 0] * s, h * 0.9 - (v[:, 1] - y0) * s], axis=1).astype(np.int32)
    mask = np.zeros((h, w), np.uint8)
    # One fill per triangle: a single multi-polygon fillPoly uses even-odd
    # filling and would leave overlapping faces hollow.
    for f in mesh.faces:
        cv2.fillConvexPoly(mask, px[f], 255)
    return mask


@pytest.fixture(scope="module")
def body():
    shape = np.zeros(SHAPE_DIMS)
    shape[1] = 0.6  # a bit fuller than the default, so it's not a trivial case
    mesh, info = build(shape.tolist(), metric_scale=1.0, return_landmarks=True)
    truth = mesh_measure.extract(mesh, info).to_dict()
    views = {
        "front": M.ViewData("front", _render_mask(mesh, 0)),
        "back": M.ViewData("back", _render_mask(mesh, 180)),
        "left": M.ViewData("left", _render_mask(mesh, 90)),
        "right": M.ViewData("right", _render_mask(mesh, -90)),
    }
    return views, truth


def test_extracts_at_least_ten_measurements(body):
    views, _ = body
    meas = M.extract(views, HEIGHT_CM)
    assert len(meas) >= 10
    assert meas["height"].value == HEIGHT_CM
    for m in meas.values():
        assert 0 < m.confidence <= 1
        assert m.kind in ("girth", "width", "length")


def test_girths_track_the_true_body(body):
    """Silhouette widths/depths recover the mesh's own girths. The ANSUR shape
    factor models a *human* torso, so on this idealised elliptical mesh the
    torso girths read high by about that factor — the check is on geometry."""
    views, truth = body
    meas = M.extract(views, HEIGHT_CM)
    for name in ("waist", "hip"):
        recovered = meas[name].value / M.SHAPE_FACTOR[name]
        assert recovered == pytest.approx(truth[name], rel=0.12), name


def test_four_views_agree_with_each_other(body):
    views, _ = body
    meas = M.extract(views, HEIGHT_CM)
    # Front/back and left/right of a symmetric body agree → high agreement.
    assert meas["waist"].confidence > 0.5


def test_front_and_one_side_is_the_minimum(body):
    views, _ = body
    meas = M.extract({"front": views["front"], "left": views["left"]}, HEIGHT_CM)
    assert "chest" in meas
    with pytest.raises(ValueError):
        M.extract({"front": views["front"], "back": views["back"]}, HEIGHT_CM)


def test_ellipse_perimeter_matches_circle():
    assert M.ellipse_perimeter(10, 10) == pytest.approx(2 * np.pi * 10, rel=1e-6)


def test_body_fit_reproduces_measured_girths():
    target = {"chest": 98.0, "waist": 84.0, "hip": 99.0, "thigh": 57.0}
    res = fit(target, 180.0, max_iter=4)
    assert res.metric_scale == pytest.approx(180 / 175, rel=1e-6)
    assert len(res.shape) == SHAPE_DIMS
    for k in ("chest", "waist", "hip"):
        assert abs(res.residual_cm[k]) < 4.0, (k, res.residual_cm)


# ── quality gate (runs the real detector) ──


def test_blank_photo_is_rejected_with_a_helpful_message():
    from app.scan import pose as P

    img = np.full((1200, 900, 3), 200, np.uint8)
    q = quality.assess("front", img, P.detect(img))
    assert not q.ok
    codes = {i.code for i in q.issues}
    assert "NO_PERSON" in codes
    assert all(i.message for i in q.issues)


def test_tiny_photo_is_rejected():
    from app.scan import pose as P

    img = np.full((280, 200, 3), 128, np.uint8)
    q = quality.assess("left", img, P.detect(img))
    assert not q.ok and q.issues[0].code == "LOW_RESOLUTION"
    assert "200×280" in q.issues[0].message  # says what it got, not just "too small"


# ── small photos (the sample scan, downscaled) ──

DEMO = Path(__file__).resolve().parents[3] / "apps" / "web" / "public" / "demo-scan"


def _demo_at(long_side: int) -> dict[str, np.ndarray]:
    out = {}
    for v in ("front", "back", "left", "right"):
        im = cv2.imread(str(DEMO / f"{v}.jpg"))
        s = long_side / max(im.shape[:2])
        out[v] = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    return out


@pytest.fixture(scope="module")
def demo_full():
    from app.scan.analyze import analyze

    cv2.setRNGSeed(0)
    res = analyze(_demo_at(1440), 172.0, fit_body=False)
    assert res["status"] == "accepted"
    return {m["name"]: m["value"] for m in res["measurements"]}


def test_small_photos_below_the_old_480px_limit_are_measured(demo_full):
    from app.scan.analyze import analyze

    # 480×640: rejected outright before. The person is ~470 px tall in it.
    cv2.setRNGSeed(0)
    res = analyze(_demo_at(640), 172.0, fit_body=False)
    assert res["status"] == "accepted", res["issues"]
    codes = {i["code"] for i in res["issues"]}
    assert "LOW_DETAIL" in codes  # accepted, but the user is told it's less precise
    assert not codes & {"BLURRY", "SOFT"}  # the upscale must not read as blur
    assert all(v["metrics"]["resolution"] == [480, 640] for v in res["views"])
    # Measured drift at this size is ~3 cm on average (hip/thigh worst, +4–6 cm:
    # the person matte runs wide at low detail) — hence the LOW_DETAIL warning.
    # This guards against the upscale path breaking, e.g. a wrong scale factor.
    small = {m["name"]: m["value"] for m in res["measurements"]}
    keys = ("chest", "waist", "hip", "shoulder_width")
    drift = {k: abs(small[k] - demo_full[k]) for k in keys}
    assert max(drift.values()) < 7.5, drift
    assert sum(drift.values()) / len(keys) < 4.5, drift


def test_low_detail_lowers_confidence(demo_full):
    from app.scan.analyze import analyze

    cv2.setRNGSeed(0)
    full = analyze(_demo_at(1440), 172.0, fit_body=False)
    cv2.setRNGSeed(0)
    small = analyze(_demo_at(640), 172.0, fit_body=False)
    assert small["confidence"]["scanQuality"] < full["confidence"]["scanQuality"]


def test_person_too_few_pixels_tall_is_rejected_per_photo():
    from app.scan.analyze import analyze

    # 270×360: still opens, but the person is only ~250 px tall.
    res = analyze(_demo_at(360), 172.0, fit_body=False)
    assert res["status"] == "rejected"
    low = [i for i in res["issues"] if i["code"] == "LOW_RESOLUTION"]
    assert {i["view"] for i in low} == {"front", "back", "left", "right"}
    assert "pixels tall" in low[0]["message"]


def test_analyze_rejects_missing_views():
    from app.scan.analyze import analyze

    img = np.full((1200, 900, 3), 200, np.uint8)
    res = analyze({"front": img}, HEIGHT_CM)
    assert res["status"] == "rejected"
    missing = {i["view"] for i in res["issues"] if i["code"] == "MISSING_VIEW"}
    assert missing == {"back", "left", "right"}
