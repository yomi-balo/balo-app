'use client';

import { Link2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { CalendarProviderButton } from './calendar-provider-button';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarEmptyStateProps {
  onConnect: (provider: CalendarProvider) => void;
}

export function CalendarEmptyState({
  onConnect,
}: Readonly<CalendarEmptyStateProps>): React.JSX.Element {
  return (
    <Card className="p-6">
      {/* Section label */}
      <div className="mb-2 flex items-center gap-2">
        <Link2 className="text-primary h-3.5 w-3.5" aria-hidden="true" />
        <span className="text-primary text-[11px] font-bold tracking-wider uppercase">
          Connect a calendar
        </span>
      </div>

      {/* Description */}
      <p className="text-muted-foreground mb-5 text-sm leading-relaxed">
        Balo reads your calendar events to calculate your real availability. Clients will only see
        open slots, never your event titles or details.
      </p>

      {/* Provider buttons */}
      <div className="flex flex-col gap-2.5">
        <CalendarProviderButton provider="google" onClick={() => onConnect('google')} />
        <CalendarProviderButton provider="microsoft" onClick={() => onConnect('microsoft')} />
      </div>
    </Card>
  );
}
