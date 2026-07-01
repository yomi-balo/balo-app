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

export const publishBodySchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('user.welcome'), payload: userWelcomePayload }),
  z.object({
    event: z.literal('expert.application_submitted'),
    payload: expertApplicationSubmittedPayload,
  }),
  z.object({ event: z.literal('expert.approved'), payload: expertApprovedPayload }),
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
type PublishCoverageGap =
  | Exclude<PublishableNotificationEvent, PublishBody['event']>
  | Exclude<PublishBody['event'], PublishableNotificationEvent>;

type AssertNever<T extends never> = T;

export type AssertPublishCoverageComplete = AssertNever<PublishCoverageGap>;
