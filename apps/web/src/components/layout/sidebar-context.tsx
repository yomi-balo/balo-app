'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Workspace } from '@balo/shared/workspaces';
import type { NavContext } from './nav-registry';

interface SidebarContextValue {
  isCollapsed: boolean;
  toggleCollapsed: () => void;

  // Mode & user info. ⚠ `activeMode` is PRESENTATION ONLY here — the Logo expert badge and the
  // user-pill subtitle. It is NEVER a nav gate; nav scopes on `navContext.workspaceType`.
  activeMode: 'client' | 'expert';
  userName: string;
  userInitials: string;
  userAvatarUrl: string | null;
  checklistCompletedCount: number;
  checklistAllComplete: boolean;
  /**
   * BAL-495 — the SERVER-RESOLVED nav context every surface's registry lookup reads. Replaces
   * the BAL-347 `canManageCompany` boolean: the Team gate is now the `manage_members` token
   * inside `capabilities`, withheld server-side on a personal company.
   */
  navContext: NavContext;
  /**
   * BAL-496 — the actor's FULL workspace list, derived SERVER-side by
   * `getWorkspacesForCurrentUser()` and passed down. ⚠ Deliberately NOT read off the session:
   * the list overran the 4096-byte cookie ceiling and was removed from `SessionUser` in
   * BAL-494's security round 2. `[]` is a valid, stable state (no switcher), never an error.
   */
  workspaces: readonly Workspace[];
  /**
   * `Workspace['key']` of the ACTIVE workspace, from `activeWorkspaceKeyOf(sessionUser)`.
   * `null` only when there is no session user or the cookie predates BAL-494 — in both of which
   * `workspaces` is `[]` (see `(dashboard)/layout.tsx` for the proof). Never names a
   * representation workspace (R1).
   */
  activeWorkspaceKey: string | null;
}

const SidebarContext = createContext<SidebarContextValue | null>(null);

const STORAGE_KEY = 'balo_sidebar_collapsed';

interface SidebarProviderProps {
  children: ReactNode;
  activeMode: 'client' | 'expert';
  userName: string;
  userInitials: string;
  userAvatarUrl: string | null;
  checklistCompletedCount: number;
  checklistAllComplete: boolean;
  navContext: NavContext;
  workspaces: readonly Workspace[];
  activeWorkspaceKey: string | null;
}

export function SidebarProvider({
  children,
  activeMode,
  userName,
  userInitials,
  userAvatarUrl,
  checklistCompletedCount,
  checklistAllComplete,
  navContext,
  workspaces,
  activeWorkspaceKey,
}: SidebarProviderProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(false);

  // Hydrate from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'true') setIsCollapsed(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(STORAGE_KEY, String(next));
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({
      isCollapsed,
      toggleCollapsed,
      activeMode,
      userName,
      userInitials,
      userAvatarUrl,
      checklistCompletedCount,
      checklistAllComplete,
      navContext,
      workspaces,
      activeWorkspaceKey,
    }),
    [
      isCollapsed,
      toggleCollapsed,
      activeMode,
      userName,
      userInitials,
      userAvatarUrl,
      checklistCompletedCount,
      checklistAllComplete,
      navContext,
      workspaces,
      activeWorkspaceKey,
    ]
  );

  return <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>;
}

export function useSidebar(): SidebarContextValue {
  const ctx = useContext(SidebarContext);
  if (!ctx) throw new Error('useSidebar must be used within SidebarProvider');
  return ctx;
}

/** Safe version that returns null when outside SidebarProvider */
export function useSidebarOptional(): SidebarContextValue | null {
  return useContext(SidebarContext);
}
