'use client';

import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PROVIDER_META } from '../_lib/calendar-providers';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarConnectAnotherProps {
  readonly provider: CalendarProvider;
  readonly onConnect: (provider: CalendarProvider) => void;
}

/**
 * BAL-397 §3.4 — single-provider BY CONSTRUCTION: this only ever renders when exactly one
 * provider slot remains offerable, so it is a NAMED button with that provider's logo, not a
 * dropdown. Simpler than a two-logo affordance and strictly better UX: one click, no menu.
 */
export function CalendarConnectAnother({
  provider,
  onConnect,
}: Readonly<CalendarConnectAnotherProps>): React.JSX.Element {
  const { label, Icon } = PROVIDER_META[provider];

  return (
    <Button
      type="button"
      variant="outline"
      className="border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 w-full gap-2 border-dashed"
      onClick={() => onConnect(provider)}
    >
      <Plus className="h-4 w-4" aria-hidden="true" />
      Connect {label}
      <Icon size={16} />
    </Button>
  );
}
