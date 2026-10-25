# TailorAI

Turn phone photos or a short 360° video into an accurate 3D digital human — and persist it as a
permanent **Digital Body Profile**.

> **Status:** Running end to end on a Windows laptop (no Docker/WSL needed).
> Four photos → 11 measurements → a realistic, rigged **Anny** 3D body fitted
> to them → a 34-outfit shop with **Find my size** and **3D try-on** (fit map on
> your own body, every size) → an **accuracy page** that compares the scan with
> a tape measure. Optional **Gemini** writes size explanations and reads brand
> size charts. 70 unit tests, `npm run smoke` 23/23, `npm run test:mvp` 21/21.
> The Flutter phone app has not yet been run on a device. See [RUNBOOK](RUNBOOK.md).

---

## The idea in one diagram

```
photos / 360° video
        │
        ▼
  ┌─────────────────────────────────────────┐
  │  Body Core        │  Appearance Shell   │
  │  ~2 KB, permanent │  ~5 MB, disposable  │
  │  MHR parameters   │  mesh + texture     │
  │  measurement-ready│  viewable, exportable│
  └─────────────────────────────────────────┘
        │
        ▼
  3D viewer · GLB/OBJ export · saved profile
```

The split is the whole architecture. The **Core** is the user's identity and survives every
future model upgrade. The **Shell** is a render, regenerable at any time. Improving the pipeline
in 2027 must never invalidate a profile created in 2026.

## Running it

See **[RUNBOOK.md](RUNBOOK.md)** for setup, verification, current status, and
the deviations from the original architecture.

Quick verification of the part that is proven end-to-end:

```bash
cd services/reconstruction && .venv/Scripts/python.exe -m pytest tests/ -q
```

## Documentation

| Doc | Contents |
|---|---|
| [RUNBOOK](RUNBOOK.md) | **Start here** — how to run it, what works, what doesn't |
| [00 — Scope & Milestones](docs/00-scope-and-milestones.md) | Goal, principles, verified constraints, decisions, M0–M7 |
| [01 — AI Pipeline](docs/01-ai-pipeline.md) | Model research & comparison, chosen pipeline, 12 stages, limitations |
| [02 — System Architecture](docs/02-system-architecture.md) | Components, folder structure, job state machine, security |
| [03 — Data Model](docs/03-data-model.md) | Postgres/Prisma schema, retention & deletion |
| [04 — API Spec](docs/04-api-spec.md) | REST + SSE contract, error taxonomy |
| [05 — Mobile App](docs/05-mobile-app.md) | Flutter stack, guided capture, 3D viewer, design language |
| [06 — Infra, Cost & Risk](docs/06-infra-cost-risk.md) | Compute/storage/GPU estimates, **privacy & legal**, risk register |
| [07 — Body Intelligence MVP](docs/07-body-intelligence-mvp.md) | **The web MVP**: four-photo scan → measurements → Body Profile → Find My Size; accuracy and limitations |
| [08 — Realistic body, try-on, Gemini](docs/08-realistic-body-tryon-gemini.md) | Anny body fitted to all measurements, 3D try-on fit map, accuracy study, Gemini features, add-outfit page |

## Stack

**Web (MVP)** Next.js 15.5 · Tailwind · React Three Fiber — scan, Body Profile, shop, Find My Size, 3D try-on, accuracy, add-outfit
**Mobile** Flutter (Dart) · `model_viewer_plus` (textured GLB) · `camera` · `go_router` · `provider`
**API** NestJS (Express) · Postgres + Prisma · Redis + BullMQ · S3-compatible storage (MinIO or SeaweedFS)
**Pipeline** Node orchestrator (state machine) → stateless Python service (FastAPI + PyTorch)
**Models** MediaPipe Pose (scan, CPU) · **Anny** (rigged body, CPU) · SAM 3D Body → MHR · BiRefNet · xatlas — all behind swappable adapters
**Optional AI** Gemini (`gemini-3.5-flash-lite`) — size explanations, size-chart reading, opt-in photo check

## Model choice, briefly

**SAM 3D Body** (Meta, CVPR 2026) outputs **MHR** parameters. Chosen because it is the only
tier-1 human reconstruction model that is both **commercially licensed** and **runs in 8 GB of
VRAM**. Nearly every alternative (ECON, SIFU, PSHuman, LHM, SiTH) depends on SMPL, which forbids
commercial use *and* forbids commercial training — and which needs 24–40 GB besides.

Full comparison, including the models we rejected and why, in
[01 — AI Pipeline](docs/01-ai-pipeline.md).

## Before writing code

Two items in [06](docs/06-infra-cost-risk.md#6-privacy--legal) are load-bearing and not optional:
biometric-data compliance (BIPA/GDPR Art. 9), and the clothing/minors controls. Both are already
reflected in the schema and API design.
