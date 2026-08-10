# TailorAI — Scope, Principles & Milestones

> **Status:** Proposed architecture, awaiting approval. No implementation code written yet.
> **Date:** 2026-08-07

---

## 1. The one goal

Turn a person's phone photos or a short 360° video into an accurate, inspectable, downloadable
3D digital human — and persist it as their **permanent Digital Body Profile**.

Everything else is out of scope. Explicitly **not** building now: fashion, recommendations,
shopping, styling, wardrobes, analytics, enterprise dashboards, public APIs, try-on.

## 2. The load-bearing insight

The naive version of this product treats "the avatar" as one artifact: a mesh with a texture.
That is a mistake, and it is the mistake that makes avatar products impossible to evolve.

We split the output into two layers with different lifetimes:

| | **Body Core** | **Appearance Shell** |
|---|---|---|
| What | Parametric body: shape coefficients, skeleton, metric scale | Mesh surface + texture + clothing detail |
| Size | ~2 KB of floats | 5–20 MB of geometry and pixels |
| Lifetime | **Permanent.** This *is* the user's profile | **Disposable.** A render, regenerable any time |
| Serves | Measurements, sizing, try-on, tailoring | Viewing, sharing, download |
| Changes when | The user's body changes | We ship a better renderer |

**Why this matters:** when we replace the mesh generator in 2027, every existing user's profile
stays valid — we re-render the shell from the stored Core. If the avatar were one artifact,
every model upgrade would orphan the entire user base. This separation is the single most
important decision in the document, and it is what makes the "Body Intelligence platform"
future actually reachable rather than aspirational.

It also means the moat is the Core (a few hundred floats per user, plus consented longitudinal
history), not the pretty mesh. The mesh is the demo. The Core is the company.

## 3. Engineering principles

1. **Every AI model sits behind an adapter.** No pipeline stage imports a model directly.
   Swapping SAM 3D Body for its successor is a config change, not a refactor.
2. **The Core is sacred; the Shell is cattle.** Never let a rendering concern write to the Core.
3. **Jobs are resumable state machines, not scripts.** Every stage is independently retryable
   with its inputs and outputs content-addressed in object storage.
4. **Biometric data is treated as radioactive by default.** Raw imagery has a TTL. See
   [06-infra-cost-risk.md](06-infra-cost-risk.md#privacy--legal).
5. **Type safety end to end.** One schema package generates the API contract, the DB types,
   and the mobile client.
6. **No stage may block a request.** Everything past upload is queued.

## 4. Confirmed constraints (verified, not assumed)

**Dev hardware** (probed 2026-08-07):

| Resource | Value | Consequence |
|---|---|---|
| GPU | RTX 4060 Laptop, **8 GB VRAM**, CC 8.9 | Hard ceiling. Rules out PSHuman/LHM/SiTH locally |
| CPU / RAM | i7-13700HX, 24 threads / 31.7 GB | Comfortable for CPU-side mesh work |
| Disk | **C: 39.5 GB free**, D: 216.7 GB free | All weights, Docker volumes, MinIO data go on `D:` |
| Toolchain | Node 22.14, Python 3.11.9 (`python3`), Docker 28.0.4, WSL2 Ubuntu | Use `python3` (3.11), **not** `python` (3.13 — too new for the ML stack) |

**VRAM budget at fp16** — what actually fits in 8 GB:

| Model | Weights | Est. peak | Fits? |
|---|---|---|---|
| SAM 3D Body (ViT-H, 631M) | ~1.3 GB | ~4 GB | ✅ |
| SAM 3D Body (DINOv3-H+, 840M) | ~1.7 GB | ~5 GB | ✅ tight |
| BiRefNet (matting) | ~1.0 GB | ~3 GB | ✅ |
| PSHuman @ 768 | — | >40 GB | ❌ |
| PSHuman @ 512 | — | ~24 GB | ❌ |
| LHM-0.5B | — | ~12–16 GB | ❌ |

Only one tier-1 human reconstruction model runs on this machine. That is not a limitation to
work around — it is the decision, made for us, and it happens to point at the
commercially-licensed option.

## 5. Decisions taken

| # | Decision | Rationale |
|---|---|---|
| D1 | React Native + Expo | One codebase; `react-native-filament` is production-proven for GLB |
| D2 | Model tier: research-grade behind an adapter, clean-licensed default | User's call, risk acknowledged. Enforced by a build gate (§ADR-2) |
| D3 | Local GPU for dev, cloud adapter stubbed | Zero spend now; `RemoteInferenceAdapter` ships from day one so the swap is exercised, not theoretical |
| D4 | Guided capture in v1 | Capture quality dominates final accuracy. Cheapest possible accuracy win |

### ADR-2: how the licensing swap is made real

D2 carries genuine legal debt — SMPL forbids commercial use *and* forbids training networks for
commercial use, and Meshcapade (the sole sub-licensor) was acquired by Epic in Feb 2026, so
future terms are uncertain. Because a promise in a document is not a control, the swap is
enforced mechanically:

1. **`packages/model-registry/licenses.json`** — every model declares
   `{ id, license, commercial_ok, source_url, sha256 }`.
2. **Build gate** — CI and the production Docker build run `verify-licenses`, which fails the
   build if any model with `commercial_ok: false` is reachable while `MODEL_TIER=production`.
3. **Research models are cloud-only by construction** — they don't fit on dev hardware, so the
   research tier can only be reached by explicitly pointing at a rented GPU.

Net effect: shipping a non-commercial weight to production requires deliberately deleting a
CI check, not merely forgetting.

## 6. Milestones

Each milestone ends with something demonstrable. No milestone is "plumbing only."

| M | Name | Delivers | Exit criteria |
|---|---|---|---|
| **M0** | Foundations | Monorepo, Docker Compose (Postgres/Redis/MinIO), CI, contracts package | `docker compose up` → all green; typecheck passes across workspaces |
| **M1** | Identity & storage | Auth, user records, resumable uploads, TTL policy | Sign in on device, upload a 60 MB video, resume after airplane-mode kill |
| **M2** | Job engine | Queue, stage state machine, SSE progress, retries | A no-op 5-stage job streams live progress to the phone and survives a worker restart |
| **M3** | **Body Core** | Frame selection, matting, SAM 3D Body, multi-frame fusion, scale resolution | Real photos → MHR params + height estimate, with confidence, persisted |
| **M4** | **Appearance Shell** | UV unwrap, multi-view texture bake, cleanup, GLB/OBJ export | Downloadable textured GLB that opens correctly in Blender and three.js |
| **M5** | Guided capture | Silhouette overlay, pose/distance/lighting checks, auto-capture, on-device blur rejection | Untrained user completes a capture unaided and gets a usable reconstruction |
| **M6** | Viewer & profile | Filament viewer (orbit/zoom/pan, wireframe/solid/texture, lighting, stats), profile screen, export | Full journey: capture → process → inspect → download → saved profile |
| **M7** | Hardening | Rate limits, quotas, error taxonomy, observability, load test, privacy controls (export/delete) | Sustained 50 concurrent jobs; documented p50/p95; user can delete all data |

M3 and M4 are the technical heart. M0–M2 exist to make them safe to build.

## 7. What "done" looks like for v1

A user installs the app, is guided through a 25-second capture, waits ~2–4 minutes watching
honest live progress, and receives a 3D model they recognise as themselves — which they can
orbit, inspect, download as GLB/OBJ, and which persists as their profile. Measurements are
*not* exposed in v1, but the Core carries everything needed to derive them later.

---

**Next:** [01-ai-pipeline.md](01-ai-pipeline.md) — model research, comparison and the chosen pipeline.
