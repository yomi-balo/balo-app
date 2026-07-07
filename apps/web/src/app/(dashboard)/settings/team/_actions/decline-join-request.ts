'use server';

import 'server-only';

import { runJoinRequestResolution, type ActionResult } from './join-request-shared';

/**
 * Decline a pending domain join request (BAL-345 §5.3). Same gate as approve
 * (`MANAGE_MEMBERS` on the request's own party) — no membership is created. The
 * requester is notified + the resolution tracked post-commit. The full pipeline
 * lives in `runJoinRequestResolution` (shared with approve); this file is the thin
 * `'use server'` entry point.
 */
export async function declineJoinRequest(input: { requestId: string }): Promise<ActionResult> {
  return runJoinRequestResolution(input, 'declined');
}
