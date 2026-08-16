import { describe, expect, it } from 'vitest';
import { canEndMeeting, endedByForActor, type MeetingEndedBy } from './end-authority';

describe('canEndMeeting (BAL-134 D3/D6/D7)', () => {
  const TRUTH_TABLE: ReadonlyArray<{
    isExpertHost: boolean;
    isClientPrincipal: boolean;
    expected: boolean;
    endedBy: MeetingEndedBy | null;
  }> = [
    { isExpertHost: false, isClientPrincipal: false, expected: false, endedBy: null },
    { isExpertHost: true, isClientPrincipal: false, expected: true, endedBy: 'expert_host' },
    { isExpertHost: false, isClientPrincipal: true, expected: true, endedBy: 'client_principal' },
    // ⚠ BOTH-TRUE IS UNREACHABLE THROUGH `authorizeMeetingParticipation` (its expert arm runs
    // only when the actor holds NO company membership) — pinned anyway, because the pure core
    // takes no view and a widened gate must not find this state undefined.
    { isExpertHost: true, isClientPrincipal: true, expected: true, endedBy: 'expert_host' },
  ];

  it.each(TRUTH_TABLE)(
    'expertHost=$isExpertHost clientPrincipal=$isClientPrincipal → $expected',
    ({ isExpertHost, isClientPrincipal, expected }) => {
      expect(canEndMeeting({ isExpertHost, isClientPrincipal })).toBe(expected);
    }
  );

  it.each(TRUTH_TABLE)(
    'expertHost=$isExpertHost clientPrincipal=$isClientPrincipal stamps $endedBy',
    ({ isExpertHost, isClientPrincipal, endedBy }) => {
      expect(endedByForActor({ isExpertHost, isClientPrincipal })).toBe(endedBy);
    }
  );

  /**
   * ⚠ THE ONE PROPERTY THAT MATTERS MOST: a denial is the ONLY case that yields no label, and
   * a grant is the ONLY case that yields one. `end-meeting.ts` branches on exactly this, so a
   * `null` reaching the repository would be a type error rather than an unattributed end.
   */
  it('a label exists exactly when the actor may end', () => {
    for (const row of TRUTH_TABLE) {
      const input = {
        isExpertHost: row.isExpertHost,
        isClientPrincipal: row.isClientPrincipal,
      };
      expect(endedByForActor(input) !== null).toBe(canEndMeeting(input));
    }
  });

  it('⚠ never answers `system_idle` — that label belongs to the sweep, not to an actor', () => {
    for (const row of TRUTH_TABLE) {
      expect(
        endedByForActor({
          isExpertHost: row.isExpertHost,
          isClientPrincipal: row.isClientPrincipal,
        })
      ).not.toBe('system_idle');
    }
  });
});
