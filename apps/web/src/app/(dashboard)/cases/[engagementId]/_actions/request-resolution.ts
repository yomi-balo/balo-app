'use server';

import 'server-only';

import { revalidatePath } from 'next/cache';
import { caseEngagementsRepository } from '@balo/db';
import { ENGAGEMENT_CAPABILITIES } from '@balo/shared/authz';
import { hasEngagementCapability } from '@/lib/authz/engagement';
import { log } from '@/lib/logging';
import { authorizeCaseMutation } from '../_lib/authorize-case-mutation';
import type { CaseActionResult } from './_types/case-action-types';

/**
 * BAL-421 — THE EXPERT ASKS WHETHER THE CASE IS RESOLVED. The mirror of BAL-388's client-side
 * dismissal, and **THE FIRST `apps/web` CONSUMER OF THE ENGAGEMENT-CAPABILITY AXIS.**
 *
 * ⚠⚠ THIS IS THE ACT AXIS, NOT THE MEMBERSHIP AXIS, AND THE DIFFERENCE IS THE WHOLE POINT.
 * ADR-1046 lists "request case resolution" BY NAME as a `manage_engagement` act, so the gate
 * is `hasEngagementCapability(actor, MANAGE_ENGAGEMENT, { contextType: 'case', contextId })`.
 * Holders: THE DELIVERING EXPERT ∪ THEIR AGENCY `owner`/`admin`.
 *
 * ⚠ AGENCY ROLE `expert` DOES **NOT** HOLD IT, AND THAT IS CORRECT RATHER THAN AN OVERSIGHT.
 * It is deliberately NARROWER than the VISIBILITY rule that let that colleague read this page
 * in the first place (`actorHasExpertSideVisibility` — delivering expert ∪ ANY live agency
 * member, including role `expert`). ADR-1046 §7 records the two widths as deliberate and
 * permanent: an agency colleague reads the whole case surface and simply cannot ask the client
 * to close it. DO NOT "align" the two rules in either direction.
 *
 * ── THE TWO GATES, IN ORDER ───────────────────────────────────────────────────────────────
 *   1. `authorizeCaseMutation` — onboarded session, strict Zod, the FULL tenancy gate re-run,
 *      then the case-type coherence check (BAL-129). This discharges the READ obligation that
 *      `hasEngagementCapability` explicitly does NOT: a `true` from that seam authorizes the
 *      ACT, never the READ, and `meeting_contexts.context_id` has no FK and no RLS.
 *   2. `lens === 'expert'`, then the engagement axis. The lens assertion is first because a
 *      CLIENT-side actor is structurally excluded from the engagement resolver (it reads only
 *      the delivering expert's profile and their agency roles), so checking it explicitly is
 *      what turns a confusing `false` into a legible rule with its own test.
 *
 * ⚠⚠ NO NOTIFICATION, NO DOMAIN EVENT, NO TEMPLATE, NO RULE — SYMMETRIC WITH THE SHIPPED
 * DISMISS HALF (owner decision D-E). The ask renders as a BANNER on the client's case surface,
 * and that banner is the ENTIRE delivery mechanism. Do not invent an event for it.
 *
 * ⚠ LAST-ASK-WINS, AND THE BLAST RADIUS IS ONE BANNER. `requestResolution`'s WHERE does not
 * require the paired columns to be null, so a re-ask overwrites the timestamp and is
 * idempotent in effect. That is safe precisely BECAUSE no notification fires — an expert who
 * re-raises a dismissed banner cannot email-bomb anyone. (Whether to rate-limit the re-ask is
 * an open question for the owner; it would need a new column, i.e. a migration.)
 *
 * ⚠ THE REPOSITORY REFUSES A CLOSED CASE (`closed_at IS NULL` in its WHERE) and writes BOTH
 * paired columns in one UPDATE — `case_engagement_resolution_request_paired` rejects a
 * half-set pair with 23514. Neither rule is re-implemented here.
 */
export async function requestResolutionAction(input: {
  engagementId: string;
}): Promise<CaseActionResult> {
  const gate = await authorizeCaseMutation(input);
  if (!gate.ok) {
    return { success: false, error: gate.error };
  }
  const { user, engagementId, lens } = gate;

  const denied = "You don't have permission to do that.";
  if (lens !== 'expert') {
    return { success: false, error: denied };
  }

  try {
    const allowed = await hasEngagementCapability(
      user,
      ENGAGEMENT_CAPABILITIES.MANAGE_ENGAGEMENT,
      // ⚠ A `case` context's `contextId` IS the engagement id. The subject is DERIVED from the
      // gate, never supplied — and the seam is narrowed by type to the four engagement-grain
      // labels, so a request-grain subject could not be named here even by mistake.
      { contextType: 'case', contextId: engagementId }
    );
    if (!allowed) {
      // An agency colleague with role `expert` lands here. Deliberate — see the docblock.
      return { success: false, error: denied };
    }

    const updated = await caseEngagementsRepository.requestResolution({
      engagementId,
      userId: user.id,
    });
    if (updated === undefined) {
      // A CLOSED (or soft-deleted, or non-`case`) parent. Asking whether a closed case is
      // resolved is incoherent, and the repository refuses it with NO write.
      return { success: false, error: 'This case is no longer open.' };
    }

    log.info('Case resolution requested', { engagementId, userId: user.id });

    revalidatePath('/cases/' + engagementId);
    return { success: true };
  } catch (error) {
    log.error('Failed to request case resolution', {
      engagementId,
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Something went wrong. Please try again.' };
  }
}
