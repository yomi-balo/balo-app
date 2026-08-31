'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight } from 'lucide-react';
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
  /** BAL-497 (D3/D9) — leaves the dashboard shell for the `(marketing)` route group. Presentation
   *  only: renders the jump-out arrow (expanded only), sets `prefetch={false}`, and folds "opens
   *  the public directory" into the accessible name. Never changes the navigation mechanism —
   *  still a soft `<Link>`. */
  jumpOut?: boolean;
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
  jumpOut = false,
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
  // D7 — the ACTIVE BACKGROUND MOVED TO THE PILL (`SidebarNavSection`). Painting it here as well
  // would double-paint the same token at 20% instead of 10%.
  const activeStateClass = isActive ? 'text-primary' : inactiveTextClass;

  // D9 — reuses the EXISTING right-aligned `suffix` slot (`ml-auto`, expanded-only), confirmed
  // generic: the only other user is the expert-checklist badge on `expert_settings`, which
  // carries no `jumpOut`, so they can never collide.
  const trailing =
    suffix ??
    (jumpOut ? <ArrowUpRight className="h-3 w-3 opacity-[0.55]" aria-hidden="true" /> : null);

  // §0.2/D6-AMENDED — a collapsed icon-only link has NO accessible name today (the Radix Tooltip
  // supplies only `aria-describedby`, never a name). `aria-label` is added ONLY when collapsed or
  // jumpOut — an unconditional one would override the link's rendered content and silently drop
  // the expert-checklist badge ("3/5") from the announced name.
  let accessibleName: string | undefined;
  if (jumpOut) {
    accessibleName = `${label}, opens the public directory`;
  } else if (isCollapsed) {
    accessibleName = label;
  }

  const linkContent = (
    <Link
      href={href}
      onClick={onClick}
      prefetch={jumpOut ? false : undefined}
      aria-label={accessibleName}
      className={cn(
        'relative flex h-11 items-center gap-3 rounded-lg px-3 transition-colors',
        'motion-reduce:transition-none',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        isSecondary ? 'text-xs font-normal' : 'text-sm font-medium',
        activeStateClass,
        isCollapsed && 'justify-center gap-0 px-2'
      )}
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span
        aria-hidden={isCollapsed || undefined}
        className={cn(
          'overflow-hidden whitespace-nowrap',
          'transition-[max-width,opacity]',
          '[transition-duration:.22s,.16s]',
          '[transition-timing-function:cubic-bezier(.4,0,.2,1),ease]',
          'motion-reduce:transition-none',
          isCollapsed ? 'max-w-0 opacity-0' : 'max-w-[150px] opacity-100'
        )}
      >
        {label}
      </span>
      {!isCollapsed && trailing && <span className="ml-auto">{trailing}</span>}
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
