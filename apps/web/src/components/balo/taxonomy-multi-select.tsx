'use client';

import { useMemo, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, X, Plus, AlertCircle, RotateCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { TaxonomyChip } from './taxonomy-chip';
import { SelectedToken } from '@/components/search/composer/selected-token';
import { highlightMatch } from '@/components/search/composer/highlight';
import { DENSE_CAP } from '@/components/search/composer/constants';

interface TaxonomyMultiSelectProps {
  /** The taxonomy to browse (groups[].items[]). Empty groups → empty/error branch. */
  taxonomy: ProductTaxonomy;
  /** Currently-selected option UUIDs. */
  selectedIds: ReadonlySet<string>;
  /** id→name map for selected-token labels. */
  nameMap: Record<string, string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  /** Loading branch (taxonomy still fetching) — skeleton pills. */
  loading?: boolean;
  /** Error branch — when the fetch failed (vs simply empty). */
  error?: boolean;
  /** Re-fetch handler for the empty/error Retry button. */
  onRetry?: () => void;
  /** Lifts the inner scroll cap when inside a scrolling sheet. */
  inSheet?: boolean;
  /** Placeholder for the search box, e.g. "Filter project types…". */
  searchPlaceholder: string;
  /** Accessible name prefix for the search input + a unique id seed. */
  fieldId: string;
  /** Copy for the empty/error panel (no taxonomy returned vs fetch failed). */
  emptyCopy: string;
  errorCopy: string;
  /** "No X match" copy for the search-no-results line. */
  noMatchNoun: string;
}

/**
 * Grouped, searchable, multi-select chip picker — the generalised
 * `ProductSelector`. Drives Tags and Products (design §2.4 / §2.5) from one
 * component, differing only in taxonomy source + copy. Adds the four async
 * states the original lacked: loading (skeleton pills), empty + Retry, error +
 * Retry, success (chips). Selection is always OPTIONAL — never blocks submit.
 */
export function TaxonomyMultiSelect({
  taxonomy,
  selectedIds,
  nameMap,
  onToggle,
  onClear,
  loading = false,
  error = false,
  onRetry,
  inSheet = false,
  searchPlaceholder,
  fieldId,
  emptyCopy,
  errorCopy,
  noMatchNoun,
}: Readonly<TaxonomyMultiSelectProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());

  const trimmed = query.trim();
  const filteredGroups = useMemo(() => {
    if (trimmed === '') return taxonomy.groups;
    const lowered = trimmed.toLowerCase();
    return taxonomy.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.name.toLowerCase().includes(lowered)),
      }))
      .filter((group) => group.items.length > 0 || group.name.toLowerCase().includes(lowered));
  }, [taxonomy.groups, trimmed]);

  const selectedItems = useMemo(
    () => Array.from(selectedIds).map((id) => ({ id, name: nameMap[id] ?? id })),
    [selectedIds, nameMap]
  );

  const expandGroup = (groupName: string): void => {
    setExpandedGroups((prev) => new Set(prev).add(groupName));
  };

  // ── Loading branch — skeleton search bar + group headers + chip pills. ──
  if (loading) {
    return (
      <div aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading options…</span>
        <div className="bg-muted mb-3 h-11 animate-pulse rounded-[11px]" />
        {['sk-g1', 'sk-g2'].map((g) => (
          <div key={g} className="mb-4">
            <div className="bg-muted mb-2.5 h-3 w-28 animate-pulse rounded" />
            <div className="flex flex-wrap gap-2">
              {['p1', 'p2', 'p3'].map((p) => (
                <div key={`${g}-${p}`} className="bg-muted h-9 w-28 animate-pulse rounded-[10px]" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  // ── Empty / error branch — non-blocking panel + Retry (optional field). ──
  if (taxonomy.groups.length === 0) {
    return (
      <div className="border-border bg-muted/30 flex flex-col items-start gap-2 rounded-xl border p-4">
        <p className="text-muted-foreground flex items-center gap-2 text-[13px]">
          {error && <AlertCircle className="text-destructive h-4 w-4 shrink-0" aria-hidden />}
          {error ? errorCopy : emptyCopy}
        </p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-primary hover:text-primary/80 focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-md text-[13px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden /> Retry
          </button>
        )}
      </div>
    );
  }

  return (
    <div>
      <AnimatePresence initial={false}>
        {selectedItems.length > 0 && (
          <motion.div
            layout
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.22 }}
            className="overflow-hidden"
          >
            <div className="bg-muted/60 border-border/60 mb-3.5 rounded-xl border p-3">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
                  {selectedItems.length} selected
                </span>
                <button
                  type="button"
                  onClick={onClear}
                  className="text-muted-foreground hover:text-foreground focus-visible:ring-ring text-xs font-medium underline underline-offset-2 transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  Clear all
                </button>
              </div>
              <motion.div layout className="flex flex-wrap gap-2">
                <AnimatePresence initial={false}>
                  {selectedItems.map((item) => (
                    <SelectedToken
                      key={item.id}
                      label={item.name}
                      onRemove={() => onToggle(item.id)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="border-border bg-card focus-within:border-ring focus-within:ring-ring/30 mb-3 flex h-11 items-center gap-2.5 rounded-[11px] border px-3.5 transition-shadow focus-within:ring-[3px]">
        <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
        <label htmlFor={`taxonomy-search-${fieldId}`} className="sr-only">
          {searchPlaceholder}
        </label>
        <input
          id={`taxonomy-search-${fieldId}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={searchPlaceholder}
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {query !== '' && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground flex shrink-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div
        className={cn('overflow-y-auto pr-1', inSheet ? '' : 'max-h-[300px]')}
        data-testid={`taxonomy-browse-${fieldId}`}
      >
        {filteredGroups.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-[13px]">
            No {noMatchNoun} match &ldquo;{trimmed}&rdquo;
          </p>
        )}
        {filteredGroups.map((group) => {
          const isDense = group.items.length > DENSE_CAP && trimmed === '';
          const showAll = expandedGroups.has(group.name);
          const visible = isDense && !showAll ? group.items.slice(0, DENSE_CAP) : group.items;
          const hiddenCount = group.items.length - visible.length;
          return (
            <div key={group.id} className="mb-4">
              <div className="mb-2.5 flex items-baseline gap-2">
                <span className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
                  {group.name}
                </span>
                {group.items.length > 1 && (
                  <span className="text-muted-foreground/70 text-[11px]">{group.items.length}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {visible.map((item, index) => {
                  const revealed = isDense && showAll && index >= DENSE_CAP;
                  return (
                    <motion.div
                      key={item.id}
                      initial={revealed && !reduce ? { opacity: 0, scale: 0.85 } : false}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{
                        duration: 0.18,
                        delay: revealed ? (index - DENSE_CAP) * 0.03 : 0,
                      }}
                    >
                      <TaxonomyChip
                        label={highlightMatch(item.name, trimmed)}
                        name={item.name}
                        selected={selectedIds.has(item.id)}
                        onToggle={() => onToggle(item.id)}
                      />
                    </motion.div>
                  );
                })}
                {hiddenCount > 0 && (
                  <button
                    type="button"
                    onClick={() => expandGroup(group.name)}
                    className="border-border text-muted-foreground hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-[10px] border border-dashed px-3.5 py-2 text-[13px] font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden /> {hiddenCount} more
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
