# TailorAI — Runbook

How to run, verify, and extend the system on this machine.

---

## 0. What state the project is in

| Component | Status |
|---|---|
| Monorepo, contracts, licence gate | ✅ gate verified in both directions |
| API gateway (NestJS) | ✅ **running**, serving against live Postgres + Redis + MinIO |
| Orchestrator (job state machine) | ✅ **running**, jobs complete in ~14 s |
| Reconstruction service (Python) | ✅ **running**, 25 unit/integration tests pass |
| Mobile app (Expo) | ✅ built, typechecks — **not yet run on a device** |
| Full-stack smoke test | ✅ **23/23**, repeatable |
| Docker infra | ⚠️ broken on this machine — **WSL2 path used instead** |

The whole backend has been executed end to end. A user journey — sign in,
consent, upload, reconstruct, download — runs against real HTTP, a real
database, a real queue and real object storage, and produces a downloadable GLB
at the exact requested stature.

Last run:

```
▸ Consent gate      job creation refused without consent (403 CONSENT_REQUIRED)
▸ Capture upload    4 photos via presigned URLs, verified server-side
▸ Pipeline          9 stages succeeded, 3 skipped, 0 degraded — 15.1 s
▸ Body Core         v1 · MHR · quality 0.44 · scale USER_HEIGHT (174 cm)
▸ Avatar            1926 verts · 3816 tris · 2414 KB · 70% inferred
▸ Authorisation     cross-user read blocked (404)
23 passed, 0 failed
```

**Docker Desktop is broken here.** It fails at startup with
`removing stale socket: userAnalyticsOtlpHttp.sock` — an orphaned kernel handle
in `%LOCALAPPDATA%\Docker\run\` that cannot be deleted while Windows holds it.
**A reboot clears it.** Until then, use the WSL2 path in §3, which runs the same
services on the same ports with the same credentials.

---

## 1. Prerequisites

Already present on this machine: Node 22.14, Python 3.11.9 (`python3`), Git,
Docker 28.0.4, WSL2.

**Everything writes to `D:`.** `C:` has ~39 GB free; weights, Docker volumes and
MinIO data will exhaust it. `.env` already points at `D:/tailorai/.data`.

---

## 2. First-time setup

```bash
npm install
```

```bash
cd services/reconstruction && python3 -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt
```

```bash
cd apps/mobile && npm install --legacy-peer-deps
```

---

## 3. Start infrastructure

Two interchangeable paths. Both give Postgres 5432, Redis 6379, MinIO 9000 and
a **private** bucket, on identical ports and credentials — no app config differs.

**Path A — WSL2 (works today):**

```bash
npm run wsl:up
```

Runs the three services natively inside WSL2 Ubuntu. WSL relays localhost, so
Windows reaches them on 127.0.0.1 exactly as it would with containers.
`npm run wsl:status` / `npm run wsl:down` to inspect and stop.

**Path B — Docker (needs a reboot first, see §0):**

```bash
npm run infra:up
```

Then, either way:

```bash
npm run db:migrate
```

---

## 4. Run the stack

One command starts all three processes with the shared `.env` loaded, logging
to `.data\logs\`:

```bash
npm run stack:start
```

`npm run stack:status` and `npm run stack:stop` to check and stop. To run them
individually in separate terminals instead:

```bash
cd services/reconstruction && .venv/Scripts/python.exe -m app.main
```

```bash
npm run dev:api
```

```bash
npm run dev:worker
```

Then the app:

```bash
cd apps/mobile && npx expo start --dev-client
```

The mobile app needs a **dev client build**, not Expo Go — `react-native-filament`
and the camera are native modules. Build once with `npx expo prebuild` then
`npx expo run:android` (or `run:ios` on a Mac).

Point the app at your machine's LAN IP, not localhost:

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.x:3000 npx expo start --dev-client
```

---

## 4a. Testing on a phone

The app runs in **Expo Go** — no native build, no Mac, no Apple Developer
account.

> ### The SDK version is pinned to 54. Do not bump it casually.
>
> Expo Go does **not** track the newest SDK. It tracks whatever build Apple
> currently has on the App Store, and that lags — badly. As of this writing the
> newest Expo SDK is **57**, but the App Store ships **Expo Go 54.0.2, last
> updated 2025-09-23**, which only opens **SDK 54** projects. A brand-new
> iPhone on current iOS still gets 54, and the App Store correctly shows "no
> update available".
>
> Before changing `expo` in `apps/mobile/package.json`, check what Apple is
> actually serving:
>
> ```bash
> curl -s "https://itunes.apple.com/lookup?bundleId=host.exp.Exponent" | jq -r ".results[0].version"
> ```
>
> Match the project to that number. `npm view expo dist-tags` tells you what
> Expo has released, which is a different and much less useful question.

1. Install **Expo Go** from the App Store (or Play Store).
2. Put the phone on the **same Wi-Fi** as this PC (`Airtel_Air_Varad`).
3. `npm run stack:start` and `cd apps/mobile && npx expo start --host lan`
4. iPhone: scan the QR with the **Camera** app. Android: scan from inside Expo Go.
   Or open `exp://192.168.1.22:8081` directly.

If the phone's IP subnet changes, update **both**:

- `apps/mobile/.env` → `EXPO_PUBLIC_API_URL`
- repo-root `.env` → `S3_ENDPOINT` (presigned storage URLs go to the device too)

Then restart the API so it re-reads them.

**Two things reliably break this:**

- **A VPN on either device.** A `ProTUN` adapter (10.2.0.2) is active on this
  machine; VPNs commonly block LAN-to-LAN traffic. Disconnect it if the phone
  cannot reach the API.
- **`localhost` anywhere in config.** On a phone that means the phone. Every
  address the device receives must be `192.168.1.22`.

Verify from the phone's browser before blaming the app —
`http://192.168.1.22:3000/v1/health` should return JSON.

### Viewer difference in Expo Go

Expo Go cannot load native modules, so the 3D viewer runs on **expo-gl +
three.js** (`src/features/viewer/ThreeViewer.tsx`). Geometry, proportions and
metric scale render correctly; **embedded GLB textures do not**, because
three.js decodes them through browser APIs React Native lacks. The viewer says
so on screen rather than passing an untextured body off as finished.

The Filament implementation is preserved at
`src/features/viewer/AvatarViewer.filament.tsx` for the dev-client path. To use
it: reinstall `react-native-filament`, switch the export in
`src/features/viewer/index.ts`, drop the tsconfig exclusion, and build a dev
client. On iOS that needs macOS or EAS Build plus a paid Apple Developer
membership.

---

## 5. Verify

**Full user journey against the running stack** — the test that proves the
system works, rather than proving the maths works:

```bash
npm run smoke
```

23 assertions: consent gate, presigned upload, magic-byte verification,
idempotency, live pipeline progress, scale provenance, sensitive-field
withholding, cross-user isolation, GLB download and stature check. It creates a
fresh user each run, so the consent gate is genuinely exercised every time.

**Reconstruction unit + integration tests** (no stack required):

```bash
cd services/reconstruction && .venv/Scripts/python.exe -m pytest tests/ -q
```

25 tests. The integration test stands up a real local HTTP storage server and
feeds synthetic captures through the whole chain. Last run:

```
✔ avatar: 1902 verts, 3768 tris, 625 KB, 172.0 cm, 68% inferred
25 passed
```

**Eyeball a produced avatar** (headless, no device needed):

```bash
services/reconstruction/.venv/Scripts/python.exe scripts/render-preview.py
```

Typecheck everything:

```bash
npm run typecheck --workspaces --if-present
```

Licence gate, both directions:

```bash
npm run verify:licenses
```

```bash
MODEL_TIER=production RECONSTRUCTION_ADAPTER=pshuman npm run verify:licenses
```

The second must **fail with exit 1**. If it ever passes, the gate is broken and
non-commercial weights can reach production.

---

## 6. Switching to real models

The system runs the complete pipeline today with `RECONSTRUCTION_ADAPTER=mock`,
which derives body shape from actual image silhouettes and produces a real
avatar. To move to SAM 3D Body:

```bash
powershell -ExecutionPolicy Bypass -File scripts/download-weights.ps1
```

```bash
cd services/reconstruction && .venv/Scripts/python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
```

Then set `RECONSTRUCTION_ADAPTER=sam3dbody` and `SEGMENTATION_ADAPTER=birefnet`.

**One integration point remains open.** `Sam3DBodyAdapter._load_checkpoint` and
`._forward` raise with instructions rather than guessing at the repo's entry
point. Everything surrounding them — device placement, fp16, VRAM guarding, OOM
handling, subject-crop preprocessing, MHR parameter extraction, camera
conversion — is complete and exercised. Wire those two methods against the real
`facebookresearch/sam-3d-body` API when the weights land.

This was left explicit on purpose: code that looks plausible and fails at
runtime is worse than code that says what it needs.

---

## 7. Deviations from the approved architecture

Each of these was a deliberate call made while building; all are reversible.

| Doc said | Built | Why |
|---|---|---|
| pnpm + Turborepo | **npm workspaces** | Neither `pnpm` nor `uv` is installed here. npm ships with Node 22 and the workspace layout is identical if you switch later. |
| Fastify | **Express** | Bytes never transit the API (presigned uploads), so Fastify's throughput edge is moot, and Express has fewer sharp edges for SSE. |
| Orchestrator owns S1–S3, S11–S12 | **Python owns all media work** | `opencv-python` bundles ffmpeg, removing a system-binary dependency from Node. The invariant that mattered — Node owns *state*, Python owns *pixels* — got cleaner. |
| Upload field `sha256` | **`clientFingerprint`** | Hashing 60 MB on the JS thread blocks the UI for seconds. Real integrity is byte-length + magic-byte sniffing server-side. A field named `sha256` that isn't one is a false assurance. |
| Guided capture with on-device pose/blur ML | **Silhouette overlay, tilt check, timed auto-capture; quality scoring server-side** | Real-time pose analysis needs `react-native-vision-camera` + TFLite and a physical device to validate. The server-side scorer (sharpness, exposure, duplicate, coverage) is built and tested. |

---

## 8. Known gaps

1. **The mobile app has never rendered on a device.** This is now the largest
   unverified surface. Filament API usage is typechecked against the installed
   1.11.0 types, but layout, gestures, camera and the SSE client need a real
   screen. Everything it talks to is proven.
2. **Texture coverage is high-inference (~70%) on synthetic fixtures.** Expect
   better on real captures with genuine 360° video, but the multi-view
   projection in `texture/bake.py` remains the least-validated stage.
3. **Quality scores ~0.44 on a 4-photo capture.** That is the honesty machinery
   working, not a defect: four discrete angles genuinely cover less than a
   slow video turn. Video mode should score materially higher — worth
   confirming once real captures exist.
4. **`S8_RETARGET` (Anny) is skipped**, as scoped. clad.you found Anny's built-in
   regressor underperformed and trained their own; budget real work here.
5. **Performance numbers in `docs/06` are still estimates.** The metadata
   sidecar records per-stage timings — replace that table with measurements
   after the first real GPU runs.
6. **Compliance controls are structural, not reviewed.** Consent ledger, age
   gate, retention TTL and the Illinois block exist in code. A lawyer has not
   looked at the consent copy. Do that before the first external user.

---

## 9. Useful commands

```bash
npm run infra:logs
```

```bash
npm run db:studio
```

```bash
npm run infra:reset
```

MinIO console: `http://localhost:9001` (`tailorai` / `tailorai_dev_secret`).
API health: `http://localhost:3000/v1/health/ready`.
Reconstruction health: `http://localhost:8000/health`.
