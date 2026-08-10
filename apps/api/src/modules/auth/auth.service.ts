import { Inject, Injectable, Logger } from '@nestjs/common';
import { SignJWT, jwtVerify } from 'jose';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, type SessionResponse, type UserProfile } from '@tailorai/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { loadEnv, type Env } from '../../config/env';
import { AUTH_PROVIDER, type AuthProvider } from './auth.provider';
import type { AuthedUser } from '../../common/current-user.decorator';
import { toUserProfile } from '../users/users.mapper';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly env: Env = loadEnv();
  private readonly secret: Uint8Array;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {
    this.secret = new TextEncoder().encode(this.env.JWT_SECRET);
  }

  /** Exchange a provider credential for app tokens, provisioning on first sight. */
  async createSession(providerToken: string): Promise<SessionResponse> {
    const identity = await this.provider.verify(providerToken);

    const user = await this.prisma.user.upsert({
      where: { externalId: identity.externalId },
      create: {
        externalId: identity.externalId,
        email: identity.email ?? null,
        displayName: identity.displayName ?? null,
      },
      update: {
        // Keep email fresh, but never clobber a name the user set themselves.
        ...(identity.email ? { email: identity.email } : {}),
      },
    });

    if (user.deletedAt) {
      throw new AppError('FORBIDDEN', { userId: user.id }, 'This account has been deleted.');
    }

    const accessToken = await this.signAccess(user.id, user.externalId);
    const refreshToken = await this.issueRefresh(user.id);

    return {
      accessToken,
      refreshToken,
      expiresIn: this.env.JWT_ACCESS_TTL,
      user: toUserProfile(user),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthedUser> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: 'tailorai',
        audience: 'tailorai-app',
      });
      if (payload.typ !== 'access') throw new Error('wrong token type');
      return { id: String(payload.sub), externalId: String(payload.ext) };
    } catch {
      throw new AppError('UNAUTHENTICATED');
    }
  }

  /**
   * Rotates the refresh token on every use.
   *
   * A refresh token that survives its own use is a replayable credential; if
   * one is stolen, rotation means at most one extra session before the theft
   * becomes visible as a failed refresh.
   */
  async refresh(refreshToken: string): Promise<SessionResponse> {
    const tokenHash = this.hash(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new AppError('UNAUTHENTICATED', undefined, 'Session expired. Please sign in again.');
    }
    if (stored.user.deletedAt) throw new AppError('FORBIDDEN');

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    const accessToken = await this.signAccess(stored.user.id, stored.user.externalId);
    const nextRefresh = await this.issueRefresh(stored.user.id);

    return {
      accessToken,
      refreshToken: nextRefresh,
      expiresIn: this.env.JWT_ACCESS_TTL,
      user: toUserProfile(stored.user),
    };
  }

  async logout(userId: string, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash: this.hash(refreshToken), userId },
        data: { revokedAt: new Date() },
      });
    } else {
      // No token supplied ⇒ revoke everything. "Sign out everywhere".
      await this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
  }

  private async signAccess(userId: string, externalId: string): Promise<string> {
    return new SignJWT({ ext: externalId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuer('tailorai')
      .setAudience('tailorai-app')
      .setIssuedAt()
      .setExpirationTime(`${this.env.JWT_ACCESS_TTL}s`)
      .sign(this.secret);
  }

  private async issueRefresh(userId: string): Promise<string> {
    const token = randomBytes(48).toString('base64url');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        // Only the hash is stored; a leaked table yields no usable tokens.
        tokenHash: this.hash(token),
        expiresAt: new Date(Date.now() + this.env.JWT_REFRESH_TTL * 1000),
      },
    });
    return token;
  }

  private hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
