import IORedis, { type Redis } from 'ioredis';
import type { JobEvent, JobStatus, StageName, StageStatus } from '@tailorai/contracts';
import { config } from './config';

const EVENT_LOG_TTL_SECONDS = 3600;

/**
 * Publishes job progress to Redis, where every API instance relays it to its
 * own SSE clients.
 *
 * The bounded replay log is what lets a phone that was backgrounded for two
 * minutes reconnect and catch up rather than showing a frozen progress bar.
 */
export class EventPublisher {
  private readonly redis: Redis;

  constructor() {
    this.redis = new IORedis(config().REDIS_URL, { maxRetriesPerRequest: null });
  }

  async stage(
    jobId: string,
    stage: StageName,
    status: StageStatus,
    jobStatus: JobStatus,
    progress: number,
  ): Promise<void> {
    await this.publish(jobId, {
      event: 'stage',
      jobId,
      stage,
      status,
      jobStatus,
      progress,
      at: new Date().toISOString(),
    });
  }

  async completed(jobId: string, bodyCoreId: string, renderId: string): Promise<void> {
    await this.publish(jobId, {
      event: 'completed',
      jobId,
      bodyCoreId,
      renderId,
      at: new Date().toISOString(),
    });
  }

  async failed(
    jobId: string,
    errorCode: string,
    errorMessage: string,
    retryable: boolean,
  ): Promise<void> {
    await this.publish(jobId, {
      event: 'failed',
      jobId,
      errorCode,
      errorMessage,
      retryable,
      at: new Date().toISOString(),
    });
  }

  async cancelled(jobId: string): Promise<void> {
    await this.publish(jobId, { event: 'cancelled', jobId, at: new Date().toISOString() });
  }

  private async publish(jobId: string, event: JobEvent): Promise<void> {
    const logKey = `job:${jobId}:log`;
    const seq = await this.redis.rpush(logKey, JSON.stringify(event));
    await this.redis.expire(logKey, EVENT_LOG_TTL_SECONDS);
    await this.redis.publish(`job:${jobId}:events`, JSON.stringify({ jobId, seq, event }));
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}
