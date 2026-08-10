/**
 * Identity provider seam.
 *
 * Auth is the thing most likely to be swapped (local dev → Clerk → self-hosted)
 * and the thing most painful to swap if it leaks into callers. Everything above
 * this interface deals in `ProviderIdentity`; nothing knows which provider is
 * configured.
 */
export interface ProviderIdentity {
  /** Stable id from the provider. Stored as `User.externalId`. */
  externalId: string;
  email?: string;
  displayName?: string;
  emailVerified?: boolean;
}

export interface AuthProvider {
  readonly name: string;
  /**
   * Exchange a provider-issued credential for a verified identity.
   * Throws AppError('UNAUTHENTICATED') if the credential is not valid.
   */
  verify(token: string): Promise<ProviderIdentity>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
