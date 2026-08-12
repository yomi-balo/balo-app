import 'server-only';

import { z } from 'zod';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { hasCapability, CAPABILITIES } from '@/lib/authz';
import { log } from '@/lib/logging';
import { resolveRecapAccess } from '@/lib/meetings/resolve-recap-access';

/**
 * BAL-388 — THE SHARED AUTHORIZATION PREAMBLE FOR THE RECAP CASE MUTATIONS.
 *
 * ⚠⚠ EXTRACTED, NOT INVENTED. `resolve-case.ts` and `dismiss-resolution-request.ts` had
 * ~38 verbatim lines between them — the signed-in wrapper, the Zod parse, the gate + lens +
 * contextType triple, the capability check and the derived engagement id — differing only in
 * one error string, which SonarCloud normalises. That is precisely the >3% new-code
 * duplication shape the gate exists to catch, and it is worse than a style problem: FIVE gates
 * copy-pasted into two files drift independently, and the copy that drifts is the one nobody
 * re-reads.
 *
 * ⚠ NOT a `use server` module, deliberately. It exports a non-async-safe type alongside its
 * function and is only ever CALLED by the two Server Actions, so it must not itself be a
 * server-action entry point (a `use server` file may export async functions only).
 *
 * THE FOUR GATES, IN THIS ORDER, AND THE ORDER IS PART OF THE CONTRACT:
 *   1. `requireOnboardedUser()` — mandatory for a mutation. Server Actions bypass middleware.
 *   2. Zod `.strict()` — the meetingId is the ONLY thing trusted from input. There is no
 *      `engagementId` field, so a caller cannot name a case they could not otherwise reach.
 *   3. `resolveRecapAccess` — the SAME read gate the page uses, re-run in full, then asserted
 *      to be the CLIENT lens on a `case` context. An expert can NEVER close a case (BAL-417).
 *   4. `hasCapability(..., PARTICIPATE, { companyId })` — the MEMBERSHIP axis, with the
 *      `companyId` taken from THE GATE and never from input (ADR-1029).
 *
 * ⚠ `expertProfileId` IS NARROWED **AT THE GATE**, not defended against downstream.
 * `engagements.expert_profile_id` is `.notNull()`, so on a `case` context it can never be null
 * and a later `if (expertProfileId !== null)` would be a dead branch guarding the review token
 * AND the close publish — untested, uncovered, and silently email-less if it ever did fire.
 * Narrowing here collapses it into the same single denial literal every other miss uses.
 *
 * ⚠ ONE DENIAL LITERAL. Gate-null, wrong lens, non-case and a nameless expert all return the
 * same copy, so the action is never an existence oracle over `meetings.id`.
 */

const recapMutationSchema = z.object({ meetingId: z.uuid() }).strict();

export type RecapCaseMutationGate =
  | {
      ok: true;
      user: SessionUser;
      meetingId: string;
      /** A `case` context contextId IS the engagement id — derived, never supplied. */
      engagementId: string;
      companyId: string;
      /** Never null on a `case` — narrowed here so no caller re-defends it. */
      expertProfileId: string;
    }
  | { ok: false; error: string };

const UNAVAILABLE = 'This recap is no longer available.';

/**
 * Resolve the acting user and the case they are mutating, or a user-facing refusal.
 *
 * @param deniedCapabilityCopy the message for an authenticated NON-participant. It is the ONLY
 * thing that differs between the two call sites, so it is a parameter rather than a fork.
 */
export async function authorizeRecapCaseMutation(
  input: { meetingId: string },
  deniedCapabilityCopy: string
): Promise<RecapCaseMutationGate> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { ok: false, error: 'You are not signed in.' };
  }

  const parsed = recapMutationSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: 'Invalid request.' };
  }
  const { meetingId } = parsed.data;

  try {
    const access = await resolveRecapAccess(meetingId, user.id);
    if (
      access === null ||
      access.lens !== 'client' ||
      access.subject.contextType !== 'case' ||
      access.expertProfileId === null
    ) {
      return { ok: false, error: UNAVAILABLE };
    }

    const allowed = await hasCapability(user, CAPABILITIES.PARTICIPATE, {
      companyId: access.companyId,
    });
    if (!allowed) {
      return { ok: false, error: deniedCapabilityCopy };
    }

    return {
      ok: true,
      user,
      meetingId,
      engagementId: access.subject.contextId,
      companyId: access.companyId,
      expertProfileId: access.expertProfileId,
    };
  } catch (error) {
    log.error('Recap case mutation authorization failed', {
      meetingId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
