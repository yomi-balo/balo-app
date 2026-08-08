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
 */
export const creditDurationSourceEnum = pgEnum('credit_duration_source', [
  'live_capture',
  'external',
]);

/**
 * Which path produced the finalized billing figure (recap-facing). No column default —
 * the writer states it: `live_capture` (wall-clock hang-up), `confirmed` / `disputed` /
 * `auto_confirmed` (the external BAL-133 duration-settlement paths).
 */
export const creditFinalizationPathEnum = pgEnum('credit_finalization_path', [
  'live_capture',
  'confirmed',
  'disputed',
  'auto_confirmed',
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
 * BAL-134 owns the transition map and will need `cancelled` as a terminal state when it
 * lands.
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
