'use client';

import { Clock, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { GoogleIcon, MicrosoftIcon } from './calendar-provider-icons';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarSessionExpiredCardProps {
  provider: CalendarProvider;
  onTryAgain: () => void;
}

export function CalendarSessionExpiredCard({
  provider,
  onTryAgain,
}: Readonly<CalendarSessionExpiredCardProps>): React.JSX.Element {
  const ProviderIcon = provider === 'google' ? GoogleIcon : MicrosoftIcon;
  const providerName = provider === 'google' ? 'Google Calendar' : 'Microsoft 365';

  return (
    <Card className="px-8 py-10 text-center">
      {/* Provider badge — greyed */}
      <div className="bg-card border-border mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border opacity-60 shadow-sm">
        <ProviderIcon size={28} />
      </div>

      {/* Session expired pill */}
      <div className="bg-muted border-border mb-3.5 inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5">
        <Clock className="text-muted-foreground h-3 w-3" aria-hidden="true" />
        <span className="text-muted-foreground text-[13px] font-semibold">
          Connection attempt timed out
        </span>
      </div>

      <p className="text-muted-foreground mx-auto max-w-[360px] text-sm leading-relaxed">
        The {providerName} sign-in session expired before completing. This usually happens if the
        window was open for more than a few minutes.
      </p>
      <p className="text-muted-foreground/70 mx-auto mt-1.5 max-w-[300px] text-[13px]">
        No changes were made to your account.
      </p>

      <Button className="mt-6 gap-1.5" onClick={onTryAgain}>
        <RefreshCw className="h-3.5 w-3.5" />
        Try again
      </Button>
    </Card>
  );
}
