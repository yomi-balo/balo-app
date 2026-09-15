'use server';

import 'server-only';

import { requireOnboardedUser } from '@/lib/auth/session';
import { runMarkThreadRead } from './_shared/mark-thread-read-core';
import type { MarkThreadReadInput, MarkThreadReadResult } from './_shared/mark-thread-read-core';

export type { MarkThreadReadResult } from './_shared/mark-thread-read-core';

/**
 * Advance the viewer's read watermark for one thread (BAL-271 / A4 — D3).
 * The repo upsert uses `GREATEST(existing, new)`, so concurrent/out-of-order
 * marks never move the watermark backwards. High-frequency — no `log.info`
 * (not a business event) and no `revalidatePath` (island-local state).
 */
export async function markThreadReadAction(
  input: MarkThreadReadInput
): Promise<MarkThreadReadResult> {
  let user;
  try {
    user = await requireOnboardedUser();
  } catch {
    return { success: false, error: 'You are not signed in.' };
  }

  return runMarkThreadRead(user, input);
}
