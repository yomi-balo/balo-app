import { pgEnum } from 'drizzle-orm/pg-core';

export const userModeEnum = pgEnum('user_mode', ['client', 'expert']);
export const userStatusEnum = pgEnum('user_status', ['active', 'inactive', 'suspended']);
export const companyRoleEnum = pgEnum('company_role', ['owner', 'admin', 'member']);
export const agencyRoleEnum = pgEnum('agency_role', ['owner', 'admin', 'expert']);
export const expertTypeEnum = pgEnum('expert_type', ['freelancer', 'agency']);
export const platformRoleEnum = pgEnum('platform_role', ['user', 'admin', 'super_admin']);
export const signupIntentEnum = pgEnum('signup_intent', ['client', 'expert']);

export const languageProficiencyEnum = pgEnum('language_proficiency', [
  'beginner',
  'intermediate',
  'advanced',
  'native',
]);

export const applicationStatusEnum = pgEnum('application_status', [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
]);

export const consultationStatusEnum = pgEnum('consultation_status', ['confirmed', 'cancelled']);

export const projectRequestStatusEnum = pgEnum('project_request_status', [
  'draft',
  'requested',
  'exploratory_meeting_requested',
  'experts_invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'kickoff_approved',
]);
export const projectRequestSourceEnum = pgEnum('project_request_source', [
  'manual',
  'ai',
  'quickstart',
]);
export const projectRequestSendToEnum = pgEnum('project_request_send_to', ['direct', 'match']);

/**
 * Per-expert relationship status (request_expert_relationships). One row per
 * (request, expert), born at admin invite. Linear advance with a terminal
 * `declined` branch. The request-level status is the max-progress aggregate
 * across all relationships (see project-requests / request-origination).
 */
export const requestExpertRelationshipStatusEnum = pgEnum('request_expert_relationship_status', [
  'invited',
  'eoi_submitted',
  'proposal_requested',
  'proposal_submitted',
  'accepted',
  'declined',
]);

/**
 * Proposal lifecycle (A6 / BAL-287). The original minimal set
 * (`submitted`/`accepted`/`withdrawn`) plus three APPENDED values for the full
 * project-proposal model: `draft` (composer save-before-submit, written by A6.2),
 * `changes_requested` (client asked for revisions), and `resubmitted` (the OLD
 * version stamp when an expert submits a new version — the new version is a fresh
 * `submitted` row). Postgres can only APPEND enum values, so the three new labels
 * trail the originals; ordering carries no semantics (the transition map in
 * `repositories/proposals.ts` is the source of truth for legal moves).
 */
export const proposalStatusEnum = pgEnum('proposal_status', [
  'submitted',
  'accepted',
  'withdrawn',
  'draft',
  'changes_requested',
  'resubmitted',
]);

// ── A6 proposal model (BAL-287) ──────────────────────────────────────────

/**
 * Pricing method for a proposal / engagement. `fixed` = an agreed total split
 * into payment installments; `tm` = a deposit + billed-against-time at a rate.
 */
export const pricingMethodEnum = pgEnum('pricing_method', ['fixed', 'tm']);

/** T&M invoice cadence. */
export const proposalCadenceEnum = pgEnum('proposal_cadence', ['monthly', 'fortnightly']);

/** Section a client change-request targets (the composer ChangesModal select). */
export const proposalChangeSectionEnum = pgEnum('proposal_change_section', [
  'general',
  'milestones',
  'pricing',
  'payment_terms',
  'timeline',
]);

/**
 * Proposal-scoped attachment kind: a terms supplement (the expert's additional
 * terms document) vs a reference / supporting doc.
 */
export const proposalDocumentKindEnum = pgEnum('proposal_document_kind', ['terms', 'ref']);

/**
 * Engagement product type — the supertype discriminator (BAL-417 / ADR-1045 §1).
 * `engagements` is a SUPERTYPE; the concrete shape lives in a 1:1 child table keyed
 * on `engagement_id`. `project` → `project_engagements`, `case` → `case_engagements`.
 * `package` and `retainer` are DECLARED-BUT-UNBUILT: no child table, no writer, no
 * reader. They exist so the seam is visible and so adding one later is a new table,
 * NOT an ALTER TYPE (which would re-open the ADD-VALUE one-tx hazard).
 *
 * Standalone CREATE TYPE → every label is usable as a DEFAULT / CHECK / index
 * predicate literal in the SAME migration (no ADD-VALUE hazard).
 */
export const engagementTypeEnum = pgEnum('engagement_type', [
  'case',
  'project',
  'package',
  'retainer',
]);

/**
 * SUPERTYPE engagement lifecycle (BAL-417). Reduced from four labels to three:
 * `pending_acceptance` was a PROJECT sub-state and moved to
 * `project_delivery_status` on `project_engagements`.
 *
 * These three are the coarse, TYPE-AGNOSTIC states every engagement product
 * shares: `active` (the engagement exists and is not terminal), `completed`,
 * `cancelled`.
 *
 * ⚠ `active` HERE DOES NOT MEAN "MUTABLE". For a project, mutability is
 * `project_engagements.delivery_status = 'active'` — a project awaiting client
 * acceptance is `active` on this column and MUST NOT accept milestone writes.
 * `lockActiveEngagement` performs that second check; never re-derive it from this
 * column alone.
 *
 * ⚠ SHRINKING this enum required a hand-written DROP TYPE / CREATE TYPE block in
 * migration 0055 (drizzle's generated block omits the DROP DEFAULT / SET DEFAULT
 * pair and fails on an EMPTY database). See 0055's header comment.
 */
export const engagementStatusEnum = pgEnum('engagement_status', [
  'active',
  'completed',
  'cancelled',
]);

/**
 * PROJECT delivery lifecycle (BAL-330, relocated to `project_engagements` by
 * BAL-417). This is the FINE-GRAINED SSOT for a project's state; the supertype's
 * `engagement_status` is its COARSE PROJECTION (`active|pending_acceptance` →
 * `active`; `completed` → `completed`; `cancelled` → `cancelled`), written by the
 * same transaction via `projectDeliveryToEngagementStatus`.
 *
 * ⚠ The coarse projection is NOT sufficient for "may this engagement be mutated?".
 * `lockActiveEngagement` reads THIS column for a project (see
 * repositories/_shared/engagement-lock.ts) — a project in `pending_acceptance` is
 * `active` on the parent but is NOT mutable.
 *
 * The four labels are deliberately IDENTICAL to the pre-BAL-417
 * `engagement_status` labels so `PROJECT_DELIVERY_TRANSITIONS` and every delivery
 * surface's status switch survive the split as a FIELD-SOURCE change, not a
 * semantics change.
 */
export const projectDeliveryStatusEnum = pgEnum('project_delivery_status', [
  'active',
  'pending_acceptance',
  'completed',
  'cancelled',
]);

/**
 * Why a case was closed (BAL-417). `resolved` = a client-side member closed it
 * deliberately (`closed_by_user_id` NOT NULL). `auto_inactive` = the BAL-420
 * inactivity sweep closed it (`closed_by_user_id` NULL — no human actor; the
 * ADR-1030 system-actor attribution exemption, same ruling as BAL-387).
 * Enforced by CHECK `case_engagement_close_coherent`.
 */
export const caseCloseReasonEnum = pgEnum('case_close_reason', ['resolved', 'auto_inactive']);

/**
 * Delivery milestone lifecycle (BAL-330). Standalone `CREATE TYPE` — all values
 * commit atomically with the type, so `DEFAULT 'pending'` is safe in the same
 * migration (no ADD-VALUE one-tx hazard).
 */
export const engagementMilestoneStatusEnum = pgEnum('engagement_milestone_status', [
  'pending',
  'in_progress',
  'completed',
]);

/**
 * How an engagement's completion was accepted: by the `client`, or by the D7
 * auto-accept sweep (`auto`). NULL until the engagement reaches `completed`.
 */
export const engagementAcceptanceMethodEnum = pgEnum('engagement_acceptance_method', [
  'client',
  'auto',
]);

// ── Domain auto-join (BAL-344 / ADR-1031) ────────────────────────────────

/**
 * Party kind a domain mapping points at. Polymorphic target for
 * `party_domains.party_id` — `company` is the only value written this ticket;
 * `agency` is reserved (capture is party-agnostic) for a future agency-creation
 * seam.
 */
export const partyTypeEnum = pgEnum('party_type', ['company', 'agency']);

/**
 * How a `party_domains` row was created. `auto_captured` = derived from a
 * creator's verified corporate email at party creation; `admin_added` = manual
 * admin path (future). No column default — every writer states it explicitly.
 */
export const partyDomainSourceEnum = pgEnum('party_domain_source', [
  'auto_captured',
  'admin_added',
]);

// ── Domain auto-join match engine (BAL-345 / ADR-1031) ───────────────────

/**
 * How a party (company/agency) admits users whose verified email domain matches
 * a `party_domains` row. `auto` = create the membership immediately; `request` =
 * file a pending `party_join_requests` row an admin approves; `off` = do nothing.
 * Standalone `CREATE TYPE` — all values commit atomically with the type, so using
 * a value as a column DEFAULT in the same migration is safe.
 */
export const domainJoinModeEnum = pgEnum('domain_join_mode', ['auto', 'request', 'off']);

/**
 * Who is authoritative over a party's membership. `balo` = Balo's own join engine
 * governs membership (the only value the v1 engine acts on); `directory` = an
 * external directory (SCIM/SSO) owns membership and the engine stands down.
 */
export const membershipAuthorityEnum = pgEnum('membership_authority', ['balo', 'directory']);

/**
 * How a membership row (company_members / agency_members) originated.
 * `personal_workspace` = the auto-created workspace at signup (the ONLY existing
 * writer today); `invite` = future explicit invitation acceptance; `domain_match`
 * = BAL-345 auto-join OR an approved join request; `owner` = future founding owner
 * of a non-personal org. Standalone `CREATE TYPE` → safe as a column DEFAULT in
 * the same migration.
 */
export const joinMethodEnum = pgEnum('join_method', [
  'personal_workspace',
  'invite',
  'domain_match',
  'owner',
]);

/**
 * Lifecycle of a `party_join_requests` row. `pending` is the only non-terminal
 * status; `approved`/`declined`/`withdrawn` are terminal. Standalone `CREATE TYPE`
 * → the value `'pending'` is safe as a column DEFAULT and as a partial-index
 * predicate literal in the same migration. Ordering carries no semantics — the
 * transition map in `repositories/party-join-requests.ts` is the source of truth.
 */
export const partyJoinRequestStatusEnum = pgEnum('party_join_request_status', [
  'pending',
  'approved',
  'declined',
  'withdrawn',
]);

// ── Client Credit System (BAL-376 / ADR-1040) ────────────────────────────
//
// All FIVE enums below are standalone `CREATE TYPE`s (never `ALTER TYPE ... ADD
// VALUE`), so every value commits atomically with the type. Using a value as a
// column DEFAULT (`'notify_only'`, `'active'`) or as a partial-index predicate
// literal (`credit_holds` active-holds index) is SAFE in the SAME migration — the
// enum-default-same-txn hazard (memory `reference_enum_default_same_tx_migration_hazard`)
// applies ONLY to ADD-VALUE, which none of these are (plan Decision 5).

/**
 * A wallet's behaviour when its balance crosses the low-balance threshold.
 * `auto_topup` = reload off the stored mandate; `keep_going` = allow overdraft
 * grace, no reload; `notify_only` = neither (the safe default — a brand-new wallet
 * has no card/mandate and therefore cannot auto-top-up).
 */
export const lowBalanceModeEnum = pgEnum('low_balance_mode', [
  'auto_topup',
  'keep_going',
  'notify_only',
]);

/**
 * The coarse ledger bucket. `entry_type` is the category; `reason` (below) is the
 * granular sub-type. Both are stated explicitly by the driver — no column default.
 */
export const creditEntryTypeEnum = pgEnum('credit_entry_type', [
  'purchase',
  'consume',
  'refund',
  'expiry',
  'adjustment',
]);

/**
 * The granular ledger "why" (full set per ADR-1040, incl. promo). Maps onto
 * `credit_entry_type` (documented in the reason→entry_type table in the plan):
 * manual_purchase/auto_topup/overdraft_settlement → purchase; session_consume →
 * consume; dormancy_expiry → expiry; promo/adjustment → adjustment. Only
 * session_consume + overdraft_settlement write a member-attributed audit row.
 */
export const creditLedgerReasonEnum = pgEnum('credit_ledger_reason', [
  'manual_purchase',
  'auto_topup',
  'overdraft_settlement',
  'session_consume',
  'dormancy_expiry',
  'promo',
  'adjustment',
]);

/**
 * Hold (reservation) lifecycle. `active` (default) reserves available balance;
 * `settled`/`released` are terminal. Standalone `CREATE TYPE` → the `'active'`
 * literal is safe in the `credit_holds` partial-index predicate.
 */
export const creditHoldStatusEnum = pgEnum('credit_hold_status', ['active', 'settled', 'released']);

/**
 * FX display-quote currencies (presentation only). NEVER referenced by any
 * balance/settlement path — display rates are last-write-wins per pair and never
 * enter balance math (invariant #8).
 */
export const fxDisplayQuoteEnum = pgEnum('fx_display_quote', ['GBP', 'EUR', 'USD']);

// ── Promo codes (BAL-384 / ADR-1042) ──────────────────────────────────────

/**
 * Promo-code admin lifecycle (BAL-384). ONLY the admin-controlled state:
 * `active` (mintable/redeemable, subject to window + cap) vs `deactivated`
 * (admin turned it off). `expired` / `exhausted` / `scheduled` are DERIVED at
 * read time from valid_until / redeemed_count / valid_from — never stored (a
 * stored `expired` would need a sweep job, out of scope, and duplicate
 * valid_until). Standalone CREATE TYPE → the `default('active')` in the same
 * migration is SAFE (the enum-default-same-txn hazard applies ONLY to ALTER TYPE
 * ADD VALUE, memory reference_enum_default_same_tx_migration_hazard).
 */
export const promoCodeStatusEnum = pgEnum('promo_code_status', ['active', 'deactivated']);

// ── Stripe provider layer (BAL-382) ──────────────────────────────────────

/**
 * Off-session mandate lifecycle (BAL-382 / Decision B). Standalone `CREATE TYPE`, but
 * the column that uses it (`credit_wallets.mandate_status`) is NULLABLE with NO default,
 * so no enum literal ever appears inside a `DEFAULT` in the same migration txn as the
 * `CREATE TYPE` — this deliberately sidesteps the enum-default-same-txn migration hazard
 * (memory `reference_enum_default_same_tx_migration_hazard`), so no `::text::enum` cast
 * fix is needed. Lifecycle: `null` (no mandate ever attempted) → `pending` (createSetupIntent)
 * → `active` (setup_intent.succeeded) or `failed` (setup_intent.setup_failed);
 * `requires_action` is reserved for a future SCA-during-setup surface. Ordering carries no
 * semantics.
 */
export const mandateStatusEnum = pgEnum('mandate_status', [
  'pending',
  'active',
  'requires_action',
  'failed',
]);

// ── Session consume & overdraft (BAL-378 / ADR-1040 Lane 2) ────────────────
//
// All FOUR enums below are standalone `CREATE TYPE`s (never `ALTER TYPE ... ADD
// VALUE`), so every value commits atomically with the type. Using a value as a
// column DEFAULT (`'pending'`, `'not_required'`, `'open'`) or as a partial-index
// predicate literal (`credit_sessions` meter/settling indexes; `credit_receivables`
// company-open index) is SAFE in the SAME migration — the enum-default-same-txn
// hazard (memory `reference_enum_default_same_tx_migration_hazard`) applies ONLY to
// ADD-VALUE, which none of these are (plan §4 / Decision 5).

/**
 * The credit-session (billing envelope) lifecycle. Default `pending` (opened + hold
 * placed, not yet connected). `active` = metering; `grace` = card-backed overdraft
 * after the balance hit zero WITH a mandate; `wrapped` = the ONE warm pause (ceiling
 * hit, 30-min grace bound, or no-mandate balance-used); `ended` = terminated (→ settle);
 * `cancelled` = a pending session that never connected. Ordering carries no semantics —
 * `repositories/credit-sessions.ts` holds the legal-transition source of truth.
 */
export const creditSessionStatusEnum = pgEnum('credit_session_status', [
  'pending',
  'active',
  'grace',
  'wrapped',
  'ended',
  'cancelled',
]);

/**
 * Settlement outcome for a session's terminal overdraft. Default `not_required` (no
 * overdraft, or not yet ended). `processing` = an off-session charge is in flight;
 * `settled` = the overdraft credit landed (webhook); `failed` = hard decline / async
 * payment_failed (→ receivable + soft hold); `requires_action` = SCA could not complete
 * off-session (→ receivable, recovery). Set at `end` / by the settlement webhook.
 */
export const creditSettlementStatusEnum = pgEnum('credit_settlement_status', [
  'not_required',
  'processing',
  'settled',
  'failed',
  'requires_action',
]);

/**
 * Receivable lifecycle. Default `open` (an unrecovered overdraft; the company is
 * soft-held while ANY open receivable exists — derived, not a column). `cleared` = the
 * overdraft was later settled (webhook) or written down by ops; `written_off` = a future
 * ops write-off. Ordering carries no semantics.
 */
export const creditReceivableStatusEnum = pgEnum('credit_receivable_status', [
  'open',
  'cleared',
  'written_off',
]);

/**
 * Why a receivable was opened. No column default — the writer states it: a hard/async
 * decline (`settlement_declined`) vs an SCA that could not complete off-session
 * (`settlement_requires_action`, which carries a recoverable PaymentIntent).
 */
export const creditReceivableReasonEnum = pgEnum('credit_receivable_reason', [
  'settlement_declined',
  'settlement_requires_action',
]);

// ── Case consultation billing slice (BAL-399 / ADR-1043) ───────────────────
//
// All THREE enums below are standalone `CREATE TYPE`s (never `ALTER TYPE ... ADD
// VALUE`), so every value commits atomically with the type. Two of them are used as
// column DEFAULTs — `credit_duration_source` DEFAULT 'live_capture' (credit_sessions)
// and `expert_payout_record_status` DEFAULT 'recorded' (expert_payout_records). Per the
// BAL-399 plan directive, the generated migration hand-casts BOTH defaults
// `::text::<enum>` (memory `reference_enum_default_same_tx_migration_hazard`) as a
// defensive measure for the from-scratch single-transaction migration run. The cast is
// semantically identical to the bare literal, so it is a safe no-op even though — as the
// BAL-378 enums above note — the enum-default-same-txn hazard strictly applies only to
// ADD-VALUE. `credit_finalization_path` has NO column default (every writer states the
// path), so it needs no cast.

/**
 * How a session's billable duration is established.
 *  `live_capture` → wall-clock metering (BAL-378) finalizes at hang-up.
 *  `external`     → held on an outside tool / bot failed; duration settled later via BAL-133.
 *  `presence`     → BAL-412 (ADR-1044 §7): the session's FINAL billable duration is
 *                   established from `meeting_presence` at settlement, with the 15-minute
 *                   billing floor applied. **Metered live exactly like `live_capture`** —
 *                   `findMeterable` includes it and the per-minute tick loop runs, because
 *                   the in-call balance panel, the grace/ceiling state machine and the
 *                   one-shot low/near-wrap notices are all tick-driven. What differs is only
 *                   how the TERMINAL figure is fixed: `settleFromPresence` tops the ticks up
 *                   to the floored figure over the SAME tick-sequence idempotency scheme.
 *                   Set at `open`, immutable, like the other two.
 *
 * ⚠ BAL-412 ADDED `'presence'` VIA `ALTER TYPE … ADD VALUE` (migration 0071), so the label is
 * subject to the one-transaction hazard — and drizzle-orm's migrator runs **every pending
 * migration in ONE transaction** (`pg-core/dialect.js`'s `migrate`), so on a FROM-SCRATCH run
 * that is every migration file, not just 0071. THE LABEL THEREFORE APPEARS IN NO INDEX
 * PREDICATE AND NO CHECK, in 0071 or in any later migration. The
 * `credit_sessions_presence_unsettled_idx` partial index carries `duration_source` as a KEY
 * COLUMN with a `billing_finalized_at IS NULL AND deleted_at IS NULL` predicate for exactly
 * this reason — see that index's comment on `schema/credit-sessions.ts`. Enum literals at
 * QUERY time are always safe; the restriction is index predicates, CHECKs and column defaults.
 *
 * ⚠ NO COLUMN DEFAULT MOVES. `credit_sessions.duration_source` keeps `DEFAULT 'live_capture'`
 * (an OLD label), so the default-to-a-just-added-value hazard (memory
 * `reference_enum_default_same_tx_migration_hazard`) does not arise.
 */
export const creditDurationSourceEnum = pgEnum('credit_duration_source', [
  'live_capture',
  'external',
  'presence',
]);

/**
 * Which path produced the finalized billing figure (recap-facing). No column default —
 * the writer states it: `live_capture` (wall-clock hang-up), `confirmed` / `disputed` /
 * `auto_confirmed` (the external BAL-133 duration-settlement paths), `presence` (BAL-412's
 * `meeting_presence`-derived settlement with the ADR-1044 §7 floor).
 *
 * ⚠ `'presence'` IS ALSO AN `ADD VALUE` LABEL (migration 0071) — same rule as
 * `credit_duration_source` above: it appears in no index predicate, no CHECK and no default.
 * This type has never had a column default (every writer states the path), so the cast the
 * BAL-399 note below describes is not needed for it.
 */
export const creditFinalizationPathEnum = pgEnum('credit_finalization_path', [
  'live_capture',
  'confirmed',
  'disputed',
  'auto_confirmed',
  'presence',
]);

/**
 * BAL-412 (ADR-1044 §7) — HOW A PRESENCE SETTLEMENT RESOLVED. Four shapes, and they are NOT
 * redundant with `meeting_outcome`:
 *
 *   `held`           → both sides present. Outcome `completed`. Billed
 *                      `ceil(max(expert-present, floor))`.
 *   `no_show_client` → expert present ≥ the floor, no client-side participant EVER arrived.
 *                      Outcome `no_show_client`. Billed the floor **FLAT** — the floor is the
 *                      WHOLE charge, not a minimum: an expert who waits 40 minutes bills 15,
 *                      and accrues 15 (owner ruling, 2026-08-21). The expert's excess wait is
 *                      deliberately not billed to a client who never arrived.
 *   `missed_call`    → the expert never joined. Outcome `missed_call`. ZERO, hold released.
 *   `abandoned_wait` → the expert joined, waited, and left BELOW the floor with no client
 *                      ever present (decision D2). ZERO, hold released.
 *
 * ⚠⚠ THE LAST TWO ARE WHY THIS TYPE EXISTS. `meeting_outcome` has only three labels and
 * **BAL-412 mints no fourth** — an `abandoned_wait` therefore lands on the meeting row as
 * `completed` with a zero settlement, which is indistinguishable from a `missed_call` (also
 * zero) and from a genuine completed call on `meetings.outcome` alone. "Never joined" vs
 * "joined and gave up" survives settlement ONLY on `credit_sessions.settlement_shape`.
 *
 * Standalone `CREATE TYPE` (never `ALTER TYPE … ADD VALUE`), so every label commits
 * atomically WITH the type and the one-transaction hazard cannot apply. No column default —
 * the column is NULL for any session never settled from presence.
 */
export const creditSettlementShapeEnum = pgEnum('credit_settlement_shape', [
  'held',
  'no_show_client',
  'missed_call',
  'abandoned_wait',
]);

/**
 * Expert payout obligation lifecycle. `recorded` (default) = obligation booked (BAL-399).
 * `disbursing` / `paid` / `failed` are RESERVED for the future Airwallex payout-run
 * (BAL-202/203) — BAL-399 only ever writes `recorded`. Ordering carries no semantics.
 */
export const expertPayoutRecordStatusEnum = pgEnum('expert_payout_record_status', [
  'recorded',
  'disbursing',
  'paid',
  'failed',
]);

// ── Action items — first-class model (BAL-391 / ADR-1043) ──────────────────
//
// All THREE enums below are standalone `CREATE TYPE`s (never `ALTER TYPE ... ADD
// VALUE`), so every value commits atomically with the type. Using a value as a
// column DEFAULT (`'open'`) in the SAME migration is SAFE — the enum-default-same-txn
// hazard (memory `reference_enum_default_same_tx_migration_hazard`) applies ONLY to
// ADD-VALUE, which none of these are.

/** BAL-391 (ADR-1043) — action-item status. Standalone CREATE TYPE → default('open') safe. */
export const actionItemStatusEnum = pgEnum('action_item_status', ['open', 'done']);

/** BAL-391 — how the item was produced. 'ai_extracted' = pipeline (BAL-387); 'manual' = user add. */
export const actionItemSourceEnum = pgEnum('action_item_source', ['ai_extracted', 'manual']);

/**
 * BAL-391 — which SIDE of the engagement owns the item. null column value = unassigned.
 * Maps 1:1 to the engagement's concrete companyId (client) / expertProfileId (expert).
 */
export const actionItemAssigneePartyEnum = pgEnum('action_item_assignee_party', [
  'client',
  'expert',
]);

// ── Transcript pipeline (BAL-387 / ADR-1013 + ADR-1043) ────────────────────
//
// All THREE enums below are standalone `CREATE TYPE`s (never `ALTER TYPE ... ADD
// VALUE`), so every value commits atomically with the type. The ONLY value used as a
// column DEFAULT is `transcript_status` `'processing'` (on `transcripts.status`), which
// is SAFE in the SAME migration — the enum-default-same-txn hazard (memory
// `reference_enum_default_same_tx_migration_hazard`) applies ONLY to ADD-VALUE, which
// none of these are. NONE appears in an index predicate — every transcript partial index
// predicates on `deleted_at`/`meeting_id` only (the ADD-VALUE house rule).

/**
 * BAL-387 — the capture vendor a transcript was normalized FROM. `daily_deepgram` =
 * Balo Video's native Daily+Deepgram capture (speaker attribution via authenticated
 * `user_id`); `recall` = a Recall bot at an external venue (name-diarization). No column
 * default — every writer states the vendor explicitly.
 */
export const transcriptVendorEnum = pgEnum('transcript_vendor', ['daily_deepgram', 'recall']);

/**
 * BAL-387 — coarse transcript lifecycle. Default `processing` (raw persisted, pipeline
 * stages still running); `ready` = recap published; `failed` = a stage exhausted its
 * retries. Ordering carries no semantics — the pipeline's stage gates are the source of
 * truth for progress.
 */
export const transcriptStatusEnum = pgEnum('transcript_status', ['processing', 'ready', 'failed']);

/**
 * BAL-387 — which LLM-derived artifact a `transcript_artifacts` row holds. `cleaned` =
 * disfluency/ASR-normalized full text; `summary` = the concise recap. Raw is artifact #1
 * (the `transcripts.canonical` jsonb), not a `transcript_artifacts` kind. No column
 * default — every writer states the kind explicitly.
 */
export const transcriptArtifactKindEnum = pgEnum('transcript_artifact_kind', [
  'cleaned',
  'summary',
]);

// ── Meetings primitive (BAL-418 / ADR-1045 §2/§3/§6 + ADR-1043 §1/§2) ──────
//
// All four enums below were created by 0056 as standalone `CREATE TYPE`s, so every label
// they were BORN with commits atomically with the type. Using such a label as a column
// DEFAULT (`meetings.status = 'scheduled'`) or inside a CHECK (`meeting_outcome_requires_ended`,
// `meeting_context_admin_no_id`) in the SAME migration is SAFE — the enum-default-same-txn
// hazard (memory `reference_enum_default_same_tx_migration_hazard`) applies ONLY to
// ADD-VALUE. NONE appears in an INDEX PREDICATE (the house rule at `action-items.ts` /
// `transcripts.ts`).
//
// ⚠ ONE EXCEPTION, ADDED BY BAL-428: `meeting_status` gained `'cancelled'` through a bare
// `ALTER TYPE … ADD VALUE` in migration 0059. That label is therefore subject to the
// one-transaction hazard, and 0059 obeys it — see `meetingStatusEnum` below.

/**
 * BAL-134's meeting lifecycle (BAL-418 creates it; BAL-134 owns the transitions).
 * scheduled → waiting_for_participants → in_progress → ended, plus the terminal
 * `cancelled` (BAL-428).
 * WHY THE END-REASON IS NOT HERE: `missed_call` / `no_show_client` are *why* a meeting
 * ended, not a lifecycle state — BAL-134's own `meeting_ended` analytic already
 * carries `outcome`. See `meetingOutcomeEnum`.
 *
 * ⚠ `'cancelled'` (BAL-428 decision, Option C) IS APPENDED LAST, DELIBERATELY, and its
 * position is load-bearing in two ways:
 *
 *   1. IT MUST STAY LAST. Migration 0059 emits a BARE `ALTER TYPE … ADD VALUE 'cancelled'`
 *      with NO `BEFORE`/`AFTER` clause. Inserting a future label before it — or reordering
 *      this array — makes the generated SQL disagree with the deployed type's sort order.
 *   2. THE LITERAL MUST NOT APPEAR ANYWHERE ELSE IN 0059. Postgres permits `ADD VALUE`
 *      inside a transaction but forbids USING the new label in that same transaction, and
 *      drizzle wraps each migration file in one. So 0059 adds the label and nothing else
 *      touches it: `meeting_outcome_requires_ended` is NOT rewritten, and NO CHECK
 *      constraining the cancel transition is added there.
 *
 * WHY A LABEL RATHER THAN A `cancelled_at` COLUMN (BAL-428 F3): a nullable timestamp would
 * leave a dead meeting sitting at `status='scheduled'`, forcing EVERY future status reader
 * to remember an extra predicate. With the label,
 * `consultationTimestampsForEngagements`'s `status IN ('scheduled',
 * 'waiting_for_participants')` filter and `meeting_status_scheduled_start_idx` exclude a
 * cancelled meeting with ZERO code change. `status='ended' + outcome='cancelled'` was
 * rejected too — it overloads `ended` and reaches into BAL-412/BAL-134 semantics.
 *
 * ⚠⚠ EVERY `ADD VALUE` ON THIS TYPE MUST SWEEP THE READERS THAT BRANCH ON A LABEL, NOT JUST
 * THE WRITERS. "Zero code change" above is true of the two FILTERS named there; it is NOT
 * true of code that enumerates states. The readers that had to be revisited for `cancelled`,
 * and that the next label must be checked against:
 *
 *   · `repositories/_shared/consultation-projection.ts` — `consultationStatusForMeeting`
 *     maps the lifecycle onto `confirmed | cancelled`. A new label defaults to `confirmed`
 *     (it BLOCKS the slot). Confirm that is right for the label, or add a case.
 *   · `repositories/meetings.ts` — `cancel()` and `updateSchedule()` both gate on an
 *     explicit status set. A new pre-terminal label almost certainly belongs in
 *     `updateSchedule`'s `inArray([...])`.
 *   · `repositories/meeting-presence.ts` — `resolveClockCeiling` treats ONLY `ended` as
 *     supplying a ceiling; every other status measures to the wall clock. Read its
 *     `'cancelled'` residual paragraph before adding a terminal label.
 *   · `repositories/meeting-contexts.ts` — `consultationTimestampsForEngagements` names
 *     `scheduled | waiting_for_participants` (upcoming) and `ended`+`completed` (delivered).
 *   · `repositories/_shared/consultation-count.ts` — the PUBLIC "sessions" stat, gated on
 *     `ended` + `outcome='completed'`.
 *
 * ── BAL-134 HAS LANDED: THE WRITERS THIS LIST MUST NOW ALSO SWEEP ─────────────────────
 *
 * BAL-134 owns the transition map, and `cancelled` is a terminal state to it. The four new
 * `meetingsRepository` methods each gate on an EXPLICIT status set, so a future label must
 * be checked against every one of them — none of them defaults a label into a bucket:
 *
 *   · `listLifecycleCandidates` — the sweep's candidate scan takes its `statuses` from the
 *     CALLER (`apps/api`'s lifecycle sweep passes the three non-terminal labels). A new
 *     PRE-TERMINAL label is therefore invisible to the sweep — and so unterminable — until
 *     that caller names it. Nothing here fails; the meeting simply never gets evaluated.
 *   · `markWaitingForParticipants` — CAS from `scheduled` only.
 *   · `markInProgress` — CAS from (`scheduled`, `waiting_for_participants`).
 *   · `endMeeting` — CAS from "NOT IN (`ended`, `cancelled`)", i.e. the ONE method written
 *     as an EXCLUSION rather than an inclusion. A new TERMINAL label must be added to that
 *     exclusion or `endMeeting` will happily re-end a meeting already in it.
 *
 * And the reader `resolveClockCeiling` (above) now genuinely reaches its `ended` + `ended_at`
 * branch for the first time, because `endMeeting` stamps `ended_at` in the SAME statement
 * that sets `status='ended'` — the residual that reader's docblock assigned to BAL-134.
 */
export const meetingStatusEnum = pgEnum('meeting_status', [
  'scheduled',
  'waiting_for_participants',
  'in_progress',
  'ended',
  'cancelled',
]);

/**
 * WHY a meeting ended. NULL unless `status = 'ended'` (CHECK `meeting_outcome_requires_ended`).
 * `completed` = it happened. `no_show_client` = expert present, no client-side participant ever
 * arrived (BAL-412 settles this). `missed_call` = the expert never joined (BAL-134, 2026-07-31).
 */
export const meetingOutcomeEnum = pgEnum('meeting_outcome', [
  'completed',
  'no_show_client',
  'missed_call',
]);

/**
 * BAL-134 / ADR-1049 — WHO ended the meeting. NULL unless `status = 'ended'` (CHECK
 * `meeting_ended_by_requires_ended`). ORTHOGONAL to `meeting_outcome`, which says WHY:
 * ADR-1049's four-path taxonomy (plus the fifth, "abandoned wait") crosses the two axes,
 * and neither derives from the other.
 *
 *   `client_principal` — a client-side holder pressed End (D6: the membership arm of
 *                        `canEndMeeting`, resolved through `CONSUME_CREDITS` on the booking
 *                        company — the party whose money is being spent may stop the spend).
 *   `expert_host`      — the delivering expert (or their agency owner/admin) pressed End
 *                        (D7: `hasEngagementCapability(HOST_MEETINGS)`, ADR-1046).
 *   `system_idle`      — NOBODY pressed anything. The lifecycle sweep terminated the meeting
 *                        under one of the four SYSTEM rules (idle end, no-show, missed call,
 *                        abandoned wait). ⚠ ONE LABEL FOR ALL FOUR, deliberately: which
 *                        system rule fired is carried by `outcome` (`completed` /
 *                        `no_show_client` / `missed_call` / NULL for an abandoned wait) and
 *                        by the analytics event, so splitting this axis would encode the
 *                        same fact twice and let the two disagree.
 *
 * ⚠ WHY THE HUMAN PATHS CARRY NO `outcome` (D5). ADR-1049: "the ender never sets the
 * outcome" — BAL-412 resolves it from `meeting_presence`. `meeting_outcome_requires_ended`
 * is ONE-DIRECTIONAL (`outcome ⇒ ended`), so `ended` + `outcome IS NULL` is legal and is
 * exactly what a human end writes. The three system-terminated paths ARE DEFINED BY their
 * outcome in ADR-1049's own table, so the sweep writes it.
 *
 * ⚠ NULLABLE, AND THAT IS NOT A GAP. Every meeting that has NOT ended has no ender, and a
 * meeting that ends is stamped in the SAME statement that sets `status='ended'`
 * (`meetingsRepository.endMeeting`) — so `ended` with a NULL `ended_by` is unreachable
 * through the write path, while remaining representable for the rows migration 0066 found
 * already `ended`. Making the column NOT NULL would have required inventing an ender for
 * those rows, which is the "attribution column with no writer is a worse lie than its
 * absence" failure in reverse: a FABRICATED actor is worse still.
 *
 * STANDALONE `CREATE TYPE` in migration 0066 (never `ALTER TYPE … ADD VALUE`), so every
 * label commits atomically with the type and naming one in a DEFAULT or a CHECK in that same
 * migration would be safe (memory `reference_enum_default_same_tx_migration_hazard` binds
 * ADD-VALUE only). 0066 needs neither: the column takes NO DEFAULT (it is meaningless before
 * an end) and `meeting_ended_by_requires_ended` names no `meeting_ended_by` label — it
 * references `status = 'ended'`, a `meeting_status` label created back in 0056. It appears
 * in NO index predicate (the house rule at `action-items.ts` / `transcripts.ts`).
 */
export const meetingEndedByEnum = pgEnum('meeting_ended_by', [
  'client_principal',
  'expert_host',
  'system_idle',
]);

/**
 * ADR-1045 §2 — what a meeting is FOR. `context_id` is polymorphic:
 *   case              → engagements.id  (case_engagements.engagement_id IS engagements.id —
 *                       the child PK is the parent's identity, so there is no ambiguity)
 *   project_discovery → project_requests.id  (a discovery call held BEFORE kickoff
 *                       materialises the engagement)
 *   project_kickoff / package_session / retainer_checkin → engagements.id
 *   admin             → NULL (no subject; CHECK `meeting_context_admin_no_id`)
 *   request_interaction → request_expert_relationships.id   (BAL-413 / ADR-1046 amendment
 *                       2026-08-07)
 * ADR-1045 §2 is the authoritative list (ADR-1043 §1 predates `retainer_checkin`).
 *
 * ⚠ THE TWO REQUEST-GRAIN LABELS ARE NOT INTERCHANGEABLE — this is the single most likely
 * future confusion, so it is written down rather than inferred:
 *   `project_discovery`   = the EXPLORATORY call (Balo admin triage), at REQUEST grain.
 *   `request_interaction` = CLIENT↔CANDIDATE calls, at RELATIONSHIP grain.
 * On a `direct`-routed request the two grains coincide and resolve to the same expert; on a
 * `match` request only `request_interaction` has a holder at all.
 *
 * ⚠ APPEND-ONLY. A label is added at the END of this array, never inserted mid-array — an
 * insert changes enum ordinals and makes drizzle recreate the type instead of emitting a
 * plain `ALTER TYPE … ADD VALUE`. See the runtime drift guard in
 * `src/invariants/meeting-context-type-labels.test.ts` for what an 8th label must sweep.
 */
export const meetingContextTypeEnum = pgEnum('meeting_context_type', [
  'case',
  'project_discovery',
  'project_kickoff',
  'package_session',
  'retainer_checkin',
  'admin',
  'request_interaction',
]);

/**
 * BAL-424 / ADR-1045 §2 — what a CONVERSATION is anchored to (schema/conversations.ts).
 *
 * STANDALONE `CREATE TYPE` in migration 0062, so every label it is BORN with commits
 * atomically with the type; naming one inside a CHECK in that same migration would be safe
 * (memory `reference_enum_default_same_tx_migration_hazard` binds only `ALTER TYPE … ADD
 * VALUE`). It appears in NO index predicate — the house rule at `action-items.ts` /
 * `transcripts.ts`.
 *
 *   `relationship` — `request_expert_relationships.id`. The pre-sales thread.
 *   `engagement`   — `engagements.id` (the ADR-1045 SUPERTYPE, so one label serves case,
 *                    project, package and retainer). The delivery thread.
 *
 * ⚠ THE LABELS NAME THE ANCHOR TABLE, NOT A PURPOSE — DELIBERATELY UNLIKE
 * `meeting_context_type`, whose seven labels name what a MEETING IS FOR
 * (`case`/`project_discovery`/`project_kickoff`/…). A conversation has no purpose axis: it
 * is one continuous thread between two parties, and the only question the seam answers is
 * "whose thread is this". Collapsing the four engagement-grain meeting labels into one
 * `engagement` label here is what makes kickoff carry-over a single row rather than four.
 *
 * ⚠ NO `admin` LABEL, AND `context_id` IS THEREFORE `NOT NULL` (scope decision 1,
 * 2026-08-10). `meeting_contexts` carries an `admin` label with a NULLABLE `context_id`, a
 * biconditional CHECK and a second admin-only partial unique. THIS SEAM INHERITS NONE OF
 * THAT APPARATUS. There is no admin chat and none is ticketed —
 * `resolve-conversation-access.ts` denies admin observers in writing ("A4 has no admin
 * chat"). Copying the label would put every admin thread in ONE `context_id = NULL` bucket
 * that cannot name its counterparty, and would leave a dead enum label. Add it when a real
 * admin-chat feature exists AND can say what it points at.
 *
 * ⚠ NO `direct` LABEL — deferred to BAL-255 (scope decision 2). Cold-profile messaging has
 * no producer and no actor today: the expert profile's booking card renders "Send a message
 * first" unconditionally, its CTAs route to a "Coming soon" toast, `/experts/` is a PUBLIC
 * route so the CTA renders to LOGGED-OUT visitors (no authenticated actor, no company to
 * gate `PARTICIPATE` against), and `/messages` is an unwired placeholder. Structurally,
 * `(company, expert_profile)` is a PAIR and `context_id` is ONE uuid — `direct` needs its
 * own anchor table, which is a real design that must land with its consumer. BAL-255 must
 * also first reconcile its own wrinkle: its ask is anchored to a QUICK START PACKAGE, a
 * fifth context, not the `(company, expert_profile)` pair. Recorded here so the gap is not
 * rediscovered as an oversight.
 *
 * ⚠ APPEND-ONLY, for the same reason `meeting_context_type` is: a label goes at the END of
 * this array, never mid-array — an insert changes ordinals and makes drizzle recreate the
 * type instead of emitting a plain `ALTER TYPE … ADD VALUE`.
 */
export const conversationContextTypeEnum = pgEnum('conversation_context_type', [
  'relationship',
  'engagement',
]);

/**
 * Which SIDE a presence interval belongs to (BAL-134's two clocks).
 * `observer` = a Balo staffer / silent attendee: present, but NEVER makes a meeting billable.
 * Declared now so a staff join does not later require an ALTER TYPE … ADD VALUE.
 */
export const meetingParticipantPartyEnum = pgEnum('meeting_participant_party', [
  'expert',
  'client',
  'observer',
]);

/**
 * BAL-420 / ADR-1047 Decision 4 — the lifecycle of ONE durable "publish this event later"
 * promise (`scheduled_notifications`).
 *
 *   pending   → the promise is live and will be claimed once `scheduled_for` passes.
 *   claimed   → a dispatch tick took it (the send-once gate). Reclaimable ONLY after the
 *               claim TTL, which is how a send that died mid-flight is reconciled.
 *   published → terminal, happy path: the event was handed to `publish()`.
 *   cancelled → terminal, driven internally by the code path that observes the
 *               condition-voiding fact. A `claimed` row is deliberately NOT cancellable.
 *   skipped   → terminal and NORMAL: the fire-time recheck said the notification is no
 *               longer warranted (`skip_reason`). NOT a failure.
 *   failed    → terminal FAILURE: attempts exhausted or an unregistered recheck name
 *               (`last_error`). Deliberately a different column from `skip_reason`.
 *
 * ⚠ `pending` and `claimed` APPEAR IN INDEX PREDICATES (see `scheduled-notifications.ts`),
 * a deliberate deviation from the `action-items.ts` / `transcripts.ts` house convention of
 * predicating on `deleted_at` alone. ADR Decision 4 requires it: without the
 * `status = 'pending'` half, the unique index would permit ONE notification per dedupe key
 * EVER, and a key could never be re-scheduled after it fires. The residual cost is bounded
 * and known: a future `ALTER TYPE … ADD VALUE` on this enum is still safe on its own, but
 * the new value may not be USED (in an index predicate, a default, or a data statement) in
 * the SAME migration transaction — split it across two migrations.
 */
export const scheduledNotificationStatusEnum = pgEnum('scheduled_notification_status', [
  'pending',
  'claimed',
  'published',
  'cancelled',
  'skipped',
  'failed',
]);

/**
 * What a second `schedule()` on a key that already has a LIVE pending row does.
 *
 *   first_wins      → the existing promise STANDS UNTOUCHED, keeping its original
 *                     `scheduled_for`, `payload`, `event` and `recheck`. The conservative
 *                     default.
 *   replace_pending → the new schedule SUPERSEDES all four.
 *
 * BOTH are expressed as `ON CONFLICT … DO UPDATE`, differing only in the `set`;
 * `first_wins`'s is the no-op self-assignment `updated_at = updated_at`. It is deliberately
 * NOT `DO NOTHING` — that returns zero rows on a conflict, so reporting `already_pending`
 * would need a second, racy query for the existing row. See the repository for the full
 * reasoning.
 *
 * BAL-420 ships BOTH and rules on NO window policy (ADR Decision 6) — a fixed window is
 * `first_wins`, a sliding debounce is `replace_pending`, and BAL-424 chooses. `mode` is
 * NOT used in any index predicate.
 *
 * ⚠ `replace_pending` is a SUPPRESSION primitive: a caller who can schedule key K can push
 * a pending Balo-facing alert arbitrarily far out. That is why scheduling is API-internal
 * only (ADR Decisions 10 and 11).
 */
export const scheduledNotificationModeEnum = pgEnum('scheduled_notification_mode', [
  'first_wins',
  'replace_pending',
]);

/**
 * BAL-390 — WHERE the review was captured.
 *   `end_of_call` — the in-app post-call control (BAL-389 mounts it; BAL-390 ships only
 *                   the pure resolver + the submit action + the reader).
 *   `recap`       — BAL-388's recap surface. DECLARED, NO PRODUCER: shipping the label
 *                   now means the recap capture path never needs an ALTER TYPE … ADD VALUE.
 *   `email`       — the magic-link landing form.
 */
export const reviewSurfaceEnum = pgEnum('review_surface', ['end_of_call', 'recap', 'email']);

/**
 * BAL-390 — HOW the writer authenticated.
 *   `session`    — an authenticated iron-session request.
 *   `magic_link` — a `review_invite_tokens` bearer.
 *
 * ORTHOGONAL to `review_surface`, and deliberately NOT called `source`: a column named
 * `source` sitting next to a column named `surface` reads as two columns answering the
 * same question. This is the axis a security reviewer reads ("show me every review
 * written via a magic link"), and it is NOT derivable from the surface in the general
 * case — a future emailed recap link would be `surface='recap'`, `auth_method='magic_link'`.
 *
 * WHY IT SHIPS NOW rather than later: pre-launch with no live data, ADDING this column
 * later would be nearly free — but the DATA IS NOT BACKFILLABLE. You cannot retroactively
 * determine how an existing review was authenticated. Both values occur in v1
 * (end-of-call ⇒ `session`, email landing form ⇒ `magic_link`), so it populates
 * meaningfully from day one, and `magic_link` is precisely the value an incident response
 * would query against, because that token arrives in an inbox. Deferring the column would
 * lose that signal permanently.
 *
 * Both new enums are standalone `CREATE TYPE` in migration 0058, so their literals would
 * be safe inside a CHECK in that same migration (the one-transaction hazard applies only
 * to `ALTER TYPE … ADD VALUE` — the ruling at `engagements.ts` and `case-engagements.ts`).
 * NEITHER APPEARS IN AN INDEX PREDICATE — house rule.
 */
export const reviewAuthMethodEnum = pgEnum('review_auth_method', ['session', 'magic_link']);

// ── BAL-408 / ADR-1044 — the guest participation model (schema/guests.ts) ──────────────
//
// ALL FOUR ENUMS BELOW ARE STANDALONE `CREATE TYPE`s IN MIGRATION 0061, so every label
// they are BORN with commits atomically with the type. Naming such a label inside a CHECK
// in that SAME migration is therefore SAFE — `meeting_guest_party_two_sided` and
// `meeting_guest_delegate_is_client_side` both do it, on the identical footing as
// `meeting_outcome_requires_ended` (0056). Memory
// `reference_enum_default_same_tx_migration_hazard` binds only `ALTER TYPE … ADD VALUE`,
// which 0061 performs on NO type. Any FUTURE label added to one of these inherits that
// prohibition: add it in one migration, use it in a default/CHECK in the next.
//
// NONE of the four appears in an INDEX PREDICATE (the house rule at `action-items.ts` /
// `transcripts.ts`) — the guest partial uniques predicate on `deleted_at` / `revoked_at`
// COLUMNS only.

/**
 * BAL-408 — guest vs delegate. A DELEGATE attends INSTEAD of the booker (replacement
 * semantics); a GUEST attends alongside.
 *
 * ⚠ EXPERT SUBSTITUTION IS OUT OF SCOPE AND IS MADE UNREPRESENTABLE, not merely
 * discouraged: `meeting_guest_delegate_is_client_side` refuses `participation_role =
 * 'delegate'` on the expert side at the DATABASE. An expert-side delegate IS substitution
 * by definition (the booker a delegate replaces is the client), so no future service
 * branch can reintroduce it by accident.
 *
 * NO `observer` / `co_host` LABEL. This axis answers "alongside or instead of", nothing
 * else — WHICH SIDE is `party`, and WHETHER THEY MAY HOST is ADR-1046's engagement axis,
 * which reads no participant table at all.
 */
export const meetingParticipationRoleEnum = pgEnum('meeting_participation_role', [
  'guest',
  'delegate',
]);

/**
 * BAL-408 / ADR-1044 — what a guest may READ afterwards.
 *
 *   `meeting`    — the safe default: this ONE meeting and its artefacts.
 *   `engagement` — the whole envelope, RETROSPECTIVELY (consultations held before the
 *                  guest was invited are included — that is the decision, and it is why
 *                  the invite UI carries an explicit disclosure sentence).
 *
 * ⚠ THE LABEL IS `engagement`, NOT `case`, DELIBERATELY. It names the ADR-1045 SUPERTYPE:
 * a guest on a `project_kickoff`, `package_session` or `retainer_checkin` meeting gets the
 * identical whole-envelope grant, and `case` is only one of four `engagement_type` values.
 * UI copy still renders "Whole case" when the engagement IS a case — a rendering concern,
 * not a schema one.
 *
 * ⚠ BAL-408 RECORDS THE GRANT; IT DOES NOT ENFORCE THE READ. The surfaces that would
 * enforce it do not exist for a guest yet (the recap is BAL-388; transcripts BAL-387 and
 * action items BAL-391 ship inert). The pure predicate BAL-388 must call is
 * `guestMayReadMeeting` in `@balo/shared/meetings`.
 */
export const guestAccessScopeEnum = pgEnum('guest_access_scope', ['meeting', 'engagement']);

/**
 * BAL-408 — HOW the guest reached the meeting.
 *   `email` ⇒ someone with rights named this address ⇒ trust-by-default (BAL-134).
 *   `link`  ⇒ the link was forwarded / shared ⇒ the waiting-to-join queue.
 * ORTHOGONAL to `admission`: the channel is the FACT, the admission is the DECISION.
 */
export const meetingGuestInviteChannelEnum = pgEnum('meeting_guest_invite_channel', [
  'email',
  'link',
]);

/**
 * BAL-408 — the admit/deny lifecycle.
 *   `pre_admitted` — an email-invited guest; no host decision is required or recorded.
 *   `pending`      — the waiting-to-join queue. ⚠ NO PRODUCER SHIPS IN BAL-408: the lobby
 *                    identity model (anonymous visitor → name capture, bot protection,
 *                    share-link proof) is BAL-132's design, so admit/deny ships INERT.
 *   `admitted` / `denied` — terminal. Both are stamped (`admission_decided_at`) and
 *                    attributed (`admitted_by_user_id`); `meeting_guest_admission_terminal_stamped`
 *                    makes an unstamped terminal state — and a stamped non-terminal one —
 *                    impossible.
 */
export const meetingGuestAdmissionEnum = pgEnum('meeting_guest_admission', [
  'pre_admitted',
  'pending',
  'admitted',
  'denied',
]);

// ── BAL-423 — meeting files (schema/meeting-files.ts) ──────────────────────────────────

/**
 * BAL-423 (D0) — WHICH IN-CALL ENTRY POINT produced a `meeting_files` row.
 *   `chat`      — the in-call chat paperclip.
 *   `files_tab` — the in-call Files tab drop-zone.
 * ONE store, TWO entry points. Between-call attachments are `conversation_files`, a
 * different table with a different anchor; BAL-421 merges the two on READ.
 *
 * Standalone `CREATE TYPE` in migration 0063, so every label it is BORN with commits
 * atomically with the type — naming one in a CHECK in that same migration would be safe
 * (`reference_enum_default_same_tx_migration_hazard` binds only ALTER TYPE … ADD VALUE).
 * It appears in NO index predicate — the action-items.ts / transcripts.ts house rule.
 * ⚠ APPEND-ONLY: a label goes at the END, never mid-array — an insert changes ordinals
 * and makes drizzle recreate the type instead of emitting a plain ALTER TYPE … ADD VALUE.
 */
export const meetingFileSourceEnum = pgEnum('meeting_file_source', ['chat', 'files_tab']);

// ── BAL-411 — expert-initiated reschedule proposals (schema/reschedule-proposals.ts) ────

/**
 * BAL-411 (§D1/§D3) — the lifecycle of ONE expert-initiated reschedule proposal.
 *
 *   pending   → live and answerable by the client until `expires_at`.
 *   accepted  → terminal: the client took one option and the meeting MOVED (the accept
 *               path's own `rescheduleMeeting` call is what actually moves it).
 *   declined  → terminal: the client kept the original time.
 *   withdrawn → terminal: the EXPERT pulled the proposal back before it was answered.
 *   expired   → terminal: the deadline passed unanswered.
 *
 * ⚠ `expired` IS PRODUCIBLE, NOT RESERVED, AND THAT IS THE WHOLE POINT. Expiry is
 * evaluated LAZILY (§D1) — no sweep, no bespoke job — so a lapsed proposal keeps
 * `status = 'pending'` in the row while reading as expired to
 * `deriveRescheduleProposalState`. The stored status is therefore a MONOTONE LOWER BOUND
 * on truth. That is safe everywhere except the "at most one pending proposal per meeting"
 * partial unique, whose predicate cannot mention `now()` (not IMMUTABLE); the gap is closed
 * at the WRITE path by `rescheduleProposalsRepository.expireStaleForMeeting`, which runs as
 * the first statement inside the propose transaction and is the only writer of this label.
 * A union member nothing can produce would be "coverage that does not exist"
 * (`packages/shared/src/engagements/case-surface.ts`); this one has a real writer.
 *
 * ⚠ `pending` APPEARS IN AN INDEX PREDICATE (`reschedule_proposal_one_pending_idx`), a
 * deliberate deviation from the `action-items.ts` / `transcripts.ts` house rule of
 * predicating on `deleted_at` alone, and the same deviation `scheduled_notifications` makes
 * for the same reason: without it the unique would permit ONE proposal per meeting EVER.
 * SAFE IN MIGRATION 0073 because this is a brand-new STANDALONE `CREATE TYPE` — every label
 * commits atomically with the type, so naming one in an index predicate in that same
 * migration is legal. The residual is the usual one (memory
 * `reference_enum_default_same_tx_migration_hazard`): a FUTURE label added by
 * `ALTER TYPE … ADD VALUE` may NOT be *used* in an index predicate, default, CHECK or data
 * statement in the same migration transaction — split it across two.
 * ⚠ APPEND-ONLY: a new label goes at the END, never mid-array.
 */
export const rescheduleProposalStatusEnum = pgEnum('reschedule_proposal_status', [
  'pending',
  'accepted',
  'declined',
  'withdrawn',
  'expired',
]);

// ── BAL-473 — meeting recordings (schema/meeting-recordings.ts) ─────────────────────────

/**
 * BAL-473 — the lifecycle of ONE recording SEGMENT of one meeting.
 *
 *   recording    → Daily is (believed to be) capturing. `capture_ended_at` IS NULL, and the
 *                  partial-unique `meeting_recording_capturing_idx` holds the meeting's ONE
 *                  capture slot while this label is set.
 *   source_ready → Daily finished and the source is downloadable. `recording-ingest` is owed.
 *   ingesting    → a Mux asset exists (`mux_asset_id` stamped); waiting on `video.asset.ready`.
 *   ready        → TERMINAL SUCCESS. `mux_playback_id` is stamped and the segment is playable.
 *   failed       → TERMINAL FAILURE. `failed_stage` + `failure_reason` say where and why.
 *
 * ⚠ A MEETING HAS 1:n SEGMENTS IN START ORDER (D2). Daily stops a cloud recording when the
 * room goes idle (`minIdleTimeOut`); a rejoin starts another. Segments are the truth, not a
 * defect to collapse.
 *
 * ⚠ `ready` IS NEVER OVERWRITTEN. `markFailed` compare-and-sets on `status <> 'ready'` — a
 * late vendor error must not un-publish a segment BAL-440 is already rendering.
 *
 * ⚠ APPEND-ONLY: a new label goes at the END, never mid-array. And a future NON-TERMINAL
 * capture label (e.g. a `paused`) MUST be added to `meeting_recording_capture_slot` in the
 * same change, or the capture-slot invariant silently stops meaning what it says.
 */
export const recordingStatusEnum = pgEnum('recording_status', [
  'recording',
  'source_ready',
  'ingesting',
  'ready',
  'failed',
]);

/**
 * BAL-433 (ADR-1044 amendment 2026-08-25, Ruling 1) — HOW ONE PARTY'S CALENDAR ENTRY WAS
 * DELIVERED, and the discriminator that makes "a provider write OR an ICS, NEVER BOTH" a
 * CONSTRAINT rather than a convention.
 *
 *  · `provider_event` — Balo wrote the event into a connected Google/Microsoft calendar
 *    through Apiroc. The row carries the connection, the calendar, the VENDOR-RETURNED event
 *    id and the tag.
 *  · `ics`            — no writable connection, so this party's entry is delivered as a
 *    Balo-organizer ICS instead. The row carries NONE of the four provider columns.
 *
 * ⚠ NOT `ics_fallback`. For the EXPERT party it is a fallback (Ruling 1); for the CLIENT
 * party (BAL-475) it is the only mode there will ever be — `calendar_connections` is keyed on
 * `expert_profile_id` and no client-side connection model exists anywhere in the repo.
 * ⚠ APPEND-ONLY: a new label goes at the END, never mid-array.
 */
export const meetingCalendarDeliveryModeEnum = pgEnum('meeting_calendar_delivery_mode', [
  'provider_event',
  'ics',
]);
