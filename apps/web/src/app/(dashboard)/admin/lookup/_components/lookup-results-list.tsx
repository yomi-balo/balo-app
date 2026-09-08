'use client';

import { motion } from 'motion/react';
import { ChevronRight, RotateCcw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  LOOKUP_RESULT_CAP,
  type LookupEntityType,
  type LookupResult,
  type LookupTypeFilter,
} from '@balo/shared/lookup';
import type { RecentLookupEntry } from '../_lib/use-recent-lookups';
import { LOOKUP_FILTER_LABEL, LOOKUP_TYPE_LABEL, LOOKUP_TYPE_ICON } from '../_lib/lookup-view';

/**
 * BAL-551 — the Lookup results list. All four async states, plus the two distinct zero
 * variants the ticket calls for: "nothing anywhere" and "this chip is empty but other types
 * have matches". `isPending` (the search box's debounced navigation) renders the busy state;
 * the route-segment `loading.tsx` covers first paint.
 */

/** The one row shape both a live `LookupResult` and a stored `RecentLookupEntry` reduce to. */
interface LookupRow {
  readonly key: string;
  readonly type: LookupEntityType;
  readonly id: string;
  readonly title: string;
  readonly sub: string;
}

function rowFor(entity: {
  type: LookupEntityType;
  id: string;
  title: string;
  sub: string;
}): LookupRow {
  return {
    key: `${entity.type}:${entity.id}`,
    type: entity.type,
    id: entity.id,
    title: entity.title,
    sub: entity.sub,
  };
}

interface LookupResultsListProps {
  readonly query: string;
  readonly filter: LookupTypeFilter;
  /** The full result set for the current query, BEFORE the chip filter. */
  readonly matches: readonly LookupResult[];
  /** `matches` after the chip filter. */
  readonly filtered: readonly LookupResult[];
  readonly recent: readonly RecentLookupEntry[];
  readonly tooShort: boolean;
  readonly truncated: boolean;
  readonly isPending: boolean;
  readonly selectedKey: string | null;
  readonly onSelectResult: (result: LookupResult) => void;
  readonly onSelectRecent: (entry: RecentLookupEntry) => void;
  readonly onShowAllTypes: () => void;
}

function LoadingSkeleton(): React.JSX.Element {
  return (
    <output
      aria-busy="true"
      className="border-border bg-card block overflow-hidden rounded-2xl border"
    >
      <span className="sr-only">Searching Lookup…</span>
      {['row-a', 'row-b', 'row-c', 'row-d', 'row-e', 'row-f'].map((key) => (
        <div
          key={key}
          className="border-border/60 flex items-center gap-3 border-b p-4 last:border-b-0"
        >
          <div className="bg-muted size-[30px] shrink-0 animate-pulse rounded-lg" />
          <div className="flex-1 space-y-2">
            <div className="bg-muted h-4 w-1/3 animate-pulse rounded" />
            <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </output>
  );
}

function EmptyInvitation(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-5 py-8 text-center">
      <Search className="text-muted-foreground mx-auto mb-3 size-6" aria-hidden="true" />
      <p className="text-foreground text-sm font-semibold">
        {/* pending-MJ */}
        Search for anyone or anything — a name, an email, a company domain, a session id, or a
        Stripe PaymentIntent.
      </p>
    </div>
  );
}

function TooShortNotice(): React.JSX.Element {
  return (
    <div className="border-border bg-card rounded-2xl border px-5 py-8 text-center">
      <p className="text-muted-foreground text-sm">
        {/* pending-MJ */}
        Keep typing — Lookup needs at least two characters.
      </p>
    </div>
  );
}

interface NothingFoundProps {
  readonly query: string;
  readonly filter: LookupTypeFilter;
  readonly otherTypesCount: number;
  readonly onShowAllTypes: () => void;
}

function NothingFound({
  query,
  filter,
  otherTypesCount,
  onShowAllTypes,
}: Readonly<NothingFoundProps>): React.JSX.Element {
  const chipFiltered = filter !== 'all' && otherTypesCount > 0;
  return (
    <div className="border-border bg-card rounded-2xl border px-5 py-8 text-center">
      <p className="text-foreground text-sm font-semibold">
        {chipFiltered
          ? `Nothing in ${LOOKUP_FILTER_LABEL[filter].toLowerCase()} for "${query}"`
          : `Nothing matches "${query}"`}
      </p>
      <p className="text-muted-foreground mt-1.5 text-xs">
        {chipFiltered
          ? `${otherTypesCount} in other types.`
          : /* pending-MJ */ 'Try a person, a company or agency, an email, or an id.'}
      </p>
      {chipFiltered && (
        <button
          type="button"
          onClick={onShowAllTypes}
          className="text-primary focus-visible:ring-ring mt-3 inline-flex min-h-[44px] items-center gap-1.5 rounded px-2 text-xs font-semibold hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          {/* pending-MJ */}
          Show all types
        </button>
      )}
    </div>
  );
}

interface ResultRowProps {
  readonly row: LookupRow;
  readonly index: number;
  readonly selected: boolean;
  readonly onClick: () => void;
}

function ResultRow({ row, index, selected, onClick }: Readonly<ResultRowProps>): React.JSX.Element {
  const Icon = LOOKUP_TYPE_ICON[row.type];
  return (
    <motion.div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, delay: 0.04 + index * 0.03 }}
      className={cn(
        'border-border/60 focus-visible:ring-ring flex min-h-[44px] cursor-pointer items-center gap-3 border-b p-4 transition-colors last:border-b-0 focus-visible:ring-2 focus-visible:outline-none',
        selected ? 'bg-primary/10 shadow-[inset_3px_0_0_var(--primary)]' : 'hover:bg-muted'
      )}
    >
      <div className="bg-muted flex size-[30px] shrink-0 items-center justify-center rounded-lg">
        <Icon className="text-muted-foreground size-3.5" aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-foreground text-sm font-semibold">{row.title}</p>
        <p className="text-muted-foreground mt-0.5 text-xs leading-snug">{row.sub}</p>
      </div>
      <span className="bg-muted text-muted-foreground inline-flex w-fit shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap">
        {LOOKUP_TYPE_LABEL[row.type]}
      </span>
      <ChevronRight className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
    </motion.div>
  );
}

export function LookupResultsList({
  query,
  filter,
  matches,
  filtered,
  recent,
  tooShort,
  truncated,
  isPending,
  selectedKey,
  onSelectResult,
  onSelectRecent,
  onShowAllTypes,
}: Readonly<LookupResultsListProps>): React.JSX.Element {
  const searching = query.trim() !== '';

  // BAL-551 fix round F13 — `!searching` is checked BEFORE `isPending`, deliberately. The
  // shell's `isPending` state updates one effect-tick behind the `query` prop (it is lifted
  // from the search box's own `useTransition` via an `onPendingChange` EFFECT, not
  // synchronously during render), so the render that first carries the just-cleared `query`
  // can still carry a STALE `isPending: true`. Recent is client-side and instant either way,
  // so there is never a real search in flight to show a skeleton for once the query is empty.
  if (!searching) {
    if (recent.length === 0) return <EmptyInvitation />;
    return (
      <div className="border-border bg-card overflow-hidden rounded-2xl border">
        {recent.map((entry, index) => (
          <ResultRow
            key={rowFor(entry).key}
            row={rowFor(entry)}
            index={index}
            selected={rowFor(entry).key === selectedKey}
            onClick={() => onSelectRecent(entry)}
          />
        ))}
      </div>
    );
  }

  if (isPending) return <LoadingSkeleton />;

  if (tooShort) return <TooShortNotice />;

  if (filtered.length === 0) {
    return (
      <NothingFound
        query={query}
        filter={filter}
        otherTypesCount={matches.length}
        onShowAllTypes={onShowAllTypes}
      />
    );
  }

  return (
    <div>
      <div className="border-border bg-card overflow-hidden rounded-2xl border">
        {filtered.map((entity, index) => (
          <ResultRow
            key={rowFor(entity).key}
            row={rowFor(entity)}
            index={index}
            selected={rowFor(entity).key === selectedKey}
            onClick={() => onSelectResult(entity)}
          />
        ))}
      </div>
      {truncated && (
        <p className="text-muted-foreground mt-2 text-xs">
          {/* pending-MJ */}
          Showing the first {LOOKUP_RESULT_CAP} matches — add a word to narrow it down.
        </p>
      )}
    </div>
  );
}
