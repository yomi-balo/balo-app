/**
 * experts/applicant-write-window — BAL-593's H1 fix: the ONE predicate deciding whether an
 * applicant-authored write to `expert_profiles` (and its child rows) is still allowed, once a
 * Balo-staff edit can act on the very same row.
 *
 * PURE. No I/O, no `@balo/db`. The clock is a PARAMETER, never `Date.now()` — the caller
 * (`expertsRepository.saveApplicantDraftStep`) reads it inside the same `FOR UPDATE` transaction
 * that also reads `submittedAt`, so the two are always consistent with each other.
 *
 * ⚠ NO `.js` EXTENSIONS ON RELATIVE IMPORTS IN `packages/shared`. EVER.
 */

/**
 * The only writes that can legitimately trail a submit are a save already in flight when the
 * submit commits, and the unload beacon. Both land within seconds; 60s is twice the applicant
 * wizard's 30s idle-autosave debounce, covering a cold start, and is still far below any real
 * staff edit (the interview is booked days later). `under_review` and `approved` get NO grace —
 * only `submitted` does.
 */
export const APPLICANT_POST_SUBMIT_GRACE_MS = 60_000;

/** What an applicant-authored write to this draft resolves to. */
export type ApplicantDraftWriteDecision = 'ok' | 'declined' | 'closed';

/**
 * Classifies an applicant write against the row's locked `applicationStatus` and `submittedAt`.
 *
 * | status                          | result                                              |
 * | -------------------------------- | --------------------------------------------------- |
 * | `draft`                          | `ok`                                                 |
 * | `submitted`, within grace         | `ok`                                                 |
 * | `submitted`, past grace or no `submittedAt` | `closed`                                   |
 * | `rejected`                       | `declined`                                           |
 * | anything else (`under_review`, `approved`, a later `submitted`) | `closed`              |
 *
 * `rejected` STAYS `declined`. The only route from `rejected` back to a writable row is the
 * applicant's explicit "Start a new application" transition, `expertsRepository.reopenApplication`
 * (`rejected → draft`, behind the reapply cooldown). A stale wizard tab whose row is still
 * `rejected` is therefore refused, never silently reopened.
 *
 * `submittedAt` is `null` for a row that was marked `submitted` without that timestamp ever being
 * set — an impossible-in-practice but UNTRUSTED-input shape; it resolves to `closed`, never `ok`,
 * because there is no evidence of a recent submit to grant grace against.
 */
export function classifyApplicantDraftWrite(
  status: string,
  submittedAt: Date | null,
  now: Date
): ApplicantDraftWriteDecision {
  if (status === 'draft') return 'ok';
  if (status === 'rejected') return 'declined';
  if (status === 'submitted') {
    if (submittedAt === null) return 'closed';
    const elapsedMs = now.getTime() - submittedAt.getTime();
    return elapsedMs <= APPLICANT_POST_SUBMIT_GRACE_MS ? 'ok' : 'closed';
  }
  return 'closed';
}
