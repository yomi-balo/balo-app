import { describe, it, expect } from 'vitest';
import { GUEST_SERVER_EVENTS, type GuestServerEventMap } from './guest';

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
      'GUEST_DENIED',
      'GUEST_INVITE_OPENED',
      'GUEST_INVITED',
      // ⚠ BAL-132. `GUEST_JOINED` sorts here under BOTH ICU `localeCompare` and code-unit
      // order — after `GUEST_INVITED` (`I` < `J`) and before `GUEST_REMOVED` (`J` < `R`) —
      // so unlike the `GUEST_INVITE_OPENED` / `GUEST_INVITED` pair above, its position is
      // not collation-sensitive.
      'GUEST_JOINED',
      // ⚠ BAL-436. `GUEST_LINK_RESENT` sorts here under BOTH ICU `localeCompare` and
      // code-unit order — after `GUEST_JOINED` (`J` < `L`) and before `GUEST_REMOVED`
      // (`L` < `R`) — so its position is not collation-sensitive either.
      'GUEST_LINK_RESENT',
      'GUEST_REMOVED',
    ]);
  });

  it('maps each constant to its exact snake_case event name', () => {
    expect(GUEST_SERVER_EVENTS.GUEST_ADMITTED).toBe('guest_admitted');
    expect(GUEST_SERVER_EVENTS.GUEST_DENIED).toBe('guest_denied');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITE_OPENED).toBe('guest_invite_opened');
    expect(GUEST_SERVER_EVENTS.GUEST_INVITED).toBe('guest_invited');
    expect(GUEST_SERVER_EVENTS.GUEST_JOINED).toBe('guest_joined');
    expect(GUEST_SERVER_EVENTS.GUEST_LINK_RESENT).toBe('guest_link_resent');
    expect(GUEST_SERVER_EVENTS.GUEST_REMOVED).toBe('guest_removed');
  });

  it('uses snake_case event values', () => {
    for (const value of Object.values(GUEST_SERVER_EVENTS)) {
      expect(value).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('⚠ does NOT declare an event with no producer — `guest_converted_to_member` is still BAL-345’s', () => {
    // A constant with no emitter reads as a 100% drop-off funnel step in PostHog. The shape
    // is documented in the module docblock so the receiving ticket adds it verbatim; it may
    // not be declared here until it can actually fire.
    //
    // ⚠ `guest_joined` WAS PINNED ABSENT HERE AND HAS NOW LANDED (BAL-132). Removing this
    // assertion is the CORRECT amendment, not a weakening of the guard: the rule is "no
    // constant without a producer", and `guest_joined` arrived in the same PR as
    // `joinMeetingAsGuest`, which emits it on every successful Daily token mint. The
    // exact-key-set case above is what keeps the set honest now.
    const values: readonly string[] = Object.values(GUEST_SERVER_EVENTS);
    expect(values).not.toContain('guest_converted_to_member');
  });

  it('BAL-345’s shape stays reserved in prose, not in code — the docblock is the hand-off', () => {
    // Non-vacuity for the assertion above: prove the collection really is the one being
    // guarded, so a future refactor that empties it cannot make the check pass for free.
    expect(Object.values(GUEST_SERVER_EVENTS).length).toBeGreaterThan(0);
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
});
