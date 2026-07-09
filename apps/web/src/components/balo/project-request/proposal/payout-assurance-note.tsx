'use client';

import { Clock, ShieldCheck, TrendingUp, Wallet, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { ProposalPricingMethod } from './proposal-composer-state';

interface PayoutAssuranceNoteProps {
  /** Fixed vs T&M — only toggles the extra "Rates too" disclosure row. */
  pricingMethod: ProposalPricingMethod;
}

interface DisclosureRow {
  icon: LucideIcon;
  /** Colour class for the leading icon — the row's semantic accent. */
  accent: string;
  title: string;
  body: string;
}

/**
 * Expert-facing payout assurance notice (BAL-357). Leads with the benefit — the
 * expert's quote is paid in full — and discloses, without ever showing a number,
 * that Balo adds an (undisclosed) service margin to the client-facing price.
 *
 * Renders NO figures: it needs only {@link ProposalPricingMethod} to decide
 * whether the T&M "Rates too" row appears. The margin percentage never renders.
 *
 * Behaviours (Escape-close, focus-return-to-trigger, outside-click dismiss,
 * `role="dialog"`, portal, enter/exit animation) come from the shadcn
 * {@link Popover} (Radix) — no manual event machinery.
 *
 * Expert-only surface: it discloses the margin, so it must never reach the
 * client. Placement is gated by the caller (`lens === 'expert'`).
 */
export function PayoutAssuranceNote({
  pricingMethod,
}: Readonly<PayoutAssuranceNoteProps>): React.JSX.Element {
  const rows: DisclosureRow[] = [
    {
      icon: Wallet,
      accent: 'text-success',
      title: 'Your quote is yours',
      body: 'The amount you set here is exactly what you’re paid — no deductions.',
    },
    {
      icon: TrendingUp,
      accent: 'text-primary',
      title: 'Balo adds a margin',
      body: 'We add a service margin on top of your quote. That combined figure is the only price your client sees.',
    },
  ];

  if (pricingMethod === 'tm') {
    rows.push({
      icon: Clock,
      accent: 'text-violet-600 dark:text-violet-500',
      title: 'Rates too',
      body: 'On time & materials work, the margin also applies to your hourly rate and deposit.',
    });
  }

  return (
    <div className="mt-2.5 flex items-start gap-2">
      <ShieldCheck className="text-success mt-0.5 h-[15px] w-[15px] shrink-0" aria-hidden="true" />
      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
        You receive this full amount. Balo adds a service margin to the price your client sees.{' '}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="text-primary focus-visible:ring-ring rounded-[3px] font-semibold underline underline-offset-2 hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
            >
              How pricing works
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            aria-label="How pricing works"
            className="bg-popover w-80 rounded-2xl p-4 shadow-lg motion-reduce:animate-none motion-reduce:transition-none"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <span className="text-foreground text-[13.5px] font-bold">How pricing works</span>
              <PopoverClose
                aria-label="Close"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex h-6 w-6 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </PopoverClose>
            </div>

            <div className="flex flex-col gap-3">
              {rows.map((row) => {
                const Icon = row.icon;
                return (
                  <div key={row.title} className="flex gap-2.5">
                    <span className="border-border bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border">
                      <Icon className={cn('h-[15px] w-[15px]', row.accent)} aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-foreground text-[12.5px] font-semibold">{row.title}</p>
                      <p className="text-muted-foreground text-[12.5px] leading-relaxed">
                        {row.body}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>

            <p className="border-border text-muted-foreground mt-3.5 border-t pt-3 text-[12px] leading-relaxed">
              The margin percentage isn’t shown to you, and it isn’t itemised for your client — they
              simply see one total price.
            </p>
          </PopoverContent>
        </Popover>
      </p>
    </div>
  );
}
