'use client';

import { useSidebar } from './sidebar-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { SidebarNavLink } from './sidebar-nav-link';
import { Logo } from './logo';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  LayoutDashboard,
  MessageSquare,
  FolderKanban,
  Package,
  PanelLeftClose,
  PanelLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// TODO: Derive nav items from user's activeMode (client vs consultant) in a future ticket
const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/dashboard/cases', label: 'Cases', icon: MessageSquare },
  { href: '/dashboard/projects', label: 'Projects', icon: FolderKanban },
  { href: '/dashboard/packages', label: 'Packages', icon: Package },
];

function SidebarContent({ isCollapsed }: { isCollapsed: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col pb-14">
      {/* Logo */}
      <div
        className={cn(
          'border-sidebar-border flex h-14 items-center border-b px-4',
          isCollapsed && 'justify-center px-2'
        )}
      >
        <Logo collapsed={isCollapsed} />
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-1 p-3">
        <TooltipProvider delayDuration={0}>
          {NAV_ITEMS.map((item) => (
            <SidebarNavLink
              key={item.href}
              href={item.href}
              label={item.label}
              icon={item.icon}
              isCollapsed={isCollapsed}
            />
          ))}
        </TooltipProvider>
      </nav>

      <Separator className="bg-sidebar-border" />
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
