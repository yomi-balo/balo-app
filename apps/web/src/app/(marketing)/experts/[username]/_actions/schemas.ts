import { z } from 'zod';

export const projectRequestInputSchema = z.object({
  expertProfileId: z.string().uuid(),
  title: z.string().trim().min(3, 'Give your project a title').max(200),
  description: z.string().trim().min(10, 'Add a sentence or two about what you need').max(5000),
  focusArea: z.string().trim().max(100).nullable().optional(),
  budget: z.string().trim().max(50).nullable().optional(),
  timeline: z.string().trim().max(50).nullable().optional(),
  source: z.enum(['manual', 'ai', 'quickstart']).default('manual'),
});

export type ProjectRequestInput = z.infer<typeof projectRequestInputSchema>;
