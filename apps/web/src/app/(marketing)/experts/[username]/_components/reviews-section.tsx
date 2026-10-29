'use client';

import { useCallback, useId, useState } from 'react';
import { BadgeCheck, ChevronDown, ChevronUp, Info, MessageCircle } from 'lucide-react';
import { REVIEW_SUMMARY_FLOOR } from '@balo/shared/reviews';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SectionLabel } from '@/components/expert/profile';
import { RatingStars } from '@/components/expert/profile/rating-stars';
import type { ProfileReviewEntryView } from '@/components/expert/profile/types';
import { ReviewEntry } from '@/components/balo/reviews/review-entry';
import { track, EXPERT_PROFILE_EVENTS } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import {
  INITIAL_VISIBLE,
  REVIEW_BUCKETS,
  distribution,
  engagementsLabel,
  filterEntries,
  kindCounts,
  kindPhrase,
  showMoreLabel,
  type ReviewsFilter,
} from './reviews-summary';

/**
 * "Reviews" — one entry per reviewed engagement, so the list length equals `ratingCount`
 * (design ref `expert-reviews-section.jsx`).
 *
 * Below `REVIEW_SUMMARY_FLOOR` reviewed engagements the summary is one compact line (average
 * plus a project/consultation phrase) and the entries lead. At or above it the large average,
 * the star distribution and, when both kinds exist, filter chips appear. Chips filter the list
 * only; the summary stays on all engagements. Three entries show first, then "Show N more".
 *
 * The average is always the stored `ratingAverage`; the distribution and the kind phrase come
 * from the entries. The count says "engagements", never "reviews": `ratingCount` counts
 * engagements reviewed, not review rows.
 *
 * Entries arrive already shaped by the server (`mapReviewEntriesToView`): the reviewing person
 * named as "{First} {L}." with an optional role, the client company only when every rater chose
 * it and it is allowed on reviews (the shared D6 rule on `PublicReviewEntry`), and a note only
 * when it is public. `reviews` null, or empty while an average exists, means the entry list is
 * unavailable; the section shows the stored aggregate and says so rather than an empty list.
 *
 * Unrated is an invitation, never absence framing and never hidden: a visitor can act from
 * here. The heading states where ratings come from and the sub-line does the inviting.
 *
 * ⚠ DRAFT COPY — pending MJ sign-off (load-failure line).
 */

const verifiedCopy = (firstName: string): string =>
  `Every rating comes from a client who completed work with ${firstName} on Balo. Each engagement counts once, however many people on the client’s team rated it.`;

function VerifiedEngagements({
  expertId,
  firstName,
}: Readonly<{ expertId: string; firstName: string }>): React.JSX.Element {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        track(EXPERT_PROFILE_EVENTS.REVIEWS_VERIFIED_INFO_OPENED, { expert_id: expertId });
      }
    },
    [expertId]
  );

  return (
    <Popover onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="text-muted-foreground -mr-2 min-h-11 gap-1.5 px-2 text-[13px] font-medium"
        >
          <BadgeCheck className="text-primary size-[15px]" aria-hidden="true" />
          Verified engagements
          <Info className="size-[13px]" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 text-[13px] leading-relaxed">
        <p className="text-muted-foreground">{verifiedCopy(firstName)}</p>
      </PopoverContent>
    </Popover>
  );
}

function CompactSummary({
  average,
  ratingCount,
  entries,
}: Readonly<{
  average: number;
  ratingCount: number;
  entries: readonly ProfileReviewEntryView[];
}>): React.JSX.Element {
  const phrase = kindPhrase(entries) || engagementsLabel(ratingCount);
  return (
    <div className="flex items-center gap-[7px]">
      <RatingStars rating={average} size={18} />
      <span className="text-foreground text-[17px] font-semibold tabular-nums">
        {average.toFixed(1)}
      </span>
      <span className="text-muted-foreground text-sm">from {phrase}</span>
    </div>
  );
}

function Distribution({
  entries,
}: Readonly<{ entries: readonly ProfileReviewEntryView[] }>): React.JSX.Element {
  const counts = distribution(entries);
  const total = entries.length;
  return (
    <div className="grid w-full gap-1.5" role="list" aria-label="Rating distribution">
      {REVIEW_BUCKETS.map((stars) => {
        const count = counts[stars];
        const width = total === 0 ? 0 : (count / total) * 100;
        return (
          <div
            key={stars}
            role="listitem"
            aria-label={`${stars} ${stars === 1 ? 'star' : 'stars'}: ${engagementsLabel(count)}`}
          >
            <div
              aria-hidden="true"
              className="grid grid-cols-[10px_12px_1fr_18px] items-center gap-2"
            >
              <span className="text-muted-foreground text-right text-[12.5px] tabular-nums">
                {stars}
              </span>
              <RatingStars rating={5} size={11} />
              <span className="bg-muted h-1.5 overflow-hidden rounded-[3px]">
                <span
                  className="bg-warning block h-full rounded-[3px]"
                  style={{ width: `${width}%` }}
                />
              </span>
              <span
                className={cn(
                  'text-[12.5px] tabular-nums',
                  count > 0 ? 'text-muted-foreground' : 'text-muted-foreground/60'
                )}
              >
                {count}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FullSummary({
  average,
  ratingCount,
  entries,
}: Readonly<{
  average: number;
  ratingCount: number;
  entries: readonly ProfileReviewEntryView[];
}>): React.JSX.Element {
  return (
    <div className="flex flex-col items-start gap-5 sm:flex-row sm:items-center sm:gap-10">
      <div className="shrink-0">
        <div className="flex items-center gap-2.5">
          <span className="text-foreground text-4xl leading-none font-semibold tracking-tight tabular-nums">
            {average.toFixed(1)}
          </span>
          <RatingStars rating={average} size={26} />
        </div>
        <p className="text-muted-foreground mt-2 text-[13.5px]">
          from {engagementsLabel(ratingCount)}
        </p>
      </div>
      <div className="w-full max-w-full sm:max-w-[300px] sm:flex-1">
        <Distribution entries={entries} />
      </div>
    </div>
  );
}

const CHIPS: readonly { filter: ReviewsFilter; label: string }[] = [
  { filter: 'all', label: 'All' },
  { filter: 'project', label: 'Projects' },
  { filter: 'case', label: 'Consultations' },
];

function FilterChips({
  counts,
  active,
  onSelect,
}: Readonly<{
  counts: Readonly<Record<ReviewsFilter, number>>;
  active: ReviewsFilter;
  onSelect: (filter: ReviewsFilter) => void;
}>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label="Filter reviews by engagement type"
      className="flex flex-wrap gap-1.5"
    >
      {CHIPS.map(({ filter, label }) => {
        const isActive = active === filter;
        return (
          <button
            key={filter}
            type="button"
            aria-pressed={isActive}
            onClick={() => onSelect(filter)}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium focus-visible:ring-2 focus-visible:outline-none',
              isActive
                ? 'bg-foreground text-background border-foreground'
                : 'bg-card text-muted-foreground border-border hover:text-foreground'
            )}
          >
            {label}
            <span className="tabular-nums opacity-70">{counts[filter]}</span>
          </button>
        );
      })}
    </div>
  );
}

function ReviewList({
  entries,
  expanded,
  onToggle,
}: Readonly<{
  entries: readonly ProfileReviewEntryView[];
  expanded: boolean;
  onToggle: (revealed: number) => void;
}>): React.JSX.Element {
  const visible = expanded ? entries : entries.slice(0, INITIAL_VISIBLE);
  const remaining = entries.length - visible.length;
  const canToggle = remaining > 0 || (expanded && entries.length > INITIAL_VISIBLE);
  const handleToggle = useCallback(() => onToggle(remaining), [onToggle, remaining]);
  const listId = useId();

  return (
    <>
      <div id={listId} className="border-border/60 mt-5 border-t pt-5">
        {visible.map((entry, index) => (
          <ReviewEntry
            key={entry.key}
            engagementKind={entry.engagementKind}
            rating={entry.rating}
            dateLabel={entry.dateLabel}
            topics={entry.topics}
            raters={entry.raters}
            sharedCompanyName={entry.sharedCompanyName}
            first={index === 0}
          />
        ))}
      </div>
      {canToggle && (
        <div className="border-border/60 border-t pt-3">
          <Button
            type="button"
            variant="link"
            onClick={handleToggle}
            aria-expanded={expanded}
            aria-controls={listId}
            className="min-h-11 gap-1.5 px-0 text-sm font-semibold"
          >
            {remaining > 0 ? showMoreLabel(remaining) : 'Show fewer'}
            {remaining > 0 ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronUp className="size-4" aria-hidden="true" />
            )}
          </Button>
        </div>
      )}
    </>
  );
}

function Invitation({ firstName }: Readonly<{ firstName: string }>): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <div className="bg-muted mb-4 flex h-12 w-12 items-center justify-center rounded-xl">
        <MessageCircle className="text-muted-foreground h-6 w-6" aria-hidden="true" />
      </div>
      <p className="text-foreground text-sm font-semibold">Ratings come from completed work</p>
      <p className="text-muted-foreground mt-1 max-w-sm text-sm leading-relaxed">
        Be the first to work with {firstName} and share how it went.
      </p>
    </div>
  );
}

const FILTER_NOUNS: Readonly<Record<ReviewsFilter, readonly [string, string]>> = {
  all: ['review', 'reviews'],
  project: ['project review', 'project reviews'],
  case: ['consultation review', 'consultation reviews'],
};

function filterAnnouncement(filter: ReviewsFilter, count: number): string {
  const [one, many] = FILTER_NOUNS[filter];
  return `${count} ${count === 1 ? one : many}`;
}

function RatedReviews({
  expertId,
  firstName,
  ratingAverage,
  ratingCount,
  entries,
}: Readonly<{
  expertId: string;
  firstName: string;
  ratingAverage: number;
  ratingCount: number;
  entries: readonly ProfileReviewEntryView[];
}>): React.JSX.Element {
  const [filter, setFilter] = useState<ReviewsFilter>('all');
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState('');

  const full = ratingCount >= REVIEW_SUMMARY_FLOOR;
  const { projects, consultations } = kindCounts(entries);
  const bothKinds = full && projects > 0 && consultations > 0;
  const listed = full ? filterEntries(entries, filter) : entries;

  const handleSelect = useCallback(
    (next: ReviewsFilter) => {
      setFilter(next);
      setExpanded(false);
      setAnnouncement(`Showing ${filterAnnouncement(next, filterEntries(entries, next).length)}`);
      track(EXPERT_PROFILE_EVENTS.REVIEWS_FILTER_SELECTED, { expert_id: expertId, filter: next });
    },
    [expertId, entries]
  );

  const handleToggle = useCallback(
    (revealed: number) => {
      if (revealed > 0) {
        track(EXPERT_PROFILE_EVENTS.REVIEWS_SHOW_MORE, { expert_id: expertId, revealed });
      }
      setExpanded((value) => !value);
    },
    [expertId]
  );

  const verified = <VerifiedEngagements expertId={expertId} firstName={firstName} />;

  return (
    <>
      {full ? (
        <>
          <FullSummary average={ratingAverage} ratingCount={ratingCount} entries={entries} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            {bothKinds ? (
              <FilterChips
                counts={{ all: entries.length, project: projects, case: consultations }}
                active={filter}
                onSelect={handleSelect}
              />
            ) : (
              <span />
            )}
            {verified}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CompactSummary average={ratingAverage} ratingCount={ratingCount} entries={entries} />
          {verified}
        </div>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      <ReviewList entries={listed} expanded={expanded} onToggle={handleToggle} />
    </>
  );
}

export function ReviewsSection({
  expertId,
  firstName,
  ratingAverage,
  ratingCount,
  reviews,
}: Readonly<{
  expertId: string;
  firstName: string;
  /** `null` ⇒ NO REVIEWS. Never 0.0 — the scale starts at 1. */
  ratingAverage: number | null;
  ratingCount: number;
  /** `null` or empty while rated ⇒ the list is unavailable; the stored aggregate still shows. */
  reviews: readonly ProfileReviewEntryView[] | null;
}>): React.JSX.Element {
  let body: React.JSX.Element;
  if (ratingAverage === null) {
    body = <Invitation firstName={firstName} />;
  } else if (reviews === null || reviews.length === 0) {
    body = (
      <div className="grid gap-2">
        <CompactSummary average={ratingAverage} ratingCount={ratingCount} entries={[]} />
        <p className="text-muted-foreground text-sm">
          Reviews couldn&apos;t load right now. Refresh the page to try again.
        </p>
      </div>
    );
  } else {
    body = (
      <RatedReviews
        expertId={expertId}
        firstName={firstName}
        ratingAverage={ratingAverage}
        ratingCount={ratingCount}
        entries={reviews}
      />
    );
  }

  return (
    <Card className="gap-0 p-7">
      <SectionLabel icon={MessageCircle} tone="muted" className="mb-4">
        Reviews
      </SectionLabel>
      {body}
    </Card>
  );
}
