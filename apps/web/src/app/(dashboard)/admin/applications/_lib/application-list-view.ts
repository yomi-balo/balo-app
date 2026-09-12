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

/**
 * The retrospective decision ATTRIBUTION ("Approved by Dana @ Balo" / "Declined by Dana @ Balo")
 * — CLAUDE.md's attribution rule: retrospective copy names the PERSON with "@ org" on first
 * mention. Balo staff always decide as "@ Balo" — there is no other org on this axis.
 *
 * ⚠⚠ THE DATE IS NO LONGER PART OF THIS STRING (web-review fix round, W4). This used to append
 * `· 3 Sep` from a local `formatShortDate` reading `getUTC*`. That was DETERMINISTIC (fix-round
 * F15's point, and worth keeping) but it was wrong for the reader: for Melbourne staff a decision
 * recorded before ~10am AEST rendered as the PREVIOUS calendar day, on the one surface that
 * answers "when was this decided".
 *
 * The date is now rendered beside this label by the SHIPPED `<LocalDate>`
 * (`components/local-date.tsx`) — the VIEWER's timezone, with a UTC first paint so hydration
 * never mismatches. That is the house mechanism for exactly this problem, so `formatShortDate`
 * and its month table are DELETED rather than reimplemented: no second spelling to drift, and
 * nothing server-side reads a local getter. Callers render
 * `{attribution} · <LocalDate iso={decidedAtIso} />`.
 */
export function formatDecisionAttribution(input: {
  readonly decision: 'approved' | 'declined';
  readonly decidedByFirstName: string | null;
  readonly decidedByLastName: string | null;
}): string {
  const personName = [input.decidedByFirstName, input.decidedByLastName]
    .filter((part): part is string => Boolean(part))
    .join(' ');
  const label = personWithOrgLabel(personName || 'A Balo staff member', 'Balo');
  const verb = input.decision === 'approved' ? 'Approved' : 'Declined'; // pending-MJ (D2)
  return `${verb} by ${label}`;
}

/** One list row, ready to render. */
export interface ApplicationListRowView {
  readonly expertProfileId: string;
  readonly name: string;
  readonly email: string;
  /** The agency the applicant applies under, or the independent-expert label. */
  readonly agencyLabel: string;
  /** The waiting label (pending) or the retrospective decision attribution (decided). */
  readonly statusLine: string;
  /**
   * W4 — `decided_at` as an ISO string for `<LocalDate>`, or `null` on a pending row (which has
   * no decision to date). ISO, not a `Date`: `<LocalDate>` is a client component and takes the
   * string it puts in `dateTime`.
   */
  readonly decidedAtIso: string | null;
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

  // W4 — the PENDING arm has no decision to date, and neither does a decided row whose
  // `decided_at` is null (only hand-written data reaches that). Both fall back to the waiting
  // label with no date beside it, exactly as before.
  const decidedAt = filter === 'pending' ? null : row.decidedAt;

  const statusLine =
    decidedAt === null
      ? formatWaitingLabel(daysWaiting)
      : formatDecisionAttribution({
          decision: filter === 'approved' ? 'approved' : 'declined',
          decidedByFirstName: row.decidedByFirstName,
          decidedByLastName: row.decidedByLastName,
        });

  return {
    expertProfileId: row.expertProfileId,
    name,
    email: row.email,
    agencyLabel,
    statusLine,
    decidedAtIso: decidedAt?.toISOString() ?? null,
    daysWaiting,
  };
}
