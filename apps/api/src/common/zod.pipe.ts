import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import { ZodSchema, ZodError } from 'zod';
import { AppError } from '@tailorai/contracts';

/**
 * Validates request payloads against the shared zod contracts.
 *
 * Using the same schemas the mobile client is generated from means a shape the
 * app can construct is a shape the API accepts, by construction rather than by
 * discipline.
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata): unknown {
    try {
      return this.schema.parse(value);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new AppError(
          'VALIDATION_FAILED',
          {
            issues: err.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
          err.issues
            .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
            .join('; '),
        );
      }
      throw err;
    }
  }
}

export function zodBody(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
