'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { runSubmitEoi } from './_shared/submit-eoi-core';
import type { SubmitEoiInput, SubmitEoiResult } from './_shared/submit-eoi-core';

export type { SubmitEoiResult } from './_shared/submit-eoi-core';

/**
 * Expert EOI submission (BAL-270 / A3).
 *
 * IDOR-safe by construction: the input is `{ requestId, message }` ONLY — the
 * `relationshipId` is NEVER accepted from the client. It is derived server-side by
 * loading the request graph and resolving the viewer's lens (the same
 * authorization the page uses); the resolver only yields a `relationshipId` for a
 * LIVE, non-declined relationship whose `expertProfileId === user.expertProfileId`.
 *
 * Branches off the hydrated relationship status + live-EOI presence:
 *  - first EOI (relationship `invited`) → `submit()` — atomically advances the
 *    relationship AND derives the request-level status (ADR-1025 / BAL-295), so no
 *    separate request transition is issued here;
 *  - resubmit (relationship `eoi_submitted`, no live EOI) → `resubmit()`, which
 *    does not move the relationship and so leaves the request status unchanged;
 *  - already has a live EOI → friendly pre-check error.
 *
 * The `transitioned` analytics flag is re-sourced by comparing the request status
 * BEFORE vs a fresh `findById` re-read AFTER the relationship op — truthful (reads
 * the committed post-derivation status) without re-issuing the now-redundant
 * request transition.
 *
 * Fires a client-facing `project.eoi_submitted` notification (fire-and-forget) and
 * returns `timeToEoiMs` for the island to attach to analytics.
 */
export async function submitEoiAction(input: SubmitEoiInput): Promise<SubmitEoiResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  return runSubmitEoi(user, input);
}
