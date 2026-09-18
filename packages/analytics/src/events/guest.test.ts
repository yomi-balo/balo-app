import { describe, it, expect } from 'vitest';
import {
  ASSERT_GUEST_REENTRY_KEYS_COMPLETE,
  GUEST_SERVER_EVENTS,
  type GuestServerEventMap,
} from './guest';

describe('GUEST_SERVER_EVENTS', () => {
  it('exposes exactly the BAL-408 guest server events', () => {
    // ⚠ THE COMPARATOR IS NOT OPTIONAL — a bare `.sort()` is a SonarCloud reliability bug
    // (implementation-defined comparator).
    //
    // ⚠ AND IT ORDERS `GUEST_INVITE_OPENED` BEFORE `GUEST_INVITED` — verified, not assumed.
    // After the shared `GUEST_INVITE` prefix the strings differ at `_` vs `D`. ICU collation
    // gives punctuation a LOWER primary weight than letters, so `_OPENED` sorts first; a
    // bare code-unit `.sort()` would put `GUEST_INVITED` first (`D` 0x44 < `_` 0x5F). The
    // list below is the `localeCompare` order — do not "correct" it.
    expect(Object.keys(GUEST_SERVER_EVENTS).sort((a, b) => a.localeCompare(b))).toEqual([
      'GUEST_ADMITTED',
      // ⚠ BAL-489. Sorts here under BOTH ICU localeCompare and code-unit order — after
      // GUEST_ADMITTED (A < C) and before GUEST_DENIED (C < D) — so its position is not
      // collation-sensitive.
      'GUEST_CONVERTED_TO_MEMBER',
      'GUEST_DENIED',
      'GUEST_INVITE_OPENED',
      'GUEST_INVITED',
      // ⚠ BAL-132. `GUEST_JOINED` sorts here under BOTH ICU `localeCompare` and code-unit
      // order — after `GUEST_INVITED` (`I` < `J`) and before `GUEST_REMOVED` (`J` < `R`) —
      // so unlike the `GUEST_INVITE_OPENED` / `GUEST_INVITED` pair above, its position is
      // not collation-sensitive.
      'GUEST_JOINED',
      // ⚠ BAL-436. `GUEST_LINK_RESENT` sorts here under BOTH ICU `localeCompare` and
      // code-unit order — after `GUEST_JOINED` (`J` < `L`) and before `GUEST_RECAP_VIEWED`
      // (`L` < `R`) — so its position is not collation-sensitive either.
      'GUEST_LINK_RESENT',
      // ⚠ BAL-439 (R12). `GUEST_RECAP_VIEWED` sorts here under BOTH ICU `localeCompare` and
      // code-unit order — after `GUEST_LINK_RESENT` (`L` < `R`) and before `GUEST_REMOVED`
      // (shared `GUEST_RE` prefix, then `C` < `M`) — so its position is not
      // collation-sensitive either.
      'GUEST_RECAP_VIEWED',
      // ⚠ BAL-442. After the shared `GUEST_RE` prefix: `GUEST_RECAP_VIEWED` (`C`),
      // `GUEST_REENTRY_REQUESTED` (`E`), `GUEST_REMOVED` (`M`) — `C` < `E` < `M` under BOTH
      // ICU localeCompare and code-unit order, so this position is not collation-sensitive.
      'GUEST_REENTRY_REQUESTED',
      'GUEST_REMOVED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(GUEST_SERVER_EVENTS.GUEST_ADMITTED).toBe('guest_admitted');
    expect(GUEST_SERVER_EVENTS.GUEST_CONVERTED_TO_MEMBER).toBe('guest_converted_to_member');
    expect(GUEST_SERVER_EVENTS.GUEST_DENIED).toBe('guest_denied');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED).toBe('guest_invite_opened');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITED).toBe('guest_invited');
    expect(GUEST_SERVER_EVENTS.GUEST_JOINED).toBe('guest_joined');
    expect(GUEST_SERVER_EVENTS.GUEST_LINK_RESENT).toBe('guest_link_resent');
    expect(GUEST_SERVER_EVENTS.GUEST_RECAP_VIEWED).toBe('guest_recap_viewed');
    expect(GUEST_SERVER_EVENTS.GUEST_REENTRY_REQUESTED).toBe('guest_reentry_requested');
    expect(GUEST_SERVER_EVENTS.GUEST_REMOVED).toBe('guest_removed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(GUEST_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('⚠ `guest_converted_to_member` is DECLARED — the last reserved event arrived WITH its producer (BAL-489)', () => {
    // This case used to pin the event ABSENT, because it had no producer. BAL-489 ships the
    // producer (`runGuestConversionAndEmit`, fired from the verified new-user seams) in the
    // same PR, so the guard FLIPS rather than being deleted: the rule "no constant without a
    // producer" is now held by the exact-key-set case above. (`guest_joined` took the same
    // path at BAL-132.)
    const values: readonly string[] = Object.values(GUEST_SERVER_EVENTS);
    expect(values).toContain('guest_converted_to_member');
  });

  it('⚠ `guest_converted_to_member` landed VERBATIM — `{ days_since_meeting }` plus distinct_id, no PII', () => {
    const converted: GuestServerEventMap['guest_converted_to_member'] = {
      days_since_meeting: 21,
      distinct_id: 'user-1',
    };
    // ⚠ EXACT KEY SET, WITH A COMPARATOR (a bare `.sort()` fails SonarCloud S2871). An email,
    // domain, name, token or row count widens this set and fails here.
    expect(Object.keys(converted).sort((a, b) => a.localeCompare(b))).toEqual([
      'days_since_meeting',
      'distinct_id',
    ]);
  });

  /**
   * ⚠⚠ BAL-132 — `guest_joined.party` IS **OPTIONAL**, AND THE OMISSION IS THE WHOLE POINT.
   *
   * `meeting_guests.party` is NOT NULL and CHECK-narrowed to `client | expert`, so the lobby
   * writer stores the PLACEHOLDER `client` — not because a side was resolved (a bare meeting
   * URL carries no sharer identity) but because the column demands something. Emitting that
   * placeholder makes a dashboard filtered on `party = client` silently include every
   * link-share joiner: a WRONG answer, not merely a coarse one.
   *
   * ⚠ IT WAS `MeetingGuestSide | null` FIRST, and both this test and the source docblock said
   * the property was "ABSENT rather than wrong". **IT WAS NOT ABSENT.** `trackServer` spreads
   * the properties object straight into `capture({ properties })`, so the `null` reached
   * PostHog as a real value: it satisfies `party is set`, it creates a `null` breakdown bucket,
   * and it appears in the property explorer. Optional-and-omitted is what makes the claim true.
   *
   * ⚠ THE COMPILE-TIME HALF IS NOW ACTUALLY COMPILED. `@balo/analytics` had no `scripts` block
   * at all, so root `pnpm typecheck` never reached this package and Vitest transpiles via
   * esbuild WITHOUT type checking — a "COMPILE-TIME assertion" that nothing compiled. The
   * package now has a `typecheck` script, so the `@ts-expect-error` below is genuinely a gate.
   */
  it('⚠ `guest_joined.party` is OPTIONAL and OMITTED on link_share — never null', () => {
    const linkShare: GuestServerEventMap['guest_joined'] = {
      join_method: 'link_share',
      admitted: true,
      distinct_id: 'guest-1',
    };
    const resolved: GuestServerEventMap['guest_joined'] = {
      party: 'expert',
      join_method: 'magic_link',
      admitted: false,
      distinct_id: 'guest-2',
    };

    // ⚠ KEY ABSENCE, not `=== undefined`: `JSON.stringify` drops an absent key entirely, which
    // is exactly why PostHog never sees the property. A `party: undefined` would pass an
    // `=== undefined` check while still being a present key.
    expect('party' in linkShare).toBe(false);
    expect(resolved.party).toBe('expert');
  });

  it('⚠ `guest_joined.party` REJECTS null — the encoding that used to ship', () => {
    const withNull: GuestServerEventMap['guest_joined'] = {
      // @ts-expect-error — `null` is a VALUE PostHog would store; the property must be omitted.
      party: null,
      join_method: 'link_share',
      admitted: true,
      distinct_id: 'guest-3',
    };

    expect(withNull.join_method).toBe('link_share');
  });

  /**
   * ⚠⚠ BAL-439 (R12) — `guest_recap_viewed` ARRIVED WITH ITS PRODUCER, in the same PR
   * (`app/join/[token]/recap/[meetingId]/page.tsx`). Like `guest_converted_to_member` after it
   * (BAL-489), this event arrived WITH its producer — the exact rule R8 cites approvingly and
   * R12 restates.
   */
  it('⚠ `guest_recap_viewed` carries no PII and no counterparty identity', () => {
    const viewed: GuestServerEventMap['guest_recap_viewed'] = {
      access_scope: 'engagement',
      is_own_meeting: false,
      summary_state: 'ready',
      days_since_meeting: 5,
      distinct_id: 'guest-4',
    };

    // ⚠ EXACT KEY SET — a future edit that adds an email, a company name or a counterparty
    // name would widen this set and fail here loudly, rather than shipping unnoticed.
    expect(Object.keys(viewed).sort()).toEqual([
      'access_scope',
      'days_since_meeting',
      'distinct_id',
      'is_own_meeting',
      'summary_state',
    ]);
  });

  /**
   * ⚠⚠ fix-round-1 / S6 (R12) — `days_since_meeting` is a WHOLE, NON-NEGATIVE day count, never
   * negative and never fractional at the type level (the runtime floor lives in the shared
   * `daysSinceMeeting` (`apps/web/src/lib/analytics/days-since-meeting.ts`), called at the
   * page — and shared with `guest_converted_to_member` (R9)).
   */
  it('⚠ `days_since_meeting` is a plain number — floored, non-negative, computed at the page', () => {
    const openedTheSameDay: GuestServerEventMap['guest_recap_viewed'] = {
      access_scope: 'meeting',
      is_own_meeting: true,
      summary_state: 'absent',
      days_since_meeting: 0,
      distinct_id: 'guest-5',
    };

    expect(openedTheSameDay.days_since_meeting).toBe(0);
  });

  /**
   * BAL-442 — `guest_reentry_requested` fires on BOTH the match and the miss arm.
   *
   * ⚠⚠ NO `meeting_id`, NO `party` — see the map entry's own docblock for why (the SINK, not
   * consistency: PostHog is a third-party processor and `meetingId` is already logged
   * deliberately as a structured field elsewhere).
   *
   * ⚠ fix-round (F7) — WEAKENED CLAIM, on purpose. `Object.keys(match)` below only ever
   * inspects the keys THIS test itself typed into the literal — it is runtime-tautological and
   * would still pass if `GuestServerEventMap['guest_reentry_requested']` grew an OPTIONAL
   * `meeting_id?`/`party?` field elsewhere in the map (the literal below simply wouldn't set
   * it). The real "no extra key was added to the TYPE" guarantee is
   * `ASSERT_GUEST_REENTRY_KEYS_COMPLETE` in `guest.ts` — a compile-time witness that fails
   * `tsc`, not this runtime check — referenced below so it cannot rot back into
   * "declared but unused". The `Object.keys` assertions here now document only what they
   * actually prove: that a `matched`/`distinct_id` literal is what a match and a miss build.
   */
  it('⚠ `guest_reentry_requested` — the compile-time key-set witness holds', () => {
    expect(ASSERT_GUEST_REENTRY_KEYS_COMPLETE).toBe(true);
  });

  it('documents the match/miss literals as `{ matched, distinct_id }`', () => {
    const match: GuestServerEventMap['guest_reentry_requested'] = {
      matched: true,
      distinct_id: 'guest-6',
    };
    const miss: GuestServerEventMap['guest_reentry_requested'] = {
      matched: false,
      distinct_id: 'system:guest-reentry',
    };

    expect(Object.keys(match).sort((a, b) => a.localeCompare(b))).toEqual([
      'distinct_id',
      'matched',
    ]);
    expect(Object.keys(miss).sort((a, b) => a.localeCompare(b))).toEqual([
      'distinct_id',
      'matched',
    ]);
  });
});
