import { toast } from 'sonner';
import type { Workspace } from '@balo/shared/workspaces';
import type { AuthResult } from '@/lib/auth/errors'; // TYPE-ONLY — erased, no server graph

/**
 * BAL-496 → BAL-500 — the workspace switch's user-facing FEEDBACK, in one place. EXTRACTED from
 * `workspace-switcher.tsx` (behaviour byte-for-byte unchanged, its 20 tests pass untouched) so the
 * ⌘K palette is a second caller rather than a second copy: two copies of these strings would drift,
 * and a verbatim second copy trips SonarCloud's new-code duplication gate.
 *
 * ⚠ NO analytics here. `workspace_switched` is emitted EXACTLY ONCE, server-side, inside
 * `switchWorkspace()` (`lib/workspaces/switch-workspace.ts:143-151`). Neither caller re-emits it,
 * and `WORKSPACE_SERVER_EVENTS` is deliberately absent from the client barrels.
 */

export const WORKSPACE_SWITCH_THREW_MESSAGE = 'Something went wrong. Please try again.';

/**
 * Deliberately NOT `workspaceDisplayName` — that helper borrows the actor's own name for the
 * expert row's LABEL, but the toast says "your expert workspace" rather than naming the person,
 * which reads oddly in a sentence about switching.
 */
export function switchedWorkspaceLabel(workspace: Workspace): string {
  return workspace.type === 'expert' ? 'your expert workspace' : workspace.name;
}

export function toastWorkspaceSwitchOutcome(result: AuthResult<{ workspace: Workspace }>): void {
  if (result.success) {
    // `AuthResult<T>.data` is typed `data?: T` even though the action always populates it on
    // success — destructure + guard, never `!`. The toast never depends on `data` being present:
    // CLAUDE.md requires a toast on every user-initiated mutation, so a successful switch always
    // gets one; `data` only decides which label it carries.
    const { data } = result;
    const label = data === undefined ? 'workspace' : switchedWorkspaceLabel(data.workspace);
    toast.success(`Switched to ${label}`);
    return;
  }
  toast.error(result.error);
}

export function toastWorkspaceSwitchThrew(): void {
  toast.error(WORKSPACE_SWITCH_THREW_MESSAGE);
}
