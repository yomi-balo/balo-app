'use client';

import { useSidebar } from './sidebar-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { SidebarNavLink } from './sidebar-nav-link';
import { resolveNavItems, type NavBadgeSource, type EnabledNavEntry } from './nav-registry';
import { useNavItemTracking } from './use-nav-item-tracking';
import { Logo } from './logo';
import { UserMenu } from './user-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PanelLeftClose, PanelLeft, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface NavBadgeCounts {
  readonly checklistCompletedCount: number;
  readonly checklistAllComplete: boolean;
}

/**
 * ⚠ A `Record` OVER THE UNION, ON PURPOSE. Adding a member to `NavBadgeSource` without adding a
 * renderer here is a COMPILE ERROR — a `switch` or a ternary would silently render nothing.
 * (`noUncheckedIndexedAccess` does not widen a finite-literal-keyed Record, so the lookup below
 * is non-optional.)
 */
const NAV_BADGE_RENDERERS: Record<NavBadgeSource, (counts: NavBadgeCounts) => React.JSX.Element> = {
  expertChecklist: ({ checklistCompletedCount, checklistAllComplete }) => (
    <ChecklistBadge completedCount={checklistCompletedCount} allComplete={checklistAllComplete} />
  ),
};

function ChecklistBadge({
  completedCount,
  allComplete,
}: {
  completedCount: number;
  allComplete: boolean;
}): React.JSX.Element {
  if (allComplete) {
    return (
      <span
        className="bg-success/10 text-success flex h-5 w-5 items-center justify-center rounded-full"
        style={{ animation: 'checkPop 0.3s ease-out' }}
      >
        <Check className="h-3 w-3" />
      </span>
    );
  }

  return (
    <span className="bg-primary/10 text-primary rounded-full px-2 py-0.5 text-[10px] font-semibold">
      {completedCount}/5
    </span>
  );
}

function SidebarContent({ isCollapsed }: { isCollapsed: boolean }): React.JSX.Element {
  const {
    activeMode,
    userName,
    userInitials,
    userAvatarUrl,
    checklistCompletedCount,
    checklistAllComplete,
    navContext,
  } = useSidebar();

  const primaryItems = resolveNavItems(navContext, 'primary');
  const secondaryItems = resolveNavItems(navContext, 'secondary');
  const trackNavItem = useNavItemTracking('sidebar', navContext.workspaceType);
  const badgeCounts: NavBadgeCounts = { checklistCompletedCount, checklistAllComplete };

  const renderLink = (entry: EnabledNavEntry, isSecondary: boolean): React.JSX.Element => (
    <SidebarNavLink
      key={entry.key}
      href={entry.href}
      label={entry.label}
      icon={entry.icon}
      isCollapsed={isCollapsed}
      isSecondary={isSecondary}
      onClick={() => trackNavItem(entry.key)}
      suffix={entry.badgeSource ? NAV_BADGE_RENDERERS[entry.badgeSource](badgeCounts) : undefined}
    />
  );

  return (
    <div className="flex h-full flex-col pb-14">
      {/* Logo */}
      <div
        className={cn(
          'border-sidebar-border flex h-14 items-center border-b px-4',
          isCollapsed && 'justify-center px-2'
        )}
      >
        <Logo collapsed={isCollapsed} showExpertBadge={activeMode === 'expert'} />
      </div>

      {/* Primary navigation */}
      <nav className="flex-1 space-y-1 p-3">
        <TooltipProvider delayDuration={0}>
          {primaryItems.map((entry) => renderLink(entry, false))}
        </TooltipProvider>
      </nav>

      <Separator className="bg-sidebar-border" />

      {/* Bottom navigation */}
      <div className="space-y-1 p-3">
        <TooltipProvider delayDuration={0}>
          {secondaryItems.map((entry) => renderLink(entry, true))}
        </TooltipProvider>
      </div>

      <Separator className="bg-sidebar-border" />

      {/* User pill */}
      <div className={cn('p-3', isCollapsed && 'flex justify-center')}>
        <UserMenu>
          <button
            className={cn(
              'ring-offset-background focus-visible:ring-ring hover:bg-sidebar-accent/50 flex items-center transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              isCollapsed
                ? 'min-h-[44px] min-w-[44px] justify-center rounded-full'
                : 'w-full gap-3 rounded-lg px-3 py-2 text-left'
            )}
            aria-label={`User menu for ${userName}`}
          >
            <Avatar className="h-8 w-8 shrink-0">
              {userAvatarUrl && <AvatarImage src={userAvatarUrl ?? undefined} alt={userName} />}
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                {userInitials}
              </AvatarFallback>
            </Avatar>
            {!isCollapsed && (
              <div className="min-w-0 flex-1">
                <p className="text-sidebar-foreground truncate text-sm font-medium">{userName}</p>
                <p className="text-muted-foreground text-xs">
                  {activeMode === 'expert' ? 'Expert' : 'Client'}
                </p>
              </div>
            )}
          </button>
        </UserMenu>
      </div>
    </div>
  );
}

export function Sidebar(): React.JSX.Element {
  const { isCollapsed, isMobileOpen, toggleCollapsed, setMobileOpen } = useSidebar();
  const isMobile = useIsMobile();

  // Mobile: render sidebar inside a Sheet (left-sliding drawer)
  if (isMobile) {
    return (
      <Sheet open={isMobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="bg-sidebar text-sidebar-foreground w-64 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
          </SheetHeader>
          <SidebarContent isCollapsed={false} />
        </SheetContent>
      </Sheet>
    );
  }

  // Desktop: fixed sidebar with collapse toggle
  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border relative border-r',
        'sticky top-0 h-screen shrink-0',
        'transition-[width] duration-200 ease-in-out',
        isCollapsed ? 'w-[56px]' : 'w-64'
      )}
    >
      <SidebarContent isCollapsed={isCollapsed} />

      {/* Collapse toggle button pinned at the bottom */}
      <div
        className={cn(
          'border-sidebar-border absolute right-0 bottom-0 left-0 border-t p-3',
          isCollapsed && 'flex justify-center'
        )}
      >
        <Button
          variant="ghost"
          size={isCollapsed ? 'icon' : 'sm'}
          onClick={toggleCollapsed}
          className="text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50 min-h-[44px] w-full"
          aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {isCollapsed ? (
            <PanelLeft className="h-4 w-4" />
          ) : (
            <>
              <PanelLeftClose className="h-4 w-4" />
              <span className="ml-2">Collapse</span>
            </>
          )}
        </Button>
      </div>
    </aside>
  );
}
