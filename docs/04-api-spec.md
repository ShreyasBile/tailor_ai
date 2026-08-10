# TailorAI — API Specification

REST + SSE over HTTPS. `application/json`. Bearer JWT. Base: `/v1`.

Schemas live in `packages/contracts` as zod definitions and are the single source of truth —
the NestJS validation pipe, the OpenAPI document, and the mobile SDK are all generated from
them. There is no second place to update.

---

## 1. Conventions

**Errors** — RFC 9457 Problem Details, plus a closed-taxonomy `code` the client can branch on:

```json
{
  "type": "https://api.tailorai.app/errors/no-person-detected",
  "title": "No person detected",
  "status": 422,
  "code": "NO_PERSON_DETECTED",
  "detail": "We couldn't find a person in your photos. Make sure your full body is visible.",
  "instance": "/v1/jobs/9f2c...",
  "retryable": false
}
```

`detail` is written for a human on a phone screen — never a stack trace, never a model name.

**Idempotency** — `Idempotency-Key` header required on all `POST`s that create resources.
Replaying a key returns the original response.

**Pagination** — cursor-based: `?limit=20&cursor=<opaque>` → `{ data, nextCursor }`.
Offset pagination breaks under concurrent inserts.

**Versioning** — URL-versioned (`/v1`). Breaking changes mint `/v2`; both run during migration.

**Rate limits** — returned as `RateLimit-*` headers. Job creation is limited far harder than
reads (GPU is the scarce resource).

---

## 2. Auth

```http
POST   /v1/auth/session          # exchange provider token → app JWT + refresh
POST   /v1/auth/refresh
POST   /v1/auth/logout
GET    /v1/me
PATCH  /v1/me                    # displayName, heightCm, weightKg, birthYear, sexAtBirth
DELETE /v1/me                    # GDPR erasure → schedules hard purge
GET    /v1/me/export             # GDPR portability → signed archive URL
```

`PATCH /v1/me` matters more than it looks: `heightCm` is the primary scale anchor for S7.

### Consent

```http
GET  /v1/me/consents
POST /v1/me/consents             # { kind, version, granted }
```

**`BIOMETRIC_PROCESSING` consent is enforced at job creation.** Without it, `POST /v1/jobs`
returns `403 CONSENT_REQUIRED`. This is a hard gate, not a UI checkbox.

---

## 3. Capture sessions & uploads

```http
POST /v1/capture-sessions
```
```json
{ "mode": "VIDEO_360", "deviceModel": "iPhone 15 Pro", "qualityHints": { "lighting": 0.82 } }
→ 201 { "id": "...", "status": "UPLOADING", "purgeAfter": "2026-09-06T..." }
```

Returning `purgeAfter` at creation makes the retention promise visible to the client, so the app
can state it plainly rather than burying it in a policy page.

### Resumable multipart upload

```http
POST /v1/capture-sessions/:id/uploads
```
```json
{ "kind": "RAW_VIDEO", "fileName": "capture.mp4", "sizeBytes": 48210432,
  "mimeType": "video/mp4", "sha256": "e3b0c...", "partSizeBytes": 8388608 }
→ 201 {
  "uploadId": "...",
  "parts": [ { "partNumber": 1, "url": "https://...", "expiresAt": "..." }, ... ]
}
```

Client PUTs each part directly to object storage, collecting ETags. Bytes never touch the API.

```http
GET  /v1/uploads/:uploadId                 # → which parts landed (resume after a kill)
POST /v1/uploads/:uploadId/complete        # { parts: [{ partNumber, etag }] }
DELETE /v1/uploads/:uploadId               # abort
```

`complete` verifies size + sha256, sniffs magic bytes, and only then marks the session `READY`.
A client-declared MIME type is never trusted.

---

## 4. Jobs

```http
POST /v1/jobs
```
```json
{ "sessionId": "...", "options": { "quality": "standard", "textured": true } }
→ 202 { "id": "...", "status": "QUEUED", "estimatedSeconds": 180 }
```

Guards: consent present, session `READY`, per-user concurrent-job quota, rate limit.

```http
GET    /v1/jobs/:id
GET    /v1/jobs?status=COMPLETED&limit=20
POST   /v1/jobs/:id/cancel
```

`GET /v1/jobs/:id`:

```json
{
  "id": "...", "status": "TEXTURING", "progress": 0.72,
  "stages": [
    { "name": "S5_BODY_INFERENCE", "status": "SUCCEEDED", "durationMs": 31240 },
    { "name": "S10_TEXTURE_BAKE",  "status": "RUNNING",   "startedAt": "..." }
  ],
  "estimatedSecondsRemaining": 47,
  "result": null
}
```

Exposing real stage records — not a synthetic percentage — is what lets the app show
"texturing, this is the slow part" instead of a bar that lies.

### Live progress (SSE)

```http
GET /v1/jobs/:id/events        # Accept: text/event-stream
```

```
event: stage
id: 7
data: {"stage":"S10_TEXTURE_BAKE","status":"RUNNING","progress":0.72}

event: completed
data: {"jobId":"...","renderId":"...","bodyCoreId":"..."}
```

Supports `Last-Event-ID` for reconnection — essential on mobile, where the app is backgrounded
constantly. Heartbeat comment every 15 s keeps intermediaries from closing the stream.

Fallback: if SSE fails twice, the client degrades to polling `GET /v1/jobs/:id` at 3 s. Mobile
networks are hostile; the happy path must not be the only path.

---

## 5. Body profile

```http
GET /v1/me/body-core                # current
GET /v1/me/body-core/history        # all versions
```

```json
{
  "id": "...", "version": 2, "isCurrent": true,
  "bodyModel": "MHR", "bodyModelVersion": "1.0",
  "scale": { "source": "USER_HEIGHT", "heightCm": 178.0, "confidence": 0.91 },
  "quality": { "overall": 0.84, "frameCount": 16, "captureMode": "VIDEO_360" },
  "createdAt": "..."
}
```

**Raw `shapeParams` are deliberately not returned by default.** They're the crown jewels and the
app doesn't need them to render. Available via `?include=params` for export/portability flows.

---

## 6. Avatars & downloads

```http
GET /v1/avatars/:renderId
```
```json
{
  "id": "...", "bodyCoreId": "...",
  "stats": { "vertexCount": 18439, "triangleCount": 36512, "textureRes": 2048, "fileSizeBytes": 4218880 },
  "isTextured": true, "isDegraded": false,
  "coverage": { "front": 1.0, "back": 0.94, "inpaintedFraction": 0.06 },
  "assets": {
    "glb":       { "url": "https://...", "expiresAt": "..." },
    "thumbnail": { "url": "https://...", "expiresAt": "..." }
  }
}
```

`coverage` is what lets the viewer honestly flag inpainted regions rather than presenting
invented geometry as observed fact.

```http
POST /v1/avatars/:renderId/exports    # { format: "GLB" | "OBJ_ZIP" }
GET  /v1/exports/:id                  # → short-lived signed URL
```

All download URLs are presigned and expire in 5 minutes. No bucket is ever public.

---

## 7. Endpoint summary

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/session` | Sign in |
| GET/PATCH/DELETE | `/v1/me` | Profile, erasure |
| GET/POST | `/v1/me/consents` | Consent ledger |
| POST | `/v1/capture-sessions` | Start a capture |
| POST | `/v1/capture-sessions/:id/uploads` | Presigned multipart |
| GET/POST/DELETE | `/v1/uploads/:id[/complete]` | Resume, finalise, abort |
| POST/GET | `/v1/jobs` | Create, list |
| GET | `/v1/jobs/:id` | Status + stages |
| GET | `/v1/jobs/:id/events` | **SSE progress** |
| POST | `/v1/jobs/:id/cancel` | Cancel |
| GET | `/v1/me/body-core[/history]` | The profile |
| GET | `/v1/avatars/:id` | Render + signed asset URLs |
| POST | `/v1/avatars/:id/exports` | Generate download |
| GET | `/v1/health`, `/v1/health/ready` | Probes |

## 8. Internal contract — orchestrator → GPU service

Not public. Deliberately narrow, so the service stays stateless and relocatable (§02).

```http
POST /infer/segment      { frames: [signedUrl] }        → { masks: [signedUrl] }
POST /infer/body         { frames: [signedUrl] }        → { perFrame: [{ shape[], pose[], camera }] }
POST /infer/texture      { meshRef, frames, cameras }   → { atlasRef, coverage }
GET  /health             → { ready, gpu, vramFreeMb, loadedModels[] }
```

The GPU service receives signed URLs, never blobs, and returns refs, never blobs — so moving it
to a rented GPU changes latency and nothing else.

---

**Next:** [05-mobile-app.md](05-mobile-app.md)
