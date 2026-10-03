'use server';

import 'server-only';

import { z } from 'zod';
import type { SessionUser } from '@/lib/auth/session';
import { requireOnboardedUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { authorizeClientCaseMutation } from '../_lib/authorize-client-case-mutation';
import {
  enqueueProjectBriefParse,
  type StartProjectBriefParseResult,
} from '@/lib/project-request/actions/enqueue-project-brief-parse';

export type { StartProjectBriefParseResult };

const inputSchema = z.object({ caseId: z.uuid() }).strict();

const DENIED = "You don't have permission to draft a project brief from this case.";
const WRONG_WORKSPACE = 'Switch to the workspace this case belongs to.';

/**
 * BAL-589 — start a project-brief parse sourced from ONE case's message/transcript history,
 * rather than uploaded documents. Client-only, both in rendering and here:
 *
 *   1. `authorizeClientCaseMutation` — the shared client-lens membership gate (onboarded
 *      session, tenancy re-run, `lens === 'client'`, `PARTICIPATE`). An expert-lens actor, or
 *      one missing `PARTICIPATE`, is denied before anything is read or written.
 *   2. The gate's `companyId` (from the LOADED case row) must equal the session's ACTIVE
 *      company — a user whose active company has since switched away from this case's buyer
 *      org is refused, even though they technically still belong to it.
 *   3. {@link enqueueProjectBriefParse} — the shared BAL-254 tail (shared hourly rate limit,
 *      row write, api enqueue hop). The worker re-derives the case gate itself from the
 *      persisted row before reading any history (`case-source.ts`) — this action's gate is
 *      authorization to REQUEST the parse, not a cache of what the worker is allowed to read.
 */
export async function startCaseBriefParseAction(
  rawInput: unknown
): Promise<StartProjectBriefParseResult> {
  let user: SessionUser;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { caseId } = parsed.data;

  const gate = await authorizeClientCaseMutation(caseId, user, DENIED);
  if (!gate.ok) {
    log.warn('Case brief parse rejected — case gate denied', {
      caseId,
      userId: user.id,
      error: gate.error,
    });
    return { success: false, error: gate.error };
  }

  if (gate.companyId !== user.companyId) {
    log.warn('Case brief parse rejected — active company does not match the case', {
      caseId,
      userId: user.id,
      activeCompanyId: user.companyId,
    });
    return { success: false, error: WRONG_WORKSPACE };
  }

  const result = await enqueueProjectBriefParse({
    companyId: gate.companyId,
    userId: user.id,
    source: { source: 'case', sourceEngagementId: caseId },
    logContext: { caseId },
  });

  if (result.success && result.parseId !== undefined) {
    log.info('Case brief parse started', { caseId, parseId: result.parseId });
  }

  return result;
}
