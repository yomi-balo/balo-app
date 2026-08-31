'use client';

import { useCallback } from 'react';
import { track, NAV_EVENTS } from '@/lib/analytics';
import type { NavItemKey, NavSurface } from '@/lib/analytics';
import type { NavWorkspaceType } from './nav-registry';

/**
 * BAL-495 — the ONE nav-click dispatch point, shared by the sidebar today and by BAL-501's bottom
 * tabs / BAL-500's ⌘K palette. Surfaces pass their own `surface`; nothing else emits this event.
 */
export function useNavItemTracking(
  surface: NavSurface,
  workspaceType: NavWorkspaceType
): (item: NavItemKey) => void {
  return useCallback(
    (item: NavItemKey) => {
      track(NAV_EVENTS.ITEM_CLICKED, { item, surface, workspace_type: workspaceType });
    },
    [surface, workspaceType]
  );
}
