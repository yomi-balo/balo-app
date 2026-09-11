import { personWithOrgLabel } from '@balo/shared/parties';
import { applicationWaitingDays } from '@balo/shared/experts';
import type { ApplicationReviewFilter, ApplicationReviewRow } from '@balo/db';

/**
 * BAL-549 — client-safe view helpers for the `/admin/applications` list: the chip vocabulary,
 * row-mapping, chip counts, and the waiting-age label.
 *
 * ⚠ NO `server-only`, NO VALUE import from `@balo/db` (memory
 * `reference_balo_db_client_bundle_footgun`) — `application-filter-chips.tsx` (a `'use client'`
 * leaf) imports from this module, so a `@balo/db` value import would drag the postgres driver
 * into the browser bundle. `ApplicationReviewFilter` / `ApplicationReviewRow` are TYPE-ONLY
 * imports, erased at compile time — safe. The filter tuple below is a LOCAL, client-safe
 * restatement of `@balo/db`'s `APPLICATION_REVIEW_FILTERS` (the `LOOKUP_TYPE_FILTERS` /
 * `@balo/shared/lookup` pattern), not a re-export of it.
 */

/** Caller-side constants for `listApplicationsForReview` (plan §5.4 tail). */
export const APPLICATION_LIST_LIMIT = 100;
export const DECIDED_WINDOW_DAYS = 30;

/**
 * The `/admin/applications` chip vocabulary, in display order. `satisfies` proves — at compile
 * time — that every element is a real `ApplicationReviewFilter`; a drift (a renamed/added/
 * removed label on either side) is a type error, not a silent runtime mismatch.
 */
export const APPLICATION_LIST_FILTERS = [
  'pending',
  'approved',
  'declined',
] as const satisfies readonly ApplicationReviewFilter[];

export const APPLICATION_FILTER_LABEL: Record<ApplicationReviewFilter, string> = {
  pending: 'Pending',
  approved: 'Approved',
  declined: 'Declined',
};

/**
 * BAL-549 (orchestrator D4 / O7) — never a bare index, never a regex. Defaults to `'pending'`
 * for anything not in the vocabulary, INCLUDING a prototype-chain key (`__proto__`,
 * `constructor`) — `Array.prototype.find` over a fixed tuple never resolves an inherited
 * property, unlike a bare object index (the `resolveActiveAdminSection` / S5852 rule).
 */
export function resolveApplicationFilter(raw: string | undefined): ApplicationReviewFilter {
  const found = APPLICATION_LIST_FILTERS.find((candidate) => candidate === raw);
  return found ?? 'pending';
}

/**
 * BAL-549 (orchestrator O7) — the pending row's age label. Formats the SAME number the
 * `days_waiting` analytics property carries (`applicationWaitingDays`, `@balo/shared/experts`),
 * so the label a staffer reads and the number the funnel records can never disagree by a day.
 *
 * ⚠⚠ NOT `formatAdminAlertAge` (`admin/_lib/admin-queue-view.ts:149`). That one is MINUTE-based
 * and ROUNDS (6d 23h → "7d"); this one renders a FLOORED day count (6d 23h → "waiting 6d"),
 * because "waiting 6d" must mean "has been waiting AT LEAST 6 days". Rounding up would overstate
 * a wait on the surface where staff triage by it. Reusing the queue's formatter here would make
 * the RENDERED LABEL and the `days_waiting` ANALYTICS PROPERTY on the SAME ROW disagree by
 * one — do not consolidate them. See `applicationWaitingDays`'s docblock for the full ruling.
 *
 * Ages are facts, never countdowns (the queue's copy rule, kept).
 */
export function formatWaitingLabel(days: number): string {
  if (days < 1) return 'waiting today'; // pending-MJ
  return `waiting ${days}d`; // pending-MJ
}

const SHORT_MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * "3 Sep" — the shape both the list row and the decision banner use. A fixed lookup, not
 * `Intl`/`toLocaleDateString('en-GB', …)`: ICU's `en-GB` "short" month for September is "Sept"
 * (4 letters), not "Sep" — locale-dependent and would silently vary by Node/ICU build.
 *
 * ⚠⚠ `getUTC*`, NEVER `getMonth()`/`getDate()` (fix round, F15). This renders SERVER-SIDE in a
 * Server Component, so the plain getters would read the DEPLOYMENT's timezone: the same
 * `decided_at` would print "3 Sep" on one host and "4 Sep" on another, and the tests pinning
 * "3 Sep" for a UTC-midnight instant were green only because CI runners happen to default to
 * UTC. UTC is the one reading that is the same everywhere, and it is the instant the column
 * stores.
 */
export function formatShortDate(date: Date): string {
  const month = SHORT_MONTHS[date.getUTCMonth()];
  return `${date.getUTCDate()} ${month ?? ''}`.trim();
}

/**
 * The retrospective decision line ("Approved by Dana @ Balo · 3 Sep" / "Declined by Dana @
 * Balo · 3 Sep") — CLAUDE.md's attribution rule: retrospective copy names the PERSON with
 * "@ org" on first mention. Balo staff always decide as "@ Balo" — there is no other org on
 * this axis.
 */
export function formatDecisionLine(input: {
  readonly decision: 'approved' | 'declined';
  readonly decidedByFirstName: string | null;
  readonly decidedByLastName: string | null;
  readonly decidedAt: Date;
}): string {
  const personName = [input.decidedByFirstName, input.decidedByLastName]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  const label = personWithOrgLabel(personName || 'A Balo staff member', 'Balo');
  const verb = input.decision === 'approved' ? 'Approved' : 'Declined'; // pending-MJ (D2)
  return `${verb} by ${label} · ${formatShortDate(input.decidedAt)}`;
}

/** One list row, ready to render. */
export interface ApplicationListRowView {
  readonly expertProfileId: string;
  readonly name: string;
  readonly email: string;
  /** The agency the applicant applies under, or the independent-expert label. */
  readonly agencyLabel: string;
  /** The waiting label (pending) or the retrospective decision line (decided). */
  readonly statusLine: string;
  readonly daysWaiting: number;
}

export function toApplicationListRowView(
  row: ApplicationReviewRow,
  filter: ApplicationReviewFilter,
  now: Date
): ApplicationListRowView {
  const name =
    [row.firstName, row.lastName].filter((part): part is string => Boolean(part)).join(' ') ||
    row.email;
  const agencyLabel = row.agencyName ?? 'Independent'; // pending-MJ

  // ⚠ THE ONE DERIVATION — never re-derived locally. Callers passing this same number to the
  // `days_waiting` analytics property is what keeps the rendered label and the funnel metric
  // from disagreeing by a day (orchestrator O7).
  const daysWaiting = applicationWaitingDays(row.submittedAt, now);

  const statusLine =
    filter === 'pending' || row.decidedAt === null
      ? formatWaitingLabel(daysWaiting)
      : formatDecisionLine({
          decision: filter === 'approved' ? 'approved' : 'declined',
          decidedByFirstName: row.decidedByFirstName,
          decidedByLastName: row.decidedByLastName,
          decidedAt: row.decidedAt,
        });

  return {
    expertProfileId: row.expertProfileId,
    name,
    email: row.email,
    agencyLabel,
    statusLine,
    daysWaiting,
  };
}
