import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@tailorai/contracts';
import type { AuthProvider, ProviderIdentity } from '../auth.provider';
import { loadEnv } from '../../../config/env';

/**
 * Development-only provider: accepts an email address and trusts it.
 *
 * Exists so the whole stack is runnable without signing up for a third-party
 * service. It refuses to construct when NODE_ENV=production — a dev auth
 * shortcut reaching production is a well-worn way to lose a database.
 */
@Injectable()
export class LocalAuthProvider implements AuthProvider {
  readonly name = 'local';
  private readonly logger = new Logger(LocalAuthProvider.name);

  constructor() {
    if (loadEnv().NODE_ENV === 'production') {
      throw new Error(
        'AUTH_PROVIDER=local is a development shortcut and must never run in production. ' +
          'Configure clerk or supabase.',
      );
    }
    this.logger.warn('Using LOCAL auth provider — any email is accepted. Development only.');
  }

  async verify(token: string): Promise<ProviderIdentity> {
    const email = token.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AppError('UNAUTHENTICATED', undefined, 'Local provider expects an email address');
    }
    return {
      externalId: `local:${email}`,
      email,
      displayName: email.split('@')[0],
      emailVerified: true,
    };
  }
}
