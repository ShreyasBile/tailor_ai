import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  type Consent,
  type GrantConsentRequest,
  type UpdateProfileRequest,
  type UserProfile,
} from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import { loadEnv, type Env } from '../../config/env';
import { toUserProfile } from './users.mapper';

/** Consent document versions. Bumping one re-prompts every user. */
export const CONSENT_VERSIONS = {
  BIOMETRIC_PROCESSING: 'biometric-v1',
  RAW_MEDIA_RETENTION: 'retention-v1',
  MODEL_IMPROVEMENT: 'improvement-v1',
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly env: Env = loadEnv();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async getProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });
    if (!user) throw new AppError('NOT_FOUND');
    return toUserProfile(user);
  }

  async updateProfile(userId: string, patch: UpdateProfileRequest): Promise<UserProfile> {
    // Age gate: minors are out of scope entirely. See docs/06 §6.2 — this is a
    // deliberate product restriction, not a model limitation.
    if (patch.birthYear !== undefined) {
      const age = new Date().getFullYear() - patch.birthYear;
      if (age < this.env.MIN_AGE_YEARS) {
        throw new AppError('AGE_RESTRICTED', { userId, age });
      }
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: patch,
    });
    return toUserProfile(user);
  }

  // ── Consent ──

  async listConsents(userId: string): Promise<Consent[]> {
    const rows = await this.prisma.consent.findMany({
      where: { userId },
      orderBy: { grantedAt: 'desc' },
    });
    return rows.map((c) => ({
      kind: c.kind,
      version: c.version,
      granted: c.granted,
      grantedAt: c.grantedAt.toISOString(),
      revokedAt: c.revokedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Appends to the consent ledger. Never updates in place.
   *
   * BIPA and GDPR require proving what was consented to, when, and from where —
   * years later. An overwritten row cannot do that.
   */
  async recordConsent(
    userId: string,
    req: GrantConsentRequest,
    meta: { ipAddress?: string; userAgent?: string },
  ): Promise<Consent> {
    if (!req.granted) {
      await this.prisma.consent.updateMany({
        where: { userId, kind: req.kind, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const row = await this.prisma.consent.create({
      data: {
        userId,
        kind: req.kind,
        version: req.version,
        granted: req.granted,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    this.logger.log(
      JSON.stringify({ event: 'consent', userId, kind: req.kind, granted: req.granted }),
    );

    return {
      kind: row.kind,
      version: row.version,
      granted: row.granted,
      grantedAt: row.grantedAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }

  /**
   * Hard gate enforced before any biometric processing begins.
   *
   * Called from job creation, not from the UI layer — a checkbox in an app is a
   * UX affordance; this is the control.
   */
  async assertBiometricConsent(userId: string): Promise<void> {
    if (!this.env.REQUIRE_BIOMETRIC_CONSENT) return;

    const latest = await this.prisma.consent.findFirst({
      where: {
        userId,
        kind: 'BIOMETRIC_PROCESSING',
        version: CONSENT_VERSIONS.BIOMETRIC_PROCESSING,
      },
      orderBy: { grantedAt: 'desc' },
    });

    if (!latest || !latest.granted || latest.revokedAt) {
      throw new AppError('CONSENT_REQUIRED', {
        userId,
        required: CONSENT_VERSIONS.BIOMETRIC_PROCESSING,
      });
    }
  }

  // ── Erasure & portability ──

  /**
   * GDPR erasure. Deletes storage first, then rows.
   *
   * Ordering matters: if we delete rows first and the storage sweep fails, we
   * have orphaned biometric blobs and no record of where they are.
   */
  async deleteAccount(userId: string): Promise<void> {
    await this.storage.deletePrefix(`users/${userId}/`);

    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          email: null,
          displayName: null,
          heightCm: null,
          weightKg: null,
          birthYear: null,
          sexAtBirth: null,
        },
      }),
      // Cascades remove sessions, assets, jobs, cores and renders.
      this.prisma.captureSession.deleteMany({ where: { userId } }),
      this.prisma.bodyCore.deleteMany({ where: { userId } }),
    ]);

    this.logger.log(JSON.stringify({ event: 'account_erased', userId }));
  }

  /** GDPR portability. Includes raw shape params — this is the one place they leave. */
  async exportData(userId: string): Promise<Record<string, unknown>> {
    const [user, consents, sessions, cores, jobs] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.consent.findMany({ where: { userId } }),
      this.prisma.captureSession.findMany({ where: { userId }, include: { assets: true } }),
      this.prisma.bodyCore.findMany({ where: { userId }, include: { renders: true } }),
      this.prisma.reconstructionJob.findMany({ where: { userId }, include: { stages: true } }),
    ]);

    if (!user) throw new AppError('NOT_FOUND');

    return {
      exportedAt: new Date().toISOString(),
      format: 'tailorai-export-v1',
      user: toUserProfile(user),
      consents,
      captureSessions: sessions.map((s) => ({
        ...s,
        assets: s.assets.map((a) => ({ ...a, sizeBytes: a.sizeBytes.toString() })),
      })),
      bodyCores: cores,
      jobs,
    };
  }
}
