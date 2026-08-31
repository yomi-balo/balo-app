'use client';

import { useSidebar } from './sidebar-context';
import { SidebarNavLink } from './sidebar-nav-link';
import { resolveNavItems, type EnabledNavEntry } from './nav-registry';
import { useNavItemTracking } from './use-nav-item-tracking';
import { NAV_BADGE_RENDERERS, type NavBadgeCounts } from './nav-badges';
import { Logo } from './logo';
import { WorkspaceSwitcher } from './workspace-switcher';
import { UserMenu } from './user-menu';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PanelLeftClose, PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

function SidebarContent({ isCollapsed }: { isCollapsed: boolean }): React.JSX.Element {
  const {
    activeMode,
    userName,
    userInitials,
    userAvatarUrl,
    checklistCompletedCount,
    checklistAllComplete,
    navContext,
    workspaces,
    activeWorkspaceKey,
  } = useSidebar();

  const primaryItems = resolveNavItems(navContext, 'primary');
  const secondaryItems = resolveNavItems(navContext, 'secondary');
  const trackNavItem = useNavItemTracking('sidebar', navContext.workspaceType);
  const badgeCounts: NavBadgeCounts = { checklistCompletedCount, checklistAllComplete };
  // D10 + D11: the Logo yields the collapsed rail TO the switcher — but only when there IS one.
  const showLogo = !isCollapsed || workspaces.length === 0;

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
      {/* Workspace header — D10: EXPANDED = Logo above the switcher; COLLAPSED = switcher
          avatar only (the prototype hides the Logo when collapsed,
          `balo-nav-explorer.jsx:966-970`; the shipped `Logo` always renders its 8×8 mark, so
          rendering both in the 40px rail box stacks two circles).
          ⚠ EXCEPTION — with ZERO workspaces there is no switcher, so nothing collides and the
          collapsed rail keeps the Logo mark rather than showing an empty 40px box.
          ⚠ The fixed `h-14` is GONE (D10 says the block gets taller). Consequence to expect in
          review: the sidebar header's `border-b` no longer lines up with `TopNav`'s `h-14`
          seam. That is what the prototype does too, and CLAUDE.md makes the prototype the
          design source of truth. */}
      <div className={cn('border-sidebar-border border-b px-3 pt-3.5 pb-3', isCollapsed && 'px-2')}>
        {showLogo && (
          <div
            className={cn(
              !isCollapsed && 'px-1',
              // `mb-2.5` only when the switcher actually renders beneath the Logo — with zero
              // workspaces `WorkspaceSwitcher` returns `null`, and the margin would otherwise
              // dangle under nothing.
              !isCollapsed && workspaces.length > 0 && 'mb-2.5',
              isCollapsed && 'flex justify-center'
            )}
          >
            <Logo iconOnly={isCollapsed} />
          </div>
        )}
        <WorkspaceSwitcher
          workspaces={workspaces}
          activeWorkspaceKey={activeWorkspaceKey}
          actorName={userName}
          actorInitials={userInitials}
          actorAvatarUrl={userAvatarUrl}
          isCollapsed={isCollapsed}
        />
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
  const { isCollapsed, toggleCollapsed } = useSidebar();

  // §2.1 — CSS-gated, never `useIsMobile`: `hidden lg:block` avoids the first-paint flash a
  // JS-gated ladder would produce (`use-mobile.ts` renders `false` on first paint).
  return (
    <aside
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border relative hidden border-r lg:block',
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
