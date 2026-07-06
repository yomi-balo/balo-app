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
