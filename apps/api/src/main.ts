import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json } from 'express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './common/problem.filter';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Fails loudly here rather than on the first request that needs a missing var.
  const env = loadEnv();
  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      env.LOG_LEVEL === 'debug'
        ? ['log', 'error', 'warn', 'debug', 'verbose']
        : ['log', 'error', 'warn'],
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('', { exclude: [] });

  app.enableCors({
    origin: env.CORS_ORIGINS,
    credentials: true,
    // Idempotency-Key and Last-Event-ID must survive preflight.
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'Last-Event-ID'],
  });

  app.useGlobalFilters(new ProblemDetailsFilter());

  // JSON bodies only, and small ones — file bytes go straight to object storage
  // via presigned URLs and never pass through here (docs/02 §5). One admin
  // exception: a size-chart image (downscaled in the browser) is read once
  // by Gemini and discarded, so it is posted inline rather than stored.
  app.use('/v1/admin/size-chart/read', json({ limit: '4mb' }));
  app.use(json({ limit: '256kb' }));

  app.enableShutdownHooks();

  await app.listen(env.API_PORT, env.API_HOST);

  logger.log(`API listening on http://${env.API_HOST}:${env.API_PORT}/v1`);
  logger.log(`Model tier: ${env.MODEL_TIER} | adapters: ${env.RECONSTRUCTION_ADAPTER}/${env.SEGMENTATION_ADAPTER}`);
  if (env.AUTH_PROVIDER === 'local') {
    logger.warn('AUTH_PROVIDER=local — development only.');
  }
}

void bootstrap();
