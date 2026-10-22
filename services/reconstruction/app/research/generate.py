"""CLI: generate the synthetic body-measurement dataset.

  python -m app.research.generate --n 2000 --out <repo>/.data/research/synth
  python -m app.research.generate --calibrate      # sanity-check distribution

Outputs per sample: frontal.png, lateral.png (silhouettes), shaded.png,
and a row in measurements.csv + a JSONL manifest. Split into train/val/test.
"""

from __future__ import annotations

import argparse
import csv
import json
import pathlib

import numpy as np

from . import synth_data as S
from .measurements import BodyMeasurements

_FIELDS = list(BodyMeasurements.__annotations__.keys())
_SEXES = ["FEMALE", "MALE", "UNSPECIFIED"]


def calibrate(n: int = 400) -> None:
    """Report synthetic measurement distribution vs real adult reference means,
    so we can see the sim matches reality before training on it."""
    rng = np.random.default_rng(0)
    rows = [S.make_sample(rng, _SEXES[i % 3], size=64)["measurements"] for i in range(n)]
    ref = {  # approximate mixed-sex adult means (cm), public anthropometric ranges
        "height": 170, "chest": 96, "waist": 86, "hip": 100,
        "thigh": 56, "calf": 37, "ankle": 22, "bicep": 31, "wrist": 16,
    }
    print(f"\n  Synthetic distribution over {n} samples (mean ± sd)  [ref = real adult mean]\n")
    for k in _FIELDS:
        vals = np.array([r[k] for r in rows if r.get(k) is not None], dtype=float)
        if len(vals) == 0:
            continue
        tag = f"  [ref ~{ref[k]}]" if k in ref else ""
        print(f"    {k:20} {vals.mean():6.1f} ± {vals.std():4.1f}{tag}")
    print()


def generate(n: int, out: pathlib.Path, size: int, seed: int) -> None:
    rng = np.random.default_rng(seed)
    import cv2

    # Deterministic split: 80/10/10.
    splits = (["train"] * 8 + ["val"] + ["test"])
    out.mkdir(parents=True, exist_ok=True)
    manifest = (out / "manifest.jsonl").open("w", encoding="utf-8")
    csv_f = (out / "measurements.csv").open("w", newline="", encoding="utf-8")
    writer = csv.writer(csv_f)
    writer.writerow(["id", "split", "sex", "metric_scale", *_FIELDS])

    for i in range(n):
        split = splits[i % 10]
        sex = _SEXES[i % 3]
        sample = S.make_sample(rng, sex, size=size)
        sid = f"{i:06d}"
        d = out / split / sid
        d.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(d / "frontal.png"), sample["frontal"])
        cv2.imwrite(str(d / "lateral.png"), sample["lateral"])
        cv2.imwrite(str(d / "shaded.png"), sample["shaded"][:, :, ::-1])
        meas = sample["measurements"]
        (d / "meta.json").write_text(
            json.dumps({"id": sid, "split": split, "sex": sex,
                        "metric_scale": sample["metric_scale"],
                        "shape": sample["shape"], "measurements": meas}, indent=2),
            encoding="utf-8",
        )
        manifest.write(json.dumps({"id": sid, "split": split, "sex": sex,
                                   "frontal": f"{split}/{sid}/frontal.png",
                                   "lateral": f"{split}/{sid}/lateral.png",
                                   "measurements": meas}) + "\n")
        writer.writerow([sid, split, sex, sample["metric_scale"],
                         *[meas.get(f) for f in _FIELDS]])
        if (i + 1) % max(1, n // 20) == 0:
            print(f"  {i+1}/{n}")

    manifest.close(); csv_f.close()
    print(f"\n  wrote {n} samples to {out}")
    print(f"  splits: {sum(1 for j in range(n) if splits[j%10]=='train')} train / "
          f"{sum(1 for j in range(n) if splits[j%10]=='val')} val / "
          f"{sum(1 for j in range(n) if splits[j%10]=='test')} test")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=1000)
    ap.add_argument("--out", type=str, default=str(pathlib.Path(__file__).resolve().parents[4] / ".data" / "research" / "synth"))
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--calibrate", action="store_true")
    a = ap.parse_args()
    if a.calibrate:
        calibrate()
    else:
        generate(a.n, pathlib.Path(a.out), a.size, a.seed)


if __name__ == "__main__":
    main()
