'use client';

import { Link2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CalendarProviderCard } from './calendar-provider-card';
import { PROVIDER_ORDER } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarEmptyStateProps {
  readonly providers: readonly CalendarProvider[];
  readonly onConnect: (provider: CalendarProvider) => void;
}

/**
 * BAL-397 §9.1/§3.3 — the "zero slots" surface: hero + a provider-card grid for every
 * offerable provider (usually both). Framed as an invitation ("Connect your calendar"), never
 * hidden and never absence-framed, per balo-ui.
 */
export function CalendarEmptyState({
  providers,
  onConnect,
}: Readonly<CalendarEmptyStateProps>): React.JSX.Element {
  return (
    <div className="space-y-4">
      <Card className="p-6">
        {/* Plan §9.1 — the icon TILE plus a real <h3>. The primary invitation on the whole
            surface belongs in the heading tree, not in an uppercase eyebrow <span>. */}
        <div className="mb-2 flex items-center gap-3">
          <div className="bg-primary/10 flex size-10 shrink-0 items-center justify-center rounded-xl">
            <Link2 className="text-primary h-[18px] w-[18px]" aria-hidden="true" />
          </div>
          <h3 className="text-foreground text-base font-semibold">Connect your calendar</h3>
        </div>
        <p className="text-muted-foreground text-sm leading-relaxed">
          Sync your work calendar so clients only see the times you&apos;re actually free — and
          confirmed bookings land straight on your schedule.
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {PROVIDER_ORDER.filter((p) => providers.includes(p)).map((provider) => (
          <CalendarProviderCard key={provider} provider={provider} onConnect={onConnect} />
        ))}
      </div>
    </div>
  );
}
