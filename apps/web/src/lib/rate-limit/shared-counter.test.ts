import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SharedRateLimitActor } from './shared-counter';

const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockLogDebug = vi.fn();

vi.mock('server-only', () => ({}));
vi.mock('@/lib/logging', () => ({
  log: { info: mockLogInfo, warn: mockLogWarn, error: mockLogError, debug: mockLogDebug },
}));

const ACTOR: SharedRateLimitActor = { id: 'user-1' };
const OTHER_ACTOR: SharedRateLimitActor = { id: 'user-2' };
const IMPERSONATED_ACTOR: SharedRateLimitActor = { id: 'user-1', impersonatorUserId: 'staff-9' };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** The module is reloaded per test so the module-level fail-open log gate never leaks state. */
async function loadModule(): Promise<typeof import('./shared-counter')> {
  vi.resetModules();
  return import('./shared-counter');
}

describe('checkSharedRateLimit', () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;
  const originalApiUrl = process.env.API_URL;
  const originalPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_SECRET = 'test-internal-secret';
    process.env.API_URL = 'http://api.test';
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    };
    restore('INTERNAL_API_SECRET', originalSecret);
    restore('API_URL', originalApiUrl);
    restore('NEXT_PUBLIC_API_URL', originalPublicApiUrl);
  });

  it('200 → allowed, calling fetch with the exact URL, method, header, body and a signal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, { allowed: true }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-chat-post', ACTOR);

    expect(verdict).toEqual({ allowed: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('http://api.test/rate-limit/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-api-key': 'test-internal-secret' },
      body: JSON.stringify({ bucket: 'meeting-chat-post', userId: 'user-1' }),
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    });

    // The exact header SET, not a subset: `toEqual`, never `objectContaining`.
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toEqual({
      'Content-Type': 'application/json',
      'x-internal-api-key': 'test-internal-secret',
    });
  });

  it('an empty-string API_URL is treated as unset, falling straight to localhost:3002', async () => {
    process.env.API_URL = '';
    delete process.env.NEXT_PUBLIC_API_URL;
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    await checkSharedRateLimit('meeting-chat-post', ACTOR);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3002/rate-limit/check',
      expect.anything()
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('falls back to NEXT_PUBLIC_API_URL, then localhost:3002, silently (no log.warn)', async () => {
    delete process.env.API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'http://public-api.test';
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    await checkSharedRateLimit('meeting-chat-post', ACTOR);

    expect(mockFetch).toHaveBeenCalledWith(
      'http://public-api.test/rate-limit/check',
      expect.anything()
    );
    expect(mockLogWarn).not.toHaveBeenCalled();
  });

  it('uses the impersonator id, not the actor id, when present', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    await checkSharedRateLimit('typing-signal', IMPERSONATED_ACTOR);

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ bucket: 'typing-signal', userId: 'staff-9' });
  });

  it('429 → refused, clamping a large cooldownSeconds to 300', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(429, { cooldownSeconds: 9_999 }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 300 });
  });

  it('429 → refused, flooring a cooldownSeconds of 0 to 1', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(429, { cooldownSeconds: 0 }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it('429 with a malformed body → retryAfterSeconds defaults to 60', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('not json {{{', { status: 429 }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('429 with no cooldownSeconds field → retryAfterSeconds defaults to 60', async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse(429, {}));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('429 with an empty body → retryAfterSeconds defaults to 60', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('429 with a non-object JSON body (a bare number) → retryAfterSeconds defaults to 60', async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response('42', { status: 429 }));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    const verdict = await checkSharedRateLimit('meeting-reaction', ACTOR);
    expect(verdict).toEqual({ allowed: false, retryAfterSeconds: 60 });
  });

  it('missing_secret → allowed, makes no fetch attempt, and logs the exact payload', async () => {
    delete process.env.INTERNAL_API_SECRET;
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

    const verdict = await checkSharedRateLimit('proposal-pdf', ACTOR);

    expect(verdict).toEqual({ allowed: true });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, {
      bucket: 'proposal-pdf',
      reason: 'missing_secret',
      suppressed: 0,
    });
  });

  it.each([
    [400, 'misconfigured'],
    [401, 'unauthorized'],
    [404, 'misconfigured'],
    [500, 'misconfigured'],
    [503, 'unavailable'],
    [418, 'unexpected_status'],
  ] as const)(
    'status %i (%s) → allowed (fail open), with the exact log payload',
    async (status, reason) => {
      const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

      const verdict = await checkSharedRateLimit('meeting-realtime-token', ACTOR);
      expect(verdict).toEqual({ allowed: true });

      const expectedPayload = {
        bucket: 'meeting-realtime-token',
        reason,
        status,
        suppressed: 0,
      };
      const isCritical = reason === 'unauthorized' || reason === 'misconfigured';
      if (isCritical) {
        expect(mockLogError).toHaveBeenCalledTimes(1);
        expect(mockLogError).toHaveBeenCalledWith(
          SHARED_RATE_LIMIT_UNAVAILABLE_LOG,
          expectedPayload
        );
        expect(mockLogWarn).not.toHaveBeenCalled();
      } else {
        expect(mockLogWarn).toHaveBeenCalledTimes(1);
        expect(mockLogWarn).toHaveBeenCalledWith(
          SHARED_RATE_LIMIT_UNAVAILABLE_LOG,
          expectedPayload
        );
        expect(mockLogError).not.toHaveBeenCalled();
      }
      expect(mockLogInfo).not.toHaveBeenCalled();
    }
  );

  it('a TimeoutError from the abort → allowed (fail open), logging reason "timeout" with no status', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError'));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

    await expect(checkSharedRateLimit('typing-signal', ACTOR)).resolves.toEqual({
      allowed: true,
    });
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, {
      bucket: 'typing-signal',
      reason: 'timeout',
      suppressed: 0,
    });
  });

  it('an AbortError → allowed (fail open), logging reason "timeout" with no status', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

    await expect(checkSharedRateLimit('typing-signal', ACTOR)).resolves.toEqual({
      allowed: true,
    });
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, {
      bucket: 'typing-signal',
      reason: 'timeout',
      suppressed: 0,
    });
  });

  it('an ordinary network error → allowed (fail open), logging reason "network" with no status', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('fetch failed'));
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

    await expect(checkSharedRateLimit('meeting-chat-read', ACTOR)).resolves.toEqual({
      allowed: true,
    });
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, {
      bucket: 'meeting-chat-read',
      reason: 'network',
      suppressed: 0,
    });
  });

  it('never throws, even when fetch rejects with a non-Error value, and still logs reason "network"', async () => {
    const mockFetch = vi.fn().mockRejectedValue('boom');
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit, SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();

    await expect(checkSharedRateLimit('meeting-chat-read', ACTOR)).resolves.toEqual({
      allowed: true,
    });
    expect(mockLogWarn).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(SHARED_RATE_LIMIT_UNAVAILABLE_LOG, {
      bucket: 'meeting-chat-read',
      reason: 'network',
      suppressed: 0,
    });
  });

  it('never throws, even when the response body cannot be read', async () => {
    const brokenResponse = {
      status: 200,
      text: () => Promise.reject(new Error('body already consumed')),
    } as unknown as Response;
    const mockFetch = vi.fn().mockResolvedValue(brokenResponse);
    vi.stubGlobal('fetch', mockFetch);
    const { checkSharedRateLimit } = await loadModule();

    await expect(checkSharedRateLimit('meeting-chat-read', ACTOR)).resolves.toEqual({
      allowed: true,
    });
  });

  describe('the gated fail-open log', () => {
    it('pins the message verbatim', async () => {
      const { SHARED_RATE_LIMIT_UNAVAILABLE_LOG } = await loadModule();
      expect(SHARED_RATE_LIMIT_UNAVAILABLE_LOG).toBe(
        'Shared rate limit unavailable — failing open'
      );
    });

    // The exact per-status log payload (401/500/503/418/400/404) is pinned by the
    // `it.each` above; this block covers what that one doesn't: the verbatim message, the
    // no-log cases, and the gate's own suppression behaviour.

    it('never logs on a 200', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(200, {}));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      await checkSharedRateLimit('meeting-chat-post', ACTOR);

      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockLogInfo).not.toHaveBeenCalled();
    });

    it('never logs on a 429', async () => {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(429, { cooldownSeconds: 10 }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      await checkSharedRateLimit('meeting-chat-post', ACTOR);

      expect(mockLogWarn).not.toHaveBeenCalled();
      expect(mockLogError).not.toHaveBeenCalled();
      expect(mockLogInfo).not.toHaveBeenCalled();
    });

    it('admits one log per 60s window, suppressing repeats and re-admitting after it elapses', async () => {
      vi.useFakeTimers();
      try {
        const mockFetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
        vi.stubGlobal('fetch', mockFetch);
        const { checkSharedRateLimit } = await loadModule();

        vi.setSystemTime(0);
        await checkSharedRateLimit('meeting-chat-post', ACTOR); // admitted
        vi.setSystemTime(1_000);
        await checkSharedRateLimit('meeting-chat-post', ACTOR); // suppressed #1
        vi.setSystemTime(2_000);
        await checkSharedRateLimit('meeting-chat-post', ACTOR); // suppressed #2

        expect(mockLogWarn).toHaveBeenCalledTimes(1);

        vi.setSystemTime(60_000);
        await checkSharedRateLimit('meeting-chat-post', ACTOR); // re-admitted

        expect(mockLogWarn).toHaveBeenCalledTimes(2);
        expect(mockLogWarn).toHaveBeenNthCalledWith(
          2,
          'Shared rate limit unavailable — failing open',
          expect.objectContaining({ suppressed: 2 })
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('the refusal memo', () => {
    it('does not memoize a 429 with a malformed body — the next call still fetches', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('not json {{{', { status: 429 }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      const first = await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(first).toEqual({ allowed: false, retryAfterSeconds: 60 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
      const second = await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(second).toEqual({ allowed: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('does not memoize a 429 with an empty body — the next call still fetches', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      const first = await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(first).toEqual({ allowed: false, retryAfterSeconds: 60 });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
      const second = await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(second).toEqual({ allowed: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('a 429 leaves a live refusal memo — a later timeout for the same bucket and person stays refused with no fetch attempt', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { cooldownSeconds: 30 }));
        vi.stubGlobal('fetch', mockFetch);
        const { checkSharedRateLimit } = await loadModule();

        const first = await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(first).toEqual({ allowed: false, retryAfterSeconds: 30 });
        expect(mockFetch).toHaveBeenCalledTimes(1);

        // The hop would time out on this next call — the memo must refuse it before fetch is
        // ever attempted.
        mockFetch.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'));
        vi.setSystemTime(5_000); // well inside the 30s refusal
        const second = await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(second.allowed).toBe(false);
        expect(mockFetch).toHaveBeenCalledTimes(1); // unchanged — no second attempt
      } finally {
        vi.useRealTimers();
      }
    });

    it('pins the memoized retryAfterSeconds exactly, ceiling the remainder to a whole second', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { cooldownSeconds: 30 }));
        vi.stubGlobal('fetch', mockFetch);
        const { checkSharedRateLimit } = await loadModule();

        await checkSharedRateLimit('meeting-chat-post', ACTOR);

        // 30 s minus the 500 ms safety margin, minus 5 s elapsed = 24.5 s remaining → ceils to 25.
        vi.setSystemTime(5_000);
        const second = await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(second).toEqual({ allowed: false, retryAfterSeconds: 25 });
        expect(mockFetch).toHaveBeenCalledTimes(1); // still memoized — no second fetch

        // 29.5 s minus 29 s elapsed = 500 ms remaining — sub-second, never rounds down to 0.
        vi.setSystemTime(29_000);
        const third = await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(third).toEqual({ allowed: false, retryAfterSeconds: 1 });
        expect(mockFetch).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears the memoized refusal once it expires, letting a real check run again', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(0);
        const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { cooldownSeconds: 10 }));
        vi.stubGlobal('fetch', mockFetch);
        const { checkSharedRateLimit } = await loadModule();

        await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(mockFetch).toHaveBeenCalledTimes(1);

        mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
        vi.setSystemTime(10_001); // just past the 10s window
        const verdict = await checkSharedRateLimit('meeting-chat-post', ACTOR);
        expect(verdict).toEqual({ allowed: true });
        expect(mockFetch).toHaveBeenCalledTimes(2); // a real check happened again
      } finally {
        vi.useRealTimers();
      }
    });

    it('isolates the memo per bucket and per person', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { cooldownSeconds: 30 }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // A different bucket, same person — not memoized, so a real check runs.
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
      await checkSharedRateLimit('meeting-chat-read', ACTOR);
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // The same bucket, a different person — also not memoized.
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
      await checkSharedRateLimit('meeting-chat-post', OTHER_ACTOR);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('memoizes by the resolved actor id (the impersonator, when present), never raw actor.id', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(429, { cooldownSeconds: 30 }));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      await checkSharedRateLimit('meeting-chat-post', IMPERSONATED_ACTOR);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // ACTOR shares the same underlying `.id` as IMPERSONATED_ACTOR but has no impersonator —
      // a memo keyed on raw actor.id would wrongly refuse this real, un-impersonated user too.
      mockFetch.mockResolvedValueOnce(jsonResponse(200, {}));
      const actorVerdict = await checkSharedRateLimit('meeting-chat-post', ACTOR);
      expect(actorVerdict).toEqual({ allowed: true });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // The impersonated session itself stays refused, with no further fetch.
      const impersonatedVerdict = await checkSharedRateLimit(
        'meeting-chat-post',
        IMPERSONATED_ACTOR
      );
      expect(impersonatedVerdict.allowed).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('caps the memo, evicting the oldest entry once full', async () => {
      // A fresh Response per call — a shared instance's body can only be read once, which
      // would make every call after the first look like an unparseable, non-memoizing 429.
      const mockFetch = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse(429, { cooldownSeconds: 300 })));
      vi.stubGlobal('fetch', mockFetch);
      const { checkSharedRateLimit } = await loadModule();

      // One more than the 10,000-entry cap — the first key must be evicted to make room, even
      // though its own cooldown is nowhere near expiry.
      for (let i = 0; i < 10_001; i += 1) {
        await checkSharedRateLimit('meeting-chat-post', { id: `flood-${i}` });
      }
      const callsBeforeRecheck = mockFetch.mock.calls.length;

      // Positive control: a key that is neither the oldest nor the one that just triggered the
      // eviction is still refused with no new fetch — proving eviction drops only the SINGLE
      // oldest entry, not the whole map (a `.clear()` at the cap would wipe this one too).
      const survivingVerdict = await checkSharedRateLimit('meeting-chat-post', { id: 'flood-1' });
      expect(survivingVerdict.allowed).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(callsBeforeRecheck);

      // The oldest key was evicted to make room — a fresh check actually runs for it.
      mockFetch.mockImplementationOnce(() => Promise.resolve(jsonResponse(200, {})));
      const evictedVerdict = await checkSharedRateLimit('meeting-chat-post', { id: 'flood-0' });
      expect(evictedVerdict).toEqual({ allowed: true });
      expect(mockFetch).toHaveBeenCalledTimes(callsBeforeRecheck + 1);
    }, 20_000);
  });

  describe('the arithmetic pin', () => {
    it('RATE_LIMIT_HOP_TIMEOUT_MS + TYPING_PUBLISH_TIMEOUT_MS + 270 < TYPING_RELAY_SLOW_MS', async () => {
      const { RATE_LIMIT_HOP_TIMEOUT_MS } = await import('@balo/shared/rate-limit');
      // TYPING_PUBLISH_TIMEOUT_MS — the typing Ably publish's own budget (ably-server.ts:38).
      const { TYPING_PUBLISH_TIMEOUT_MS } = await import('@/lib/realtime/ably-server');
      // TYPING_RELAY_SLOW_MS — the relay's whole-call slow threshold (typing-relay.ts:40).
      const { TYPING_RELAY_SLOW_MS } = await import('@/lib/realtime/typing-relay');

      // 270 = browser↔Vercel round trip (≤100ms) + session read (≤20ms) + the consumer's own
      // tenancy gate (≤150ms for 6–9 indexed Postgres reads) — see the module docblock's
      // latency arithmetic. None of the three has an exported constant of its own, so the
      // number is pinned here.
      expect(RATE_LIMIT_HOP_TIMEOUT_MS + TYPING_PUBLISH_TIMEOUT_MS + 270).toBeLessThan(
        TYPING_RELAY_SLOW_MS
      );
    });
  });
});
