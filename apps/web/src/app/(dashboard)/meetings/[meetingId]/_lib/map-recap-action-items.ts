import 'server-only';

import type { ActionItem } from '@balo/db';
import type { RecapLens } from '@balo/analytics/events';
import {
  mapActionItemNode,
  type ActionItemNodeView,
  type ActionItemsPanelView,
} from '@/lib/engagement/action-items-view';

/**
 * BAL-388 — the MEETING-scoped action-items view.
 *
 * ⚠⚠ THE SHIPPED `mapActionItemsToView` CANNOT BE REUSED, AND THIS IS NOT A PREFERENCE. That
 * function takes a `ProjectEngagementWithMilestones` and calls `deriveEngagementParties`, so
 * it inherits a hydrated PROJECT graph a case meeting simply does not have; its own docblock
 * says the case panel is a separate mapper. The CLIENT component `ActionItemsPanel` IS reused
 * verbatim — it consumes only the plain `ActionItemsPanelView`. The per-ITEM mapping is
 * `mapActionItemNode`, shared with the project mapper so nothing is re-spelled.
 *
 * ⚠⚠ `canWrite` IS THE CALLER'S TO PASS, AND THE RECAP PASSES `false`. Every action-item
 * MUTATION gates through `gateEngagementParticipant` →
 * `projectEngagementsRepository.findWithMilestones`, whose query filters
 * `engagement_type = 'project'` — so a CASE id resolves to `undefined` and toggle / assign /
 * edit / remove would toast "This engagement could not be found" on EVERY click. That fails
 * CLOSED (no security consequence) but a panel whose controls always error is worse than one
 * that does not offer them. Making the mutation gate case-aware is what turns this back on.
 *
 * ⚠⚠ READ THIS BEFORE PASSING `canWrite: true` HERE. The panel's ADD row writes an
 * ENGAGEMENT-grain item with `meeting_id = NULL`, and THIS list is MEETING-scoped — so on a
 * writable recap a newly added item would vanish from the list the instant it was submitted.
 * Whoever makes the mutation gate case-aware owes this surface a suppressed add row (or an
 * add path that stamps `meeting_id`); the read-only posture is the only reason it is not a
 * live defect today. Deliberately NOT pre-built as a flag: an unreachable flag with its own
 * unreachable copy is a decoy, not a guard.
 *
 * SERVER-ONLY and PURE (the `@balo/db` import is TYPE-ONLY, erased at build). The returned
 * object is plain data, safe to hand to the client island.
 */
export function mapRecapActionItems(input: {
  engagementId: string;
  actionItems: ActionItem[];
  lens: RecapLens;
  clientCompanyName: string;
  expertPartyShort: string;
  /** Mutations are allowed only while the case is still OPEN. */
  canWrite: boolean;
  now?: Date;
}): ActionItemsPanelView {
  const nowMs = (input.now ?? new Date()).getTime();
  const items: ActionItemNodeView[] = input.actionItems.map((item) =>
    mapActionItemNode(item, input.clientCompanyName, input.expertPartyShort, nowMs)
  );

  return {
    engagementId: input.engagementId,
    items,
    canWrite: input.canWrite,
    viewerParty: input.lens,
    clientCompanyName: input.clientCompanyName,
    expertPartyShort: input.expertPartyShort,
  };
}

/** How many of the meeting's action items are still open — the §R2 meta count. */
export function countOpenActionItems(actionItems: readonly ActionItem[]): number {
  return actionItems.filter((item) => item.status === 'open').length;
}
