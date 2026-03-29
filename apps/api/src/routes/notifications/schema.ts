import { z } from 'zod';

const userWelcomePayload = z.object({
  correlationId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.enum(['client', 'expert']),
});

const expertApplicationSubmittedPayload = z.object({
  correlationId: z.string().uuid(),
  userId: z.string().uuid(),
  applicationId: z.string().uuid(),
});

export const publishBodySchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('user.welcome'), payload: userWelcomePayload }),
  z.object({
    event: z.literal('expert.application_submitted'),
    payload: expertApplicationSubmittedPayload,
  }),
]);

export type PublishBody = z.infer<typeof publishBodySchema>;
