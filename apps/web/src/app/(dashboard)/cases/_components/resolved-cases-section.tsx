'use client';

import { useCallback, useState, useTransition } from 'react';
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
  readonly onTrack: CasesIndexClickHandler;
}

export function ResolvedCasesSection({
  resolvedCount,
  onTrack,
}: Readonly<ResolvedCasesSectionProps>): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [rows, setRows] = useState<readonly CasesIndexResolvedRowView[]>([]);
  const [cursor, setCursor] = useState<ResolvedCasesCursorDTO | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [pending, startTransition] = useTransition();

  const fetchPage = useCallback((after: ResolvedCasesCursorDTO | null) => {
    startTransition(async () => {
      const result = await loadMoreResolvedCases({ cursor: after });
      if (!result.success) {
        // ⚠ A TOAST, NOT A SILENT NO-OP. The disclosure has already opened, so an empty body with
        // no explanation would read as "there are none" — the opposite of what happened.
        toast.error(CASES_INDEX_SHOW_MORE_FAILED);
        return;
      }
      setRows((current) => [...current, ...result.rows]);
      setCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setLoaded(true);
    });
  }, []);

  const handleToggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    track(RECAP_EVENTS.CASES_INDEX_RESOLVED_TOGGLED, { expanded: next });
    if (next && !loaded) fetchPage(null);
  }, [expanded, loaded, fetchPage]);

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
