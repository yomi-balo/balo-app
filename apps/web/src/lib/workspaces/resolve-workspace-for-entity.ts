import 'server-only';

import type { CompanyWorkspace, Workspace } from '@balo/shared/workspaces';
import type { SessionUser } from '@/lib/auth/session';
import { deriveWorkspacesForUser } from './derive-workspaces';
import { sealWorkspaceSwitchToken, WORKSPACE_SWITCH_TOKEN_PARAM } from './switch-token';

export interface EntityWorkspaceTarget {
  /** The company that OWNS the entity — e.g. `projectRequest.companyId`. */
  readonly companyId: string;
}

/**
 * BAL-494 — the caller's OTHER workspace that can view this entity, or `null` when there is
 * none (no workspace owns it), when they are ALREADY in it (the structural loop guard), or —
 * ⚠⚠ R1 — when the only matching workspace is REPRESENTATION-only. A representation
 * workspace is not switchable (see `switch-workspace.ts`'s R1 guard), so it must never be
 * offered as a redirect target either — offering it here and rejecting it at the switch
 * endpoint would just be a confusing two-step failure. Mark for BAL-314.
 */
export async function resolveWorkspaceForEntity(
  user: SessionUser,
  target: EntityWorkspaceTarget
): Promise<CompanyWorkspace | null> {
  const derived = await deriveWorkspacesForUser(user.id);
  if (derived === null) return null;

  const candidate = derived.workspaces.find(
    (w): w is CompanyWorkspace => w.type === 'company' && w.companyId === target.companyId
  );
  if (candidate === undefined) return null;

  // R1 / BAL-314 — never offer a representation workspace as a switch target.
  if (candidate.via === 'representation') return null;

  // Already active → structural loop guard (the caller falls through to its normal flow).
  if (candidate.key === derived.activeWorkspace.key) return null;

  return candidate;
}

/**
 * `/api/auth/switch-workspace?t=<sealed>&returnTo=<encoded>`
 *
 * The switch target lives ONLY inside the sealed token — the route never reads it from a raw
 * query param. `returnTo` is repeated in the clear purely so an EXPIRED token still lands the
 * user on the deep-linked page (which then re-mints a fresh token and succeeds) instead of
 * dumping them on `/dashboard`; the route rejects any request whose clear-text `returnTo`
 * disagrees with the sealed one.
 */
export async function workspaceSwitchRedirectPath(
  userId: string,
  workspace: Workspace,
  returnTo: string
): Promise<string> {
  const token = await sealWorkspaceSwitchToken({
    userId,
    targetKey: workspace.key,
    returnTo,
  });
  const params = new URLSearchParams({ [WORKSPACE_SWITCH_TOKEN_PARAM]: token, returnTo });
  return `/api/auth/switch-workspace?${params.toString()}`;
}
