import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

/**
 * Typed API client.
 *
 * Handles the three things every request needs and nobody should have to
 * remember: bearer auth, transparent token refresh on 401, and mapping
 * RFC 9457 problems into a typed error the UI can branch on.
 */

const BASE_URL = (Constants.expoConfig?.extra?.apiUrl as string) ?? 'http://localhost:3000';
const API = `${BASE_URL}/v1`;

const ACCESS_KEY = 'tailorai.accessToken';
const REFRESH_KEY = 'tailorai.refreshToken';

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  retryable: boolean;
}

/** Carries the taxonomy code so screens can offer the right recovery action. */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static async fromResponse(res: Response): Promise<ApiError> {
    try {
      const problem = (await res.json()) as ProblemDetails;
      return new ApiError(
        problem.code ?? 'INTERNAL_ERROR',
        res.status,
        problem.retryable ?? false,
        // `detail` is written for a person on a phone — show it verbatim.
        problem.detail ?? 'Something went wrong.',
      );
    } catch {
      return new ApiError('INTERNAL_ERROR', res.status, res.status >= 500, 'Something went wrong.');
    }
  }
}

export const tokens = {
  async get(): Promise<{ access: string | null; refresh: string | null }> {
    const [access, refresh] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
    ]);
    return { access, refresh };
  },
  async set(access: string, refresh: string): Promise<void> {
    // Keychain/Keystore, never AsyncStorage — these are session credentials
    // guarding biometric data.
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, access),
      SecureStore.setItemAsync(REFRESH_KEY, refresh),
    ]);
  },
  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
    ]);
  },
};

let refreshInFlight: Promise<boolean> | null = null;

async function refreshTokens(): Promise<boolean> {
  // Collapse concurrent refreshes: several requests 401-ing at once must not
  // each burn a single-use refresh token.
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const { refresh } = await tokens.get();
    if (!refresh) return false;

    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: refresh }),
      });
      if (!res.ok) {
        await tokens.clear();
        return false;
      }
      const data = (await res.json()) as { accessToken: string; refreshToken: string };
      await tokens.set(data.accessToken, data.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  skipAuth?: boolean;
  retryOn401?: boolean;
  timeoutMs?: number;
}

/**
 * Without this, a request to an unreachable host hangs until the OS gives up —
 * a minute or more of a spinner with no explanation. On a phone, wrong Wi-Fi
 * and captive portals are normal, so failing fast and saying so beats waiting.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const {
    method = 'GET',
    body,
    idempotencyKey,
    skipAuth,
    retryOn401 = true,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (!skipAuth) {
    const { access } = await tokens.get();
    if (access) headers.authorization = `Bearer ${access}`;
  }
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ApiError(
      aborted ? 'TIMEOUT' : 'NETWORK_ERROR',
      0,
      true,
      aborted
        ? "That took too long. Check you're on the same Wi-Fi and try again."
        : "Couldn't reach the server. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 && retryOn401 && !skipAuth) {
    if (await refreshTokens()) {
      return request<T>(path, { ...opts, retryOn401: false });
    }
  }

  if (!res.ok) throw await ApiError.fromResponse(res);
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

export const apiBaseUrl = API;
