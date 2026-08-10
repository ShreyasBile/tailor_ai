import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { loadEnv, type Env } from '../../config/env';
import { RECONSTRUCTION_QUEUE, type ReconstructionJobData } from './queue.constants';

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly env: Env = loadEnv();
  private queue!: Queue<ReconstructionJobData>;
  private connection!: Redis;

  async onModuleInit(): Promise<void> {
    this.connection = new IORedis(this.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.queue = new Queue<ReconstructionJobData>(RECONSTRUCTION_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        // Job state lives in Postgres; BullMQ retries are only for "the worker
        // died before claiming it". Stage-level retries are the orchestrator's
        // concern, because the right policy differs per stage (docs/02 §3).
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 1000 },
        removeOnFail: { age: 86_400 },
      },
    });

    this.logger.log(`Queue "${RECONSTRUCTION_QUEUE}" ready`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue?.close();
    this.connection?.disconnect();
  }

  async enqueueReconstruction(data: ReconstructionJobData): Promise<void> {
    await this.queue.add('reconstruct', data, {
      // BullMQ dedupes on jobId, giving idempotency a second layer beyond the
      // Idempotency-Key check at the API.
      jobId: data.jobId,
    });
  }

  async cancel(jobId: string): Promise<boolean> {
    const job = await this.queue.getJob(jobId);
    if (!job) return false;
    // Only removable while still waiting — an active job is cancelled
    // cooperatively via the DB status flag the orchestrator checks.
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
      return true;
    }
    return false;
  }

  async depth(): Promise<number> {
    const counts = await this.queue.getJobCounts('waiting', 'active', 'delayed');
    return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
  }
}
