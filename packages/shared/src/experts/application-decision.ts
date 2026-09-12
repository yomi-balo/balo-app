/**
 * experts/application-decision — BAL-549's ONE definition of the expert-application decline
 * vocabulary, and the ONE "how long has this been waiting" derivation.
 *
 * WHY HERE AND NOT `@balo/db` (which owns the pgEnum). `@balo/shared` must not import
 * `@balo/db`: a client component that value-imports `@balo/db` drags the `postgres` driver into
 * the browser bundle and fails `next build`. The tuple is needed by a CLIENT island (the decline
 * sheet's reason picker), by `packages/shared`'s own notification payload, and by
 * `packages/analytics`' event map — none of which may depend on `@balo/db`. So this module
 * RESTATES the vocabulary, exactly as `project-requests/index.ts` does, and
 * `packages/db/src/schema/experts.ts` carries an `Exact<>` compile-time pin that turns a drift
 * between the two into a TYPE ERROR rather than a runtime surprise.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 *
 * PURE. No I/O, no clock (the clock is a parameter), no `server-only`.
 */

/**
 * Why an expert application was DECLINED (`expert_decline_reason`). Balo picks exactly one;
 * there is no applicant-side arm — only Balo declines an application.
 *
 * ⚠ THE STORED `application_status` IS `'rejected'`, NOT `'declined'` (orchestrator D2). This
 * tuple is the REASON vocabulary, not the status; the status label is unchanged and needs no
 * migration. Every user-facing surface says "declined".
 */
export const EXPERT_DECLINE_REASONS = [
  'experience_depth',
  'credentials_unverified',
  'application_incomplete',
  'not_a_fit',
] as const;

/** @see EXPERT_DECLINE_REASONS */
export type ExpertDeclineReason = (typeof EXPERT_DECLINE_REASONS)[number];

/**
 * THE decline-reason narrowing, for the one place a reason arrives as `unknown` (the merged
 * notification payload the api template reads). `null` for anything unrecognised — the caller
 * decides what to degrade to, rather than this module guessing on its behalf.
 */
export function narrowToExpertDeclineReason(value: unknown): ExpertDeclineReason | null {
  if (typeof value !== 'string') return null;
  return EXPERT_DECLINE_REASONS.find((candidate) => candidate === value) ?? null;
}

/**
 * BAL-549 (orchestrator O7) — WHOLE DAYS an application has been waiting, from
 * `expert_profiles.submitted_at`. `0` when never submitted, and never negative (a clock skew
 * that puts `submittedAt` in the future reads as 0, not as -1).
 *
 * ⚠⚠ THIS IS **NOT** THE QUEUE'S AGE, AND THE TWO DISAGREE BY DESIGN. The pending-actions queue
 * (`admin/_lib/admin-queue-view.ts`) computes its age from `admin_alerts.first_seen_at` — when
 * the SWEEP first saw the application — which is its documented sort key and is at least
 * `EXPERT_APPLICATION_PENDING_CUTOFF_MS` (2h, `apps/api/src/jobs/admin-alert-finders.ts`) plus
 * sweep latency BEHIND `submitted_at`.
 *
 * THE RULING (orchestrator O7): the LIST page, the REVIEW page and the analytics `days_waiting`
 * property all use THIS function — the TRUE wait, which is what staff and the funnel metric
 * mean. The QUEUE row keeps `first_seen_at` unchanged; BAL-548's sort key is not touched. A
 * staff member may therefore see "waiting 6d" here and "6d" (or "5d") on the queue row for the
 * same applicant. That is the honest reading of two different questions.
 *
 * ⚠⚠ DO NOT REUSE `formatAdminAlertAge`
 * (`apps/web/src/app/(dashboard)/admin/_lib/admin-queue-view.ts`) TO RENDER THIS NUMBER, AND DO
 * NOT "CONSOLIDATE" THE TWO. They round in OPPOSITE directions on purpose:
 *   · `formatAdminAlertAge` takes MINUTES and returns `Math.round(ageMinutes / 1440)` — a
 *     6d 23h alert reads "7d".
 *   · This function FLOORS — 6d 23h is 6, because "waiting 6d" must mean "has been waiting AT
 *     LEAST 6 days". Rounding up would overstate a wait on the surface where staff triage by it.
 * Reusing the queue's formatter here would make the RENDERED LABEL and the `days_waiting`
 * ANALYTICS PROPERTY on the SAME ROW disagree by one — an inconsistency WITHIN one surface,
 * which is strictly worse than the queue-vs-list difference O7 deliberately accepts.
 */
export function applicationWaitingDays(submittedAt: Date | null, now: Date): number {
  if (submittedAt === null) return 0;
  const ms = now.getTime() - submittedAt.getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / 86_400_000);
}
