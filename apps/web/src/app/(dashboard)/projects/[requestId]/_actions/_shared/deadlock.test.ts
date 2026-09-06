import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
});

import { isDeadlockDetected, deadlockFailure, CONCURRENT_RETRY_MESSAGE } from './deadlock';
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

  it('is false for anything without a code', () => {
    expect(isDeadlockDetected(new Error('db exploded'))).toBe(false);
    expect(isDeadlockDetected(null)).toBe(false);
    expect(isDeadlockDetected(undefined)).toBe(false);
    expect(isDeadlockDetected('40P01')).toBe(false);
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
      // ⚠ THE ERROR ITSELF, not just the caller's context. This is a HANDLED boundary — the
      // rejection becomes a user-facing string and is never re-thrown, so the original is
      // lost unless it is logged here (CLAUDE.md's caught-error-boundary rule).
      error: 'deadlock detected',
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
    // A non-Error rejection still carries its stringification and no bogus stack.
    expect(fields.error).toBe(String({ code: '40P01' }));
    expect(fields.stack).toBeUndefined();
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
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('adds no `code` to the failure — the action result unions are unchanged', () => {
    const result = deadlockFailure({ code: '40P01' }, 'msg', {});
    expect(result).not.toBeNull();
    expect(Object.keys(result ?? {}).sort()).toEqual(['error', 'success']);
  });
});
