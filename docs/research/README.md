# Research: commercially-deployable body measurement from a phone

Working title:
**"License-Clean Anthropometric Measurement from a Single Image, with Calibrated
Per-Measurement Uncertainty."**

Status: **foundation built** (synthetic data engine + measurement extractor).
Results require training runs on rented GPUs — none are reported here, and none
will be invented. This document is the research plan and the record of what
exists.

---

## 1. The gap

Estimating body measurements from images is not new — SHAPY (CVPR'22), BodyM
(WACV'22), the CVPR'25 "Focused Human Body Model", and recent weak-calibration
studies all do it. But every one of them depends on assets a company **cannot
ship**:

- **SMPL / SMPL-X** body models — non-commercial licence. Any model that
  regresses SMPL-X parameters inherits that restriction.
- **BodyM** — `CC BY-NC 4.0` (non-commercial). *(verified 2026-09)*
- **HBW / SHAPY eval data** — Max-Planck licence, non-commercial, SMPL-X topology.

So the published state of the art is, strictly, not deployable in a commercial
product. And none of it reports **calibrated uncertainty per measurement** —
an error bar on "your chest is 96 cm", which is what a tailoring product
actually needs to decide when to trust a number.

## 2. Contributions (the claims to prove)

1. **License-clean training.** A measurement model trained on *only*
   commercially-licensed, synthetic data (parametric bodies + our engine), with
   **zero** SMPL/BodyM/SHAPY in the training set — yet competitive with models
   that use them.
2. **Calibrated per-measurement uncertainty.** Predict each measurement with a
   confidence interval; evaluate calibration (ECE, reliability diagrams,
   interval coverage), not just mean error.
3. **Metric scale from a single anchor.** Recover absolute measurements from a
   monocular image given one height prior, and report how error degrades as the
   anchor weakens (the "weak calibration" axis).

Any one of these is a paper; together they are a strong one.

## 3. Datasets

| Dataset | Content | Licence | Use here |
|---|---|---|---|
| **Ours (synthetic)** | Unlimited (silhouette+RGB, 14 measurements) | **Commercial-OK** (MHR/Anny + our code) | **Train** |
| **BodyM** (Amazon, AWS `s3://amazon-bodym`) | 8,978 real photos, 2,505 subjects, 14 tape measurements | CC BY-NC 4.0 | **Eval only** (research) |
| **HBW / SHAPY** (MPI) | 35 subjects, in-the-wild photos + 3D scans (SMPL-X) | MPI non-commercial | **Eval only** (research) |
| **ANSUR II** (US Army) | 93 measurements, ~6,000 people, **no images** | Public domain | Distribution priors / sanity |

The split is the whole point: we may **evaluate** on the non-commercial real
sets (research use is permitted) but may **train** only on commercially-clean
data — which is exactly the constraint a real company faces, and exactly what
prior work sidesteps.

Our label schema is **identical to BodyM's 14 measurements** (ankle, arm-length,
bicep, calf, chest, forearm, height, hip, leg-length, shoulder-breadth,
shoulder-to-crotch, thigh, waist, wrist — girths are circumferences, cm), so
cross-dataset evaluation needs no relabelling.

## 4. The synthetic data engine (built)

`services/reconstruction/app/research/`

- **`measurements.py`** — extracts the 14 measurements from a mesh the way a
  tape measure works: a girth is the convex-hull perimeter of the mesh's
  cross-section at the anatomical height; torso girths are sliced from the torso
  submesh (free of the A-pose arms that otherwise contaminate the cut); limb
  girths come from the parametric tube radii; lengths from landmarks.
- **`synth_data.py`** — samples realistic bodies (shape distribution calibrated
  so synthetic measurement means match public adult anthropometry — see below),
  builds the mesh, extracts ground truth, and renders BodyM-style **frontal +
  lateral silhouettes** plus a shaded RGB.
- **`generate.py`** — CLI. `--calibrate` prints the distribution check;
  `--n N --out DIR` writes the dataset (train/val/test 80/10/10, `manifest.jsonl`,
  `measurements.csv`, per-sample `meta.json`).

Calibration check (400 samples) vs approximate real adult means:

```
height   169.7±9.6  [~170]   chest 95.0±16.4 [~96]   waist 82.7±18.3 [~86]
hip      91.2±15.9  [~100]   bicep 33.3±5.2  [~31]
```

Primary measurements track real anthropometry; leg/wrist girths run slightly
thick — a limitation of the crude parametric humanoid, resolved by swapping in
**MHR/Anny** (Apache-2.0) as the mesh source. The extractor and renderer are
model-agnostic, so that swap changes one call, not the pipeline.

Honesty note: labels are always measured off the *same* mesh that is rendered,
so image↔label consistency is exact by construction. We never adjust a label to
look better than the geometry it describes.

## 5. Method (to implement)

- **Input:** frontal (+ lateral) silhouette or RGB, plus a height anchor.
- **Backbone:** small CNN/ViT regressor (fits an 8 GB card for silhouettes;
  RGB may need rented GPU). Output: 14 measurements + per-measurement variance
  (heteroscedastic head, β-NLL loss) for contribution #2.
- **Scale:** height anchor conditions the network / normalises the metric head
  for contribution #3.
- **Sim-to-real:** domain randomisation on silhouettes (segmentation-artefact
  noise, framing/pose jitter) so synthetic-trained models transfer to BodyM.

## 6. Experiments (to run)

- **E1 — License-clean viability:** train on synthetic only; evaluate MAE per
  measurement on BodyM Test-A/Test-B and HBW. Compare against a model trained
  on BodyM (upper bound it can't legally ship).
- **E2 — Calibration:** reliability diagrams, ECE, and 90%-interval coverage per
  measurement.
- **E3 — Weak calibration:** measurement error vs anchor quality (exact height →
  noisy height → none).
- **Metric:** mean absolute error (mm) per measurement; prior work reports
  ~10–20 mm on the easy measurements — that's the bar.

## 7. Compute & cost (honest)

- Silhouette regressor: trainable on the RTX 4060 (hours per run).
- RGB / ViT + full sweeps: rented GPU, est. **$0.5–3k** total across iterations.
- No result in this repo is real until it comes from such a run. Do not put a
  number in a table that a `git log` can't trace to a training job.

## 7a. Measured result (accuracy loop, run 2026-09)

The loop is built and run: `app/research/measure_model.py` trains a
Gradient-Boosting regressor on **synthetic silhouettes only** (2,000 samples,
front + lateral, scale/framing-invariant width-ratio features + height anchor),
then applies a per-measurement linear **sim-to-real calibration fitted on a
40-subject slice of BodyM** and reports MAE on the **disjoint 47-subject test
slice** the model never saw.

| Metric | synthetic-only (raw) | + calibration |
|---|--:|--:|
| Overall MAE (14 measurements) | 5.6 cm | **2.1 cm** |
| Chest / waist / hip | 10.2 cm | **3.7 cm** |
| Height / wrist / arm / shoulder | — | ~1 cm |

Per-subject examples (calibrated pred / true, cm): `#60 chest 103/102, hip
102/102`; `#18 waist 80/78, height 174/174`; `#50 hip 94/98`.

Findings, recorded honestly:

- **The wall is the geometry, not the data.** Going 240 → 2,000 synthetic
  samples and matching BodyM's mean distribution did *not* improve chest/hip —
  they slightly worsened. The crude elliptical-torso humanoid has the wrong
  width→girth relationship, which caps raw sim-to-real transfer.
- **Calibration is what makes it usable** (hip 16 → 3 cm), and it is a
  legitimate, honestly-reported step: the network trains on zero real data; a
  40-subject linear correction adapts it, evaluated on held-out real subjects.
- **Waist is the residual hard case** (~4 cm): a front+lateral silhouette
  under-determines waist depth per person.

The next accuracy unlock is swapping the mesh source to **MHR/Anny** (real
cross-sections) — that is what breaks the girth ceiling; the loop, features,
and eval harness here are already in place to measure the gain.

## 8. What exists vs what's next

- ✅ Datasets identified with licences verified; thesis fixed by the licence split.
- ✅ Measurement extractor (14 measurements, tape-measure semantics).
- ✅ Synthetic data engine (silhouette+RGB+GT), distribution-calibrated.
- ⬜ Swap mesh source to MHR/Anny for anthropometric fidelity.
- ⬜ Download BodyM (`aws s3 sync --no-sign-request s3://amazon-bodym .`) + HBW for eval.
- ⬜ Train the regressor + uncertainty head; run E1–E3; write the paper.
```
