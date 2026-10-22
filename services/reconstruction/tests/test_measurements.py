"""Guards on the measurement extractor — the ground-truth generator for the
research dataset. If these drift, every synthetic label is wrong."""

from __future__ import annotations


from app.bodymodel.humanoid import SHAPE_DIMS, build
from app.research import measurements as M


def _measure(shape, height_cm):
    mesh, info = build(shape, metric_scale=height_cm / 175.0, return_landmarks=True)
    return M.extract(mesh, info)


def test_height_is_exact():
    for h in (150.0, 168.0, 185.0, 200.0):
        m = _measure([0.0] * SHAPE_DIMS, h)
        assert abs(m.height - h) < 0.2, f"{h} -> {m.height}"


def test_all_14_measurements_present():
    m = _measure([0.0] * SHAPE_DIMS, 175.0).to_dict()
    for k in ("height", "chest", "waist", "hip", "thigh", "calf", "ankle",
              "shoulder_breadth", "arm_length", "leg_length",
              "shoulder_to_crotch", "bicep", "forearm", "wrist"):
        assert m[k] is not None and m[k] > 0, f"missing {k}"


def test_girths_scale_with_build():
    slim = _measure([0, -1.3, -0.5, -0.7, -0.5, -1.1, 0, 0] + [0.0] * (SHAPE_DIMS - 8), 175.0)
    broad = _measure([0, 1.5, 1.1, 0.9, 1.0, 1.1, 0, 0] + [0.0] * (SHAPE_DIMS - 8), 175.0)
    # Same height, but a broad build must be larger everywhere it counts.
    assert abs(slim.height - broad.height) < 0.2
    for attr in ("chest", "waist", "hip", "thigh", "bicep"):
        assert getattr(broad, attr) > getattr(slim, attr) * 1.2, attr


def test_anatomical_ordering():
    m = _measure([0.0] * SHAPE_DIMS, 175.0)
    # Girths taper down each limb.
    assert m.thigh > m.calf > m.ankle
    assert m.bicep > m.wrist
    # Torso: chest and hip exceed the waist for a typical build.
    assert m.chest > m.waist * 0.9 and m.hip > m.waist * 0.85


def test_measurements_are_metric_scale_linear():
    """Doubling stature scales a girth ~linearly (same shape)."""
    a = _measure([0.0] * SHAPE_DIMS, 160.0)
    b = _measure([0.0] * SHAPE_DIMS, 190.0)
    ratio = b.chest / a.chest
    assert abs(ratio - 190.0 / 160.0) < 0.05
