/**
 * BAL-399 (ADR-1040 / ADR-1043) — the money-block LENS RESOLVER (the fee-concealment boundary at
 * the route). `GET /sessions/:id/money-block` resolves the lens fail-closed:
 *  1. company member (`authorizeSessionActor`) → CLIENT lens (all-in charge, no expert/margin);
 *  2. else the session's expert (`authorizeSessionExpert`) → EXPERT lens (own earnings only);
 *  3. else `not_found` (hides existence).
 * The ADMIN (margin-bearing) lens is served ONLY by `resolveAdminMoneyBlock`, behind the
 * `hasPlatformCapability` route gate — never reachable by a company member or an expert.
 *
 * Each lens reads its OWN projection (`findForClientMoneyView` / `findForExpertView` /
 * `findForAdminView`) and serializes via the pure builders, so the counterparty economics are
 * excluded STRUCTURALLY at both the DB read and the serialization.
 */
import {
  creditSessionsRepository,
  expertPayoutRecordsRepository,
  toClientMoneyBlock,
  toExpertMoneyBlock,
  toAdminMoneyBlock,
} from '@balo/db';
import type { ClientMoneyBlock, ExpertMoneyBlock, AdminMoneyBlock } from '@balo/shared/credit';
import { platformRoleHasCapability, PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { createLogger } from '@balo/shared/logging';
import { authorizeSessionActor } from './authorize-session-actor.js';
import { authorizeSessionExpert } from './authorize-session-expert.js';

const log = createLogger('credit-session');

/** The member/expert money block a `GET /sessions/:id/money-block` response carries. */
export type MemberOrExpertMoneyBlock = ClientMoneyBlock | ExpertMoneyBlock;

export type ResolveMoneyBlockResult =
  | { ok: true; block: MemberOrExpertMoneyBlock }
  | { ok: false; code: 'not_found' };

export type ResolveAdminMoneyBlockResult =
  | { ok: true; block: AdminMoneyBlock }
  | { ok: false; code: 'forbidden' | 'not_found' };

/**
 * Resolve the client OR expert money block for `sessionId` + the authenticated `userId`. A company
 * member gets the CLIENT lens; otherwise the session's expert (or their agency) gets the EXPERT
 * lens; a stranger gets `not_found`. An expert never reaches the client lens and vice versa.
 */
export async function resolveSessionMoneyBlock(
  sessionId: string,
  userId: string
): Promise<ResolveMoneyBlockResult> {
  // 1. Company member → CLIENT lens.
  const actor = await authorizeSessionActor({ sessionId, userId });
  if (actor.ok) {
    const view = await creditSessionsRepository.findForClientMoneyView(sessionId);
    if (view === undefined) {
      return { ok: false, code: 'not_found' };
    }
    return { ok: true, block: toClientMoneyBlock(view) };
  }

  // 2. The session's expert (or their agency) → EXPERT lens. `forbidden` on the actor gate means
  //    "not a company member" — fall through to the expert gate rather than leaking a 403.
  const expert = await authorizeSessionExpert({ sessionId, userId });
  if (expert.ok) {
    const view = await creditSessionsRepository.findForExpertView(sessionId);
    if (view === undefined) {
      return { ok: false, code: 'not_found' };
    }
    const payout = await expertPayoutRecordsRepository.findBySession(sessionId);
    return { ok: true, block: toExpertMoneyBlock(view, payout?.status) };
  }

  // 3. Neither a member nor the expert → hide existence.
  return { ok: false, code: 'not_found' };
}

/**
 * Resolve the ADMIN (margin-bearing) money block. SELF-ASSERTS the platform capability
 * (`MANAGE_PLATFORM_FEES`, ADR-1035) before reading the margin-bearing view — defense-in-depth so
 * a future non-route caller can't leak margin even if it skips the route gate (the route also
 * pre-checks + logs; this is the safety net). `forbidden` when the role lacks the capability
 * (WITHOUT ever reading the session); `not_found` when the session is missing/soft-deleted.
 */
export async function resolveAdminMoneyBlock(
  sessionId: string,
  platformRole: string
): Promise<ResolveAdminMoneyBlockResult> {
  if (!platformRoleHasCapability(platformRole, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)) {
    log.warn(
      { sessionId, platformRole },
      'Admin money-block denied at the service boundary — role lacks MANAGE_PLATFORM_FEES'
    );
    return { ok: false, code: 'forbidden' };
  }
  const view = await creditSessionsRepository.findForAdminView(sessionId);
  if (view === undefined) {
    return { ok: false, code: 'not_found' };
  }
  return { ok: true, block: toAdminMoneyBlock(view) };
}
