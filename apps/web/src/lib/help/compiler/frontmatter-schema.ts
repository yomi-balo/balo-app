import { z } from 'zod';
import { HELP_AUDIENCES } from '@balo/analytics/events';

const audienceSchema = z.enum(HELP_AUDIENCES);

/** The frontmatter of a `docs/help/*.md` guide. Unknown keys are rejected. */
export const helpFrontmatterSchema = z.strictObject({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  audience: z
    .array(audienceSchema)
    .min(1)
    .refine((audiences) => new Set(audiences).size === audiences.length, {
      message: 'audience must not repeat a value',
    }),
  category: z.partialRecord(audienceSchema, z.string().min(1)),
  order: z.number().int().min(0),
  published: z.boolean(),
  updated: z.iso.date(),
  related: z.array(z.string().min(1)),
  slug: z.string().min(1).optional(),
});

export type HelpFrontmatter = z.infer<typeof helpFrontmatterSchema>;
