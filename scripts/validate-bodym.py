"""Measure the scan engine's accuracy against BodyM ground truth.

BodyM (Amazon, CC BY-NC 4.0) pairs real people's front and side silhouettes
with tape measurements. It is used here for *evaluation only* — nothing in the
engine is fitted to it (docs/research/README.md §3). Each subject's recorded
height plays the role of the height a user types into the app.

Usage (from the repo root):
    services\\reconstruction\\.venv\\Scripts\\python.exe scripts\\validate-bodym.py
    ... --pose      also run the joint detector on the silhouettes
    ... --write     update app/scan/accuracy.json and docs/validation/

Outputs per-measurement MAE, median error, bias and hit-rates within 2/4 cm.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from datetime import date
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "services" / "reconstruction"))
sys.stdout.reconfigure(encoding="utf-8")

from app.scan import measure as M  # noqa: E402
from app.scan import pose as P  # noqa: E402

DATA = ROOT / ".data" / "bodym" / "testA"

# Our measurement → BodyM column.
MAPPING = {
    "chest": "chest",
    "waist": "waist",
    "hip": "hip",
    "thigh": "thigh",
    "calf": "calf",
    "shoulder_width": "shoulder-breadth",
    "arm_length": "arm-length",
    "inseam": "leg-length",
    "torso_length": "shoulder-to-crotch",
}

# Compared and printed, but not published as a typical error: BodyM's
# shoulder-to-crotch starts from a different shoulder landmark than our
# garment-industry torso length (high shoulder point), so its error measures
# the definition gap, not the engine.
NOT_COMPARABLE = {"torso_length": "BodyM shoulder-to-crotch uses a different shoulder landmark"}


def read_csv(name: str) -> list[dict]:
    with open(DATA / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def silhouette_pose(mask: np.ndarray) -> P.PoseResult | None:
    """Run the joint detector on a silhouette rendered as a grey figure."""
    img = np.full((*mask.shape, 3), 235, np.uint8)
    img[mask > 0] = (90, 90, 90)
    res = P.detect(img, refine=False)
    if not res.detected:
        return None
    return P.PoseResult(landmarks=res.landmarks, mask=mask, image_shape=mask.shape)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pose", action="store_true")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    if not DATA.exists():
        sys.exit(f"BodyM test split not found at {DATA}")

    photo_to_subject = {r["photo_id"]: r["subject_id"] for r in read_csv("subject_to_photo_map.csv")}
    truth = {r["subject_id"]: r for r in read_csv("measurements.csv")}
    hwg = {r["subject_id"]: r for r in read_csv("hwg_metadata.csv")}

    errors: dict[str, list[float]] = {k: [] for k in MAPPING}
    seen, failed, posed = 0, 0, 0
    started = time.perf_counter()

    for mask_path in sorted((DATA / "mask").glob("*.png")):
        pid = mask_path.stem
        sid = photo_to_subject.get(pid)
        side_path = DATA / "mask_left" / mask_path.name
        if sid is None or sid not in truth or sid not in hwg or not side_path.exists():
            continue
        seen += 1
        front = (cv2.imread(str(mask_path), 0) > 127).astype(np.uint8) * 255
        side = (cv2.imread(str(side_path), 0) > 127).astype(np.uint8) * 255
        front, side = P.largest_component(front), P.largest_component(side)

        pose = silhouette_pose(front) if args.pose else None
        posed += pose is not None
        try:
            views = {
                "front": M.ViewData("front", front, pose),
                "left": M.ViewData("left", side),
            }
            meas = M.extract(views, float(hwg[sid]["height_cm"]))
        except ValueError:
            failed += 1
            continue

        for ours, theirs in MAPPING.items():
            if ours in meas:
                errors[ours].append(meas[ours].value - float(truth[sid][theirs]))

    elapsed = time.perf_counter() - started
    rows = {}
    print(f"\nBodyM testA · {seen} subjects · {failed} failed · pose on {posed} · {elapsed:.1f}s\n")
    print(f"{'measurement':<16}{'n':>4}{'MAE':>8}{'median':>8}{'bias':>8}{'≤2cm':>7}{'≤4cm':>7}")
    for k, e in errors.items():
        if not e:
            continue
        a = np.abs(np.array(e))
        rows[k] = {
            "n": len(e),
            "mae_cm": round(float(a.mean()), 2),
            "median_abs_cm": round(float(np.median(a)), 2),
            "bias_cm": round(float(np.mean(e)), 2),
            "within_2cm": round(float((a <= 2).mean()), 3),
            "within_4cm": round(float((a <= 4).mean()), 3),
        }
        r = rows[k]
        print(f"{k:<16}{r['n']:>4}{r['mae_cm']:>8.2f}{r['median_abs_cm']:>8.2f}{r['bias_cm']:>+8.2f}"
              f"{r['within_2cm']:>7.0%}{r['within_4cm']:>7.0%}"
              + ("   (definition differs — not published)" if k in NOT_COMPARABLE else ""))

    if args.write:
        report = {
            "dataset": "BodyM testA (front + left silhouettes, tape-measured ground truth)",
            "date": date.today().isoformat(),
            "subjects": seen,
            "failed": failed,
            "poseOnSilhouettes": bool(args.pose),
            "views": "2 of 4 (front, left) — BodyM has no back/right views",
            "measurements": {k: v for k, v in rows.items() if k not in NOT_COMPARABLE},
            "notComparable": {k: {**rows[k], "reason": why} for k, why in NOT_COMPARABLE.items() if k in rows},
        }
        acc = ROOT / "services" / "reconstruction" / "app" / "scan" / "accuracy.json"
        acc.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"\nwrote {acc.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
