'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, X, Plus, ChevronDown, AlertCircle, RotateCw } from 'lucide-react';
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
  // `inSheet` stays in the public prop API (the panel passes it) but is no longer
  // destructured/used: the browse list is now a self-capped floating popup, so it
  // no longer toggles the scroll cap.
  searchPlaceholder,
  fieldId,
  emptyCopy,
  errorCopy,
  noMatchNoun,
}: Readonly<TaxonomyMultiSelectProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close the overlay on outside-mousedown or Escape. Option chips use
  // `onMouseDown` preventDefault so clicking one never blurs/closes mid-toggle.
  useEffect(() => {
    function onPointerDown(event: MouseEvent): void {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  const openOverlay = useCallback((): void => {
    setOpen(true);
    inputRef.current?.focus();
  }, []);

  // Collapse when focus leaves the field entirely — the third dismiss path the
  // ticket requires alongside outside-mousedown and Escape. Chips, "+N more",
  // and the clear button use `onMouseDown` preventDefault so focus stays on the
  // input; intra-field focus moves (relatedTarget inside the root) never close.
  const handleRootBlur = useCallback((event: React.FocusEvent<HTMLDivElement>): void => {
    const root = rootRef.current;
    const next = event.relatedTarget;
    if (root && (next === null || (next instanceof Node && !root.contains(next)))) {
      setOpen(false);
    }
  }, []);

  const multiGroup = taxonomy.groups.length >= 2;
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

  // Carry each selection's group name (category) through for the multi-group
  // pill line. Walk the taxonomy so same-named items keep their group; append
  // any selected id missing from every group (stale / zero-supply) name-only.
  const selectedItems = useMemo(() => {
    const out: Array<{ id: string; name: string; category?: string }> = [];
    const seen = new Set<string>();
    for (const group of taxonomy.groups) {
      for (const item of group.items) {
        if (selectedIds.has(item.id)) {
          out.push({ id: item.id, name: item.name, category: group.name });
          seen.add(item.id);
        }
      }
    }
    for (const id of selectedIds) {
      if (!seen.has(id)) {
        out.push({ id, name: nameMap[id] ?? id, category: undefined });
      }
    }
    return out;
  }, [taxonomy.groups, selectedIds, nameMap]);

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
    <div ref={rootRef} className="relative" onBlur={handleRootBlur}>
      {/* 1 — Search control, anchored at the top. The input opens the overlay
          on focus/click and the chevron is a real toggle button, so the click
          affordances live on interactive elements (not the wrapper div). */}
      <div className="border-border bg-card focus-within:border-ring focus-within:ring-ring/30 flex h-11 cursor-text items-center gap-2.5 rounded-[11px] border px-3.5 transition-shadow focus-within:ring-[3px]">
        <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
        <label htmlFor={`taxonomy-search-${fieldId}`} className="sr-only">
          {searchPlaceholder}
        </label>
        <input
          ref={inputRef}
          id={`taxonomy-search-${fieldId}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          placeholder={searchPlaceholder}
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {query !== '' && (
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              setQuery('');
            }}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground flex shrink-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? setOpen(false) : openOverlay())}
          aria-label={open ? 'Hide options' : 'Show options'}
          aria-expanded={open}
          aria-controls={open ? `taxonomy-browse-${fieldId}` : undefined}
          className="text-muted-foreground hover:text-foreground flex shrink-0"
        >
          <ChevronDown
            className={cn('h-4 w-4 transition-transform', open && 'rotate-180')}
            aria-hidden
          />
        </button>
      </div>

      {/* 2 — Browse overlay popup. Absolutely positioned so opening it never
          reflows following sections (e.g. "Attach documents" stays put). */}
      {open && (
        <div
          id={`taxonomy-browse-${fieldId}`}
          role="group"
          aria-label={`Browse ${noMatchNoun}`}
          className="border-border bg-popover absolute top-[calc(2.75rem+0.5rem)] right-0 left-0 z-30 max-h-[300px] overflow-y-auto rounded-xl border p-2.5 shadow-lg"
          data-testid={`taxonomy-browse-${fieldId}`}
        >
          {filteredGroups.length === 0 && (
            <p role="status" className="text-muted-foreground py-6 text-center text-[13px]">
              No {noMatchNoun} match &ldquo;{trimmed}&rdquo;
            </p>
          )}
          {filteredGroups.map((group) => {
            const isDense = group.items.length > DENSE_CAP && trimmed === '';
            const showAll = expandedGroups.has(group.name);
            const visible = isDense && !showAll ? group.items.slice(0, DENSE_CAP) : group.items;
            const hiddenCount = group.items.length - visible.length;
            return (
              <div key={group.id} className="mb-4 last:mb-0">
                {multiGroup && (
                  <div className="mb-2.5 flex items-baseline gap-2">
                    <span className="text-muted-foreground text-xs font-bold tracking-wide uppercase">
                      {group.name}
                    </span>
                    {group.items.length > 1 && (
                      <span className="text-muted-foreground/70 text-[11px]">
                        {group.items.length}
                      </span>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {visible.map((item, index) => {
                    const revealed = isDense && showAll && index >= DENSE_CAP;
                    return (
                      <motion.div
                        key={item.id}
                        onMouseDown={(e) => e.preventDefault()}
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
                      onMouseDown={(e) => e.preventDefault()}
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
      )}

      {/* 3 — Selected band, below the search control, grows downward (in flow). */}
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
            <div className="bg-muted/60 border-border/60 mt-2.5 rounded-xl border p-3">
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
                      category={multiGroup ? item.category : undefined}
                      onRemove={() => onToggle(item.id)}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
