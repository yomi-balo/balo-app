import { z } from 'zod';
import type { EventPayloadMap, PublishableNotificationEvent } from '../../notifications/events.js';
import { EXPERT_CHECKLIST_ITEM_KEYS, EXPERT_DECLINE_REASONS } from '@balo/shared/experts';
import { MILESTONE_CHANGE_KINDS } from '@balo/shared/notifications';
import {
  DECLINABLE_RELATIONSHIP_STATUSES,
  PROJECT_REQUEST_CLOSE_REASONS,
  PROPOSAL_CHANGE_SECTIONS,
} from '@balo/shared/project-requests';

// N3 — `joinPath` MUST be a same-origin, ROUTE-SHAPED path, never a bare `.min(1).max(200)`
// string. `booking.confirmed`'s email template renders it as `${BASE_URL}${joinPath}`, so an
// unconstrained value lets an internal-secret-holding caller (or a future bug upstream of this
// boundary) turn `joinPath` into an absolute `https://evil.com/...` phishing link inside a real
// Balo email. The only producer is `memberJoinPath()` (`apps/web/src/lib/meetings/
// member-join-path.ts`), which emits exactly `/join/m/{meetingId}` — anchored front and back so
// nothing else is accepted.
const memberJoinPathSchema = z.string().regex(/^\/join\/m\/[0-9a-f-]{36}$/);

const userWelcomePayload = z.object({
  correlationId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(['client', 'expert']),
});

const expertApplicationSubmittedPayload = z.object({
  correlationId: z.uuid(),
  userId: z.uuid(),
  applicationId: z.uuid(),
});

const expertApprovedPayload = z.object({
  correlationId: z.uuid(),
  userId: z.uuid(),
  expertProfileId: z.uuid(),
});

/**
 * BAL-549 (D5) — `correlationId` is NOT `z.uuid()`. It is a COMPOUND, colon-free id of shape
 * `expert-application-declined.{expertProfileId}.{auditEventId}` — a re-decline of the same
 * profile must not be deduped away against a retained BullMQ job (a bare `expertProfileId`
 * would be). `.min(1).max(200)` erases under `z.infer`, so this still key-for-key matches
 * `ExpertApplicationDeclinedPayload` (`AssertPublishPayloadShapesMatch`'s documented limit L1).
 */
const expertApplicationDeclinedPayload = z.object({
  correlationId: z.string().min(1).max(200),
  userId: z.uuid(),
  expertProfileId: z.uuid(),
  reason: z.enum(EXPERT_DECLINE_REASONS),
});

// BAL-325 referral invite (expert → EXTERNAL email). `correlationId` is the
// expert_referral_invites row id — dedup per invite. `recipientEmail` is the
// invited external address (delivery + dedup identity; the deliberate
// PII-in-queue exception for a non-user recipient). Mirrors
// apps/web/src/lib/notifications/types.ts.
const expertReferralInvitedPayload = z.object({
  correlationId: z.uuid(),
  recipientEmail: z.string().email().max(254),
  inviterName: z.string().min(1).max(120),
});

const projectRequestSubmittedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  expertProfileId: z.uuid(),
  companyId: z.uuid(),
  title: z.string().min(1),
  sendTo: z.literal('direct'),
  tagIds: z.array(z.uuid()),
  productIds: z.array(z.uuid()),
  documentCount: z.number().int().nonnegative(),
});

const projectMatchRequestedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  companyId: z.uuid(),
  title: z.string().min(1),
  tagIds: z.array(z.uuid()),
  productIds: z.array(z.uuid()),
  documentCount: z.number().int().nonnegative(),
});

// BAL-284 exploratory requested (admin → client). `correlationId` is the project
// request id — the transition is one-way ⇒ natural one-shot dedup. `recipientId`
// is the request owner's user id (drives recipient:'client' resolution). Mirrors
// apps/web/src/lib/notifications/types.ts.
const projectExploratoryRequestedPayload = z.object({
  correlationId: z.uuid(),
  recipientId: z.uuid(),
  projectRequestId: z.uuid(),
  title: z.string().min(1).max(200),
});

// BAL-284 expert invited (admin → expert). `correlationId` is the relationship id
// — dedup per (expert, request). `expertProfileId` is the invited expert (resolver
// hydrates data.expert ⇒ recipient:'expert'). Mirrors
// apps/web/src/lib/notifications/types.ts.
const projectExpertInvitedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  expertProfileId: z.uuid(),
  title: z.string().min(1).max(200),
});

// BAL-284 EOI submitted (expert → client). `correlationId` is the EOI id — dedup
// per submission. `recipientId` is the request owner's user id (drives
// recipient:'client' resolution). Mirrors apps/web/src/lib/notifications/types.ts.
const projectEoiSubmittedPayload = z.object({
  correlationId: z.uuid(),
  recipientId: z.uuid(),
  projectRequestId: z.uuid(),
  title: z.string().min(1).max(200),
  expertName: z.string().min(1).max(120),
});

// BAL-271 conversation events, re-anchored by BAL-424 onto the ADR-1045 §2 context seam.
// `recipientId` is set when recipientRole==='client' (dispatcher 'client' path);
// `expertProfileId` when recipientRole==='expert' (resolver hydrates data.expert).
//
// ⚠ `contextType` + `contextId` ARE THE AUTHORITATIVE ANCHOR and are both required.
// `projectRequestId` and `engagementId` are BOTH OPTIONAL — the `relationship` arm carries
// the request, the `engagement` arm carries the engagement, and a Case has no request at
// all. They exist only so the in-app template can build a deep link, so the pair is
// deliberately not cross-validated here.
// Mirrors apps/web/src/lib/notifications/types.ts.
const conversationMessagePostedPayload = z.object({
  correlationId: z.uuid(), // message id — dedup per message
  conversationId: z.uuid(),
  contextType: z.enum(['relationship', 'engagement']),
  contextId: z.uuid(),
  title: z.string().min(1),
  senderName: z.string().min(1),
  recipientRole: z.enum(['client', 'expert']),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid().optional(),
  preview: z.string().max(200),
  projectRequestId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
  sentDuringMeeting: z.boolean(),
});

const conversationFileSharedPayload = z.object({
  correlationId: z.uuid(), // file id — dedup per share
  conversationId: z.uuid(),
  contextType: z.enum(['relationship', 'engagement']),
  contextId: z.uuid(),
  title: z.string().min(1),
  senderName: z.string().min(1),
  recipientRole: z.enum(['client', 'expert']),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid().optional(),
  fileName: z.string().min(1).max(255),
  projectRequestId: z.uuid().optional(),
  engagementId: z.uuid().optional(),
});

// BAL-272 proposal request (client → expert). `correlationId` is the
// relationship id — dedup per proposal request. BAL-315 adds the admin-on-behalf
// path: `initiatedBy` gates the client heads-up rule, and `recipientId` (the
// request owner's user id) is set on the admin path only. Mirrors
// apps/web/src/lib/notifications/types.ts.
const projectProposalRequestedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  title: z.string().min(1).max(200),
  initiatedBy: z.enum(['client', 'admin']),
  recipientId: z.uuid().optional(),
});

// BAL-288 proposal submit (expert → client). `correlationId` is the proposal id
// — dedup per submitted proposal. `recipientId` is the client user id (drives
// recipient:'client' resolution). Mirrors apps/web/src/lib/notifications/types.ts.
const projectProposalSubmittedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  recipientId: z.uuid(),
  expertName: z.string().min(1).max(120),
  title: z.string().min(1).max(200),
});

// BAL-289 proposal accept (client → expert + ops). `correlationId` is the proposal
// id — dedup per accepted proposal. `expertProfileId` is the winning expert (resolver
// hydrates data.expert). Mirrors apps/web/src/lib/notifications/types.ts.
const projectProposalAcceptedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  clientName: z.string().min(1).max(120),
  clientCompanyName: z.string().min(1).max(160),
  title: z.string().min(1).max(200),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(2).max(10),
});

// BAL-291 kickoff approved (client → expert + client). `correlationId` is the
// kickoff/engagement correlation — dedup per kickoff approval. `expertProfileId`
// is the delivering expert (resolver hydrates data.expert ⇒ recipient:'expert');
// `recipientId` is the client user id (drives recipient:'client' resolution).
// Mirrors apps/web/src/lib/notifications/types.ts.
const projectKickoffApprovedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  recipientId: z.uuid(),
  title: z.string().min(1).max(200),
  expertName: z.string().min(1).max(120),
  clientName: z.string().min(1).max(120),
  clientCompanyName: z.string().min(1).max(160),
});

// BAL-290 changes requested (client → expert). `correlationId` is the proposal id
// — distinct row per round, naturally unique. `expertProfileId` is the proposal
// owner (resolver hydrates data.expert). Mirrors apps/web/src/lib/notifications/types.ts.
const projectChangesRequestedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  clientName: z.string().min(1).max(120),
  projectTitle: z.string().min(1).max(200),
  section: z.enum(PROPOSAL_CHANGE_SECTIONS),
  note: z.string().min(1).max(4000),
});

// BAL-290 proposal resubmitted (expert → client). `recipientId` is the client user
// id (drives recipient:'client' resolution). Mirrors apps/web/src/lib/notifications/types.ts.
const projectProposalResubmittedPayload = z.object({
  // format "<v2ProposalId>--v<version>" — uuid + version suffix; z.string not z.uuid so the suffix validates
  correlationId: z.string().min(1).max(80),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  recipientId: z.uuid(),
  expertName: z.string().min(1).max(120),
  projectTitle: z.string().min(1).max(200),
  version: z.number().int().positive(),
  priceCents: z.number().int().nonnegative(),
  currency: z.string().min(2).max(10),
});

// BAL-324 admin billing reminder (kickoff board → outstanding client-billing
// gate). `correlationId` is minted per click (uuid) so a re-remind is a fresh
// dispatch, not a jobId no-op. `recipientId` is the owner (recipient:'client');
// `creatorUserId` is the optional request creator (recipient:'billing_creator').
// Mirrors apps/web/src/lib/notifications/types.ts.
const projectBillingReminderPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  title: z.string().min(1).max(200),
  companyName: z.string().min(1).max(160),
  recipientId: z.uuid(),
  creatorUserId: z.uuid().optional(),
});

// BAL-386 proposal shared (client member → EXTERNAL colleague). `correlationId` is
// the proposal_share_links row id — dedup per link. `recipientEmail` is the external
// target (delivery + dedup identity); `shareToken` is the RAW magic-link token
// (URL-only). Both are the deliberate PII-in-queue exception for a non-user
// recipient. Mirrors packages/shared/src/notifications/index.ts.
const proposalSharedPayload = z.object({
  correlationId: z.uuid(),
  recipientEmail: z.string().email().max(254),
  shareToken: z.string().min(20).max(200),
  sharerName: z.string().min(1).max(160),
  sharerOrgLabel: z.string().min(1).max(200),
  proposalTitle: z.string().min(1).max(300),
  note: z.string().max(1000).optional(),
  expiresOn: z.string().min(1).max(40),
  attachments: z
    .array(
      z.object({
        source: z.literal('r2'),
        key: z.string().min(1).max(300),
        filename: z.string().min(1).max(200),
      })
    )
    .max(3),
});

// BAL-323 billing details confirmed (client → admins). `correlationId` = companyId
// (once-ever-per-company dedup). Mirrors apps/web/src/lib/notifications/types.ts.
const billingDetailsConfirmedPayload = z.object({
  correlationId: z.uuid(),
  companyId: z.uuid(),
  companyName: z.string().min(1).max(200),
  projectRequestId: z.uuid(),
});

// BAL-332 (D2) expert milestone completed (expert → client owner + admins).
// `correlationId` = `${milestoneId}:${completedAtEpochMs}` (idempotent per
// completion; z.string not z.uuid so the epoch suffix validates). `recipientId` is
// the client company owner (recipient:'client'; optional — absent for retainers/
// no-owner). Mirrors packages/shared/src/notifications/index.ts.
const engagementMilestoneCompletedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  milestoneId: z.uuid(),
  recipientId: z.uuid().optional(),
  expertPartyLabel: z.string().min(1).max(200),
  actorExpertLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  milestoneTitle: z.string().min(1).max(200),
  completedOn: z.string().min(1).max(40),
  completionNote: z.string().max(4000).optional(),
  completedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
});

// BAL-332 (D2) expert milestone reverted (expert → client owner + admins).
// `correlationId` = `${milestoneId}:reverted:${updatedAtEpochMs}`. Mirrors
// packages/shared/src/notifications/index.ts.
const engagementMilestoneRevertedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  milestoneId: z.uuid(),
  recipientId: z.uuid().optional(),
  actorExpertLabel: z.string().min(1).max(200),
  milestoneTitle: z.string().min(1).max(200),
});

// BAL-333 (D3) expert delivery-plan scope changed (expert → client owner + admins).
// `correlationId` = the dedup/debounce key (z.string not z.uuid so the `:added` /
// `:edited:${ms|bucket}` suffix validates). `recipientId` is the client company owner
// (recipient:'client'; optional — absent for retainers/no-owner). `milestoneId` is the
// affected milestone (optional for forward-compat). Mirrors
// packages/shared/src/notifications/index.ts.
const engagementScopeChangedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  milestoneId: z.uuid().optional(),
  recipientId: z.uuid().optional(),
  actorExpertLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  changeKind: z.enum(MILESTONE_CHANGE_KINDS),
  changeSummary: z.string().min(1).max(240),
});

// BAL-334 (D4) expert requested project completion (expert → client owner + admins).
// `correlationId` = `${engagementId}:completion_requested:${requestedAtMs}` (z.string
// not z.uuid so the epoch suffix validates). `recipientId` is the client company owner
// (recipient:'client'; optional — absent for retainers/no-owner). Mirrors
// packages/shared/src/notifications/index.ts.
const engagementCompletionRequestedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  recipientId: z.uuid().optional(),
  clientCompanyName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  actorExpertLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  milestonesTotal: z.number().int().nonnegative(),
  requestedDate: z.string().min(1).max(40),
  autoDate: z.string().min(1).max(40),
  reviewDays: z.number().int().nonnegative(),
});

// BAL-334 (D4) expert withdrew the completion request (expert → client owner + admins).
// `correlationId` = `${engagementId}:completion_withdrawn:${nowMs}`. Mirrors
// packages/shared/src/notifications/index.ts.
const engagementCompletionWithdrawnPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  recipientId: z.uuid().optional(),
  actorExpertLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
});

// BAL-334 (D4) admin cancelled the engagement (admin → client owner + expert).
// `correlationId` = `${engagementId}:cancelled` (one-shot terminal transition).
// `expertProfileId` → resolver hydrates data.expert (recipient:'expert'). Mirrors
// packages/shared/src/notifications/index.ts.
const engagementCancelledPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid(),
  projectTitle: z.string().min(1).max(200),
  cancelledOn: z.string().min(1).max(40),
  reason: z.string().min(1).max(2000),
});

// BAL-338 (D7) client accepted the project (client → expert + admins). `correlationId`
// = `${engagementId}:accepted` (one-shot terminal; z.string not z.uuid so the suffix
// validates). `expertProfileId` → resolver hydrates data.expert (recipient:'expert').
// BAL-390 adds the accepting member as a recipient in their own right: `userId` →
// recipient:'self' (the payment.charged shape) plus the party labels, the RAW
// review-invite token the fused rating ask needs, and `alreadyRated` — which is stated
// rather than inferred from a missing token, because a token is ALSO missing when the
// mint failed. All five are OPTIONAL so an older publisher still validates; the client
// rule is gated on `userId`.
// Mirrors packages/shared/src/notifications/index.ts.
const engagementAcceptedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  expertProfileId: z.uuid(),
  actorClientLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  acceptedOn: z.string().min(1).max(40),
  milestonesTotal: z.number().int().nonnegative(),
  userId: z.uuid().optional(),
  clientCompanyName: z.string().min(1).max(200).optional(),
  expertPartyLabel: z.string().min(1).max(200).optional(),
  reviewToken: z.string().min(20).max(200).optional(),
  alreadyRated: z.boolean().optional(),
});

// BAL-390 (D4) a case was closed — the fused close + rating email (client only).
// `correlationId` = `${engagementId}:case_closed` (one-shot terminal; z.string not
// z.uuid so the suffix validates). `recipientId` gates the rule (absent ⇒ skip).
// `reviewToken` is the RAW ≥256-bit review-invite token and appears ONLY inside the
// emailed URL — absent ⇒ already rated ⇒ the email omits the review block entirely.
// `meetingId` is the CTA subject on BOTH channels: the engagements route 404s for a CASE by
// construction, so the deep link is the recap (BAL-388). OPTIONAL — absent ⇒ no CTA at all.
// Mirrors packages/shared/src/notifications/index.ts.
const engagementCaseClosedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  meetingId: z.uuid().optional(),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid(),
  clientCompanyName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  caseTitle: z.string().min(1).max(200),
  closedDate: z.string().min(1).max(40),
  closeReason: z.enum(['resolved', 'auto_inactive']),
  consultationCount: z.number().int().nonnegative().optional(),
  reviewToken: z.string().min(20).max(200).optional(),
});

// BAL-338 (D7) client requested changes (client → expert + admins). `correlationId`
// = `${engagementId}:changes_requested:${changeRequestedAtMs}` (re-requestable; z.string
// not z.uuid so the epoch suffix validates). `note` is the client's verbatim change
// note. Mirrors packages/shared/src/notifications/index.ts.
const engagementChangesRequestedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  expertProfileId: z.uuid(),
  actorClientLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  note: z.string().min(1).max(2000),
  reviewDays: z.number().int().nonnegative(),
  reviewCycle: z.number().int().positive(),
});

// BAL-345 domain auto-join. All four events carry the SAME shape: `userId` is the
// subject (joiner/requester), `correlationId` the stable membership/request id.
// One schema, reused for all four arms (DRY — the completeness guard still checks
// each event name has an arm). Mirrors apps/web/src/lib/notifications/types.ts.
const partyJoinEventPayload = z.object({
  correlationId: z.uuid(),
  partyType: z.enum(['company', 'agency']),
  partyId: z.uuid(),
  userId: z.uuid(),
});

// BAL-348 agency provisioned (corporate expert → new agency owner). `correlationId`
// = agencyId (stable → jobId dedup); `ownerUserId` is the new owner (subject +
// recipient). All three are uuids. Mirrors apps/web/src/lib/notifications/types.ts.
const agencyProvisionedPayload = z.object({
  correlationId: z.uuid(),
  agencyId: z.uuid(),
  ownerUserId: z.uuid(),
});

// BAL-369 company provisioned (corporate + verified owner → personal workspace
// promoted to a typed org). `correlationId` = companyId (stable → jobId dedup);
// `ownerUserId` is the promoting owner (subject + recipient). All three are uuids.
// Mirrors apps/web/src/lib/notifications/types.ts.
const companyProvisionedPayload = z.object({
  correlationId: z.uuid(),
  companyId: z.uuid(),
  ownerUserId: z.uuid(),
});

// BAL-377 / BAL-381 credit top-up requested (member → billing admins). `correlationId`
// is minted per hour-bucket (topup-nudge:{companyId}:{userId}:{hourBucket}) so a burst of
// re-nudges dedups to one dispatch per hour, but a genuine later nudge still fans out.
// `companyId` drives the MANAGE_BILLING fan-out; `requestedByUserId` is the nudging
// member (context/audit only). Mirrors apps/web/src/lib/notifications/types.ts +
// packages/shared/src/notifications/index.ts.
const creditTopupRequestedPayload = z.object({
  correlationId: z.string().min(1).max(200),
  companyId: z.uuid(),
  requestedByUserId: z.uuid(),
});

// BAL-383 promo redeemed (client → self, web-published). `correlationId` =
// promo_redemptions.id (dedup); `userId` = the redeeming actor (recipient:'self').
// `grantedLabel` is pre-formatted (formatMinorAud) — no minor units in the payload.
// Mirrors packages/shared/src/notifications/index.ts.
const promoRedeemedPayload = z.object({
  correlationId: z.uuid(),
  userId: z.uuid(),
  code: z.string().min(1).max(64),
  grantedLabel: z.string().min(1).max(40),
  companyName: z.string().min(1).max(200),
});

// BAL-391 (ADR-1043) action item assigned (client → assigned side, web-published).
// `correlationId` = `${actionItemId}:assigned:${assignedAtMs}` (z.string not z.uuid so
// the epoch suffix validates). `assigneeParty` routes the two conditioned rules;
// `recipientId` (client owner) / `expertProfileId` are set on their respective party
// branches. Mirrors packages/shared/src/notifications/index.ts.
const actionItemAssignedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  actionItemId: z.uuid(),
  assigneeParty: z.enum(['client', 'expert']),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid().optional(),
  actorLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  actionItemBody: z.string().min(1).max(2000),
  dueOn: z.string().min(1).max(40).optional(),
});

// BAL-414 (D1/D2) — the non-calendar de-list (email + in-app). `correlationId` is the
// `audit_events` row id minted by the conditional compare-and-set (§B.2) — a z.uuid, not the
// expertProfileId, so a genuine later regression re-notifies rather than being silenced by a
// stable dedup key. `failingItems` reads the single vocabulary tuple rather than restating the
// six literals. Mirrors packages/shared/src/notifications/index.ts.
const expertSearchabilityLostPayload = z.object({
  correlationId: z.uuid(),
  expertProfileId: z.uuid(),
  // S3 (fix round 1) — the enum bounds the VALUES but not the LENGTH; `.max()` bounds a caller
  // holding INTERNAL_API_SECRET to at most the real vocabulary size, closing off a repeated-key
  // payload that would otherwise fit Fastify's 1MB default body limit and flow into an O(n)
  // email body / in-app count (precedent: `proposal.shared`'s `attachments: z.array(...).max(3)`).
  failingItems: z.array(z.enum(EXPERT_CHECKLIST_ITEM_KEYS)).max(EXPERT_CHECKLIST_ITEM_KEYS.length),
});

// BAL-414 (D2) — the re-list, in-app only (no email rule — see engine/rules.ts). Same
// correlationId shape as the lost payload above. Mirrors packages/shared/src/notifications/index.ts.
const expertSearchabilityRestoredPayload = z.object({
  correlationId: z.uuid(),
  expertProfileId: z.uuid(),
});

// BAL-400 (D4) — a consultation was booked into a case. `correlationId` is `${meetingId}` (a
// uuid) — a retry through the idempotent replay path publishes the SAME jobId, so BullMQ dedups
// it rather than double-notifying. `recipientId` optional: absent ⇒ the client rule skips
// (the resolver has no reviewer to hydrate). No rate/total/estimate field exists on this
// payload — there is none to leak (D4c). Mirrors packages/shared/src/notifications/index.ts.
const bookingConfirmedPayload = z.object({
  correlationId: z.uuid(),
  meetingId: z.uuid(),
  engagementId: z.uuid(),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid(),
  clientCompanyName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  caseTitle: z.string().min(1).max(200),
  isNewCase: z.boolean(),
  priorConsultationCount: z.number().int().nonnegative(),
  scheduledStartIso: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
  joinPath: memberJoinPathSchema,
  provisioned: z.boolean(),
  guestCount: z.number().int().nonnegative(),
});

// BAL-409 — a booked consultation was moved by the CLIENT (web-published, mirroring
// `booking.confirmed`). `correlationId` = `${meetingId}:${scheduledStartIso}` — NOT the bare
// meetingId, so a SECOND reschedule notifies again rather than colliding with the first
// publish's jobId. No rate/total/hold field — a reschedule moves no money. Mirrors
// packages/shared/src/notifications/index.ts.
const bookingRescheduledPayload = z.object({
  correlationId: z.string().min(1).max(200),
  meetingId: z.uuid(),
  engagementId: z.uuid(),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid(),
  clientCompanyName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  caseTitle: z.string().min(1).max(200),
  previousScheduledStartIso: z.string().datetime(),
  scheduledStartIso: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
  // No `joinPath` — a reschedule reuses the same room, so the link is unchanged and neither
  // template renders one. See `BookingRescheduledPayload`. `booking.confirmed` keeps its own.
  // BAL-411 widened this from `z.literal('client')` — accepting the client's OWN acceptance of
  // an expert-initiated proposal.
  initiatedBy: z.enum(['client', 'expert']),
});

// BAL-411 — the expert proposed alternative times (web-published, mirroring
// `booking.rescheduled`). `correlationId` = proposalId — a fresh row per propose, so
// re-proposing mints a genuinely new id. No rate/total/hold field — a proposal moves no money.
// Mirrors packages/shared/src/notifications/index.ts.
const rescheduleProposalSentPayload = z.object({
  correlationId: z.uuid(),
  proposalId: z.uuid(),
  meetingId: z.uuid(),
  engagementId: z.uuid(),
  recipientUserIds: z.array(z.uuid()),
  expertPartyLabel: z.string().min(1).max(200),
  expertPersonLabel: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
  caseTitle: z.string().min(1).max(200),
  originalScheduledStartIso: z.string().datetime(),
  optionStartIsos: z.array(z.string().datetime()).min(1).max(3),
  durationMinutes: z.number().int().positive(),
  hoursToStart: z.number(),
  expiresAtIso: z.string().datetime(),
});

// BAL-411 — the client declined every option. `correlationId` = proposalId — one decline per
// proposal (the repository CAS is terminal). Mirrors packages/shared/src/notifications/index.ts.
const rescheduleProposalDeclinedPayload = z.object({
  correlationId: z.uuid(),
  proposalId: z.uuid(),
  meetingId: z.uuid(),
  engagementId: z.uuid(),
  expertProfileId: z.uuid(),
  clientCompanyName: z.string().min(1).max(200),
  caseTitle: z.string().min(1).max(200),
  declinedByLabel: z.string().min(1).max(200),
  originalScheduledStartIso: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
});

// BAL-283 (Ruling 3) — the expert shared availability on a project-request thread
// (web-published). `correlationId` = `${relationshipId}--${sharedAtIso}` — per WRITE, never
// per relationship (BullMQ dedups against retained completed jobs). `previousSharedAtIso` is
// the ONLY input to the notification rule's flat 24h re-notify window. No money field — an
// intro call is unbilled. Mirrors packages/shared/src/notifications/index.ts.
const conversationAvailabilitySharedPayload = z.object({
  correlationId: z.string().min(1).max(200),
  requestId: z.uuid(),
  requestTitle: z.string().min(1).max(200),
  relationshipId: z.uuid(),
  recipientId: z.uuid(),
  expertProfileId: z.uuid(),
  expertPersonName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  sharedAtIso: z.string().datetime(),
  previousSharedAtIso: z.string().datetime().nullable(),
});

// BAL-283 — a free intro call was booked on a project-request thread (web-published, AFTER
// `POST /meetings` returns 201). `correlationId` = `${meetingId}` — an idempotent replay
// publishes the same jobId and dedups. SIBLING of `booking.confirmed`, never a reuse — no
// `engagementId`/`caseTitle` here and there never will be. Mirrors
// packages/shared/src/notifications/index.ts.
// BAL-431 / ADR-1048 — `request_file.shared_with_expert` / `.shared_with_client`. ⚠ NEITHER
// PAYLOAD CARRIES AN AUDIENCE, TRACK-COUNT OR SIBLING-NAME FIELD (ADR-1048 §3 binds the
// notification payload exactly as it binds the expert serializer) — do not widen either
// schema with one.
const requestFileSharedWithExpertPayload = z.object({
  correlationId: z.string().min(1).max(200),
  fileId: z.uuid(),
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  requestTitle: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
  sharedByPersonLabel: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
});

const requestFileSharedWithClientPayload = z.object({
  correlationId: z.uuid(),
  fileId: z.uuid(),
  requestId: z.uuid(),
  relationshipId: z.uuid(),
  recipientId: z.uuid(),
  requestTitle: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  expertPersonLabel: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
});

// BAL-540 — the request was closed. `correlationId` is the `project_request.closed` audit row
// id. `recipientUserIds` is bounded per the `expertSearchabilityLostPayload` reasoning above: a
// caller holding INTERNAL_API_SECRET must not be able to fan out unboundedly.
// ⚠ NO `.min(1)`, deliberately (a deviation from a literal reading of the plan's Zod-bounds
// list): a request closed by Balo with ZERO invited tracks still publishes — the client arm
// (gated on `recipientId`) must still fire — with a genuinely empty `recipientUserIds` (edge
// case 1 in decisions-bal-540.md's Observability section). Mirrors
// packages/shared/src/notifications/index.ts.
const projectRequestClosedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  title: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
  closedBy: z.enum(['client', 'balo']),
  reason: z.enum(PROJECT_REQUEST_CLOSE_REASONS),
  recipientUserIds: z.array(z.uuid()).max(50),
  recipientId: z.uuid().optional(),
});

// BAL-540 — one track was declined. `correlationId` is the `request_expert_relationship.declined`
// audit row id. Mirrors packages/shared/src/notifications/index.ts.
const projectTrackDeclinedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  title: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
  declinedBy: z.enum(['client', 'balo']),
  stage: z.enum(DECLINABLE_RELATIONSHIP_STATUSES),
  hadOpenProposal: z.boolean(),
});

// BAL-541 — a Balo staffer was assigned as a request's Balo owner. `correlationId` is the
// `project_request.owner_assigned` audit row id. Mirrors packages/shared/src/notifications/index.ts.
const projectRequestOwnerAssignedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  userId: z.uuid(),
  assignedByUserId: z.uuid(),
  title: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
});

const conversationIntroCallBookedPayload = z.object({
  correlationId: z.uuid(),
  meetingId: z.uuid(),
  requestId: z.uuid(),
  requestTitle: z.string().min(1).max(200),
  relationshipId: z.uuid(),
  recipientId: z.uuid(),
  expertProfileId: z.uuid(),
  clientPersonName: z.string().min(1).max(200),
  clientCompanyName: z.string().min(1).max(200),
  expertPartyLabel: z.string().min(1).max(200),
  scheduledStartIso: z.string().datetime(),
  durationMinutes: z.number().int().positive(),
  joinPath: memberJoinPathSchema,
  provisioned: z.boolean(),
  guestCount: z.number().int().nonnegative(),
});

export const publishBodySchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('user.welcome'), payload: userWelcomePayload }),
  z.object({
    event: z.literal('expert.application_submitted'),
    payload: expertApplicationSubmittedPayload,
  }),
  z.object({ event: z.literal('expert.approved'), payload: expertApprovedPayload }),
  z.object({
    event: z.literal('expert.application_declined'),
    payload: expertApplicationDeclinedPayload,
  }),
  z.object({
    event: z.literal('expert.referral_invited'),
    payload: expertReferralInvitedPayload,
  }),
  z.object({
    event: z.literal('project.request_submitted'),
    payload: projectRequestSubmittedPayload,
  }),
  z.object({
    event: z.literal('project.match_requested'),
    payload: projectMatchRequestedPayload,
  }),
  z.object({
    event: z.literal('project.exploratory_requested'),
    payload: projectExploratoryRequestedPayload,
  }),
  z.object({
    event: z.literal('project.expert_invited'),
    payload: projectExpertInvitedPayload,
  }),
  z.object({
    event: z.literal('project.eoi_submitted'),
    payload: projectEoiSubmittedPayload,
  }),
  z.object({
    event: z.literal('project.proposal_requested'),
    payload: projectProposalRequestedPayload,
  }),
  z.object({
    event: z.literal('project.proposal_submitted'),
    payload: projectProposalSubmittedPayload,
  }),
  z.object({
    event: z.literal('project.proposal_accepted'),
    payload: projectProposalAcceptedPayload,
  }),
  z.object({
    event: z.literal('project.kickoff_approved'),
    payload: projectKickoffApprovedPayload,
  }),
  z.object({
    event: z.literal('project.changes_requested'),
    payload: projectChangesRequestedPayload,
  }),
  z.object({
    event: z.literal('project.proposal_resubmitted'),
    payload: projectProposalResubmittedPayload,
  }),
  z.object({
    event: z.literal('conversation.message_posted'),
    payload: conversationMessagePostedPayload,
  }),
  z.object({
    event: z.literal('conversation.file_shared'),
    payload: conversationFileSharedPayload,
  }),
  z.object({
    event: z.literal('project.billing_reminder'),
    payload: projectBillingReminderPayload,
  }),
  z.object({
    event: z.literal('proposal.shared'),
    payload: proposalSharedPayload,
  }),
  z.object({
    event: z.literal('billing.details_confirmed'),
    payload: billingDetailsConfirmedPayload,
  }),
  z.object({
    event: z.literal('engagement.milestone_completed'),
    payload: engagementMilestoneCompletedPayload,
  }),
  z.object({
    event: z.literal('engagement.milestone_reverted'),
    payload: engagementMilestoneRevertedPayload,
  }),
  z.object({
    event: z.literal('engagement.scope_changed'),
    payload: engagementScopeChangedPayload,
  }),
  z.object({
    event: z.literal('engagement.completion_requested'),
    payload: engagementCompletionRequestedPayload,
  }),
  z.object({
    event: z.literal('engagement.completion_withdrawn'),
    payload: engagementCompletionWithdrawnPayload,
  }),
  z.object({
    event: z.literal('engagement.cancelled'),
    payload: engagementCancelledPayload,
  }),
  z.object({
    event: z.literal('engagement.accepted'),
    payload: engagementAcceptedPayload,
  }),
  z.object({
    event: z.literal('engagement.changes_requested'),
    payload: engagementChangesRequestedPayload,
  }),
  z.object({
    event: z.literal('engagement.case_closed'),
    payload: engagementCaseClosedPayload,
  }),
  z.object({
    event: z.literal('party.member_joined_via_domain'),
    payload: partyJoinEventPayload,
  }),
  z.object({
    event: z.literal('party.join_request_created'),
    payload: partyJoinEventPayload,
  }),
  z.object({
    event: z.literal('party.join_request_approved'),
    payload: partyJoinEventPayload,
  }),
  z.object({
    event: z.literal('party.join_request_declined'),
    payload: partyJoinEventPayload,
  }),
  z.object({
    event: z.literal('agency.provisioned'),
    payload: agencyProvisionedPayload,
  }),
  z.object({
    event: z.literal('company.provisioned'),
    payload: companyProvisionedPayload,
  }),
  z.object({
    event: z.literal('credit.topup.requested'),
    payload: creditTopupRequestedPayload,
  }),
  z.object({
    event: z.literal('promo.redeemed'),
    payload: promoRedeemedPayload,
  }),
  z.object({
    event: z.literal('action_item.assigned'),
    payload: actionItemAssignedPayload,
  }),
  z.object({
    event: z.literal('expert.searchability_lost'),
    payload: expertSearchabilityLostPayload,
  }),
  z.object({
    event: z.literal('expert.searchability_restored'),
    payload: expertSearchabilityRestoredPayload,
  }),
  z.object({
    event: z.literal('booking.confirmed'),
    payload: bookingConfirmedPayload,
  }),
  z.object({
    event: z.literal('booking.rescheduled'),
    payload: bookingRescheduledPayload,
  }),
  z.object({
    event: z.literal('reschedule_proposal.sent'),
    payload: rescheduleProposalSentPayload,
  }),
  z.object({
    event: z.literal('reschedule_proposal.declined'),
    payload: rescheduleProposalDeclinedPayload,
  }),
  z.object({
    event: z.literal('conversation.availability_shared'),
    payload: conversationAvailabilitySharedPayload,
  }),
  z.object({
    event: z.literal('conversation.intro_call_booked'),
    payload: conversationIntroCallBookedPayload,
  }),
  z.object({
    event: z.literal('request_file.shared_with_expert'),
    payload: requestFileSharedWithExpertPayload,
  }),
  z.object({
    event: z.literal('request_file.shared_with_client'),
    payload: requestFileSharedWithClientPayload,
  }),
  z.object({
    event: z.literal('project.request_closed'),
    payload: projectRequestClosedPayload,
  }),
  z.object({
    event: z.literal('project.track_declined'),
    payload: projectTrackDeclinedPayload,
  }),
  z.object({
    event: z.literal('project.request_owner_assigned'),
    payload: projectRequestOwnerAssignedPayload,
  }),
]);

export type PublishBody = z.infer<typeof publishBodySchema>;

/**
 * Compile-time completeness guard (BAL-284).
 *
 * `publishBodySchema` and the event catalog (`apps/api/src/notifications/events.ts`)
 * are two hand-maintained registries. They must stay in lockstep: before this guard,
 * adding a publishable event to the catalog without a matching arm here compiled
 * cleanly but **400'd every publish at runtime** — and the web-side
 * `publishNotificationEvent` swallows that 400, so the notification vanished
 * silently (no email, no in-app row, no `notification_log`). That is the exact bug
 * this ticket fixes for `project.{exploratory_requested,expert_invited,eoi_submitted}`.
 *
 * `PublishCoverageGap` is the symmetric difference between the events covered by
 * `publishBodySchema` and the publishable catalog. When they match it is `never`;
 * otherwise it is the offending event name(s). `AssertNever`'s `extends never`
 * constraint then fails `tsc` and prints the missing/stray event right here — so a
 * new event without a schema arm (or an arm for a server-only event like
 * `calendar.auth_error`) can never ship silently again.
 */
// Split per direction so neither branch forms a `never | never` union (S6571)
// while keeping the exact guarantee: a missing schema arm OR a stray one fails
// `tsc` and prints the offending event right here.
type MissingSchemaArm = Exclude<PublishableNotificationEvent, PublishBody['event']>;
type StraySchemaArm = Exclude<PublishBody['event'], PublishableNotificationEvent>;

type AssertNever<T extends never> = T;

export type AssertPublishCoverageComplete = [
  AssertNever<MissingSchemaArm>,
  AssertNever<StraySchemaArm>,
];

/**
 * Compile-time PAYLOAD-SHAPE guard (BAL-427) — the sibling of `AssertPublishCoverageComplete`
 * above, one level deeper.
 *
 * That guard proves every publishable event NAME has an arm here. It says nothing about the
 * arm's SHAPE. So a payload interface and its Zod arm could disagree — a widened union, a
 * renamed field, an added property — and still compile: the web publisher typechecks against
 * the interface, this schema validates the wire body, and the mismatch only surfaces as a 400
 * at runtime. `publishNotificationEvent` swallows that 400 by contract
 * (`apps/web/src/lib/notifications/publish.ts` — a notification hiccup must NEVER break the
 * user-facing action), so the notification vanished silently: no email, no in-app row, no
 * `notification_log`. Exactly the failure mode the docblock above describes, one layer down.
 * The live instance BAL-427 found: `ProjectChangesRequestedPayload.section` was `string` while
 * this file validated a five-value enum.
 *
 * `SameShape` asserts mutual assignability AND identical key sets between each arm's inferred
 * payload and the catalog's `EventPayloadMap` entry. `AssertNever` then fails `tsc` right here
 * and names the offending event(s).
 *
 * ⚠ THE MAPPED-TYPE LOOKUP IS INLINED INSIDE `AssertNever` ON PURPOSE — DO NOT EXTRACT IT TO A
 * NAMED ALIAS. With an alias, tsc prints the alias name and HIDES the events as soon as more
 * than one arm diverges ("Type 'PayloadShapeMismatch' does not satisfy the constraint 'never'").
 * Inlined, it prints the union of offending event names every time
 * ("Type '"expert.approved" | "engagement.scope_changed"' does not satisfy…"). Naming the event
 * is the whole point of this guard.
 *
 * ⚠ WHY THE `keyof` CHECK EXISTS. Mutual assignability alone does NOT see an OPTIONAL property
 * present on one side only — optional props are assignable in both directions. That is a live
 * hazard, not a theoretical one: Zod v4 `z.object()` STRIPS unknown keys rather than rejecting
 * them, so a payload that gains an optional field in TS but not in its arm here publishes a
 * clean 200 with the field silently dropped — and a recipient silently never notified. Comparing
 * key sets closes it AT THE TOP LEVEL. Verified: green across all arms today, and it catches an
 * added `.optional()` that the assignability check alone waves through — as long as that field
 * is added directly on the object, not nested inside one. See L4 below for the gap that leaves.
 *
 * ⚠⚠ WHAT THIS GUARD DOES **NOT** CATCH — four documented limits. Do not read it as total.
 *
 *   L1. CONSTRAINT drift. `z.infer` erases refinements: `z.string().min(1).max(4000)` infers a
 *       plain `string`. `ProjectChangesRequestedPayload.note` is `string` in TS and `.min(1)`
 *       here, so publishing an empty note still 400s silently and this guard stays green. Same
 *       for `.uuid()`, `.max(n)`, `.email()`, and `memberJoinPathSchema`'s regex. DO NOT try to
 *       encode length bounds or formats into the TS types — that trades a small invisible gap
 *       for a large unreadable one. Bounds are validated here and only here, on purpose.
 *   L2. DEFAULTS and transforms. `.default(...)` makes `z.input` and `z.output` differ; this
 *       guard compares against `z.infer` (= output). No publish arm uses one today.
 *   L3. THE WEB MIRROR. This binds `publishBodySchema` to the API-side catalog
 *       (`apps/api/src/notifications/events.ts`). The web publisher compiles against its OWN
 *       mirror at `apps/web/src/lib/notifications/types.ts`, and neither app can import the
 *       other — that separation is why the mirror exists. ~15 payload interfaces are declared in
 *       both files; they are field-for-field identical today, but a web-side edit to one of them
 *       would still drift past this guard. The durable fix is migrating those stragglers into
 *       `@balo/shared/notifications` (that module's header already says "migrate
 *       opportunistically"); every payload that lives there is bound on BOTH sides by
 *       construction. Not in BAL-427's scope.
 *   L4. NESTING. The `keyof` comparison above is TOP-LEVEL ONLY — it compares the outer
 *       object's own key sets, not the keys of any object nested inside an array or nested
 *       object field. `SameShape<{x:{k:string}[]},{x:{k:string;c?:string}[]}>` evaluates to
 *       `true`: mutual assignability holds for arrays of structurally-compatible-enough element
 *       types and the outer `keyof` sees only `x` on both sides, so the extra nested `c` is
 *       invisible to this guard. The live surface is `proposalSharedPayload.attachments[]`
 *       (below) — the one arm whose payload nests an object inside an array. A nested optional
 *       added to `ProposalSharedPayload['attachments'][number]` on only one side compiles clean
 *       here, and Zod v4 strips it on the wire at publish time: the exact silent-drop failure
 *       this guard exists to prevent, one level deeper than it currently looks. Recursing the
 *       comparison is out of scope for BAL-427 — this is a documented limit, not a fix.
 *
 * SCOPE NOTE (BAL-427, D3) — enum tuples were single-sourced for exactly four fields
 * (`section`, `changeKind`, `reason`, `stage`), not for all ~17 enum-valued fields. The shape
 * guard makes the remaining independent spellings SAFE (they cannot diverge without failing
 * here), so consolidating them buys churn, not safety. ⚠ In particular: `initiatedBy` is spelled
 * TWICE with GENUINELY DIFFERENT value sets — `['client','admin']` on
 * `project.proposal_requested` and `['client','expert']` on `booking.rescheduled`. They are
 * different domain concepts. A field-name-driven "let's finish single-sourcing `initiatedBy`"
 * would silently merge them. DO NOT.
 */
type CoveredPublishArm = Extract<PublishBody['event'], keyof EventPayloadMap>;

type PublishArmPayload<E extends PublishBody['event']> = Extract<
  PublishBody,
  { event: E }
>['payload'];

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type SameShape<A, B> =
  MutuallyAssignable<A, B> extends true
    ? MutuallyAssignable<keyof A, keyof B> extends true
      ? true
      : false
    : false;

/**
 * A schema arm whose event has no `EventPayloadMap` entry. Without this, the mapped type below
 * would fail to index and tsc would emit an opaque "cannot be used to index" error instead of
 * naming the event.
 */
export type AssertEveryPublishArmHasAPayloadMapEntry = AssertNever<
  Exclude<PublishBody['event'], keyof EventPayloadMap>
>;

export type AssertPublishPayloadShapesMatch = AssertNever<
  {
    [E in CoveredPublishArm]: SameShape<PublishArmPayload<E>, EventPayloadMap[E]> extends true
      ? never
      : E;
  }[CoveredPublishArm]
>;

/**
 * NON-VACUITY CONTROLS — these keep the guard honest without a test file. Each probe resolves to
 * `never` only while `SameShape` behaves correctly; if a refactor ever makes it answer `true`
 * unconditionally (the way a guard silently dies), the matching `AssertNever` goes red here.
 * `IdenticalShapesProbe` is the positive control: it goes red if `SameShape` starts rejecting
 * shapes that genuinely match.
 */
type IdenticalShapesProbe = SameShape<{ a: string }, { a: string }> extends true ? never : 'a';
type FieldTypeDriftProbe = SameShape<{ a: string }, { a: number }> extends true ? 'b' : never;
type WidenedUnionProbe = SameShape<{ a: 'x' }, { a: 'x' | 'y' }> extends true ? 'c' : never;
type ExtraOptionalFieldProbe =
  SameShape<{ a: string }, { a: string; b?: number }> extends true ? 'd' : never;
/**
 * `NarrowedZodProbe` — catches a degradation of `MutuallyAssignable` to ONE direction only
 * (e.g. `[B] extends [A]`). All four probes above stay green under that degradation: they never
 * exercise a pair where only the reverse direction fails. `{ a: string }` vs `{ a: 'x' }` does —
 * `'x'` is assignable to `string` but not the other way — so a one-directional check would wave
 * this through as `true`. If `MutuallyAssignable` is ever narrowed to one direction, this probe
 * goes red.
 */
type NarrowedZodProbe = SameShape<{ a: string }, { a: 'x' }> extends true ? 'e' : never;

export type AssertShapeGuardIsNotVacuous = [
  AssertNever<IdenticalShapesProbe>,
  AssertNever<FieldTypeDriftProbe>,
  AssertNever<WidenedUnionProbe>,
  AssertNever<ExtraOptionalFieldProbe>,
  AssertNever<NarrowedZodProbe>,
];
