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

**Faster fix, no reboot:** quit Docker Desktop, rename the folder holding the
orphaned socket (the file itself can't be deleted, but its parent can be
moved), and start Docker again — it recreates the folder:

```bash
mv "$LOCALAPPDATA/Docker/run" "$LOCALAPPDATA/Docker/run.stale-$(date +%s)"
```

Force-killing Docker Desktop orphans the socket again, so expect to repeat this
after any hard stop.

**Low-RAM machines (≈8 GB).** Uncapped, Docker's WSL2 VM reserves ~3.5 GB and
the other processes fail with "paging file is too small" or `OpenBLAS error:
Memory allocation still failed`. Two settings fix it:

- `%USERPROFILE%\.wslconfig` with `[wsl2]` / `memory=2GB` caps the VM (then
  `wsl --shutdown` and restart Docker). Postgres + Redis + MinIO fit easily.
- `OPENBLAS_NUM_THREADS=2` and `OMP_NUM_THREADS=2` in `.env` stop numpy from
  allocating a buffer per core in the reconstruction service.

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
cd services/reconstruction && py -3.12 -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt pytest pytest-asyncio ruff
```

The venv is machine-specific (it hard-links its base interpreter). After
copying the repo to another machine, delete `.venv` and recreate it.

```bash
cd apps/app_flutter && flutter pub get
```

The app needs Flutter ≥ 3.32 (Dart ≥ 3.8); `flutter upgrade` if older.

Then, with infrastructure up (§3), apply the schema:

```bash
cd apps/api && npx prisma migrate deploy
```

`prisma` reads `DATABASE_URL` from the environment; export it from the root
`.env` first, or use `npm run db:migrate` with it set.

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

**One click:** the **TailorAI** desktop shortcut runs `scripts/start-tailorai.ps1`,
which does everything in order — repairs a copied venv / missing npm links,
starts Postgres, Redis and MinIO in WSL, rebuilds whatever changed, applies
migrations, seeds the catalogue on a fresh database, starts the four services
(waiting for each to be healthy) and opens http://localhost:3001. Press Enter in
its window to stop everything; closing the window leaves TailorAI running, and
running the shortcut again brings the stop prompt back. Same thing from a
terminal:

```bash
npm run launch
```

After moving or copying the repo, recreate the shortcut so it points at the new
location:

```bash
powershell -ExecutionPolicy Bypass -File scripts/install-shortcut.ps1
```

**Just the services** (infrastructure already up, builds current) — starts
reconstruction, API, orchestrator and web with the shared `.env` loaded,
logging to `.data\logs\`. Ports come from `.env` (`RECON_PORT`, `API_PORT`); a
service that is already healthy is left alone:

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

Then the app — see §4a.

---

## 4a. Testing on a phone (Flutter, Android)

The mobile app is **Flutter** (`apps/app_flutter`). It compiles to a native
APK; there is no Expo Go and no cloud build in the loop. This machine already
has everything needed — Flutter 3.32, the Android SDK, and the JDK bundled with
Android Studio.

**Run on a connected Android device (USB debugging on):**

```bash
cd apps/app_flutter && flutter run
```

`flutter run` gives hot reload: edit a `.dart` file, press `r` in the terminal,
the change is on the phone in under a second. `flutter devices` lists what's
connected.

**Or build an APK to sideload:**

```bash
npm run app:apk
# → apps/app_flutter/build/app/outputs/flutter-apk/app-debug.apk
```

### Networking

The app talks to the same backend, over the LAN, at `http://192.168.1.22:3000`
by default (`lib/core/config.dart`). The phone must be on the **same Wi-Fi** as
this PC, and the repo-root `.env` `S3_ENDPOINT` must also be `192.168.1.22`
(presigned storage URLs are handed to the device, so the 3D viewer loads its GLB
from there too).

Two robust alternatives to the LAN IP:

- **USB reverse tunnel** — cleanest, immune to VPN/firewall. With the device
  plugged in:
  ```bash
  adb reverse tcp:3000 tcp:3000 && adb reverse tcp:9000 tcp:9000
  flutter run --dart-define=API_BASE=http://localhost:3000
  ```
  Then also set the repo-root `.env` `S3_ENDPOINT=http://localhost:9000` and
  restart the API, so presigned URLs resolve through the tunnel.
- **Emulator** — use `--dart-define=API_BASE=http://10.0.2.2:3000` (the
  emulator's alias for the host loopback).

**Two things reliably break LAN access:** a VPN on either device (blocks
LAN-to-LAN), and `localhost` left in any address the device receives (on a phone
that means the phone). Verify from the phone's browser first —
`http://192.168.1.22:3000/v1/health` should return JSON.

### The viewer renders textures

`model_viewer_plus` renders the **textured** GLB natively — the whole reason the
frontend moved to Flutter. No dev-client caveat, no untextured fallback.

### Android build config worth knowing

- `minSdk = 23` (`android/app/build.gradle.kts`) — covers webview, camera and
  secure storage.
- `usesCleartextTraffic="true"` in the manifest — the dev backend is plain HTTP
  on the LAN. Remove it for production (HTTPS).

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
Reconstruction health: `http://localhost:<RECON_PORT>/health` (`RECON_PORT` in
`.env`; 8001 on this machine, because another local app holds 8000).
