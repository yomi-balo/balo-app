import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fix round 1 item 9 — the shared fetch+auth+error-mapping shape extracted from
 * `lib/booking/booking-api-client.ts` and `lib/meetings/reschedule-proposal-api-client.ts`.
 * Those two files' own tests already exercise most of this through their public functions;
 * this file covers the pieces neither caller's happy path reaches directly: the `API_URL`
 * fallback warning, `readRetryAfter`'s bounds, and a `parse` that returns `null` on a
 * malformed-but-2xx body (the identity `parse` `booking-api-client.ts` passes never does this).
 */

const mockLoggedFetch = vi.fn();
const mockGetSession = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging/fetch-wrapper', () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));
vi.mock('@/lib/auth/session', () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

import { log } from '@/lib/logging';
import {
  getApiUrl,
  postBaloApiJson,
  readInstant,
  readRetryAfter,
  readString,
  safeParse,
} from './balo-api-client';

const ACCESS_TOKEN = 'workos.access.token';

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.API_URL;
  delete process.env.NEXT_PUBLIC_API_URL;
  mockGetSession.mockResolvedValue({ user: { id: 'user-1' }, accessToken: ACCESS_TOKEN });
});

describe('getApiUrl', () => {
  it('falls back to localhost:3002 and warns when unset', () => {
    expect(getApiUrl()).toBe('http://localhost:3002');
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('API_URL not configured'));
  });

  it('prefers API_URL over NEXT_PUBLIC_API_URL', () => {
    process.env.API_URL = 'http://api.internal';
    process.env.NEXT_PUBLIC_API_URL = 'http://api.public';
    expect(getApiUrl()).toBe('http://api.internal');
  });
});

describe('safeParse', () => {
  it('tolerates an empty body', () => {
    expect(safeParse('')).toEqual({});
  });

  it('tolerates a malformed body without throwing', () => {
    expect(safeParse('{not json')).toEqual({});
  });
});

describe('readString / readInstant', () => {
  it('readString returns undefined for a non-string value', () => {
    expect(readString({ a: 1 }, 'a')).toBeUndefined();
  });

  it('readInstant rejects an unparseable date string', () => {
    expect(readInstant({ a: 'not-a-date' }, 'a')).toBeUndefined();
  });

  it('readInstant accepts a valid ISO instant', () => {
    expect(readInstant({ a: '2026-09-01T09:00:00.000Z' }, 'a')).toBe('2026-09-01T09:00:00.000Z');
  });
});

describe('readRetryAfter', () => {
  it('is undefined when the header is absent', () => {
    expect(readRetryAfter(response(429, {}))).toBeUndefined();
  });

  it('caps at 300 seconds', () => {
    expect(readRetryAfter(response(429, {}, { 'Retry-After': '99999' }))).toBe(300);
  });

  it('ignores a non-positive value', () => {
    expect(readRetryAfter(response(429, {}, { 'Retry-After': '0' }))).toBeUndefined();
  });
});

describe('postBaloApiJson', () => {
  it('fails closed with unauthenticated when the session has no access token', async () => {
    mockGetSession.mockResolvedValue({ user: { id: 'user-1' }, accessToken: undefined });
    const result = await postBaloApiJson('/x', {}, (p) => p, 'Test');
    expect(result).toEqual({ ok: false, status: 401, code: 'unauthenticated' });
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });

  it('logs with the caller-supplied label and returns a transport failure when parse returns null', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, { unexpected: 'shape' }));
    const result = await postBaloApiJson('/x', {}, () => null, 'Widget');
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
    expect(log.error).toHaveBeenCalledWith(
      'Widget api returned a malformed 200 body',
      expect.objectContaining({ path: '/x' })
    );
  });

  it('logs with the caller-supplied label when the fetch itself throws', async () => {
    mockLoggedFetch.mockRejectedValue(new Error('network down'));
    const result = await postBaloApiJson('/x', {}, (p) => p, 'Widget');
    expect(result).toEqual({ ok: false, status: 0, code: 'request_failed' });
    expect(log.error).toHaveBeenCalledWith(
      'Widget api call failed',
      expect.objectContaining({ path: '/x', error: 'network down' })
    );
  });

  it('resolves the parsed data on a clean 2xx', async () => {
    mockLoggedFetch.mockResolvedValue(response(200, { ok: true }));
    const result = await postBaloApiJson('/x', {}, (p) => p, 'Widget');
    expect(result).toEqual({ ok: true, data: { ok: true } });
  });
});
