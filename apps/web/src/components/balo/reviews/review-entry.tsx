'use client';

import { useCallback, useState } from 'react';
import { User } from 'lucide-react';
import type { ReviewAttribution } from '@balo/shared/reviews';
import { StarRow } from '@/components/expert/profile/rating-stars';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * One review of an expert, as a visitor reads it (design ref `expert-reviews-section.jsx`,
 * `ReviewEntry`). Presentational: it formats nothing. Every attribution string arrives already
 * built by `formatReviewAttribution`, so the capture Preview and the public profile (BAL-629)
 * render the same words.
 *
 * ⚠ A note arrives as `string | null` and is shown as given. The caller decides whether a note
 * is public (`publicReviewNote`); a private note must reach this component as `null`.
 *
 * ⚠ The layout reflows on the CONTAINER's width (a Tailwind container query at 520px), not the
 * viewport's: the same entry sits in a wide profile column and in a narrow popover.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off ("Consultation" is the public label for a case).
 */

/** Notes longer than this clamp to four lines behind a "Read more" toggle. */
export const NOTE_CLAMP_CHARS = 260;

export interface ReviewEntryRater {
  /** A stable key for the row. Never an array index. */
  id: string;
  attribution: ReviewAttribution;
  rating: number;
  note: string | null;
}

export interface ReviewEntryProps {
  engagementKind: 'project' | 'case';
  /** The engagement's rating: the mean of its raters. */
  rating: number;
  /** "Oct 2026", or `null` to omit the date. */
  dateLabel: string | null;
  topics: readonly string[];
  raters: readonly ReviewEntryRater[];
  /** The company every rater opted to show, or `null` ("on the client’s team"). */
  sharedCompanyName: string | null;
  first?: boolean;
}

const KIND_BADGE: Readonly<
  Record<ReviewEntryProps['engagementKind'], { label: string; className: string }>
> = {
  project: { label: 'Project', className: 'bg-primary/10 text-primary' },
  case: { label: 'Consultation', className: 'bg-info/10 text-info' },
};

function formatRating(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

function Avatar({ initials }: Readonly<{ initials: string | null }>): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="bg-muted text-muted-foreground inline-flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold"
    >
      {initials ?? <User className="size-4" />}
    </span>
  );
}

function Attribution({
  attribution,
  rating,
}: Readonly<{ attribution: ReviewAttribution; rating?: number }>): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Avatar initials={attribution.initials} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground text-sm font-semibold break-words">
            {attribution.name}
          </span>
          {rating !== undefined && <RatingStars rating={rating} size={12} />}
        </div>
        {attribution.descriptor !== null && (
          <div className="text-muted-foreground mt-px text-[13px] break-words">
            {attribution.descriptor}
          </div>
        )}
      </div>
    </div>
  );
}

function RatingStars({
  rating,
  size,
}: Readonly<{ rating: number; size: number }>): React.JSX.Element {
  return (
    <span role="img" aria-label={`${formatRating(rating)} out of 5 stars`} className="inline-flex">
      <StarRow rating={rating} size={size} />
    </span>
  );
}

function Note({ text }: Readonly<{ text: string }>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const long = text.length > NOTE_CLAMP_CHARS;
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <div>
      <p
        className={cn(
          'text-foreground max-w-[68ch] text-[15px] leading-relaxed break-words',
          long && !open && 'line-clamp-4'
        )}
      >
        {text}
      </p>
      {long && (
        <Button
          type="button"
          variant="link"
          onClick={toggle}
          aria-expanded={open}
          className="mt-1 h-auto p-0 text-[13.5px] font-semibold"
        >
          {open ? 'Show less' : 'Read more'}
        </Button>
      )}
    </div>
  );
}

function Topics({ topics }: Readonly<{ topics: readonly string[] }>): React.JSX.Element | null {
  if (topics.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {topics.map((topic) => (
        <li
          key={topic}
          className="text-muted-foreground border-border rounded-md border px-2 py-0.5 text-xs leading-snug whitespace-nowrap"
        >
          {topic}
        </li>
      ))}
    </ul>
  );
}

export function ReviewEntry({
  engagementKind,
  rating,
  dateLabel,
  topics,
  raters,
  sharedCompanyName,
  first = false,
}: Readonly<ReviewEntryProps>): React.JSX.Element {
  const badge = KIND_BADGE[engagementKind];
  const [single] = raters;
  const multi = raters.length > 1;

  return (
    <article
      className={cn('@container', first ? 'pt-1 pb-5' : 'border-border/60 border-t py-5')}
      aria-label="Review"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <RatingStars rating={rating} size={15} />
        <span
          className={cn(
            'rounded-md px-2 py-0.5 text-xs leading-snug font-semibold',
            badge.className
          )}
        >
          {badge.label}
        </span>
        {dateLabel !== null && (
          <span className="text-muted-foreground ml-auto text-[13px]">{dateLabel}</span>
        )}
      </div>

      {multi ? (
        <>
          <p className="text-muted-foreground mt-2 text-[13px]">
            {`Rated by ${raters.length} people `}
            {sharedCompanyName === null ? 'on the client’s team' : `at ${sharedCompanyName}`}
          </p>
          <div className="border-border/60 mt-3.5 grid gap-4 border-l-2 pl-3.5">
            {raters.map((rater) => (
              <div key={rater.id}>
                <Attribution attribution={rater.attribution} rating={rater.rating} />
                {rater.note !== null && (
                  <div className="mt-2">
                    <Note text={rater.note} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="mt-3.5">
            <Topics topics={topics} />
          </div>
        </>
      ) : (
        single !== undefined && (
          <>
            {single.note !== null && (
              <div className="mt-3">
                <Note text={single.note} />
              </div>
            )}
            <div className="mt-3.5 flex flex-col items-start justify-between gap-3 @min-[520px]:flex-row @min-[520px]:items-center">
              <Attribution attribution={single.attribution} />
              <Topics topics={topics} />
            </div>
          </>
        )
      )}
    </article>
  );
}
