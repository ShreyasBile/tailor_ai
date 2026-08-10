import type { User } from '@prisma/client';
import type { UserProfile } from '@tailorai/contracts';

/**
 * DB row → API shape.
 *
 * Explicit rather than spread: a new sensitive column must be deliberately
 * exposed, never leak into responses because someone added a field.
 */
export function toUserProfile(user: User): UserProfile {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    heightCm: user.heightCm,
    weightKg: user.weightKg,
    birthYear: user.birthYear,
    sexAtBirth: user.sexAtBirth,
    dataRegion: user.dataRegion,
    createdAt: user.createdAt.toISOString(),
  };
}
