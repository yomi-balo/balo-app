import type { NavContext } from './nav-registry';

/**
 * BAL-499 (D2/D8) — THE credits-chip workspace gate: whether the top-bar chip is even a
 * candidate for this render. A pure predicate over the already-resolved, server-side
 * `NavContext.workspaceType` (ADR-1053) — the SAME scoping axis the sidebar already gates on,
 * never a client-side re-decision. `nav-registry.ts` owns `workspaceType`'s definition; this
 * module only reads it, so it stays importable from both server (`(dashboard)/layout.tsx`) and
 * client code, type-only, with no `@balo/db` / `server-only` reach of its own.
 */
export function creditsChipIsInScope(navContext: NavContext): boolean {
  return navContext.workspaceType === 'company';
}
