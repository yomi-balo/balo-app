import 'server-only';

import { internalApiFetch } from './internal-api';

interface CalendarApiOptions extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}

/**
 * Calls the Fastify calendar API with the server-to-server auth header.
 * Thin wrapper over `internalApiFetch` that pins the `calendar-api` service tag so
 * calendar server actions label their logs consistently; the fetch, auth-header, and
 * error-body handling live in that single implementation.
 */
export async function calendarApiFetch<T>(
  path: string,
  options: CalendarApiOptions = {}
): Promise<T> {
  return internalApiFetch<T>(path, options, 'calendar-api');
}
