# 08 — Realistic body, virtual try-on, accuracy study, Gemini

What was added on top of the Body Intelligence MVP ([07](07-body-intelligence-mvp.md)),
how each part works, and how it was verified.

```
4 photos ─► measurements (11, with confidence + body height of each)
              │
              ├─► Anny body fitted to all 11 ─► GLB (13.7k verts, rigged)
              │                                    │
              │        size chart + cut + stretch  ▼
              ├─► fit engine (every size) ─► try-on: garment shell on YOUR body,
              │         │                    coloured by fit, per size
              │         └─► explanation ─► (optional) Gemini rewrite, numbers only
              │
              └─► tape check ─► scan-vs-tape per person ─► group accuracy report
```

---

## 1. Realistic body — Anny

| | Before | Now |
|---|---|---|
| Body model | hand-made loft of ellipses (`bodymodel/humanoid.py`) | **Anny** (NAVER LABS, Apache-2.0 code, CC0 MakeHuman assets) |
| Mesh | ~1.9k vertices, no skeleton | 13,718 vertices, 27,420 triangles, 104-bone skeleton |
| Fitted to | chest, waist, hip | all 11 scan measurements, at the heights the scan measured them |

**Code:** `services/reconstruction/app/bodymodel/anny_body.py` (load, build, frame
conversion), `app/scan/anny_fit.py` (measure + fit).

**How the fit works.** The mesh is measured exactly the way the scan measures a
person — tape-style convex girths at the scan's own heights, shoulder joints +
acromion offset, the shoulder→elbow→wrist joint chain, crotch height from the
geometry — then Anny's sliders are solved until the two agree:

1. gender from the profile; the height slider so proportions suit the stature;
2. the weight slider to the mean torso girth (secant);
3. twelve tape-measure local changes (bust, waist, hips, neck, thigh, calf,
   shoulder, upper/lower leg, upper/lower arm, nape-to-waist) by damped
   Gauss–Newton, residuals weighted by each measurement's confidence. Local
   changes are linear blendshapes, so the basis is built once (12 forwards)
   and each solver step is a matrix product plus a few mesh slices.

The mesh is then scaled uniformly to the user's exact height.

**Measured agreement** (mesh vs. scan, cm), sample scan, male: chest −0.1,
waist +0.1, hip 0.0, neck +0.2, calf −0.2, arm −1.4, shoulder +1.6, inseam +2.6,
torso length +2.6, thigh +8.5 (scan thigh confidence 0.11 — down-weighted on
purpose). Synthetic female, 162 cm: every girth within 0.5 cm. Fit time 5–14 s
on a laptop CPU.

**Storage.** `BodyCore.bodyModel = ANNY`, `shapeParams` = 6 phenotypes + 12
local changes. Older profiles keep `MHR` and the humanoid; `/mesh/build`
dispatches on `bodyModel`, so nothing old breaks. `SCAN_BODY_MODEL=humanoid`
switches Anny off.

## 2. Virtual try-on — the fit map

**Code:** `apps/web/src/lib/tryon.ts` (geometry), `components/tryon-viewer.tsx`,
the product page's *Try it on* tab.

The garment is a shell offset from the user's own body by its **ease** —
garment circumference minus body circumference — at every height:

* ease per zone = design ease for this garment type × cut (slim 0.6 … oversized
  2.2) + the fit engine's `roomCm` for the chosen size;
* the body is split into torso / arms / legs / hands by slicing it into 140
  horizontal bands and labelling the blobs; the crotch is found from the
  geometry, not assumed;
* sleeves end at the size's arm length, trouser hems at crotch − the size's
  inseam; skirts, dresses, kurtas and coats hang as a tube below the hip,
  widened wherever a thigh would poke through;
* every zone is coloured by the engine's own verdict — red too tight, amber
  snug, green good, blue loose — so the picture and the numbers always agree.

The fit engine now returns per-dimension detail for **every** size, so the size
buttons reshape the garment instantly with no round trip.

It is deliberately geometric, not cloth simulation: it shows the truth about
fit at interactive speed. Real garment meshes on Anny's skeleton are the next
step for looks.

## 3. Accuracy study

**Code:** `apps/api/src/modules/accuracy`, page `/accuracy`, table `TapeCheck`.

A user enters tape measurements (with a how-to for each). The page shows scan
vs. tape with ✓ inside the target (±3 cm girths, ±2 cm lengths — two people with
a tape disagree that much). `GET /v1/accuracy/report` aggregates every tester's
latest check: MAE, bias, % within 2/4 cm per measurement, plus the share of size
feedback marked *perfect*. The input boxes deliberately never show the scan's
value, so it cannot anchor the tape reading.

## 4. Gemini (optional)

**Code:** `services/reconstruction/app/llm/gemini.py`. Off unless
`GEMINI_API_KEY` is set; every feature falls back to the rules-based behaviour
on any error or timeout.

| Feature | Model | Sent to Google | Default |
|---|---|---|---|
| Size explanation rewrite | `gemini-3.5-flash-lite` | numbers only: sizes, cm, verdicts, cut, stretch | on with a key |
| Scan photo check (loose clothing, hair over neck, arms against body) | `gemini-3.5-flash-lite` | the four scan photos | **off** (`GEMINI_PHOTO_CHECK`) — biometric data |
| Size-chart reading (admin) | `gemini-3.5-flash-lite` | the chart image | on with a key |

Guards: a rewrite that doesn't name the recommended size, or runs long, is
discarded; the photo check only ever adds *warnings*; chart numbers are
normalised by plain code (inches → cm, single values → ranges meeting halfway,
centre-back sleeves left out with a warning, garment-measurement charts flagged).
The API rejects deadlines under 10 s; explanations use 12 s, photos/charts 45 s.

## 4b. Fit engine v2 — sizes that can't close

Found on a real scan (chest 98.7, waist 100.6): a tee recommended **M** with
the waist 12.6 cm too small, because tops weight the waist at 15%. Now:

* any girth that has to close (chest, waist, hip, thigh) more than 2 cm past
  the stretch allowance **blocks** the size, whatever its weight — unless the
  measurement's confidence is below 0.4 (a thigh read through loose trousers);
* blocked sizes score ≤ 15 and are crossed out "too small" on the size
  buttons; the explanation names the next size down and why it won't close;
  if even the largest can't close, it says so (`noSizeFits`);
* "size up for a looser feel" is suppressed when the chosen size is already
  loose in a key dimension;
* every dimension carries **one** number shown everywhere — `outsideCm`, the
  distance from the size's range — used by the size bars, the try-on labels
  ("Waist 13 cm too small"), the try-on geometry and Gemini's text;
* measurements under 0.3 confidence are drawn grey ("unsure") in the try-on,
  and the Anny fit ignores readings under 0.25 confidence.

## 4c. Product photos and photo try-on

* **Product photos:** `scripts/make-product-photos.py` makes one per garment
  with `gemini-3.1-flash-lite-image` from its own description, colour and
  material (no third-party photography to license) →
  `apps/web/public/garments/<slug>.jpg`, linked by `npm run db:seed`
  (`Garment.imageUrl`). The add-outfit page can generate one too, or take an
  https link the admin may use.
* **Photo try-on** (product page → *Photo try-on*): the shopper's own front scan
  photo + the product photo → `gemini-nano-banana-2.1` → the shopper wearing
  it, same face, body, pose and background. Explicit consent checkbox per
  request (`consent: true` is required by the API); the image is returned
  inline and never stored. Labelled a style preview: image models always make
  clothes look good, so fit comes from the fit map.

## 5. Catalogue

34 outfits, 6 brands (two new: Desi Loom — Indian sizing, Stride — athleisure),
including kurtas, anarkali, Nehru jacket, blazers, hoodies, joggers, leggings,
shorts and skirts. `/admin/outfits` adds more: Gemini reads a size-chart image
into an editable table, then brand, cut, stretch, price (₹/$/€/£) and colour.
Admins: `ADMIN_EMAILS`; empty means every signed-in user on a local dev stack.

## 6. Verification

| Suite | Command | Result |
|---|---|---|
| Unit + integration | `cd services/reconstruction && .venv/Scripts/python.exe -m pytest tests/ -q` | 78 passed |
| Backend journey | `npm run smoke` | 23 passed |
| Product journey | `npm run test:mvp` | 21 passed |
| Browser | headless Edge screenshots of every page incl. WebGL try-on | rendered as designed |

## 7. Limitations

1. The try-on is a fit map, not cloth: no folds or drape physics.
2. Anny's thigh and torso length lag the other measurements by 2–8 cm when the
   scan's own reading is low-confidence.
3. No real-person accuracy study has been run yet — the `/accuracy` page is the
   instrument; the numbers in [07 §5](07-body-intelligence-mvp.md) are still
   the BodyM silhouette benchmark.
4. Garment ease is a per-type rule; brands publishing garment measurements
   would replace it.
