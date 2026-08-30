import type { CompanyMemberRole, Workspace } from '@balo/shared/workspaces';

/**
 * BAL-496 (D3) — THE single source of the workspace subtitle strings, shared by the sidebar
 * switcher today and by BAL-501's More sheet / BAL-503's palette later. Pure; no `'use client'`
 * and no `server-only`, so both halves of the tree may import it (same stance as
 * `nav-registry.ts`). The `·` is U+00B7 MIDDLE DOT, exactly as the design reference writes it
 * (`.claude/design-references/balo-nav-explorer.jsx:165,169,173`).
 */

/**
 * ⚠ A `Record` OVER THE FINITE UNION, ON PURPOSE — adding a member to `CompanyMemberRole`
 * without a string here is a COMPILE ERROR, where a `switch` default would silently emit the
 * role-free fallback. (`noUncheckedIndexedAccess` does not widen a finite-literal-keyed
 * `Record`, so the lookup below is non-optional — same technique as `NAV_BADGE_RENDERERS` in
 * `sidebar.tsx`.) Copy is gender-neutral: it names roles and parties, never people.
 */
const CLIENT_ROLE_SUBTITLES: Record<CompanyMemberRole, string> = {
  owner: 'Client · Owner',
  admin: 'Client · Admin',
  member: 'Client · Member',
};

export const EXPERT_WORKSPACE_SUBTITLE = 'Expert workspace';
export const REPRESENTING_WORKSPACE_SUBTITLE = 'Client · Representing';
export const PERSONAL_WORKSPACE_SUBTITLE = 'Client · Personal';
export const PLAIN_CLIENT_SUBTITLE = 'Client';

/**
 * BAL-496 (D5) / BAL-500 — the visible note on a representation row, which is listed but NEVER
 * switchable (`switchWorkspace` rejects `via:'representation'` with
 * `reason:'representation_switch_not_enabled'`). Lives HERE so the sidebar switcher and the ⌘K
 * palette cannot drift; the two surfaces must agree word for word. BAL-314 is what removes the
 * restriction — until then do NOT widen `switchWorkspaceAction` to surface `AuthResult.code`.
 * ⚠ The apostrophe is U+2019 (’), matching the shipped switcher string exactly.
 */
export const REPRESENTATION_SWITCH_UNAVAILABLE_NOTE = 'Switching here isn’t available yet';

/**
 * FIRST MATCH WINS, and the order is load-bearing (D3):
 *   1. expert                     → 'Expert workspace'
 *   2. via === 'representation'   → 'Client · Representing'
 *   3. isPersonal                 → 'Client · Personal'
 *   4. role owner|admin|member    → 'Client · Owner' | '… Admin' | '… Member'
 *   5. company, no role           → 'Client'
 *
 * ⚠ REPRESENTATION OUTRANKS PERSONAL deliberately: "you are acting for someone else" is the more
 * consequential fact. It also falls out of D2's invariant — a representation workspace has no
 * role at all, so without arm 2 it would land on arm 5 and read as a bare 'Client'.
 * ⚠ Arm 5 is reachable ONLY through D2's invariant hole in reverse (a company row with
 * `via:'membership'` and no role) — impossible from `deriveWorkspaces` today, but this function
 * takes any `Workspace`, so it answers rather than throws.
 */
export function workspaceSubtitle(workspace: Workspace): string {
  if (workspace.type === 'expert') return EXPERT_WORKSPACE_SUBTITLE;
  if (workspace.via === 'representation') return REPRESENTING_WORKSPACE_SUBTITLE;
  if (workspace.isPersonal) return PERSONAL_WORKSPACE_SUBTITLE;
  const { role } = workspace; // destructure + guard, never `!`
  if (role === undefined) return PLAIN_CLIENT_SUBTITLE;
  return CLIENT_ROLE_SUBTITLES[role];
}

/**
 * D12 — the expert workspace has NO display name of its own (`ExpertWorkspace` is
 * `{ type, key }`), so it borrows the PERSON's name, matching the prototype's expert row
 * (`balo-nav-explorer.jsx:162-168`). Company workspaces use their own name.
 */
export function workspaceDisplayName(workspace: Workspace, actorName: string): string {
  return workspace.type === 'expert' ? actorName : workspace.name;
}

/**
 * D12 — expert row borrows the actor's initials; a company row derives them from its NAME.
 * There is no company avatar field and no company-logo accessor in the shell; do not invent one.
 */
export function workspaceInitials(workspace: Workspace, actorInitials: string): string {
  return workspace.type === 'expert' ? actorInitials : initialsFromName(workspace.name);
}

/**
 * Up to two initials, first + last token, upper-cased. `'?'` when there is nothing to derive.
 *
 * ⚠ NOT imported from `@/lib/search/expert-card-mapper`: that module value-imports
 * `buildExpertise` from the `@/components/expert` BARREL, which would drag the whole expert-card
 * component tree into the sidebar's client bundle. Nor from
 * `app/(dashboard)/meetings/[meetingId]/_lib/resolve-counterparty.ts`, which is route-local and
 * uses first+SECOND rather than first+last. Local, guarded, ~7 lines.
 */
function initialsFromName(name: string): string {
  const tokens = name
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const [first] = tokens;
  if (first === undefined) return '?';
  const last = tokens.length > 1 ? tokens[tokens.length - 1] : undefined;
  const tail = last === undefined ? '' : last.charAt(0);
  return (first.charAt(0) + tail).toUpperCase();
}
