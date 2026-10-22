import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import type { ZodSchema } from 'zod';
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
    // safeParse, not parse + `instanceof ZodError`: the schemas come from the
    // ESM contracts package while this file loads zod's CJS build, so the two
    // ZodError classes differ and instanceof is always false (every invalid
    // body became a 500).
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;
    const { issues } = result.error;
    throw new AppError(
      'VALIDATION_FAILED',
      {
        issues: issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      },
      issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
    );
  }
}

export function zodBody(schema: ZodSchema): ZodValidationPipe {
  return new ZodValidationPipe(schema);
}
