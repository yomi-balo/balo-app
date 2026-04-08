import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';

const API_BASE_URL =
  process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3002';
const API_KEY = process.env.INTERNAL_API_SECRET || '';

interface CalendarApiOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

/**
 * Calls the Fastify calendar API with internal auth header.
 * Used by server actions to proxy calendar requests.
 */
export async function calendarApiFetch<T>(
  path: string,
  options: CalendarApiOptions = {}
): Promise<T> {
  const url = `${API_BASE_URL}${path}`;

  const response = await loggedFetch(url, {
    ...options,
    service: 'calendar-api',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-api-key': API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Calendar API returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}
