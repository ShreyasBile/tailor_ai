'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, hasSession, signIn as apiSignIn, signOut as apiSignOut } from './api';
import type { UserProfile } from './types';
import type { PreparedPhoto } from './upload';
import type { View } from './types';

interface SessionState {
  user: UserProfile | null;
  loading: boolean;
  signIn: (email: string) => Promise<UserProfile>;
  signOut: () => Promise<void>;
  reload: () => Promise<UserProfile | null>;
  /** Scan photos survive navigation between /scan and its progress page, so
   * a rejected photo can be retaken without re-choosing the other three. */
  photos: Partial<Record<View, PreparedPhoto>>;
  setPhoto: (view: View, photo: PreparedPhoto | null) => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [photos, setPhotos] = useState<Partial<Record<View, PreparedPhoto>>>({});

  const reload = useCallback(async () => {
    if (!hasSession()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    try {
      const me = await api<UserProfile>('/me');
      setUser(me);
      return me;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const signIn = useCallback(async (email: string) => {
    await apiSignIn(email);
    const me = await api<UserProfile>('/me');
    setUser(me);
    return me;
  }, []);

  const signOut = useCallback(async () => {
    await apiSignOut();
    setUser(null);
    setPhotos({});
  }, []);

  const setPhoto = useCallback((view: View, photo: PreparedPhoto | null) => {
    setPhotos((prev) => {
      const old = prev[view];
      if (old && old !== photo) URL.revokeObjectURL(old.previewUrl);
      const next = { ...prev };
      if (photo) next[view] = photo;
      else delete next[view];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ user, loading, signIn, signOut, reload, photos, setPhoto }),
    [user, loading, signIn, signOut, reload, photos, setPhoto],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
