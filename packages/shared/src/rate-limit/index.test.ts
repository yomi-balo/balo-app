import { describe, expect, it } from 'vitest';
import {
  createLogGate,
  RATE_LIMIT_BUCKETS,
  RATE_LIMIT_CHECK_DEADLINE_MS,
  RATE_LIMIT_CHECK_PATH,
  RATE_LIMIT_HOP_TIMEOUT_MS,
} from './index';

describe('RATE_LIMIT_BUCKETS', () => {
  it('is a non-empty, unique, kebab-case tuple', () => {
    expect(RATE_LIMIT_BUCKETS.length).toBeGreaterThan(0);
    expect(new Set(RATE_LIMIT_BUCKETS).size).toBe(RATE_LIMIT_BUCKETS.length);
    for (const bucket of RATE_LIMIT_BUCKETS) {
      expect(bucket).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });
});

describe('RATE_LIMIT_CHECK_PATH', () => {
  it('is the wire path both sides share', () => {
    expect(RATE_LIMIT_CHECK_PATH).toBe('/rate-limit/check');
  });
});

describe('timing constants', () => {
  it('keeps the api Redis deadline strictly below the web hop timeout', () => {
    expect(RATE_LIMIT_CHECK_DEADLINE_MS).toBeLessThan(RATE_LIMIT_HOP_TIMEOUT_MS);
  });
});

describe('createLogGate', () => {
  it('admits the very first event, reporting zero suppressed', () => {
    const gate = createLogGate(1_000);
    expect(gate.admit(0)).toEqual({ admitted: true, suppressed: 0 });
  });

  it('suppresses every event inside the interval after the first admission', () => {
    const gate = createLogGate(1_000);
    expect(gate.admit(0).admitted).toBe(true);
    expect(gate.admit(1).admitted).toBe(false);
    expect(gate.admit(999).admitted).toBe(false);
  });

  it('re-admits once the interval has fully elapsed, reporting how many were swallowed', () => {
    const gate = createLogGate(1_000);
    expect(gate.admit(0)).toEqual({ admitted: true, suppressed: 0 }); // admitted
    expect(gate.admit(100).admitted).toBe(false); // swallowed #1
    expect(gate.admit(500).admitted).toBe(false); // swallowed #2

    expect(gate.admit(1_000)).toEqual({ admitted: true, suppressed: 2 });
  });

  it('starts a fresh suppression count after each re-admission', () => {
    const gate = createLogGate(1_000);
    gate.admit(0); // admitted, suppressed resets to 0
    gate.admit(100); // swallowed #1
    expect(gate.admit(1_000)).toEqual({ admitted: true, suppressed: 1 });

    // A new window: nothing swallowed yet, so the NEXT admission reports 0 again.
    expect(gate.admit(2_000)).toEqual({ admitted: true, suppressed: 0 });
  });

  it('is a fresh, independent gate on every call to createLogGate', () => {
    const first = createLogGate(1_000);
    first.admit(0);

    const second = createLogGate(1_000);
    // The second gate has never admitted, so it must treat time 0 as its own first event
    // rather than inheriting the first gate's state.
    expect(second.admit(0)).toEqual({ admitted: true, suppressed: 0 });
  });
});
