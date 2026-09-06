import 'server-only';

import { loggedFetch } from '@/lib/logging/fetch-wrapper';
import { log } from '@/lib/logging';
import { getApiUrl } from '@/lib/api/balo-api-client';

/**
 * BAL-540 — the web→api hop for the post-commit half of the request-close cascade's meeting
 * cancellations: `POST /meetings/cancelled-teardown`.
 *
 * ⚠ IT DOES NOT USE `postBaloApiJson` / the `balo-api-client` request helper (though it reuses
 * that module's `getApiUrl`): that helper forwards the VIEWER's Bearer token, and this is a
 * SYSTEM consequence of a `@balo/db` transaction that already committed, never a user act. It
 * mirrors `lib/notifications/publish.ts`'s posture instead — `x-internal-api-key` +
 * `loggedFetch({ service: 'balo-api' })` — the same internal-auth shape the api route expects
 * (`requireInternalAuth`, the `POST /credit/setup-intent` precedent).
 *
 * Never throws: the close has ALREADY COMMITTED by the time this runs, so a transport error or
 * non-2xx here must never surface to the caller. Logs and swallows. No-ops on an empty array —
 * a request closed with zero live meetings (e.g. nobody was ever invited) has nothing to tear
 * down and must not spend an HTTP round trip saying so.
 *
 * ⚠ IT CHUNKS, AND THAT IS LOAD-BEARING. `close()`'s `cancelledMeetings` is UNBOUNDED (one
 * `project_discovery` meeting plus every live `request_interaction` meeting across N
 * relationships — there is no cap on the read). The route's Zod body caps `meetings` at
 * {@link TEARDOWN_BATCH_SIZE}, so posting the whole array in one request meant a 26-meeting
 * cascade 400'd and the client swallowed it — dropping the teardown for the ENTIRE batch, not
 * just the excess, leaving every Daily room provisioned and every expert's availability cache
 * stale. Chunking makes an oversized cascade cost extra round trips instead of correctness; a
 * failing chunk is logged and the remaining chunks still run.
 */
/** Must not exceed the route schema's `.max()` (`apps/api/.../cancelled-teardown.schema.ts`). */
export const TEARDOWN_BATCH_SIZE = 25;

export async function postCancelledTeardown(
  meetings: ReadonlyArray<{ meetingId: string; expertProfileId: string | null }>
): Promise<void> {
  if (meetings.length === 0) return;

  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) {
    log.error('INTERNAL_API_SECRET not configured — cannot post cancelled-meeting teardown', {
      meetingCount: meetings.length,
    });
    return;
  }

  for (let offset = 0; offset < meetings.length; offset += TEARDOWN_BATCH_SIZE) {
    // Sequential, not `Promise.all`: this runs post-commit in a deferred `runAfterResponse`
    // callback, and a burst of parallel internal POSTs buys nothing here. (No `eslint-disable`
    // for `no-await-in-loop` — the rule is not enabled in this config.)
    await postOneBatch(secret, meetings.slice(offset, offset + TEARDOWN_BATCH_SIZE));
  }
}

/** One ≤{@link TEARDOWN_BATCH_SIZE} batch. Logs and swallows; never throws. */
async function postOneBatch(
  secret: string,
  batch: ReadonlyArray<{ meetingId: string; expertProfileId: string | null }>
): Promise<void> {
  try {
    const response = await loggedFetch(`${getApiUrl()}/meetings/cancelled-teardown`, {
      service: 'balo-api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-api-key': secret,
      },
      body: JSON.stringify({ meetings: batch }),
    });

    if (!response.ok) {
      const body = await response.text();
      log.error('Cancelled-meeting teardown post failed', {
        status: response.status,
        body,
        meetingCount: batch.length,
      });
    }
  } catch (error) {
    log.error('Cancelled-meeting teardown request failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      meetingCount: batch.length,
    });
  }
}
