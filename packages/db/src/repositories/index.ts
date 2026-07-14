export { usersRepository } from './users';
export { companiesRepository } from './companies';
export type {
  SetJoinModeResult,
  PromoteToOrganizationInput,
  PromoteToOrganizationResult,
} from './companies';
export { agenciesRepository, AgencyDomainCaptureConflictError } from './agencies';
export type {
  AgencySummary,
  JoinExistingInput,
  JoinExistingResult,
  ProvisionInput,
  ProvisionSoloInput,
  ProvisionResult,
  TransferOwnershipInput,
} from './agencies';
export { expertsRepository, isUniqueViolation } from './experts';
export type {
  ApplicationWithRelations,
  ApplicationCompetencyWithRelations,
  ApplicationCertWithRelations,
  ApplicationLanguageWithRelations,
  ApplicationIndustryWithRelations,
  ProfileSettingsData,
  PublicExpertProfile,
  ProfileStepWrite,
} from './experts';
export { referenceDataRepository } from './reference-data';
export { payoutsRepository } from './payouts';
export { companyBillingRepository, ensureClientBillingGateConfirmed } from './company-billing';
export type { CompanyBillingDetails, NewCompanyBillingDetails } from '../schema';
export type {
  ProductsByCategory,
  CertificationsByCategory,
  ProjectTagsByGroup,
} from './reference-data';
export { notificationLogRepository } from './notification-log';
export { userNotificationsRepository } from './user-notifications';
export { calendarRepository } from './calendar';
export { availabilityRulesRepository } from './availability-rules';
export { consultationsRepository } from './consultations';
export { projectRequestsRepository } from './project-requests';
export {
  STATUS_TRANSITIONS,
  isAllowedTransition,
  InvalidStatusTransitionError,
  InvalidKickoffStateError,
  type ProjectRequestStatus,
  type ProjectRequestWithRelations,
  type KickoffGate,
} from './project-requests';
export type { ProjectRequest, NewProjectRequest } from '../schema';
export { requestExpertRelationshipsRepository } from './request-expert-relationships';
export { expertReferralInvitesRepository } from './expert-referral-invites';
export {
  RELATIONSHIP_STATUS_TRANSITIONS,
  isAllowedRelationshipTransition,
  InvalidRelationshipTransitionError,
  type RelationshipStatus,
} from './request-expert-relationships';
export {
  deriveRequestStatus,
  RELATIONSHIP_TO_REQUEST_STATUS,
} from './_shared/derive-request-status';
export { expressionsOfInterestRepository } from './expressions-of-interest';
export { proposalsRepository } from './proposals';
export {
  PROPOSAL_STATUS_TRANSITIONS,
  isAllowedProposalTransition,
  InvalidProposalTransitionError,
  ProposalNotDraftError,
  type ProposalStatus,
} from './proposals';
export {
  assertProposalCoherent,
  assertEngagementTermsCoherent,
  ProposalCoherenceError,
  EngagementTermsCoherenceError,
} from './proposal-coherence';
export type {
  ProposalCoherenceRule,
  EngagementTermsCoherenceRule,
  ProposalCoherenceSnapshot,
  EngagementTermsSnapshot,
} from './proposal-coherence';
export { proposalMilestonesRepository } from './proposal-milestones';
export type { ProposalMilestoneInput } from './proposal-milestones';
export {
  proposalPaymentInstallmentsRepository,
  installmentsSumTo100,
} from './proposal-payment-installments';
export type { ProposalPaymentInstallmentInput } from './proposal-payment-installments';
export { proposalDocumentsRepository } from './proposal-documents';
export { proposalChangeRequestsRepository } from './proposal-change-requests';
export {
  engagementsRepository,
  KickoffGatesIncompleteError,
  ENGAGEMENT_STATUS_TRANSITIONS,
  isAllowedEngagementTransition,
  InvalidEngagementTransitionError,
  MilestonesIncompleteError,
  advanceEngagementStatus,
  AUTO_ACCEPT_DAYS,
  type EngagementWithMilestones,
  type EngagementWithProgress,
  type PortfolioEngagementView,
  type AdminEngagementListItem,
} from './engagements';
export {
  engagementMilestonesRepository,
  snapshotFromProposalTx,
  ENGAGEMENT_MILESTONE_STATUS_TRANSITIONS,
  isAllowedMilestoneTransition,
  InvalidMilestoneTransitionError,
  EngagementNotActiveError,
  MilestoneReorderMismatchError,
  type EngagementMilestoneStatus,
} from './engagement-milestones';
export type {
  PricingMethod,
  ProposalCadence,
  ProposalChangeSection,
  ProposalDocumentKind,
  EngagementStatus,
} from './proposal-types';
export { conversationsRepository } from './conversations';
export { projectsInboxRepository } from './projects-inbox';
export type { PortfolioRequestRow, PortfolioInvitationRow } from './projects-inbox';
export type {
  RequestExpertRelationship,
  NewRequestExpertRelationship,
  ExpressionOfInterest,
  NewExpressionOfInterest,
  Proposal,
  NewProposal,
  ProposalMilestone,
  NewProposalMilestone,
  ProposalPaymentInstallment,
  NewProposalPaymentInstallment,
  ProposalDocument,
  NewProposalDocument,
  ProposalChangeRequest,
  NewProposalChangeRequest,
  Engagement,
  NewEngagement,
  EngagementMilestone,
  NewEngagementMilestone,
  ConversationMessage,
  NewConversationMessage,
  ConversationFile,
  NewConversationFile,
  ExpertReferralInvite,
  NewExpertReferralInvite,
} from '../schema';
export { expertSearchRepository } from './expert-search';
export type {
  ExpertSearchParams,
  ExpertSearchRow,
  ExpertSearchCompetencyRow,
  FacetCount,
} from './expert-search';
export { partyDomainsRepository } from './party-domains';
export type {
  DomainCaptureResult,
  CaptureDomainInput,
  AddDomainInput,
  RemoveDomainInput,
  RemoveDomainResult,
  PartyDomainWithCreator,
} from './party-domains';
export { auditEventsRepository } from './audit-events';
export type { RecordAuditInput } from './audit-events';
export { partyMembershipsRepository } from './party-memberships';
export type {
  DomainMembershipInput,
  FindOrCreateMembershipResult,
  SoftRemoveMembershipResult,
  PartyJoinSettings,
} from './party-memberships';
export {
  partyJoinRequestsRepository,
  PARTY_JOIN_REQUEST_STATUS_TRANSITIONS,
  isAllowedJoinRequestTransition,
  InvalidJoinRequestTransitionError,
  advanceJoinRequestStatus,
} from './party-join-requests';
export type {
  FindOrCreatePendingResult,
  CreatePendingInput,
  ResolveRequestInput,
  PendingJoinRequestRow,
  ResolvedJoinRequestRow,
} from './party-join-requests';
export { partyJoinOptoutsRepository } from './party-join-optouts';
export type { OptOutInput, OptOutResult } from './party-join-optouts';
export { partyJoinRepository } from './party-join';
export type { LeaveDomainPartyInput, LeaveDomainPartyResult } from './party-join';
export type {
  PartyDomain,
  NewPartyDomain,
  PartyType,
  PartyDomainSource,
  AuditEvent,
  NewAuditEvent,
  PartyJoinRequest,
  NewPartyJoinRequest,
  PartyJoinRequestStatus,
  PartyJoinOptout,
  NewPartyJoinOptout,
} from '../schema';

// ── Client Credit System (BAL-376 / ADR-1040) ────────────────────────────
export { creditWalletsRepository } from './credit-wallets';
export {
  creditLedgerRepository,
  applyLedgerEntry,
  WalletNotFoundError,
  type ApplyLedgerEntryInput,
  type ApplyLedgerEntryResult,
} from './credit-ledger';
export { creditHoldsRepository, InvalidHoldTransitionError } from './credit-holds';
export { fxDisplayRatesRepository } from './fx-display-rates';
export { deriveIdempotencyKey, type IdempotencyKeyInput } from './_shared/credit-idempotency';
export { acquireWalletLock } from './_shared/wallet-lock';
export {
  recordCreditAudit,
  type CreditAuditAction,
  type CreditAuditEntityType,
  type CreditAuditContext,
  type RecordCreditAuditInput,
} from './_shared/credit-audit';
export {
  CLIENT_WALLET_VIEW_COLUMNS,
  toClientWalletView,
  balanceContribution,
  toLedgerActivityView,
  type ClientWalletView,
  type LedgerActivityView,
} from './_shared/credit-views';
export type {
  CreditWallet,
  NewCreditWallet,
  CreditLedgerEntry,
  NewCreditLedgerEntry,
  CreditEntryType,
  CreditLedgerReason,
  CreditHold,
  NewCreditHold,
  CreditHoldStatus,
  FxDisplayRate,
  NewFxDisplayRate,
  FxDisplayQuote,
} from '../schema';
