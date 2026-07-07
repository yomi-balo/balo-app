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
