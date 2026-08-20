'use client';

import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarProviderCardProps {
  readonly provider: CalendarProvider;
  readonly onConnect: (provider: CalendarProvider) => void;
}

/**
 * BAL-397 §8 (Non-Radix) — a `<Card>` CONTAINING a `<Button>`, not itself a button. The design
 * prototype makes the whole card clickable and nests a "Connect" button inside it; a button
 * inside a button is invalid HTML and produces a double activation target. Only the Button is
 * interactive — the card's hover affordance carries no `onClick` of its own. This is why the
 * file moved off `calendar-provider-button.tsx`.
 */
export function CalendarProviderCard({
  provider,
  onConnect,
}: Readonly<CalendarProviderCardProps>): React.JSX.Element {
  const { label, sublabel, Icon } = PROVIDER_META[provider];

  return (
    <Card className="hover:border-primary/40 flex flex-col items-start gap-3.5 p-4 transition-all hover:shadow-md sm:p-5">
      <div className="bg-card border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border shadow-sm">
        <Icon size={22} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-semibold">{label}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{sublabel}</p>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => onConnect(provider)}
      >
        Connect
      </Button>
    </Card>
  );
}
