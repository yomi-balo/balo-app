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
]);

export type PublishBody = z.infer<typeof publishBodySchema>;
