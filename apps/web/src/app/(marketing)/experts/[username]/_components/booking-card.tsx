'use client';

import { useEffect, useRef } from 'react';
import { Video, Briefcase, MessageCircle, ChevronRight, ShieldCheck, Heart } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';

interface BookingCardProps {
  expertId: string;
  /** Dollars per minute, or null → "Rate on request". */
  rate: number | null;
  availableForWork: boolean;
  onBook: () => void;
  onStartProject: () => void;
  onMessage: () => void;
}

const TRUST_ROWS = [
  { icon: ShieldCheck, tone: 'text-success', text: 'Identity & certifications verified by Balo' },
  { icon: Heart, tone: 'text-pink-500', text: 'Money-back if your session falls short' },
] as const;

/**
 * Right-rail booking card. Position/order is CSS-only (single source of truth,
 * matching the grid's 820px breakpoint): below 820px it's `order-first` +
 * `relative` so the CTA surfaces first at FIRST PAINT (no hydration jump / CLS);
 * at ≥820px it sits in normal order and is `sticky`. CRITICAL: the card stays a
 * DIRECT child of the two-column grid (its scroll context) — wrapping it in a
 * positioned div would silently kill `position: sticky`.
 *
 * CTAs are stubbed (BAL-252/253/255 replace the handler bodies). Fires a
 * `cta_impression` per CTA on mount.
 */
export function BookingCard({
  expertId,
  rate,
  availableForWork,
  onBook,
  onStartProject,
  onMessage,
}: Readonly<BookingCardProps>): React.JSX.Element {
  const impressionFired = useRef(false);

  useEffect(() => {
    if (impressionFired.current) return;
    impressionFired.current = true;
    for (const cta of ['book', 'project', 'message'] as const) {
      track(EXPERT_PROFILE_EVENTS.PROFILE_CTA_IMPRESSION, { expert_id: expertId, cta });
    }
  }, [expertId]);

  return (
    <div className="relative z-30 order-first flex flex-col gap-3.5 min-[820px]:sticky min-[820px]:top-20 min-[820px]:order-none">
      <Card className="gap-0 overflow-hidden p-0 shadow-[0_12px_40px_rgba(27,26,68,0.12)] min-[820px]:-mt-[105px] dark:shadow-[0_12px_40px_rgba(0,0,0,0.4)]">
        {/* Rate header */}
        <div className="from-primary/5 border-border/60 border-b bg-gradient-to-br to-violet-500/5 px-6 pt-6 pb-5">
          {rate == null ? (
            <span className="text-foreground text-[22px] font-bold tracking-[-0.01em]">
              Rate on request
            </span>
          ) : (
            <div className="flex items-baseline gap-1.5">
              <span className="text-foreground font-mono text-[32px] font-bold tracking-[-0.02em] tabular-nums">
                A${rate.toFixed(2)}
              </span>
              <span className="text-muted-foreground/70 text-[15px] font-semibold">/ min</span>
            </div>
          )}
          <p className="text-muted-foreground mt-1.5 text-[13px]">
            {rate == null
              ? 'Message to discuss scope and pricing'
              : 'Pay only for the minutes you use · incl. service fee'}
          </p>
        </div>

        <div className="px-6 pt-5 pb-6">
          {/* Availability */}
          <div className="mb-4 flex items-center gap-2">
            {availableForWork ? (
              <>
                <span className="animate-pulse-dot bg-success h-2 w-2 rounded-full" />
                <span className="text-foreground text-[13px] font-semibold">
                  Available for new work
                </span>
              </>
            ) : (
              <>
                <span className="bg-muted-foreground/50 h-2 w-2 rounded-full" />
                <span className="text-muted-foreground text-[13px] font-medium">
                  Currently unavailable
                </span>
              </>
            )}
          </div>

          {/* Primary CTA */}
          <button
            type="button"
            onClick={onBook}
            className="from-primary flex w-full items-center justify-center gap-2 rounded-[11px] bg-gradient-to-r to-violet-600 px-4 py-3.5 text-[15px] font-semibold text-white shadow-sm transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-violet-500/50 focus-visible:outline-none dark:to-violet-500"
          >
            <Video className="h-4 w-4" /> Book a consultation
          </button>

          {/* Divider */}
          <div className="my-4 flex items-center gap-3">
            <span className="bg-border/60 h-px flex-1" />
            <span className="text-muted-foreground/70 text-xs font-medium">or</span>
            <span className="bg-border/60 h-px flex-1" />
          </div>

          {/* Secondary CTA — project */}
          <button
            type="button"
            onClick={onStartProject}
            className="border-border flex w-full items-center gap-3 rounded-[11px] border px-3.5 py-3.5 text-left transition-colors hover:border-violet-500/40 hover:bg-violet-500/5 focus-visible:ring-2 focus-visible:ring-violet-500/40 focus-visible:outline-none"
          >
            <span className="flex h-9.5 w-9.5 shrink-0 items-center justify-center rounded-[10px] border border-violet-500/25 bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Briefcase className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="text-foreground block text-sm font-semibold">Start a project</span>
              <span className="text-muted-foreground/70 block text-xs">
                Get a scoped proposal for larger work
              </span>
            </span>
            <ChevronRight className="text-muted-foreground/70 h-4 w-4" />
          </button>

          {/* Message link */}
          <button
            type="button"
            onClick={onMessage}
            className="text-muted-foreground hover:text-foreground mt-3 flex w-full items-center justify-center gap-2 rounded-[10px] py-2.5 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-violet-500/40 focus-visible:outline-none"
          >
            <MessageCircle className="h-4 w-4" /> Send a message first
          </button>
        </div>
      </Card>

      {/* Trust card */}
      <Card className="gap-0 px-5 py-4">
        {TRUST_ROWS.map((row, i) => (
          <div
            key={row.text}
            className={cn(
              'flex items-center gap-3',
              i === 0 ? 'border-border/60 border-b pb-3' : 'pt-3'
            )}
          >
            <row.icon className={cn('h-4 w-4 shrink-0', row.tone)} aria-hidden="true" />
            <span className="text-muted-foreground text-[13px]">{row.text}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
