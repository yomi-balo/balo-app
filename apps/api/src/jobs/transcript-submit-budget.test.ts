import { describe, it, expect, vi } from 'vitest';
import { DAILY_REQUEST_TIMEOUT_MS } from '../services/daily/client.js';
import {
  BACKOFF_DELAY_MS,
  SUBMIT_ATTEMPTS,
  SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS,
  TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS,
} from './transcript-submit-budget.js';

describe('transcript-submit-budget', () => {
  it('pins the submit constants the budget is derived from', () => {
    expect(SUBMIT_ATTEMPTS).toBe(3);
    expect(BACKOFF_DELAY_MS).toBe(10_000);
    expect(DAILY_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS).toBe(5_000);
  });

  it('⚠ the budget is DERIVED: per-attempt (timeout + slack) plus the exponential backoff waits', () => {
    expect(TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS).toBe(3 * (10_000 + 5_000) + (10_000 + 20_000));
    expect(TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS).toBe(75_000);
  });

  it('the backoff term equals the summed waits between attempts, derived from the constants', () => {
    let backoffWaits = 0;
    for (let attempt = 1; attempt < SUBMIT_ATTEMPTS; attempt += 1) {
      backoffWaits += BACKOFF_DELAY_MS * 2 ** (attempt - 1);
    }
    expect(TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS).toBe(
      SUBMIT_ATTEMPTS * (DAILY_REQUEST_TIMEOUT_MS + SUBMIT_ATTEMPT_NON_HTTP_SLACK_MS) + backoffWaits
    );
  });

  it('the budget covers the worst-case timeline: every attempt times out, with every backoff wait', () => {
    // Walk the timeline attempt by attempt: each attempt runs to its timeout, then (unless it
    // was the last) BullMQ waits `BACKOFF_DELAY_MS × 2^(attempt−1)` before the next one.
    let worstCaseMs = 0;
    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt += 1) {
      worstCaseMs += DAILY_REQUEST_TIMEOUT_MS;
      if (attempt < SUBMIT_ATTEMPTS) worstCaseMs += BACKOFF_DELAY_MS * 2 ** (attempt - 1);
    }
    expect(worstCaseMs).toBe(60_000);
    expect(TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(worstCaseMs);
  });

  it('⚠ the budget follows DAILY_REQUEST_TIMEOUT_MS rather than a pasted literal', async () => {
    vi.resetModules();
    vi.doMock('../services/daily/client.js', () => ({ DAILY_REQUEST_TIMEOUT_MS: 20_000 }));
    try {
      const mod = await import('./transcript-submit-budget.js');
      expect(mod.TRANSCRIPT_SUBMIT_RETRY_BUDGET_MS).toBe(3 * (20_000 + 5_000) + 30_000);
    } finally {
      vi.doUnmock('../services/daily/client.js');
      vi.resetModules();
    }
  });
});
