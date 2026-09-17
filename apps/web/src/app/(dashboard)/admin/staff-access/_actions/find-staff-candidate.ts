'use server';
import 'server-only';

import { usersRepository } from '@balo/db';
import { log } from '@/lib/logging';
import { requireStaffAccessManager } from './_shared/require-staff-access-manager';
import {
  findStaffCandidateInputSchema,
  type FindStaffCandidateActionInput,
} from '../_lib/staff-access-schema';
import {
  STAFF_CANDIDATE_MESSAGES,
  type FindStaffCandidateActionResult,
} from '../_lib/staff-access-outcome';

/**
 * BAL-561 (ruling 3) — "Give someone access" step 1: look up a live account by exact,
 * case-insensitive email. LIVE-GATED, like `saveStaffAccessAction`: the lookup reveals whether an
 * account exists at all, which is exactly the kind of fact a revoked-but-still-cookied caller
 * must not get to probe for up to seven days.
 *
 * A miss, a soft-deleted account, and a suspended account all return the same `not_found` — the
 * repository's `findStaffCandidateByEmail` already collapses those (ruling 3); this action adds
 * no second distinction on top.
 *
 * ⚠ NEVER LOG THE EMAIL. The catch block logs only the actor and the error — an email address is
 * PII, and this is a lookup path an attacker could otherwise use to fish log output.
 */
export async function findStaffCandidateAction(
  input: FindStaffCandidateActionInput
): Promise<FindStaffCandidateActionResult> {
  const auth = await requireStaffAccessManager();
  if (!auth.ok) {
    return { success: false, code: 'denied', error: auth.error };
  }

  const parsed = findStaffCandidateInputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, code: 'invalid', error: STAFF_CANDIDATE_MESSAGES.invalid };
  }

  try {
    // Already trimmed by Zod — never re-lowercased here (the repository's `lower()` comparison
    // is the ONE place casing is folded, matching the `users_email_lower_unique` index it relies on).
    const person = await usersRepository.findStaffCandidateByEmail(parsed.data.email);
    if (person === undefined) {
      return { success: false, code: 'not_found', error: STAFF_CANDIDATE_MESSAGES.not_found };
    }
    return { success: true, person };
  } catch (error) {
    log.error('Staff candidate lookup failed', {
      actorUserId: auth.user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, code: 'failed', error: STAFF_CANDIDATE_MESSAGES.failed };
  }
}
