'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { GoogleIcon, MicrosoftIcon } from './calendar-provider-icons';
import type { CalendarProvider } from '../_types/calendar';

interface CalendarProviderButtonProps {
  provider: CalendarProvider;
  onClick: () => void;
  alreadyConnected?: boolean;
}

const PROVIDER_CONFIG = {
  google: {
    name: 'Google Calendar',
    description: 'Gmail or Google Workspace',
    Icon: GoogleIcon,
  },
  microsoft: {
    name: 'Microsoft 365',
    description: 'Outlook or Microsoft 365',
    Icon: MicrosoftIcon,
  },
} as const;

export function CalendarProviderButton({
  provider,
  onClick,
  alreadyConnected = false,
}: Readonly<CalendarProviderButtonProps>): React.JSX.Element {
  const config = PROVIDER_CONFIG[provider];
  const { Icon } = config;

  return (
    <button
      type="button"
      onClick={alreadyConnected ? undefined : onClick}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl border-[1.5px] p-3.5 text-left transition-all',
        alreadyConnected
          ? 'bg-muted cursor-default opacity-55'
          : 'bg-card hover:border-primary hover:bg-primary/5 hover:ring-primary/12 border-border cursor-pointer hover:ring-[3px]'
      )}
    >
      {/* Provider icon badge */}
      <div className="bg-card border-border flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] border shadow-sm">
        <Icon size={22} />
      </div>

      {/* Labels */}
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-semibold">{config.name}</p>
        <p className="text-muted-foreground mt-0.5 text-xs">{config.description}</p>
      </div>

      {/* CTA or connected badge */}
      {alreadyConnected ? (
        <div className="border-success/20 bg-success/10 text-success flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold">
          <Check className="h-3 w-3" />
          Connected
        </div>
      ) : (
        <span className="bg-primary/10 text-primary border-primary/20 group-hover:bg-primary shrink-0 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all group-hover:text-white">
          Connect
        </span>
      )}
    </button>
  );
}
