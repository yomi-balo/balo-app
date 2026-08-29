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
import type { NavContext } from './nav-registry';

interface SidebarContextValue {
  isCollapsed: boolean;
  isMobileOpen: boolean;
  toggleCollapsed: () => void;
  setMobileOpen: (open: boolean) => void;

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
}: SidebarProviderProps): React.JSX.Element {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);

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

  const setMobileOpenCb = useCallback((open: boolean) => {
    setIsMobileOpen(open);
  }, []);

  const value = useMemo(
    () => ({
      isCollapsed,
      isMobileOpen,
      toggleCollapsed,
      setMobileOpen: setMobileOpenCb,
      activeMode,
      userName,
      userInitials,
      userAvatarUrl,
      checklistCompletedCount,
      checklistAllComplete,
      navContext,
    }),
    [
      isCollapsed,
      isMobileOpen,
      toggleCollapsed,
      setMobileOpenCb,
      activeMode,
      userName,
      userInitials,
      userAvatarUrl,
      checklistCompletedCount,
      checklistAllComplete,
      navContext,
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
