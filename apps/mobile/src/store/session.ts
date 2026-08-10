import { create } from 'zustand';
import { request, tokens } from '../lib/api';

export interface UserProfile {
  id: string;
  email: string | null;
  displayName: string | null;
  heightCm: number | null;
  weightKg: number | null;
  birthYear: number | null;
  sexAtBirth: 'FEMALE' | 'MALE' | 'UNSPECIFIED' | null;
  dataRegion: string;
  createdAt: string;
}

export interface Consent {
  kind: string;
  version: string;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
}

/** Must match apps/api CONSENT_VERSIONS. */
export const BIOMETRIC_CONSENT_VERSION = 'biometric-v1';

interface SessionState {
  user: UserProfile | null;
  consents: Consent[];
  loading: boolean;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  signIn: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  updateProfile: (patch: Partial<UserProfile>) => Promise<void>;
  grantBiometricConsent: () => Promise<void>;
  hasBiometricConsent: () => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  consents: [],
  loading: false,
  hydrated: false,

  async hydrate() {
    set({ loading: true });
    try {
      const { access } = await tokens.get();
      if (!access) {
        set({ hydrated: true, loading: false });
        return;
      }
      const [user, consents] = await Promise.all([
        request<UserProfile>('/me'),
        request<Consent[]>('/me/consents'),
      ]);
      set({ user, consents, hydrated: true, loading: false });
    } catch {
      await tokens.clear();
      set({ user: null, consents: [], hydrated: true, loading: false });
    }
  },

  async signIn(email: string) {
    set({ loading: true });
    try {
      const res = await request<{
        accessToken: string;
        refreshToken: string;
        user: UserProfile;
      }>('/auth/session', { method: 'POST', body: { token: email }, skipAuth: true });

      await tokens.set(res.accessToken, res.refreshToken);
      const consents = await request<Consent[]>('/me/consents');
      set({ user: res.user, consents, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },

  async signOut() {
    try {
      await request('/auth/logout', { method: 'POST', body: {} });
    } catch {
      /* best effort — clearing local tokens is what matters */
    }
    await tokens.clear();
    set({ user: null, consents: [] });
  },

  async refreshProfile() {
    const user = await request<UserProfile>('/me');
    set({ user });
  },

  async updateProfile(patch) {
    const user = await request<UserProfile>('/me', { method: 'PATCH', body: patch });
    set({ user });
  },

  async grantBiometricConsent() {
    await request<Consent>('/me/consents', {
      method: 'POST',
      body: {
        kind: 'BIOMETRIC_PROCESSING',
        version: BIOMETRIC_CONSENT_VERSION,
        granted: true,
      },
    });
    const consents = await request<Consent[]>('/me/consents');
    set({ consents });
  },

  hasBiometricConsent() {
    return get().consents.some(
      (c) =>
        c.kind === 'BIOMETRIC_PROCESSING' &&
        c.version === BIOMETRIC_CONSENT_VERSION &&
        c.granted &&
        !c.revokedAt,
    );
  },
}));
