'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LucideIcon } from 'lucide-react';
import { isNavItemActive } from './is-nav-item-active';

interface SidebarNavLinkProps {
  href: string;
  label: string;
  icon: LucideIcon;
  isCollapsed: boolean;
  isSecondary?: boolean;
  suffix?: React.ReactNode;
  /** BAL-495 — telemetry only. Navigation is still `<Link>`'s job; this never preventDefaults. */
  onClick?: () => void;
}

export function SidebarNavLink({
  href,
  label,
  icon: Icon,
  isCollapsed,
  isSecondary = false,
  suffix,
  onClick,
}: SidebarNavLinkProps): React.JSX.Element {
  const pathname = usePathname();
  const isActive = isNavItemActive(pathname, href);

  let inactiveTextClass =
    'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground';
  if (isSecondary) {
    inactiveTextClass =
      'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground';
  }
  const activeStateClass = isActive ? 'bg-primary/10 text-primary' : inactiveTextClass;

  const linkContent = (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
        'min-h-[44px]',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        isSecondary ? 'text-xs font-normal' : 'text-sm font-medium',
        activeStateClass,
        isCollapsed && 'justify-center px-2'
      )}
    >
      <Icon className="h-5 w-5 shrink-0" />
      {!isCollapsed && (
        <>
          <span className="flex-1">{label}</span>
          {suffix && <span className="ml-auto">{suffix}</span>}
        </>
      )}
    </Link>
  );

  if (isCollapsed) {
    return (
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>{linkContent}</TooltipTrigger>
        <TooltipContent side="right" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    );
  }

  return linkContent;
}
