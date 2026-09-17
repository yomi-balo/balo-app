import { z } from 'zod';
import { STAFF_ACCESS_ROLE_ORDER } from './staff-access-roles';

/**
 * BAL-561 — the client-safe input schemas for the two Staff access Server Actions. Client-safe
 * (no `server-only`, no DB import) so both the `'use client'` components building these payloads
 * and the `'use server'` actions parsing them can import it.
 *
 * ⚠ `customList` IS `z.string()`, NOT `z.enum(PLATFORM_CAPABILITIES ...)`, DELIBERATELY. An
 * unknown token must reach the mutator and come back as the named `unknown_capability` refusal —
 * ONE definition of "known" (`@balo/shared/authz/staff-access`'s `validateStaffAccessDraft`), not
 * a second one duplicated into a Zod enum that could drift from the axis.
 *
 * `.email()` on a TRIMMED string (`z.string().trim()` runs before `.email()`) means a partial
 * address like `'dana@'` or `'dana@northwind'` fails validation, so nothing is looked up — the
 * lookup action never runs a query for malformed input.
 */
export const staffAccessStateSchema = z
  .object({
    role: z.enum(STAFF_ACCESS_ROLE_ORDER),
    customList: z.array(z.string().min(1).max(64)).max(64).nullable(),
  })
  .strict();

export const saveStaffAccessInputSchema = z
  .object({
    targetUserId: z.uuid(),
    expected: staffAccessStateSchema,
    next: staffAccessStateSchema,
  })
  .strict();

export const findStaffCandidateInputSchema = z
  .object({ email: z.string().trim().max(254).email() })
  .strict();

export type SaveStaffAccessActionInput = z.infer<typeof saveStaffAccessInputSchema>;
export type FindStaffCandidateActionInput = z.infer<typeof findStaffCandidateInputSchema>;
