import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildJobId, JOB_ID_CONTRACT_VIOLATION } from './queue.js';

/**
 * BAL-531 — `buildJobId` is the ONLY way a custom BullMQ jobId may be minted. This suite pins:
 *  1. the two ticket acceptance examples verbatim;
 *  2. BullMQ's actual `Job.addJob` predicate, restated so a future misquote is caught here first;
 *  3. the escape's injectivity — the whole reason it is two characters, not one;
 *  4. the four throw guards, in every environment.
 *
 * `queue.test.ts` is a NEW file — no existing suite covered `lib/queue.ts` before this ticket.
 */

describe('buildJobId — ticket acceptance examples', () => {
  it('example 1 — meeting-calendar-amend', () => {
    const id = buildJobId('meeting-calendar-amend', '3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef');
    expect(id.includes(':')).toBe(false);
    expect(id).toBe('meeting-calendar-amend--3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef');
  });

  it('example 2 — credit-session-low-balance with a colon-bearing correlationId', () => {
    const id = buildJobId('credit-session-low-balance', 'user-1', 'calendar-sub-lapse:2026-09-04');
    expect(id.includes(':')).toBe(false);
    expect(id).toBe('credit-session-low-balance--user-1--calendar-sub-lapse_c2026-09-04');
  });
});

describe('buildJobId — the actual BullMQ rule, pinned', () => {
  const FIXTURES = [
    buildJobId('meeting-calendar-amend', '3f2a2b7e-1234-4a1b-9c3d-abcdefabcdef'),
    buildJobId('credit-session-low-balance', 'user-1', 'calendar-sub-lapse:2026-09-04'),
    buildJobId('expert.application_submitted', 'app-456'),
    buildJobId('auto_topup', 'wallet-a', 'entry-1'),
    buildJobId('dormancy_expiry', 'wallet-a', '2026-09-04'),
    buildJobId('a', 'manual:x'),
    buildJobId('a', 'manual_x'),
  ] as const;

  it('every id has zero colons', () => {
    for (const id of FIXTURES) {
      expect(id.includes(':')).toBe(false);
    }
  });

  it('every id satisfies the verbatim upstream predicate from bullmq@5.70.4 Job.addJob', () => {
    for (const id of FIXTURES) {
      expect(id.includes(':') && id.split(':').length !== 3).toBe(false);
    }
  });
});

describe('buildJobId — injectivity (the reason the escape is two characters)', () => {
  it('swapped colon/underscore order stays distinct', () => {
    expect(buildJobId('e', 'a_:b')).not.toBe(buildJobId('e', 'a:_b'));
  });

  it('a literal colon and a literal underscore in the "same" position do not collide', () => {
    expect(buildJobId('e', 'manual:x')).not.toBe(buildJobId('e', 'manual_x'));
  });

  it('two distinct auto-topup dedup keys stay distinct', () => {
    expect(buildJobId('auto_topup', 'w', 'e1')).not.toBe(buildJobId('auto_topup', 'w', 'e2'));
  });
});

describe('buildJobId — uniform escaping is deliberate (D1), not an accident', () => {
  it('escapes the event-name part the same way as every other part', () => {
    expect(buildJobId('expert.application_submitted', 'app-456')).toBe(
      'expert.application__submitted--app-456'
    );
  });
});

describe('JOB_ID_CONTRACT_VIOLATION — verbatim stability', () => {
  // BAL-531 fix round F1 — every `toThrow(...)` above INTERPOLATES this imported constant, so it
  // proved only that the constant equals itself: PROVED by mutation — changing `lib/queue.ts`'s
  // wording left 30/30 tests passing. Pin the LITERAL itself here, so a future rewording is
  // caught by this file first, not discovered when an Axiom monitor pointed at the old wording
  // goes quiet.
  it('the exported prefix is verbatim stable — a monitor is pointed at this literal', () => {
    expect(JOB_ID_CONTRACT_VIOLATION).toBe('BullMQ job id contract violation');
  });
});

describe('buildJobId — separator collision across a fixed arity (documented limitation, F3)', () => {
  // The docblock's own worked example, `buildJobId('a--b','c') === buildJobId('a','b--c')`, is
  // NOT a real collision — both sides are arity-2, so it demonstrates nothing about crossing
  // arities. The genuine collision needs no `--` inside either part at all:
  it('a trailing "-" on a non-final part collides with a leading "-" on the next (same arity)', () => {
    expect(buildJobId('a-', 'b')).toBe(buildJobId('a', '-b'));
    expect(buildJobId('a-', 'b')).toBe('a---b');
  });
});

describe('buildJobId — throws', () => {
  it('throws on zero parts', () => {
    expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    expect(() => buildJobId()).toThrow(
      `${JOB_ID_CONTRACT_VIOLATION}: buildJobId() called with no parts`
    );
  });

  it('throws on an empty part', () => {
    expect(() => buildJobId('a', '')).toThrow(JOB_ID_CONTRACT_VIOLATION);
  });

  it('throws when the escaped, joined result is all-digit', () => {
    expect(() => buildJobId('123')).toThrow(JOB_ID_CONTRACT_VIOLATION);
  });

  describe('fires in every environment', () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      vi.stubEnv('NODE_ENV', originalEnv ?? 'test');
    });

    it('throws with NODE_ENV=production', () => {
      vi.stubEnv('NODE_ENV', 'production');
      expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    });

    it('throws with NODE_ENV=test', () => {
      vi.stubEnv('NODE_ENV', 'test');
      expect(() => buildJobId()).toThrow(JOB_ID_CONTRACT_VIOLATION);
    });
  });
});
