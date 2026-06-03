'use client';

import { useCallback } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { track, SEARCH_EVENTS } from '@/lib/analytics';
import { useUpdateSearchParams } from './use-update-search-params';

interface SearchPaginationProps {
  page: number;
  total: number;
  pageSize: number;
}

function buildPageNumbers(pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, i) => i + 1);
}

export function SearchPagination({
  page,
  total,
  pageSize,
}: Readonly<SearchPaginationProps>): React.JSX.Element | null {
  const { setPage } = useUpdateSearchParams();

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  const goTo = useCallback(
    (next: number) => {
      if (next < 1 || next > pageCount || next === page) return;
      track(SEARCH_EVENTS.PAGINATION, { to_page: next });
      setPage(next);
    },
    [page, pageCount, setPage]
  );

  if (pageCount <= 1) return null;

  const atStart = page <= 1;
  const atEnd = page >= pageCount;
  const numberBtn = (active: boolean): string =>
    cn(
      'flex h-9 min-w-9 items-center justify-center rounded-[9px] border px-1.5 text-[13px] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
      active
        ? 'border-primary bg-primary/10 text-primary font-bold'
        : 'border-border bg-card text-muted-foreground hover:bg-muted font-medium'
    );

  return (
    <nav className="mt-8 flex items-center justify-center gap-2" aria-label="Pagination">
      <button
        type="button"
        onClick={() => goTo(page - 1)}
        disabled={atStart}
        aria-label="Previous page"
        className={cn(numberBtn(false), 'disabled:cursor-not-allowed disabled:opacity-40')}
      >
        <ChevronLeft className="h-[15px] w-[15px]" />
      </button>

      {/* Desktop: numbered */}
      <div className="hidden items-center gap-2 md:flex">
        {buildPageNumbers(pageCount).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => goTo(p)}
            aria-label={`Page ${p}`}
            aria-current={p === page ? 'page' : undefined}
            className={numberBtn(p === page)}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Mobile: compact */}
      <span className="text-muted-foreground px-2 text-[13px] md:hidden">
        Page {page} of {pageCount}
      </span>

      <button
        type="button"
        onClick={() => goTo(page + 1)}
        disabled={atEnd}
        aria-label="Next page"
        className={cn(
          numberBtn(false),
          'gap-1.5 px-3.5 font-medium disabled:cursor-not-allowed disabled:opacity-40'
        )}
      >
        Next
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </nav>
  );
}
