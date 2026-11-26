"""TailorAI reconstruction service.

Stateless. No database, no queue, no auth context, no storage credentials.
It receives presigned URLs and returns refs. That is precisely what lets it run
on this laptop today and on a rented RunPod GPU tomorrow with one URL change.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

import numpy as np
import trimesh
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse

from .adapters.registry import build_body_adapter, build_segmentation_adapter
from .bodymodel.humanoid import apply_cylindrical_uv
from .config import settings
from .core.fusion import fuse
from .errors import ReconError, inference_failed, no_person_detected
from .media.extract import extract_frames
from .media.select import select_frames
from .mesh.build import build_mesh
from .runtime.vram import gpu_info
from .schemas import (
    TryOnPreviewRequest,
    FitRecommendRequest,
    PhotoTryOnRequest,
    ProcessScanRequest,
    ProductPhotoRequest,
    ReadSizeChartRequest,
    ScanAnalyzeRequest,
    MeasureRequest,
    MeasureResponse,
    MeasurementRegion,
    AdapterInfo,
    BodyInferRequest,
    BodyInferResponse,
    BuildMeshRequest,
    BuildMeshResponse,
    ExtractRequest,
    ExtractResponse,
    FuseRequest,
    FuseResponse,
    HealthResponse,
    MaskResult,
    SegmentRequest,
    SegmentResponse,
    SelectRequest,
    SelectResponse,
    TextureRequest,
    TextureResponse,
)
from .storage import fetch_image, put_image
from .texture.bake import bake_texture

logging.basicConfig(
    level=getattr(logging, settings().log_level.upper(), logging.INFO),
    format='{"ts":"%(asctime)s","level":"%(levelname)s","service":"reconstruction",'
    '"logger":"%(name)s","message":"%(message)s"}',
)
log = logging.getLogger("tailorai.reconstruction")

_state: dict[str, object] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    cfg = settings()

    # The licence gate runs here, at construction. A model not cleared for the
    # configured tier prevents the service from starting rather than failing on
    # the first job (ADR-2).
    log.info(
        "starting: tier=%s body=%s seg=%s device=%s",
        cfg.model_tier,
        cfg.body_adapter,
        cfg.segmentation_adapter,
        cfg.resolved_device,
    )

    _state["body"] = build_body_adapter(cfg.body_adapter, cfg.model_tier)
    _state["seg"] = build_segmentation_adapter(cfg.segmentation_adapter, cfg.model_tier)

    # Warm up so the first real job doesn't pay model-load cost. This is the
    # difference between a $0.09 scan and a $0.03 one (docs/06 §2).
    try:
        _state["body"].warmup()  # type: ignore[union-attr]
        _state["seg"].warmup()  # type: ignore[union-attr]
        from .scan import pose as scan_pose

        scan_pose.warmup()
        _state["ready"] = True
        log.info("adapters warm (incl. scan pose model)")

        # The Anny body loads in the background: its first-ever load builds an
        # on-disk cache (~90 s) and must not hold up the health check.
        from .scan import analyze as scan_analyze_mod

        if scan_analyze_mod.use_anny():
            import threading

            from .bodymodel import anny_body

            threading.Thread(target=anny_body.warmup, name="anny-warmup", daemon=True).start()
    except Exception as exc:  # noqa: BLE001
        _state["ready"] = False
        log.error("warmup failed: %s", exc)

    yield

    _state.clear()


app = FastAPI(
    title="TailorAI Reconstruction",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
)


async def require_api_key(x_api_key: str = Header(default="")) -> None:
    """Shared-secret auth for the internal boundary.

    Not user auth — the orchestrator is the only caller. It exists so a GPU
    service exposed on a cloud network is not openly callable.
    """
    if x_api_key != settings().api_key:
        raise HTTPException(status_code=401, detail={"code": "UNAUTHENTICATED"})


@app.exception_handler(ReconError)
async def recon_error_handler(_request: Request, exc: ReconError) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, dict) else {"code": "INTERNAL_ERROR"}
    log.warning("request failed: %s", detail)
    return JSONResponse(status_code=exc.status_code, content=detail)


# ─────────────────────────── health ───────────────────────────


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    cfg = settings()
    info = gpu_info()
    body = _state.get("body")
    seg = _state.get("seg")

    return HealthResponse(
        ready=bool(_state.get("ready", False)),
        device=cfg.resolved_device,
        gpuName=info["name"],  # type: ignore[arg-type]
        vramTotalMb=info["totalMb"],  # type: ignore[arg-type]
        vramFreeMb=info["freeMb"],  # type: ignore[arg-type]
        loadedModels=[m for m in (getattr(body, "id", None), getattr(seg, "id", None)) if m],
        adapters=AdapterInfo(body=cfg.body_adapter, segmentation=cfg.segmentation_adapter),
        modelTier=cfg.model_tier,
    )


# ─────────────────────────── media plane ───────────────────────────


@app.post("/media/extract", response_model=ExtractResponse, dependencies=[Depends(require_api_key)])
async def media_extract(req: ExtractRequest) -> ExtractResponse:
    return extract_frames(req)


@app.post("/media/select", response_model=SelectResponse, dependencies=[Depends(require_api_key)])
async def media_select(req: SelectRequest) -> SelectResponse:
    return select_frames(req)


# ─────────────────────────── inference plane ───────────────────────────


@app.post("/infer/segment", response_model=SegmentResponse, dependencies=[Depends(require_api_key)])
async def infer_segment(req: SegmentRequest) -> SegmentResponse:
    started = time.perf_counter()
    adapter = _state.get("seg")
    if adapter is None:
        raise inference_failed("segmentation adapter not initialised")

    results: list[MaskResult] = []
    people = 0

    for frame, output_url in zip(req.frames, req.outputUrls, strict=False):
        image = fetch_image(frame.imageUrl)
        alpha = adapter.segment(image)  # type: ignore[union-attr]

        foreground = float((alpha > 0.5).mean())

        ys, xs = np.nonzero(alpha > 0.5)
        bbox = (
            (float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max()))
            if len(xs) > 0
            else None
        )

        put_image(output_url, (np.clip(alpha, 0, 1) * 255).astype(np.uint8), ".png")

        if foreground > 0.02:
            people = max(people, 1)

        results.append(
            MaskResult(index=frame.index, foregroundRatio=foreground, bbox=bbox)
        )

    if people == 0:
        raise no_person_detected("no foreground found in any frame")

    return SegmentResponse(
        masks=results,
        personCount=people,
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


@app.post("/infer/body", response_model=BodyInferResponse, dependencies=[Depends(require_api_key)])
async def infer_body(req: BodyInferRequest) -> BodyInferResponse:
    started = time.perf_counter()
    adapter = _state.get("body")
    if adapter is None:
        raise inference_failed("body adapter not initialised")

    estimates = []
    for frame in req.frames:
        image = fetch_image(frame.imageUrl)
        mask = None
        if frame.maskUrl:
            raw = fetch_image(frame.maskUrl)
            mask = raw[:, :, 0].astype(np.float32) / 255.0 if raw.ndim == 3 else raw.astype(np.float32) / 255.0

        estimates.append(adapter.infer(image, mask, frame.index))  # type: ignore[union-attr]

    if not estimates:
        raise no_person_detected("no frames produced an estimate")

    return BodyInferResponse(
        adapterId=getattr(adapter, "id", "unknown"),
        bodyModel=getattr(adapter, "body_model", "MHR"),
        bodyModelVersion=getattr(adapter, "body_model_version", "1.0"),
        perFrame=estimates,
        elapsedMs=int((time.perf_counter() - started) * 1000),
    )


@app.post("/infer/fuse", response_model=FuseResponse, dependencies=[Depends(require_api_key)])
async def infer_fuse(req: FuseRequest) -> FuseResponse:
    return fuse(req)


@app.post("/infer/texture", response_model=TextureResponse, dependencies=[Depends(require_api_key)])
async def infer_texture(req: TextureRequest) -> TextureResponse:
    from .storage import fetch_bytes

    raw = fetch_bytes(req.meshUrl)
    loaded = trimesh.load(
        file_obj=__import__("io").BytesIO(raw), file_type="glb", force="mesh", process=False
    )
    if not isinstance(loaded, trimesh.Trimesh):
        raise inference_failed("mesh could not be loaded for texturing")

    uvs = apply_cylindrical_uv(loaded)
    return bake_texture(req, loaded, uvs)


# ─────────────────────────── mesh plane ───────────────────────────


@app.post("/mesh/build", response_model=BuildMeshResponse, dependencies=[Depends(require_api_key)])
async def mesh_build(req: BuildMeshRequest) -> BuildMeshResponse:
    return build_mesh(req)


@app.post("/body/helpers", dependencies=[Depends(require_api_key)])
def body_helpers(req: MeasureRequest) -> dict:
    """MakeHuman's helper layers (tights, skirt) for an Anny shape, in the
    avatar GLB's frame: what the shop's 3D garments hang on. Sync on purpose
    (FastAPI runs it in a thread): it's a model evaluation, ~0.1 s."""
    import base64

    from .bodymodel import mh_helpers

    h = mh_helpers.helpers(req.shape, req.metricScale)
    return {"count": int(len(h)), "positions": base64.b64encode(h.tobytes()).decode("ascii")}


# ─────────────────────────── measurement plane ───────────────────────────


@app.post("/measure", response_model=MeasureResponse, dependencies=[Depends(require_api_key)])
async def measure(req: MeasureRequest) -> MeasureResponse:
    """Derive the 14 anthropometric measurements + their body regions from a
    shape vector. Pure geometry — no GPU, no I/O — so the API can call it
    per request to serve a user's measurements."""
    import time as _t

    from .bodymodel.humanoid import build as _build
    from .research import measurements as _M

    started = _t.perf_counter()
    mesh, mesh_info = _build(req.shape, metric_scale=req.metricScale, return_landmarks=True)
    meas = _M.extract(mesh, mesh_info)
    regions = {k: MeasurementRegion(**v) for k, v in _M.regions_for(meas).items()}
    return MeasureResponse(
        measurements=meas.to_dict(),
        regions=regions,
        elapsedMs=int((_t.perf_counter() - started) * 1000),
    )


# ─────────────────────────── scan + fit (MVP) ───────────────────────────
#
# Plain `def` (not async): MediaPipe and mesh fitting are CPU-bound, so FastAPI
# runs these in its threadpool instead of blocking the event loop.


@app.post("/scan/analyze", dependencies=[Depends(require_api_key)])
def scan_analyze(req: ScanAnalyzeRequest) -> dict:
    """Validate four views, measure, and fit the body. Never raises for a bad
    scan: a rejected scan is a normal result carrying user-facing issues."""
    from .scan.analyze import analyze

    images = {v.view: fetch_image(v.imageUrl) for v in req.views}
    result = analyze(images, req.heightCm, fit_body=req.fitBody, sex=req.sexAtBirth)
    if result["status"] == "accepted":
        from .llm import gemini

        # Advisory only: warnings that explain a likely-inflated girth, never a rejection.
        result["issues"].extend(gemini.check_photos(images) or [])
    return result


@app.post("/fit/recommend", dependencies=[Depends(require_api_key)])
def fit_recommend(req: FitRecommendRequest) -> dict:
    from .fit.engine import recommend
    from .llm import gemini

    try:
        result = recommend(
            req.body,
            req.garment.model_dump(),
            [r.model_dump() for r in req.sizeChart],
            req.preference,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "FIT_UNAVAILABLE", "message": str(exc)}) from exc

    friendly = gemini.explain_fit(result, req.garment.model_dump(), req.preference)
    if friendly:
        result["explanationRules"] = result["explanation"]
        result["explanation"] = friendly
        result["explanationSource"] = f"gemini:{gemini.TEXT_MODEL}"
    return result


@app.post("/catalog/read-size-chart", dependencies=[Depends(require_api_key)])
def read_size_chart(req: ReadSizeChartRequest) -> dict:
    """Gemini transcribes a brand's size-chart image into the shop's form."""
    import base64
    import binascii

    from .llm import gemini

    if not gemini.enabled():
        raise HTTPException(status_code=503, detail={"code": "GEMINI_DISABLED",
                                                     "message": "Set GEMINI_API_KEY to read size charts."})
    try:
        image = base64.b64decode(req.imageBase64, validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=400, detail={"code": "BAD_IMAGE", "message": "Not valid base64."}) from exc
    result = gemini.read_size_chart(image, req.mimeType)
    if result is None or not result["sizes"]:
        raise HTTPException(status_code=422, detail={"code": "CHART_UNREADABLE",
                                                     "message": "Couldn't find a size table in that image."})
    return result


def _gemini_or_503():
    from .llm import gemini

    if not gemini.enabled():
        raise HTTPException(status_code=503, detail={"code": "GEMINI_DISABLED",
                                                     "message": "Set GEMINI_API_KEY to use AI images."})
    return gemini


_OUT_OF_CREDITS = HTTPException(status_code=402, detail={
    "code": "GEMINI_CREDITS",
    "message": "The Gemini image credits for this project are used up. Add credits at "
               "https://aistudio.google.com (Billing), then try again.",
})


@app.post("/catalog/product-photo", dependencies=[Depends(require_api_key)])
def product_photo(req: ProductPhotoRequest) -> dict:
    """A product photo for a garment, made from its description."""
    import base64

    gemini = _gemini_or_503()
    try:
        out = gemini.product_photo(req.garment.model_dump())
    except gemini.OutOfCredits as exc:
        raise _OUT_OF_CREDITS from exc
    if out is None:
        raise HTTPException(status_code=502, detail={"code": "IMAGE_FAILED", "message": "Couldn't create a photo right now."})
    data, mime = out
    return {"imageBase64": base64.b64encode(data).decode(), "mimeType": mime, "model": gemini.PRODUCT_IMAGE_MODEL}


@app.post("/tryon/photo", dependencies=[Depends(require_api_key)])
def photo_tryon(req: PhotoTryOnRequest) -> dict:
    """The person's scan photo wearing the garment. Nothing is stored."""
    import base64

    from .storage import fetch_bytes

    gemini = _gemini_or_503()
    person = fetch_bytes(req.personImageUrl)
    garment = fetch_bytes(req.garmentImageUrl)
    mime = "image/png" if garment[:4] == b"\x89PNG" else "image/webp" if garment[8:12] == b"WEBP" else "image/jpeg"
    g = req.garment
    what = f"{g.colorName} {g.name}, {g.subcategory.lower()}".strip()
    try:
        out = gemini.photo_tryon(person, garment, mime, what)
    except gemini.OutOfCredits as exc:
        raise _OUT_OF_CREDITS from exc
    if out is None:
        raise HTTPException(status_code=502, detail={"code": "IMAGE_FAILED", "message": "Couldn't create the try-on photo right now."})
    data, out_mime, model = out
    return {"imageBase64": base64.b64encode(data).decode(), "mimeType": out_mime, "model": model}


@app.get("/tryon/engines", dependencies=[Depends(require_api_key)])
def tryon_engines() -> dict:
    """Which AI photo engines are available right now."""
    from .tryon.ai import engines

    return engines()


@app.post("/tryon/preview", dependencies=[Depends(require_api_key)])
def tryon_preview(req: TryOnPreviewRequest) -> dict:
    """The shopper's own scan photo, re-dressed: a catalogue garment (mode
    "product") or the outfit they're wearing (mode "own"), in a given size.
    Local — no generative model, nothing leaves this machine."""
    from .tryon.parse import ParseError
    from .tryon.service import EngineUnavailable, Unsupported, preview

    try:
        return preview(req)
    except EngineUnavailable as exc:
        raise HTTPException(status_code=503, detail={"code": "ENGINE_UNAVAILABLE", "message": str(exc)}) from exc
    except Unsupported as exc:
        raise HTTPException(status_code=422, detail={"code": "TRYON_UNSUPPORTED", "message": str(exc)}) from exc
    except ParseError as exc:
        raise HTTPException(
            status_code=422,
            detail={"code": "TRYON_UNREADABLE", "message": f"We couldn't read your photo for a try-on: {exc}."},
        ) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "TRYON_UNSUPPORTED", "message": str(exc)}) from exc


@app.post("/process-scan", dependencies=[Depends(require_api_key)])
def process_scan(req: ProcessScanRequest) -> dict:
    """The MVP plan's interface contract (§7), for direct callers. The product
    path goes through the orchestrator, which also builds and stores the GLB."""
    from .scan.analyze import analyze

    images = {k: fetch_image(v) for k, v in req.images.model_dump().items()}
    res = analyze(images, req.height_cm)
    return {
        "scan_id": req.scan_id,
        "status": "completed" if res["status"] == "accepted" else "rejected",
        "body_model": (
            {"format": "parametric", "shape": res["body"]["shape"],
             "metric_scale": res["body"]["metricScale"], "mesh_url": None}
            if res.get("body") else None
        ),
        "measurements": {f"{m['name']}_cm": m["value"] for m in res["measurements"]},
        "confidence": {"overall": res["confidence"]["overall"]},
        "issues": res["issues"],
    }


def main() -> None:
    import uvicorn

    cfg = settings()
    uvicorn.run(
        "app.main:app",
        host=cfg.host,
        port=cfg.port,
        log_level=cfg.log_level,
        reload=False,
    )


if __name__ == "__main__":
    main()
