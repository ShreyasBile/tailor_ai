import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '@tailorai/contracts';

export interface AuthedUser {
  id: string;
  externalId: string;
}

export type AuthedRequest = Request & { user?: AuthedUser; userId?: string };

/**
 * Resolves the authenticated user, throwing rather than returning undefined.
 *
 * A handler that receives `undefined` and forgets to check is how data leaks
 * across accounts; making the decorator throw removes that failure mode.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthedUser => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user) throw new AppError('UNAUTHENTICATED');
    return req.user;
  },
);
