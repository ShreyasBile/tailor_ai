# TailorAI — Mobile Application

React Native + Expo (D1). iOS and Android from one codebase.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Expo SDK (managed + dev client) | Native modules needed for camera/3D, so a dev client — not Expo Go |
| Navigation | `expo-router` | File-based, typed, deep-linkable (needed for "your avatar is ready" notifications) |
| **3D viewer** | **`react-native-filament`** | Metal on iOS / Vulkan on Android, renders off the JS thread, production-proven at scale |
| Camera | `react-native-vision-camera` | Frame processors — required for on-device quality checks (D4) |
| On-device ML | `react-native-fast-tflite` + VisionCamera worklets | Pose/blur checks at capture time |
| State | TanStack Query + Zustand | Query owns server state; Zustand owns capture-session UI state |
| Storage | `expo-secure-store` (tokens), MMKV (cache) | Tokens must be in the keychain, not AsyncStorage |
| Upload | `expo-file-system` background upload | Survives backgrounding — critical for 60 MB videos |
| Animation | Reanimated 3 + Moti | 60/120 fps on the UI thread |

### Why Filament and not expo-gl/three.js

`expo-gl` uses deprecated OpenGL ES on iOS and renders on the JS thread; `expo-three` has a
documented history of failing on custom GLB models on device. `react-native-filament` uses the
platform-native graphics API and a dedicated render thread pool.

The viewer is the moment the product either lands or doesn't — a user seeing their own body for
the first time. It cannot stutter. This is not a place to economise.

---

## 2. Screens

```
(auth)/          sign-in · consent  ← biometric consent is a blocking gate
(tabs)/
  index          home · latest avatar · "New scan" CTA
  profile        body profile · scan history · settings · delete my data
capture/
  intro          mode choice: 360° video (recommended) | photos
  guide          how-to: fitted clothing, plain background, full body
  session        ★ guided capture
  review         retake or submit
processing/[id]  ★ live progress
viewer/[id]      ★ 3D viewer
```

The three starred screens are the product. Everything else is scaffolding.

---

## 3. Guided capture (D4)

**Rationale:** capture quality dominates final accuracy more than any model choice. A user
standing too close in a dim hallway wearing a puffer jacket produces a bad avatar regardless of
how good SAM 3D Body is. Fixing it at capture costs one milestone; fixing it downstream is
impossible.

### On-device checks, before a frame is ever kept

Running in a VisionCamera frame processor at ~10 fps on a worklet thread:

| Check | Method | Feedback |
|---|---|---|
| Full body in frame | TFLite pose → all keypoints inside safe area | "Step back — we need your feet" |
| Distance | Shoulder-width ratio vs frame | "A bit closer" / "Too close" |
| Lighting | Mean luma + clipping ratio | "Too dark — find a brighter spot" |
| Blur | Laplacian variance on downscaled frame | Silently reject; never store |
| Pose | Wrist-to-hip distance, ankle separation | "Arms slightly away from your body" |
| Device tilt | Accelerometer pitch | "Hold the phone upright" |

**A-pose is requested** (arms ~30–45° from torso, feet shoulder-width). It separates limbs from
the torso, which materially improves both segmentation and shape fitting.

### Video mode

Silhouette overlay + a rotation ring that fills as yaw coverage is achieved. Voice/haptic cue at
each quadrant. Target ~25 s. The ring is driven by **actual estimated yaw**, not a timer — a
user who rotates unevenly gets told, rather than getting a bad scan.

### Photo mode

Four guided shots (front → right → back → left) with auto-capture once all checks pass green for
~500 ms. Single-front-photo is permitted but the app states plainly that the back will be
inferred. Honesty here prevents the "why does my back look wrong" support load.

### What ships to the server

Only frames that pass. A 25 s capture yields ~100 candidates; the app uploads video plus a
`qualityHints` sidecar recording what was rejected and why — which is how we later diagnose bad
reconstructions from real users.

---

## 4. Processing screen

The user is waiting 2–4 minutes. This screen decides whether that feels like progress or
abandonment.

- **Real stages, real names** — "Building your body model", "Painting your texture" — driven by
  the SSE stage feed, not a timer.
- **Never fake it.** If texturing takes 60 s, the bar sits in texturing and says so. A bar that
  lies is worse than no bar.
- **Backgroundable.** Upload and job continue when the app is backgrounded; a push notification
  fires on completion and deep-links to `viewer/[id]`.
- **Reconnect silently.** SSE drops constantly on mobile; `Last-Event-ID` resumes, and after two
  failures it degrades to polling without telling the user anything is wrong.
- **Failures are actionable.** The error taxonomy maps to a specific fix and a retake button —
  `INPUT_TOO_DARK` → "It was too dark. Try again near a window."

---

## 5. The 3D viewer

All requested capabilities, mapped to implementation:

| Requirement | Implementation |
|---|---|
| Rotate / zoom / pan | Filament camera manipulator + Gesture Handler; one-finger orbit, pinch zoom, two-finger pan |
| Lighting | IBL environment + adjustable key light; 2–3 presets (Studio / Soft / Dramatic) |
| Grid | Toggleable ground grid + contact shadow — critical for reading scale |
| Fullscreen | Immersive mode, chrome fades out |
| Wireframe / Solid / Texture | Three material variants swapped on the same mesh |
| Reset camera | Animated return to the framed default |
| Statistics | Vertices, triangles, texture res, file size, live FPS |
| Responsive | LOD ladder; drop to a decimated mesh on low-end devices |

**Additions worth making:**
- **Coverage overlay** — shade regions that were inpainted rather than observed, using the
  `coverage` field from the API. Turns a hidden weakness into visible integrity.
- **Turntable** — slow auto-rotate on load. The first three seconds sell the product.
- **Measurement-ready hooks** — the viewer knows the mesh is a parametric body, so annotation
  anchors are stubbed now even though measurements ship later.

**Performance budget:** GLB under 5 MB, 60 fps on a mid-range Android, first paint under 1.5 s
from cache. Enforced by KTX2 texture compression and Draco geometry compression at export.

---

## 6. Design language

Dark-first, near-black (`#0A0A0B`) rather than pure black, so the 3D viewport reads as the
brightest thing on screen. One accent colour. Type at two weights. Generous negative space.

The premium feel comes from **restraint and motion quality**, not decoration: spring-based
transitions, shared-element handoff from thumbnail to viewer, skeleton loaders that match final
layout, and haptics on meaningful state changes only.

Accessibility is not optional: minimum 4.5:1 contrast, full VoiceOver/TalkBack labelling,
`prefers-reduced-motion` respected, and every capture instruction delivered as text *and* audio —
a user positioning themselves for a photo often cannot see the screen.

---

## 7. Offline & resilience

- Capture works fully offline; uploads queue and drain when connectivity returns.
- Upload state persists across app kill — resumed via `GET /v1/uploads/:id`.
- Last avatar is cached locally and viewable with no network.
- Every mutation carries an `Idempotency-Key`.

---

**Next:** [06-infra-cost-risk.md](06-infra-cost-risk.md)
