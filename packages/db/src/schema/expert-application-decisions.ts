import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { expertApplicationDecisionEnum, expertDeclineReasonEnum } from './enums';
import { users } from './users';
import { expertProfiles } from './experts';
import { timestamps, softDelete } from './helpers';

/**
 * expert_application_decisions (BAL-557) — the ARCHIVE of an expert application's past
 * terminal decisions. One row per archived decision.
 *
 * `expert_profiles` holds only the CURRENT decision (`decided_at`, `decided_by_user_id`,
 * `decline_reason`, `decline_note` — the ADR-1030 floor). When a declined applicant starts a new
 * application (`expertsRepository.reopenApplication`, `rejected → draft`), that transaction
 * copies the floor columns and the decided application's `submitted_at` from the LOCKED profile
 * row into a row here, then clears them on the profile. The staff review page reads this table
 * so a prior decision stays discoverable after the profile moves on.
 *
 * ⚠ THE FLOOR COLUMNS ARE NULLABLE because the profile's are: a pre-ADR-1030 or imported
 * `rejected` row can carry NULL decision columns (`schema/experts.ts`), and the archive copies
 * what is there rather than inventing it.
 *
 * ⚠ ONE WRITER: `expertApplicationDecisionsRepository.archiveTx`, called only from
 * `reopenApplication`'s locked transaction.
 *
 * ── NO RLS — A KNOWING DEVIATION, RECORDED ────────────────────────────────────────────
 * No schema file in this package calls `.enableRLS()` or `pgPolicy()`: Balo authenticates with
 * WorkOS + iron-session, so `auth.uid()` is always null, every reader is the admin `db` client
 * (which bypasses RLS), and the boundary is the application layer. The one read is gated by a
 * platform capability on the staff review page. Same deviation as `admin-alerts.ts`.
 *
 * ── NO `relations()` BLOCK ────────────────────────────────────────────────────────────
 * A relational `with:` hydration of `users` for `decided_by_user_id` would pull `workos_id` and
 * the full PII row. A reader that needs the decider's name resolves it with an explicit
 * projection (`usersRepository.findNamesByIds`).
 */
export const expertApplicationDecisions = pgTable(
  'expert_application_decisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // The application this decision was about. Restrict: an archived decision is history and
    // must not vanish with a hard-deleted profile.
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'restrict' }),

    decision: expertApplicationDecisionEnum('decision').notNull(),

    // WHO decided. Preserve attribution → restrict, matching `expert_profiles.decided_by_user_id`.
    decidedByUserId: uuid('decided_by_user_id').references(() => users.id, {
      onDelete: 'restrict',
    }),

    decidedAt: timestamp('decided_at', { withTimezone: true }),

    // WHY, as a category — the archived `expert_profiles.decline_reason`.
    declineReason: expertDeclineReasonEnum('decline_reason'),

    /**
     * ⚠⚠ STAFF-ONLY FREE TEXT — the archived `expert_profiles.decline_note`, under the same
     * rules: NEVER serialised on any applicant-facing lens, page, Server Action result,
     * notification payload or audit row.
     *
     *  1. THE ONE CARRIER. `expertApplicationDecisionsRepository.listForStaffReview` is the only
     *     read in this package that projects it, and `/admin/applications/[profileId]/page.tsx`
     *     is its only caller.
     *  2. THE RENDER GATE. That page passes the note on only when the viewer holds
     *     `REVIEW_EXPERT_APPLICATIONS`, exactly as it does for the current decision's note.
     *  3. THE AUDIT ROW. `expert_application.reopened` records the archived row's id, never the
     *     note.
     *
     * ⚠ ERASURE. This column is a SECOND carrier of staff-authored text about the applicant
     * (after `expert_profiles.decline_note`). A personal-data erasure path must scrub it, as it
     * must scrub the names held in `audit_events`.
     */
    declineNote: text('decline_note'),

    // When the decided application was submitted — the archived `expert_profiles.submitted_at`.
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    /**
     * The staff review read (`listForStaffReview`: one profile, newest first). NOT partial: it
     * also serves the `restrict` FK's delete-time scan, which ignores `deleted_at`.
     */
    index('expert_application_decisions_profile_idx').on(t.expertProfileId, t.createdAt),

    /** The `restrict` FK's delete-time scan on `users`. */
    index('expert_application_decisions_decided_by_idx').on(t.decidedByUserId),
  ]
);

export type ExpertApplicationDecision = typeof expertApplicationDecisions.$inferSelect;
export type NewExpertApplicationDecision = typeof expertApplicationDecisions.$inferInsert;
