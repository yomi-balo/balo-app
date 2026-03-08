import { AirwallexAuthError, AirwallexApiError } from './errors.js';

// ── Token Cache ─────────────────────────────────────────────────

interface TokenCache {
  token: string;
  expiresAt: Date;
}

let tokenCache: TokenCache | null = null;

function getEnvConfig(): { base: string; clientId: string; apiKey: string } {
  const env = process.env.AIRWALLEX_ENV ?? 'demo';
  const base =
    env === 'prod' ? process.env.AIRWALLEX_API_BASE_PROD! : process.env.AIRWALLEX_API_BASE_DEMO!;
  const clientId =
    env === 'prod' ? process.env.AIRWALLEX_CLIENT_ID_PROD! : process.env.AIRWALLEX_CLIENT_ID_DEMO!;
  const apiKey =
    env === 'prod' ? process.env.AIRWALLEX_API_KEY_PROD! : process.env.AIRWALLEX_API_KEY_DEMO!;

  return { base, clientId, apiKey };
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
    throw new AirwallexAuthError(await res.text());
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

  // Token expired mid-request — clear cache and retry once
  if (res.status === 401 && !options?.isRetry) {
    const errText = await res.text();
    if (errText.includes('credentials_expired')) {
      tokenCache = null;
      return airwallexRequest(method, path, body, { ...options, isRetry: true });
    }
    throw new AirwallexApiError(401, path, errText);
  }

  if (!res.ok) {
    throw new AirwallexApiError(res.status, path, await res.text());
  }

  return res.json() as T;
}
