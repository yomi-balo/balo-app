import 'server-only';

import {
  deriveWorkspaces,
  parseWorkspaceKey,
  companyWorkspaceKey,
  EXPERT_WORKSPACE,
  type Workspace,
  type StoredWorkspaceChoice,
  type WorkspaceSwitchTrigger,
} from '@balo/shared/workspaces';
import { usersRepository } from '@balo/db';
import { trackServerAndFlush, WORKSPACE_SERVER_EVENTS } from '@/lib/analytics/server';
import { getSession, type SessionUser } from '@/lib/auth/session';
import { log } from '@/lib/logging';
import { loadWorkspaceDerivationMaterials } from './derive-workspaces';
import { applyWorkspaceDerivationToSessionUser } from './session-workspace';

export type SwitchWorkspaceResult =
  | { readonly ok: true; readonly workspace: Workspace; readonly changed: boolean }
  | {
      readonly ok: false;
      /**
       * ⚠⚠ R1 (BAL-494 orchestrator ruling) — `'representation_switch_not_enabled'` is a
       * DISTINCT reason from `'not_eligible'`, on purpose: a representation workspace IS in
       * the actor's derived list (BAL-496 renders it) but is NOT a valid switch target. See
       * the guard below — mark for BAL-314, which must reconcile `hasCapability` with
       * representation before this guard can be loosened.
       */
      readonly reason: 'invalid_target' | 'not_eligible' | 'representation_switch_not_enabled';
    };

function targetKeyFor(parsed: NonNullable<ReturnType<typeof parseWorkspaceKey>>): string {
  return parsed.kind === 'expert' ? EXPERT_WORKSPACE.key : companyWorkspaceKey(parsed.companyId);
}

/**
 * BAL-494 — the shared switch service. Validates the target against the actor's SERVER-
 * derived workspace list (plain set membership — no new capability token, no fourth
 * ADR-1029 axis: `hasCapability` and its call sites are untouched, per BAL-313's docblock),
 * persists the choice, patches + saves the session, and fires the ONE analytics dispatch
 * point for a workspace switch. `trigger` is hardcoded at each call site, never read from
 * request input, so it cannot be spoofed.
 */
export async function switchWorkspace(
  user: SessionUser,
  rawTargetKey: string,
  trigger: WorkspaceSwitchTrigger
): Promise<SwitchWorkspaceResult> {
  const parsed = parseWorkspaceKey(rawTargetKey);
  if (parsed === null) {
    return { ok: false, reason: 'invalid_target' };
  }

  const { input, stored } = await loadWorkspaceDerivationMaterials(user.id);
  const derived = deriveWorkspaces(input, stored);
  if (derived === null) {
    return { ok: false, reason: 'not_eligible' };
  }

  const targetKey = targetKeyFor(parsed);
  const target = derived.workspaces.find((w) => w.key === targetKey);
  if (target === undefined) {
    log.warn('Workspace switch rejected: target not in derived list', {
      userId: user.id,
      targetKey,
    });
    return { ok: false, reason: 'not_eligible' };
  }

  // ⚠⚠ R1 GUARD — BAL-314: a representation workspace would project `session.companyId` for
  // a NON-member (`hasCapability` still reports "not a member" — two gates disagreeing is
  // exactly what ADR-1029 warns against). Reject with a DISTINCT reason so a caller can tell
  // "not yours" apart from "yours, but not switchable yet". Remove only when BAL-314
  // reconciles `hasCapability` with representation.
  if (target.type === 'company' && target.via === 'representation') {
    log.warn('Workspace switch rejected: representation workspace is not switchable (BAL-314)', {
      userId: user.id,
      targetKey,
    });
    return { ok: false, reason: 'representation_switch_not_enabled' };
  }

  // No-op short-circuit — also the structural loop guard for the deep-link auto-switch path.
  if (target.key === derived.activeWorkspace.key) {
    return { ok: true, workspace: target, changed: false };
  }

  // ADR-1030 — DELIBERATELY NOT AUDITED. Ruled 2026-08-29 (ADR authority: Yomi), in response to
  // a review question, so it is not re-litigated: a workspace switch is a SELF-DIRECTED
  // PREFERENCE, not a consequential authority or money-boundary action.
  //   • It GRANTS NOTHING — it selects among workspaces the actor already holds. The grant lives
  //     in `company_members`, and that is where it is auditable.
  //   • No counterparty effect, no money boundary, and it is none of ADR-1030's seven v1 actions
  //     — whose risk table says "hold v1 to the seven listed actions; expand only on
  //     demonstrated need".
  //   • Every consequential act performed WHILE in a workspace already writes its own
  //     attribution including `company_id`, so "who was acting as company X when they did Y" is
  //     answerable from Y's own row — never reconstructed from a switch log.
  //   • ADR-1030 routes the residual forensic question ("who was acting as X at time T") to
  //     Pino/Axiom by design; its own table puts that class explicitly OUT of the DB.
  // No existing `activeMode` writer audits either, so this removes nothing. If a counterparty
  // effect is ever attached to the switch, revisit: the write and the `audit_events` row must
  // then share ONE `db.transaction` per ADR-1030's spine, at BOTH write sites (here and the
  // repair write in `api/auth/session-sync/route.ts`).
  if (target.type === 'expert') {
    // `activeCompanyId` is deliberately left alone — a trip through the expert workspace
    // must not lose the user's company choice.
    await usersRepository.update(user.id, { activeMode: 'expert' });
  } else {
    await usersRepository.update(user.id, {
      activeMode: 'client',
      activeCompanyId: target.companyId,
    });
  }

  const newStored: StoredWorkspaceChoice =
    target.type === 'expert'
      ? { activeMode: 'expert', activeCompanyId: stored.activeCompanyId }
      : { activeMode: 'client', activeCompanyId: target.companyId };

  // Recomputed PURELY from the already-fetched materials — no second round of DB reads.
  const recomputed = deriveWorkspaces(input, newStored);
  if (recomputed === null) {
    // Unreachable: `derived` (same `input`) was just proven non-null above.
    log.warn('Workspace switch: recomputed derivation unexpectedly null', {
      userId: user.id,
      targetKey,
    });
    return { ok: false, reason: 'not_eligible' };
  }

  const session = await getSession();
  if (session.user === undefined) {
    // Unreachable in practice (the caller already authenticated `user`), but the session is
    // re-opened here rather than trusted from the caller — fail safe rather than crash.
    log.warn('Workspace switch: session has no user at patch time', { userId: user.id });
    return { ok: false, reason: 'not_eligible' };
  }
  applyWorkspaceDerivationToSessionUser(session.user, recomputed);
  await session.save();

  trackServerAndFlush(WORKSPACE_SERVER_EVENTS.SWITCHED, {
    from_type: derived.activeWorkspace.type,
    to_type: recomputed.activeWorkspace.type,
    ...(recomputed.activeWorkspace.type === 'company'
      ? { to_company_id: recomputed.activeWorkspace.companyId }
      : {}),
    trigger,
    distinct_id: user.id,
  });

  log.info('Workspace switched', {
    userId: user.id,
    fromKey: derived.activeWorkspace.key,
    toKey: recomputed.activeWorkspace.key,
    trigger,
  });

  return { ok: true, workspace: recomputed.activeWorkspace, changed: true };
}
