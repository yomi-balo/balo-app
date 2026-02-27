'use client';

import { useSidebar } from './sidebar-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { UserMenu } from './user-menu';
import { ThemeToggle } from '@/components/ui/theme-toggle';
import { Menu, Bell, Search } from 'lucide-react';

export function TopNav(): React.JSX.Element {
  const { setMobileOpen } = useSidebar();
  const isMobile = useIsMobile();

  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="flex h-14 items-center gap-4 px-4 sm:px-6 lg:px-8">
        {/* Mobile hamburger */}
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation menu"
            className="shrink-0"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}

        {/* Search placeholder */}
        <div className="relative max-w-md flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            type="search"
            placeholder="Search..."
            className="pl-9"
            disabled
            aria-label="Search (coming soon)"
          />
        </div>

        {/* Right-side actions */}
        <div className="ml-auto flex items-center gap-2">
          {/* Notification bell placeholder */}
          <Button variant="ghost" size="icon" aria-label="Notifications (coming soon)" disabled>
            <Bell className="h-4 w-4" />
          </Button>

          <ThemeToggle />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}
