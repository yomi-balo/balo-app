'use client';

import { Link2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { GoogleIcon, MicrosoftIcon } from './calendar-provider-icons';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarConnectingStateProps {
  provider: CalendarProvider;
  onCancel: () => void;
}

export function CalendarConnectingState({
  provider,
  onCancel,
}: CalendarConnectingStateProps): React.JSX.Element {
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerName = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';

  return (
    <Card className="px-8 py-10 text-center">
      {/* Provider badge with pulse ring */}
      <div className="relative mx-auto mb-6 h-16 w-16">
        <div className="border-primary/25 absolute -inset-1 animate-pulse rounded-2xl border-2" />
        <div className="bg-card border-border flex h-16 w-16 items-center justify-center rounded-2xl border shadow-md">
          <ProviderIcon size={30} />
        </div>
      </div>

      {/* Status pill */}
      <div className="bg-primary/10 border-primary/20 mb-3.5 inline-flex items-center gap-2 rounded-full border px-4 py-1.5">
        <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
        <span className="text-primary text-[13px] font-semibold">Waiting for authorization...</span>
      </div>

      {/* Description */}
      <p className="text-muted-foreground mx-auto max-w-[380px] text-sm leading-relaxed">
        A {providerName} sign-in window should have opened. Complete authorization there, then
        return here.
      </p>

      {/* Actions */}
      <div className="mt-6 flex justify-center gap-2">
        <Button size="sm" className="gap-1.5">
          <Link2 className="h-3.5 w-3.5" />
          Re-open window
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
