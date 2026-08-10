# TailorAI — Infrastructure, Cost, Risk

---

## 1. Environments

| | Dev (now) | Staging | Production |
|---|---|---|---|
| API | local Node | Fly.io / Railway | Fly.io multi-region |
| Orchestrator | local Node | 1 worker | N workers, autoscaled on queue depth |
| GPU service | **local RTX 4060** | RunPod serverless L4 | RunPod/Modal L4, autoscaled |
| Postgres | Docker (on `D:`) | Neon branch | Neon / RDS, PITR enabled |
| Redis | Docker | Upstash | Upstash / ElastiCache |
| Storage | **MinIO on `D:`** | Cloudflare R2 | Cloudflare R2 |

**Cloudflare R2 over S3** — R2 charges no egress. Every avatar view downloads a 4 MB GLB;
on S3 that becomes the dominant line item as usage grows. R2 is S3-API-compatible, so the
storage adapter is identical either way.

**Everything on `D:` in dev.** C: has 39.5 GB free — model weights (~5 GB), Docker volumes, and
MinIO data will exhaust it. Set `DOCKER_DATA_ROOT` and all bind mounts to `D:\tailorai\.data\`.

---

## 2. Compute estimates

### Per reconstruction (16 frames)

| Stage | RTX 4060 (dev) | L4 (prod) | Bound by |
|---|---|---|---|
| Validate / decode / select | 10–20 s | 8–15 s | CPU |
| Matting ×16 | 6–10 s | 4–7 s | GPU |
| SAM 3D Body ×16 | 24–40 s | 15–25 s | **GPU — the bottleneck** |
| Fusion / scale / retarget | 2–5 s | 2–4 s | CPU |
| UV (cached) + texture bake | 30–60 s | 20–35 s | GPU + CPU |
| Optimise + export | 15–30 s | 10–20 s | CPU |
| **Total** | **~2–3 min** | **~60–105 s** | |

Consistent with the ~80 s of compute clad.you reported on an L4 for a comparable pipeline.

**These are estimates, not measurements.** M3's exit criteria include replacing this table with
real per-stage timings from the metadata sidecar.

### VRAM plan (8 GB ceiling)

Weights stay resident across a job — reloading per job is what turns a $0.03 scan into $0.09.
Peak concurrent residency: BiRefNet (~1 GB) + SAM 3D Body ViT-H (~1.3 GB) ≈ 2.3 GB weights,
~5–6 GB peak with activations at batch 2. **Dev machine runs exactly one job at a time.**
A `VRAMGuard` in `services/reconstruction/runtime/` enforces this and returns `503` rather than
letting CUDA OOM take the process down.

---

## 3. Storage estimates

Per scan:

| Artifact | Size | Retention |
|---|---|---|
| Raw video (25 s, 1080p) | 25–60 MB | **30 days** |
| Candidate frames (~100) | ~30 MB | 7 days |
| Selected + prepared frames (16) | ~9 MB | 7 days |
| Masks (16) | ~3 MB | 7 days |
| Texture atlas (2048², KTX2) | ~2 MB | permanent |
| **GLB (Draco + KTX2)** | **~4 MB** | permanent |
| OBJ + MTL + PNG (zip) | ~15 MB | on demand, 7 days |
| Thumbnails | ~0.5 MB | permanent |
| `BodyCore` row | **~2 KB** | permanent |

- **Transient peak:** ~120 MB per in-flight job
- **Steady state after purge:** **~7 MB per user**

| Users | Steady storage | R2 cost/mo (@ $0.015/GB) |
|---|---|---|
| 1,000 | 7 GB | ~$0.11 |
| 10,000 | 70 GB | ~$1.05 |
| 100,000 | 700 GB | ~$10.50 |

**Storage is not a cost problem.** GPU is. Retention policy is driven by privacy law, not by
the storage bill — which is why the 30-day raw purge costs us nothing to honour.

---

## 4. Cost model

| Scans/mo | Serverless L4 @ ~$0.04 | Dedicated L4 pod ($0.39/hr) | Cheaper |
|---|---|---|---|
| 100 | $4 | $280 | Serverless |
| 1,000 | $40 | $280 | Serverless |
| 5,000 | $200 | $280 | Serverless |
| **~7,000** | **~$280** | **$280** | **crossover** |
| 50,000 | $2,000 | ~$840 (3 pods) | Dedicated |

**Crossover is around 7,000 scans/month.** Below that, serverless with scale-to-zero is
unambiguously right — which is why D3's `RemoteInferenceAdapter` targets serverless, and why the
adapter boundary matters: crossing over later is a deployment change, not an architecture change.

Fixed costs at low volume: Neon + Upstash + Fly + R2 ≈ **$30–60/month**.

---

## 5. Bottlenecks

| # | Bottleneck | Symptom | Mitigation |
|---|---|---|---|
| B1 | **GPU throughput** | Queue depth grows under burst | Scale-to-N serverless; queue with honest ETAs; per-user concurrency cap |
| B2 | **Serverless cold start** | First scan after idle pays model-load cost | Keep-warm during active hours; bake weights into the image, never download at runtime |
| B3 | Texture bake (CPU+GPU mixed) | Longest single stage | Parallelise per-view projection; cache the UV atlas (topology is fixed) |
| B4 | Mobile upload | 60 MB over cellular | On-device frame pre-selection to cut payload; background upload; resumability |
| B5 | Viewer first paint | Big GLB on a mid-range phone | Draco + KTX2, LOD ladder, aggressive local cache |
| B6 | Postgres job-status polling | If SSE fails, N clients poll | SSE primary; 3 s poll floor; Redis-cached status |

B1 and B2 are the ones that will actually hurt. Both are addressed by the adapter boundary and
by never shipping a container that downloads weights at runtime.

---

## 6. Privacy & legal

**This is the highest-severity section in the document. Read it before writing code.**

### 6.1 Body scans are biometric data

Not "sensitive personal data" loosely — a specific, aggressively-enforced legal category:

- **GDPR Art. 9** — special category. Requires explicit consent, a DPIA, and data minimisation.
- **Illinois BIPA** — statutory damages of **$1,000–5,000 per violation**, with a private right
  of action. Per person, per violation. BIPA suits have produced nine-figure settlements and
  have ended companies. It requires written consent *and* a published retention schedule
  *before* collection.
- **Texas CUBI**, **Washington My Health My Data** — similar, with state-AG enforcement.

**Architectural consequences, already reflected in the schema and API:**
- `Consent` is a versioned ledger with IP and timestamp, not a boolean — you must be able to
  *prove* consent years later.
- `BIOMETRIC_PROCESSING` consent is a hard gate at `POST /v1/jobs` (403 without it).
- `purgeAfter` is set at capture time and returned to the client — a published, enforced
  retention schedule is a statutory requirement, not a feature.
- Deletion must reach object storage, not just Postgres.
- `dataRegion` pins residency from day one; retrofitting residency is brutal.

**Recommendation: geo-gate Illinois at launch** until BIPA-compliant written consent flow is
reviewed by a lawyer. This is a one-line feature flag now and an existential problem later.

### 6.2 The clothing problem — read this one carefully

Body reconstruction is more accurate with minimal clothing. Every product in this space
therefore drifts toward encouraging users to scan in underwear. That means:

**You will be operating a service that receives intimate images of users, uploaded from phones,
stored on your infrastructure — with no reliable way to verify the subject's age.**

The consequences are categorically different from ordinary data risk: this is potential criminal
exposure (CSAM), app-store removal, and payment-processor termination — not a fine.

Non-negotiable controls, in v1:

1. **Guided capture explicitly requests fitted clothing** — leggings/t-shirt, not underwear.
   Accept the small accuracy cost. The pipeline is designed for clothed subjects.
2. **Hard 18+ age gate** at signup, with date of birth stored, plus the ToS prohibition.
   `Anny` supports all ages; **we deliberately do not.** Minors are out of scope for v1 and the
   `birthYear` field enforces it.
3. **Automated nudity detection at ingest**, before human eyes or long-term storage. Reject and
   purge immediately with a clear message.
4. **No human review of raw imagery by default.** If debugging needs it, require a break-glass
   flow that is logged, time-boxed, and consented to.
5. **Aggressive raw-media TTL** (30 days) — the safest image is one you no longer hold. The
   `BodyCore` is only ~2 KB and is all you actually need long-term.

I'd push to have a lawyer review the consent flow and ToS before the first external user, not
before launch. It is much cheaper now.

### 6.3 Model licensing

Per D2 you've chosen research-grade-now with a swap plan, and the ADR-2 build gate makes that
mechanically enforceable. Two things to hold onto:

- The SMPL license forbids commercial use **and** forbids training networks for commercial use —
  so a model fine-tuned against SMPL data is contaminated, not merely a dependency to remove.
- On this hardware the research models can't run anyway, so v1 lands on the clean path by
  default. The debt only becomes real if someone deliberately points production at a rented GPU
  running SMPL-based weights.

---

## 7. Risk register

| # | Risk | Sev | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **BIPA / GDPR Art. 9 exposure** | Critical | Medium | §6.1 — consent ledger, retention, geo-gate, DPIA |
| R2 | **Intimate imagery / minors** | Critical | Medium | §6.2 — clothing guidance, 18+ gate, nudity detection, TTL |
| R3 | Accuracy disappoints (5–8 cm MAE) | High | **High** | Set expectations in-app; ship confidence UI; don't claim tailoring-grade |
| R4 | SMPL contamination reaches prod | High | Low | ADR-2 CI gate |
| R5 | 8 GB dev GPU blocks iteration | Medium | High | Accepted; `RemoteInferenceAdapter` from M3 lets you rent an A100 on demand |
| R6 | SAM 3D Body license changes | Medium | Low | Adapter boundary; MHR is Apache 2.0 independently |
| R7 | GPU cost spike from abuse | Medium | Medium | Per-user quotas, rate limits, cost telemetry per job |
| R8 | `react-native-filament` maintenance | Medium | Low | Viewer behind an interface; `<model-viewer>` in a WebView is the fallback |
| R9 | Capture UX too hard for real users | High | Medium | M5 usability testing with untrained users is an explicit exit criterion |
| R10 | Cold-start latency hurts first impression | Low | High | Keep-warm; honest ETA; weights baked into image |

R3 deserves emphasis: **the most likely way this product fails is not technical failure but
expectation failure** — a user who was promised a perfect digital twin and got a 5 cm-off
approximation. The confidence fields in `BodyCore`, the `coverage` map in the API, and the
inpaint overlay in the viewer all exist to make the product honest about what it knows. Honesty
is a feature here, not a caveat.

---

## 8. Improvements I'd recommend beyond the brief

1. **User-stated height as a first-class input.** Cheapest accuracy win available — it resolves
   the scale ambiguity that no amount of model quality can fix. Already in S7 and the schema.
2. **Ship the coverage/confidence UI in v1.** Turns the accuracy weakness into visible integrity.
3. **Longitudinal profiles from day one.** `BodyCore` is versioned, so "your body over time"
   works later at zero extra cost. This is a genuinely differentiated feature and ~2 KB/scan.
4. **A golden-set regression harness.** 20–30 fixed capture sets with known ground-truth
   measurements, run on every pipeline change. Without it you cannot tell an improvement from a
   regression, and model swaps become guesswork. I'd build this in M3.
5. **Bake weights into the container image.** Turns a 90-second cold start into a 10-second one.
6. **Defer Anny retarget (S8) past M4.** clad.you found the built-in regressor underperformed and
   had to train their own. Real work, not on the critical path to a viewable avatar.
7. **ARKit depth in M5+.** True metric scale on supported iPhones removes the single largest
   accuracy caveat. Deliberately not in v1 scope.

---

## 9. Open questions for you

1. **Target market / launch geography** — decides whether R1's geo-gate is a one-line flag or a
   blocking legal workstream.
2. **Accuracy bar for "good enough"** — is 5–8 cm MAE acceptable for v1, or is sizing-grade
   (~2–3 cm) a launch requirement? This changes the roadmap substantially.
3. **Auth provider preference** — Clerk, Supabase, or self-hosted? All fit behind `AuthProvider`;
   I'd default to Clerk for Expo DX.
4. **Do you want the FastAPI-only variant?** (§02) — one language instead of two, at the cost of
   shared types with the app.

None of these block starting M0.

---

**Back to:** [00-scope-and-milestones.md](00-scope-and-milestones.md)
