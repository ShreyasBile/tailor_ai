"""Unit tests for the pieces that must not silently drift.

Focus is on the invariants a user would notice being wrong: stated height is
delivered exactly, fusion resists outlier frames, and scale provenance is
honest about what it knows.
"""

from __future__ import annotations

import numpy as np
import pytest

from app.bodymodel.humanoid import SHAPE_DIMS, apply_cylindrical_uv, build
from app.core.fusion import _coverage_degrees, _robust_average, resolve_scale
from app.schemas import CameraParams, PerFrameEstimate


# ─────────────────────────── body model ───────────────────────────


@pytest.mark.parametrize("target_cm", [150.0, 165.0, 178.0, 195.0])
def test_delivered_height_matches_request_exactly(target_cm: float) -> None:
    """A stated height must be delivered to sub-millimetre accuracy.

    Everything downstream — sizing, measurements, tailoring — inherits this
    error, so it is the one number that cannot be approximately right.
    """
    mesh = build([0.0] * SHAPE_DIMS, metric_scale=target_cm / 175.0)
    height_cm = (mesh.bounds[1][1] - mesh.bounds[0][1]) * 100.0
    assert abs(height_cm - target_cm) < 0.1


def test_model_is_grounded_at_origin() -> None:
    mesh = build([0.0] * SHAPE_DIMS, metric_scale=1.0)
    assert abs(float(mesh.bounds[0][1])) < 1e-6


def test_girth_coefficient_changes_body_volume() -> None:
    """Girth must move actual body mass, not just the bounding box.

    Measured by volume rather than X-span: span is dominated by arm reach,
    which girth barely affects, so a span assertion would pass on a model that
    ignored the coefficient entirely.
    """
    slim = build([0.0, -1.5] + [0.0] * (SHAPE_DIMS - 2), metric_scale=1.0)
    broad = build([0.0, 1.5] + [0.0] * (SHAPE_DIMS - 2), metric_scale=1.0)

    assert broad.volume > slim.volume * 1.3


def test_hip_coefficient_widens_the_seat() -> None:
    def hip_width(mesh) -> float:
        # Sample the torso at seat height. In an A-pose the wrists sit at
        # almost exactly hip height, so the band must also be restricted to
        # the torso: it lies within ~8% of body height of the centreline,
        # while the hands are out past 25%.
        height = mesh.bounds[1][1] - mesh.bounds[0][1]
        y = mesh.bounds[0][1] + 0.53 * height
        band = mesh.vertices[np.abs(mesh.vertices[:, 1] - y) < 0.02 * height]
        torso = band[np.abs(band[:, 0]) < 0.15 * height]
        return float(torso[:, 0].max() - torso[:, 0].min()) if len(torso) else 0.0

    narrow = build([0.0, 0.0, 0.0, -1.5] + [0.0] * (SHAPE_DIMS - 4), metric_scale=1.0)
    wide = build([0.0, 0.0, 0.0, 1.5] + [0.0] * (SHAPE_DIMS - 4), metric_scale=1.0)

    assert hip_width(wide) > hip_width(narrow) * 1.1


def test_extreme_coefficients_stay_bounded() -> None:
    """An outlier estimate must not produce a grotesque mesh."""
    mesh = build([50.0] * SHAPE_DIMS, metric_scale=1.0)
    height = mesh.bounds[1][1] - mesh.bounds[0][1]
    width = mesh.bounds[1][0] - mesh.bounds[0][0]
    assert 0.5 < height < 3.0
    assert width < height * 1.2


def test_uv_covers_every_vertex_in_unit_square() -> None:
    mesh = build([0.0] * SHAPE_DIMS, metric_scale=1.0)
    uv = apply_cylindrical_uv(mesh)
    assert uv.shape == (len(mesh.vertices), 2)
    assert uv.min() >= -1e-6
    assert uv.max() <= 1.0 + 1e-6


def test_mesh_exports_to_glb_within_budget() -> None:
    import trimesh

    mesh = build([0.0] * SHAPE_DIMS, metric_scale=1.0)
    glb = trimesh.Scene(mesh).export(file_type="glb")
    assert len(glb) > 0
    # Budget is 5 MB for smooth mobile rendering (docs/05 §5).
    assert len(glb) < 5 * 1024 * 1024


# ─────────────────────────── fusion ───────────────────────────


def test_robust_average_rejects_a_single_bad_frame() -> None:
    """One badly-fit frame must not move the result.

    This is the entire reason fusion uses Huber weighting instead of a mean —
    a motion-blurred frame otherwise votes as loudly as a good one.
    """
    good = np.tile(np.array([1.0, 2.0, 3.0]), (9, 1))
    outlier = np.array([[80.0, -60.0, 95.0]])
    matrix = np.vstack([good, outlier])

    shape, confidence, outliers = _robust_average(matrix)

    assert 9 in outliers, "the outlier frame should be identified"
    np.testing.assert_allclose(shape, [1.0, 2.0, 3.0], atol=0.15)
    assert confidence.shape == (3,)


def test_single_frame_reports_low_confidence() -> None:
    """One frame cannot corroborate itself.

    Zero variance must not be read as certainty — that would present a guess
    with the same authority as a measurement.
    """
    shape, confidence, outliers = _robust_average(np.array([[1.0, 2.0, 3.0]]))
    assert outliers == []
    assert float(confidence.mean()) < 0.5


def test_agreeing_frames_raise_confidence() -> None:
    tight = np.tile(np.array([1.0, 2.0]), (12, 1)) + np.random.default_rng(0).normal(
        0, 0.01, (12, 2)
    )
    loose = np.tile(np.array([1.0, 2.0]), (12, 1)) + np.random.default_rng(0).normal(
        0, 1.2, (12, 2)
    )

    _, tight_conf, _ = _robust_average(tight)
    _, loose_conf, _ = _robust_average(loose)

    assert tight_conf.mean() > loose_conf.mean()


# ─────────────────────────── scale ladder ───────────────────────────


def test_user_height_is_preferred_and_exact() -> None:
    result = resolve_scale(182.0, "MALE")
    assert result.source == "USER_HEIGHT"
    assert result.heightCm == 182.0
    assert result.confidence is not None and result.confidence > 0.9
    assert abs(result.metricScale - 182.0 / 175.0) < 1e-9


def test_missing_height_falls_back_with_low_confidence() -> None:
    """Falling back is fine; pretending it is reliable is not."""
    result = resolve_scale(None, "FEMALE")
    assert result.source == "STATISTICAL_PRIOR"
    assert result.confidence is not None and result.confidence < 0.5


@pytest.mark.parametrize("bad", [0.0, 12.0, 400.0, -170.0])
def test_implausible_height_is_rejected(bad: float) -> None:
    result = resolve_scale(bad, "UNSPECIFIED")
    assert result.source == "STATISTICAL_PRIOR"


# ─────────────────────────── coverage ───────────────────────────


def _frame(index: int, yaw: float | None) -> PerFrameEstimate:
    return PerFrameEstimate(
        index=index,
        shape=[0.0] * 8,
        pose=[0.0] * 63,
        camera=CameraParams(
            focal=1000.0,
            principalPoint=(500.0, 500.0),
            rotation=(0.0, 0.0, 0.0, 1.0),
            translation=(0.0, 0.0, 2.8),
            subjectYawDeg=yaw,
        ),
        score=0.9,
    )


def test_full_turn_reports_high_coverage() -> None:
    frames = [_frame(i, i * 45.0) for i in range(8)]
    assert _coverage_degrees(frames) > 300.0


def test_frames_clustered_at_the_front_report_low_coverage() -> None:
    """Eight frontal frames are not a 360° capture.

    A naive min/max span would call this wide; the user's back would then be
    entirely hallucinated while the UI claimed good coverage.
    """
    frames = [_frame(i, 2.0 * i) for i in range(8)]
    assert _coverage_degrees(frames) < 120.0


def test_coverage_needs_at_least_two_views() -> None:
    assert _coverage_degrees([_frame(0, 0.0)]) == 0.0
    assert _coverage_degrees([_frame(0, None), _frame(1, None)]) == 0.0
