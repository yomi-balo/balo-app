'use client';

import type { ReactNode } from 'react';
import { NotificationBell } from '@/components/balo/notification-bell';
import { Breadcrumbs } from './breadcrumbs';
import { CommandPalette } from './command-palette';

interface TopNavProps {
  /**
   * BAL-499 — server-rendered chip, client workspaces only (`CreditsChipSlot`, resolved and
   * gated in `(dashboard)/layout.tsx`, a Server Component). This component performs NO
   * workspace read of its own to decide whether to show it — absent/`null` renders no chip
   * markup at all, not even a wrapper element, so an expert workspace's RSC payload never
   * carries a chip node to hydrate (D2).
   */
  readonly creditsChip?: ReactNode;
}

export function TopNav({ creditsChip = null }: Readonly<TopNavProps>): React.JSX.Element {
  return (
    <header className="border-border bg-background/95 supports-[backdrop-filter]:bg-background/60 sticky top-0 z-40 w-full border-b backdrop-blur">
      <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Breadcrumbs />
        {/* Spacer — the ⌘K palette sits between it and the chip, per the design reference. */}
        <div className="flex-1" />
        <CommandPalette />
        {/* BAL-499 F7 — no wrapper `<div>` around the chip: a classless wrapper is still a flex
            item (and so still consumes this row's `gap-3`) even when its content resolves to
            `null` (the slot's error path) or is CSS-hidden below `sm` (the chip's own `hidden
            ... sm:inline-flex`), leaving a stray gap before the bell. Rendering `creditsChip`
            directly means an absent/erroring/hidden chip contributes no flex item at all. */}
        {creditsChip}
        <NotificationBell />
      </div>
    </header>
  );
}
