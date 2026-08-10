import {
  AppError,
  ERROR_CATALOG,
  STAGE_ORDER,
  STAGE_TO_STATUS,
  STAGE_WEIGHTS,
  type ErrorCode,
  type StageName,
} from '@tailorai/contracts';
import type { Stage, StageContext } from './types';
import { log } from '../logger';

/**
 * Runs the pipeline DAG.
 *
 * Responsibilities, deliberately narrow:
 *   - drive stages in order, honouring skip conditions
 *   - apply the per-stage retry policy
 *   - persist stage records and job progress after every transition
 *   - publish progress
 *   - checkpoint state so a retry resumes rather than restarts
 *
 * It knows nothing about images, meshes or models. That is the point: the
 * control plane is testable without a GPU.
 */
export class PipelineRunner {
  constructor(private readonly stages: Stage[]) {
    const declared = new Set(stages.map((s) => s.name));
    const missing = STAGE_ORDER.filter((s) => !declared.has(s));
    if (missing.length > 0) {
      throw new Error(`Pipeline is missing stage implementations: ${missing.join(', ')}`);
    }
  }

  async run(ctx: StageContext): Promise<void> {
    let completedWeight = 0;

    for (const stage of this.stages) {
      // Cooperative cancellation: checked between stages so we never abandon a
      // stage mid-write and leave orphaned artifacts.
      if (await this.isCancelled(ctx)) {
        ctx.log.info('Job cancelled, halting pipeline', { stage: stage.name });
        await ctx.events.cancelled(ctx.jobId);
        return;
      }

      const weight = STAGE_WEIGHTS[stage.name] ?? 0;

      if (stage.skipIf?.(ctx)) {
        await this.recordStage(ctx, stage.name, 'SKIPPED', 0, null);
        completedWeight += weight;
        await this.updateProgress(ctx, stage.name, completedWeight);
        continue;
      }

      const outcome = await this.runStage(ctx, stage, completedWeight);

      if (outcome.status === 'FAILED') {
        throw outcome.error;
      }

      completedWeight += weight;
      await this.updateProgress(ctx, stage.name, completedWeight);
    }
  }

  private async runStage(
    ctx: StageContext,
    stage: Stage,
    completedWeight: number,
  ): Promise<{ status: 'SUCCEEDED' | 'DEGRADED' | 'FAILED'; error?: AppError }> {
    const policy = stage.retry;
    let lastError: AppError | undefined;

    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      const startedAt = Date.now();
      const stageCtx: StageContext = { ...ctx, attempt };

      await this.recordStageStart(ctx, stage.name, attempt);
      await ctx.events.stage(
        ctx.jobId,
        stage.name,
        'RUNNING',
        STAGE_TO_STATUS[stage.name],
        completedWeight,
      );

      try {
        await stage.run(stageCtx);
        const durationMs = Date.now() - startedAt;
        ctx.state.timings[stage.name] = durationMs;

        await this.recordStage(ctx, stage.name, 'SUCCEEDED', durationMs, null, attempt);
        await this.checkpoint(ctx);

        ctx.log.info('Stage succeeded', { stage: stage.name, durationMs, attempt });
        return { status: 'SUCCEEDED' };
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        const appErr =
          err instanceof AppError
            ? err
            : new AppError('INTERNAL_ERROR', { cause: String(err) });

        lastError = appErr;

        const isLastAttempt = attempt === policy.maxAttempts - 1;
        const isNonRetryable = policy.nonRetryableCodes.includes(appErr.code);

        ctx.log.warn('Stage failed', {
          stage: stage.name,
          attempt,
          code: appErr.code,
          durationMs,
          willRetry: !isLastAttempt && !isNonRetryable,
        });

        if (isNonRetryable || isLastAttempt) {
          // An optional stage degrades rather than killing the job — the user
          // gets an untextured avatar instead of an error screen.
          if (stage.optional) {
            await this.recordStage(ctx, stage.name, 'DEGRADED', durationMs, appErr.code, attempt);
            await ctx.events.stage(
              ctx.jobId,
              stage.name,
              'DEGRADED',
              STAGE_TO_STATUS[stage.name],
              completedWeight,
            );
            ctx.log.warn('Optional stage degraded, continuing', {
              stage: stage.name,
              code: appErr.code,
            });
            return { status: 'DEGRADED' };
          }

          await this.recordStage(ctx, stage.name, 'FAILED', durationMs, appErr.code, attempt);
          return { status: 'FAILED', error: appErr };
        }

        await this.recordStage(ctx, stage.name, 'FAILED', durationMs, appErr.code, attempt);
        await sleep(policy.backoffMs(attempt));
      }
    }

    return {
      status: 'FAILED',
      error: lastError ?? new AppError('INTERNAL_ERROR'),
    };
  }

  private async isCancelled(ctx: StageContext): Promise<boolean> {
    const job = await ctx.prisma.reconstructionJob.findUnique({
      where: { id: ctx.jobId },
      select: { status: true },
    });
    return job?.status === 'CANCELLED';
  }

  private async recordStageStart(
    ctx: StageContext,
    name: StageName,
    attempt: number,
  ): Promise<void> {
    await ctx.prisma.jobStage.upsert({
      where: { jobId_name_attempt: { jobId: ctx.jobId, name, attempt } },
      create: {
        jobId: ctx.jobId,
        name,
        attempt,
        sequence: STAGE_ORDER.indexOf(name),
        status: 'RUNNING',
        startedAt: new Date(),
      },
      update: { status: 'RUNNING', startedAt: new Date() },
    });
  }

  private async recordStage(
    ctx: StageContext,
    name: StageName,
    status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'DEGRADED',
    durationMs: number,
    errorCode: string | null,
    attempt = 0,
  ): Promise<void> {
    await ctx.prisma.jobStage.upsert({
      where: { jobId_name_attempt: { jobId: ctx.jobId, name, attempt } },
      create: {
        jobId: ctx.jobId,
        name,
        attempt,
        sequence: STAGE_ORDER.indexOf(name),
        status,
        durationMs,
        errorCode,
        startedAt: new Date(Date.now() - durationMs),
        finishedAt: new Date(),
      },
      update: { status, durationMs, errorCode, finishedAt: new Date() },
    });
  }

  private async updateProgress(
    ctx: StageContext,
    stage: StageName,
    weight: number,
  ): Promise<void> {
    const progress = Math.min(1, weight);
    await ctx.prisma.reconstructionJob.update({
      where: { id: ctx.jobId },
      data: { status: STAGE_TO_STATUS[stage], progress },
    });
    await ctx.events.stage(ctx.jobId, stage, 'SUCCEEDED', STAGE_TO_STATUS[stage], progress);
  }

  /**
   * Persists pipeline state so a retry resumes from the last good stage.
   * Cheap (a few KB of JSON) relative to redoing GPU work.
   */
  private async checkpoint(ctx: StageContext): Promise<void> {
    const key = ctx.storage.key({
      userId: ctx.userId,
      jobId: ctx.jobId,
      kind: 'state',
      fileName: 'pipeline-state.json',
    });
    await ctx.storage.put(key, JSON.stringify(ctx.state), 'application/json');
  }
}

export function userMessageFor(code: string): string {
  return (
    ERROR_CATALOG[code as ErrorCode]?.message ?? ERROR_CATALOG.INTERNAL_ERROR.message
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { log };
