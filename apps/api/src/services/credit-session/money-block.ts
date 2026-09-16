/**
 * BAL-399 (ADR-1040 / ADR-1043) — the money-block LENS RESOLVER (the fee-concealment boundary at
 * the route). `GET /sessions/:id/money-block` resolves the lens fail-closed:
 *  1. company member (`authorizeSessionActor`) → CLIENT lens (all-in charge, no expert/margin);
 *  2. else the session's expert (`authorizeSessionExpertVisibility`) → EXPERT lens (own earnings);
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
import { PLATFORM_CAPABILITIES } from '@balo/shared/authz';
import { userHasPlatformCapability, type PlatformCapabilityActor } from '../../authz/platform.js';
import { createLogger } from '@balo/shared/logging';
import { resolveSessionLens } from './resolve-session-lens.js';

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
  // BAL-441 — THE lens decision, declared ONCE in `resolveSessionLens`. Extracted verbatim so
  // this route and `GET /sessions/:id/statement` (`resolveSessionStatement`) can never disagree
  // about who this viewer is. Behaviour/ordering/fail-closed semantics are unchanged.
  const grant = await resolveSessionLens(sessionId, userId);
  if (!grant.ok) {
    return { ok: false, code: 'not_found' };
  }

  if (grant.lens === 'client') {
    const view = await creditSessionsRepository.findForClientMoneyView(sessionId);
    if (view === undefined) {
      return { ok: false, code: 'not_found' };
    }
    return { ok: true, block: toClientMoneyBlock(view) };
  }

  const view = await creditSessionsRepository.findForExpertView(sessionId);
  if (view === undefined) {
    return { ok: false, code: 'not_found' };
  }
  const payout = await expertPayoutRecordsRepository.findBySession(sessionId);
  return { ok: true, block: toExpertMoneyBlock(view, payout?.status) };
}

/**
 * Resolve the ADMIN (margin-bearing) money block. SELF-ASSERTS the platform capability
 * (`MANAGE_PLATFORM_FEES`, ADR-1035) before reading the margin-bearing view — defense-in-depth so
 * a future non-route caller can't leak margin even if it skips the route gate (the route also
 * pre-checks + logs; this is the safety net). `forbidden` when the actor lacks the capability
 * (WITHOUT ever reading the session); `not_found` when the session is missing/soft-deleted.
 *
 * ⚠ BAL-560 (D11) — TAKES THE ACTOR, NOT A BARE `platformRole` STRING. The per-user override
 * (`users.platform_capabilities`) is half of the answer, and a role string cannot carry it: a
 * "fee-blind staff viewer" is an `admin` row whose override omits `MANAGE_PLATFORM_FEES`, and
 * the old signature would have resolved them as a full admin. `PlatformCapabilityActor` makes
 * `platformCapabilities` REQUIRED precisely so that a caller holding only a role string is a
 * COMPILE ERROR rather than a silent bypass.
 *
 * ⚠ THE SELF-ASSERT STAYS A SELF-ASSERT — do NOT replace it with a pre-resolved boolean
 * parameter. That would delete exactly the defense-in-depth property this docblock claims.
 */
export async function resolveAdminMoneyBlock(
  sessionId: string,
  actor: PlatformCapabilityActor
): Promise<ResolveAdminMoneyBlockResult> {
  if (!userHasPlatformCapability(actor, PLATFORM_CAPABILITIES.MANAGE_PLATFORM_FEES)) {
    // ⚠ LOG SHAPE PRESERVED BYTE-FOR-BYTE — the same `{ sessionId, platformRole }` key set and
    // the same message string. Dashboards key on both (memory
    // `feedback_monitor_strings_need_verbatim_pin`); BAL-560 widened the SIGNATURE, not the log.
    log.warn(
      { sessionId, platformRole: actor.platformRole },
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
