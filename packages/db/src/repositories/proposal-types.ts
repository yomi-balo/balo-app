import type { Proposal, ProposalChangeRequest, ProposalDocument, Engagement } from '../schema';

/**
 * Shared enum-value types for the A6 proposal/engagement repos, derived from the
 * inferred schema column types so they stay in lock-step with the pgEnum
 * definitions (single source of truth). Kept in a tiny standalone module so the
 * proposal repos can share them without importing each other.
 */
export type PricingMethod = Proposal['pricingMethod'];
export type ProposalCadence = NonNullable<Proposal['cadence']>;
export type ProposalChangeSection = ProposalChangeRequest['section'];
export type ProposalDocumentKind = ProposalDocument['kind'];
export type EngagementStatus = Engagement['status'];
