import { pgTable, uuid, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { meetingContextTypeEnum } from './enums';
import { meetings } from './meetings';
import { timestamps, softDelete } from './helpers';

/**
 * meeting_contexts (BAL-418 / ADR-1045 §2) — THE POLYMORPHIC SEAM. It is the ONLY place
 * that answers "what is this meeting FOR", which is exactly why `meetings` carries no
 * context column. Structurally parallel to the `conversation_contexts` table BAL-424 will
 * build (ADR-1045's 2026-08-03 amendment: "the seam is how ANY cross-cutting primitive
 * attaches to a context") — copy this shape, do not invent a second one.
 *
 * EVERY meeting has ≥1 row here, including an `admin` meeting (whose row carries
 * `context_type='admin', context_id = NULL`). Rejected the alternative "admin = zero rows"
 * because it makes "admin meeting" / "context row soft-deleted" / "bug" three states that
 * look identical to every reader, and it leaves the `admin` enum label dead.
 *
 * "≥1 context row" CANNOT be a DB constraint (it needs a deferrable constraint or a
 * trigger — out of scope). It is enforced at the SINGLE write path:
 * `meetingsRepository.create` takes a required non-empty `contexts` array and throws
 * `MeetingContextRequiredError` on an empty one, inside the same transaction as the
 * `meetings` insert.
 *
 * NO RLS (matching `meetings` and the credit/transcript precedents): the boundary is the
 * application layer.
 *
 * ⚠⚠ TENANCY OBLIGATION — THE ONE THING THIS SEAM CANNOT ENFORCE FOR ITSELF.
 *
 * `context_id` has NO FOREIGN KEY (it is polymorphic — it targets `engagements.id` OR
 * `project_requests.id`). That makes it UNLIKE every other id column in this schema: a
 * uuid belonging to ANOTHER TENANT does not fail, it **succeeds silently**. There is no
 * `23503` to catch the mistake, and there is no RLS behind it.
 *
 * Two concrete consequences, both reachable from a single unchecked `contextId`:
 *   1. READ — `meetingContextsRepository.listMeetingsForContext('case', <victim's
 *      engagement id>)` returns another tenant's meetings, INCLUDING `join_url` and
 *      `daily_room_name`, which are call-JOIN CREDENTIALS.
 *   2. WRITE — `attach({ contextType: 'case', contextId: <victim's engagement id> })`
 *      forges a context row that feeds `consultationTimestampsForEngagements`; one future
 *      `scheduled_start` makes `isCaseInactive` return false and holds the victim's case
 *      open for as long as that forged `scheduled_start` stays in the future — renewable at
 *      will by forging another, without the attacker ever touching a row they own.
 *   3. CALENDAR (BAL-428, the newest and most directly abusable). `context_id` is now what
 *      the consultation projection resolves an EXPERT from
 *      (`_shared/consultation-projection.ts`), so an unchecked id books time on a STRANGER'S
 *      CALENDAR. `meetingsRepository.create` with `contextId = <victim expert's engagement
 *      id>` writes a `confirmed` `consultations` row against that expert, and the
 *      availability resolver then subtracts it from their open windows — a denial-of-service
 *      on a marketplace expert's bookability, repeatable until their calendar reads as
 *      fully booked, by an attacker who owns none of the rows involved. The projection is
 *      deliberately NOT a place to fix this: it resolves the expert exactly as the seam
 *      says to, and a gate inside a repository would be the deviation (ADR-1029).
 *
 * THEREFORE: every caller of `meetingsRepository.create`, `meetingContextsRepository.attach`
 * / `listByMeeting` / `listMeetingsForContext` / `consultationTimestampsForEngagements`
 * MUST first resolve the context's OWNING PARTY (engagement → `company_id` /
 * `expert_profile_id`; project request → `company_id`) and check `hasCapability` against it
 * before passing `contextId` in. That check belongs in the service / server-action layer,
 * NOT here — authorization is capability-based and resolved at the call site (ADR-1029),
 * and a gate inside a repository would be the deviation, not the fix.
 *
 * ✅ DISCHARGED FOR BOOKING BY **BAL-129**, WHICH IS NOW THE WORKING PRECEDENT — read it
 * before writing the next one. `apps/api/src/services/meetings/authorize-meeting-booking.ts`
 * is this obligation in code for `meetingsRepository.create`: it resolves the owning party per
 * context label (engagement → `company_id`; project request → `company_id`), checks
 * `hasCapability`-equivalent `PARTICIPATE` on the MEMBERSHIP axis against THAT company, runs
 * the membership check BEFORE any coherence check so the gate is not a cross-tenant existence
 * oracle, and collapses "no such row" and "not your company" into ONE `404` literal. It also
 * threads the resolved `expert_profile_id` back, so the caller's aggregate bounds (availability
 * validation + rate limiting, `routes/meetings/index.ts`) act on the same expert the
 * projection will resolve. Consequence 3 above is closed for `POST /meetings` and for nothing
 * else.
 *
 * STILL CARRIED BY:
 * **BAL-409/BAL-410/BAL-411** (reschedule + cancel — these take a bare `meeting_id` rather
 * than a `context_id`, so their check is "who owns THIS MEETING", resolved through this
 * seam; see `apps/api/src/services/meetings/meeting-availability.ts`),
 * **BAL-421** (the case surface — the first caller of `listMeetingsForContext`), and
 * **BAL-425/BAL-420** (the inactivity sweep — the first caller of
 * `consultationTimestampsForEngagements`, which must pass only engagement ids it already
 * scoped).
 *
 * ── BAL-424 HAS NOW COPIED THIS SHAPE, AND DISCHARGED THE OBLIGATION ──────────────────
 * `conversation_contexts` (`schema/conversations.ts`) is the second cross-cutting primitive
 * on this seam. The tenancy obligation transferred VERBATIM and is STRICTLY WORSE there: a
 * cross-tenant `context_id` on a conversation is direct MESSAGE DISCLOSURE, not merely join
 * credentials or calendar exposure. It is discharged at the service / server-action layer by
 * two gates, both following BAL-129's ordering rule (authorization before any coherence or
 * state check; every denial collapsed into ONE literal; the distinguishing shape to the log
 * only):
 *   · `apps/web/src/lib/conversations/authorize-conversation-context.ts` — the ENGAGEMENT arm;
 *   · `apps/web/src/lib/project-request/resolve-conversation-access.ts` — the RELATIONSHIP
 *     arm (it resolves the owning company through the request graph).
 *
 * ⚠ THREE DELIBERATE DEVIATIONS, recorded so the two seams do not read as accidental
 * divergence — each is argued in full on `conversation_contexts` itself: (1) NO `admin`
 * context type, therefore (2) its `context_id` is `NOT NULL`, with no biconditional CHECK
 * and no admin-only partial unique, and (3) it is unique on `(context_type, context_id)`
 * ALONE — 1:1, not this table's 1:N triple — because "two threads for one case" is the state
 * that seam exists to make unrepresentable. A fourth difference is in the LABELS: they name
 * the ANCHOR TABLE (`relationship`, `engagement`), never a purpose, because a conversation
 * has no purpose axis.
 */
export const meetingContexts = pgTable(
  'meeting_contexts',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    meetingId: uuid('meeting_id')
      .notNull()
      .references(() => meetings.id, { onDelete: 'cascade' }),

    contextType: meetingContextTypeEnum('context_type').notNull(),

    // POLYMORPHIC — NO FK BY DESIGN: it targets `engagements.id` OR `project_requests.id`
    // depending on `context_type` (see `meetingContextTypeEnum`'s docblock for the map).
    // NULL iff `context_type = 'admin'` (the biconditional CHECK below).
    contextId: uuid('context_id'),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    // MULTI-CONTEXT (decision D3). Unique on the TRIPLE, never on `meeting_id` alone: a
    // discovery call anchored to a `project_requests.id` gains a SECOND row for the
    // engagement at kickoff, so BAL-425's "this engagement's meetings" read finds it.
    // PARTIAL on deleted_at — memory `reference_softdelete_nonpartial_unique_recreate`.
    uniqueIndex('meeting_context_unique_idx')
      .on(t.meetingId, t.contextType, t.contextId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Postgres treats NULLs as DISTINCT in a unique index, so the triple above does NOT
    // stop two `admin` rows on one meeting. This closes it. The predicate uses
    // `context_id` (never an enum literal — the house rule at `action-items.ts` /
    // `transcripts.ts`); by the biconditional CHECK below,
    // `context_id IS NULL` ⟺ `context_type = 'admin'`, so this IS the admin guard.
    uniqueIndex('meeting_context_admin_uq')
      .on(t.meetingId)
      .where(sql`${t.contextId} IS NULL AND ${t.deletedAt} IS NULL`),
    // THE BAL-425 REVERSE READ: "every meeting for this context".
    index('meeting_context_reverse_idx')
      .on(t.contextType, t.contextId)
      .where(sql`${t.deletedAt} IS NULL`),
    index('meeting_context_meeting_idx').on(t.meetingId),
    // NO THREE-VALUED-LOGIC HOLE (same proof as `engagement_balo_fee_bps_case_null`):
    //   LHS `context_id IS NULL` — IS NULL is total, never yields NULL.
    //   RHS `context_type = 'admin'` — context_type is NOT NULL and 'admin' is a literal
    //   ⇒ never NULL.
    // boolean = boolean over two non-NULL operands ⇒ TRUE or FALSE. It can never "pass by
    // being unknown".
    check(
      'meeting_context_admin_no_id',
      sql`(${t.contextId} IS NULL) = (${t.contextType} = 'admin')`
    ),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const meetingContextsRelations = relations(meetingContexts, ({ one }) => ({
  meeting: one(meetings, {
    fields: [meetingContexts.meetingId],
    references: [meetings.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type MeetingContext = typeof meetingContexts.$inferSelect;
export type NewMeetingContext = typeof meetingContexts.$inferInsert;

/** What a meeting is FOR (schema-derived — single source of truth). */
export type MeetingContextType = (typeof meetingContextTypeEnum.enumValues)[number];
