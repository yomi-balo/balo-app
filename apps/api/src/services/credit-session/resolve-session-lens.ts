/**
 * BAL-441 (plan §3) — THE session lens decision, declared ONCE. Extracted verbatim (behaviour,
 * ordering and fail-closed semantics unchanged) out of `resolveSessionMoneyBlock`
 * (`./money-block.ts`) so the money-block route and the new `GET /sessions/:id/statement` route
 * can never disagree about who this viewer is.
 *
 * ⚠ `resolveSessionMoneyBlock`'s existing tests must pass UNTOUCHED — that is the acceptance
 * criterion for this refactor.
 */
import type { CreditSession } from '@balo/db';
import { authorizeSessionActor } from './authorize-session-actor.js';
import { authorizeSessionExpertVisibility } from './authorize-session-expert-visibility.js';

export type SessionLensGrant =
  | { ok: true; lens: 'client'; session: CreditSession }
  | { ok: true; lens: 'expert'; session: CreditSession; expertProfileId: string }
  | { ok: false; code: 'not_found' };

/**
 * Resolve the CLIENT-or-EXPERT lens for `sessionId` + the authenticated `userId`. Fail-closed,
 * in this order:
 *   1. company member (`authorizeSessionActor`)                       → CLIENT
 *   2. else the session's expert (`authorizeSessionExpertVisibility`) → EXPERT
 *   3. else `not_found` — existence is hidden at the SERVICE, not just the route.
 *
 * `forbidden` from the actor gate means "not a company member" and MUST fall through to the
 * expert gate rather than leaking a 403 (see `resolveSessionMoneyBlock`'s original comment,
 * unchanged in spirit here). NEVER reaches the ADMIN lens — `resolveAdminMoneyBlock` is a
 * separate authorization surface (ADR-1035) and does not call this function.
 */
export async function resolveSessionLens(
  sessionId: string,
  userId: string
): Promise<SessionLensGrant> {
  // 1. Company member → CLIENT lens.
  const actor = await authorizeSessionActor({ sessionId, userId });
  if (actor.ok) {
    return { ok: true, lens: 'client', session: actor.session };
  }

  // 2. The session's expert (or their agency) → EXPERT lens. `forbidden` on the actor gate means
  //    "not a company member" — fall through to the expert gate rather than leaking a 403.
  const expert = await authorizeSessionExpertVisibility({ sessionId, userId });
  if (expert.ok) {
    return {
      ok: true,
      lens: 'expert',
      session: expert.session,
      expertProfileId: expert.expertProfileId,
    };
  }

  // 3. Neither a member nor the expert → hide existence.
  return { ok: false, code: 'not_found' };
}
