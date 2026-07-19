import { z } from 'zod';
import type { PublishableNotificationEvent } from '../../notifications/events.js';

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

// BAL-271 conversation events. `recipientId` is set when recipientRole==='client'
// (dispatcher 'client' path); `expertProfileId` when recipientRole==='expert'
// (resolver hydrates data.expert). Mirrors apps/web/src/lib/notifications/types.ts.
const projectMessagePostedPayload = z.object({
  correlationId: z.uuid(), // message id — dedup per message
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  title: z.string().min(1),
  senderName: z.string().min(1),
  recipientRole: z.enum(['client', 'expert']),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid().optional(),
  preview: z.string().max(200),
});

const projectFileSharedPayload = z.object({
  correlationId: z.uuid(), // file id — dedup per share
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  title: z.string().min(1),
  senderName: z.string().min(1),
  recipientRole: z.enum(['client', 'expert']),
  recipientId: z.uuid().optional(),
  expertProfileId: z.uuid().optional(),
  fileName: z.string().min(1).max(255),
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
  section: z.enum(['general', 'milestones', 'pricing', 'payment_terms', 'timeline']),
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
  changeKind: z.enum(['added', 'edited', 'removed']),
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
// Mirrors packages/shared/src/notifications/index.ts.
const engagementAcceptedPayload = z.object({
  correlationId: z.string().min(1).max(120),
  engagementId: z.uuid(),
  expertProfileId: z.uuid(),
  actorClientLabel: z.string().min(1).max(200),
  projectTitle: z.string().min(1).max(200),
  acceptedOn: z.string().min(1).max(40),
  milestonesTotal: z.number().int().nonnegative(),
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

export const publishBodySchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('user.welcome'), payload: userWelcomePayload }),
  z.object({
    event: z.literal('expert.application_submitted'),
    payload: expertApplicationSubmittedPayload,
  }),
  z.object({ event: z.literal('expert.approved'), payload: expertApprovedPayload }),
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
    event: z.literal('project.message_posted'),
    payload: projectMessagePostedPayload,
  }),
  z.object({
    event: z.literal('project.file_shared'),
    payload: projectFileSharedPayload,
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
