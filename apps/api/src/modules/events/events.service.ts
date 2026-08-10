import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import type { JobEvent } from '@tailorai/contracts';
import { loadEnv } from '../../config/env';
import { jobChannel, jobEventLog, JOB_EVENT_LOG_TTL_SECONDS } from '../queue/queue.constants';

interface Envelope {
  jobId: string;
  seq: number;
  event: JobEvent;
}

/**
 * Fan-out for job progress.
 *
 * The orchestrator publishes to Redis; every API instance subscribes and
 * relays to its own SSE clients. This keeps the API stateless — any instance
 * can serve any job's stream, so scaling out needs no sticky sessions.
 *
 * A bounded replay log per job lets a reconnecting client resume from
 * Last-Event-ID instead of missing the transitions it slept through, which on
 * mobile is most of them.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private subscriber!: Redis;
  private publisher!: Redis;
  private readonly stream = new Subject<Envelope>();
  private readonly subscribed = new Set<string>();

  async onModuleInit(): Promise<void> {
    const url = loadEnv().REDIS_URL;
    this.subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    this.publisher = new IORedis(url, { maxRetriesPerRequest: null });

    this.subscriber.on('pmessage', (_pattern, channel, payload) => {
      try {
        const envelope = JSON.parse(payload) as Envelope;
        this.stream.next(envelope);
      } catch (err) {
        this.logger.warn(`Malformed event on ${channel}: ${String(err)}`);
      }
    });

    await this.subscriber.psubscribe('job:*:events');
    this.logger.log('Subscribed to job event channels');
  }

  async onModuleDestroy(): Promise<void> {
    this.subscriber?.disconnect();
    this.publisher?.disconnect();
    this.stream.complete();
  }

  /** Publishes an event and appends it to the bounded replay log. */
  async publish(jobId: string, event: JobEvent): Promise<void> {
    const logKey = jobEventLog(jobId);
    const seq = await this.publisher.rpush(logKey, JSON.stringify(event));
    await this.publisher.expire(logKey, JOB_EVENT_LOG_TTL_SECONDS);

    const envelope: Envelope = { jobId, seq, event };
    await this.publisher.publish(jobChannel(jobId), JSON.stringify(envelope));
  }

  /** Events missed while disconnected, replayed in order. */
  async replay(jobId: string, afterSeq: number): Promise<Array<{ seq: number; event: JobEvent }>> {
    const entries = await this.publisher.lrange(jobEventLog(jobId), afterSeq, -1);
    return entries.map((raw, i) => ({
      seq: afterSeq + i + 1,
      event: JSON.parse(raw) as JobEvent,
    }));
  }

  /** Live stream for one job. */
  subscribe(jobId: string): Observable<{ seq: number; event: JobEvent }> {
    this.subscribed.add(jobId);
    return this.stream.asObservable().pipe(
      filter((e) => e.jobId === jobId),
      map((e) => ({ seq: e.seq, event: e.event })),
    );
  }
}
