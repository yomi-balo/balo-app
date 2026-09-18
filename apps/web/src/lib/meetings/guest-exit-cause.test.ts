import { describe, expect, it } from 'vitest';
import { guestExitCauseForStatus, type GuestExitCause } from './guest-exit-cause';

/**
 * BAL-476 (R5 amended) — ⚠⚠ THIS IS RULE 4'S ONLY MECHANISED FORM. The frame, the Server Action
 * and the api client all defer to `guestExitCauseForStatus`; if this file is green the rule holds
 * everywhere, and if somebody inlines a second spelling of it this file will not notice — which
 * is exactly why the rule lives in ONE function and nothing else may branch on the status.
 */

describe('guestExitCauseForStatus', () => {
  it('⚠ 404 ⇒ "removed" — a revoked guest token stops resolving entirely', () => {
    expect(guestExitCauseForStatus(404)).toBe('removed');
  });

  it('⚠ 409 ⇒ "host_ended" — the token still resolves, the meeting is terminal', () => {
    expect(guestExitCauseForStatus(409)).toBe('host_ended');
  });

  /**
   * ⚠⚠ THE DEFAULT ARM IS THE WHOLE RULE: anything we did not POSITIVELY confirm resolves to the
   * VAGUER card. We never fall back to a wrong SPECIFIC claim.
   */
  const INCONCLUSIVE = [0, 200, 201, 204, 400, 401, 403, 429, 500, 502, 503] as const;

  it.each(INCONCLUSIVE)('⚠ %i ⇒ "access_ended" — say less, never something false', (status) => {
    expect(guestExitCauseForStatus(status)).toBe('access_ended');
  });

  it('⚠ the inconclusive set is non-empty and covers the transport sentinel (guards a vacuous pass)', () => {
    expect(INCONCLUSIVE).toHaveLength(11);
    expect(INCONCLUSIVE).toContain(0);
    const causes = INCONCLUSIVE.map(guestExitCauseForStatus);
    expect(causes).toHaveLength(INCONCLUSIVE.length);
    expect(new Set(causes)).toEqual(new Set(['access_ended']));
  });

  it('⚠ 404 and 409 are the ONLY two positive answers, out of the whole status space', () => {
    const positive: GuestExitCause[] = ['removed', 'host_ended'];
    const statuses = Array.from({ length: 600 }, (_value, index) => index);
    const specific = statuses.filter((status) =>
      positive.includes(guestExitCauseForStatus(status))
    );

    expect(specific).toEqual([404, 409]);
  });
});
