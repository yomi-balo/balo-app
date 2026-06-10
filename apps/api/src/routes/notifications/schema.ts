import { z } from 'zod';

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
// relationship id — dedup per proposal request. Mirrors
// apps/web/src/lib/notifications/types.ts.
const projectProposalRequestedPayload = z.object({
  correlationId: z.uuid(),
  projectRequestId: z.uuid(),
  relationshipId: z.uuid(),
  expertProfileId: z.uuid(),
  title: z.string().min(1).max(200),
});

// TODO(BAL-284): known gap — three pre-existing web-published events are missing
// from this union ('project.exploratory_requested', 'project.expert_invited',
// 'project.eoi_submitted'); they currently 400 at the publish route. BAL-284
// adds them (out of scope for BAL-272).
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
    event: z.literal('project.proposal_requested'),
    payload: projectProposalRequestedPayload,
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
