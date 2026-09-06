import 'server-only';

import { z } from 'zod';
import type { SessionStatement } from '@balo/shared/credit';
import { callSessionApi } from '@/lib/credit/api-client';
import { log } from '@/lib/logging';

/**
 * BAL-441 (plan §5) — server-only web→api fetch of `GET /sessions/:id/statement`.
 *
 * ⚠ Deliberately NOT `fetchSessionMoneyBlock` (`@/lib/api/session-money-block.ts`) — that
 * module's collapse-to-`null` is right for the recap FRAGMENT (a failure becomes its own muted
 * fallback) and must not change; the recap is a live consumer. A DEDICATED PAGE CANNOT SWALLOW:
 * collapsing everything to one outcome would render "not found" over a database outage and tell
 * the reader their receipt does not exist. So this module calls `callSessionApi` directly and
 * keeps FOUR outcomes (BAL-519 added `rate_limited`).
 */
export type SessionStatementFetch =
  | { outcome: 'ok'; statement: SessionStatement }
  | { outcome: 'denied' } // → notFound()
  // BAL-519 — the api's per-user limiter refused this read. NOT a denial (404 would tell the
  // reader their receipt does not exist) and NOT an outage (`error.tsx` says "this is on our
  // side", a lie for a rate-limited caller). `retryAfterSeconds` is carried for the PDF route's
  // `Retry-After` header ONLY — the page renders no countdown (D4).
  | { outcome: 'rate_limited'; retryAfterSeconds: number | null }
  | { outcome: 'unavailable' }; // → throw → error.tsx

/**
 * `403` is unreachable today (the api never returns it for this route — existence is hidden via
 * `404`), but it is in the set DEFENSIVELY so a future api change cannot turn a denial into an
 * outage page.
 */
const DENIED_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404]);

/** BAL-519 — deliberately NOT a member of `DENIED_STATUSES`; see the branch below. */
const RATE_LIMITED_STATUS = 429;

/**
 * ⚠ THE UUID CHECK IS A SECURITY CONTROL, NOT A TIDINESS ONE — DO NOT REMOVE IT.
 *
 * `sessionId` originates in a Next dynamic route segment, and Next DECODES those, so `.`, `..`,
 * `%2F`, `?` and `#` all arrive verbatim. Interpolating that straight into the api path lets a
 * crafted id re-point the request at a DIFFERENT `apps/api` endpoint — with the viewer's WorkOS
 * Bearer token already attached by `callSessionApi`, and with no runtime shape validation on the
 * response (`callSessionApi` returns `parsed as T`).
 *
 * Today the blast radius is contained by three separate accidents (every api route is
 * `requireAuth`-gated against the same viewer, the admin route 403s a non-staff caller, and the
 * `lens` check plus a downstream property access reject the rest) — none of which is input
 * validation, and any of which a refactor could remove without noticing. The two PDF Route
 * Handlers already validate; the page entry points did not, and that asymmetry was the bug.
 */
const sessionIdSchema = z.string().uuid();

/** Fetch the session statement, mapping every HTTP outcome to one of four page-level signals. */
export async function fetchSessionStatement(sessionId: string): Promise<SessionStatementFetch> {
  if (!sessionIdSchema.safeParse(sessionId).success) {
    // Same outcome as every other denial, so a malformed id is indistinguishable from a real
    // one that the viewer may not see — existence stays hidden either way.
    log.warn('Session statement rejected — malformed session id');
    return { outcome: 'denied' };
  }

  const result = await callSessionApi<SessionStatement>(
    // `encodeURIComponent` is belt-and-braces behind the UUID check above; keep BOTH, because
    // the check is the piece a future refactor is most likely to drop.
    `/sessions/${encodeURIComponent(sessionId)}/statement`,
    'GET'
  );

  if (result.ok) {
    return { outcome: 'ok', statement: result.data };
  }

  // ⚠ CHECKED BEFORE THE DENIAL SET, AND THE SET DELIBERATELY EXCLUDES 429. Ordering it first
  // means a future edit that added 429 to `DENIED_STATUSES` could not silently turn a
  // rate-limited read into a "your receipt does not exist" 404.
  if (result.status === RATE_LIMITED_STATUS) {
    log.warn('Session statement rate-limited', { sessionId, status: result.status });
    return { outcome: 'rate_limited', retryAfterSeconds: result.retryAfterSeconds ?? null };
  }

  if (DENIED_STATUSES.has(result.status)) {
    // ⚠ The `401` case deserves a `warn`, not silence: the page's `getCurrentUser()` gate
    // already passed, so a 401 here means the iron-session has no access token or is
    // un-onboarded. It resolves to `denied` → 404 because that leaks nothing and cannot loop —
    // do NOT redirect to `/login` from inside this loader.
    log.warn('Session statement denied', { sessionId, status: result.status });
    return { outcome: 'denied' };
  }

  // `status === 0` (transport failure), `status >= 500` (incl. the route's own 503), and any
  // OTHER unexpected status all fail LOUD rather than silently 404ing.
  log.error('Session statement unavailable', { sessionId, status: result.status });
  return { outcome: 'unavailable' };
}
