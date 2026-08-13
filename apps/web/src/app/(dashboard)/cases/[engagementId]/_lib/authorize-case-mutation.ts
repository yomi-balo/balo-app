import 'server-only';

import { z } from 'zod';
import { caseEngagementsRepository, type CaseEngagementRow } from '@balo/db';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { errorMessage, log } from '@/lib/logging';
import { resolveCaseAccess } from '@/lib/cases/resolve-case-access';

/**
 * BAL-421 — THE SHARED AUTHORIZATION PREAMBLE FOR THE CASE-SURFACE MUTATIONS (close, and the
 * expert's resolution request). The engagement-grain sibling of
 * `meetings/[meetingId]/_lib/authorize-recap-case-mutation.ts`.
 *
 * ⚠ NOT a `'use server'` module, deliberately. It exports a TYPE alongside its function, and
 * a `'use server'` file may export async functions only (memory
 * `reference_use_server_no_value_exports`). Same ruling as its recap sibling.
 *
 * ── ⚠⚠ HOW THE ANTI-ORACLE PROPERTY SURVIVES A GRAIN WHERE THE ID *IS* THE ENGAGEMENT ID ──
 *
 * `authorizeRecapCaseMutation` achieves it by REFUSING TO ACCEPT an engagement id at all
 * ("there is deliberately no `engagementId` field so a caller cannot name a case they could
 * not otherwise reach"). That is structurally impossible here: the case surface's subject IS
 * the engagement. So the property is preserved a different way — by re-deriving EVERY
 * authorization input from the LOADED ROW and never from input:
 *
 *   1. `requireOnboardedUser()` — mandatory for a mutation. Server Actions bypass middleware,
 *      so this is the only thing standing between an un-onboarded session and a write.
 *   2. Strict Zod — `engagementId` is the ONLY trusted input, and it is a SUBJECT, never a
 *      CLAIM. It names what to act on; it asserts nothing about who may.
 *   3. `resolveCaseAccess` — the FULL tenancy gate, re-run. Actions bypass middleware and must
 *      NEVER trust the page's earlier decision.
 *   4. `findByEngagementId` — the case-TYPE coherence check, AFTER authorization (BAL-129).
 *   5. `companyId` comes from `access.companyId` — i.e. from the LOADED `engagements` row via
 *      the gate — NEVER from `user.companyId` and NEVER from input (ADR-1029).
 *
 * ⚠ THE PROPERTY THAT MATTERS IS UNCHANGED: **naming a case you cannot reach yields exactly
 * the same refusal as naming one that does not exist.** Gate-null, non-case and not-found all
 * return ONE literal; the distinguishing reason goes to `log.warn` inside the gate only.
 *
 * ⚠ THIS GATE DOES NOT DECIDE THE CAPABILITY. It resolves WHO is acting and WHAT on, and
 * reports the lens; each action then checks its OWN axis — `PARTICIPATE` on the MEMBERSHIP
 * axis for the close, `MANAGE_ENGAGEMENT` on the ENGAGEMENT axis for the resolution request.
 * Those are different axes with different holder sets, so folding either into here would
 * force one of them to be wrong.
 */

const caseMutationSchema = z.object({ engagementId: z.uuid() }).strict();

export type CaseMutationGate =
  | {
      ok: true;
      user: SessionUser;
      engagementId: string;
      /** From the LOADED engagement row via the gate. Never the session, never input. */
      companyId: string;
      /** Never null on the supertype (BAL-417) — narrowed so no caller re-defends it. */
      expertProfileId: string;
      lens: 'client' | 'expert';
      /** Threaded back so the action never re-reads the case (nor can disagree with it). */
      caseRow: CaseEngagementRow;
    }
  | { ok: false; error: string };

/** ONE literal for gate-null, non-case and not-found alike. */
const UNAVAILABLE = 'This case is no longer available.';

export async function authorizeCaseMutation(input: {
  engagementId: string;
}): Promise<CaseMutationGate> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { ok: false, error: 'You are not signed in.' };
  }

  const parsed = caseMutationSchema.safeParse(input);
  if (!parsed.success) {
    // ⚠ BEFORE ANY DB READ — a malformed id never reaches a repository.
    return { ok: false, error: 'Invalid request.' };
  }
  const { engagementId } = parsed.data;

  try {
    const access = await resolveCaseAccess(engagementId, user.id);
    if (access === null) {
      return { ok: false, error: UNAVAILABLE };
    }

    // ⚠ COHERENCE **AFTER** AUTHORIZATION (BAL-129). `findByEngagementId` filters
    // `engagement_type = 'case'` and both `deleted_at`s, so a PROJECT engagement id and a
    // CROSS-TENANT id produce the SAME refusal and this check can never be an oracle.
    const caseRow = await caseEngagementsRepository.findByEngagementId(engagementId);
    if (caseRow === undefined) {
      return { ok: false, error: UNAVAILABLE };
    }

    return {
      ok: true,
      user,
      engagementId,
      companyId: access.companyId,
      expertProfileId: access.expertProfileId,
      lens: access.lens,
      caseRow,
    };
  } catch (error) {
    log.error('Case mutation authorization failed', {
      engagementId,
      userId: user.id,
      error: errorMessage(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}
