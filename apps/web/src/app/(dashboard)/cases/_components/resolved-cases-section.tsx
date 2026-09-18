'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { ChevronDown, CircleCheck, CircleSlash } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import { loadMoreResolvedCases } from '../_actions/load-more-cases';
import { LocalDateTime } from '@/components/balo/date/local-date-time';
import {
  CASES_INDEX_BOOK_AGAIN,
  CASES_INDEX_CLOSED_PREFIX,
  CASES_INDEX_RESOLVED_SECTION,
  CASES_INDEX_SHOW_MORE,
  CASES_INDEX_SHOW_MORE_BUSY,
  CASES_INDEX_SHOW_MORE_FAILED,
  casesIndexHeldCount,
} from '../_lib/cases-index-copy';
import type {
  CasesIndexResolvedRowView,
  ResolvedCasesCursorDTO,
} from '../_lib/cases-index-view-types';
import type { CasesIndexClickHandler } from './cases-index-click';

/**
 * BAL-567 — the RESOLVED section: collapsed by default, and it fetches NOTHING until it is
 * opened.
 *
 * ⚠⚠ COLLAPSED-BY-DEFAULT IS WHY THE ROWS ARE NOT ON THE FIRST PAYLOAD. A resolved case has
 * nothing left to act on, so loading a page of them on every render would be work that most
 * visits never look at. The first expansion calls the Server Action with a `null` cursor.
 *
 * ⚠ THE COUNT IS THE SCOPE'S TOTAL (`count(*)`), not the number of rows loaded — so the heading
 * is honest before anything is fetched and does not jump when a page arrives.
 *
 * ⚠ THE ACTION RE-DERIVES ITS OWN SCOPE from the session and re-runs the participation gate; this
 * component sends only a cursor. See `load-more-cases.ts`.
 */

interface ResolvedCasesSectionProps {
  readonly resolvedCount: number;
  /**
   * The SERVER PAYLOAD'S IDENTITY. A new object means a fresh read landed, which makes any rows
   * this section already loaded stale — see the reset below. It is compared by reference only;
   * nothing here reads a field off it.
   */
  readonly dataToken: object;
  readonly onTrack: CasesIndexClickHandler;
}

/** One loaded page-set of resolved rows. `loaded` is what tells the effect below to stop. */
interface ResolvedPage {
  /** The payload this page-set belongs to — see {@link OpenPagination.token} in the shell. */
  readonly token: object;
  readonly rows: readonly CasesIndexResolvedRowView[];
  readonly cursor: ResolvedCasesCursorDTO | null;
  readonly hasMore: boolean;
  readonly loaded: boolean;
}

function emptyResolvedPage(token: object): ResolvedPage {
  return { token, rows: [], cursor: null, hasMore: true, loaded: false };
}

export function ResolvedCasesSection({
  resolvedCount,
  dataToken,
  onTrack,
}: Readonly<ResolvedCasesSectionProps>): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<ResolvedPage>(() => emptyResolvedPage(dataToken));
  const [pending, startTransition] = useTransition();
  /**
   * ⚠⚠ THE TOKEN A REQUEST IS CURRENTLY IN FLIGHT FOR — **NOT** A BOOLEAN. A plain `true`/`false`
   * guard made this worse than the shell's version of the same bug: after a refresh reset the
   * flag was still `true` from the pre-refresh request, so the effect's page-one reload was
   * BLOCKED, and the in-flight request then appended rows 21-40 with no page one under them.
   * Keyed on the token, a new payload is never blocked by the old payload's request.
   */
  const inFlightFor = useRef<object | null>(null);

  /**
   * ⚠⚠ ALREADY-LOADED ROWS ARE DISCARDED WHEN A FRESH READ LANDS. `useRefreshOnFocus` (in the
   * shell) calls `router.refresh()`, which re-renders without remounting — so `resolvedCount`
   * updated while these rows did not, and the section showed a count that disagreed with its own
   * list, against a cursor from the old ordering. Milder than the open list's version of the
   * same bug, but the same bug.
   *
   * ⚠ THE DISCLOSURE STAYS OPEN. Collapsing a section the viewer deliberately opened would be a
   * second, visible surprise; instead `loaded` goes back to `false` and the effect below re-fetches
   * page one. That also unifies the two paths — first expansion and post-refresh reload are now
   * the same code.
   *
   * ⚠ ADJUSTED DURING RENDER, not in an effect, so the stale rows never paint.
   */
  const [servedToken, setServedToken] = useState(dataToken);
  if (servedToken !== dataToken) {
    setServedToken(dataToken);
    setPage(emptyResolvedPage(dataToken));
  }

  const fetchPage = useCallback(
    (after: ResolvedCasesCursorDTO | null) => {
      // Already fetching for THIS payload. A request for an older one never blocks a new one.
      if (inFlightFor.current === dataToken) return;
      const issuedFor = dataToken;
      inFlightFor.current = issuedFor;
      startTransition(async () => {
        try {
          const result = await loadMoreResolvedCases({ cursor: after });
          if (!result.success) {
            // ⚠ A TOAST, NOT A SILENT NO-OP. The disclosure has already opened, so an empty body
            // with no explanation would read as "there are none" — the opposite of what happened.
            toast.error(CASES_INDEX_SHOW_MORE_FAILED);
            return;
          }
          setPage((current) => {
            // A refresh landed while this was in flight — drop the page rather than stacking it
            // on (or in place of) the fresh one. See `inFlightFor`.
            if (current.token !== issuedFor) return current;
            return {
              token: current.token,
              rows: [...current.rows, ...result.rows],
              cursor: result.nextCursor,
              hasMore: result.hasMore,
              loaded: true,
            };
          });
        } finally {
          // Only clear the slot if it is still OURS — a newer request must not be un-marked.
          if (inFlightFor.current === issuedFor) inFlightFor.current = null;
        }
      });
    },
    [dataToken]
  );

  // Page one, for BOTH the first expansion and a post-refresh reload of an open section.
  useEffect(() => {
    if (!expanded || page.loaded) return;
    fetchPage(null);
  }, [expanded, page.loaded, fetchPage]);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    track(RECAP_EVENTS.CASES_INDEX_RESOLVED_TOGGLED, { expanded: next });
  }, [expanded]);

  const { rows, cursor, hasMore } = page;
  const handleShowMore = useCallback(() => {
    if (cursor !== null) fetchPage(cursor);
  }, [cursor, fetchPage]);

  // Nothing resolved ⇒ no disclosure at all. This is the ONE section the empty-state rule lets us
  // hide: it is purely retrospective, and there is no action a viewer could take from it.
  if (resolvedCount === 0) return null;

  return (
    <section className="mt-7" aria-labelledby="cases-resolved-heading">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={handleToggle}
        className="text-foreground focus-visible:ring-ring inline-flex items-center gap-2 rounded-md text-[15px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
      >
        <ChevronDown
          className={cn('size-4 transition-transform', !expanded && '-rotate-90')}
          aria-hidden="true"
        />
        <span id="cases-resolved-heading">{CASES_INDEX_RESOLVED_SECTION}</span>
        <span className="text-muted-foreground text-[13px] font-medium">{resolvedCount}</span>
      </button>

      {expanded && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className="border-border bg-card divide-border mt-3 divide-y overflow-hidden rounded-xl border"
        >
          {rows.map((row) => (
            <ResolvedCaseRow key={row.engagementId} row={row} onTrack={onTrack} />
          ))}
          {rows.length === 0 && pending && (
            <div className="text-muted-foreground px-4 py-4 text-sm">
              {CASES_INDEX_SHOW_MORE_BUSY}
            </div>
          )}
          {hasMore && rows.length > 0 && (
            <div className="px-4 py-3">
              <Button variant="outline" size="sm" onClick={handleShowMore} disabled={pending}>
                {pending ? CASES_INDEX_SHOW_MORE_BUSY : CASES_INDEX_SHOW_MORE}
              </Button>
            </div>
          )}
        </motion.div>
      )}
    </section>
  );
}

function ResolvedCaseRow({
  row,
  onTrack,
}: Readonly<{
  row: CasesIndexResolvedRowView;
  onTrack: CasesIndexClickHandler;
}>): React.JSX.Element {
  const auto = row.closeReason === 'auto_inactive';
  const Icon = auto ? CircleSlash : CircleCheck;
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 px-4 py-3 transition-colors">
      <Link
        href={row.href}
        onClick={() => onTrack('case')}
        className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <Icon
          className={cn(
            'size-[18px] shrink-0',
            auto ? 'text-muted-foreground' : 'text-emerald-600 dark:text-emerald-400'
          )}
          aria-hidden="true"
        />
        <span className="block min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-semibold">{row.title}</span>
          <span className="text-muted-foreground block truncate text-[12.5px]">
            {row.counterpartyName}
            {row.counterpartyOrgLabel !== null && <span>, {row.counterpartyOrgLabel}</span>}
          </span>
        </span>
        <span className="hidden shrink-0 text-right sm:block">
          <span className="text-muted-foreground block text-[12.5px]">
            {CASES_INDEX_CLOSED_PREFIX[row.closeReason ?? 'unrecorded']}{' '}
            <LocalDateTime iso={row.closedAtIso} variant="day-month" />
          </span>
          <span className="text-muted-foreground/70 block text-xs">
            {casesIndexHeldCount(row.heldCount)}
          </span>
        </span>
      </Link>
      {/* Only a CLIENT can book, and only with a live destination — `bookAgainHref` is `null`
          on the expert side and whenever the expert has no username. */}
      {row.bookAgainHref !== null && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={row.bookAgainHref} onClick={() => onTrack('book_again')}>
            {CASES_INDEX_BOOK_AGAIN}
          </Link>
        </Button>
      )}
    </div>
  );
}
