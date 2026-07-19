import 'server-only';

import type { ActionItem, EngagementWithMilestones } from '@balo/db';
import { deriveEngagementParties } from './engagement-parties';
import type { EngagementLens, EngagementViewerContext } from './resolve-engagement-lens';

/**
 * The action-items panel's single serializable contract (BAL-391 / ADR-1043).
 * `mapActionItemsToView` (server-only — it imports the parties engine) produces THIS
 * plain object once from the LIVE `action_items` rows, and the client
 * `ActionItemsPanel` consumes ONLY it — never `@balo/db` (the `@balo/db` import here is
 * TYPE-ONLY, erased at build, so no postgres client is pulled into a bundle) and never
 * the raw read model. Every string / flag the panel renders already lives here.
 *
 * Attribution (BAL-329 / CLAUDE.md): assignee is PARTY-level and PROSPECTIVE — it names
 * the party (the client company, or the expert party short label), never a person.
 * Retrospective per-person attribution ("done by Dana @ …") is a BAL-388 recap concern,
 * deliberately deferred (no per-item user hydration → no N+1 here).
 */
export interface ActionItemNodeView {
  id: string;
  /** Plain text (the item line) — rendered as text; React escaping is the boundary. */
  body: string;
  status: 'open' | 'done';
  /** Which SIDE owns it; `null` = unassigned. */
  assigneeParty: 'client' | 'expert' | null;
  /** Prospective party label: `null` (Unassigned) | clientCompanyName | expertPartyShort. */
  assigneeLabel: string | null;
  /** "9 Jul 2026" (UTC) when a due date is set; `null` otherwise. Stated as a helpful fact. */
  dueLabel: string | null;
  /**
   * Machine value (`YYYY-MM-DD`, UTC) for the edit form's native date input — EDIT
   * PREFILL ONLY, so the client never parses `dueLabel` back into a date. Mirrors the
   * milestone view's `descriptionText` prefill precedent. `null` when no due date.
   */
  dueAtValue: string | null;
  /** `dueAt < now` AND still `open` — a helpful "past due" hint, never a countdown. */
  isOverdue: boolean;
}

export interface ActionItemsPanelView {
  engagementId: string;
  items: ActionItemNodeView[];
  /** Mutations are allowed only on a live, active engagement (matches milestones). */
  canWrite: boolean;
  /** = `ctx.lens` — drives default self-assign framing + copy. */
  viewerParty: EngagementLens;
  /** Assign-control label for the client side (from `deriveEngagementParties`). */
  clientCompanyName: string;
  /** Assign-control label for the expert side (from `deriveEngagementParties`). */
  expertPartyShort: string;
}

/** "9 Jul 2026" — UTC day + short month + year (deterministic under TZ=UTC). */
function formatDueLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** `YYYY-MM-DD` (UTC) — the native `<input type="date">` value for the edit prefill. */
function toDateInputValue(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Party → prospective label (`null` = Unassigned). Pure lookup, no nested ternary. */
function deriveAssigneeLabel(
  party: ActionItem['assigneeParty'],
  clientCompanyName: string,
  expertPartyShort: string
): string | null {
  if (party === 'client') return clientCompanyName;
  if (party === 'expert') return expertPartyShort;
  return null;
}

/**
 * Map the LIVE action-item rows + resolved viewer context into the single serializable
 * panel view. SERVER-ONLY, PURE (no I/O; `@balo/db` type-only) — the returned object is
 * plain data safe to hand to the client island. `now` is injectable for deterministic
 * `isOverdue` tests (default `new Date()`).
 */
export function mapActionItemsToView(
  engagement: EngagementWithMilestones,
  actionItems: ActionItem[],
  ctx: EngagementViewerContext,
  now: Date = new Date()
): ActionItemsPanelView {
  const parties = deriveEngagementParties(engagement);
  const nowMs = now.getTime();

  const items: ActionItemNodeView[] = actionItems.map((item) => {
    const dueAt = item.dueAt;
    return {
      id: item.id,
      body: item.body,
      status: item.status,
      assigneeParty: item.assigneeParty,
      assigneeLabel: deriveAssigneeLabel(
        item.assigneeParty,
        parties.clientCompanyName,
        parties.expertPartyShort
      ),
      dueLabel: dueAt === null ? null : formatDueLabel(dueAt),
      dueAtValue: dueAt === null ? null : toDateInputValue(dueAt),
      isOverdue: dueAt !== null && item.status === 'open' && dueAt.getTime() < nowMs,
    };
  });

  return {
    engagementId: engagement.id,
    items,
    canWrite: engagement.status === 'active',
    viewerParty: ctx.lens,
    clientCompanyName: parties.clientCompanyName,
    expertPartyShort: parties.expertPartyShort,
  };
}
