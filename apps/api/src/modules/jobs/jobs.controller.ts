import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CreateJobRequest,
  isTerminal,
  type CreateJobResponse,
  type Job,
  type JobEvent,
} from '@tailorai/contracts';
import { JobsService } from './jobs.service';
import { EventsService } from '../events/events.service';
import { zodBody } from '../../common/zod.pipe';
import { CurrentUser, type AuthedUser } from '../../common/current-user.decorator';

/** Idle streams get closed by proxies; a comment frame keeps them open. */
const HEARTBEAT_MS = 15_000;

@Controller({ path: 'jobs', version: '1' })
export class JobsController {
  constructor(
    private readonly jobs: JobsService,
    private readonly events: EventsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AuthedUser,
    @Body(zodBody(CreateJobRequest)) body: CreateJobRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateJobResponse> {
    return this.jobs.create(user.id, body, idempotencyKey);
  }

  @Get()
  async list(
    @CurrentUser() user: AuthedUser,
    @Query('limit') limit = '20',
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
  ): Promise<{ data: Job[]; nextCursor: string | null }> {
    return this.jobs.list(user.id, {
      limit: Math.min(100, Math.max(1, Number(limit) || 20)),
      ...(cursor ? { cursor } : {}),
      ...(status ? { status } : {}),
    });
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Job> {
    return this.jobs.findOne(user.id, id);
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Job> {
    return this.jobs.cancel(user.id, id);
  }

  /**
   * Live progress over SSE.
   *
   * Written against the raw response rather than Nest's @Sse() so we control
   * flushing, heartbeats and Last-Event-ID replay directly — all three matter
   * on mobile, where the app is backgrounded constantly and connections drop
   * mid-job.
   */
  @Get(':id/events')
  async stream(
    @CurrentUser() user: AuthedUser,
    @Param('id', ParseUUIDPipe) jobId: string,
    @Req() req: Request,
    @Res() res: Response,
    @Headers('last-event-id') lastEventId?: string,
  ): Promise<void> {
    // Ownership check before opening the stream.
    const job = await this.jobs.findOne(user.id, jobId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (seq: number, event: JobEvent): void => {
      res.write(`id: ${seq}\n`);
      res.write(`event: ${event.event}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    // Replay whatever the client missed while disconnected.
    const from = Number(lastEventId ?? 0) || 0;
    for (const { seq, event } of await this.events.replay(jobId, from)) {
      send(seq, event);
    }

    // Already finished — say so and close rather than holding a dead stream.
    if (isTerminal(job.status)) {
      send(from + 1, {
        event: job.status === 'COMPLETED' ? 'completed' : 'failed',
        jobId,
        ...(job.status === 'COMPLETED'
          ? { bodyCoreId: job.result?.bodyCoreId ?? '', renderId: job.result?.renderId ?? '' }
          : {
              errorCode: job.errorCode ?? 'INTERNAL_ERROR',
              errorMessage: job.errorMessage ?? '',
              retryable: false,
            }),
        at: new Date().toISOString(),
      } as JobEvent);
      res.end();
      return;
    }

    const subscription = this.events.subscribe(jobId).subscribe(({ seq, event }) => {
      send(seq, event);
      if (event.event === 'completed' || event.event === 'failed' || event.event === 'cancelled') {
        cleanup();
        res.end();
      }
    });

    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }
}
