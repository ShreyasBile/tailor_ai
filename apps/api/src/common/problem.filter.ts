import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, buildProblem, type ErrorCode, type ProblemDetails } from '@tailorai/contracts';

/** Taxonomy code for framework-raised HttpExceptions (e.g. ParseUUIDPipe's
 * 400). Anything unmapped stays INTERNAL_ERROR, but keeps its real status. */
const HTTP_STATUS_CODE: Record<number, ErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

/**
 * Single place where errors become HTTP.
 *
 * Everything below this throws typed AppErrors carrying a taxonomy code;
 * exactly one place decides status codes and response shape. That is what
 * makes "the user always sees an actionable message" enforceable rather than
 * aspirational.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const instance = req.originalUrl;

    let problem: ProblemDetails;
    let internal: Record<string, unknown> | undefined;

    if (exception instanceof AppError) {
      problem = exception.toProblem(instance);
      internal = exception.context;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      problem = buildProblem(HTTP_STATUS_CODE[status] ?? 'INTERNAL_ERROR', { instance });
      problem.status = status;
    } else {
      problem = buildProblem('INTERNAL_ERROR', { instance });
      internal = { raw: exception instanceof Error ? exception.message : String(exception) };
    }

    // 5xx is our fault and must be investigable; 4xx is expected traffic.
    const logPayload = {
      code: problem.code,
      status: problem.status,
      method: req.method,
      path: instance,
      // Never log request bodies — they can carry biometric data (docs/02 §6).
      userId: (req as Request & { userId?: string }).userId,
      ...internal,
    };

    if (problem.status >= 500) {
      this.logger.error(
        JSON.stringify(logPayload),
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(JSON.stringify(logPayload));
    }

    res.status(problem.status).type('application/problem+json').json(problem);
  }
}
