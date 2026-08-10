import { Global, Module, Logger } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { AUTH_PROVIDER, type AuthProvider } from './auth.provider';
import { LocalAuthProvider } from './providers/local.provider';
import { loadEnv } from '../../config/env';

/**
 * Provider selection happens once, here. Adding Clerk or Supabase means adding
 * a class that implements AuthProvider and one case below — no caller changes.
 */
function createProvider(): AuthProvider {
  const env = loadEnv();
  switch (env.AUTH_PROVIDER) {
    case 'local':
      return new LocalAuthProvider();
    case 'clerk':
    case 'supabase':
      throw new Error(
        `AUTH_PROVIDER=${env.AUTH_PROVIDER} is not implemented yet. ` +
          `Add apps/api/src/modules/auth/providers/${env.AUTH_PROVIDER}.provider.ts ` +
          `implementing AuthProvider, then register it here.`,
      );
    default:
      throw new Error(`Unknown AUTH_PROVIDER: ${String(env.AUTH_PROVIDER)}`);
  }
}

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: AUTH_PROVIDER,
      useFactory: (): AuthProvider => {
        const provider = createProvider();
        new Logger('AuthModule').log(`Auth provider: ${provider.name}`);
        return provider;
      },
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
