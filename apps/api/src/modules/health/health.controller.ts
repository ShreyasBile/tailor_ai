import { Controller, Get } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { Public } from '../../common/auth.guard';
import { loadEnv } from '../../config/env';

@Controller({ path: 'health', version: '1' })
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  /** Liveness: is the process up. Deliberately does no I/O. */
  @Public()
  @Get()
  live(): { status: string; version: string } {
    return { status: 'ok', version: process.env.npm_package_version ?? '0.1.0' };
  }

  /** Readiness: can we actually serve traffic. Checks every dependency. */
  @Public()
  @Get('ready')
  async ready(): Promise<Record<string, unknown>> {
    const env = loadEnv();
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'ok';
    } catch (err) {
      checks.database = `error: ${String(err)}`;
      ok = false;
    }

    try {
      checks.queueDepth = String(await this.queue.depth());
      checks.queue = 'ok';
    } catch (err) {
      checks.queue = `error: ${String(err)}`;
      ok = false;
    }

    return {
      status: ok ? 'ok' : 'degraded',
      modelTier: env.MODEL_TIER,
      adapters: {
        body: env.RECONSTRUCTION_ADAPTER,
        segmentation: env.SEGMENTATION_ADAPTER,
      },
      checks,
    };
  }
}
