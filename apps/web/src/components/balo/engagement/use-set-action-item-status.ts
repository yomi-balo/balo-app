'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setActionItemStatusAction } from '@/app/(dashboard)/engagements/[id]/_actions/set-action-item-status';
import { setCaseActionItemStatusAction } from '@/app/(dashboard)/cases/[engagementId]/_actions/set-case-action-item-status';

/** Which engagement product's status action applies — each gates on its own loader. */
export type ActionItemStatusGrain = 'project' | 'case';

/**
 * Mark an action item done or reopen it, for either grain — the ONE runner behind the project
 * workspace / recap panel (`ActionItemsPanel`) and the case page (`CaseActionItems`). Calls the
 * grain's Server Action, toasts the outcome (own copy on success, the action's copy verbatim on
 * failure) and refreshes on BOTH outcomes so the caller's optimistic patch snaps back to server
 * truth. The caller owns the optimistic patch and the transition it runs in.
 */
export function useSetActionItemStatus(
  engagementId: string,
  grain: ActionItemStatusGrain
): (actionItemId: string, status: 'open' | 'done') => Promise<void> {
  const router = useRouter();
  return useCallback(
    async (actionItemId: string, status: 'open' | 'done'): Promise<void> => {
      const setStatus =
        grain === 'case' ? setCaseActionItemStatusAction : setActionItemStatusAction;
      const result = await setStatus({ engagementId, actionItemId, status });
      if (result.success) {
        toast.success(status === 'done' ? 'Marked done' : 'Reopened');
      } else {
        toast.error(result.error);
      }
      router.refresh();
    },
    [engagementId, grain, router]
  );
}
