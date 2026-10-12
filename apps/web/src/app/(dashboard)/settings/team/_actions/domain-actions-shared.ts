import 'server-only';

import { companiesRepository } from '@balo/db';
import type { ActionResult } from './join-request-shared';

/**
 * Shared, non-action helpers for the company join-mode Server Action. Like
 * `join-request-shared.ts`, this has NO `'use server'` directive — it is a `server-only`
 * helper module imported by the thin action files.
 */

export type { ActionResult };

/**
 * Mirror the company page's `isPersonal` guard for the company Server Actions. The
 * `/settings/team` page `notFound()`s for a personal workspace, but a user who owns their own
 * personal workspace still holds `MANAGE_MEMBERS` on it — so without this an actor could
 * invoke these actions directly against a workspace that has no member-management surface.
 * Loads the company (companies has NO `deleted_at` → `findById` returns the row or
 * `undefined`) and returns a friendly deny `ActionResult` when the company is MISSING or
 * PERSONAL, else `null`.
 */
export async function assertRealCompany(companyId: string): Promise<ActionResult | null> {
  const company = await companiesRepository.findById(companyId);
  if (company === undefined || company.isPersonal) {
    return { success: false, error: "This isn't available for personal workspaces." };
  }
  return null;
}
