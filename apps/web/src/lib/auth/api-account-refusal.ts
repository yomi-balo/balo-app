import 'server-only';

import {
  ACCOUNT_REFUSAL_HEADER,
  isAccountRefusalCode,
  reasonOfRefusal,
  type AccountRefusalCode,
} from '@balo/shared/authz';
import { log } from '@/lib/logging';
import { getSession } from './session';
// ⚠ NO `noteAccountRefusal` IMPORT, DELIBERATELY (fix round 2, G3). This module is log-only: the
// `api` path's one emitter is `apps/api`'s `requireAuth`, on the other side of the HTTP hop.

/**
 * BAL-568 — the `apps/web` half of the api refusal marker.
 *
 * `apps/api`'s `requireAuth` refuses a suspended or soft-deleted account with a 401 whose BODY is
 * byte-identical to every other 401 and whose refusal is carried by the
 * {@link ACCOUNT_REFUSAL_HEADER} response header. Every server-only web→api client reads it here,
 * so no caller has to infer "suspended" from a bare 401 — which is precisely what the ruling
 * forbids.
 */

/**
 * The marker, or `null`. `Headers.get` is case-insensitive per the Fetch spec, so the lower-case
 * constant matches whatever casing the wire carried. An unknown value fails closed to `null`.
 */
export function accountRefusalFromResponse(response: Response): AccountRefusalCode | null {
  const raw = response.headers.get(ACCOUNT_REFUSAL_HEADER);
  return isAccountRefusalCode(raw) ? raw : null;
}

/**
 * Record an api-path account refusal: one `warn` line, and **no analytics event**.
 *
 * ⚠⚠ LOG-ONLY, BY THE ONE-EMITTER-PER-PATH RULE (fix round 2, G3 — see `./account-liveness.ts`).
 * The refusal ORIGINATES in `apps/api`'s `requireAuth`, which already emitted
 * `auth_session_invalidated { path: 'api' }` for it before the 401 ever reached this tier. This
 * function used to emit a second copy of the same event, so every refused API call counted twice.
 * The `warn` line stays — it is what correlates the web-side failure with the api-side refusal —
 * but the event does not.
 *
 * ⚠⚠ IT DOES NOT `redirect()` AND IT DOES NOT DESTROY THE COOKIE, AND BOTH OMISSIONS ARE
 * DELIBERATE:
 *   · `redirect()` throws `NEXT_REDIRECT`, and every shipped caller of these clients wraps the
 *     call in its own `try/catch` (e.g. `cases/[engagementId]/_actions/cancel-consultation.ts`
 *     calls the client INSIDE a `try` whose `catch` renders generic retry copy). The redirect
 *     would be SWALLOWED there and the sign-out would fail silently — the worst outcome.
 *     `unstable_rethrow` appears nowhere in this codebase; adopting it across ~75 catch sites is
 *     its own ticket, not a rider on this one.
 *   · Destroying the cookie HERE would make the next render's `checkSessionDrift` see no session
 *     at all, so the sync route would take its `!session?.user?.id` arm and redirect to a BARE
 *     `/login` — losing BAL-197's `account_suspended` / `account_deleted` copy. Leaving the
 *     cookie in place lets the sync route read the live row and produce the right message.
 *
 * The cookie grants nothing in the meantime: after this ticket every actor-resolution seam
 * re-reads the live row.
 */
export async function noteApiAccountRefusal(code: AccountRefusalCode): Promise<void> {
  const session = await getSession();
  const userId = session.user?.id;
  if (userId === undefined) {
    // No session to attribute it to — the api refused a Bearer this tier could not have sent.
    log.warn('API refused a non-live account', { reason: reasonOfRefusal(code) });
    return;
  }
  log.warn('API refused a non-live account', { userId, reason: reasonOfRefusal(code) });
}

/**
 * THE ONE SHAPE EVERY SERVER-ONLY web→api CLIENT USES on a non-2xx: read the marker, record the
 * refusal if present, and hand back the code so the client can surface it as its typed failure's
 * `code`. Extracted rather than repeated at the five call sites — five copies of the
 * read + log + emit sequence is exactly the new-code duplication SonarCloud's >3% gate catches.
 *
 * Returns `null` for an ordinary 401 (or any other status), leaving that client's existing
 * behaviour byte-identical to before this ticket.
 */
export async function consumeApiAccountRefusal(
  response: Response
): Promise<AccountRefusalCode | null> {
  const code = accountRefusalFromResponse(response);
  if (code === null) return null;
  await noteApiAccountRefusal(code);
  return code;
}
