export { usersRepository } from './users';
export { companiesRepository } from './companies';
export type {
  CompanySummary,
  SetJoinModeResult,
  PromoteToOrganizationInput,
  PromoteToOrganizationResult,
  CompanyBillingIdentity,
  SeedBillingEmailInput,
  SeedBillingEmailResult,
  SetBillingEmailInput,
  SetBillingEmailResult,
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
/**
 * BAL-414 — the ONLY reader of the six checklist inputs and the ONLY writer of
 * `expert_profiles.searchable` outside seeds. Both apps go through it: `apps/api`'s
 * credential break/repair triggers and `apps/web`'s dashboard read path. The RULE it feeds
 * lives in `@balo/shared/experts`, never here.
 */
export {
  expertSearchabilityRepository,
  EXPERT_SEARCHABILITY_AUDIT_ENTITY_TYPE,
  EXPERT_SEARCHABILITY_GRANTED_ACTION,
  EXPERT_SEARCHABILITY_REVOKED_ACTION,
  type ExpertSearchabilityConnectionState,
  type ExpertSearchabilityChecklistInputs,
  type ExpertSearchabilitySnapshot,
  type ExpertSearchabilitySource,
  type ExpertSearchabilityWriteResult,
  type ApplySearchableInput,
} from './expert-searchability';
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
export {
  scheduledNotificationsRepository,
  ScheduledNotificationNotFoundError,
  type ScheduleOutcome,
  type ScheduleNotificationInput,
  type ScheduleNotificationResult,
  type ListDueInput,
  type ClaimInput,
} from './scheduled-notifications';
export { userNotificationsRepository } from './user-notifications';
export { calendarRepository } from './calendar';
export type { UpsertApirocConnectionInput, BusyReadTarget } from './calendar';
export type { CalendarConnection, CalendarCredentialStatus, CalendarSubCalendar } from '../schema';
export { CALENDAR_CREDENTIAL_STATUSES } from '../schema';
// ── Apiroc webhook subscriptions (BAL-468) — the ONLY access path to that table ──────────
export { calendarSubscriptionsRepository } from './calendar-subscriptions';
export type {
  InsertSubscriptionInput,
  ActiveConnectionWithoutSubscription,
} from './calendar-subscriptions';
export type { CalendarSubscription, NewCalendarSubscription } from '../schema';
// ── Consultation calendar events (BAL-396 §5, per-party since BAL-433) ───────────────────
// The vendor event id's only home, and — since BAL-433 — the ICS-fallback condition's too.
export { meetingCalendarEventsRepository } from './meeting-calendar-events';
export type {
  RecordProviderEventInput,
  RecordIcsDeliveryInput,
  MeetingCalendarEventParty,
  MeetingCalendarProviderEvent,
} from './meeting-calendar-events';
export type {
  MeetingCalendarEvent,
  NewMeetingCalendarEvent,
  MeetingCalendarDeliveryMode,
} from '../schema';
export { availabilityRulesRepository, type WeeklyRuleInput } from './availability-rules';
export { availabilityOverridesRepository } from './availability-overrides';
export type { CreateAvailabilityOverrideInput } from './availability-overrides';
export type { AvailabilityOverride, NewAvailabilityOverride } from '../schema';
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
  // BAL-431 (Ruling 2) — award closure. Exported for `materializeFromKickoff`'s transaction
  // and for tests; there is deliberately no second write site.
  markNotSelectedByAward,
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
// ── Engagement supertype (BAL-417 / ADR-1045 §1) ───────────────────────────
// `EngagementStatus` is deliberately NOT re-exported here — it keeps its existing
// export path from `./proposal-types` (same `Engagement['status']` alias, narrowed
// automatically by the enum shrink). Exporting it from both modules would be a
// duplicate symbol.
export { engagementsRepository } from './engagements';
export {
  insertEngagementRowTx,
  lockEngagementRowTx,
  softDeleteEngagementTx,
  projectDeliveryToEngagementStatus,
  EngagementTypeMismatchError,
  type EngagementType,
  type ProjectDeliveryStatus,
} from './_shared/engagement-supertype';
export {
  projectEngagementsRepository,
  KickoffGatesIncompleteError,
  PROJECT_DELIVERY_TRANSITIONS,
  isAllowedProjectDeliveryTransition,
  InvalidEngagementTransitionError,
  MilestonesIncompleteError,
  advanceProjectDelivery,
  AUTO_ACCEPT_DAYS,
  type ProjectEngagementRow,
  type ProjectEngagementWithMilestones,
  type PortfolioProjectEngagementView,
  type AdminProjectEngagementListItem,
} from './project-engagements';
export {
  caseEngagementsRepository,
  CaseCloserNotMemberError,
  CaseAlreadyClosedError,
  type CaseEngagementRow,
  type CaseCloseReason,
} from './case-engagements';
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
export {
  actionItemsRepository,
  ACTION_ITEM_STATUS_TRANSITIONS,
  isAllowedActionItemTransition,
  InvalidActionItemTransitionError,
  type ActionItemStatus,
  type ActionItemAssigneeParty,
} from './action-items';
export type { ActionItem, NewActionItem } from '../schema';
// ── Transcript pipeline (BAL-387 / ADR-1013 + ADR-1043) ────────────────────
export { transcriptsRepository, type InsertRawTranscriptInput } from './transcripts';
export {
  transcriptArtifactsRepository,
  type UpsertTranscriptArtifactInput,
} from './transcript-artifacts';
export type {
  Transcript,
  NewTranscript,
  TranscriptArtifact,
  NewTranscriptArtifact,
  TranscriptVendor,
  TranscriptStatus,
  TranscriptArtifactKind,
  CanonicalTranscript,
  CanonicalSpeaker,
  CanonicalSegment,
  ExtractedActionItem,
} from '../schema';
export type {
  PricingMethod,
  ProposalCadence,
  ProposalChangeSection,
  ProposalDocumentKind,
  EngagementStatus,
} from './proposal-types';
export {
  conversationsRepository,
  conversationContextKey,
  ConversationContextTakenError,
} from './conversations';
export type {
  ConversationContextRef,
  ConversationThreadSummary,
  ConversationUnreadSummary,
} from './conversations';
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
  ProjectEngagement,
  NewProjectEngagement,
  CaseEngagement,
  NewCaseEngagement,
  EngagementMilestone,
  NewEngagementMilestone,
  Conversation,
  NewConversation,
  ConversationContext,
  NewConversationContext,
  ConversationContextType,
  ConversationMessage,
  NewConversationMessage,
  ConversationFile,
  NewConversationFile,
  // BAL-424: the read-state types were previously NOT re-exported (`portfolio-view.ts`
  // inferred them). The API-side unread recheck needs to name them.
  ConversationReadState,
  NewConversationReadState,
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
export { recordScheduleAudit, type ScheduleAuditAction } from './_shared/schedule-audit';
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
export {
  creditWalletsRepository,
  type CardDisplayInput,
  // BAL-521 — which door detached the saved card; `apps/api` passes it to the shared primitive.
  type SavedCardDetachSource,
  // BAL-524 — the discriminated result of `updateConfig`; callers must be able to name it to
  // narrow on `outcome`.
  type UpdateWalletConfigResult,
} from './credit-wallets';
export {
  creditLedgerRepository,
  applyLedgerEntry,
  WalletNotFoundError,
  LedgerIdempotencyConflictError,
  type ApplyLedgerEntryInput,
  type ApplyLedgerEntryResult,
} from './credit-ledger';
export { creditHoldsRepository, InvalidHoldTransitionError } from './credit-holds';
export {
  creditSessionsRepository,
  SessionNotFoundError,
  InvalidSessionTransitionError,
  ExternalDurationConflictError,
  ExpertProfileNotFoundError,
  /** BAL-412 (F2) — the presence-settlement TOCTOU refusal; the backstop retries on it. */
  SettlementDrawDivergedError,
  SESSION_EXPERT_ACCRUED_ACTION,
  SESSION_AUDIT_ENTITY_TYPE,
  CLIENT_SESSION_VIEW_COLUMNS,
  type OpenSessionInput,
  type OpenSessionResult,
  type MeterTransitions,
  type MeterSessionResult,
  type EndSessionResult,
  type MarkSettlementResultInput,
  type ClientSessionView,
  type CaseExpertEarningsAggregate,
  type SessionStatementContextRow,
} from './credit-sessions';
export {
  creditReceivablesRepository,
  type OpenReceivableInput,
  type OpenReceivableResult,
} from './credit-receivables';
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
  CLIENT_SESSION_MONEY_COLUMNS,
  EXPERT_SESSION_MONEY_COLUMNS,
  toClientMoneyBlock,
  toExpertMoneyBlock,
  toAdminMoneyBlock,
  type ClientWalletView,
  type LedgerActivityView,
  type ClientSessionMoneyView,
  type ExpertSessionMoneyView,
} from './_shared/credit-views';
export type {
  CreditWallet,
  NewCreditWallet,
  MandateStatus,
  CreditLedgerEntry,
  NewCreditLedgerEntry,
  CreditEntryType,
  CreditLedgerReason,
  CreditHold,
  NewCreditHold,
  CreditHoldStatus,
  CreditSession,
  NewCreditSession,
  CreditSessionStatus,
  CreditSettlementStatus,
  CreditDurationSource,
  CreditFinalizationPath,
  CreditReceivable,
  NewCreditReceivable,
  CreditReceivableStatus,
  CreditReceivableReason,
  FxDisplayRate,
  NewFxDisplayRate,
  FxDisplayQuote,
} from '../schema';

// ── Proposal Share Links (BAL-386) ────────────────────────────────────────
export { proposalShareLinksRepository } from './proposal-share-links';
export type {
  CreateShareLinkInput,
  CreateShareLinkResult,
  RevokeShareLinkInput,
} from './proposal-share-links';
export type { ProposalShareLink, NewProposalShareLink } from '../schema';
// ── Promo codes (BAL-384) ─────────────────────────────────────────────────
export {
  promoCodesRepository,
  normalizePromoCode,
  DuplicatePromoCodeError,
  PromoCodeNotFoundError,
  CapBelowRedeemedCountError,
  type CreatePromoCodeInput,
  type UpdatePromoCapInput,
  type PromoRedemptionRecord,
  type RedeemPromoInput,
  type RedeemPromoResult,
} from './promo-codes';
export type {
  PromoCode,
  NewPromoCode,
  PromoRedemption,
  NewPromoRedemption,
  PromoCodeStatus,
} from '../schema';
// ── Promo redeem engine (BAL-377) ──────────────────────────────────────────
export {
  promoRedemptionsRepository,
  PromoInvalidError,
  PromoScheduledError,
  PromoExpiredError,
  PromoExhaustedError,
  PromoAlreadyRedeemedError,
  type PromoValidation,
  type PromoValidationReason,
  type RedeemResult,
  type ValidatePromoInput,
  type RedeemPromoGrantInput,
} from './promo-redemptions';
// ── Stripe provider (BAL-382) ─────────────────────────────────────────────
export { stripeWebhookEventsRepository } from './stripe-webhook-events';
export type { StripeWebhookEvent, NewStripeWebhookEvent } from '../schema';
// ── Daily webhook idempotency (BAL-134, D2) — the SECOND webhook marker log ─
export {
  dailyWebhookEventsRepository,
  type InsertReceivedDailyEventInput,
} from './daily-webhook-events';
export type { DailyWebhookEvent, NewDailyWebhookEvent } from '../schema';
// ── Mux webhook idempotency (BAL-473) — the event-id log for `POST /webhooks/mux` ────────
export { muxWebhookEventsRepository, type InsertReceivedMuxEventInput } from './mux-webhook-events';
export type { MuxWebhookEvent, NewMuxWebhookEvent } from '../schema';
// ── Apiroc webhook idempotency (BAL-468) — the THIRD webhook marker log ─────
export {
  apirocWebhookEventsRepository,
  type InsertReceivedApirocEventInput,
} from './apiroc-webhook-events';
export type { ApirocWebhookEvent, NewApirocWebhookEvent } from '../schema';
// ── Case consultation billing / expert payout obligation (BAL-399) ──────────
export {
  expertPayoutRecordsRepository,
  type RecordPayoutInput,
  type RecordPayoutResult,
} from './expert-payout-records';
export type {
  ExpertPayoutRecord,
  NewExpertPayoutRecord,
  ExpertPayoutRecordStatus,
} from '../schema';
// ── Meetings primitive (BAL-418 / ADR-1045 §2/§3/§6) ───────────────────────
export {
  meetingsRepository,
  MeetingContextRequiredError,
  MeetingNotCancellableError,
  MeetingNotReschedulableError,
  type CancelMutationResult,
  type CreateMeetingInput,
  type CreatedMeeting,
  type MeetingContextInput,
  type MeetingMutationResult,
  type RescheduleMutationResult,
  type MeetingWithContexts,
  // BAL-283 — the batched "is a call booked on this context?" read's row shape.
  type ContextMeetingSummary,
  // BAL-134 / ADR-1049 — the lifecycle transitions (§4.3).
  type ListLifecycleCandidatesInput,
  type EndMeetingInput,
  type EndMeetingResult,
  // BAL-498 — the expert calendar's read row shape.
  type ExpertCalendarMeeting,
} from './meetings';
// ── Consultation projection (BAL-428) — `consultations` as a read model of `meetings` ──
// The WRITERS are deliberately NOT exported: they are transaction-scoped internals of
// `meetingsRepository` / `meetingContextsRepository`. Only the typed errors (so callers can
// branch), the status mapping and the reconciliation read cross the package boundary.
export {
  MatchModeDiscoveryNotBookableError,
  MeetingContextNotProjectableError,
  MeetingContextUnresolvableError,
  MeetingExpertAmbiguousError,
  consultationStatusForMeeting,
  findProjectionDrift,
  findProjectionForMeeting,
  // The UNSCOPED full-table scan, deliberately under its own name — `findProjectionDrift`
  // now REQUIRES `meetingIds`, so an unbounded read cannot be reached by omitting an
  // argument from a web action. See both docblocks.
  scanAllProjectionDrift,
  type ProjectionDrift,
  type ProjectionDriftKind,
} from './_shared/consultation-projection';
export {
  meetingContextsRepository,
  MeetingAdminContextExistsError,
  MeetingPrimaryContextRepointedError,
  type ConsultationTimestamps,
} from './meeting-contexts';
export {
  meetingPresenceRepository,
  InvalidPresenceIdentityError,
  InvalidPresenceTimestampError,
  type OpenPresenceInput,
  type ClosePresenceInput,
  type PresenceIdentity,
  type PresenceWindow,
} from './meeting-presence';
// ── Meeting files (BAL-423) — the FOURTH file scope, anchored on `meetings.id` ──────────
export {
  meetingFilesRepository,
  isTwoSidedParty,
  MEETING_FILE_LIST_LIMIT,
  type MeetingFileParty,
  type AddMeetingFileInput,
  type SoftDeleteMeetingFileInput,
  type FindMeetingFileInput,
} from './meeting-files';
// ── Request shared files (BAL-431 / ADR-1048) — the FIFTH file scope, anchored on
//    `project_requests.id`, carrying an AUDIENCE OF TRACKS. ────────────────────────────────
//
// ⚠ `listForEngagement` SHIPS INERT: `/engagements/[id]` has no files surface today, so §5
// promotion lineage lands as a read-side join with its integration tests and no UI consumer
// (the BAL-403 / BAL-420 / BAL-313 / BAL-391 shape). Named as a follow-up in the PR body.
export {
  requestSharedFilesRepository,
  REQUEST_SHARED_FILE_LIST_LIMIT,
  RequestFileNotFoundError,
  RequestFileTrackNotLiveError,
  RequestFileGrantNotFoundError,
  RequestFileAlreadyDeletedError,
  type RequestFileWithGrants,
  type ShareRequestFileInput,
  type ShareRequestFileResult,
  type RevokeRequestFileGrantInput,
  type SoftDeleteRequestFileInput,
  type SoftDeleteRequestFileResult,
} from './request-shared-files';
export type {
  RequestSharedFile,
  NewRequestSharedFile,
  RequestFileGrant,
  NewRequestFileGrant,
  RequestFileSide,
  RequestFileAudience,
} from '../schema';
// The audit vocabulary + its payload contract (Ruling 4 — APPEND-ONLY, no backfill).
export {
  recordRequestFileAudit,
  type RequestFileAuditAction,
  type RequestFileAuditEntityType,
  type RequestFileAuditCommon,
  type RequestFileAuditPayload,
  type RequestFileAuditTrackRef,
  type RequestFileAuditAudienceEntry,
} from './_shared/request-file-audit';
// ── Meeting recordings (BAL-473) — 1:n recording SEGMENTS anchored on `meetings.id` ──────
export {
  meetingRecordingsRepository,
  MEETING_RECORDING_LIST_LIMIT,
  FAILURE_REASON_MAX_LENGTH,
  type InsertCapturingRecordingInput,
  type MarkRecordingStartedInput,
  type MarkRecordingSourceReadyInput,
  type MarkRecordingIngestingInput,
  type MarkRecordingReadyInput,
  type MarkRecordingFailedInput,
  type MarkRecordingSourceDeletedInput,
  type FindMeetingRecordingInput,
} from './meeting-recordings';
/**
 * The judgement-free "who owns this meeting context" READ (BAL-423). Exported because BOTH
 * apps must resolve tenancy from ONE definition — it is NOT a gate, and every caller still
 * runs its own capability check against what it returns. See the module docblock.
 */
export {
  resolveMeetingContextOwner,
  resolveClientCompaniesForMeetings,
  type MeetingContextOwner,
  type MeetingClientCompany,
} from './_shared/meeting-context-owner';
export type {
  Meeting,
  NewMeeting,
  MeetingStatus,
  MeetingOutcome,
  MeetingEndedBy,
  MeetingContext,
  NewMeetingContext,
  MeetingContextType,
  MeetingPresence,
  NewMeetingPresence,
  MeetingParticipantParty,
  MeetingFile,
  NewMeetingFile,
  MeetingFileSource,
  MeetingRecording,
  NewMeetingRecording,
  MeetingRecordingStatus,
} from '../schema';
// ── Guest participation model (BAL-408 / ADR-1044) ─────────────────────────
export {
  meetingGuestsRepository,
  type MeetingGuestParty,
  type MeetingGuestAdmissionDecision,
  type CreateMeetingGuestInput,
  type CreateMeetingGuestsInput,
  type RevokeMeetingGuestInput,
  type DecideMeetingGuestAdmissionInput,
  type MeetingGuestWithMeeting,
  type MeetingGuestPublic,
} from './meeting-guests';
export type {
  MeetingGuest,
  NewMeetingGuest,
  MeetingParticipationRole,
  GuestAccessScope,
  MeetingGuestInviteChannel,
  MeetingGuestAdmission,
} from '../schema';
// ── Review & rating primitive (BAL-390) ────────────────────────────────────
export {
  reviewsRepository,
  UNTITLED_ENGAGEMENT_LABEL,
  type UpsertReviewInput,
  type UpsertReviewResult,
  type RatingNudgeCandidate,
} from './reviews';
export {
  reviewInviteTokensRepository,
  type CreateReviewInviteTokenInput,
} from './review-invite-tokens';
export type { Review, NewReview, ReviewInviteToken, NewReviewInviteToken } from '../schema';
// ── Reschedule proposals (BAL-411 / ADR-1044) ──────────────────────────────
export {
  rescheduleProposalsRepository,
  RescheduleProposalAlreadyPendingError,
  type ProposeRescheduleInput,
  type RescheduleProposalOptionInput,
  type RescheduleProposalWithOptions,
  type LiveRescheduleProposalSummary,
  type AnswerRescheduleProposalInput,
  type AcceptRescheduleProposalInput,
  type AcceptedRescheduleProposal,
} from './reschedule-proposals';
export type {
  RescheduleProposal,
  NewRescheduleProposal,
  RescheduleProposalOption,
  NewRescheduleProposalOption,
  RescheduleProposalStatus,
} from '../schema';
// ── Representations (BAL-313 / ADR-1028 Phase 1) ───────────────────────────
// ⚠ SHIPS INERT — no UI, no Server Action, no API route, no notification and no analytics
// consume any of this yet. BAL-314 is the first consumer, and it owns the grant surface, the
// "who may grant" gate and the `hasCapability` role ∪ representation wiring.
export {
  representationsRepository,
  RepresentationCapabilityError,
  RepresentationScopeError,
  RepresentationExpiryError,
  RepresentationConflictError,
  type RepresentationSubject,
  type GrantRepresentationInput,
  type GrantRepresentationResult,
  type RevokeRepresentationInput,
} from './representations';
export type {
  Representation,
  NewRepresentation,
  RepresentationScope,
  RepresentationStatus,
} from '../schema';
