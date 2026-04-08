'use client';

import { Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { MicrosoftIcon } from './calendar-provider-icons';

interface CalendarO365WaitingCardProps {
  onTryAgain: () => void;
  onCancel: () => void;
}

const INSTRUCTIONS = [
  'Ask your IT admin to approve "Balo" in the Microsoft Entra admin center',
  'This approval only needs to happen once — all colleagues at your company can connect after',
  'Once approved, click "Try connecting again" below',
] as const;

export function CalendarO365WaitingCard({
  onTryAgain,
  onCancel,
}: Readonly<CalendarO365WaitingCardProps>): React.JSX.Element {
  return (
    <Card className="px-8 py-10 text-center">
      {/* Microsoft badge with clock overlay */}
      <div className="relative mx-auto mb-5 h-[68px] w-[68px]">
        <div className="bg-card border-border flex h-[68px] w-[68px] items-center justify-center rounded-[18px] border shadow-md">
          <MicrosoftIcon size={32} />
        </div>
        <div className="bg-warning/10 border-card absolute -right-1 -bottom-1 flex h-6 w-6 items-center justify-center rounded-full border-2">
          <Clock className="text-warning h-3 w-3" aria-hidden="true" />
        </div>
      </div>

      {/* Status pill */}
      <div className="bg-warning/10 border-warning/20 mb-3.5 inline-flex items-center gap-2 rounded-full border px-4 py-1.5">
        <div className="bg-warning h-2 w-2 animate-pulse rounded-full" />
        <span className="text-warning text-[13px] font-semibold">
          Waiting for IT admin approval
        </span>
      </div>

      <h3 className="text-foreground mb-2.5 text-lg font-semibold">
        Your IT admin needs to take action
      </h3>
      <p className="text-muted-foreground mx-auto max-w-[400px] text-sm leading-relaxed">
        You&apos;ve requested access, but your company&apos;s Microsoft administrator needs to
        approve the Balo calendar integration in their admin portal.
      </p>

      {/* Instructions box */}
      <div className="bg-muted border-border mx-auto mt-5 max-w-[400px] rounded-[10px] border p-4 text-left">
        <p className="text-muted-foreground mb-2.5 text-[11px] font-bold tracking-wider uppercase">
          What to do next
        </p>
        <div className="space-y-2">
          {INSTRUCTIONS.map((text, i) => (
            <div key={i} className="flex gap-2">
              <div className="bg-primary/10 border-primary/20 text-primary flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[9px] font-bold">
                {i + 1}
              </div>
              <span className="text-muted-foreground text-[13px] leading-snug">{text}</span>
            </div>
          ))}
        </div>
      </div>

      <a
        href="https://docs.cronofy.com/calendar-admins/faqs/need-admin-approval-error/"
        target="_blank"
        rel="noreferrer"
        className="text-primary mt-4 mb-5 inline-flex items-center gap-1 text-[13px] hover:underline"
      >
        View admin approval guide
        <ExternalLink className="h-3 w-3" aria-hidden="true" />
      </a>

      {/* CTAs */}
      <div className="flex justify-center gap-2.5">
        <Button className="gap-1.5" onClick={onTryAgain}>
          <RefreshCw className="h-3.5 w-3.5" />
          Try connecting again
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}
