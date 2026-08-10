import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  isTerminal,
  PIPELINE_VERSION,
  STAGE_ORDER,
  STAGE_WEIGHTS,
  type CreateJobRequest,
  type CreateJobResponse,
  type Job,
  type JobStageView,
  type StageName,
} from '@tailorai/contracts';
import type { JobStage, ReconstructionJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { UsersService } from '../users/users.service';
import { loadEnv, type Env } from '../../config/env';

/** Rough wall-clock estimate shown to the user. Refined from telemetry in M3. */
const ESTIMATED_SECONDS = { fast: 90, standard: 180, high: 300 } as const;

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private readonly env: Env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly users: UsersService,
  ) {}

  async create(
    userId: string,
    req: CreateJobRequest,
    idempotencyKey?: string,
  ): Promise<CreateJobResponse> {
    // Replaying a key returns the original result — a phone on a flaky
    // connection must not create three reconstructions.
    if (idempotencyKey) {
      const existing = await this.prisma.reconstructionJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        if (existing.userId !== userId) throw new AppError('CONFLICT');
        return {
          id: existing.id,
          status: existing.status,
          estimatedSeconds: ESTIMATED_SECONDS.standard,
        };
      }
    }

    // Gate 1: biometric consent. Enforced here, not in the UI (docs/06 §6.1).
    await this.users.assertBiometricConsent(userId);

    const session = await this.prisma.captureSession.findFirst({
      where: { id: req.sessionId, userId },
      include: { _count: { select: { assets: true } } },
    });
    if (!session) throw new AppError('NOT_FOUND');
    if (session.status !== 'READY') {
      throw new AppError('SESSION_NOT_READY', { sessionId: session.id, status: session.status });
    }
    if (session._count.assets === 0) throw new AppError('INSUFFICIENT_FRAMES');

    // Gate 2: concurrency. GPU is the scarce resource; one job per user keeps
    // a single user from monopolising the queue.
    const active = await this.prisma.reconstructionJob.count({
      where: { userId, status: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } },
    });
    if (active >= this.env.MAX_CONCURRENT_JOBS_PER_USER) {
      throw new AppError('CONCURRENT_JOB_LIMIT', { userId, active });
    }

    // Gate 3: daily quota.
    const since = new Date(Date.now() - 86_400_000);
    const today = await this.prisma.reconstructionJob.count({
      where: { userId, queuedAt: { gte: since } },
    });
    if (today >= this.env.MAX_JOBS_PER_DAY_PER_USER) {
      throw new AppError('QUOTA_EXCEEDED', { userId, today });
    }

    const options = req.options ?? { quality: 'standard' as const, textured: true };

    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.reconstructionJob.create({
        data: {
          userId,
          sessionId: session.id,
          pipelineVersion: PIPELINE_VERSION,
          options,
          idempotencyKey: idempotencyKey ?? null,
          modelVersions: {
            body: this.env.RECONSTRUCTION_ADAPTER,
            segmentation: this.env.SEGMENTATION_ADAPTER,
          },
        },
      });

      // Materialise the full stage list up front so progress is computable
      // from the DB alone, without asking the worker what it plans to do.
      await tx.jobStage.createMany({
        data: STAGE_ORDER.map((name, i) => ({
          jobId: created.id,
          name,
          sequence: i,
          status: 'PENDING' as const,
        })),
      });

      await tx.captureSession.update({
        where: { id: session.id },
        data: { status: 'PROCESSING' },
      });

      return created;
    });

    await this.queue.enqueueReconstruction({
      jobId: job.id,
      userId,
      sessionId: session.id,
      options,
    });

    this.logger.log(JSON.stringify({ event: 'job_created', jobId: job.id, userId }));

    return {
      id: job.id,
      status: job.status,
      estimatedSeconds: ESTIMATED_SECONDS[options.quality],
    };
  }

  async findOne(userId: string, jobId: string): Promise<Job> {
    const job = await this.prisma.reconstructionJob.findFirst({
      where: { id: jobId, userId },
      include: {
        stages: { orderBy: { sequence: 'asc' } },
        bodyCore: { select: { id: true } },
        render: { select: { id: true } },
      },
    });
    if (!job) throw new AppError('NOT_FOUND');
    return this.toDto(job, job.stages, job.bodyCore?.id, job.render?.id);
  }

  async list(
    userId: string,
    opts: { limit: number; cursor?: string; status?: string },
  ): Promise<{ data: Job[]; nextCursor: string | null }> {
    const rows = await this.prisma.reconstructionJob.findMany({
      where: {
        userId,
        ...(opts.status ? { status: opts.status as ReconstructionJob['status'] } : {}),
      },
      include: {
        stages: { orderBy: { sequence: 'asc' } },
        bodyCore: { select: { id: true } },
        render: { select: { id: true } },
      },
      orderBy: { queuedAt: 'desc' },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });

    const hasMore = rows.length > opts.limit;
    const page = hasMore ? rows.slice(0, opts.limit) : rows;

    return {
      data: page.map((j) => this.toDto(j, j.stages, j.bodyCore?.id, j.render?.id)),
      nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * Cancellation is cooperative for running jobs: we flip the DB status and the
   * orchestrator checks it between stages. Killing mid-stage would leave
   * partial artifacts with no owner.
   */
  async cancel(userId: string, jobId: string): Promise<Job> {
    const job = await this.prisma.reconstructionJob.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new AppError('NOT_FOUND');
    if (isTerminal(job.status)) {
      throw new AppError('CONFLICT', { status: job.status }, 'That scan has already finished.');
    }

    await this.queue.cancel(jobId);
    await this.prisma.reconstructionJob.update({
      where: { id: jobId },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });

    return this.findOne(userId, jobId);
  }

  // ── mapping ──

  private toDto(
    job: ReconstructionJob,
    stages: JobStage[],
    bodyCoreId?: string,
    renderId?: string,
  ): Job {
    const stageViews: JobStageView[] = stages.map((s) => ({
      name: s.name as StageName,
      sequence: s.sequence,
      status: s.status,
      attempt: s.attempt,
      startedAt: s.startedAt?.toISOString() ?? null,
      finishedAt: s.finishedAt?.toISOString() ?? null,
      durationMs: s.durationMs,
      errorCode: s.errorCode,
    }));

    return {
      id: job.id,
      sessionId: job.sessionId,
      status: job.status,
      progress: job.progress,
      stages: stageViews,
      pipelineVersion: job.pipelineVersion,
      errorCode: job.errorCode,
      errorMessage: job.errorMessage,
      queuedAt: job.queuedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      estimatedSecondsRemaining: this.estimateRemaining(job, stages),
      result:
        bodyCoreId && renderId ? { bodyCoreId, renderId } : null,
    };
  }

  /**
   * Estimate derived from remaining stage weights, not a countdown timer.
   *
   * A timer that hits zero while the job is still running destroys trust more
   * than a slightly wrong estimate does.
   */
  private estimateRemaining(job: ReconstructionJob, stages: JobStage[]): number | null {
    if (isTerminal(job.status)) return null;

    const quality = (job.options as { quality?: keyof typeof ESTIMATED_SECONDS })?.quality;
    const total = ESTIMATED_SECONDS[quality ?? 'standard'];

    const remainingWeight = stages
      .filter((s) => s.status === 'PENDING' || s.status === 'RUNNING')
      .reduce((sum, s) => sum + (STAGE_WEIGHTS[s.name as StageName] ?? 0), 0);

    return Math.max(1, Math.round(total * remainingWeight));
  }
}
