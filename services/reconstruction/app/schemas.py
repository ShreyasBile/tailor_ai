"""Request/response models mirroring packages/contracts/src/internal.ts.

This service never receives blobs and never returns blobs — everything moves
through presigned URLs supplied by the orchestrator. That is what keeps it
stateless, credential-free, and relocatable to a rented GPU.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class PreparedFrame(BaseModel):
    index: int
    imageUrl: str
    maskUrl: str | None = None
    width: int = 0
    height: int = 0
    qualityScore: float = 1.0


class CameraParams(BaseModel):
    focal: float
    principalPoint: tuple[float, float]
    rotation: tuple[float, float, float, float]
    translation: tuple[float, float, float]
    subjectYawDeg: float | None = None


class PerFrameEstimate(BaseModel):
    index: int
    shape: list[float]
    pose: list[float]
    camera: CameraParams
    score: float | None = None


# ── /media/extract ──


class FrameSlot(BaseModel):
    """A presigned PUT target for one extracted frame.

    The orchestrator presigns a fixed pool of slots up front (maxDuration ×
    sampleFps) because a presigned URL signs an exact key — it cannot be
    templated per index. The service consumes as many slots as it needs and
    leaves the rest unused.
    """

    index: int
    key: str
    url: str


class ExtractRequest(BaseModel):
    jobId: str
    videoUrl: str
    sampleFps: float = 4.0
    maxDurationS: int = 60
    uploadSlots: list[FrameSlot]
    # Front-camera capture is mirrored. Flipping here, as frames are written,
    # means every downstream stage sees anatomically correct images and none of
    # them need to know which lens was used.
    mirrored: bool = False


class ExtractedFrame(BaseModel):
    index: int
    key: str
    width: int
    height: int
    timestampMs: int


class ExtractResponse(BaseModel):
    frames: list[ExtractedFrame]
    durationMs: int
    fps: float
    elapsedMs: int


# ── /media/select ──


class SelectCandidate(BaseModel):
    index: int
    imageUrl: str
    key: str


class SelectRequest(BaseModel):
    jobId: str
    frames: list[SelectCandidate]
    targetCount: int = 16


class ScoredFrame(BaseModel):
    index: int
    key: str
    sharpness: float
    exposure: float
    qualityScore: float
    selected: bool
    rejectReason: str | None = None


class SelectResponse(BaseModel):
    frames: list[ScoredFrame]
    selectedCount: int
    elapsedMs: int


# ── /infer/segment ──


class SegmentRequest(BaseModel):
    jobId: str
    frames: list[PreparedFrame]
    outputUrls: list[str]


class MaskResult(BaseModel):
    index: int
    foregroundRatio: float
    bbox: tuple[float, float, float, float] | None = None


class SegmentResponse(BaseModel):
    masks: list[MaskResult]
    personCount: int
    elapsedMs: int


# ── /infer/body ──


class BodyInferRequest(BaseModel):
    jobId: str
    frames: list[PreparedFrame]


class BodyInferResponse(BaseModel):
    adapterId: str
    bodyModel: str
    bodyModelVersion: str
    perFrame: list[PerFrameEstimate]
    elapsedMs: int


# ── /infer/fuse ──


class FuseRequest(BaseModel):
    jobId: str
    perFrame: list[PerFrameEstimate]
    userHeightCm: float | None = None
    sexAtBirth: Literal["FEMALE", "MALE", "UNSPECIFIED"] | None = None


class ScaleResult(BaseModel):
    source: Literal["USER_HEIGHT", "ARKIT_DEPTH", "REFERENCE_OBJECT", "STATISTICAL_PRIOR"]
    heightCm: float | None
    confidence: float | None
    metricScale: float


class FuseResponse(BaseModel):
    shape: list[float]
    shapeConfidence: list[float]
    outlierFrames: list[int]
    scale: ScaleResult
    coverageDegrees: float
    overallQuality: float
    elapsedMs: int


# ── /infer/texture ──


class TextureRequest(BaseModel):
    jobId: str
    meshUrl: str
    frames: list[PreparedFrame]
    cameras: list[CameraParams]
    resolution: int = 2048
    outputUrl: str


class CoverageResult(BaseModel):
    front: float
    back: float
    left: float
    right: float
    inpaintedFraction: float


class TextureResponse(BaseModel):
    resolution: int
    coverage: CoverageResult
    elapsedMs: int


# ── /mesh/build ──


class BuildMeshRequest(BaseModel):
    jobId: str
    shape: list[float]
    metricScale: float = 1.0
    # "ANNY" → the Anny body; anything else → the parametric humanoid, which is
    # what every shape vector stored before the Anny body describes.
    bodyModel: str = "MHR"
    textureUrl: str | None = None
    outputGlbUrl: str
    outputObjUrl: str | None = None
    outputThumbnailUrl: str


class BuildMeshResponse(BaseModel):
    vertexCount: int
    triangleCount: int
    glbBytes: int
    objBytes: int | None
    elapsedMs: int


# ── /health ──


class AdapterInfo(BaseModel):
    body: str
    segmentation: str


class HealthResponse(BaseModel):
    ready: bool
    device: str
    gpuName: str | None
    vramTotalMb: int | None
    vramFreeMb: int | None
    loadedModels: list[str] = Field(default_factory=list)
    adapters: AdapterInfo
    modelTier: str


# ── /measure (research: anthropometry from shape) ──


class MeasureRequest(BaseModel):
    shape: list[float]
    metricScale: float = 1.0


class MeasurementRegion(BaseModel):
    """Where a measurement sits on the body, for the app's highlight overlay.

    `kind`: 'girth' (a horizontal band), 'width' (a horizontal span), or
    'length' (a vertical span). `y`/`y0`/`y1` are fractions of stature from the
    ground (0=feet, 1=head), so the app can place the highlight without knowing
    the mesh.
    """

    value: float
    unit: str = "cm"
    kind: Literal["girth", "width", "length"]
    y: float | None = None
    y0: float | None = None
    y1: float | None = None
    side: Literal["torso", "arm", "leg", "full"] = "torso"


class MeasureResponse(BaseModel):
    measurements: dict[str, float | None]
    regions: dict[str, MeasurementRegion]
    elapsedMs: int


# ── /scan/analyze (four-view MVP scan) ──


class ScanView(BaseModel):
    view: Literal["front", "back", "left", "right"]
    # Presigned URL, or a data: URI (used by /process-scan callers).
    imageUrl: str


class ScanAnalyzeRequest(BaseModel):
    jobId: str | None = None
    heightCm: float = Field(gt=50, lt=260)
    views: list[ScanView]
    fitBody: bool = True
    # Sets the Anny body's gender slider; None/UNSPECIFIED → androgynous.
    sexAtBirth: str | None = None


# ── /fit/recommend ──


class FitGarment(BaseModel):
    category: str
    # Style decides which measurements matter (no sleeve length on a tee).
    subcategory: str = ""
    fitIntent: Literal["slim", "regular", "relaxed", "oversized"] = "regular"
    stretch: Literal["none", "low", "medium", "high"] = "none"


class SizeChartRow(BaseModel):
    label: str
    # dimension → [min_cm, max_cm] body measurement range for this size
    measurements: dict[str, tuple[float, float]]


class FitRecommendRequest(BaseModel):
    # name → cm, or name → {"value": cm, "confidence": 0..1}
    body: dict[str, float | dict[str, float]]
    garment: FitGarment
    sizeChart: list[SizeChartRow]
    preference: Literal["snug", "regular", "loose"] = "regular"


# ── /catalog/read-size-chart (admin: Gemini reads a chart image) ──


class ReadSizeChartRequest(BaseModel):
    imageBase64: str = Field(min_length=100, max_length=3_000_000)
    mimeType: Literal["image/jpeg", "image/png", "image/webp"] = "image/jpeg"


# ── /catalog/product-photo and /tryon/photo (Gemini images) ──


class GarmentDescription(BaseModel):
    name: str
    subcategory: str
    gender: str = "unisex"
    fitIntent: str = "REGULAR"
    material: str = ""
    description: str = ""
    colorName: str = ""
    colorHex: str = ""


class ProductPhotoRequest(BaseModel):
    garment: GarmentDescription


class PhotoTryOnRequest(BaseModel):
    personImageUrl: str
    garmentImageUrl: str
    garment: GarmentDescription


# ── /process-scan (the MVP plan's §7 interface contract, verbatim shape) ──


class ProcessScanImages(BaseModel):
    front: str
    back: str
    left: str
    right: str


class ProcessScanRequest(BaseModel):
    scan_id: str
    height_cm: float = Field(gt=50, lt=260)
    images: ProcessScanImages


# ── /tryon/preview (local photo try-on and size preview) ──


class TryOnGarment(BaseModel):
    slug: str
    name: str = ""
    category: str = "tops"
    subcategory: str = ""
    description: str = ""
    imageUrl: str | None = None


class TryOnPreviewRequest(BaseModel):
    personImageUrl: str
    personKey: str  # stable id of the photo, for caching its parse
    heightCm: float = Field(gt=50, lt=260)
    view: Literal["front", "back"] = "front"
    mode: Literal["product", "own"] = "product"
    garment: TryOnGarment
    sizes: list[dict]  # the fit engine's per-size results, with dimensions
    size: str
    recommended: str
    amplify: float = Field(default=1.0, ge=0.5, le=2.0)
