'use client';

import { useCallback } from 'react';
import Link from 'next/link';
import { CalendarClock, CircleHelp, ListChecks, MessageSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  resolveCardBand,
  resolveNextSlot,
  splitProductTags,
  CASE_TAGS_SHOWN,
  type CardBand,
} from '../_lib/cases-index-presentation';
import {
  CASES_INDEX_UNREAD,
  casesIndexHeldCount,
  casesIndexItemsForYou,
  casesIndexOpenedAt,
} from '../_lib/cases-index-copy';
import { formatCaseDay } from '../_lib/cases-index-presentation';
import { CaseCounterpartyLine } from './case-counterparty-line';
import { CaseTrail } from './case-trail';
import { CaseCardNextSlot } from './case-card-next-slot';
import type { ViewerClock } from '@/hooks/use-viewer-clock';
import type { CasesIndexCardView, CasesIndexSide } from '../_lib/cases-index-view-types';
import type { CasesIndexClickHandler, CasesIndexClickReporter } from './cases-index-click';

/**
 * BAL-567 — ONE open case in the grid.
 *
 * ⚠ TWO DENSITIES, ONE COMPONENT. The expert side lists three columns of denser cards and the
 * client side two comfortable ones, which changes padding, type scale and how many product tags
 * fit — nothing else. `dense` is passed in by the shell (which knows the grid it drew); it is a
 * LAYOUT input, never a side comparison made here.
 *
 * ⚠ THE WHOLE IDENTITY BLOCK IS ONE LINK, not a click handler on the article. A card that
 * navigates from a `div` is invisible to keyboard users and to "open in new tab"; the slot's own
 * button sits OUTSIDE that link so the two targets never nest.
 */

interface CaseCardProps {
  readonly card: CasesIndexCardView;
  readonly side: CasesIndexSide;
  readonly dense: boolean;
  /**
   * ⚠ `null` UNTIL THE BROWSER'S ZONE IS KNOWN, and the time-dependent regions render a skeleton
   * in the meantime — the `up-next-row.tsx` posture, verbatim. Formatting with a server zone on
   * the first paint would produce different HTML on the server and the client for every viewer
   * outside UTC (a hydration mismatch on every page load), and formatting with a GUESSED zone
   * would print a date that then silently moves.
   */
  readonly clock: ViewerClock | null;
  readonly onTrack: CasesIndexClickReporter;
}

const BAND_ICONS: Readonly<Record<CardBand['icon'], LucideIcon>> = {
  'calendar-clock': CalendarClock,
  'circle-help': CircleHelp,
};

/**
 * ⚠ RAW PALETTE FOR THE BAND TEXT, NOT `text-warning` / a violet token — the same contrast
 * reasoning `up-next-row.tsx` records: at 12.5px these are normal-size text and owe AA 4.5:1 on
 * a tinted fill, which the 700-weight scale clears and the semantic tokens do not. The FILLS are
 * the tokens' own tints; a fill carries no contrast obligation.
 */
const BAND_CLASS: Readonly<Record<CardBand['tone'], string>> = {
  amber:
    'bg-amber-50 text-amber-700 shadow-[inset_0_-1px_0_var(--color-amber-200)] dark:bg-amber-500/10 dark:text-amber-400 dark:shadow-none',
  violet:
    'bg-violet-50 text-violet-700 shadow-[inset_0_-1px_0_var(--color-violet-200)] dark:bg-violet-500/10 dark:text-violet-400 dark:shadow-none',
};

export function CaseCard({
  card,
  side,
  dense,
  clock,
  onTrack,
}: Readonly<CaseCardProps>): React.JSX.Element {
  const band = resolveCardBand(card, side);
  const slot = clock === null ? null : resolveNextSlot(card, side, clock.now, clock.timeZone);
  const tags = splitProductTags(
    card.productTags,
    dense ? CASE_TAGS_SHOWN.dense : CASE_TAGS_SHOWN.comfortable
  );
  // ⚠ THE CARD BINDS ITSELF ONCE, so every child gets a STABLE handler identity rather than a
  // fresh arrow on each render (which is what the "wrap handlers in useCallback" rule is about).
  const handleTrack: CasesIndexClickHandler = useCallback(
    (target) => {
      onTrack(target, card);
    },
    [onTrack, card]
  );
  const handleOpen = useCallback(() => {
    handleTrack('case');
  }, [handleTrack]);

  return (
    <article className="border-border bg-card hover:border-muted-foreground/30 flex min-w-0 flex-col overflow-hidden rounded-2xl border shadow-sm transition-colors">
      {band !== null && <CardStateBand band={band} />}

      <Link
        href={card.href}
        onClick={handleOpen}
        className={cn(
          'focus-visible:ring-ring block rounded-t-2xl focus-visible:ring-2 focus-visible:outline-none',
          dense ? 'px-4 pt-3.5 pb-3' : 'px-[18px] pt-4 pb-3'
        )}
      >
        <span
          className={cn(
            'text-foreground line-clamp-2 block font-semibold tracking-tight',
            dense ? 'text-[14.5px] leading-snug' : 'text-base leading-snug'
          )}
        >
          {card.title}
        </span>
        <CaseCounterpartyLine card={card} size={dense ? 'size-5' : 'size-6'} />
        {tags.shown.length > 0 && (
          <span className="mt-2.5 flex flex-wrap gap-1.5">
            {tags.shown.map((tag) => (
              <span
                key={tag}
                className="border-border bg-muted text-muted-foreground rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium"
              >
                {tag}
              </span>
            ))}
            {tags.overflow > 0 && (
              <span className="border-border bg-muted text-muted-foreground/70 rounded-md border px-1.5 py-0.5 text-[11.5px] font-medium">
                +{tags.overflow}
              </span>
            )}
          </span>
        )}
      </Link>

      <div className={cn('border-border border-t py-3', dense ? 'mx-4' : 'mx-[18px]')}>
        {slot === null ? (
          <NextSlotSkeleton />
        ) : (
          <CaseCardNextSlot slot={slot} onTrack={handleTrack} />
        )}
      </div>

      <div
        className={cn(
          'border-border bg-muted/50 mt-auto flex min-h-5 flex-wrap items-center gap-3 border-t py-2.5',
          dense ? 'px-4' : 'px-[18px]'
        )}
      >
        <CaseTrail trail={card.trail} />
        <CaseCardFacts card={card} />
        {!dense && clock !== null && (
          <span className="text-muted-foreground/70 ml-auto text-xs whitespace-nowrap">
            {casesIndexOpenedAt(formatCaseDay(card.openedAtIso, clock.timeZone))}
          </span>
        )}
      </div>
    </article>
  );
}

/** The slot's placeholder before the viewer's clock lands. Same height as either real shape. */
function NextSlotSkeleton(): React.JSX.Element {
  return (
    <span aria-hidden="true" className="flex items-center gap-3">
      <span className="bg-muted block size-11 shrink-0 animate-pulse rounded-[10px]" />
      <span className="block min-w-0 flex-1">
        <span className="bg-muted block h-3.5 w-28 animate-pulse rounded" />
        <span className="bg-muted mt-1.5 block h-3 w-20 animate-pulse rounded" />
      </span>
    </span>
  );
}

function CardStateBand({ band }: Readonly<{ band: CardBand }>): React.JSX.Element {
  const Icon = BAND_ICONS[band.icon];
  return (
    <div
      className={cn(
        'flex items-center gap-2 px-4 py-2 text-[12.5px] font-semibold',
        BAND_CLASS[band.tone]
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{band.text}</span>
    </div>
  );
}

/** The three at-a-glance figures. Each is omitted at zero rather than rendered as "0 for you". */
function CaseCardFacts({ card }: Readonly<{ card: CasesIndexCardView }>): React.JSX.Element {
  return (
    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-3 text-[12.5px]">
      {card.heldCount > 0 && (
        <span className="whitespace-nowrap">{casesIndexHeldCount(card.heldCount)}</span>
      )}
      {card.actionItemsForYou > 0 && (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          <ListChecks className="size-3.5" aria-hidden="true" />
          {casesIndexItemsForYou(card.actionItemsForYou)}
        </span>
      )}
      {card.unread && (
        <span className="text-primary inline-flex items-center gap-1 font-semibold whitespace-nowrap">
          <MessageSquare className="size-3.5" aria-hidden="true" />
          {CASES_INDEX_UNREAD}
        </span>
      )}
    </span>
  );
}
