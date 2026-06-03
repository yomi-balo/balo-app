'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { Search, X, Package, ChevronDown, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { DENSE_CAP } from './constants';
import { ProductChip } from './product-chip';
import { SelectedToken } from './selected-token';
import { highlightMatch } from './highlight';

/** Surface label for the `product_selector_opened` analytics event. */
export type ProductSelectorSurface = 'popover' | 'rail' | 'sheet';

interface ProductSelectorProps {
  taxonomy: ProductTaxonomy;
  /** Currently-selected skill UUIDs. */
  selectedIds: ReadonlySet<string>;
  /** Authoritative id→name map (taxonomy-backed, covers zero-supply skills). */
  nameMap: Record<string, string>;
  onToggle: (id: string) => void;
  onClear: () => void;
  /** When `true`, render a collapsible header; otherwise always expanded. */
  collapsible?: boolean;
  /** Initial open state when collapsible. */
  defaultOpen?: boolean;
  /** Lifts the inner scroll cap (the sheet scrolls instead). */
  inSheet?: boolean;
  /** Surface for the open analytics event. */
  surface: ProductSelectorSurface;
  onOpened?: (surface: ProductSelectorSurface) => void;
  onSearched?: (hadResults: boolean) => void;
  onGroupExpanded?: (group: string) => void;
}

const SEARCH_DEBOUNCE_MS = 400;

export function ProductSelector({
  taxonomy,
  selectedIds,
  nameMap,
  onToggle,
  onClear,
  collapsible = false,
  defaultOpen = false,
  inSheet = false,
  surface,
  onOpened,
  onSearched,
  onGroupExpanded,
}: Readonly<ProductSelectorProps>): React.JSX.Element {
  const reduce = useReducedMotion();
  const [query, setQuery] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(!collapsible || defaultOpen);

  // Per-typing-session guard: fire `product_selector_searched` at most once until
  // the box is cleared back to empty.
  const searchedThisSession = useRef(false);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const hadResults = filteredGroups.length > 0;

  // Debounced "searched" analytics, once per typing session.
  useEffect(() => {
    if (trimmed === '') {
      searchedThisSession.current = false;
      return;
    }
    if (searchedThisSession.current) return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchedThisSession.current = true;
      onSearched?.(hadResults);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [trimmed, hadResults, onSearched]);

  const selectedItems = useMemo(
    () => Array.from(selectedIds).map((id) => ({ id, name: nameMap[id] ?? id })),
    [selectedIds, nameMap]
  );

  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) onOpened?.(surface);
      return next;
    });
  }, [onOpened, surface]);

  const expandGroup = useCallback(
    (groupName: string) => {
      setExpandedGroups((prev) => new Set(prev).add(groupName));
      onGroupExpanded?.(groupName);
    },
    [onGroupExpanded]
  );

  const tokensTray = (
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
  );

  const browse = (
    <>
      <div className="border-border bg-card focus-within:border-ring focus-within:ring-ring/30 mb-3 flex h-11 items-center gap-2.5 rounded-[11px] border px-3.5 transition-shadow focus-within:ring-[3px]">
        <Search className="text-muted-foreground h-4 w-4 shrink-0" aria-hidden />
        <label htmlFor={`product-search-${surface}`} className="sr-only">
          Search products and skills
        </label>
        <input
          id={`product-search-${surface}`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter products…"
          className="text-foreground placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        {query !== '' && (
          <button
            type="button"
            onClick={() => setQuery('')}
            aria-label="Clear product search"
            className="text-muted-foreground hover:text-foreground flex shrink-0"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>

      <div
        className={cn('overflow-y-auto pr-1', inSheet ? '' : 'max-h-[300px]')}
        data-testid="product-browse-list"
      >
        {filteredGroups.length === 0 && (
          <p className="text-muted-foreground py-6 text-center text-[13px]">
            No products match &ldquo;{trimmed}&rdquo;
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
                      <ProductChip
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
    </>
  );

  if (!collapsible) {
    return (
      <div>
        {tokensTray}
        {browse}
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggleOpen}
        aria-expanded={open}
        className="flex w-full items-center gap-2 pb-3 text-left"
      >
        <Package className="text-muted-foreground h-3.5 w-3.5" aria-hidden />
        <span className="text-muted-foreground text-[11px] font-bold tracking-wide uppercase">
          Products
        </span>
        {selectedItems.length > 0 && (
          <span className="bg-primary text-primary-foreground flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold">
            {selectedItems.length}
          </span>
        )}
        <ChevronDown
          className={cn(
            'text-muted-foreground ml-auto h-3.5 w-3.5 transition-transform',
            open && 'rotate-180'
          )}
          aria-hidden
        />
      </button>
      {tokensTray}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={reduce ? false : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            {browse}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
