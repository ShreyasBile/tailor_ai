# 07 — Body Intelligence MVP

The seven-day plan's product loop, built end to end on this repo:

```
basic details → 4 photos → validation → measurement → 3D body → Body Profile
             → select garment → size recommendation → fit score + explanation → feedback
```

Everything runs locally on a laptop CPU (no GPU required). Start it with
`npm run stack:start` and open **http://localhost:3001**.

---

## 1. Definition of Done — status

| Plan requirement (§12) | Status | Where |
|---|---|---|
| Account/profile with height and basic details | ✅ | `/onboarding` — height (cm or ft/in), weight, sex, fit preference, biometric consent |
| Upload/capture four controlled photos | ✅ | `/scan` — front/back/left/right slots with drawn pose guides, drag-drop or phone camera; photos normalised in-browser (EXIF rotation, 2048 px, JPEG) |
| Reject obviously bad scans | ✅ | `app/scan/quality.py` — 16 checks (resolution, exposure, blur, framing, distance, person, clutter, wrong view, pose), each with a fix-it message; rejected photos are flagged individually and can be retaken alone |
| Usable 3D body representation | ✅ | Parametric body fitted to the measured girths (`app/scan/body_fit.py`), exported as GLB, exact stature |
| ≥ 10 body measurements | ✅ | 11: height, chest, waist, hip, shoulder width, inseam, thigh, arm length, neck, torso length, calf |
| Measurements in a persistent Body Profile | ✅ | `body_measurements` table, versioned with the BodyCore; `/profile` |
| Rotate and inspect the 3D model | ✅ | React Three Fiber viewer: orbit, zoom, auto-rotate; selecting a measurement draws it on the body (ring / span / bracket) |
| Select a sample garment | ✅ | `/shop` — 16 garments, 4 brands, 9 size charts |
| Fit engine returns size + score | ✅ | `app/fit/engine.py` — size, 0–100 fit score, per-dimension verdicts, explanation, between-sizes, confidence |
| Whole journey from a fresh session | ✅ | `npm run test:mvp` — 21 assertions from a brand-new account |
| Deployed and demonstrable | ⚠️ local | Runs as a local stack (Docker infra + 4 processes). No cloud deployment — see §8 |
| Documented accuracy and limitations | ✅ | §5 and §7 below; `app/scan/accuracy.json` |

## 2. What runs where

| Concern | Owner (plan §3) | Code |
|---|---|---|
| Person detection, pose, matte | AI/ML | `services/reconstruction/app/scan/pose.py` — MediaPipe Pose *heavy* (Apache-2.0), GrabCut edge refinement |
| Scan quality gate | AI/ML | `app/scan/quality.py` |
| Measurement engine | AI/ML | `app/scan/measure.py` |
| 3D body fit | AI/ML | `app/scan/body_fit.py` |
| Fit engine | AI/ML | `app/fit/engine.py` |
| Validation | AI/ML | `scripts/validate-bodym.py` |
| Pipeline integration | Full-stack | `services/orchestrator` — new stage `S3B_SCAN_ANALYZE` |
| API: scans, measurements, catalogue, recommendations, feedback | Full-stack | `apps/api` — `catalog` module, `GET /me/measurements` |
| Data model | Full-stack | `apps/api/prisma/schema.prisma` — `BodyMeasurement`, `Brand`, `SizeChart(+Entry)`, `Garment`, `Recommendation`, `FitFeedback` |
| Web app | Full-stack | `apps/web` — Next.js 15, Tailwind, React Three Fiber |

### Interface contract (plan §7)

The CV service exposes the plan's contract verbatim as `POST /process-scan`
(`scan_id`, `height_cm`, `images.{front,back,left,right}` as URLs or data URIs →
`status`, `body_model`, `measurements.*_cm`, `confidence.overall`, `issues`). The
product path uses the richer `POST /scan/analyze`, called by the orchestrator,
which also returns per-view quality and per-measurement confidence. Size
recommendations go through `POST /fit/recommend`.

## 3. The model choice, and why it isn't HMR2.0/SMPL

The plan suggests HMR2.0 / 4D-Humans / U-HMR. All of them output **SMPL**, whose
licence forbids commercial use — this repo's licence gate (ADR-2,
`packages/model-registry`) blocks SMPL-derived models in production builds. The
project's chosen commercial model, SAM 3D Body, needs 8 GB of VRAM; this machine
has a 4 GB GTX 1650.

So the MVP uses a pretrained, commercially-licensed **2-D** model (MediaPipe Pose:
detection + 33 keypoints + person segmentation, CPU) and does the 3-D work
geometrically:

1. **Scale** each view from the user's height (cm per pixel, per view).
2. **Locate** measurement heights from detected joints and silhouette landmarks
   (shoulder line, armpit line, crotch notch) — not fixed ratios.
3. **Measure** widths from front/back and depths from left/right; girth = ellipse
   perimeter × an ANSUR II cross-section shape factor (chest 1.10, waist/hip 1.065).
4. **Fit** the parametric body to the measured chest, waist and hip, so the 3D
   model the user rotates agrees with the numbers beside it.

Swapping in SAM 3D Body later changes step 4's input, not the product: the
`/scan/analyze` response, storage and UI stay the same.

## 4. Fit engine (plan §10)

Rules and scoring, deliberately transparent:

* For each size and each relevant dimension (category-weighted: tops lean on
  chest/shoulders, bottoms on waist/hip/inseam, dresses on chest/waist/hip), find
  where the body sits in that size's range versus where it *should* sit.
* "Should" shifts with the user's preference (snug 0.72 → loose 0.25 of the range),
  the garment's cut (slim aims lower, oversized higher) and stretch (adds
  tolerance on the tight side only).
* Score the gap with an asymmetric curve — tight hurts sooner than loose; a
  critical dimension that won't fit caps the size at 45.
* Output: size, fit score, label, alternative size, "between sizes" flag,
  confidence (measurement confidence × score separation), per-dimension verdicts
  and a plain-English explanation.

Every recommendation is stored with its full output, and `FitFeedback`
(perfect / too small / too large / kept / returned) is the training signal for
replacing the rules with a learned model.

## 5. Measured accuracy (plan §11)

Evaluated on **BodyM testA**: 87 real people, front + side silhouettes,
tape-measured ground truth, their recorded height as the scale anchor. BodyM is
CC BY-NC — used for evaluation only; nothing is fitted to it.

| Measurement | MAE (cm) | Median (cm) | Bias (cm) | ≤ 2 cm | ≤ 4 cm |
|---|---|---|---|---|---|
| Waist | 3.27 | 1.89 | −0.32 | 52% | 70% |
| Inseam (vs. leg length) | 2.59 | 2.10 | +0.91 | 48% | 83% |
| Calf | 1.95 | 1.97 | −1.28 | 53% | 94% |
| Hip | 3.31 | 2.45 | +0.64 | 40% | 72% |
| Shoulder width | 3.31 | 3.25 | +3.03 | 17% | 70% |
| Arm length | 3.56 | 3.22 | +3.37 | 22% | 68% |
| Chest | 5.23 | 3.83 | −0.86 | 33% | 51% |
| Thigh | 5.89 | 5.16 | −2.20 | 21% | 33% |
| Torso length | — | — | — | — | — |

Reproduce with `npm run validate:bodym`.

**Read these numbers correctly:**

* They use **2 of the 4 views** (BodyM has no back/right photos) and joints detected
  on **silhouettes**, not photos — the joint detector is worse there (it places
  shoulders and hips ~5% of stature low). Real four-photo scans should do at least
  as well; that has not been measured yet.
* Torso length is not comparable: BodyM's shoulder-to-crotch starts from a
  different shoulder landmark than our garment-industry definition (high point of
  shoulder), so it is excluded from the published typical errors.
* Commercial body scanners and tape measurement by different people typically
  disagree by 1–3 cm on girths. Waist, hip, inseam and calf are near that; chest
  and thigh are not yet.
* Girths outside the plausible human range for the user's height (e.g. a neck
  over 25% of stature) keep their value but have confidence cut and carry a
  note — usually loose clothing or hair over the neck.

These MAEs are shown in the app as each measurement's "± typical error".

## 6. Demo script

1. `npm run stack:start` → http://localhost:3001
2. **Create my Body Profile** → sign in with any email → height **172 cm** → consent.
3. On **/scan**, click *Try a sample scan* (or upload four real photos) → **Measure my body**.
   Watch the four phases complete (~20 s).
4. **Body Profile**: rotate the model; click *Chest*, *Waist*, *Inseam* to see where
   each was measured; note confidence and ± error per card; toggle cm/in.
5. **Shop** → *Oxford Button-Down* → **Find my size** → read the explanation and the
   per-dimension bars → switch *Snug / Loose* and watch the size move.
6. Open *Straight Selvedge Jean* — same body, different brand, sized by waist, hip and inseam.
7. Show rejection: rescan with one photo replaced by a blank or cropped image — the
   job fails with a note on exactly that photo, and *Retake photos* returns to the
   scan page with only that slot flagged.

Automated: `npm run test:mvp` runs the same journey (21 checks).

## 7. Known limitations

1. **No real four-photo validation yet.** The plan's Day 7 asks for 10–20 test scans
   with tape measurements. The engine and the error metrics exist
   (`validate-bodym.py`); a loader for a folder of real scans + tape measurements,
   and the scans themselves, do not yet.
2. **The 3D body is a fitted parametric mannequin**, not a reconstructed surface. It
   matches stature and torso girths; it does not capture posture, muscle shape or
   clothing. Replace with SAM 3D Body (8 GB GPU) for a true reconstruction.
3. **Thigh and chest are the weakest measurements** (MAE 5–6 cm). Thigh suffers when
   the inner thighs touch; chest when arms rest against the torso. Both lower the
   reported confidence, which the fit engine weighs.
4. **Clothing matters.** Loose clothing inflates every girth; the quality gate cannot
   yet detect it. The scan page asks for fitted clothing.
5. **Size charts are invented** (realistic, but not real brands). Production needs
   real brand charts, and garment measurements for ease-aware fitting.
6. **The fit engine is rules, not learned.** Feedback is being stored to train one.
7. **Sample scan is a render**, useful for demos only — never for accuracy claims.
8. **Not deployed to the cloud.** Local auth (`AUTH_PROVIDER=local`) accepts any
   email and must be replaced (Clerk/Supabase) before any external user.

## 8. Cut list status (plan §13)

Video scanning, body-shape classification, advanced animations, analytics and an
ML fit model were all left out, as planned. Nothing outside the
photos → 3D → measurements → fit loop was added.
