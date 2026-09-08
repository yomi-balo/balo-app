'use client';

import { useEffect, useRef, useState } from 'react';
import { Clock, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LookupResult, LookupTypeFilter } from '@balo/shared/lookup';
import {
  LOOKUP_FILTER_LABEL,
  countsByFilter,
  filterByType,
  selectionFromRecent,
  selectionFromResult,
  type LookupSelection,
} from '../_lib/lookup-view';
import { useRecentLookups, type RecentLookupEntry } from '../_lib/use-recent-lookups';
import { LookupSearchBox } from './lookup-search-box';
import { LookupTypeChips } from './lookup-type-chips';
import { LookupResultsList } from './lookup-results-list';
import { LookupDrillIn } from './lookup-drill-in';
import { LookupAnalytics, type LookupOpenedSelection } from './lookup-analytics';

/**
 * BAL-551 — the Lookup shell. Owns chip filter, selection and Recent state; composes the
 * search box, chips, results list, drill-in and the analytics island.
 *
 * `q` lives in the URL (server read — see `page.tsx`); everything else here is client state
 * and never touches the URL (BAL-551 plan §2.1).
 */

interface LookupShellProps {
  readonly query: string;
  readonly results: readonly LookupResult[];
  readonly truncated: boolean;
  readonly tooShort: boolean;
}

export function LookupShell({
  query,
  results,
  truncated,
  tooShort,
}: Readonly<LookupShellProps>): React.JSX.Element {
  const [filter, setFilter] = useState<LookupTypeFilter>('all');
  const [selection, setSelection] = useState<LookupSelection | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [opened, setOpened] = useState<LookupOpenedSelection | null>(null);
  const seqRef = useRef(0);
  const previousQueryRef = useRef(query);
  const { recent, remember } = useRecentLookups();

  // Typing resets the chip to All (the ticket's stated behaviour).
  //
  // ⚠ BAL-551 fix round F4 — a change to a DIFFERENT non-empty query also clears the
  // drill-in `selection`, so it cannot keep rendering query A's orphaned entity while the
  // list underneath has already moved on to query B. Clearing the query to EMPTY is the
  // one deliberate exception — that is the Recent view, and `lookup-shell.test.tsx`'s
  // "selecting a result remembers it so it appears in Recent on an empty query" test pins
  // the selection staying open there.
  useEffect(() => {
    const previousQuery = previousQueryRef.current;
    previousQueryRef.current = query;
    setFilter('all');
    if (query !== '' && query !== previousQuery) {
      setSelection(null);
    }
  }, [query]);

  const searching = query.trim() !== '';
  const filtered = filterByType(results, filter);
  const counts = countsByFilter(results);

  function selectResult(result: LookupResult): void {
    setSelection(selectionFromResult(result));
    remember(result);
    seqRef.current += 1;
    setOpened({ entityType: result.type, via: 'search', seq: seqRef.current });
  }

  function selectRecent(entry: RecentLookupEntry): void {
    setSelection(selectionFromRecent(entry));
    remember({ ...entry, publicExpertUsername: null });
    seqRef.current += 1;
    setOpened({ entityType: entry.type, via: 'recent', seq: seqRef.current });
  }

  return (
    <div className="flex flex-col gap-5">
      <LookupSearchBox initialQuery={query} onPendingChange={setIsPending} />

      {searching && <LookupTypeChips filter={filter} counts={counts} onSelect={setFilter} />}

      <div>
        <div className="text-muted-foreground mb-2.5 flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase">
          {searching ? (
            <>
              <Filter className="size-3.5" aria-hidden="true" />
              {filter === 'all' ? 'Results' : LOOKUP_FILTER_LABEL[filter]} · {filtered.length}
            </>
          ) : (
            <>
              <Clock className="size-3.5" aria-hidden="true" />
              Recent · opened by you
            </>
          )}
        </div>
        <div
          className={cn(
            'grid grid-cols-1 items-start gap-4',
            selection !== null && 'lg:grid-cols-2'
          )}
        >
          <LookupResultsList
            query={query}
            filter={filter}
            matches={results}
            filtered={filtered}
            recent={recent}
            tooShort={tooShort}
            truncated={truncated}
            isPending={isPending}
            selectedKey={selection?.key ?? null}
            onSelectResult={selectResult}
            onSelectRecent={selectRecent}
            onShowAllTypes={() => setFilter('all')}
          />
          {selection !== null && <LookupDrillIn selection={selection} />}
        </div>
      </div>

      <LookupAnalytics
        query={query}
        typeFilter={filter}
        resultCount={filtered.length}
        opened={opened}
      />
    </div>
  );
}
