import { describe, expect, it } from 'vitest';
import { MAX_MEETING_PARTICIPANTS } from '@balo/shared/meetings';
import {
  GUEST_ACTION_COPY,
  guestActionCopyFor,
  rateLimitedCopy,
  type GuestActionErrorCode,
} from './guests-copy';

/**
 * BAL-436 — the api literal → copy table.
 *
 * ⚠⚠ THE LOAD-BEARING ASSERTION IS THE **NO-403** ONE. The guest surface collapses "no such
 * meeting", "not your party", "unresolvable context" and "not a host" into ONE literal, so any
 * sentence implying a permission problem would invent a distinction the api deliberately
 * refuses to make — and would be wrong for three of those four cases.
 */

describe('GUEST_ACTION_COPY', () => {
  it('⚠⚠ no message implies a 403 — there is no 403 anywhere on this surface', () => {
    const forbidden = ['permission', 'not allowed', 'unauthorized', 'unauthorised', 'forbidden'];
    for (const [code, message] of Object.entries(GUEST_ACTION_COPY)) {
      for (const word of forbidden) {
        expect(message.toLowerCase(), `${code} implies a permission failure`).not.toContain(word);
      }
    }
  });

  it('⚠ no message names a gendered pronoun', () => {
    for (const [code, message] of Object.entries(GUEST_ACTION_COPY)) {
      expect(message.toLowerCase(), `${code} is gendered`).not.toMatch(/\b(he|she|his|her)\b/);
    }
  });

  it('derives the cap from the shared constant rather than hardcoding a 10', () => {
    expect(GUEST_ACTION_COPY.participant_cap_reached).toContain(String(MAX_MEETING_PARTICIPANTS));
  });

  it('frames the race as a race, not as a failure', () => {
    expect(GUEST_ACTION_COPY.guest_not_pending).toBe('Someone else already decided this.');
  });

  it('names the control that clears a flooded queue', () => {
    expect(GUEST_ACTION_COPY.lobby_queue_full).toContain('deny');
  });
});

describe('guestActionCopyFor', () => {
  it.each<[GuestActionErrorCode, number]>([
    ['meeting_not_found', 404],
    ['guest_not_found', 404],
    ['guest_link_not_resendable', 409],
    ['guest_already_invited', 409],
    ['participant_cap_reached', 409],
    ['guest_not_pending', 409],
  ])('maps the %s literal to its own sentence', (code, status) => {
    expect(guestActionCopyFor({ status, code })).toBe(GUEST_ACTION_COPY[code]);
  });

  /**
   * ⚠⚠ EVERY STATUS ARM IS EXERCISED WITH A `code` THAT MAPS **SOMEWHERE ELSE**.
   *
   * An earlier version passed `{status: 0, code: 'request_failed'}`, `{status: 503, code:
   * 'rate_limit_unavailable'}` and `{status: 401, code: 'unauthenticated'}` — i.e. codes whose
   * own table entry was already the expected sentence. Every one of those assertions therefore
   * passed with the status arm DELETED, and the byte-identical `rate_limit_unavailable` /
   * `request_failed` copy hid the 503 case even from a careful reader. A pass-through cannot be
   * distinguished from a lookup unless the two disagree.
   */
  it('⚠⚠ TRANSPORT (`status: 0`) OVERRIDES the body`s literal, whatever it said', () => {
    const copy = guestActionCopyFor({ status: 0, code: 'guest_not_found' });

    expect(copy).toBe(GUEST_ACTION_COPY.request_failed);
    expect(copy).not.toBe(GUEST_ACTION_COPY.guest_not_found);
  });

  it('⚠⚠ a 503 and any 500 OVERRIDE their literal — "our side, not yours"', () => {
    // ⚠ `rate_limit_unavailable` is the literal a 503 actually carries, and its table entry is
    // now a DIFFERENT sentence — so this asserts the status arm rather than a coincidence.
    const fiveOhThree = guestActionCopyFor({ status: 503, code: 'rate_limit_unavailable' });
    expect(fiveOhThree).toBe(GUEST_ACTION_COPY.request_failed);
    expect(fiveOhThree).not.toBe(GUEST_ACTION_COPY.rate_limit_unavailable);

    expect(guestActionCopyFor({ status: 500, code: 'meeting_not_found' })).toBe(
      GUEST_ACTION_COPY.request_failed
    );
  });

  it('⚠⚠ a 401 OVERRIDES the body`s literal and asks the person to sign in', () => {
    const copy = guestActionCopyFor({ status: 401, code: 'meeting_not_found' });

    expect(copy).toBe(GUEST_ACTION_COPY.unauthenticated);
    expect(copy).not.toBe(GUEST_ACTION_COPY.meeting_not_found);
  });

  it('⚠⚠ a 429 OVERRIDES the body`s literal and quotes the cooldown', () => {
    const copy = guestActionCopyFor({
      status: 429,
      code: 'meeting_not_found',
      retryAfterSeconds: 120,
    });

    expect(copy).toBe(rateLimitedCopy(120));
    expect(copy).not.toBe(GUEST_ACTION_COPY.meeting_not_found);
  });

  it('⚠ the two "our side" sentences are DISTINGUISHABLE — identical copy hides a routing bug', () => {
    expect(GUEST_ACTION_COPY.rate_limit_unavailable).not.toBe(GUEST_ACTION_COPY.request_failed);
  });

  it('⚠ an UNKNOWN literal degrades to the retryable line rather than leaking the literal', () => {
    const copy = guestActionCopyFor({ status: 409, code: 'some_new_literal' });

    expect(copy).toBe(GUEST_ACTION_COPY.request_failed);
    expect(copy).not.toContain('some_new_literal');
  });
});

describe('rateLimitedCopy', () => {
  it('quotes a real number of minutes, rounded UP', () => {
    expect(rateLimitedCopy(61)).toContain('2 minutes');
  });

  it('⚠ NEVER says "0 minutes" — a 40-second cooldown honestly reads as a minute', () => {
    expect(rateLimitedCopy(40)).toContain('1 minute');
    expect(rateLimitedCopy(40)).not.toContain('0 minute');
  });

  it('singularises one minute', () => {
    expect(rateLimitedCopy(60)).toContain('1 minute.');
  });

  it('falls back to the generic line with no usable number', () => {
    expect(rateLimitedCopy(undefined)).toBe(GUEST_ACTION_COPY.rate_limited);
    expect(rateLimitedCopy(0)).toBe(GUEST_ACTION_COPY.rate_limited);
  });

  it('is what a 429 resolves to, with the header value threaded through', () => {
    expect(guestActionCopyFor({ status: 429, code: 'rate_limited', retryAfterSeconds: 120 })).toBe(
      rateLimitedCopy(120)
    );
  });
});
