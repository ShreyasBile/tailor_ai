# TailorAI — AI Pipeline

> Model research, comparison, selection rationale, and the stage-by-stage reconstruction pipeline.

---

## 1. Model landscape (researched 2026-08-07)

### 1.1 The licensing wall

Before accuracy, licensing. Nearly every published human-reconstruction method is built on
**SMPL / SMPL-X** from Max Planck. Its terms:

- Non-commercial. Production use requires a paid sub-license from Meshcapade.
- The license **also forbids training neural networks for commercial use** — so a model
  *trained against* SMPL is contaminated, not just a model that ships SMPL.
- Pricing was never public; it is a negotiation.
- **Epic Games acquired Meshcapade in Feb 2026** (closing April), so future terms are unknown.

This eliminates, for a commercial product: **ECON, ICON, SIFU, SiTH, PSHuman, LHM, SHAPY,
CameraHMR, NLF, SMPLest-X** — i.e. essentially the entire visible leaderboard.

Two Apache-2.0 parametric body models emerged in late 2025 specifically to break this wall:

- **MHR** (Momentum Human Rig, Meta) — Apache 2.0. 18,439 verts, 127 joints, 45 shape
  coefficients. Decouples skeleton from surface shape.
- **Anny** (NAVER Labs Europe) — Apache 2.0, `pip install anny`, no gated download.
  13,718 verts, 163 bones, **11 interpretable phenotype parameters** (gender, age, height,
  weight, muscle, cup size) + 256 local blendshapes, calibrated against WHO population data.

### 1.2 Reconstruction method comparison

Quantitative figures below are as reported in the LHM paper's comparison table (single-view
novel-view synthesis); they are directionally useful, not a controlled benchmark.

| Method | PSNR | SSIM | Body model | License | VRAM | Verdict |
|---|---|---|---|---|---|---|
| **SAM 3D Body** (Meta, CVPR'26) | — | — | **MHR** | **SAM License — commercial OK** | ~4–5 GB | ✅ **Chosen** |
| SIFU | 16.68 | 0.917 | SMPL-X | Non-commercial | ~16 GB | ❌ License |
| PSHuman (CVPR'25) | 17.56 | 0.921 | SMPL-X | Non-commercial | **>40 GB** @768 | ❌ License + VRAM |
| LHM-0.5B | **25.18** | **0.951** | SMPL-X | Non-commercial | ~12–16 GB | ❌ License + VRAM |
| ECON | — | — | SMPL-X | Non-commercial | ~12 GB | ❌ License; weak texture |
| SiTH (CVPR'24) | — | — | SMPL-X | Non-commercial | ~16 GB | ❌ License |
| TRELLIS / TripoSR | — | — | none (generic object) | MIT | ~8–16 GB | ⚠️ Fallback only — no body prior |

LHM's numbers are clearly the strongest, and it is worth being honest that we are **not**
choosing the highest-scoring model. We are choosing the best model we can legally ship and
actually run. Note also that PSNR/SSIM on novel-view synthesis rewards *photorealistic
appearance*, not *metric body accuracy* — which is the thing our product is actually for.
LHM's lead is largely a lead at rendering, and rendering is our disposable layer.

### 1.3 Verified license grant for the chosen model

From `facebookresearch/sam-3d-body/LICENSE`, quoted verbatim:

> "You are granted a non-exclusive, worldwide, non-transferable and royalty-free limited license
> under Meta's intellectual property or other rights owned by Meta embodied in the SAM Materials
> to use, reproduce, distribute, copy, create derivative works of, and make modifications to the
> SAM Materials."

No commercial carve-out, no MAU threshold. Restrictions are an acceptable-use policy (no
weapons/ITAR/espionage), attribution in publications, and passing the licence along with
redistributions. **This is safe to build a business on.** MHR itself is Apache 2.0.

### 1.4 Prior art: this pipeline has been shipped

The team at [clad.you](https://clad.you/blog/posts/body-pipeline/) built substantially this
architecture and published their numbers — invaluable de-risking:

- SAM 3D Body → MHR params → converted to Anny for interpretable parameters
- **~$0.09 per scan** unoptimised on a GCP L4; **~$0.03–0.04** with weight caching
- ~80 seconds of actual compute
- **5–8 cm MAE** on bust/waist/hip circumference, against a field norm of 3–12 cm for
  in-the-wild single-image methods
- They open-sourced `clad-body` for ISO 8559-1 circumference extraction

That accuracy is the honest expectation to set. It is good enough for a Digital Body Profile
and for sizing recommendations; it is **not** good enough for bespoke tailoring without a
correction step. Planning for that gap now is cheaper than discovering it later.

---

## 2. Chosen pipeline

Two tracks producing the two layers from [00-scope](00-scope-and-milestones.md#2-the-load-bearing-insight).

```
                     ┌──────────────── INGEST ────────────────┐
  video ──┐          │ validate → decode → dedupe → quality   │
          ├────────► │ score → select N best frames           │
  photos ─┘          └────────────────┬───────────────────────┘
                                      │
                     ┌────────────────▼───────────────────────┐
                     │ PREP: BiRefNet matting → person crop   │
                     │       → alpha masks → normalise        │
                     └────────────────┬───────────────────────┘
                                      │
              ┌───────────────────────┴────────────────────────┐
              ▼                                                ▼
   ═══ TRACK A: BODY CORE ═══                    ═══ TRACK B: APPEARANCE SHELL ═══
   SAM 3D Body per frame                         camera solve (from A's fit)
        → MHR params + camera                          │
   multi-frame robust fusion                     xatlas UV unwrap
        → single shape vector                          │
   scale resolution (height)                     multi-view projection + blend
        → metric MHR mesh                              │
   [optional] MHR → Anny retarget                inpaint unseen regions
        │                                              │
        ▼                                              ▼
   BodyCore (~2 KB, permanent)                   texture atlas + optimised mesh
              └───────────────────────┬────────────────────────┘
                                      ▼
                     ┌────────────────────────────────────────┐
                     │ EXPORT: GLB (Draco+KTX2), OBJ+MTL,     │
                     │ thumbnails, metadata → object storage  │
                     └────────────────────────────────────────┘
```

---

## 3. Stage specification

Each stage is an independently retryable unit with content-addressed inputs/outputs.

### S1 — Validate
Magic-byte sniffing (never trust extension or client MIME), codec/duration/resolution limits,
frame-count sanity, EXIF orientation normalisation, **EXIF GPS stripped immediately**.
Reject early and specifically — "video is 4 minutes, max is 60 seconds" beats "invalid file".

### S2 — Decode & frame extraction
`ffmpeg` → uniform temporal sample at ~4 fps ceiling (a 25 s video gives ~100 candidates).
Photo mode skips straight to S3 with each upload as a candidate.

### S3 — Deduplicate & quality-score
Per-frame score, cheap and CPU-only:
- **Sharpness** — variance of Laplacian; reject bottom quartile
- **Exposure** — histogram clipping at both ends
- **Subject coverage** — person bbox area as fraction of frame
- **Novelty** — perceptual hash distance from already-selected frames

Then **select N frames maximising yaw coverage**, not just quality — 8 excellent frontal frames
are worth far less than 8 mediocre frames spanning 360°. Yaw is estimated from a cheap pose
pass. Default N=16 for video, all uploads for photo mode.

> *This stage is the highest-leverage cheap win in the pipeline. Frame selection quality
> affects the result more than any hyperparameter downstream.*

### S4 — Matting & segmentation
**BiRefNet** (MIT, ~1 GB) for high-resolution automatic alpha matting — chosen over RMBG-2.0
(non-commercial) and over SAM2 (needs prompts; we want zero user input). Produces soft alpha,
which matters for hair and loose clothing. Output: RGBA crop, tight square, resolution-normalised.

### S5 — Body inference *(Track A)*
**SAM 3D Body**, ViT-H backbone at fp16, per selected frame. Returns MHR shape coefficients,
pose, and a camera. Batched to respect the 8 GB ceiling; weights held resident across a job
(this is the difference between $0.09 and $0.03 per scan).

### S6 — Multi-frame fusion *(Track A)*
Monocular per-frame estimates are noisy; fusing them is where the accuracy comes from.

- **Shape:** per-coefficient robust average across frames — median, then a Huber-weighted
  refit that down-weights outlier frames. Naive mean is badly hurt by one bad frame.
- **Pose:** *not* fused. Kept per-frame — it's a nuisance parameter for us, and needed for
  Track B's camera solve.
- **Confidence:** inter-frame variance per coefficient, persisted. This is what lets the app
  say "we're confident about your torso, less so about your arms" instead of pretending to
  certainty we don't have.

### S7 — Scale resolution *(Track A)*
**Monocular reconstruction is scale-ambiguous — there is no way around this.** A photo of a
tall person far away is identical to a short person nearby. Resolved in priority order:

1. **User-stated height** (v1 default) — one number, reliable, users know it. Anchors everything.
2. **ARKit/LiDAR depth** (v2) — true metric scale, iOS only.
3. **Reference object** (fallback) — a credit card or A4 sheet in frame.
4. **Statistical prior** — Anny's WHO-calibrated demographics. Last resort, wide error bars.

Scale is stored as its own field with `source` and `confidence`, never silently baked in.
Anything downstream that consumes measurements can then reason about trustworthiness.

### S8 — Body model retarget *(Track A, optional)*
MHR → **Anny** fit, giving 11 interpretable phenotype parameters. Not needed to render, but
it's what makes the Core *legible* — "height 178 cm, weight class X, muscle Y" is queryable and
explainable in a way that 45 abstract MHR coefficients never will be. Note clad.you found
Anny's built-in regressor underperformed and trained their own converter; expect to do the
same. Deferred to post-M4.

### S9 — UV unwrap *(Track B)*
**xatlas** (MIT). MHR topology is fixed, so the atlas is computed **once offline and cached** —
never per job. Every avatar shares a UV layout, which also makes textures comparable across
users and across time for the same user.

### S10 — Multi-view texture bake *(Track B)*
For each selected frame: project onto the mesh with that frame's camera; accept a texel if
visible (depth test) and front-facing; weight contributions by `cos(view angle)` and frame
quality score; accumulate in UV space; blend.

Known hard part: **coverage holes and seams** from self-occlusion (armpits, inner thighs, under
the chin) are unavoidable — the literature is unanimous. Handled by Poisson blending across
seams, then symmetric fill (mirror left↔right, which is legitimate for human bodies), then
inpainting whatever remains. Photo mode with only a front image will have a substantially
hallucinated back; the app must say so rather than quietly presenting a guess.

### S11 — Mesh optimisation
Watertightness check, non-manifold repair, optional decimation to an LOD ladder, tangent
generation, Draco geometry compression, KTX2/Basis texture compression. Target: **< 5 MB GLB**
for smooth mobile rendering.

### S12 — Export & persist
GLB (Draco + KTX2) as primary, OBJ + MTL + PNG for interoperability, orbit thumbnails, and a
metadata sidecar (model versions, per-stage timings, confidences, scale provenance). Then
`BodyCore` is committed to Postgres; assets go to object storage.

---

## 4. Adapter interface

Every model sits behind one contract, which is what makes D2/D3 real:

```python
class ReconstructionAdapter(Protocol):
    id: str                    # "sam3dbody-vith-v1"
    license: LicenseInfo       # from model-registry; gates production builds
    def warmup(self) -> None: ...
    def infer(self, frames: list[PreparedFrame]) -> BodyEstimate: ...
```

Three implementations ship: `Sam3DBodyAdapter` (local GPU), `RemoteInferenceAdapter` (HTTP to a
rented GPU — **written in M3, not later**, so the cloud path is exercised from the start), and
`MockAdapter` (deterministic fixtures, so the whole pipeline is testable in CI with no GPU).

The research-tier models, when wanted, are additional implementations behind the same
`Protocol`, reachable only via `RemoteInferenceAdapter` and blocked from production builds by
the license gate.

## 5. Performance estimate (RTX 4060 8 GB, 16 frames)

| Stage | Est. time | Device |
|---|---|---|
| S1–S3 validate/decode/select | 10–20 s | CPU (24 threads) |
| S4 matting ×16 | 6–10 s | GPU |
| S5 SAM 3D Body ×16 | 24–40 s | GPU |
| S6–S8 fusion, scale, retarget | 2–5 s | CPU |
| S9–S10 unwrap (cached) + bake | 30–60 s | GPU + CPU |
| S11–S12 optimise + export | 15–30 s | CPU |
| **Total** | **~2–3 min** | |

On a cloud L4 expect ~60–90 s. These are estimates from model size and stage complexity, not
measurements — **M3 must replace them with real numbers**, and the metadata sidecar records
per-stage timings precisely so this table becomes empirical.

## 6. Known limitations to design around

| Limitation | Consequence | Mitigation |
|---|---|---|
| Scale ambiguity | Height cannot be derived from pixels alone | S7 ladder; store provenance |
| 5–8 cm circumference MAE | Not tailoring-grade | Set expectations; plan a correction step |
| Loose clothing | Body shape under a coat is inferred | Guided capture asks for fitted clothing |
| Self-occlusion | Texture holes | Symmetric fill + inpaint; be honest in UI |
| Photo mode, 1 image | Back is invented | Label confidence per region; push video mode |
| Single-person assumption | Multi-person frames ambiguous | Largest-bbox selection + explicit error |

---

**Next:** [02-system-architecture.md](02-system-architecture.md)
