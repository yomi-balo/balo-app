'use server';

import 'server-only';

import { runJoinRequestResolution, type ActionResult } from './join-request-shared';

/**
 * Approve a pending domain join request (BAL-345 §5.3). Gate: `MANAGE_MEMBERS` on
 * the request's own party (owner/admin only). Materialises the membership in one
 * tx via the repo, then notifies the requester + tracks the resolution
 * post-commit. The full pipeline lives in `runJoinRequestResolution` (shared with
 * decline); this file is the thin `'use server'` entry point.
 */
export async function approveJoinRequest(input: { requestId: string }): Promise<ActionResult> {
  return runJoinRequestResolution(input, 'approved');
}
