import { AppError } from '@tailorai/contracts';
import { config } from '../config';
import {
  NO_RETRY,
  OOM_RETRY,
  TRANSIENT_RETRY,
  type Stage,
  type StageContext,
} from '../pipeline/types';

const PRESIGN_TTL = 3600;

// ─────────────────────────── S1 · Validate ───────────────────────────

const s1Validate: Stage = {
  name: 'S1_VALIDATE',
  retry: NO_RETRY,
  async run(ctx) {
    const session = await ctx.prisma.captureSession.findUnique({
      where: { id: ctx.sessionId },
      include: { assets: true, user: true },
    });
    if (!session) throw new AppError('NOT_FOUND', { sessionId: ctx.sessionId });

    const sources = session.assets.filter(
      (a) => a.kind === 'RAW_VIDEO' || a.kind === 'RAW_PHOTO',
    );
    if (sources.length === 0) throw new AppError('INSUFFICIENT_FRAMES');

    if (session.mode === 'VIDEO_360') {
      const video = sources.find((a) => a.kind === 'RAW_VIDEO');
      if (!video) throw new AppError('CORRUPT_MEDIA', undefined, 'No video found in this capture.');
      const maxMs = config().MAX_VIDEO_DURATION_S * 1000;
      if (video.durationMs && video.durationMs > maxMs) {
        throw new AppError('VIDEO_TOO_LONG', { durationMs: video.durationMs });
      }
    }

    // Four-view scan: every source photo carries its view label. All four
    // present (and nothing else) selects the scan path.
    if (session.mode === 'PHOTO_SET') {
      const views: NonNullable<typeof ctx.state.scanViews> = {};
      for (const a of sources) {
        const view = (a.metadata as { view?: string } | null)?.view;
        if (view === 'front' || view === 'back' || view === 'left' || view === 'right') {
          views[view] = a.id;
        }
      }
      if (Object.keys(views).length > 0) {
        ctx.state.scanViews = views;
        // Height is the scan's only scale anchor — without it every
        // measurement is a guess, so refuse rather than guess.
        if (session.user.heightCm == null) throw new AppError('HEIGHT_REQUIRED');
      }
    }

    // Height anchors metric scale (S7). Captured here so S7 has it regardless
    // of what the user edited between capture and processing.
    ctx.state.userHeightCm = session.user.heightCm;
    ctx.state.sexAtBirth = session.user.sexAtBirth;
    ctx.state.sourceAssetIds = sources.map((a) => a.id);

    ctx.log.info('Validated capture', {
      mode: session.mode,
      sourceCount: sources.length,
      hasHeight: session.user.heightCm != null,
    });
  },
};

// ─────────────────────────── S2 · Extract frames ───────────────────────────

const s2Extract: Stage = {
  name: 'S2_EXTRACT',
  retry: TRANSIENT_RETRY,
  // Photo mode has nothing to decode — the uploads are already frames.
  skipIf: (ctx) => ctx.state.mode === 'PHOTO_SET',
  async run(ctx) {
    const video = await ctx.prisma.asset.findFirst({
      where: { id: { in: ctx.state.sourceAssetIds }, kind: 'RAW_VIDEO' },
    });
    if (!video) throw new AppError('CORRUPT_MEDIA');

    const cfg = config();

    // Presign a fixed pool of frame slots. A presigned URL signs an exact key,
    // so it cannot be templated per index — the pool is sized to the worst
    // case and the service uses only what it needs.
    const maxFrames = Math.ceil(cfg.MAX_VIDEO_DURATION_S * cfg.FRAME_SAMPLE_FPS);
    const uploadSlots = await Promise.all(
      Array.from({ length: maxFrames }, async (_, index) => {
        const key = ctx.storage.key({
          userId: ctx.userId,
          jobId: ctx.jobId,
          kind: 'extracted_frame',
          fileName: `frame_${String(index).padStart(4, '0')}.jpg`,
        });
        return {
          index,
          key,
          url: await ctx.storage.presignPut(key, 'image/jpeg', PRESIGN_TTL),
        };
      }),
    );

    const res = await ctx.gpu.extract({
      jobId: ctx.jobId,
      videoUrl: await ctx.storage.presignGet(video.storageKey, PRESIGN_TTL),
      sampleFps: cfg.FRAME_SAMPLE_FPS,
      maxDurationS: cfg.MAX_VIDEO_DURATION_S,
      uploadSlots,
      // Un-mirror front-camera video here, once, at the point frames are
      // written — every later stage then sees anatomically correct images.
      mirrored: video.mirrored,
    });

    if (video.mirrored) {
      ctx.log.info('Un-mirroring front-camera video during extraction');
    }

    if (res.frames.length === 0) throw new AppError('CORRUPT_MEDIA');

    ctx.state.extractedFrames = res.frames.map((f) => ({
      index: f.index,
      key: f.key,
      width: f.width,
      height: f.height,
    }));

    ctx.log.info('Extracted frames', { count: res.frames.length, durationMs: res.durationMs });
  },
};

// ─────────────────────────── S3 · Select best frames ───────────────────────────

const s3Select: Stage = {
  name: 'S3_SELECT',
  retry: TRANSIENT_RETRY,
  async run(ctx) {
    // Four-view scan: the four photos are the frames, in a fixed order. No
    // frame selection — each view is needed, and S3B judges their quality.
    if (ctx.state.scanViews) {
      const order = ['front', 'right', 'back', 'left'] as const;
      const ids = order.map((v) => ctx.state.scanViews![v]).filter((x): x is string => !!x);
      const photos = await ctx.prisma.asset.findMany({ where: { id: { in: ids } } });
      const byId = new Map(photos.map((p) => [p.id, p]));
      const frames = ids.map((id, i) => {
        const p = byId.get(id)!;
        return { index: i, key: p.storageKey, width: p.width ?? 0, height: p.height ?? 0 };
      });
      ctx.state.extractedFrames = frames;
      ctx.state.selectedFrames = frames.map((f) => ({ index: f.index, key: f.key, qualityScore: 1 }));
      ctx.log.info('Four-view scan frames', { views: ids.length });
      return;
    }

    // Photo mode: the uploads themselves are the candidates.
    if (ctx.state.mode === 'PHOTO_SET' && ctx.state.extractedFrames.length === 0) {
      const photos = await ctx.prisma.asset.findMany({
        where: { id: { in: ctx.state.sourceAssetIds }, kind: 'RAW_PHOTO' },
        orderBy: { createdAt: 'asc' },
      });
      ctx.state.extractedFrames = photos.map((p, i) => ({
        index: i,
        key: p.storageKey,
        width: p.width ?? 0,
        height: p.height ?? 0,
      }));
    }

    const candidates = await Promise.all(
      ctx.state.extractedFrames.map(async (f) => ({
        index: f.index,
        key: f.key,
        imageUrl: await ctx.storage.presignGet(f.key, PRESIGN_TTL),
      })),
    );

    const res = await ctx.gpu.select({
      jobId: ctx.jobId,
      frames: candidates,
      targetCount: config().TARGET_FRAME_COUNT,
    });

    const selected = res.frames.filter((f) => f.selected);
    if (selected.length === 0) throw new AppError('INSUFFICIENT_FRAMES');

    // One usable frame is enough for photo mode (with a hallucinated back);
    // video mode promising a 360° turn and delivering two frames is not.
    if (ctx.state.mode === 'VIDEO_360' && selected.length < 4) {
      throw new AppError('INSUFFICIENT_FRAMES', { selected: selected.length });
    }

    ctx.state.selectedFrames = selected.map((f) => ({
      index: f.index,
      key: f.key,
      qualityScore: f.qualityScore,
    }));

    ctx.log.info('Selected frames', {
      candidates: res.frames.length,
      selected: selected.length,
    });
  },
};

// ─────────────────────────── S3B · Four-view scan ───────────────────────────

const s3bScan: Stage = {
  name: 'S3B_SCAN_ANALYZE',
  retry: TRANSIENT_RETRY,
  skipIf: (ctx) => ctx.state.scanViews === null,
  async run(ctx) {
    const views = ctx.state.scanViews!;
    const assets = await ctx.prisma.asset.findMany({
      where: { id: { in: Object.values(views) } },
    });
    const byId = new Map(assets.map((a) => [a.id, a]));

    const report = await ctx.gpu.scanAnalyze({
      jobId: ctx.jobId,
      heightCm: ctx.state.userHeightCm!,
      views: await Promise.all(
        (Object.entries(views) as Array<['front' | 'back' | 'left' | 'right', string]>).map(
          async ([view, id]) => ({
            view,
            imageUrl: await ctx.storage.presignGet(byId.get(id)!.storageKey, PRESIGN_TTL),
          }),
        ),
      ),
      fitBody: true,
    });

    // Saved whether accepted or not: on rejection it is how the app tells the
    // user which photo to retake, and why.
    await ctx.prisma.reconstructionJob.update({
      where: { id: ctx.jobId },
      data: { scanReport: report as object },
    });

    if (report.status === 'rejected') {
      const errors = report.issues.filter((i) => i.severity === 'error');
      ctx.log.warn('Scan rejected', { issues: errors.map((i) => `${i.view}:${i.code}`) });
      throw new AppError('SCAN_REJECTED', { issues: errors.length });
    }

    ctx.state.scan = report;
    ctx.log.info('Scan analysed', {
      measurements: report.measurements.length,
      confidence: report.confidence.overall,
      fitResidual: report.body?.residualCm,
      elapsedMs: report.elapsedMs,
    });
  },
};

// ─────────────────────────── S4 · Segment ───────────────────────────

const s4Segment: Stage = {
  name: 'S4_SEGMENT',
  retry: OOM_RETRY,
  async run(ctx) {
    const frames = await buildPreparedFrames(ctx, false);
    const outputUrls = await Promise.all(
      ctx.state.selectedFrames.map((f) =>
        ctx.storage.presignPut(maskKey(ctx, f.index), 'image/png', PRESIGN_TTL),
      ),
    );

    const res = await ctx.gpu.segment({ jobId: ctx.jobId, frames, outputUrls });

    if (res.personCount === 0) throw new AppError('NO_PERSON_DETECTED');
    if (res.personCount > 1) throw new AppError('MULTIPLE_PEOPLE', { count: res.personCount });

    // A near-empty mask means the subject wasn't really found even if the
    // detector claimed one — treat it as no person rather than reconstructing
    // noise.
    const usable = res.masks.filter((m) => m.foregroundRatio > 0.02);
    if (usable.length === 0) throw new AppError('NO_PERSON_DETECTED');

    for (const mask of usable) {
      ctx.state.maskKeys[mask.index] = maskKey(ctx, mask.index);
    }

    ctx.state.selectedFrames = ctx.state.selectedFrames.filter(
      (f) => ctx.state.maskKeys[f.index] !== undefined,
    );

    ctx.log.info('Segmented frames', { usable: usable.length });
  },
};

// ─────────────────────────── S5 · Body inference ───────────────────────────

const s5Body: Stage = {
  name: 'S5_BODY_INFERENCE',
  retry: OOM_RETRY,
  async run(ctx) {
    const frames = await buildPreparedFrames(ctx, true);

    const res = await ctx.gpu.body({ jobId: ctx.jobId, frames });
    if (res.perFrame.length === 0) throw new AppError('INFERENCE_FAILED');

    ctx.state.perFrame = res.perFrame;
    ctx.state.bodyModel = res.bodyModel;
    ctx.state.bodyModelVersion = res.bodyModelVersion;
    ctx.state.adapterId = res.adapterId;

    ctx.log.info('Body inference complete', {
      frames: res.perFrame.length,
      adapter: res.adapterId,
      elapsedMs: res.elapsedMs,
    });
  },
};

// ─────────────────────────── S6/S7/S8 · Fuse, scale, retarget ──────────────

const s6Fuse: Stage = {
  name: 'S6_FUSE',
  retry: TRANSIENT_RETRY,
  async run(ctx) {
    const res = await ctx.gpu.fuse({
      jobId: ctx.jobId,
      perFrame: ctx.state.perFrame,
      userHeightCm: ctx.state.userHeightCm,
      sexAtBirth: ctx.state.sexAtBirth,
    });

    ctx.state.shape = res.shape;
    ctx.state.shapeConfidence = res.shapeConfidence;
    ctx.state.scale = res.scale;
    ctx.state.coverageDegrees = res.coverageDegrees;
    ctx.state.overallQuality = res.overallQuality;

    // Four-view scan: the body is fitted to the *measured* girths, and scale
    // is the user's height exactly — both supersede the per-frame estimates.
    const body = ctx.state.scan?.body;
    if (body) {
      ctx.state.shape = body.shape;
      ctx.state.scale = {
        source: 'USER_HEIGHT',
        heightCm: ctx.state.userHeightCm,
        confidence: 0.95,
        metricScale: body.metricScale,
      };
      ctx.state.coverageDegrees = 360;
      ctx.state.overallQuality = ctx.state.scan!.confidence.overall;
    }

    ctx.log.info('Fused shape', {
      outlierFrames: res.outlierFrames.length,
      coverageDegrees: Math.round(res.coverageDegrees),
      scaleSource: res.scale.source,
      quality: res.overallQuality.toFixed(2),
    });
  },
};

/**
 * Scale is resolved inside the fuse call (it needs the same data), so this
 * stage validates the outcome rather than recomputing it. Kept as its own
 * stage because scale provenance is a distinct product concern and deserves a
 * distinct place to fail.
 */
const s7Scale: Stage = {
  name: 'S7_SCALE',
  retry: NO_RETRY,
  async run(ctx) {
    const scale = ctx.state.scale;
    if (!scale) throw new AppError('SCALE_UNRESOLVED');

    if (scale.source === 'STATISTICAL_PRIOR' && ctx.state.userHeightCm == null) {
      // Not fatal — we still produce an avatar — but the profile must record
      // that its metric scale is a population guess, not a measurement.
      ctx.log.warn('Scale fell back to statistical prior; no user height available', {
        confidence: scale.confidence,
      });
    }

    if (!Number.isFinite(scale.metricScale) || scale.metricScale <= 0) {
      throw new AppError('SCALE_UNRESOLVED', { metricScale: scale.metricScale });
    }
  },
};

/** Anny retarget. Deferred past v1 (docs/01 §S8) — declared so the DAG is complete. */
const s8Retarget: Stage = {
  name: 'S8_RETARGET',
  retry: NO_RETRY,
  optional: true,
  skipIf: () => true,
  async run() {
    /* not implemented in v1 */
  },
};

// ─────────────────────────── S9/S10 · UV + texture ───────────────────────────

/**
 * The UV atlas is a function of body topology, which is fixed. Computing it
 * per job would be pure waste — the Python service precomputes and caches it,
 * so this stage only asserts availability.
 */
const s9Unwrap: Stage = {
  name: 'S9_UNWRAP',
  retry: NO_RETRY,
  skipIf: () => true,
  async run() {
    /* atlas is precomputed and cached per body model */
  },
};

const s10Texture: Stage = {
  name: 'S10_TEXTURE_BAKE',
  retry: OOM_RETRY,
  // Degrades rather than fails: a grey avatar beats an error screen.
  optional: true,
  skipIf: (ctx) => !ctx.options.textured,
  async run(ctx) {
    if (!ctx.state.glbKey) {
      // Texturing needs geometry, which S11 builds. Bake against the untextured
      // mesh produced there; on first pass we build geometry first.
      await buildMesh(ctx, null);
    }

    const frames = await buildPreparedFrames(ctx, true);
    const cameras = ctx.state.perFrame
      .filter((p) => ctx.state.selectedFrames.some((f) => f.index === p.index))
      .map((p) => p.camera);

    const textureKey = ctx.storage.key({
      userId: ctx.userId,
      jobId: ctx.jobId,
      kind: 'texture_atlas',
      fileName: 'atlas.png',
    });

    const res = await ctx.gpu.texture({
      jobId: ctx.jobId,
      meshUrl: await ctx.storage.presignGet(ctx.state.glbKey!, PRESIGN_TTL),
      frames,
      cameras,
      resolution: config().TEXTURE_RESOLUTION as 1024 | 2048 | 4096,
      outputUrl: await ctx.storage.presignPut(textureKey, 'image/png', PRESIGN_TTL),
    });

    ctx.state.textureKey = textureKey;
    ctx.state.coverage = res.coverage;

    ctx.log.info('Texture baked', {
      resolution: res.resolution,
      inpainted: res.coverage.inpaintedFraction.toFixed(3),
    });
  },
};

// ─────────────────────────── S11/S12 · Optimise + export ───────────────────

const s11Optimise: Stage = {
  name: 'S11_OPTIMISE',
  retry: TRANSIENT_RETRY,
  async run(ctx) {
    // Rebuild with the texture applied (S10 may have degraded, in which case
    // textureKey is null and we ship untextured — marked as degraded).
    await buildMesh(ctx, ctx.state.textureKey);

    if (ctx.state.vertexCount === 0 || ctx.state.triangleCount === 0) {
      throw new AppError('MESH_INVALID');
    }
    if (ctx.state.textureKey === null) ctx.state.textureDegraded = true;
  },
};

const s12Export: Stage = {
  name: 'S12_EXPORT',
  retry: TRANSIENT_RETRY,
  async run(ctx) {
    const glbKey = ctx.state.glbKey;
    if (!glbKey) throw new AppError('EXPORT_FAILED');

    const glbSize = await ctx.storage.size(glbKey);
    if (glbSize === 0) throw new AppError('EXPORT_FAILED', { glbKey });

    // Metadata sidecar doubles as the permanent per-job audit record and is
    // what turns the estimates in docs/06 §2 into measurements.
    const sidecarKey = ctx.storage.key({
      userId: ctx.userId,
      jobId: ctx.jobId,
      kind: 'metadata_sidecar',
      fileName: 'metadata.json',
    });
    await ctx.storage.put(
      sidecarKey,
      JSON.stringify(
        {
          jobId: ctx.jobId,
          adapterId: ctx.state.adapterId,
          bodyModel: ctx.state.bodyModel,
          bodyModelVersion: ctx.state.bodyModelVersion,
          frameCount: ctx.state.selectedFrames.length,
          coverageDegrees: ctx.state.coverageDegrees,
          overallQuality: ctx.state.overallQuality,
          scale: ctx.state.scale,
          coverage: ctx.state.coverage,
          textureDegraded: ctx.state.textureDegraded,
          timings: ctx.state.timings,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'application/json',
    );

    ctx.log.info('Export complete', { glbBytes: glbSize });
  },
};

// ─────────────────────────── helpers ───────────────────────────

function maskKey(ctx: StageContext, index: number): string {
  return ctx.storage.key({
    userId: ctx.userId,
    jobId: ctx.jobId,
    kind: 'mask',
    fileName: `mask_${String(index).padStart(4, '0')}.png`,
  });
}

async function buildPreparedFrames(ctx: StageContext, withMasks: boolean) {
  const byIndex = new Map(ctx.state.extractedFrames.map((f) => [f.index, f]));

  return Promise.all(
    ctx.state.selectedFrames.map(async (sel) => {
      const meta = byIndex.get(sel.index);
      const maskKeyForFrame = ctx.state.maskKeys[sel.index];
      return {
        index: sel.index,
        imageUrl: await ctx.storage.presignGet(sel.key, PRESIGN_TTL),
        ...(withMasks && maskKeyForFrame
          ? { maskUrl: await ctx.storage.presignGet(maskKeyForFrame, PRESIGN_TTL) }
          : {}),
        width: meta?.width ?? 0,
        height: meta?.height ?? 0,
        qualityScore: sel.qualityScore,
      };
    }),
  );
}

async function buildMesh(ctx: StageContext, textureKey: string | null): Promise<void> {
  const glbKey = ctx.storage.key({
    userId: ctx.userId,
    jobId: ctx.jobId,
    kind: 'mesh_glb',
    fileName: 'avatar.glb',
  });
  const objKey = ctx.storage.key({
    userId: ctx.userId,
    jobId: ctx.jobId,
    kind: 'mesh_obj',
    fileName: 'avatar.obj.zip',
  });
  const thumbKey = ctx.storage.key({
    userId: ctx.userId,
    jobId: ctx.jobId,
    kind: 'thumbnail',
    fileName: 'thumb.png',
  });

  const res = await ctx.gpu.buildMesh({
    jobId: ctx.jobId,
    shape: ctx.state.shape,
    metricScale: ctx.state.scale?.metricScale ?? 1,
    textureUrl: textureKey ? await ctx.storage.presignGet(textureKey, PRESIGN_TTL) : null,
    outputGlbUrl: await ctx.storage.presignPut(glbKey, 'model/gltf-binary', PRESIGN_TTL),
    outputObjUrl: await ctx.storage.presignPut(objKey, 'application/zip', PRESIGN_TTL),
    outputThumbnailUrl: await ctx.storage.presignPut(thumbKey, 'image/png', PRESIGN_TTL),
  });

  ctx.state.glbKey = glbKey;
  ctx.state.objKey = res.objBytes ? objKey : null;
  ctx.state.thumbnailKey = thumbKey;
  ctx.state.vertexCount = res.vertexCount;
  ctx.state.triangleCount = res.triangleCount;
}

export const STAGES = [
  s1Validate,
  s2Extract,
  s3Select,
  s3bScan,
  s4Segment,
  s5Body,
  s6Fuse,
  s7Scale,
  s8Retarget,
  s9Unwrap,
  s10Texture,
  s11Optimise,
  s12Export,
];
