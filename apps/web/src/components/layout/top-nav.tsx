'use client';

import { useSidebar } from './sidebar-context';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Menu, Bell } from 'lucide-react';

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/consultations': 'Consultations',
  '/projects': 'Projects',
  '/messages': 'Messages',
  '/expert/settings': 'Expert Settings',
  '/settings/account': 'Account',
};

function getPageTitle(pathname: string): string {
  if (PAGE_TITLES[pathname]) return PAGE_TITLES[pathname];
  for (const [path, title] of Object.entries(PAGE_TITLES)) {
    if (pathname.startsWith(path + '/')) return title;
  }
  return 'Dashboard';
}

export function TopNav(): React.JSX.Element {
  const { setMobileOpen } = useSidebar();
  const isMobile = useIsMobile();
  const pathname = usePathname();
  const title = getPageTitle(pathname);

  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="flex h-14 items-center justify-between px-4 sm:px-6 lg:px-8">
        <div className="flex items-center gap-4">
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
          <h1 className="text-foreground text-base font-semibold">{title}</h1>
        </div>

        {/* Notification bell with red dot */}
        <div className="relative">
          <Button
            variant="ghost"
            size="icon"
            className="border-border border"
            aria-label="Notifications"
            disabled
          >
            <Bell className="text-muted-foreground h-4 w-4" />
          </Button>
          <span className="bg-destructive border-background absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border-2" />
        </div>
      </div>
    </header>
  );
}
