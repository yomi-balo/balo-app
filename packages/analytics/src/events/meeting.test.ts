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
      // BAL-132. `J` < `P`, so this sorts first under both collations.
      'MEETING_JOIN_GRANTED',
      'MEETING_PROVISION_FAILED',
      'MEETING_PROVISIONED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISIONED).toBe('meeting_provisioned');
    expect(MEETING_SERVER_EVENTS.MEETING_PROVISION_FAILED).toBe('meeting_provision_failed');
    expect(MEETING_SERVER_EVENTS.MEETING_JOIN_GRANTED).toBe('meeting_join_granted');
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
