'use client';

import { useCallback, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { EngagementActionResult } from '@/app/(dashboard)/engagements/[id]/_actions/engagement-lifecycle-shared';

interface UseEngagementLifecycleAction {
  isPending: boolean;
  /** Run a lifecycle Server Action: toast the outcome, then reconcile via router.refresh(). */
  run: (action: Promise<EngagementActionResult>, successMessage: string) => void;
}

/**
 * The tiny shared client hook behind the three D4 lifecycle islands (finish card,
 * withdraw, admin cancel). Wraps `useTransition` + Sonner toast + `router.refresh()`
 * so the settle/refresh logic lives in ONE place (SonarCloud new-code duplication
 * gate) rather than being copy-pasted into each island. Reconciles on BOTH outcomes —
 * the RSC payload snaps the workspace (banners, progress, milestone rail, finish card)
 * back to server truth.
 */
export function useEngagementLifecycleAction(): UseEngagementLifecycleAction {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const run = useCallback(
    (action: Promise<EngagementActionResult>, successMessage: string): void => {
      startTransition(async () => {
        const result = await action;
        if (result.success) {
          toast.success(successMessage);
        } else {
          toast.error(result.error);
        }
        router.refresh();
      });
    },
    [router]
  );

  return { isPending, run };
}

/**
 * The shared `onOpenChange` handler for the three D4 confirm dialogs: block close
 * while an action is in flight (`pending`), otherwise route a close to `onCancel`.
 * Extracted so the identical guard isn't copy-pasted into each modal (Sonar
 * duplication gate).
 */
export function usePendingDialogClose(
  pending: boolean,
  onCancel: () => void
): (next: boolean) => void {
  return useCallback(
    (next: boolean): void => {
      if (pending) return; // no close mid-flight
      if (!next) onCancel();
    },
    [pending, onCancel]
  );
}
