import { AirwallexAuthError, AirwallexApiError, AirwallexConfigError } from './errors.js';

// ── Token Cache ─────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: Date;
}

let tokenCache: TokenCache | null = null;

function getEnvConfig(): { base: string; clientId: string; apiKey: string } {
  const suffix = process.env.AIRWALLEX_ENV === 'prod' ? 'PROD' : 'DEMO';
  const base = process.env[`AIRWALLEX_API_BASE_${suffix}`];
  const clientId = process.env[`AIRWALLEX_CLIENT_ID_${suffix}`];
  const apiKey = process.env[`AIRWALLEX_API_KEY_${suffix}`];

  const missing = [
    ['AIRWALLEX_API_BASE', base],
    ['AIRWALLEX_CLIENT_ID', clientId],
    ['AIRWALLEX_API_KEY', apiKey],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => `${name}_${suffix}`);

  if (!base || !clientId || !apiKey) {
    throw new AirwallexConfigError(missing);
  }

  return { base, clientId, apiKey };
}

/** Clears the cached token. Exported for tests. */
export function resetTokenCache(): void {
  tokenCache = null;
}

async function getToken(): Promise<string> {
  // Reuse cached token if still valid (with 60s buffer)
  if (tokenCache && tokenCache.expiresAt > new Date(Date.now() + 60_000)) {
    return tokenCache.token;
  }

  const { base, clientId, apiKey } = getEnvConfig();

  const res = await fetch(`${base}/authentication/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': clientId,
      'x-api-key': apiKey,
    },
  });

  if (!res.ok) {
    throw new AirwallexAuthError(await res.text(), res.status);
  }

  const data = (await res.json()) as { token: string; expires_at: string };
  tokenCache = { token: data.token, expiresAt: new Date(data.expires_at) };
  return tokenCache.token;
}

// ── Request Helper ──────────────────────────────────────────────

interface RequestOptions {
  idempotencyKey?: string;
  isRetry?: boolean;
}

export async function airwallexRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions
): Promise<T> {
  const { base } = getEnvConfig();
  const token = await getToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  if (options?.idempotencyKey) {
    headers['x-idempotency-key'] = options.idempotencyKey;
  }

  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  // Any 401 means the cached token is no longer accepted — clear it and retry once
  if (res.status === 401 && !options?.isRetry) {
    tokenCache = null;
    return airwallexRequest(method, path, body, { ...options, isRetry: true });
  }

  if (!res.ok) {
    throw new AirwallexApiError(res.status, path, await res.text());
  }

  return res.json() as T;
}
