'use client';

import { useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Shield, User, Users, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, PROJECTS_INBOX_EVENTS } from '@/lib/analytics';
import type { PortfolioLens } from '@/lib/projects-inbox/resolve-portfolio-lens';

/**
 * LensSwitch — the portfolio VIEW chooser (BAL-274 / D1). Renders ONLY when the
 * viewer qualifies for more than one lens; a pure-client user sees no control.
 * Switching writes `?lens=` (shareable, server-rendered — no client refetch) via
 * `router.replace` and fires `projects_inbox_lens_switched`.
 *
 * Tones mirror the detail page's `LENS_META`: client = primary blue, expert =
 * brand violet, admin = info cyan — so the three lenses read apart and match the
 * request-detail "Viewing as" line.
 */

interface LensSwitchProps {
  lens: PortfolioLens;
  allowedLenses: PortfolioLens[];
}

const LENS_META: Record<PortfolioLens, { label: string; icon: LucideIcon; activeTone: string }> = {
  client: { label: 'Client', icon: User, activeTone: 'text-primary' },
  expert: { label: 'Expert', icon: Shield, activeTone: 'text-violet-600 dark:text-violet-400' },
  admin: { label: 'Admin', icon: Users, activeTone: 'text-info' },
};

export function LensSwitch({
  lens,
  allowedLenses,
}: Readonly<LensSwitchProps>): React.JSX.Element | null {
  const router = useRouter();
  const searchParams = useSearchParams();

  const handleSwitch = useCallback(
    (next: PortfolioLens) => {
      if (next === lens) return;
      track(PROJECTS_INBOX_EVENTS.INBOX_LENS_SWITCHED, { from_lens: lens, to_lens: next });
      const params = new URLSearchParams(searchParams.toString());
      params.set('lens', next);
      router.replace(`/projects?${params.toString()}`, { scroll: false });
    },
    [lens, router, searchParams]
  );

  if (allowedLenses.length <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        Lens
      </span>
      <div
        role="tablist"
        aria-label="Portfolio lens"
        className="bg-muted inline-flex gap-1 rounded-lg p-1"
      >
        {allowedLenses.map((option) => {
          const meta = LENS_META[option];
          const Icon = meta.icon;
          const active = option === lens;
          return (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => handleSwitch(option)}
              className={cn(
                'focus-visible:ring-ring inline-flex min-h-[36px] items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none',
                active
                  ? cn('bg-card shadow-sm', meta.activeTone)
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
              {meta.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
