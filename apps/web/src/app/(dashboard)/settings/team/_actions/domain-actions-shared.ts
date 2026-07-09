import 'server-only';

import { z } from 'zod';
import { companiesRepository, type DomainCaptureResult, type PartyType } from '@balo/db';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import {
  cleanDomainInput,
  isValidDomainFormat,
  DOMAIN_EMPTY_MESSAGE,
  DOMAIN_INVALID_FORMAT_MESSAGE,
} from '@/lib/domain-input';
import { partyScopeOf, type ActionResult } from './join-request-shared';

/**
 * Shared, non-action helpers for the BAL-347 admin domain Server Actions (add /
 * remove). Like `join-request-shared.ts`, this has NO `'use server'` directive — it
 * is a `server-only` helper module imported by the thin action files, so the input
 * schema + capability gate + outcome→copy mapping + revalidate target live ONCE
 * (Sonar new-code duplication gate). The pure domain cleanup/format lives in the
 * client-safe `@/lib/domain-input` (shared with the client add-domain form).
 */

export type { ActionResult };

/**
 * The add-domain Server Action input. `domain` is normalised (trim/lowercase/strip)
 * then asserted against the hostname format — so an invalid domain fails here,
 * WITHOUT hitting the DB, with the design's actionable copy. `partyType`/`partyId`
 * are validated for shape only; the capability gate re-checks them server-side.
 */
export const domainInputSchema = z.object({
  partyType: z.enum(['company', 'agency']),
  partyId: z.uuid(),
  domain: z
    .string()
    .max(255)
    .transform((raw) => cleanDomainInput(raw))
    .refine((d) => d.length > 0, { message: DOMAIN_EMPTY_MESSAGE })
    .refine((d) => isValidDomainFormat(d), { message: DOMAIN_INVALID_FORMAT_MESSAGE }),
});

export type DomainInput = z.infer<typeof domainInputSchema>;

/**
 * Extract the user-facing error for a failed `domainInputSchema` parse — the
 * domain-path message when present (the actionable copy), else a generic fallback
 * for a malformed partyType/partyId (only reachable via a tampered request).
 */
export function domainParseError(error: z.ZodError): string {
  const domainIssue = error.issues.find((issue) => issue.path[0] === 'domain');
  return domainIssue?.message ?? 'Invalid request.';
}

/**
 * Gate the actor on `MANAGE_MEMBERS` for the party. Returns a friendly deny
 * `ActionResult` when the actor lacks the capability, or `null` when allowed. The
 * scope is branched off `partyType` (reusing `partyScopeOf`) so an agency scope
 * never reads a company membership.
 */
export async function manageGate(
  actor: { id: string },
  partyType: PartyType,
  partyId: string
): Promise<ActionResult | null> {
  const allowed = await hasCapability(
    actor,
    CAPABILITIES.MANAGE_MEMBERS,
    partyScopeOf({ partyType, partyId })
  );
  return allowed ? null : { success: false, error: 'You do not have permission to do this.' };
}

/**
 * Mirror the company page's `isPersonal` guard for the company Server Actions
 * (BAL-347). The `/settings/team` page `notFound()`s for a personal workspace, but a
 * user who owns their own personal workspace still holds `MANAGE_MEMBERS` on it — so
 * without this an actor could invoke these actions directly to squat arbitrary domains
 * platform-wide. Loads the company (companies has NO `deleted_at` → `findById` returns
 * the row or `undefined`) and returns a friendly deny `ActionResult` when the company
 * is MISSING or PERSONAL, else `null`. COMPANY path only — the agency path has no
 * `isPersonal` concept, so the caller applies this guard for `partyType === 'company'`
 * only (and unconditionally for the company-only join-mode action).
 */
export async function assertRealCompany(companyId: string): Promise<ActionResult | null> {
  const company = await companiesRepository.findById(companyId);
  if (company === undefined || company.isPersonal) {
    return { success: false, error: "This isn't available for personal workspaces." };
  }
  return null;
}

/**
 * Map a `DomainCaptureResult` (from `addDomain`) to an `ActionResult` + the design's
 * edge-case copy. The other organisation is NEVER named (privacy). `captured` is the
 * only success; the caller emits analytics + revalidates on that branch.
 */
export function mapAddOutcomeToResult(result: DomainCaptureResult, domain: string): ActionResult {
  switch (result.outcome) {
    case 'captured':
      return { success: true };
    case 'already_owned':
      return { success: false, error: `${domain} is already on your list.` };
    case 'not_applicable':
      return { success: false, error: DOMAIN_EMPTY_MESSAGE };
    case 'skipped':
      if (result.reason === 'blocked_domain') {
        return {
          success: false,
          error: `${domain} is a personal email provider, so teammates can't be recognised by it. Use a domain your organisation owns.`,
        };
      }
      return {
        success: false,
        error: `${domain} is already connected to another organisation on Balo. Each domain can belong to just one. If it should be yours, contact support to claim it.`,
      };
  }
}

/**
 * The `revalidatePath` target for a party's admin surface: company → `/settings/team`
 * (Domains + Mode + Queue), agency → `/expert/settings` (the Domains tab lives under
 * it). Structural, not conditional — keeps the two surfaces in lock-step.
 */
export function revalidateTargetForParty(partyType: PartyType): string {
  return partyType === 'company' ? '/settings/team' : '/expert/settings';
}
