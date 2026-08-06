import { describe, it, expect } from 'vitest';
import { notificationRules } from './engine/rules.js';
import { WEB_SCHEDULABLE_EVENTS } from './events.js';

/**
 * ADR-1047 Decision 10's MECHANICAL COROLLARY, asserted rather than reviewed.
 *
 * > Any event whose `notificationRules` entry resolves a BALO-FACING delivery is API-only BY
 * > CONSTRUCTION, and may never appear in `WebSchedulableNotificationEvent`.
 *
 * The ADR words that corollary as `recipient: 'admin'`; enforced literally it would cover a
 * single rule in the whole table, so it is read here as the CLASS the ADR names —
 * `admin` AND `admin_users`. See `BALO_FACING_RECIPIENTS`.
 *
 * WHY A BALO-FACING RECIPIENT IS THE RIGHT PROXY. `replace_pending` is itself a SUPPRESSION
 * primitive: a caller able to schedule the same event with the same key can supersede a
 * pending promise's `scheduled_for` and payload — pushing a Balo-facing alert arbitrarily
 * far out, or replacing its contents. Dedup keys are deterministic and derived from entity
 * ids, so targeting a specific victim's alert needs no enumeration, and anyone holding
 * `INTERNAL_API_SECRET` (a build-time env var present in every Vercel preview deployment)
 * would qualify. A Balo-facing recipient is the checkable marker for "this event is how Balo
 * learns something it may not otherwise learn" — the exact class of alert that exists
 * because someone might prefer Balo not to know.
 *
 * ⚠ THIS TEST IS VACUOUSLY TRUE ON MERGE, AND THAT IS INTENDED.
 * `WebSchedulableNotificationEvent` is `never` and `WEB_SCHEDULABLE_EVENTS` is `[]`, so the
 * intersection is trivially empty today. It exists to become a LIVE TRIPWIRE the moment a
 * web-side consumer adds its first event to the union — which is precisely the moment the
 * mistake would be made, and long after the reasoning above has left anyone's head.
 *
 * This is a NEW file on purpose: `engine/rules.test.ts` is a guard/invariant file that
 * BAL-420 does not touch, and the rules table itself is untouched by this PR (Decision 1).
 */

/**
 * THE RECIPIENT KINDS THAT MEAN "BALO IS THE AUDIENCE".
 *
 *  · `admin`       — the ops inbox, a literal `OPS_NOTIFICATION_EMAIL` address.
 *  · `admin_users` — the fan-out the dispatcher resolves to Balo STAFF platform users.
 *
 * BOTH, not just `admin`. They differ only in carrier — one address versus a resolved staff
 * list — and are identical in what the corollary actually cares about: the recipient is Balo,
 * so suppressing the send is suppressing Balo's own knowledge. Matching only `admin` would
 * have covered ONE rule in the whole table while silently permitting the eight `admin_users`
 * events, which is a guard that reads far wider than it bites.
 *
 * ⚠ `email_address` IS DELIBERATELY EXCLUDED. It is the EXTERNAL, party-facing path — an
 * invitee who is not a Balo user (`expert.referral_invited`). Suppressing it withholds a
 * message from a third party; it does not stop Balo learning anything. That is the
 * party-facing class Decision 10 explicitly says PASSES the test, so folding it in here would
 * be over-blocking, not extra safety. (It is separately barred from being SCHEDULED at all,
 * on PII-retention grounds — see `SchedulableNotificationEvent`. Different reason, different
 * mechanism, deliberately not conflated.)
 */
const BALO_FACING_RECIPIENTS: ReadonlySet<string> = new Set(['admin', 'admin_users']);

/** Every event with at least one rule whose audience is Balo itself. */
function baloFacingEvents(): Set<string> {
  return new Set(
    Object.entries(notificationRules)
      .filter(([, rules]) => rules.some((rule) => BALO_FACING_RECIPIENTS.has(rule.recipient)))
      .map(([event]) => event)
  );
}

describe('web-schedulability policy (ADR-1047 Decision 10)', () => {
  it('NO event with a Balo-facing rule (admin or admin_users) is web-schedulable', () => {
    const baloFacing = baloFacingEvents();

    const violations = WEB_SCHEDULABLE_EVENTS.filter((event) => baloFacing.has(event));

    expect(
      violations,
      `These events resolve a Balo-facing (admin / admin_users) delivery and must never be ` +
        `web-schedulable — a caller who can schedule key K can supersede a pending alert's ` +
        `scheduled_for and payload, which is how Balo stops learning something:\n  ` +
        `${violations.join('\n  ')}`
    ).toEqual([]);
  });

  it('the corollary has something to bite on — Balo-facing rules still exist', () => {
    // If `rules.ts` ever loses every Balo-facing recipient, the assertion above becomes
    // vacuous for a SECOND reason (an empty left-hand set as well as an empty right-hand
    // one), and this test would stop meaning what its name claims. Fail loudly instead.
    expect(baloFacingEvents().size).toBeGreaterThan(0);
  });

  it('covers admin_users, not just the single admin rule', () => {
    // Pins the widening itself: matching only `recipient === 'admin'` found exactly ONE
    // event in the whole table (`project.match_requested`), so a regression to that
    // narrower predicate would still pass every other assertion here.
    const baloFacing = baloFacingEvents();
    expect(baloFacing.has('project.match_requested')).toBe(true); // the lone `admin` rule
    expect(baloFacing.has('engagement.completion_requested')).toBe(true); // `admin_users`
    expect(baloFacing.size).toBeGreaterThan(1);
  });

  it('WEB_SCHEDULABLE_EVENTS is empty until a web-side consumer earns an HTTP seam', () => {
    // There is no schedule route in this PR, and there will never be a cancel route
    // (Decision 11). BAL-411 is the only candidate, and it may well end up API-side too.
    //
    // ⚠ DELETE THIS CASE when the first consumer lands — a non-empty list is that consumer
    // shipping, not a violation. The assertions above are the ones that must survive.
    expect(WEB_SCHEDULABLE_EVENTS).toEqual([]);
  });
});
