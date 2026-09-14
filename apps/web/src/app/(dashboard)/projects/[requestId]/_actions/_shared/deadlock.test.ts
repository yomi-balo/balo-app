import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

import {
  isDeadlockDetected,
  isLockNotAvailable,
  deadlockFailure,
  lockContentionFailure,
  CONCURRENT_RETRY_MESSAGE,
} from './deadlock';
import { log } from '@/lib/logging';

describe('isDeadlockDetected', () => {
  it('recognises a postgres-js 40P01 rejection', () => {
    expect(
      isDeadlockDetected(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    ).toBe(true);
    // postgres-js also rejects with plain objects on some paths.
    expect(isDeadlockDetected({ code: '40P01' })).toBe(true);
  });

  it('does NOT swallow a different SQLSTATE — 23505 stays a unique violation', () => {
    expect(isDeadlockDetected(Object.assign(new Error('duplicate key'), { code: '23505' }))).toBe(
      false
    );
    // 40001 is serialization_failure, a DIFFERENT class we deliberately do not map.
    expect(isDeadlockDetected({ code: '40001' })).toBe(false);
  });

  it("does NOT swallow 55P03 — that is `isLockNotAvailable`'s job, not this one's", () => {
    expect(isDeadlockDetected({ code: '55P03' })).toBe(false);
  });

  it('is false for anything without a code', () => {
    expect(isDeadlockDetected(new Error('db exploded'))).toBe(false);
    expect(isDeadlockDetected(null)).toBe(false);
    expect(isDeadlockDetected(undefined)).toBe(false);
    expect(isDeadlockDetected('40P01')).toBe(false);
  });
});

describe('isLockNotAvailable (fix round F1)', () => {
  it('recognises a postgres-js 55P03 rejection', () => {
    expect(isLockNotAvailable(Object.assign(new Error('lock timeout'), { code: '55P03' }))).toBe(
      true
    );
    // postgres-js also rejects with plain objects on some paths.
    expect(isLockNotAvailable({ code: '55P03' })).toBe(true);
  });

  it('does NOT swallow a different SQLSTATE — 40P01 stays a deadlock, not a lock timeout', () => {
    expect(
      isLockNotAvailable(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
    ).toBe(false);
    expect(isLockNotAvailable({ code: '23505' })).toBe(false);
  });

  it('is false for anything without a code', () => {
    expect(isLockNotAvailable(new Error('db exploded'))).toBe(false);
    expect(isLockNotAvailable(null)).toBe(false);
    expect(isLockNotAvailable(undefined)).toBe(false);
    expect(isLockNotAvailable('55P03')).toBe(false);
  });
});

describe('deadlockFailure', () => {
  it('warns and returns the retryable failure on a 40P01', () => {
    const error = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    const result = deadlockFailure(error, 'Something aborted — retryable', { requestId: 'req-1' });

    expect(result).toEqual({ success: false, error: CONCURRENT_RETRY_MESSAGE });
    // ⚠ WARN, never ERROR: nothing was written and a retry succeeds.
    expect(log.warn).toHaveBeenCalledWith('Something aborted — retryable', {
      requestId: 'req-1',
      // fix round R5 — the ACTUAL SQLSTATE rides along as its own field, so the caller's
      // message text no longer has to guess which one fired.
      sqlstate: '40P01',
      // ⚠ THE ERROR ITSELF, not just the caller's context. This is a HANDLED boundary — the
      // rejection becomes a user-facing string and is never re-thrown, so the original is
      // lost unless it is logged here (CLAUDE.md's caught-error-boundary rule).
      error: 'deadlock detected',
      stack: error.stack,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('warns and returns the retryable failure on a 55P03 (fix round F1)', () => {
    const error = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const result = deadlockFailure(error, 'Something aborted — retryable', { requestId: 'req-1' });

    expect(result).toEqual({ success: false, error: CONCURRENT_RETRY_MESSAGE });
    // ⚠ WARN, never ERROR: nothing was written and a retry succeeds — same as a 40P01.
    expect(log.warn).toHaveBeenCalledWith('Something aborted — retryable', {
      requestId: 'req-1',
      sqlstate: '55P03',
      error: 'canceling statement due to lock timeout',
      stack: error.stack,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("includes postgres-js's `detail` — which two processes collided", () => {
    const detail = 'Process 123 waits for ShareLock on transaction 456; blocked by process 789.';
    deadlockFailure(
      Object.assign(new Error('deadlock detected'), { code: '40P01', detail }),
      'Something aborted — retryable',
      { requestId: 'req-1' }
    );

    expect(log.warn).toHaveBeenCalledWith(
      'Something aborted — retryable',
      expect.objectContaining({ detail })
    );
  });

  it('omits `detail` entirely when the driver supplied none (no undefined key)', () => {
    deadlockFailure({ code: '40P01' }, 'Something aborted — retryable', { requestId: 'req-1' });

    const [, fields] = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields).not.toHaveProperty('detail');
    // fix round R8 (SonarCloud S6551) — a non-Error rejection is JSON-stringified, not passed
    // through the bare `String()` that would have rendered a useless '[object Object]' and
    // discarded the `code` field entirely.
    expect(fields.error).toBe(JSON.stringify({ code: '40P01' }));
    expect(fields.stack).toBeUndefined();
  });

  it('says plainly a value could not be rendered, rather than falling back to String() (fix round R8)', () => {
    // A circular structure throws inside JSON.stringify — the fallback must still produce SOME
    // string rather than propagating that throw out of a caught-error boundary, and must not
    // reach for `String()` (which would reintroduce the exact '[object Object]' anti-pattern
    // this fix round removed).
    const circular: Record<string, unknown> = { code: '40P01' };
    circular.self = circular;
    deadlockFailure(circular, 'Something aborted — retryable', { requestId: 'req-1' });

    const [, fields] = (log.warn as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fields.error).toBe('[unserializable error value]');
  });

  it('ignores a non-string or empty `detail` rather than logging a lie', () => {
    deadlockFailure({ code: '40P01', detail: 42 }, 'msg', {});
    deadlockFailure({ code: '40P01', detail: '' }, 'msg', {});

    for (const call of (log.warn as ReturnType<typeof vi.fn>).mock.calls) {
      const [, fields] = call as [string, Record<string, unknown>];
      expect(fields).not.toHaveProperty('detail');
    }
  });

  it('does not let the error fields clobber the caller context keys', () => {
    deadlockFailure(Object.assign(new Error('boom'), { code: '40P01' }), 'msg', {
      requestId: 'req-1',
      relationshipId: 'rel-1',
    });

    expect(log.warn).toHaveBeenCalledWith(
      'msg',
      expect.objectContaining({ requestId: 'req-1', relationshipId: 'rel-1', error: 'boom' })
    );
  });

  it('returns null (and logs nothing) for any other error, so the caller falls through', () => {
    expect(deadlockFailure(new Error('db exploded'), 'msg', {})).toBeNull();
    expect(deadlockFailure({ code: '23505' }, 'msg', {})).toBeNull();
    // 40001 is serialization_failure, a DIFFERENT class deliberately not mapped alongside
    // 40P01 / 55P03.
    expect(deadlockFailure({ code: '40001' }, 'msg', {})).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('adds no `code` to the failure — the action result unions are unchanged', () => {
    const result = deadlockFailure({ code: '40P01' }, 'msg', {});
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(['error', 'success']);

    const lockTimeoutResult = deadlockFailure({ code: '55P03' }, 'msg', {});
    expect(lockTimeoutResult).not.toBeNull();
    expect(Object.keys(lockTimeoutResult ?? {}).sort()).toEqual(['error', 'success']);
  });
});

describe('lockContentionFailure (fix round R1)', () => {
  it('warns and returns the retryable failure on a 55P03', () => {
    const error = Object.assign(new Error('canceling statement due to lock timeout'), {
      code: '55P03',
    });
    const result = lockContentionFailure(error, 'Something aborted — retryable', {
      requestId: 'req-1',
    });

    expect(result).toEqual({ success: false, error: CONCURRENT_RETRY_MESSAGE });
    expect(log.warn).toHaveBeenCalledWith('Something aborted — retryable', {
      requestId: 'req-1',
      sqlstate: '55P03',
      error: 'canceling statement due to lock timeout',
      stack: error.stack,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does NOT map a 40P01 — that stays deadlockFailure-only (D6, not extended here)', () => {
    expect(
      lockContentionFailure(
        Object.assign(new Error('deadlock detected'), { code: '40P01' }),
        'msg',
        {}
      )
    ).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns null (and logs nothing) for any other error, so the caller falls through', () => {
    expect(lockContentionFailure(new Error('db exploded'), 'msg', {})).toBeNull();
    expect(lockContentionFailure({ code: '23505' }, 'msg', {})).toBeNull();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("includes postgres-js's `detail` when supplied", () => {
    const detail = 'Process 123 waits for ShareLock on transaction 456; blocked by process 789.';
    lockContentionFailure(
      Object.assign(new Error('lock timeout'), { code: '55P03', detail }),
      'msg',
      { requestId: 'req-1' }
    );

    expect(log.warn).toHaveBeenCalledWith('msg', expect.objectContaining({ detail }));
  });

  it('adds no `code` to the failure — the action result unions are unchanged', () => {
    const result = lockContentionFailure({ code: '55P03' }, 'msg', {});
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(['error', 'success']);
  });
});
