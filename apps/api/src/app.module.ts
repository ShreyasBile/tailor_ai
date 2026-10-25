import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './modules/prisma/prisma.module';
import { StorageModule } from './modules/storage/storage.module';
import { QueueModule } from './modules/queue/queue.module';
import { EventsModule } from './modules/events/events.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { AvatarsModule } from './modules/avatars/avatars.module';
import { HealthModule } from './modules/health/health.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { AccuracyModule } from './modules/accuracy/accuracy.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuthGuard } from './common/auth.guard';

@Module({
  imports: [
    // Infrastructure (all @Global)
    PrismaModule,
    StorageModule,
    QueueModule,
    EventsModule,
    AuthModule,
    // Features
    UsersModule,
    UploadsModule,
    JobsModule,
    AvatarsModule,
    CatalogModule,
    AccuracyModule,
    AdminModule,
    HealthModule,
  ],
  providers: [
    // Applied globally: routes authenticate unless they opt out with @Public().
    // Default-deny means forgetting a guard fails closed.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
