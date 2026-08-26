import {
  pgTable,
  uuid,
  integer,
  boolean,
  text,
  timestamp,
  index,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { creditWallets } from './credit-wallets';
import { creditHolds } from './credit-holds';
import { companies } from './companies';
import { engagements } from './engagements';
import { expertProfiles } from './experts';
import { meetings } from './meetings';
import { users } from './users';
import {
  creditSessionStatusEnum,
  creditSettlementStatusEnum,
  creditDurationSourceEnum,
  creditFinalizationPathEnum,
  creditSettlementShapeEnum,
} from './enums';
import { timestamps, softDelete } from './helpers';

/**
 * credit_sessions (BAL-378 / ADR-1040 Lane 2) — the CREDIT ENVELOPE of a per-minute
 * consultation (NOT the video room / full Case object, which are future Booking work).
 * A row owns the full money lifecycle of a Case: pre-connect funds-or-mandate gate + hold
 * → per-minute `session_consume` metering → grace state machine (30 min OR company
 * ceiling) → end → single session-keyed overdraft settlement → an expert-earned accrual
 * recorded INDEPENDENT of settlement (the "expert-always-paid" guarantee).
 *
 * `credit_sessions.id` is the value FK-resolved into `credit_ledger.session_id` and
 * `credit_holds.session_id` (both nullable, wired in this same migration).
 *
 * Mutable (status transitions), so `...timestamps` + `...softDelete` per convention —
 * though the terminal state is `status` (ended/cancelled), deletion is rare.
 *
 * NO RLS (ADR-1040 Decision 4, matching credit_wallets/ledger/holds): the fee/PII
 * boundary is enforced at the PROJECTION layer (`toClientSessionView` /
 * `deriveDrawdownState`) + invariant tests, NOT RLS. A client-bound read MUST exclude
 * `expertRate*`, `baloFeeBps`, `expertAccruedMinor`, `stripePaymentIntentId`.
 */
export const creditSessions = pgTable(
  'credit_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    // RESTRICT on every FK — never orphan a money row (the wallet only dies via its
    // company CASCADE, which the app never does while a session exists).
    walletId: uuid('wallet_id')
      .notNull()
      .references(() => creditWallets.id, { onDelete: 'restrict' }),

    // Denormalised capability scope + notification fan-out subject. `companies` has NO
    // `deleted_at` (memory `reference_companies_table_no_deleted_at`), so RESTRICT.
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    // The expert — accrual subject + display.
    expertProfileId: uuid('expert_profile_id')
      .notNull()
      .references(() => expertProfiles.id, { onDelete: 'restrict' }),

    // The acting member — attribution on every session_consume / overdraft_settlement
    // ledger row (satisfies the `applyLedgerEntry` memberId dev-guard) + the accrual audit.
    initiatingMemberId: uuid('initiating_member_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),

    // The pre-connect reservation (set at `open`; released at `end`/`cancel`). Nullable.
    // The `: AnyPgColumn` return annotation on the thunk is Drizzle's documented fix for a
    // MUTUAL FK cycle — credit_holds.sessionId also points at credit_sessions.id, and an
    // un-annotated inline reference on both sides makes TypeScript infer the two table types
    // circularly (TS7022). Annotating the thunk return breaks that without changing the SQL.
    holdId: uuid('hold_id').references((): AnyPgColumn => creditHolds.id, { onDelete: 'restrict' }),

    status: creditSessionStatusEnum('status').notNull().default('pending'),
    settlementStatus: creditSettlementStatusEnum('settlement_status')
      .notNull()
      .default('not_required'),

    // Duration provenance (BAL-399) — set at open; immutable. `live_capture` (default) =
    // wall-clock metering auto-finalizes at hang-up; `external` = the session parks awaiting
    // an outside-tool duration settled later via BAL-133; `presence` (BAL-412) = metered live
    // exactly like `live_capture`, but the TERMINAL figure is fixed from `meeting_presence`
    // with the ADR-1044 §7 floor. Fee-safe (client-viewable).
    //
    // ⚠ BAL-466 wires it: `joinMeetingAsMember` passes `durationSource: 'presence'` to
    // `creditSessionsRepository.open` when the first CLIENT-side member is admitted to a
    // `case` meeting, so every settlement path below is now reachable in production.
    durationSource: creditDurationSourceEnum('duration_source').notNull().default('live_capture'),

    // ── Snapshots (immutable for the life of the session; economics never drift) ──
    // Sizes the hold (estimated MAX cost).
    estimatedMinutes: integer('estimated_minutes').notNull(),
    // Raw expert quote snapshot (reconciliation/audit). NEVER on a client view.
    expertRateMinorPerHour: integer('expert_rate_minor_per_hour').notNull(),
    // Fee snapshot (BAL-357 pattern; audience-keyed). NEVER on a client view.
    // ⚠ THIS COLUMN IS THE SSOT FOR A CASE'S MARGIN (BAL-417 / D3) — it is the fee
    // actually charged. `engagements.balo_fee_bps` also exists on the supertype but is
    // NEVER charged on a case; that column is meaningful only for
    // project/retainer/package engagements and is CONSTRAINED NULL on every case row
    // (`engagement_balo_fee_bps_case_null`), so there is no second, credible-but-wrong
    // case margin left for a raw read to pick up.
    // ⚠ BAL-417 rested that argument partly on "no engagement↔credit_session join
    // exists". `engagement_id` below MAKES ONE, so `engagement_balo_fee_bps_case_null`
    // is now the WHOLE of the protection against a reporting join reading a fabricated
    // case margin. Do not relax it.
    baloFeeBps: integer('balo_fee_bps').notNull().default(2500),
    // MARKED-UP per-minute charge — drives drawdown + the widget "A$rate/min".
    clientRateMinorPerMinute: integer('client_rate_minor_per_minute').notNull(),
    // RAW per-minute — drives the expert accrual. NEVER on a client view.
    expertRateMinorPerMinute: integer('expert_rate_minor_per_minute').notNull(),
    // `wallet.overdraftCeilingMinor ?? DEFAULT_OVERDRAFT_CEILING_MINOR` snapshot.
    effectiveCeilingMinor: integer('effective_ceiling_minor').notNull(),
    // `OVERDRAFT_GRACE_MINUTES` snapshot.
    graceBoundMinutes: integer('grace_bound_minutes').notNull().default(30),

    // ── Metering state ──
    // Drawdown clock origin (metering anchor). Null until `connect`.
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    // Highest whole-minute metered (idempotency resume anchor).
    lastTickSeq: integer('last_tick_seq').notNull().default(0),
    // Charged minutes (= lastTickSeq while active/grace). ⚠ ON A PRESENCE-SETTLED SESSION
    // THIS HOLDS THE **FLOORED** FIGURE, not the delivered one — `actual_minutes` below
    // holds the pre-floor number.
    connectedMinutes: integer('connected_minutes').notNull().default(0),
    // Expert accrual = the SETTLED billable minutes × `expertRateMinorPerMinute`, finalized at
    // `end` (live_capture / external) or at presence settlement, INDEPENDENT of the PAYMENT
    // OUTCOME. NEVER on a client view (raw expert economics).
    //
    // ⚠⚠ ADR-1044 §7 (AMENDING ADR-1040 §8): THE INVARIANT IS **"EXPERT PAID FOR TIME MADE
    // AVAILABLE, WITH A 15-MINUTE FLOOR WHEN PRESENT"** — NOT "expert always paid actual
    // minutes". The old phrasing stood here and IS NOW FALSE. "When present" is load-bearing:
    // a missed call (the expert never joined) accrues NOTHING, and so does an abandoned wait
    // (the expert left below the floor with no client ever present, decision D2). On a
    // presence-settled session `connected_minutes` holds the FLOORED figure and
    // `actual_minutes` holds the pre-floor one, so the two are deliberately different numbers.
    // Pinned by `packages/db/src/invariants/expert-paid-for-time-made-available.test.ts` —
    // do not restore the old phrasing.
    expertAccruedMinor: integer('expert_accrued_minor').notNull().default(0),

    // ── One-shot markers (set once, the first time their condition holds) ──
    lowWarnedAt: timestamp('low_warned_at', { withTimezone: true }),
    graceEnteredAt: timestamp('grace_entered_at', { withTimezone: true }),
    nearWrapWarnedAt: timestamp('near_wrap_warned_at', { withTimezone: true }),
    wrappedAt: timestamp('wrapped_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    settledAt: timestamp('settled_at', { withTimezone: true }),

    // Terminal negative-balance magnitude at `end` (the settlement basis; promo excluded
    // by construction). Null until ended.
    overdraftSettledMinor: integer('overdraft_settled_minor'),

    // ── Billing finalization markers (BAL-399) — the single pending-vs-finalized signal ──
    // `billingFinalizedAt` NULL ⇒ pending receipt (the money block shows elapsed only, no
    // figures); stamped ONCE when the money block finalizes. `finalizationPath` records which
    // path finalized it (live_capture / confirmed / disputed / auto_confirmed). Both fee-safe.
    billingFinalizedAt: timestamp('billing_finalized_at', { withTimezone: true }),
    finalizationPath: creditFinalizationPathEnum('finalization_path'),

    // ── BAL-412 (ADR-1044 §7) — the presence settlement's provenance record ──
    //
    // ⚠ PLACED HERE, WITH THE FINALIZATION MARKERS, RATHER THAN IN THE "Snapshots" BLOCK
    // ABOVE. All three are written ONCE, at settlement, by the same UPDATE that stamps
    // `billing_finalized_at` — they are finalization outputs, not open-time snapshots, and
    // that block's header ("immutable for the life of the session") would be false of them.
    //
    // All three are NULLABLE WITH NO DEFAULT AND NO BACKFILL, deliberately: every row written
    // before migration 0071 carries NULL on all three, and every mapper reads them with a
    // legacy-safe fallback, so shipped rows change behaviour not at all.
    /**
     * Minutes ACTUALLY delivered — the D4-clamped expert-present clock, ceil'd, PRE-floor.
     * NULL for any session not settled from presence.
     *
     * ⚠⚠ WITHOUT THIS COLUMN THE ACTUAL FIGURE IS UNRECOVERABLE. Settlement OVERWRITES
     * `connected_minutes` with the FLOORED number, so "6 min delivered, billed at the
     * 15-minute minimum" could never be rendered afterwards and a floored charge would stay
     * indistinguishable from a genuine 15-minute call.
     *
     * FEE-SAFE: a DURATION, never a figure — it appears identically on all three lenses
     * (client / expert / admin). The split is not fee-concealed; only figures are.
     */
    actualMinutes: integer('actual_minutes'),
    /**
     * The billing floor IN FORCE at settlement, in whole minutes. Snapshotted for the same
     * reason every other economic figure here is: the floor is env-overridable per deployment
     * (`MEETING_NO_SHOW_FLOOR_MINUTES`, read in `apps/api` alone), so a later render must not
     * re-derive it from today's config. NULL when never presence-settled. Fee-safe.
     */
    billingFloorMinutes: integer('billing_floor_minutes'),
    /**
     * How the presence settlement resolved (decisions D2 / D3). NULL when never
     * presence-settled.
     *
     * ⚠ IT IS NOT REDUNDANT WITH `meetings.outcome`: `abandoned_wait` has NO outcome label —
     * BAL-412 mints no fourth `meeting_outcome` value, so it lands as `completed` with a zero
     * settlement — and `missed_call` is ALSO a zero settlement. The two zero shapes are
     * indistinguishable on the meeting row and distinguishable ONLY here.
     */
    settlementShape: creditSettlementShapeEnum('settlement_shape'),
    /**
     * BAL-412 (F14) — did the BILLING FLOOR fix `connected_minutes`? NULL when never
     * presence-settled.
     *
     * ⚠⚠ IT EXISTS BECAUSE THE ANSWER IS **NOT** RE-DERIVABLE FROM THE OTHER COLUMNS. The
     * obvious derivation, `connected_minutes > actual_minutes`, is WRONG on the Q1 no-refund
     * clamp: `connected_minutes` is post-clamp, so a session that drew 10 minutes on a 6-minute
     * presence span with a 6-minute rule reads as "floored" when no floor was involved at all.
     * The pure core (`resolveMeetingSettlement`) answers `ruleMinutes > actual_minutes`, and
     * `rule_minutes` is not persisted — this boolean IS that answer, snapshotted at settlement.
     *
     * Two readers depend on it being the real answer: `credit_session.presence_settled` (the
     * ONLY durable forensic record of a Q1 overcharge — mislabelling a clamp as a floor
     * application destroys the evidence) and the `case_billing_finalized` `floored:` property
     * (D7's "how often does the minimum bind" metric, which a clamp would inflate).
     *
     * FEE-SAFE: a boolean ABOUT a duration rule, never a figure. Not added to the client-lens
     * projections regardless — nothing client-bound reads it, and the money block derives its
     * own display predicate.
     */
    floorApplied: boolean('floor_applied'),

    // Settlement PaymentIntent (reconciliation; NEVER client-facing).
    stripePaymentIntentId: text('stripe_payment_intent_id'),

    // ── BAL-418 / ADR-1045 §3 — the meeting link + the denormalised engagement ──
    //
    // THEIR NULLABILITY IS INDEPENDENT — all four combinations are legal, which is why
    // there is NO CHECK of any shape between them:
    //   · both set        — the ordinary booked Case consultation.
    //   · engagement only — `duration_source='external'` (BAL-399/BAL-133): a real
    //     consultation on an OUTSIDE tool, with an engagement and NO Balo meeting.
    //   · both NULL       — every session written today (the live `openSession` service
    //     passes neither), so a NOT NULL or an "at least one" CHECK would break it.
    //   · meeting only    — a meeting whose only context is `project_discovery`
    //     (`context_id` is a `project_requests.id`, NOT an engagement) or `admin`.
    //     Forbidding it would decide a product question this ticket does not own.
    // BAL-401's `company_id` already carries the capability scope, so neither column is
    // load-bearing for authorization.
    //
    // ⚠ INDEPENDENT NULLABILITY IS NOT INDEPENDENT VALUES. When BOTH are set, NOTHING
    // checks that `engagement_id` is the engagement reachable via `meeting_id` →
    // `meeting_contexts.context_id` — and the two are read by DIFFERENT consumers. Money
    // and reporting read `engagement_id` directly; BAL-425's inactivity sweep
    // (`meetingContextsRepository.consultationTimestampsForEngagements`) resolves through
    // the seam instead. A divergent pair therefore bills one engagement and ages out
    // another, silently, with no row anywhere that looks wrong.
    //
    // THAT COHERENCE CANNOT BE A DB CONSTRAINT, for the same reason `meeting_contexts`
    // cannot require ≥1 context row:
    //   · a CHECK cannot contain a subquery, and the other side of the predicate lives in
    //     another table;
    //   · the composite-FK trick that pins the engagement subtypes (`engagement_id_type_uq`,
    //     BAL-417) does NOT transfer. Its semantics would fit — a composite FK is MATCH
    //     SIMPLE, so a NULL on either side satisfies it and only the both-set case is
    //     checked — but the TARGET cannot exist: it would need a UNIQUE constraint on
    //     `meeting_contexts(meeting_id, context_id)`, and that table's uniqueness is
    //     deliberately PARTIAL on `deleted_at IS NULL` (Postgres FKs cannot target a partial
    //     index), on the TRIPLE (D3 multi-context allows several engagement-bearing rows per
    //     meeting), over a POLYMORPHIC `context_id` that carries no FK of its own. Making it
    //     non-partial to serve as an FK target re-introduces the documented
    //     `reference_softdelete_nonpartial_unique_recreate` failure on detach→re-attach;
    //   · a trigger would work, and this repository has none, in any migration, by choice.
    //
    // SO IT IS ENFORCED AT THE SINGLE WRITE PATH — and the write path is genuinely single:
    // `creditSessionsRepository.open()` is the ONLY statement that ever sets either column
    // (no UPDATE anywhere touches them; they are write-once, inside the wallet lock).
    // OBLIGATION, CARRIED BY **BAL-400** (booking — the first caller that will pass both),
    // with **BAL-129** (provisioning) supplying the meeting: resolve the engagement ONCE and
    // derive `meeting_id`, `company_id` and `expert_profile_id` from THAT resolution. Never
    // accept two independently-supplied ids, and never re-resolve per column. **BAL-412**
    // (settlement) and every reporting reader consume `engagement_id` AS GIVEN and must not
    // re-derive it through the seam — that would hide a divergence rather than catch it.
    // The gap is pinned by the divergence test in credit-sessions.integration.test.ts.
    //
    // RESTRICT on both — never orphan a money row (the rule at the top of this file).
    meetingId: uuid('meeting_id').references(() => meetings.id, { onDelete: 'restrict' }),
    // DENORMALISED DELIBERATELY (ADR-1045 §3): the money and reporting paths query this
    // constantly and must not pay session → meeting → context → engagement.
    engagementId: uuid('engagement_id').references(() => engagements.id, {
      onDelete: 'restrict',
    }),

    ...timestamps,
    ...softDelete,
  },
  (t) => [
    index('credit_sessions_wallet_idx').on(t.walletId),
    index('credit_sessions_company_idx').on(t.companyId),
    // The reaper's hot path — meter only active/grace sessions. Partial on enum literals +
    // `deleted_at IS NULL` is SAFE (the `credit_holds_wallet_active_idx` precedent).
    index('credit_sessions_meter_idx')
      .on(t.status)
      .where(sql`${t.status} IN ('active', 'grace') AND ${t.deletedAt} IS NULL`),
    // Reconciliation of stuck settlements (findStuckSettling). Partial on the enum literal +
    // `deleted_at IS NULL` (matches the meter index above; a settling row is never soft-deleted,
    // so this is index-tidiness rather than a correctness fix — the `open` guard filters
    // `deleted_at` anyway).
    index('credit_sessions_settling_idx')
      .on(t.settlementStatus)
      .where(sql`${t.settlementStatus} = 'processing' AND ${t.deletedAt} IS NULL`),
    check('credit_sessions_estimated_minutes_pos', sql`${t.estimatedMinutes} > 0`),
    check('credit_sessions_expert_hourly_pos', sql`${t.expertRateMinorPerHour} > 0`),
    check('credit_sessions_client_minute_pos', sql`${t.clientRateMinorPerMinute} > 0`),
    check('credit_sessions_expert_minute_pos', sql`${t.expertRateMinorPerMinute} > 0`),
    check('credit_sessions_ceiling_nonneg', sql`${t.effectiveCeilingMinor} >= 0`),
    check(
      'credit_sessions_balo_fee_bps_range',
      sql`${t.baloFeeBps} >= 0 AND ${t.baloFeeBps} <= 10000`
    ),
    check(
      'credit_sessions_overdraft_settled_nonneg',
      sql`${t.overdraftSettledMinor} IS NULL OR ${t.overdraftSettledMinor} >= 0`
    ),
    // BAL-425: "last completed consultation" for a meeting. Covering (meeting_id, ended_at).
    index('credit_sessions_meeting_idx')
      .on(t.meetingId, t.endedAt)
      .where(sql`${t.meetingId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index('credit_sessions_engagement_idx')
      .on(t.engagementId)
      .where(sql`${t.engagementId} IS NOT NULL AND ${t.deletedAt} IS NULL`),

    // ── BAL-412 (ADR-1044 §7) ────────────────────────────────────────────────
    check(
      'credit_sessions_actual_minutes_nonneg',
      sql`${t.actualMinutes} IS NULL OR ${t.actualMinutes} >= 0`
    ),
    check(
      'credit_sessions_billing_floor_minutes_nonneg',
      sql`${t.billingFloorMinutes} IS NULL OR ${t.billingFloorMinutes} >= 0`
    ),
    /**
     * The durability backstop's finder index — `findPresenceUnsettled`: `presence` sessions
     * whose meeting has ended but which never settled (the terminal path is best-effort, so
     * a crash between `emitMeetingEnded` and settlement strands exactly this shape, and
     * `findFinalizedMissingPayout` cannot see it — that finder keys on
     * `billing_finalized_at IS NOT NULL`, i.e. the opposite half of the space).
     *
     * ⚠⚠ `duration_source` IS A **KEY COLUMN**, NOT PART OF THE PREDICATE, AND THAT IS
     * NOT A STYLE CHOICE — THE PREDICATE FORM IS UNRUNNABLE. `'presence'` reaches
     * `credit_duration_source` through `ALTER TYPE … ADD VALUE` (migration 0071), and
     * Postgres forbids USING a new enum label in the transaction that added it. It is not
     * enough to put the index in a LATER migration file either: drizzle-orm's migrator wraps
     * the ENTIRE pending set in ONE transaction (`pg-core/dialect.js` → `migrate`), so on a
     * from-scratch run — which is exactly what CI's Testcontainers harness and any fresh
     * deploy do — every migration shares one transaction with the `ADD VALUE`. A predicate
     * `WHERE duration_source = 'presence'` would raise `unsafe use of new value "presence"`
     * and take the whole migration set down with it. Hence the house rule recorded on
     * `enums.ts`: an ADD-VALUE label appears in NO index predicate and NO CHECK.
     *
     * THE KEY-COLUMN FORM IS NOT A WEAKER INDEX — IT IS A STRICTLY MORE USEFUL ONE. The
     * finder's `WHERE duration_source = 'presence' AND billing_finalized_at IS NULL AND
     * deleted_at IS NULL` still matches: the two `IS NULL` tests IMPLY the predicate (so the
     * partial index is usable) and `duration_source = 'presence'` becomes an index scan key
     * on the leading column. `meeting_id` rides second so the join to `meetings` is served
     * from the index. Enum literals at QUERY time are always safe.
     *
     * ⚠ `deleted_at IS NULL` IS IN THE PREDICATE AND MUST STAY (the shipped soft-delete
     * convention — memory `reference_softdelete_nonpartial_unique_recreate`). It is also
     * what keeps the index small: an unsettled row is a transient state, so the index holds
     * a handful of rows on a live database rather than every session ever billed.
     */
    index('credit_sessions_presence_unsettled_idx')
      .on(t.durationSource, t.meetingId)
      .where(sql`${t.billingFinalizedAt} IS NULL AND ${t.deletedAt} IS NULL`),
  ]
);

// ── Relations ──────────────────────────────────────────────────────────

export const creditSessionsRelations = relations(creditSessions, ({ one }) => ({
  wallet: one(creditWallets, {
    fields: [creditSessions.walletId],
    references: [creditWallets.id],
  }),
  company: one(companies, {
    fields: [creditSessions.companyId],
    references: [companies.id],
  }),
  expertProfile: one(expertProfiles, {
    fields: [creditSessions.expertProfileId],
    references: [expertProfiles.id],
  }),
  initiatingMember: one(users, {
    fields: [creditSessions.initiatingMemberId],
    references: [users.id],
  }),
  hold: one(creditHolds, {
    fields: [creditSessions.holdId],
    references: [creditHolds.id],
  }),
  // BAL-418 — the meeting this session billed, and its denormalised engagement.
  meeting: one(meetings, {
    fields: [creditSessions.meetingId],
    references: [meetings.id],
  }),
  engagement: one(engagements, {
    fields: [creditSessions.engagementId],
    references: [engagements.id],
  }),
}));

// ── Type exports ───────────────────────────────────────────────────────

export type CreditSession = typeof creditSessions.$inferSelect;
export type NewCreditSession = typeof creditSessions.$inferInsert;

/** Session lifecycle status (schema-derived — single source of truth). */
export type CreditSessionStatus = (typeof creditSessionStatusEnum.enumValues)[number];
/** Settlement outcome status (schema-derived — single source of truth). */
export type CreditSettlementStatus = (typeof creditSettlementStatusEnum.enumValues)[number];
/** How a session's billable duration is established (schema-derived). */
export type CreditDurationSource = (typeof creditDurationSourceEnum.enumValues)[number];
/** Which path produced the finalized billing figure (schema-derived). */
export type CreditFinalizationPath = (typeof creditFinalizationPathEnum.enumValues)[number];
/** BAL-412 — how a presence settlement resolved (schema-derived, four shapes). */
export type CreditSettlementShape = (typeof creditSettlementShapeEnum.enumValues)[number];
