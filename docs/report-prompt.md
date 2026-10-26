You are a technical writer preparing a formal academic project report. Produce a polished, print-ready **PDF** of **11–12 A4 pages** for the project described below. If you cannot output a PDF directly, output a complete single-file HTML document (with print CSS for A4) or LaTeX source that I can convert to PDF without changes.

Use ONLY the facts in the "PROJECT FACTS" section. Do not invent numbers, results, features, or citations. Where something must be filled in by me, leave a clearly visible placeholder in [SQUARE BRACKETS, bold].

=====================================================================
EDIT THESE BEFORE SENDING (cover page details)
=====================================================================
Project title:        [TailorAI — Body Intelligence: Photo-Based Body Measurement, 3D Body Model and Size Recommendation]
Report type:          [Major Project Report / Mini Project Report]
Submitted by:         [Student Name 1] — [Roll No. / PRN]
                      [Student Name 2] — [Roll No. / PRN]
                      [Student Name 3] — [Roll No. / PRN]
                      [Student Name 4] — [Roll No. / PRN]
Under the guidance of:[Guide Name], [Designation]
Department:           [Department of Computer Engineering]
College:              [College Name, City]
University:           [University Name]
Academic year:        [2026–27]
College logo:         [leave a 3 cm × 3 cm box labelled "College Logo"]

=====================================================================
FORMATTING RULES
=====================================================================
- A4, margins 2.5 cm, body font 11 pt serif (e.g. Times New Roman / Libertinus), headings in a clean sans-serif, line spacing 1.15, justified text.
- Header on every page except the cover: project short name (left) and "[College Name]" (right). Footer: page number centred.
- Numbered headings (1, 1.1, 1.2 …). Numbered figures ("Fig. 3.1 …") and tables ("Table 5.2 …") with captions.
- Every diagram must be a real drawn diagram (boxes, arrows, swimlanes), not text in a box. Use neutral colours (navy, grey, one accent), readable in black-and-white print.
- Where a screenshot belongs, insert a grey placeholder frame with the caption text, e.g. "[Insert screenshot: Find my size panel]". I will paste the screenshots myself.
- Prefer tables and diagrams over long paragraphs. No filler, no marketing tone. Write in third person ("the system", "the fit engine").
- Total length must be 11–12 pages. Follow the page plan below closely.

=====================================================================
PAGE PLAN (follow this order and size)
=====================================================================
Page 1 — Cover page: everything from the "EDIT THESE" block, centred, with the logo box at top.

Page 2 — Abstract (150–200 words) + Keywords (6–8) + Table of Contents with page numbers.

Page 3 — 1. Introduction
  1.1 Problem statement: wrong sizes are a leading cause of online apparel returns; brand size charts are inconsistent; shoppers don't know their own measurements.
  1.2 Objectives (bullet list, from PROJECT FACTS §A).
  1.3 Scope: what is in scope and what is explicitly out of scope (§A).

Page 4 — 2. Background and Technology Choices
  2.1 Approaches to body measurement from images (2-D keypoints + geometry vs. 3-D human mesh recovery).
  2.2 Model selection and licensing: table comparing SMPL-based models, SAM 3D Body, MediaPipe Pose and Anny, using §C. Explain why the MVP uses MediaPipe Pose + geometric measurement + Anny.
  2.3 Technology stack table (layer → technology → purpose) from §B.

Page 5 — 3. System Architecture (part 1)
  Fig. 3.1: layered architecture diagram: Web app (Next.js) / Mobile app (Flutter) → API gateway (NestJS) → {PostgreSQL, Redis+BullMQ, S3 object storage} → Orchestrator (Node worker, job state machine) → Reconstruction service (Python FastAPI, stateless) → {MediaPipe Pose, Anny, fit engine, optional Gemini}.
  3.1 Component responsibilities (one short paragraph or table row each).
  3.2 Key design principles from §D (Body Core vs Appearance Shell; adapters; Node owns state, Python owns pixels; no request blocks on AI work).

Page 6 — 3. System Architecture (part 2)
  Fig. 3.2: deployment diagram of the local Windows stack with ports (§E).
  3.3 Monorepo structure (compact tree from §E).
  3.4 Licence gate (ADR-2) explained in 3–4 lines.

Page 7 — 4. Workflows (part 1)
  Fig. 4.1: end-to-end user journey flowchart (§F.1).
  Fig. 4.2: scan-processing sequence diagram with lanes Browser, API, Object storage, Orchestrator, Reconstruction service, Database (§F.2).
  Fig. 4.3: job state machine (§F.3), small.

Page 8 — 4. Workflows (part 2)
  Fig. 4.4: "Find my size" recommendation workflow (§F.4).
  Fig. 4.5: 3D try-on fit-map workflow (§F.5).
  4.x Short text for photo try-on with Gemini (§F.6) and the feedback / accuracy loop (§F.7).

Page 9 — 5. Core Algorithms
  5.1 Scan quality gate (§G.1).
  5.2 Measurement engine: steps + the girth formula (§G.2).
  5.3 3D body fitting with Anny (§G.3).
  5.4 Fit engine: formulas, weights table, blocking rule, confidence (§G.4). Typeset the formulas properly.

Page 10 — 6. Data Model and API
  6.1 Table of the main database tables with one-line purpose each (§H).
  Fig. 6.1: simplified ER diagram (User → CaptureSession → ReconstructionJob → BodyCore → BodyMeasurement; Brand → SizeChart → SizeChartEntry; Garment → Recommendation → FitFeedback; User → Consent, TapeCheck).
  6.2 Table of key REST endpoints grouped by module (§I).

Page 11 — 7. Testing and Results
  7.1 Test suites table (§J.1).
  7.2 Measurement accuracy table on BodyM (§J.2) with the "how to read these numbers" notes.
  7.3 3D body agreement and performance (§J.3).
  7.4 Two screenshot placeholders side by side: "[Insert screenshot: Body Profile with 3D model]" and "[Insert screenshot: Find my size + try-on]".

Page 12 — 8. Privacy and Security, 9. Limitations, 10. Future Scope, 11. Conclusion, References
  Privacy/security bullets (§K), limitations (§L), future scope (§M), a 5–6 line conclusion, and References in IEEE style (§N). Do not invent DOIs, page numbers or years that are not given; write [verify] where a detail is missing.

=====================================================================
PROJECT FACTS (the only source of truth)
=====================================================================

§A. Goal, objectives, scope
- Goal: turn four phone photos (front, back, left, right) plus the user's height into accurate body measurements, a realistic rigged 3D body, a persistent "Body Profile", and a size recommendation for any garment with a transparent fit score and explanation.
- Product loop: basic details → 4 photos → validation → measurement → 3D body → Body Profile → select garment → size recommendation → fit score + explanation → feedback.
- Objectives: (1) reject bad photos with specific fix-it messages; (2) estimate 11 body measurements with per-measurement confidence; (3) fit a realistic 3D body to all measurements; (4) recommend a size per brand size chart, cut, fabric stretch and user preference; (5) visualise fit on the user's own body; (6) measure accuracy against a tape measure; (7) treat body data as sensitive biometric data.
- The 11 measurements: height, chest, waist, hip, shoulder width, inseam, thigh, arm length, neck, torso length, calf.
- In scope: web app (main MVP), API, job pipeline, AI service, catalogue of 34 outfits from 6 demo brands (including Indian wear: kurtas, anarkali, Nehru jacket), admin page to add outfits.
- Out of scope (deliberately cut): video scanning in the MVP, body-shape classification, animations, analytics, a machine-learned fit model (rules first; feedback is stored to train one later), cloud deployment.

§B. Technology stack
- Web: Next.js 15.5, React, Tailwind CSS, React Three Fiber (three.js) for the 3D viewer and try-on.
- Mobile: Flutter (Dart), model_viewer_plus, camera, go_router, provider (built, not yet run on a device).
- API gateway: NestJS (Express), Prisma ORM, PostgreSQL, Redis + BullMQ queue, S3-compatible object storage (SeaweedFS on Windows, MinIO on Docker/WSL), Server-Sent Events for live progress.
- Orchestrator: Node.js/TypeScript worker that owns the job state machine.
- AI service: Python 3.12, FastAPI, PyTorch (CPU), OpenCV, MediaPipe Pose (heavy model), Anny body model.
- Optional AI: Google Gemini — gemini-3.5-flash-lite (size explanations, size-chart reading, opt-in photo check), gemini-3.1-flash-lite-image (product photos), gemini-nano-banana-2.1 (photo try-on).
- Shared: npm workspaces monorepo; a "contracts" package of shared zod schemas; a "model-registry" package with licences.json.
- Testing: pytest, end-to-end Python scripts against the running stack, headless Microsoft Edge screenshots.

§C. Model choice and licensing
- SMPL-based reconstruction models (HMR2.0/4D-Humans, ECON, SIFU, PSHuman, LHM, SiTH): SMPL's licence forbids commercial use and commercial training; several also need 24–40 GB of GPU memory. Rejected.
- SAM 3D Body (Meta): commercially licensed, outputs MHR body parameters, needs an 8 GB NVIDIA GPU. Kept behind an adapter as the future high-accuracy path; the development laptop has no such GPU.
- MediaPipe Pose (Google, Apache-2.0): person detection, 33 keypoints, segmentation, runs on CPU. Used for the scan.
- Anny (NAVER LABS; Apache-2.0 code, CC0 MakeHuman assets): rigged parametric human body, 13,718 vertices, 27,420 triangles, 104-bone skeleton, runs on CPU. Used as the scan's 3D body model.
- BiRefNet (matting) and xatlas (UV unwrap) exist behind adapters for the video/texture path.

§D. Design principles
1. Body Core vs Appearance Shell: the Core is a ~2 KB parametric body (shape parameters, skeleton, metric scale) that is the user's permanent identity; the Shell (mesh + texture, ~5 MB) is disposable and can be regenerated. Upgrading the AI model never invalidates an old profile.
2. Every AI model sits behind an adapter; swapping a model is a config change (e.g. SCAN_BODY_MODEL, RECONSTRUCTION_ADAPTER).
3. Node owns state, Python owns pixels: the Python service is stateless (no DB, no queue, no auth) and can be moved to a cloud GPU by changing one URL; a crash there loses no job state.
4. Jobs are resumable state machines; each stage is retried with its own policy.
5. No request blocks on AI work; everything after upload is queued and progress is streamed with SSE.
6. Photo bytes never pass through the API: the browser uploads directly to object storage via presigned URLs; the server then checks size and file magic bytes.
7. Biometric data is treated as high-risk by default (consent gate, retention TTL, deletion).

§E. Deployment (local Windows stack, no Docker needed) and repo layout
- Ports: web app 3001; API 3002 (prefix /v1); reconstruction service 8001; PostgreSQL 5433 (project-local cluster); Redis 6379; SeaweedFS S3 API 9000.
- One-click launcher script starts storage, database, queue, builds, migrations, seeding, the four services, and opens the browser.
- Repo layout:
  apps/web (Next.js) · apps/api (NestJS + Prisma) · apps/app_flutter (Flutter)
  services/orchestrator (Node worker) · services/reconstruction (Python FastAPI: scan/, fit/, bodymodel/, llm/, adapters/)
  packages/contracts · packages/model-registry · packages/config
  infra/ (Docker compose) · scripts/ (launcher, tests, validation) · docs/
- Licence gate (ADR-2): every model declares {id, license, commercial_ok, source_url, sha256}; `verify-licenses` fails the build if a non-commercial model is reachable when MODEL_TIER=production. Shipping a non-commercial model requires deliberately deleting a CI check.

§F. Workflows
F.1 User journey: Sign in → Onboarding (height in cm or ft/in, weight, sex, fit preference snug/regular/loose, explicit biometric consent) → Scan page (4 photo slots with pose guides; upload or phone camera; photos normalised in browser: EXIF rotation, max 2048 px, JPEG) → "Measure my body" → live progress → Body Profile (rotatable 3D body, 11 measurement cards with confidence and ± typical error, cm/in toggle, clicking a measurement draws it on the body) → Shop → product page → Find my size / 3D try-on / Photo try-on → feedback → optional Accuracy page (tape check).
F.2 Scan processing: browser creates a capture session → API returns presigned upload URLs → browser uploads 4 photos straight to object storage → API verifies size + magic bytes → API checks BIOMETRIC_PROCESSING consent (403 CONSENT_REQUIRED if missing) and creates a job with an Idempotency-Key → job queued in BullMQ → orchestrator runs stages, calling the Python service; stage S3B_SCAN_ANALYZE calls POST /scan/analyze (quality gate → pose/segmentation → measurements with confidence → Anny fit) → POST /mesh/build produces a GLB at the user's exact height → results saved (BodyCore, BodyMeasurement, AvatarRender) → progress events published to Redis and streamed to the browser over SSE. If a photo is rejected, the job fails with a note on exactly that photo and only that slot is flagged for a retake. A four-photo scan completes in roughly 20–80 s on a laptop CPU.
F.3 Job states: QUEUED → VALIDATING → EXTRACTING → SELECTING → SEGMENTING → RECONSTRUCTING → FUSING → TEXTURING → OPTIMISING → EXPORTING → COMPLETED, with FAILED and CANCELLED as exits. Retry policy per failure type: service unreachable → exponential backoff (5 attempts); GPU out-of-memory → retry once smaller; bad input → no retry, specific message; texture failure → degrade to untextured mesh and continue.
F.4 Find my size: product page → POST /v1/garments/:slug/recommend → API loads the user's latest measurements (value + confidence), the garment (category, subcategory, cut: slim/regular/relaxed/oversized, stretch: none/low/medium/high) and the brand's size chart → Python POST /fit/recommend scores every size → returns recommended size, 0–100 fit score and label, alternative size, "between sizes" flag, confidence (value + label), per-dimension verdicts for every size, sizes that are too small, and an explanation → optional Gemini rewrite of the explanation (numbers only are sent; rewrite is discarded if it does not name the recommended size or is too long; falls back to the rules text on any error) → stored as a Recommendation → user switches Snug/Regular/Loose to see the size change.
F.5 3D try-on fit map: the garment is drawn as a shell around the user's own Anny body, offset by ease (design ease for the garment type × cut factor from 0.6 for slim to 2.2 for oversized + the fit engine's room for the chosen size); the body is split into torso/arms/legs/hands by slicing into 140 horizontal bands; sleeves end at the size's arm length, trouser hems at crotch minus inseam; each zone is coloured by the engine's verdict (red too tight, amber snug, green good, blue loose, grey = unsure measurement). Size buttons reshape it instantly because every size's detail is already returned.
F.6 Photo try-on (optional): user ticks a consent box per request → front scan photo + product photo → Gemini image model → image of the user wearing the garment, returned inline and never stored. Labelled a style preview; fit is judged by the fit map, not the image.
F.7 Feedback and accuracy loop: after buying, the user marks perfect / too small / too large / kept / returned (FitFeedback) — the training signal for a future learned model. On the Accuracy page the user enters tape measurements (input boxes never show the scan value, to avoid anchoring); target is ±3 cm for girths and ±2 cm for lengths; GET /v1/accuracy/report aggregates MAE, bias and % within 2/4 cm across testers.

§G. Core algorithms
G.1 Quality gate: 16 checks per photo — resolution (judged by how many pixels tall the person is; ≥ ~350 px keeps error ~1–2 cm), exposure, blur, framing, distance, person present, clutter, wrong view, pose, and others — each with a fix-it message. Optional Gemini photo check (off by default) can only add warnings (loose clothing, hair over neck, arms against body).
G.2 Measurement engine: (1) scale each view from the user's height (cm per pixel per view); (2) locate measurement heights from detected joints and silhouette landmarks (shoulder line, armpit line, crotch notch) rather than fixed ratios; (3) widths from front/back views, depths from left/right views; girth = ellipse perimeter (Ramanujan) × ANSUR II cross-section shape factor (chest 1.10, waist/hip 1.065); (4) each measurement gets a confidence; values outside the plausible human range for the height keep their value but get reduced confidence and a note.
G.3 Anny fitting: the mesh is measured exactly like the scan measures a person (tape-style convex girths at the scan's own heights). Solve: sex from profile; height slider; weight slider to mean torso girth (secant method); then 12 local tape-measure changes (bust, waist, hips, neck, thigh, calf, shoulder, upper/lower leg, upper/lower arm, nape-to-waist) by damped Gauss–Newton with residuals weighted by measurement confidence (readings under 0.25 confidence ignored); finally scale uniformly to exact height. Stored as BodyCore with bodyModel = ANNY and 6 phenotype + 12 local-change parameters. Fit time 5–14 s on CPU.
G.4 Fit engine (rules-based, explainable; engine version fit-rules-v2):
  - Category weights: Tops — chest 0.45, shoulders 0.20, waist 0.15, sleeve 0.10, neck 0.10. Outerwear — chest 0.45, shoulders 0.25, sleeve 0.15, waist 0.15. Bottoms — waist 0.45, hip 0.35, inseam 0.15, thigh 0.05. Dresses — chest 0.35, waist 0.35, hip 0.30. Irrelevant measurements are dropped by style (no sleeve length on tees/polos/sleeveless; neck only for collared shirts).
  - Target position in a size's range: t = preference (snug 0.72, regular 0.50, loose 0.25) + cut shift (slim −0.20, regular 0, relaxed +0.12, oversized +0.22), clamped to [0.05, 0.95]. Lengths use t = 0.5.
  - ideal = lo + t·(hi − lo); room = ideal − body.
  - Score per dimension = exp(−(room/σ)²), asymmetric: if too tight σ = 0.4·width + stretch allowance (none 0, low 1.5, medium 3, high 5 cm); if loose σ = max(0.8·width, a per-dimension floor). Extra penalties when beyond the range.
  - Size score = Σ score·weight·trust / Σ weight·trust, where trust = 0.3 + 0.7·confidence (an uncertain measurement counts less).
  - Blocking: a girth that must close (chest, waist, hip, thigh) more than 2 cm past the stretch allowance blocks the size (score capped at 15), unless that measurement's confidence is below 0.4. Blocked sizes rank below all wearable sizes and are shown crossed out as "too small"; if even the largest is blocked the result says no size fits.
  - Confidence = weighted measurement confidence × separation between best and second-best size (min(1, 0.6 + 4·gap)). Labels: high ≥ 0.7, medium ≥ 0.5, else low. Fit labels: Great ≥ 85, Good ≥ 70, Fair ≥ 50, else Poor.
  - Output also includes "outsideCm" — the single number shown everywhere: how far the body is outside the size's range.

§H. Database (PostgreSQL via Prisma) — main tables
User · RefreshToken · Consent (versioned ledger with IP and timestamp) · CaptureSession · Asset · Upload · ReconstructionJob · JobStage (status, attempt, timings, input/output refs per stage) · BodyCore (bodyModel ANNY/MHR, shape parameters, scale source) · AvatarRender · Export · BodyMeasurement (versioned with BodyCore) · Brand · SizeChart · SizeChartEntry · Garment (category, subcategory, cut, stretch, price, image) · Recommendation (full engine output stored) · FitFeedback · TapeCheck · PhotoTryOn.

§I. Key REST endpoints (prefix /v1)
- auth: POST /auth/session, /auth/refresh, /auth/logout
- users: GET/PATCH/DELETE /me, GET/POST /me/consents, GET /me/export (data export)
- uploads: POST /capture-sessions, POST /capture-sessions/:id/uploads, POST /uploads/:id/complete, POST /capture-sessions/:id/finalise
- jobs: POST /jobs, GET /jobs, GET /jobs/:id, GET /jobs/:id/events (SSE), POST /jobs/:id/cancel
- avatars: GET /me/avatar, /me/body-core, /me/body-core/history, /me/measurements, POST /avatars/:id/exports
- catalog: GET /brands, /garments, /garments/:slug, POST /garments/:slug/recommend, POST /recommendations/:id/feedback, GET /me/recommendations, POST /garments/:slug/photo-tryon
- accuracy: POST/GET /me/tape-checks, GET /accuracy/report
- admin: POST /admin/size-chart/read (Gemini reads a size-chart image), POST /admin/garments, POST /admin/product-photo
- health: GET /health, /health/ready
- Python service (internal, API-key protected): POST /scan/analyze, /fit/recommend, /mesh/build, /measure, /process-scan, /tryon/photo, /catalog/read-size-chart, /catalog/product-photo

§J. Testing and results
J.1 Test suites: Python unit + integration tests — 85 passed (scan, measurements, fit engine, pipeline, Gemini fallbacks, end-to-end with a local storage server); `npm run smoke` — 23 assertions on the running backend (consent gate, presigned upload, magic-byte check, idempotency, live progress, scale provenance, sensitive-field withholding, cross-user isolation returns 404, GLB download and stature check); `npm run test:mvp` — 21 assertions on the full product journey from a fresh account; headless Edge screenshots of every page including the WebGL try-on.
J.2 Measurement accuracy on BodyM test set A (87 real people, tape-measured ground truth; used for evaluation only, nothing trained on it):
  Measurement | MAE cm | Median cm | Bias cm | within 2 cm | within 4 cm
  Waist | 3.27 | 1.89 | −0.32 | 52% | 70%
  Inseam | 2.59 | 2.10 | +0.91 | 48% | 83%
  Calf | 1.95 | 1.97 | −1.28 | 53% | 94%
  Hip | 3.31 | 2.45 | +0.64 | 40% | 72%
  Shoulder width | 3.31 | 3.25 | +3.03 | 17% | 70%
  Arm length | 3.56 | 3.22 | +3.37 | 22% | 68%
  Chest | 5.23 | 3.83 | −0.86 | 33% | 51%
  Thigh | 5.89 | 5.16 | −2.20 | 21% | 33%
  Notes: uses only 2 of 4 views (BodyM has front + side silhouettes only); joints detected on silhouettes, not photos, which is harder; two people with a tape typically disagree by 1–3 cm, so waist, hip, inseam and calf are near that level while chest and thigh are not yet. These MAEs are shown in the app as each measurement's "± typical error".
J.3 Anny agreement with the scan (sample male scan, cm): chest −0.1, waist +0.1, hip 0.0, neck +0.2, calf −0.2, arm −1.4, shoulder +1.6, inseam +2.6, torso length +2.6, thigh +8.5 (thigh confidence was 0.11, deliberately down-weighted). Synthetic female 162 cm: every girth within 0.5 cm. Performance: scan ~20–80 s on CPU; Anny fit 5–14 s; first Anny load builds a cache (~90 s), then loads in under 1 s.

§K. Privacy and security
- Body scans are treated as biometric data (GDPR Art. 9, Illinois BIPA): explicit versioned consent ledger; biometric consent is a hard gate on job creation (403); 18+ age gate; raw-photo retention TTL set at capture (purgeAfter); deletion reaches object storage, not only the database; user data export endpoint.
- Capture asks for fitted clothing, not underwear.
- Every query is scoped by userId at the repository layer; cross-user reads return 404.
- Presigned URLs are short-lived; buckets are private; magic-byte sniffing and size caps on uploads; secrets come from environment variables validated at boot; logs never contain image data or tokens.
- Gemini features are optional and fall back to rules on any error; only numbers are sent for explanations; the photo check is off by default; photo try-on needs per-request consent and its image is never stored.

§L. Limitations
1. No real four-photo accuracy study with tape measurements yet (the Accuracy page is the instrument; 10–20 people needed).
2. Chest and thigh are the weakest measurements (MAE 5–6 cm); loose clothing inflates girths and is not yet detected automatically.
3. The 3D body is a fitted parametric model, not a scanned surface; the try-on is a geometric fit map, not cloth simulation (no folds or drape).
4. Fit engine is rule-based; garment ease is a per-type rule because demo brands publish body charts, not garment measurements. Size charts are realistic but invented.
5. Login is development-only; the app runs locally, not in the cloud; the Flutter app has not been run on a device.

§M. Future scope
Real-person accuracy study; SAM 3D Body on a GPU for true 3D reconstruction; 360° video scanning; a learned fit model trained on FitFeedback and returns; fit-intent-aware ease (extra room for oversized/relaxed cuts) and per-style weights (e.g. dropped shoulders); automatic loose-clothing detection; garment-measurement charts from real brands; cloth simulation on Anny's skeleton; production auth (Clerk/Supabase) and cloud deployment; mobile app release.

§N. References (format in IEEE style; do not add details not listed — mark missing ones [verify])
1. V. Bazarevsky et al., "BlazePose: On-device Real-time Body Pose Tracking," 2020 (MediaPipe Pose).
2. NAVER LABS Europe, "Anny" parametric human body model, 2025 [verify].
3. Meta AI, "SAM 3D Body" [verify year/venue].
4. M. Loper et al., "SMPL: A Skinned Multi-Person Linear Model," ACM TOG, 2015.
5. BodyM dataset — N. Ruiz et al., "Human Body Measurement Estimation with Adversarial Augmentation," 2022.
6. C. Gordon et al., "2012 Anthropometric Survey of U.S. Army Personnel (ANSUR II)," 2014.
7. P. Zheng et al., "Bilateral Reference for High-Resolution Dichotomous Image Segmentation (BiRefNet)," 2024.
8. Documentation: Next.js, NestJS, Prisma, BullMQ, FastAPI, three.js / React Three Fiber, Google Gemini API.
9. Regulation (EU) 2016/679 (GDPR), Art. 9; Illinois Biometric Information Privacy Act (BIPA), 740 ILCS 14.

=====================================================================
FINAL CHECK BEFORE YOU OUTPUT
=====================================================================
- 11–12 pages exactly; cover page fields left as editable placeholders.
- At least 8 drawn figures: architecture, deployment, user journey, scan sequence, job state machine, find-my-size flow, try-on flow, ER diagram.
- At least 6 tables: tech stack, model comparison, fit weights, database tables, API endpoints, accuracy results, test suites.
- All numbers match PROJECT FACTS exactly; nothing invented.
- Table of contents page numbers match the final layout.
