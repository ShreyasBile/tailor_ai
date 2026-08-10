import { Worker, type Job as BullJob } from 'bullmq';
import IORedis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import {
  AppError,
  ERROR_CATALOG,
  RENDERER_VERSION,
  type ErrorCode,
} from '@tailorai/contracts';
import { config } from './config';
import { log } from './logger';
import { Storage } from './clients/storage';
import { GpuClient } from './clients/gpu';
import { EventPublisher } from './events';
import { PipelineRunner } from './pipeline/runner';
import { initialState, type StageContext } from './pipeline/types';
import { STAGES } from './stages';

const RECONSTRUCTION_QUEUE = 'reconstruction';

interface JobData {
  jobId: string;
  userId: string;
  sessionId: string;
  options: { quality: 'fast' | 'standard' | 'high'; textured: boolean };
}

const prisma = new PrismaClient();
const storage = new Storage();
const gpu = new GpuClient();
const events = new EventPublisher();
const runner = new PipelineRunner(STAGES);

async function processJob(bullJob: BullJob<JobData>): Promise<void> {
  const { jobId, userId, sessionId, options } = bullJob.data;
  const jobLog = log.child({ jobId, userId });
  const startedAt = Date.now();

  const session = await prisma.captureSession.findUnique({
    where: { id: sessionId },
    select: { mode: true },
  });
  if (!session) throw new AppError('NOT_FOUND', { sessionId });

  const ctx: StageContext = {
    jobId,
    userId,
    sessionId,
    options,
    state: initialState(session.mode),
    prisma,
    storage,
    gpu,
    events,
    log: jobLog,
    attempt: 0,
  };

  await prisma.reconstructionJob.update({
    where: { id: jobId },
    data: { status: 'VALIDATING', startedAt: new Date() },
  });

  jobLog.info('Pipeline started', { mode: session.mode, quality: options.quality });

  try {
    await runner.run(ctx);

    // Cancelled mid-run: the runner returns without completing. Nothing to
    // persist, and the API already set the terminal status.
    const current = await prisma.reconstructionJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (current?.status === 'CANCELLED') {
      jobLog.info('Pipeline halted by cancellation');
      return;
    }

    const { bodyCoreId, renderId } = await persistResults(ctx);

    const computeMs = Date.now() - startedAt;
    await prisma.$transaction([
      prisma.reconstructionJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          progress: 1,
          finishedAt: new Date(),
          computeMs,
        },
      }),
      prisma.captureSession.update({
        where: { id: sessionId },
        data: { status: 'COMPLETED' },
      }),
    ]);

    await events.completed(jobId, bodyCoreId, renderId);
    jobLog.info('Pipeline completed', { computeMs, bodyCoreId, renderId });
  } catch (err) {
    const appErr =
      err instanceof AppError ? err : new AppError('INTERNAL_ERROR', { cause: String(err) });

    const message = ERROR_CATALOG[appErr.code as ErrorCode]?.message ?? appErr.message;

    await prisma.$transaction([
      prisma.reconstructionJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorCode: appErr.code,
          errorMessage: message,
          finishedAt: new Date(),
          computeMs: Date.now() - startedAt,
        },
      }),
      prisma.captureSession.update({ where: { id: sessionId }, data: { status: 'FAILED' } }),
    ]);

    await events.failed(jobId, appErr.code, message, appErr.retryable);
    jobLog.error('Pipeline failed', { code: appErr.code, context: appErr.context });

    // Swallow: the job's terminal state is recorded in Postgres, which is the
    // source of truth. Rethrowing would make BullMQ retry the whole pipeline,
    // duplicating work the stage-level policy already decided against.
  }
}

/**
 * Writes the two output layers.
 *
 * BodyCore is versioned and never overwritten — a user re-scanning in six
 * months gets version 2 while version 1 stays queryable. That longitudinal
 * history costs ~2 KB and is a genuine long-term asset (docs/03 §3).
 */
async function persistResults(
  ctx: StageContext,
): Promise<{ bodyCoreId: string; renderId: string }> {
  const { state } = ctx;
  if (!state.scale) throw new AppError('SCALE_UNRESOLVED');

  return prisma.$transaction(async (tx) => {
    const previous = await tx.bodyCore.findFirst({
      where: { userId: ctx.userId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (previous?.version ?? 0) + 1;

    await tx.bodyCore.updateMany({
      where: { userId: ctx.userId, isCurrent: true },
      data: { isCurrent: false, supersededAt: new Date() },
    });

    const core = await tx.bodyCore.create({
      data: {
        userId: ctx.userId,
        jobId: ctx.jobId,
        version,
        isCurrent: true,
        bodyModel: state.bodyModel === 'ANNY' ? 'ANNY' : 'MHR',
        bodyModelVersion: state.bodyModelVersion,
        shapeParams: state.shape,
        shapeConfidence: state.shapeConfidence,
        scaleSource: state.scale!.source,
        heightCm: state.scale!.heightCm,
        scaleConfidence: state.scale!.confidence,
        metricScale: state.scale!.metricScale,
        frameCount: state.selectedFrames.length,
        captureMode: state.mode,
        overallQuality: state.overallQuality,
        coverageDegrees: state.coverageDegrees,
      },
    });

    const assets = await createAssets(tx, ctx);

    const render = await tx.avatarRender.create({
      data: {
        bodyCoreId: core.id,
        jobId: ctx.jobId,
        rendererVersion: RENDERER_VERSION,
        vertexCount: state.vertexCount,
        triangleCount: state.triangleCount,
        textureRes: state.textureKey ? config().TEXTURE_RESOLUTION : null,
        isTextured: state.textureKey !== null,
        isDegraded: state.textureDegraded,
        coverage: state.coverage ?? undefined,
        glbAssetId: assets.glbId,
        thumbnailAssetId: assets.thumbnailId,
        textureAssetId: assets.textureId,
      },
    });

    return { bodyCoreId: core.id, renderId: render.id };
  });
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

async function createAssets(
  tx: Tx,
  ctx: StageContext,
): Promise<{ glbId: string; thumbnailId: string | null; textureId: string | null }> {
  const { state } = ctx;
  const bucket = storage.bucket;
  const expiresAt = null;

  const glbSize = state.glbKey ? await storage.size(state.glbKey) : 0;
  const glb = await tx.asset.create({
    data: {
      sessionId: ctx.sessionId,
      kind: 'MESH_GLB',
      storageKey: state.glbKey!,
      bucket,
      mimeType: 'model/gltf-binary',
      sizeBytes: BigInt(glbSize),
      sha256: '',
      expiresAt,
    },
  });

  let thumbnailId: string | null = null;
  if (state.thumbnailKey && (await storage.exists(state.thumbnailKey))) {
    const thumb = await tx.asset.create({
      data: {
        sessionId: ctx.sessionId,
        kind: 'THUMBNAIL',
        storageKey: state.thumbnailKey,
        bucket,
        mimeType: 'image/png',
        sizeBytes: BigInt(await storage.size(state.thumbnailKey)),
        sha256: '',
        expiresAt,
      },
    });
    thumbnailId = thumb.id;
  }

  let textureId: string | null = null;
  if (state.textureKey && (await storage.exists(state.textureKey))) {
    const tex = await tx.asset.create({
      data: {
        sessionId: ctx.sessionId,
        kind: 'TEXTURE_ATLAS',
        storageKey: state.textureKey,
        bucket,
        mimeType: 'image/png',
        sizeBytes: BigInt(await storage.size(state.textureKey)),
        sha256: '',
        expiresAt,
      },
    });
    textureId = tex.id;
  }

  return { glbId: glb.id, thumbnailId, textureId };
}

// ─────────────────────────── bootstrap ───────────────────────────

async function main(): Promise<void> {
  const cfg = config();

  const connection = new IORedis(cfg.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  // Fail fast and loudly if the GPU service isn't reachable — a worker that
  // silently accepts jobs it cannot process just converts a config error into
  // a queue of failed reconstructions.
  try {
    const health = await gpu.health();
    log.info('Reconstruction service reachable', {
      device: health.device,
      gpu: health.gpuName ?? 'none',
      adapters: `${health.adapters.body}/${health.adapters.segmentation}`,
      modelTier: health.modelTier,
    });
  } catch (err) {
    log.error('Reconstruction service unreachable at startup', {
      url: cfg.RECONSTRUCTION_URL,
      cause: String(err),
    });
  }

  const worker = new Worker<JobData>(RECONSTRUCTION_QUEUE, processJob, {
    connection,
    concurrency: cfg.WORKER_CONCURRENCY,
    // GPU work is long; a stalled-job check that's too eager double-processes.
    stalledInterval: 120_000,
    lockDuration: 300_000,
  });

  worker.on('failed', (job, err) => {
    log.error('Worker job failed', { jobId: job?.data.jobId, cause: String(err) });
  });

  worker.on('error', (err) => {
    log.error('Worker error', { cause: String(err) });
  });

  log.info('Orchestrator started', {
    queue: RECONSTRUCTION_QUEUE,
    concurrency: cfg.WORKER_CONCURRENCY,
    modelTier: cfg.MODEL_TIER,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info('Shutting down', { signal });
    // Let in-flight jobs finish rather than orphaning half-written artifacts.
    await worker.close();
    await events.close();
    await prisma.$disconnect();
    connection.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  log.error('Fatal startup error', { cause: String(err) });
  process.exit(1);
});
