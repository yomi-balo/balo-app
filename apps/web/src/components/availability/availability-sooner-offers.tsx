'use client';

import { Button } from '@/components/ui/button';
import { formatOfferTime } from './availability-day-keys';
import type { SoonerOffer } from './availability-filters';

interface AvailabilitySoonerOffersProps {
  offers: readonly SoonerOffer[];
  viewerTimezone: string;
  /** The selected day has no time at the chosen length: lead with the weekday instead. */
  emptyDay: boolean;
  weekday: string;
  onTakeOffer: (offer: SoonerOffer) => void;
}

function leadLine(emptyDay: boolean, count: number, weekday: string): string {
  if (!emptyDay) return 'Need it sooner? Try a shorter call:';
  return count > 1 ? `Shorter calls on ${weekday}:` : `A shorter call on ${weekday}:`;
}

/** One row of earlier, shorter alternatives to the chosen length. */
export function AvailabilitySoonerOffers({
  offers,
  viewerTimezone,
  emptyDay,
  weekday,
  onTakeOffer,
}: Readonly<AvailabilitySoonerOffersProps>): React.JSX.Element {
  return (
    <div className="border-border bg-muted/40 mb-3 rounded-[10px] border px-3.5 py-3 text-[13px] leading-snug">
      <p className="text-foreground mb-2">{leadLine(emptyDay, offers.length, weekday)}</p>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(72px,1fr))] gap-1.5">
        {offers.map((offer) => {
          const time = formatOfferTime(offer.start, viewerTimezone);
          return (
            <Button
              key={offer.minutes}
              type="button"
              variant="outline"
              className="border-primary/30 hover:border-primary hover:bg-primary/5 h-auto min-h-11 flex-col items-start gap-px px-2 py-1.5 tabular-nums"
              onClick={() => onTakeOffer(offer)}
            >
              <span className="sr-only">Switch to</span>{' '}
              <span className="text-foreground text-[13px] font-semibold whitespace-nowrap">
                {time}
              </span>{' '}
              <span className="text-primary text-xs font-medium">{offer.minutes} min</span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
