'use client';

import { useCallback, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { Workspace } from '@balo/shared/workspaces';
import { switchWorkspaceAction } from '@/lib/auth/actions/switch-workspace';

/**
 * The post-switch success toast's copy. Deliberately NOT `workspaceDisplayName` — that helper
 * borrows the actor's own name for the expert row label, but the toast says "your expert
 * workspace" instead of naming the person, which reads oddly in a sentence about switching.
 */
function switchedWorkspaceLabel(workspace: Workspace): string {
  return workspace.type === 'expert' ? 'your expert workspace' : workspace.name;
}

export interface UseWorkspaceSwitchResult {
  readonly isBusy: boolean;
  readonly switchTo: (targetKey: string) => void;
}

/**
 * BAL-501 (D9) — the EXACT switch sequence at `workspace-switcher.tsx:238-274`, extracted so
 * `WorkspaceMenu` (desktop) and `mobile-more-sheet.tsx` share one implementation rather than a
 * second, drifting copy. Proof this is behaviour-preserving: all 20 cases in
 * `workspace-switcher.test.tsx` pass UNCHANGED after `WorkspaceMenu` is rewired to consume this
 * hook.
 */
export function useWorkspaceSwitch(activeWorkspaceKey: string | null): UseWorkspaceSwitchResult {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isSwitching, setIsSwitching] = useState(false);

  const switchTo = useCallback(
    (targetKey: string): void => {
      // No-op guard: selecting the current workspace just closes the menu. `switchWorkspace`
      // short-circuits this server-side too, and emits no analytics, but not calling at all
      // keeps the toast honest — there was no switch.
      if (targetKey === activeWorkspaceKey) return;

      setIsSwitching(true);
      switchWorkspaceAction(targetKey)
        .then((result) => {
          if (result.success) {
            // `AuthResult<T>.data` is typed optional (`data?: T`) even though this action
            // always populates it on success — guard rather than assert (`noUncheckedIndexedAccess`
            // convention: destructure + guard, never `!`). The success TOAST does not depend on
            // it being present: CLAUDE.md requires a toast on every user-initiated mutation, so
            // a successful switch always gets one — `data` only decides which label it gets.
            const { data } = result;
            const label = data === undefined ? 'workspace' : switchedWorkspaceLabel(data.workspace);
            toast.success(`Switched to ${label}`);
            return;
          }
          toast.error(result.error);
        })
        .catch(() => {
          toast.error('Something went wrong. Please try again.');
        })
        .finally(() => {
          setIsSwitching(false);
          // D1 — a BARE `router.refresh()`. `switchWorkspaceAction` already calls
          // `revalidatePath('/', 'layout')` internally on success; this is only what makes the
          // client tree pick the new server render up. Do NOT add a second revalidation, a
          // `window.location` assignment, or a full page reload.
          startTransition(() => router.refresh());
        });
    },
    [activeWorkspaceKey, router]
  );

  return { isBusy: isSwitching || isPending, switchTo };
}
