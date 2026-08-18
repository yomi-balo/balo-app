import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@balo/shared/logging', () => ({
  createLogger: () => mockLog,
}));

const { callApiroc } = await import('./index.js');
const { captureApirocFailure } = await import('./interceptor.js');

interface ApirocErrorLike {
  requestId?: string;
  wireErrorRaw?: unknown;
  zodIssues?: unknown;
}

describe('callApiroc — BAL-467 fix brief round 2, item 3: capture-sink cardinality', () => {
  beforeEach(() => {
    mockLog.warn.mockClear();
    mockLog.error.mockClear();
  });

  it('single capture (the common case): attaches its requestId to the thrown ApirocError', async () => {
    const caught: unknown = await callApiroc('calendars.list', async () => {
      captureApirocFailure({
        message: 'boom',
        config: { method: 'get', url: '/api/v1/calendars/eua-1' },
        response: { status: 500, headers: { 'x-request-id': 'req-1' }, data: {} },
      });
      throw new Error('boom');
    }).catch((e: unknown) => e);

    expect((caught as ApirocErrorLike).requestId).toBe('req-1');
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.anything(), 'apiroc_capture_ambiguous');
  });

  it('shape 2 (fan-out — review-measured): two concurrent captures in one callApiroc attach NEITHER and log apiroc_capture_ambiguous, instead of last-write-wins landing a foreign requestId/wireErrorRaw on the thrown error', async () => {
    // Mirrors BAL-396's planned `freeBusy.union` shape: `callApiroc('freeBusy.union', () =>
    // Promise.all(conns.map(...)))` — two connections' calls fail concurrently inside one
    // `callApiroc` context, and `fn` rethrows one specific failure (here, connection A's).
    // Before this fix, the single-slot sink meant whichever capture ran last (B) would win
    // regardless of which error was actually thrown.
    const caught: unknown = await callApiroc('freeBusy.union', async () => {
      captureApirocFailure({
        message: 'connection A failed',
        config: { method: 'get', url: '/api/v1/free-busy/eua-A' },
        response: { status: 500, headers: { 'x-request-id': 'req-A' }, data: { wire: 'A' } },
      });
      captureApirocFailure({
        message: 'connection B failed',
        config: { method: 'get', url: '/api/v1/free-busy/eua-B' },
        response: { status: 500, headers: { 'x-request-id': 'req-B' }, data: { wire: 'B' } },
      });
      throw new Error('connection A failed');
    }).catch((e: unknown) => e);

    const apirocError = caught as ApirocErrorLike;
    // No capture attached at all — attaching either A's or B's would misattribute evidence.
    expect(apirocError.requestId).toBeUndefined();
    expect(apirocError.wireErrorRaw).toBeUndefined();
    expect(apirocError.zodIssues).toBeUndefined();

    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'freeBusy.union',
        count: 2,
        requestIds: ['req-A', 'req-B'],
      }),
      'apiroc_capture_ambiguous'
    );
  });

  it('shape 1 (documented contract limitation — review-measured, not preventable by count alone): a swallowed failure inside fn contaminates an unrelated throw when exactly one capture was recorded', async () => {
    // `fn` violates callApiroc's documented contract ("wrap exactly one SDK call that can
    // fail") by triggering a capture and then swallowing it before throwing something
    // unrelated. Because the sink still holds exactly ONE capture at unwind time, this case
    // is indistinguishable — by count alone — from the single-capture common case, so the
    // swallowed evidence still attaches. This is why the contract is documented on
    // `callApiroc`, not silently tolerated.
    const caught: unknown = await callApiroc('calendars.list', async () => {
      captureApirocFailure({
        message: 'swallowed 401',
        config: { method: 'get', url: '/api/v1/calendars/eua-1' },
        response: {
          status: 401,
          headers: { 'x-request-id': 'rid-SWALLOWED' },
          data: {},
        },
      });
      // `fn` swallows the failure above (e.g. an internal try/catch it never propagates)
      // and throws a locally-constructed, unrelated error instead.
      throw new TypeError('unrelated local error');
    }).catch((e: unknown) => e);

    expect((caught as ApirocErrorLike).requestId).toBe('rid-SWALLOWED');
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.anything(), 'apiroc_capture_ambiguous');
  });

  it('zero captures: normalizes without an explicit capture, falling back to readApirocCapture(err)', async () => {
    const caught: unknown = await callApiroc('calendars.list', async () => {
      throw new Error('no interceptor ran');
    }).catch((e: unknown) => e);

    expect((caught as ApirocErrorLike).requestId).toBeUndefined();
    expect(mockLog.warn).not.toHaveBeenCalledWith(expect.anything(), 'apiroc_capture_ambiguous');
  });
});
