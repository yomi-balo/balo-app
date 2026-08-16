import { describe, expect, it } from 'vitest';
import {
  MEETING_TRANSITIONS,
  assertMeetingTransition,
  isLegalMeetingTransition,
  type MeetingLifecycleStatus,
} from '@balo/shared/meetings';
import {
  END_MEETING_FROM,
  IN_PROGRESS_FROM,
  WAITING_FOR_PARTICIPANTS_FROM,
} from '../repositories/meetings';

/**
 * BAL-134 — ⚠⚠ THE TRANSITION MAP AND THE COMPARE-AND-SET MUST AGREE, AND UNTIL THIS PR THEY
 * WERE NOT EVEN CONNECTED.
 *
 * `@balo/shared/meetings` shipped `MEETING_TRANSITIONS` + `assertMeetingTransition` with a
 * docblock claiming the map was "consulted by EVERY writer" and that the map and the CAS were
 * "two INDEPENDENT guards". Both claims were false: `assertMeetingTransition` had NO production
 * caller anywhere. There was one guard — the CAS — and a load-bearing comment describing a
 * second one that did not exist. (This PR fixed exactly that class of trap in
 * `routes/meetings/index.ts`; leaving it here would have been the same defect twice.)
 *
 * The three `meetingsRepository` status mutators now assert their OWN declared FROM sets against
 * the map on every call, and those sets are the same arrays their `inArray` predicates use — so
 * the map and the CAS cannot drift apart silently.
 *
 * ⚠ THIS TEST IS THE STATIC HALF OF THAT GUARANTEE, and it needs no database: the FROM sets are
 * plain constants and `assertMeetingTransition` is pure. The repository's per-call assertion is
 * the runtime half. Neither replaces the other — a set that is never exercised in a test still
 * throws in production the first time its mutator runs.
 */
describe('the repository CAS FROM sets agree with MEETING_TRANSITIONS', () => {
  const EDGE_SETS: ReadonlyArray<{
    label: string;
    from: readonly MeetingLifecycleStatus[];
    to: MeetingLifecycleStatus;
  }> = [
    {
      label: 'markWaitingForParticipants',
      from: WAITING_FOR_PARTICIPANTS_FROM,
      to: 'waiting_for_participants',
    },
    { label: 'markInProgress', from: IN_PROGRESS_FROM, to: 'in_progress' },
    { label: 'endMeeting', from: END_MEETING_FROM, to: 'ended' },
  ];

  it.each(EDGE_SETS)('$label declares only edges the map allows', ({ from, to }) => {
    expect(from.length).toBeGreaterThan(0);
    for (const status of from) {
      expect(isLegalMeetingTransition(status, to)).toBe(true);
      expect(() => assertMeetingTransition(status, to)).not.toThrow();
    }
  });

  /**
   * ⚠ `endMeeting`'s CAS is an EXCLUSION (`status NOT IN ('ended','cancelled')`), so its FROM set
   * is stated here as the COMPLEMENT. That complement has to stay exact: a new terminal
   * `meeting_status` label added to the exclusion but not here — or vice versa — would mean
   * `endMeeting` could re-end a meeting already in it, which is the silent double-termination
   * `meetingStatusEnum`'s reader-sweep list warns about.
   */
  it('⚠ endMeeting covers EVERY non-terminal label — the complement of its exclusion CAS', () => {
    const terminal: readonly MeetingLifecycleStatus[] = ['ended', 'cancelled'];
    const nonTerminal = (Object.keys(MEETING_TRANSITIONS) as MeetingLifecycleStatus[]).filter(
      (status) => !terminal.includes(status)
    );

    expect([...END_MEETING_FROM].sort((a, b) => a.localeCompare(b))).toEqual(
      nonTerminal.sort((a, b) => a.localeCompare(b))
    );
  });

  /**
   * ⚠ AND THE ASSERTION REALLY REFUSES. A guard that cannot fail is the trap this whole file
   * exists to close, so the negative case is pinned beside the positive ones.
   */
  it('⚠ the assertion refuses an edge the map does not declare', () => {
    expect(() => assertMeetingTransition('ended', 'in_progress')).toThrow(
      /Illegal meeting transition/
    );
    expect(() => assertMeetingTransition('in_progress', 'waiting_for_participants')).toThrow();
  });
});
