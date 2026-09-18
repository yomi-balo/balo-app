'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { motion } from 'motion/react';
import { Plus } from 'lucide-react';
import type { CasesIndexCardState } from '@balo/analytics/events';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { useViewerClock } from '@/hooks/use-viewer-clock';
import { useRefreshOnFocus } from '@/hooks/use-refresh-on-focus';
import { loadMoreOpenCases } from '../_actions/load-more-cases';
import { resolveFeaturedTiming } from '../_lib/cases-index-presentation';
import {
  CASES_INDEX_BOOK_CTA,
  CASES_INDEX_BOOK_HREF,
  CASES_INDEX_COPY,
  CASES_INDEX_ERROR_BODY,
  CASES_INDEX_ERROR_TITLE,
  CASES_INDEX_FIND_EXPERT,
  CASES_INDEX_LOCK_BODY,
  CASES_INDEX_OPEN_SECTION,
  CASES_INDEX_RETRY,
  CASES_INDEX_SETUP_BODY,
  CASES_INDEX_SETUP_CTA,
  CASES_INDEX_SETUP_TITLE,
  CASES_INDEX_SHOW_MORE,
  CASES_INDEX_SHOW_MORE_BUSY,
  CASES_INDEX_SHOW_MORE_FAILED,
  casesIndexLockTitle,
} from '../_lib/cases-index-copy';
import { CASES_INDEX_EMPTY_ICONS, CasesIndexEmptyState } from './cases-index-empty-state';
import { FeaturedCaseCard } from './featured-case-card';
import { CaseCard } from './case-card';
import { ResolvedCasesSection } from './resolved-cases-section';
import type {
  CasesIndexCardView,
  CasesIndexCursorDTO,
  CasesIndexData,
  CasesIndexSide,
} from '../_lib/cases-index-view-types';
import type { CasesIndexClickHandler, CasesIndexClickReporter } from './cases-index-click';

/**
 * BAL-567 — the `/cases` index's ONE client island: the page heading, the two sections, the
 * Resolved disclosure, "show more", and every analytics event this surface emits.
 *
 * ⚠⚠ THE HEADING IS AN `<h2>`, NOT AN `<h1>` — and that is a DELIBERATE DEVIATION from the design
 * reference's `PageHead` (decisions D3). BAL-499 shipped THE ONE `<h1>` in the top bar, and
 * `nav-registry` already resolves `/cases` to it, so a second one here would be an a11y defect.
 * The label is passed in from the registry rather than typed as a literal, so a future rename
 * moves the crumb and this heading together.
 *
 * ⚠⚠ THE MOBILE "Book" BUTTON LIVES IN THIS PAGE, NOT IN THE TOP BAR — the second deliberate
 * deviation (decisions D4). `TopNav` has no page-action slot, and adding one is a cross-cutting
 * change to BAL-499/BAL-534's shared chrome that this ticket does not own. Below `sm` the CTA
 * renders full-width under the description; from `sm` up it sits beside the heading, as the
 * reference draws it.
 *
 * ⚠ NO VIEW GATE ANYWHERE. Which list rendered was decided server-side; everything side-dependent
 * here is a `Record<CasesIndexSide, …>` lookup. Pinned by
 * `invariants/cases-index-no-view-gate.test.ts`.
 */

interface CasesIndexShellProps {
  readonly data: CasesIndexData;
  /** The live nav entry's label — never a literal, so the crumb and the heading cannot drift. */
  readonly title: string;
  /**
   * The `expert_settings` nav entry's href, RESOLVED FROM THE REGISTRY by `page.tsx` — never a
   * literal in this tree. `null` when the entry does not resolve for this workspace (it is
   * expert-only), in which case the setup state renders WITHOUT a CTA: an absent action beats a
   * dead one, and a dead one is exactly what a hand-typed `/settings/expert` shipped.
   */
  readonly expertSetupHref: string | null;
}

/** Only the CLIENT side can book, so only it is offered the header CTA and the empty-state one. */
const SHOWS_BOOK_CTA: Readonly<Record<CasesIndexSide, boolean>> = { company: true, expert: false };

/**
 * The expert side lists three denser columns; the client side two comfortable ones; one column on
 * mobile for both. A LOOKUP, not a `side === 'expert'` branch — the rule this whole surface keeps.
 */
const GRID_CLASS: Readonly<Record<CasesIndexSide, string>> = {
  company: 'grid-cols-1 md:grid-cols-2',
  expert: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
};

/** The matching density flag for the card itself. Same lookup discipline as `GRID_CLASS`. */
const DENSE_CARDS: Readonly<Record<CasesIndexSide, boolean>> = { company: false, expert: true };

export function CasesIndexShell({
  data,
  title,
  expertSetupHref,
}: Readonly<CasesIndexShellProps>): React.JSX.Element {
  const router = useRouter();

  if (data.kind === 'error') {
    return (
      <CasesIndexFrame title={title} description={null} action={null}>
        <div className="border-border bg-card rounded-2xl border px-6 py-11 text-center">
          <p className="text-foreground text-base font-semibold">{CASES_INDEX_ERROR_TITLE}</p>
          <p className="text-muted-foreground mt-1.5 text-sm">{CASES_INDEX_ERROR_BODY}</p>
          <Button variant="outline" className="mt-4" onClick={() => router.refresh()}>
            {CASES_INDEX_RETRY}
          </Button>
        </div>
      </CasesIndexFrame>
    );
  }

  if (data.kind === 'no_access') {
    // ⚠ THE LOCK STATE — the loader's FAIL-CLOSED branch, not an empty list. See D9 and
    // `cases-index-empty-state.tsx` for why it is built although no shipped role can reach it.
    return (
      <CasesIndexFrame title={title} description={null} action={null}>
        <CasesIndexEmptyState
          icon={CASES_INDEX_EMPTY_ICONS.locked}
          title={casesIndexLockTitle(data.companyName)}
          body={CASES_INDEX_LOCK_BODY}
          tone="locked"
        />
      </CasesIndexFrame>
    );
  }

  return <CasesIndexReady data={data} title={title} expertSetupHref={expertSetupHref} />;
}

/** The heading + description + CTA frame every state renders inside. */
function CasesIndexFrame({
  title,
  description,
  action,
  children,
}: Readonly<{
  title: string;
  description: string | null;
  action: React.ReactNode;
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.24, ease: 'easeOut' }}
    >
      <div className="mb-5 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <h2 className="text-foreground text-2xl font-semibold tracking-tight">{title}</h2>
          {description !== null && (
            <p className="text-muted-foreground mt-1 text-sm">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </motion.div>
  );
}

/** Everything a "show more" has appended to page one, plus where the next page starts. */
interface OpenPagination {
  /**
   * ⚠⚠ THE SERVER PAYLOAD THIS PAGE-SET BELONGS TO, compared by reference. It is what lets an
   * IN-FLIGHT "Show more" be discarded when its answer lands after a refresh: resetting the
   * state is not enough on its own, because a request issued a moment earlier will still call
   * its `setPagination` and append a page belonging to an ordering that no longer holds —
   * re-creating the duplicate-row bug the reset exists to remove. Clicking "Show more" in an
   * UNFOCUSED window fires exactly that pair (the focus refresh and the click together).
   */
  readonly token: object;
  readonly extraCards: readonly CasesIndexCardView[];
  readonly cursor: CasesIndexCursorDTO | null;
  readonly hasMore: boolean;
}

/** The pagination state a freshly-served page one implies. */
function paginationFor(data: Extract<CasesIndexData, { kind: 'ready' }>): OpenPagination {
  return { token: data, extraCards: [], cursor: data.openCursor, hasMore: data.openHasMore };
}

function CasesIndexReady({
  data,
  title,
  expertSetupHref,
}: Readonly<{
  data: Extract<CasesIndexData, { kind: 'ready' }>;
  title: string;
  expertSetupHref: string | null;
}>): React.JSX.Element {
  const clock = useViewerClock();
  // A case can be booked, rescheduled or closed in another tab; re-reading on focus keeps the
  // list from going stale without polling. Same hook the dashboard Up next card uses.
  useRefreshOnFocus();
  const viewedRef = useRef(false);

  /**
   * ⚠⚠ THE APPENDED PAGES ARE DISCARDED WHENEVER THE SERVER SENDS A NEW `data`, AND THAT IS A
   * CORRECTNESS FIX, NOT TIDINESS. `useRefreshOnFocus` calls `router.refresh()`, which re-renders
   * this component with fresh props and does NOT remount it — so `useState` initialisers do not
   * re-run. Left alone, a viewer who pressed "Show more", tabbed away and came back got fresh
   * page one PLUS the pages appended before the refresh, against a cursor from the old ordering:
   * duplicate `engagementId` React keys, one case rendering as both the featured ticket and a
   * grid card, another vanishing until reload, and the next "Show more" paging from a stale
   * position.
   *
   * ⚠ ADJUSTED DURING RENDER, NOT IN AN EFFECT. React re-runs this component immediately and
   * commits only the corrected output, so the stale rows never paint; an effect would commit them
   * first and then blank them. It is also NOT a `key` remount — that would reset `viewedRef` and
   * turn `cases_index_viewed` into a count of focus events.
   *
   * ⚠ ONE OBJECT, NOT THREE `useState`s, so the reset is atomic: three setters leave three chances
   * to add a fourth field later and forget it here.
   */
  const [pagination, setPagination] = useState<OpenPagination>(() => paginationFor(data));
  const [servedData, setServedData] = useState(data);
  if (servedData !== data) {
    setServedData(data);
    setPagination(paginationFor(data));
  }
  const { extraCards, cursor, hasMore } = pagination;
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (viewedRef.current) return;
    viewedRef.current = true;
    track(RECAP_EVENTS.CASES_INDEX_VIEWED, {
      workspace_type: data.side,
      open_count: data.openCount,
      resolved_count: data.resolvedCount,
      has_featured: data.featured !== null,
    });
    // ⚠ `viewedRef` KEEPS THIS AT EXACTLY ONCE regardless of how many times the effect re-runs
    // (the 60s tick, a "show more" that appends), so the honest dep list is safe here. A view
    // count that re-fired on every append would be a render count, not a view count.
  }, [data]);

  /**
   * ⚠⚠ `card_state` IS COMPUTED AT CLICK TIME, NOT READ OFF THE SERVER'S STAMP. The featured
   * card's state can be `live` a moment after the page rendered `booked`, and reporting the stale
   * one would make every "clicked while live" figure wrong. `resolveFeaturedTiming` is the one
   * place `live` is derived, here as everywhere.
   */
  const trackClick: CasesIndexClickReporter = useCallback(
    (target, card) => {
      let cardState: CasesIndexCardState | null = null;
      if (card !== null) {
        cardState =
          card === data.featured
            ? resolveFeaturedTiming(card, new Date()).effectiveState
            : card.cardState;
      }
      track(RECAP_EVENTS.CASES_INDEX_CLICKED, { target, card_state: cardState });
    },
    [data.featured]
  );

  /** The chrome's own reporter — a header CTA and a resolved row belong to no card. */
  const trackChrome: CasesIndexClickHandler = useCallback(
    (target) => {
      trackClick(target, null);
    },
    [trackClick]
  );
  const handleBookClick = useCallback(() => {
    trackChrome('book');
  }, [trackChrome]);

  const handleShowMore = useCallback(() => {
    if (cursor === null) return;
    // The payload this request is issued AGAINST. Captured here, checked on arrival.
    const issuedFor = data;
    startTransition(async () => {
      const result = await loadMoreOpenCases({ cursor });
      if (!result.success) {
        toast.error(CASES_INDEX_SHOW_MORE_FAILED);
        return;
      }
      setPagination((current) => {
        // ⚠ THE FUNCTIONAL UPDATER SEES THE LATEST STATE, which is what makes this check real: a
        // refresh that landed while this request was in flight has already replaced `token`, so
        // the page is dropped rather than appended to an ordering it was not paged against. No
        // ref, no effect — the comparison happens where the write does.
        if (current.token !== issuedFor) return current;
        return {
          token: current.token,
          extraCards: [...current.extraCards, ...result.rows],
          cursor: result.nextCursor,
          hasMore: result.hasMore,
        };
      });
    });
  }, [cursor, data]);

  const copy = CASES_INDEX_COPY[data.side];
  const showsBook = SHOWS_BOOK_CTA[data.side];
  const bookCta = showsBook ? (
    <Button asChild className="w-full sm:w-auto">
      <Link href={CASES_INDEX_BOOK_HREF} onClick={handleBookClick}>
        <Plus className="size-3.5" aria-hidden="true" />
        {CASES_INDEX_BOOK_CTA}
      </Link>
    </Button>
  ) : null;

  const gridCards = [...data.open, ...extraCards];

  return (
    <CasesIndexFrame
      title={title}
      description={copy.description(data.companyName)}
      action={bookCta}
    >
      {data.empty === null ? (
        <>
          <section aria-labelledby="cases-open-heading">
            <div className="mb-3 flex items-baseline gap-2">
              <h3 id="cases-open-heading" className="text-foreground text-[15px] font-semibold">
                {CASES_INDEX_OPEN_SECTION}
              </h3>
              <span className="text-muted-foreground text-[13px]">{data.openCount}</span>
            </div>

            {data.featured !== null && (
              <FeaturedCaseCard
                card={data.featured}
                now={clock?.now ?? null}
                timeZone={clock?.timeZone ?? null}
                onTrack={trackClick}
              />
            )}

            {gridCards.length > 0 && (
              <div
                className={cn(
                  'mt-4 grid items-stretch gap-4',
                  GRID_CLASS[data.side],
                  data.featured === null && 'mt-0'
                )}
              >
                {gridCards.map((card) => (
                  <CaseCard
                    key={card.engagementId}
                    card={card}
                    side={data.side}
                    dense={DENSE_CARDS[data.side]}
                    clock={clock}
                    onTrack={trackClick}
                  />
                ))}
              </div>
            )}

            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={handleShowMore} disabled={pending}>
                  {pending ? CASES_INDEX_SHOW_MORE_BUSY : CASES_INDEX_SHOW_MORE}
                </Button>
              </div>
            )}
          </section>

          {/* ⚠ `dataToken` IS THE SERVER PAYLOAD'S IDENTITY, and it is what tells the section
              its already-loaded rows are stale — the same refresh hazard the pagination reset
              above exists for. See `ResolvedCasesSection`'s own docblock. */}
          <ResolvedCasesSection
            resolvedCount={data.resolvedCount}
            dataToken={data}
            onTrack={trackChrome}
          />
        </>
      ) : (
        <CasesIndexEmpty
          side={data.side}
          empty={data.empty}
          expertSetupHref={expertSetupHref}
          onTrack={handleBookClick}
        />
      )}
    </CasesIndexFrame>
  );
}

/**
 * The two empty states.
 *
 * ⚠ THE EXPERT'S PLAIN EMPTY STATE OFFERS NO ACTION, ON PURPOSE. There is nothing an expert can
 * do from here to make a client book, and inventing a CTA would be worse than its absence
 * (balo-ui's empty-state rule: keep-with-an-invitation is the default, but only where an action
 * genuinely exists). The setup-incomplete state DOES have one, which is why it is a separate
 * state rather than a variant of this one.
 */
function CasesIndexEmpty({
  side,
  empty,
  expertSetupHref,
  onTrack,
}: Readonly<{
  side: CasesIndexSide;
  empty: NonNullable<Extract<CasesIndexData, { kind: 'ready' }>['empty']>;
  expertSetupHref: string | null;
  /** Already bound to "no card" by the shell — the empty state belongs to none. */
  onTrack: () => void;
}>): React.JSX.Element {
  if (empty === 'expert_setup_incomplete') {
    // ⚠ THE CTA IS OMITTED WHEN THE REGISTRY GIVES NO HREF, rather than falling back to a
    // literal. A guessed destination is how this shipped broken the first time.
    const setupAction =
      expertSetupHref === null
        ? {}
        : { actionLabel: CASES_INDEX_SETUP_CTA, actionHref: expertSetupHref };
    return (
      <CasesIndexEmptyState
        icon={CASES_INDEX_EMPTY_ICONS.setup}
        title={CASES_INDEX_SETUP_TITLE}
        body={CASES_INDEX_SETUP_BODY}
        {...setupAction}
      />
    );
  }
  const copy = CASES_INDEX_COPY[side];
  const offersBooking = SHOWS_BOOK_CTA[side];
  return (
    <CasesIndexEmptyState
      icon={CASES_INDEX_EMPTY_ICONS.empty}
      title={copy.emptyTitle}
      body={copy.emptyBody}
      actionLabel={offersBooking ? CASES_INDEX_FIND_EXPERT : undefined}
      actionHref={offersBooking ? CASES_INDEX_BOOK_HREF : undefined}
      onActionClick={onTrack}
    />
  );
}
