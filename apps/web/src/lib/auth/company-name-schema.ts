import { z } from 'zod';

/**
 * Shared company-name validation for the BAL-350 onboarding company step.
 *
 * PURE module (no `'server-only'`, no I/O) so it can be imported by BOTH the
 * client step (`company-step.tsx`, via `zodResolver`) and the server action
 * (`name-workspace-and-complete.ts`, via `safeParse`). Single source of truth for
 * the rule + its user-facing messages, so the two validations can never drift.
 */
export const companyNameSchema = z.object({
  companyName: z
    .string()
    .trim()
    .min(1, 'Enter a name for your workspace')
    .max(120, 'That name is too long'),
});

export type CompanyNameForm = z.infer<typeof companyNameSchema>;
