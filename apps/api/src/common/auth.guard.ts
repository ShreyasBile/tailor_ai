import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '@tailorai/contracts';
import { AuthService } from '../modules/auth/auth.service';
import type { AuthedRequest } from './current-user.decorator';

export const IS_PUBLIC = 'isPublic';
/** Opt out of authentication. Applied explicitly, never by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);

/**
 * Applied globally. Routes are authenticated unless they opt out with @Public().
 *
 * Default-deny: forgetting a guard should fail closed, not expose an endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();

    // SSE cannot set headers from EventSource, so a query token is permitted
    // for that route only. Short-lived access tokens keep the exposure bounded.
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const queryToken =
      typeof req.query?.access_token === 'string' ? req.query.access_token : undefined;

    const token = bearer ?? queryToken;
    if (!token) throw new AppError('UNAUTHENTICATED');

    const user = await this.auth.verifyAccessToken(token);
    req.user = user;
    req.userId = user.id;
    return true;
  }
}
