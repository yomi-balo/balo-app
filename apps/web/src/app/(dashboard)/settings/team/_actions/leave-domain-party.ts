'use server';

import 'server-only';

import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { partyJoinRepository } from '@balo/db';
import { requireUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { emitDomainJoinOptedOut } from '@/lib/analytics/party-join';
import type { ActionResult } from './join-request-shared';

const inputSchema = z.object({
  partyType: z.enum(['company', 'agency']),
  partyId: z.uuid(),
});

/**
 * Escape hatch (BAL-345 §5.3) — the acting user rejects a domain-driven join and
 * records a durable opt-out so the match engine never re-joins/re-requests them to
 * this party. Self-only: the userId is ALWAYS the session user, and the requestId
 * (for the withdraw branch) is resolved server-side inside the single-tx
 * orchestrator — never trusted from the client.
 *
 * The orchestrator atomically withdraws a live pending request OR soft-removes the
 * live domain_match membership, plus the opt-out. `DOMAIN_JOIN_OPTED_OUT` is
 * emitted ONLY when something actually changed (idempotent no-op on double-submit).
 */
export async function leaveDomainParty(input: {
  partyType: 'company' | 'agency';
  partyId: string;
}): Promise<ActionResult> {
  let session;
  try {
    session = await requireUser();
  } catch {
    return { success: false, error: 'You must be signed in to do this.' };
  }

  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    return { success: false, error: 'Invalid request.' };
  }
  const { partyType, partyId } = parsed.data;

  try {
    const { path, changed } = await partyJoinRepository.leaveDomainParty({
      partyType,
      partyId,
      userId: session.id,
    });

    if (changed) {
      emitDomainJoinOptedOut(path, session.id);
    }

    revalidatePath('/settings/team');
    return { success: true };
  } catch (error) {
    log.error('Failed to leave domain party', {
      partyType,
      partyId,
      actorUserId: session.id,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return { success: false, error: 'Could not complete this action. Please try again.' };
  }
}
