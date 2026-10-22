/**
 * Browser client for the TailorAI API.
 *
 * Tokens live in localStorage (dev auth; a production deployment would use an
 * httpOnly cookie via the hosted auth provider). A 401 triggers one refresh and
 * one retry — never a loop.
 */

export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3000/v1').replace(/\/$/, '');

const STORAGE_KEY = 'tailorai.session';

interface StoredSession {
  accessToken: string;
  refreshToken: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function readSession(): StoredSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null): void {
  try {
    if (s) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — session lasts for this page only */
  }
}

export function hasSession(): boolean {
  return readSession() !== null;
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  const s = readSession();
  if (!s) return false;
  // Concurrent 401s share one refresh.
  refreshing ??= (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: s.refreshToken }),
      });
      if (!res.ok) {
        // Refresh tokens rotate on use. If another refresh already replaced
        // the one we sent, the session is fine — only a stale token failed.
        const now = readSession();
        if (now && now.refreshToken !== s.refreshToken) return true;
        saveSession(null);
        return false;
      }
      const data = (await res.json()) as StoredSession;
      saveSession({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, signal } = init;

  const doFetch = () => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const s = readSession();
    if (auth && s) headers.authorization = `Bearer ${s.accessToken}`;
    return fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  };

  let res: Response;
  try {
    res = await doFetch();
    if (res.status === 401 && auth && (await refresh())) res = await doFetch();
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', "Can't reach TailorAI. Check that the server is running.");
  }

  if (!res.ok) {
    let code = 'INTERNAL_ERROR';
    let message = `Request failed (${res.status})`;
    try {
      const p = (await res.json()) as { code?: string; detail?: string; message?: string };
      code = p.code ?? code;
      message = p.detail ?? p.message ?? message;
    } catch {
      /* not JSON */
    }
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function signIn(email: string): Promise<void> {
  const data = await api<StoredSession>('/auth/session', {
    method: 'POST',
    body: { token: email },
    auth: false,
  });
  saveSession({ accessToken: data.accessToken, refreshToken: data.refreshToken });
}

export async function signOut(): Promise<void> {
  const s = readSession();
  if (s) {
    await api('/auth/logout', { method: 'POST', body: { refreshToken: s.refreshToken } }).catch(() => {});
  }
  saveSession(null);
}
