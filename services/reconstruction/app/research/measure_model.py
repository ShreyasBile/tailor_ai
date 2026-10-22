"""Silhouette -> body-measurement model, with honest cross-domain evaluation.

The accuracy loop the product actually needs:
  train  on our SYNTHETIC silhouettes (commercially clean, unlimited)
  test   on BodyM's REAL silhouettes + REAL tape measurements (research eval)
  report MAE in cm per measurement — accuracy as a number, not a vibe.

Features are deliberately scale- and framing-invariant (width/depth *ratios*
at normalised heights), so a model trained on 256px renders transfers to
BodyM's 960px real masks. The subject's height is passed as the metric anchor.
"""

from __future__ import annotations

import csv
import glob
import json
import os

_DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), *[".."] * 4, ".data")

import cv2
import numpy as np

MEAS = [
    "ankle", "arm_length", "bicep", "calf", "chest", "forearm", "height",
    "hip", "leg_length", "shoulder_breadth", "shoulder_to_crotch", "thigh",
    "waist", "wrist",
]
# BodyM uses hyphens; map to our underscore keys.
BODYM_KEY = {m: m.replace("_", "-") for m in MEAS}

N_LEVELS = 28
_LEVELS = np.linspace(0.04, 0.96, N_LEVELS)


def _silhouette_features(mask: np.ndarray) -> np.ndarray:
    """Width ratios at N normalised heights: total-row and central-run, each
    divided by pixel body-height (so resolution/framing drop out)."""
    fg = mask > 127
    ys, xs = np.nonzero(fg)
    if len(ys) < 50:
        return np.zeros(N_LEVELS * 2, dtype=np.float32)
    top, bottom = ys.min(), ys.max()
    hpx = max(1, bottom - top)
    cx = int(np.median(xs))

    total = np.zeros(N_LEVELS, np.float32)
    central = np.zeros(N_LEVELS, np.float32)
    for i, f in enumerate(_LEVELS):
        row = int(bottom - f * hpx)
        row = int(np.clip(row, 0, mask.shape[0] - 1))
        line = fg[row]
        cnt = int(line.sum())
        total[i] = cnt / hpx
        # central contiguous run through the body centre → isolates the torso
        # / central limb, excluding arms that sit away from the centreline.
        if line[min(cx, len(line) - 1)]:
            l = cx
            while l > 0 and line[l - 1]:
                l -= 1
            r = cx
            while r < len(line) - 1 and line[r + 1]:
                r += 1
            central[i] = (r - l + 1) / hpx
    return np.concatenate([central, total])


def features(frontal_path: str, lateral_path: str, height_cm: float) -> np.ndarray:
    f = cv2.imread(frontal_path, 0)
    l = cv2.imread(lateral_path, 0)
    if f is None or l is None:
        return np.zeros(N_LEVELS * 4 + 1, np.float32)
    ff = _silhouette_features(f)
    lf = _silhouette_features(l)
    return np.concatenate([ff, lf, [height_cm / 100.0]]).astype(np.float32)


def load_synth(root=os.path.join(_DATA_ROOT, "research", "synth")) -> tuple[np.ndarray, np.ndarray]:
    X, Y = [], []
    for meta_path in glob.glob(f"{root}/*/*/meta.json"):
        d = json.load(open(meta_path))
        base = os.path.dirname(meta_path)
        m = d["measurements"]
        y = [m.get(k) for k in MEAS]
        if any(v is None for v in y):
            continue
        X.append(features(f"{base}/frontal.png", f"{base}/lateral.png", m["height"]))
        Y.append(y)
    return np.array(X, np.float32), np.array(Y, np.float32)


def load_bodym(root=os.path.join(_DATA_ROOT, "bodym", "testA")) -> tuple[np.ndarray, np.ndarray, list]:
    meas = {r["subject_id"]: r for r in csv.DictReader(open(f"{root}/measurements.csv"))}
    hwg = {r["subject_id"]: r for r in csv.DictReader(open(f"{root}/hwg_metadata.csv"))}
    s2p: dict[str, str] = {}
    for r in csv.DictReader(open(f"{root}/subject_to_photo_map.csv")):
        s2p.setdefault(r["subject_id"], r["photo_id"])

    X, Y, sids = [], [], []
    for sid, pid in s2p.items():
        fp, lp = f"{root}/mask/{pid}.png", f"{root}/mask_left/{pid}.png"
        if not (os.path.exists(fp) and os.path.exists(lp) and sid in meas and sid in hwg):
            continue
        h = float(hwg[sid]["height_cm"])
        X.append(features(fp, lp, h))
        Y.append([float(meas[sid][BODYM_KEY[k]]) for k in MEAS])
        sids.append(sid)
    return np.array(X, np.float32), np.array(Y, np.float32), sids


def train_and_eval(model_kind: str = "gbr", calibrate: bool = True, n_cal: int = 40) -> dict:
    from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
    from sklearn.multioutput import MultiOutputRegressor

    Xtr, Ytr = load_synth()
    Xbm, Ybm, _ = load_bodym()
    if len(Xtr) < 20 or len(Xbm) < 10:
        raise SystemExit("not enough data")

    # Split the REAL set: a small calibration slice for sim-to-real correction,
    # and a disjoint test slice for the reported number. The model itself never
    # trains on real data — calibration is a per-measurement linear correction
    # only, and it is measured on subjects it never saw.
    rng = np.random.default_rng(0)
    perm = rng.permutation(len(Xbm))
    cal, test = perm[:n_cal], perm[n_cal:]
    print(f"  train synthetic {Xtr.shape}   |   BodyM calib {len(cal)}  test {len(test)}")

    if model_kind == "rf":
        model = RandomForestRegressor(n_estimators=400, n_jobs=-1, random_state=0)
    else:
        model = MultiOutputRegressor(
            GradientBoostingRegressor(n_estimators=300, max_depth=3, learning_rate=0.05,
                                      subsample=0.8, random_state=0)
        )
    model.fit(Xtr, Ytr)
    pred = model.predict(Xbm)

    raw = np.abs(pred[test] - Ybm[test]).mean(axis=0)

    calmae = raw
    if calibrate:
        adj = pred.copy()
        for j in range(len(MEAS)):
            # least-squares a*pred+b on the calibration slice only
            a, b = np.polyfit(pred[cal, j], Ybm[cal, j], 1)
            adj[:, j] = a * pred[:, j] + b
        calmae = np.abs(adj[test] - Ybm[test]).mean(axis=0)

    print(f"\n  MAE on held-out BodyM ({model_kind}, cm)   raw -> calibrated:\n")
    order = sorted(range(len(MEAS)), key=lambda i: calmae[i])
    for i in order:
        print(f"    {MEAS[i]:20} {raw[i]:5.1f} -> {calmae[i]:5.1f}   (true avg {Ybm[test, i].mean():5.1f})")
    # Concrete per-subject check on real people (calibrated).
    if calibrate:
        show = ["chest", "waist", "hip", "thigh", "height"]
        print("\n  Example real subjects (calibrated pred vs true, cm):")
        for k in test[:3]:
            row = " ".join(
                f"{m}:{(np.polyval(np.polyfit(pred[cal, MEAS.index(m)], Ybm[cal, MEAS.index(m)],1), pred[k, MEAS.index(m)])):.0f}/{Ybm[k, MEAS.index(m)]:.0f}"
                for m in show)
            print(f"    #{k:3d}  {row}")
    key = ["chest", "waist", "hip"]
    kraw = np.mean([raw[MEAS.index(k)] for k in key])
    kcal = np.mean([calmae[MEAS.index(k)] for k in key])
    print(f"\n  overall {raw.mean():.1f} -> {calmae.mean():.1f} cm   |   "
          f"chest/waist/hip {kraw:.1f} -> {kcal:.1f} cm")
    return {"overall_raw": float(raw.mean()), "overall_cal": float(calmae.mean()),
            "key_raw": float(kraw), "key_cal": float(kcal)}


if __name__ == "__main__":
    import sys
    train_and_eval(sys.argv[1] if len(sys.argv) > 1 else "gbr")
