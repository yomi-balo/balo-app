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
 * Engagement lifecycle. Greenfield seam — `active` is written in A6.5.
 * `pending_acceptance` (BAL-330 / delivery epic) is the mid-state after the expert
 * requests completion and before the client accepts; `completed`/`cancelled` are
 * terminal.
 *
 * `pending_acceptance` was APPENDED at the END (Postgres `ADD VALUE` is
 * append-only; drizzle-kit emits a bare `ALTER TYPE ... ADD VALUE`). Enum ORDERING
 * carries NO semantics — the transition map in `repositories/engagements.ts`
 * (`ENGAGEMENT_STATUS_TRANSITIONS`) is the single source of truth for legal moves.
 */
export const engagementStatusEnum = pgEnum('engagement_status', [
  'active',
  'completed',
  'cancelled',
  'pending_acceptance', // APPENDED (BAL-330) — never used as a default/CHECK/index predicate (§5 enum hazard)
]);

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
