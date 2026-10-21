import type { ExpertChecklistItemKey } from './checklist';

export const LIVE_STATUS_ACTIONS = [
  'reconnect_calendar',
  'change_availability',
  'view_public_profile',
  'finish_setup',
] as const;
export type LiveStatusAction = (typeof LIVE_STATUS_ACTIONS)[number];

export const EXPERT_LIVE_STATES = ['live', 'paused', 'away', 'not_listed'] as const;
export type ExpertLiveState = (typeof EXPERT_LIVE_STATES)[number];

export interface ExpertLiveStatus {
  readonly state: ExpertLiveState;
  /** Non-null only for `not_listed`: the checklist item the expert should fix first. */
  readonly fixItem: ExpertChecklistItemKey | null;
}

/**
 * Before an expert has first gone live the checklist owns the sidebar. Once the go-live card has
 * been seen, the status stays visible even if a later regression makes the checklist incomplete.
 */
export function isExpertLiveStatusVisible(input: {
  allComplete: boolean;
  liveCelebrationSeen: boolean;
}): boolean {
  return input.allComplete || input.liveCelebrationSeen;
}

/** Derives the marketplace status; first matching rule wins. `null` means "show no badge". */
export function deriveExpertLiveStatus(input: {
  allComplete: boolean;
  liveCelebrationSeen: boolean;
  searchable: boolean;
  availableForWork: boolean;
  failingItems: readonly ExpertChecklistItemKey[];
  hasUnreadableBusyTarget: boolean;
}): ExpertLiveStatus | null {
  if (!isExpertLiveStatusVisible(input)) return null;
  if (!input.searchable) {
    const [first] = input.failingItems;
    const fixItem = input.failingItems.includes('calendar') ? 'calendar' : (first ?? null);
    return { state: 'not_listed', fixItem };
  }
  if (!input.availableForWork) return { state: 'away', fixItem: null };
  if (input.hasUnreadableBusyTarget) return { state: 'paused', fixItem: null };
  return { state: 'live', fixItem: null };
}
