import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';

// reusable primitive — not mounted in v1 (reviews deferred). Shipped so a future
// reviews feature has a ready, token-driven rating display. Rating/review data is
// null-gated everywhere on the profile, so these never render in this ticket.

interface RatingStarsProps {
  /** 0–5 rating. */
  rating: number;
  /** Star size in px. */
  size?: number;
  className?: string;
}

/**
 * A single star filled to a fractional `rating/5` via an overlay-width clip,
 * matching the design prototype's `RatingStar`.
 */
export function RatingStars({
  rating,
  size = 16,
  className,
}: Readonly<RatingStarsProps>): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  return (
    <div
      className={cn('relative shrink-0 leading-none', className)}
      style={{ width: size, height: size }}
    >
      <Star
        className="text-muted absolute inset-0 fill-current"
        style={{ width: size, height: size }}
      />
      <div className="absolute inset-0 overflow-hidden" style={{ width: `${pct}%` }}>
        <Star className="fill-warning text-warning" style={{ width: size, height: size }} />
      </div>
    </div>
  );
}

interface StarRowProps {
  /** 0–5 rating. */
  rating: number;
  size?: number;
  className?: string;
}

/**
 * A full five-star row filled to `rating`, again via an overlay-width clip.
 * Used on individual reviews in a future reviews feature.
 */
export function StarRow({
  rating,
  size = 14,
  className,
}: Readonly<StarRowProps>): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, (rating / 5) * 100));
  const row = (filled: boolean): React.JSX.Element => (
    <div className="flex gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <Star
          key={i}
          className={cn('fill-current', filled ? 'text-warning' : 'text-muted')}
          style={{ width: size, height: size }}
        />
      ))}
    </div>
  );
  return (
    <div className={cn('relative inline-flex leading-none', className)}>
      {row(false)}
      <div className="absolute inset-0 overflow-hidden" style={{ width: `${pct}%` }}>
        {row(true)}
      </div>
    </div>
  );
}
