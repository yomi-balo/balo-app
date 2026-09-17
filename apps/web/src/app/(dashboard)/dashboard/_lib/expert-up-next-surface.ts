import type { ChecklistStatus } from '@/lib/actions/expert-checklist';
import type { UpNextData } from './up-next-view-types';

/**
 * BAL-566 (R2) — bookings ALWAYS win over the ghost card. `'ghost'` ONLY when the read succeeded
 * with ZERO rows AND setup is incomplete (or the checklist read failed → treat as incomplete). An
 * error always shows the card's own error state, never the ghost.
 */
export function resolveExpertUpNextSurface(
  data: UpNextData,
  checklistStatus: Pick<ChecklistStatus, 'allComplete'> | null
): 'ghost' | 'card' {
  if (data.kind === 'error') {
    return 'card';
  }
  if (data.rows.length > 0) {
    return 'card';
  }
  const setupIncomplete = checklistStatus === null || !checklistStatus.allComplete;
  return setupIncomplete ? 'ghost' : 'card';
}
