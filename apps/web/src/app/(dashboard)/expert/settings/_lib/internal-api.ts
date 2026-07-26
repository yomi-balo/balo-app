import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';

const API_BASE_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const API_KEY = process.env.INTERNAL_API_SECRET || '';

interface InternalApiOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

/**
 * Calls an internal Fastify route with the server-to-server auth header.
 * Used by server actions that proxy internal-key-only endpoints (schedule, etc.).
 *
 * Kept separate from `calendar-api.ts` (which pins the `calendar-api` service tag);
 * this passes the service tag through so each caller labels its own logs.
 */
export async function internalApiFetch<T>(
  path: string,
  options: InternalApiOptions = {},
  service = 'internal-api'
): Promise<T> {
  // Fail fast with a clear cause instead of sending an empty key and getting an
  // opaque 401 back from the internal route.
  if (!API_KEY) {
    throw new Error('INTERNAL_API_SECRET is not set — cannot authenticate internal API calls');
  }

  const url = `${API_BASE_URL}${path}`;

  const response = await loggedFetch(url, {
    ...options,
    service,
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Internal API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}
