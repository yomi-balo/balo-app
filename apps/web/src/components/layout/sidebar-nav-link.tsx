'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { LucideIcon } from 'lucide-react';

interface SidebarNavLinkProps {
  href: string;
  label: string;
  icon: LucideIcon;
  isCollapsed: boolean;
  isSecondary?: boolean;
  suffix?: React.ReactNode;
}

export function SidebarNavLink({
  href,
  label,
  icon: Icon,
  isCollapsed,
  isSecondary = false,
  suffix,
}: SidebarNavLinkProps): React.JSX.Element {
  const pathname = usePathname();

  // Exact match for "/dashboard", prefix match for everything else
  const isActive =
    href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname === href || pathname.startsWith(href + '/');

  const linkContent = (
    <Link
      href={href}
      className={cn(
        'flex items-center gap-3 rounded-lg px-3 py-2.5 transition-colors',
        'min-h-[44px]',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        isSecondary ? 'text-xs font-normal' : 'text-sm font-medium',
        isActive
          ? 'bg-primary/10 text-primary'
          : isSecondary
            ? 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground'
            : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
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
