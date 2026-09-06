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
    const result = deadlockFailure(
      Object.assign(new Error('deadlock detected'), { code: '40P01' }),
      'Something aborted — retryable',
      { requestId: 'req-1' }
    );

    expect(result).toEqual({ success: false, error: CONCURRENT_RETRY_MESSAGE });
    // ⚠ WARN, never ERROR: nothing was written and a retry succeeds.
    expect(log.warn).toHaveBeenCalledWith('Something aborted — retryable', {
      requestId: 'req-1',
    });
    expect(log.error).not.toHaveBeenCalled();
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
