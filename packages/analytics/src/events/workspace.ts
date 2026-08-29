import type { Workspace, WorkspaceSwitchTrigger } from '@balo/shared/workspaces';

// BAL-494 / ADR-1053 — SERVER-ONLY. Every workspace switch is decided and persisted inside
// `switchWorkspace()` (`apps/web/src/lib/workspaces/switch-workspace.ts`), the ONE dispatch
// point for this event — neither of its two callers (the Server Action, the deep-link Route
// Handler) emits it themselves. Property keys are snake_case to match the codebase
// convention; `distinct_id` is required by `trackServer` and is always the SWITCHING user.
export const WORKSPACE_SERVER_EVENTS = {
  /** The actor's active workspace changed (explicit switcher pick, or an auto-switch behind
   *  a cross-workspace deep link). Never fired on a no-op (already-active target). */
  SWITCHED: 'workspace_switched',
} as const;

export interface WorkspaceServerEventMap {
  [WORKSPACE_SERVER_EVENTS.SWITCHED]: {
    // `Workspace['type']` / `WorkspaceSwitchTrigger` are imported, never re-declared inline —
    // `@balo/shared/workspaces` is the canonical home for both unions (it is sited in
    // `packages/shared` precisely so analytics can reach it), and an inline copy would drift.
    from_type: Workspace['type'];
    to_type: Workspace['type'];
    /** Present only when `to_type` is `'company'`. */
    to_company_id?: string;
    trigger: WorkspaceSwitchTrigger;
    distinct_id: string;
  };
}
