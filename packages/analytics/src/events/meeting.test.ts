import { describe, it, expect } from 'vitest';
import { MEETING_SERVER_EVENTS, type MeetingServerEventMap } from './meeting';

describe('MEETING_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-129 meeting server events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare `.sort()` is a SonarCloud reliability bug.
    // ⚠ AND IT ORDERS THESE TWO OPPOSITE TO A CODE-UNIT SORT — verified, not assumed. After
    // the shared `MEETING_PROVISION` prefix the strings differ at `E` vs `_`. A bare
    // `.sort()` compares UTF-16 code units, where `E` (0x45) < `_` (0x5F), so it yields
    // `..._PROVISIONED` first. ICU collation gives punctuation a LOWER primary weight than
    // letters, so `_` < `E` and `..._PROVISION_FAILED` comes first. The list below is the
    // `localeCompare` order; do not "correct" it to the code-unit one.
    expect(Object.keys(MEETING_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      // BAL-134 (5). ⚠ THE ORDER BELOW IS `localeCompare`'s, NOT a code-unit sort's — see the
      // note above. `MEETING_ENDED` < `MEETING_EXPERT_…` because `N` < `X`; `MEETING_MISSED_…`
      // < `MEETING_PROVISION_FAILED` because `M` < `P`; and `MEETING_STARTED` <
      // `MEETING_WAITING_…` because `S` < `W`.
      'MEETING_ENDED',
      'MEETING_EXPERT_ABSENT_ALERT',
      // BAL-132. `J` < `M`, so this sorts before the missed call.
      'MEETING_JOIN_GRANTED',
      'MEETING_MISSED_CALL',
      'MEETING_PROVISION_FAILED',
      'MEETING_PROVISIONED',
      'MEETING_STARTED',
      'MEETING_WAITING_ABANDONED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISIONED).toBe('meeting_provisioned');
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED).toBe('meeting_provision_failed');
    expect(MEETING_SERVER_EVENTS.MEETING_JOIN_GRANTED).toBe('meeting_join_granted');
    expect(MEETING_SERVER_EVENTS.MEETING_STARTED).toBe('meeting_started');
    expect(MEETING_SERVER_EVENTS.MEETING_WAITING_ABANDONED).toBe('meeting_waiting_abandoned');
    expect(MEETING_SERVER_EVENTS.MEETING_EXPERT_ABSENT_ALERT).toBe('meeting_expert_absent_alert');
    expect(MEETING_SERVER_EVENTS.MEETING_MISSED_CALL).toBe('meeting_missed_call');
    expect(MEETING_SERVER_EVENTS.MEETING_ENDED).toBe('meeting_ended');
  });

  /**
   * ⚠⚠ `distinct_id` IS REQUIRED ON EVERY SERVER EVENT AND FOUR OF THE FIVE BAL-134 EVENTS HAVE
   * NO ACTING HUMAN. `trackServer` destructures it and promotes it to PostHog's `distinctId`,
   * and the cast means a MISSING property silently becomes `undefined` — an event attributed to
   * nobody, invisible in every funnel. A COMPILE-TIME assertion: making the property optional
   * would leave the `@ts-expect-error` unused, which is itself a type error.
   */
  it('⚠ every BAL-134 lifecycle event REQUIRES distinct_id', () => {
    // @ts-expect-error — `distinct_id` is not optional.
    const missing: MeetingServerEventMap['meeting_missed_call'] = {
      meeting_id: 'meeting-1',
      client_joined: false,
    };
    expect(missing.meeting_id).toBe('meeting-1');
  });

  /**
   * ⚠ `outcome` IS NULLABLE ON `meeting_ended` AND THAT IS A REAL VALUE, NOT "unknown" (D5).
   * The two human paths and the abandoned wait leave it unset; BAL-412 resolves it from
   * `meeting_presence`.
   */
  it('⚠ `meeting_ended.outcome` accepts null — the ender never sets the outcome', () => {
    const humanEnd: MeetingServerEventMap['meeting_ended'] = {
      meeting_id: 'meeting-1',
      billable_seconds: 1800,
      expert_present_seconds: 1860,
      participant_count: 2,
      outcome: null,
      ended_by: 'client_principal',
      distinct_id: 'user-1',
    };
    const systemEnd: MeetingServerEventMap['meeting_ended'] = {
      ...humanEnd,
      outcome: 'no_show_client',
      ended_by: 'system_idle',
      // ⚠ THE MEETING ID — the four system paths have no acting user.
      distinct_id: 'meeting-1',
    };

    expect(humanEnd.outcome).toBeNull();
    expect(systemEnd.ended_by).toBe('system_idle');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(MEETING_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  /**
   * ⚠⚠ BAL-132 — `meeting_join_granted.context_type` EXCLUDES `admin`, BY TYPE.
   *
   * The sole producer is `joinMeetingAsMember`, whose `subject` is a `PrimaryMeetingContext`,
   * whose `contextType` is `MeetingContextTypeWithHolder` BY CONSTRUCTION: an `admin` meeting
   * has no holder, so it resolves on the PLATFORM axis and never reaches a member join grant.
   * Declaring the label anyway invited a consumer to write a branch that can never run.
   *
   * A COMPILE-TIME assertion — restoring `admin` to the union makes the `@ts-expect-error`
   * below unused, which is itself a type error, so `pnpm typecheck` fails either way.
   */
  it('⚠ `meeting_join_granted.context_type` cannot be `admin` — that label has no holder', () => {
    const holderBearing: MeetingServerEventMap['meeting_join_granted'] = {
      meeting_id: 'meeting-1',
      context_type: 'request_interaction',
      is_owner: true,
      distinct_id: 'user-1',
    };

    const unreachable: MeetingServerEventMap['meeting_join_granted'] = {
      meeting_id: 'meeting-1',
      // @ts-expect-error — `admin` is structurally unreachable for this producer.
      context_type: 'admin',
      is_owner: false,
      distinct_id: 'user-1',
    };

    expect(holderBearing.context_type).toBe('request_interaction');
    expect(unreachable.meeting_id).toBe('meeting-1');
  });
});
