# TailorAI — System Architecture

---

## 1. Component map

```
┌──────────────────────────────────────────────────────────────────┐
│  MOBILE (Expo / React Native)                                    │
│  guided capture · resumable upload · SSE progress · Filament     │
└───────────────────────────┬──────────────────────────────────────┘
                            │ HTTPS / JWT / SSE
┌───────────────────────────▼──────────────────────────────────────┐
│  API GATEWAY (NestJS + Fastify)                                  │
│  auth · validation · rate limit · presigned URLs · job CRUD      │
│  Owns NO business logic beyond HTTP concerns.                    │
└──┬─────────────────┬────────────────────┬────────────────────────┘
   │                 │                    │
   ▼                 ▼                    ▼
┌────────┐   ┌───────────────┐   ┌──────────────────┐
│Postgres│   │ Redis         │   │ Object storage   │
│(Prisma)│   │ BullMQ + SSE  │   │ MinIO → R2/S3    │
└────────┘   └───────┬───────┘   └──────────────────┘
                     │
┌────────────────────▼─────────────────────────────────────────────┐
│  ORCHESTRATOR (Node worker)                                      │
│  Owns the job state machine. Runs S1–S3, S11–S12 (CPU stages).   │
│  Calls the GPU service for S4–S10. Retries, timeouts, cleanup.   │
└────────────────────┬─────────────────────────────────────────────┘
                     │ HTTP (narrow, versioned contract)
┌────────────────────▼─────────────────────────────────────────────┐
│  RECONSTRUCTION SERVICE (Python 3.11 + FastAPI + PyTorch)        │
│  STATELESS. Adapters only. No DB. No queue. No auth.             │
│  Local GPU in dev  →  identical container on RunPod/Modal later. │
└──────────────────────────────────────────────────────────────────┘
```

### Why the orchestrator and GPU service are separate processes

This is the decision that makes D3 (local now, cloud later) a config change instead of a
rewrite. The Python service knows nothing about users, jobs, or storage — it takes prepared
frames and returns tensors. That means:

- It can be moved to a rented GPU by changing one URL.
- It can be scaled independently of the API (GPU is the scarce resource, HTTP is not).
- It can crash, OOM, or be restarted without losing job state — the orchestrator owns state.
- It is trivially testable, because it is a pure function with a narrow contract.

If both lived in one process, a CUDA OOM would take down the API.

### Why TypeScript gateway + Python GPU service

The AI stack is Python; that is not negotiable. The question is only what language the gateway
speaks. Choosing TypeScript buys **end-to-end type safety with the mobile app** through a shared
contracts package — a daily productivity win — and Node is genuinely good at the I/O-bound work
the gateway actually does (uploads, SSE, auth).

The cost is running two languages. That cost is contained because the boundary is narrow and
versioned: `POST /infer` in, tensors out.

> **Simpler alternative, if you'd rather run one language:** FastAPI for both, generating the
> mobile client from OpenAPI. You lose shared zod schemas and some DX. Say the word and I'll
> switch — this is the one structural choice I'd consider revisiting.

---

## 2. Folder structure

```
tailorai/
├── apps/
│   ├── mobile/                      # Expo app (D1)
│   │   ├── src/
│   │   │   ├── app/                 # expo-router routes
│   │   │   │   ├── (auth)/
│   │   │   │   ├── (tabs)/          # home · profile
│   │   │   │   ├── capture/         # guided capture flow (D4)
│   │   │   │   ├── processing/[id]  # live progress
│   │   │   │   └── viewer/[id]      # 3D viewer
│   │   │   ├── features/
│   │   │   │   ├── capture/         # camera, overlays, quality checks
│   │   │   │   ├── upload/          # chunked + resumable
│   │   │   │   ├── jobs/            # SSE subscription, state
│   │   │   │   ├── viewer/          # Filament wrapper, controls
│   │   │   │   └── profile/
│   │   │   ├── components/          # design-system primitives
│   │   │   ├── lib/                 # api client, storage, telemetry
│   │   │   └── theme/               # dark-first tokens
│   │   └── app.config.ts
│   │
│   └── api/                         # NestJS gateway
│       └── src/
│           ├── modules/
│           │   ├── auth/            # AuthProvider interface + impl
│           │   ├── users/
│           │   ├── uploads/         # presign, multipart, finalize
│           │   ├── jobs/            # create, query, cancel
│           │   ├── avatars/         # results, exports, downloads
│           │   ├── events/          # SSE hub
│           │   └── health/
│           ├── common/              # guards, filters, interceptors, errors
│           └── config/              # zod-validated env
│
├── services/
│   ├── orchestrator/                # Node worker — job state machine
│   │   └── src/
│   │       ├── stages/              # one file per S1..S12
│   │       ├── pipeline/            # DAG definition, runner, retry policy
│   │       ├── clients/             # GPU service client, storage client
│   │       └── mesh/                # Draco/KTX2/GLB/OBJ export
│   │
│   └── reconstruction/              # Python GPU service
│       ├── app/
│       │   ├── api.py               # FastAPI routes
│       │   ├── adapters/            # sam3dbody/ · birefnet/ · remote/ · mock/
│       │   ├── core/                # fusion, scale, camera solve
│       │   ├── texture/             # xatlas, projection, blend, inpaint
│       │   └── runtime/             # model cache, VRAM guard, batching
│       ├── tests/
│       └── pyproject.toml           # uv-managed, Python 3.11
│
├── packages/
│   ├── contracts/                   # zod schemas → single source of truth
│   ├── model-registry/              # licenses.json + verify-licenses (ADR-2)
│   ├── sdk/                         # typed client generated from contracts
│   └── config/                      # shared tsconfig/eslint/prettier
│
├── infra/
│   ├── docker/                      # per-service Dockerfiles
│   ├── compose/                     # local stack
│   └── migrations/                  # Prisma migrations
│
├── docs/                            # you are here
└── scripts/                         # weight download, atlas precompute, seed
```

**Rules that keep this from rotting:**
- `apps/*` may import `packages/*`. Never the reverse. Never `apps/*` → `apps/*`.
- `services/reconstruction` imports nothing from the TS side. Its contract is HTTP + JSON Schema.
- Anything in `packages/contracts` is generated-from or generates-to — never hand-edited twice.

Tooling: **pnpm workspaces + Turborepo** for TS, **uv** for Python (`uv` is not installed yet —
M0 adds it). Note weights and Docker volumes must live on `D:` given C: has 39.5 GB free.

---

## 3. Job state machine

A job is a persisted DAG, not a function call. Every stage records `status`, `startedAt`,
`finishedAt`, `attempt`, `inputRef`, `outputRef`, `error`.

```
QUEUED → VALIDATING → EXTRACTING → SELECTING → SEGMENTING
       → RECONSTRUCTING → FUSING → TEXTURING → OPTIMISING → EXPORTING → COMPLETED
                                                                     ↘ FAILED
                                                                     ↘ CANCELLED
```

**Retry policy** is per-stage, because the failure modes differ:

| Failure | Policy |
|---|---|
| GPU service unreachable | Exponential backoff, 5 attempts — it's transient |
| CUDA OOM | Retry **once** at reduced batch size, then fail — retrying identically is pointless |
| Bad input (unreadable video) | **No retry.** Fail immediately with a specific user message |
| Texture bake failure | Degrade to untextured mesh, mark partial, continue — a grey avatar beats no avatar |

Stage outputs are content-addressed (`sha256`) in object storage, so a retry resumes from the
last good stage rather than restarting a 3-minute job from zero.

**Idempotency:** job creation takes an `Idempotency-Key`. A phone that retries on a flaky
connection must not create three reconstructions.

---

## 4. Progress delivery

**SSE, not WebSockets.** Progress is unidirectional server→client; SSE gives us automatic
reconnection with `Last-Event-ID`, works over plain HTTP/2, and needs no extra infrastructure.
WebSockets would add a stateful protocol for a purely one-way feed.

The orchestrator publishes to a Redis pub/sub channel per job; the API's SSE endpoint subscribes
and relays. This keeps the API stateless and horizontally scalable — any instance can serve any
job's stream.

Progress must be **honest**: real stage transitions with real per-stage weights, not a fake
timer. A progress bar that stalls at 90% is worse than one that says "texturing — this is the
slow part."

---

## 5. Uploads

**S3 multipart with presigned URLs.** The phone uploads chunks directly to object storage; bytes
never transit the API. Resumability comes free — the client queries which parts landed and
re-sends only the gaps.

Flow: `POST /uploads` (returns uploadId + presigned part URLs) → client PUTs parts, retrying
individually → `POST /uploads/:id/complete` → server verifies checksum and size, sniffs magic
bytes, then creates the job.

The API never accepts a file body. That removes a whole category of DoS and memory-pressure
problems, and means a 60 MB video on a bad train connection is a client-side concern.

---

## 6. Security model

| Concern | Approach |
|---|---|
| AuthN | `AuthProvider` interface; Clerk or Supabase for v1 (good Expo SDKs), self-host later without touching callers |
| AuthZ | Every resource query is scoped by `userId` at the repository layer — not in controllers, where it gets forgotten |
| Upload safety | Magic-byte sniffing, size/duration caps, per-user quota, no client-MIME trust |
| Download safety | Short-lived presigned GETs (5 min), never public buckets |
| Transport | TLS everywhere; certificate pinning on mobile for the API host |
| At rest | SSE-S3/SSE-KMS on the bucket; Postgres encrypted volume |
| Rate limits | Per-user and per-IP; job creation limited far more tightly than reads |
| Secrets | Env-injected, zod-validated at boot, never in the repo |
| PII in logs | Structured logging with a redaction allowlist — log `userId`, never image data or tokens |

Biometric-specific obligations are substantial and are covered in
[06-infra-cost-risk.md](06-infra-cost-risk.md#privacy--legal). They are not optional.

---

## 7. Observability

- **Structured JSON logs** with `jobId`/`userId`/`stage` on every line, so a failed
  reconstruction can be reconstructed from logs alone.
- **Metrics:** per-stage duration histograms, queue depth, GPU utilisation and VRAM
  high-water mark, failure counts by taxonomy code, cost per job.
- **Traces:** OpenTelemetry across API → orchestrator → GPU service. Debugging a slow job
  without distributed tracing is guesswork.
- **The metadata sidecar** written in S12 doubles as a permanent per-job audit record.

---

**Next:** [03-data-model.md](03-data-model.md)
