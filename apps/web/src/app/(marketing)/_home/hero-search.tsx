'use client';

import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Package, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProductSelector } from '@/components/search/composer/product-selector';
import { EMPTY_FILTERS, serializeSearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { PopularChip } from '@/lib/marketing/popular-chips';
import type { MarketingHomeProductSource } from '@/lib/analytics';
import { useMarketingReducedMotion } from '@/components/marketing/motion/use-reduced-motion';
import { useTypewriter } from '@/components/marketing/motion/use-typewriter';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';
import { cn } from '@/lib/utils';

interface HeroSearchProps {
  readonly taxonomy: ProductTaxonomy;
  readonly productNameMap: Record<string, string>;
  readonly chips: readonly PopularChip[];
  readonly phrases: readonly string[];
  readonly verticalName: string;
}

/** §5.4 — the ref's `ProductFacet` summary computation, ported as a pure helper. */
function facetSummary(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return 'Any';
  if (rest.length === 0) return first;
  return `${first} +${rest.length}`;
}

/**
 * BAL-493 §5 — the hero search island. `SearchComposer` is deliberately NOT mounted (§5.1); this
 * wires the real `ProductSelector` (§5.2) into a real `<form>` (§5.3) with one shared
 * `selectedIds` state feeding both the popover facet and the "Popular:" chips (§5.4 — chips and
 * facet cannot drift, because there is exactly one state). The typewriter placeholder (§5.5) is
 * purely decorative and `aria-hidden`; the real `<input>` always carries its own `aria-label`.
 */
export function HeroSearch({
  taxonomy,
  productNameMap,
  chips,
  phrases,
  verticalName,
}: Readonly<HeroSearchProps>): React.JSX.Element {
  const router = useRouter();
  const tracking = useMarketingHomeTracking();
  const reduced = useMarketingReducedMotion();
  const typed = useTypewriter(phrases, reduced);

  const [q, setQ] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [facetOpen, setFacetOpen] = useState(false);

  /**
   * ⚠ THE `track` CALL MUST STAY OUT OF THE `useState` UPDATER. React 19 / Next 16 invoke
   * state updaters TWICE under StrictMode (on by default), so an analytics emit inside the
   * updater double-counts `marketing_home_hero_product_toggled` and silently corrupts AC-6's
   * data. The next set is therefore computed explicitly from `selectedIds` and handed to
   * `setSelectedIds` as a value — which is also why `selectedIds` is a dependency here.
   */
  const handleToggle = useCallback(
    (id: string, source: MarketingHomeProductSource) => {
      const wasSelected = selectedIds.has(id);
      const next = new Set(selectedIds);
      if (wasSelected) next.delete(id);
      else next.add(id);
      setSelectedIds(next);
      tracking.heroProductToggled(productNameMap[id] ?? id, source, !wasSelected);
    },
    [selectedIds, tracking, productNameMap]
  );

  const handleClear = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleFacetOpenChange = useCallback(
    (open: boolean) => {
      setFacetOpen(open);
      if (open) tracking.heroFacetOpened();
    },
    [tracking]
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const productIds = [...selectedIds];
      tracking.heroSearchSubmitted(
        q,
        productIds.map((id) => productNameMap[id] ?? id)
      );
      const params = serializeSearchFilters({ ...EMPTY_FILTERS, q, products: productIds });
      router.push(`/experts?${params.toString()}`);
    },
    [q, selectedIds, tracking, productNameMap, router]
  );

  const selectedNames = useMemo(
    () => [...selectedIds].map((id) => productNameMap[id] ?? id),
    [selectedIds, productNameMap]
  );
  const summary = facetSummary(selectedNames);

  return (
    <>
      <form
        role="search"
        action="/experts"
        method="get"
        onSubmit={handleSubmit}
        className="mk-search"
      >
        <span className="mk-search-icon">
          <Search size={20} aria-hidden="true" />
        </span>
        <div className="mk-search-field">
          <input
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={`Describe what you need help with in ${verticalName}`}
          />
          {q === '' && (
            <span className="mk-search-ghost" aria-hidden="true">
              {typed}
              {!reduced && <span className="mk-caret" />}
            </span>
          )}
        </div>
        {[...selectedIds].map((id) => (
          <input key={id} type="hidden" name="products" value={id} />
        ))}
        <span className="mk-sdiv" aria-hidden="true" />
        <Popover open={facetOpen} onOpenChange={handleFacetOpenChange}>
          <PopoverTrigger asChild>
            <button type="button" className={cn('mk-facet', facetOpen && 'is-open')}>
              <Package size={15} aria-hidden="true" />
              <span className="mk-facet-txt">
                <span className="mk-facet-lab">Product</span>
                <span className={cn('mk-facet-val', selectedIds.size > 0 && 'has')}>{summary}</span>
              </span>
              {selectedIds.size > 0 && (
                <span className="mk-facet-badge mk-mono">{selectedIds.size}</span>
              )}
              <ChevronDown
                size={14}
                className={facetOpen ? 'mk-rot' : undefined}
                aria-hidden="true"
              />
            </button>
          </PopoverTrigger>
          <PopoverContent className="mk-facet-pop" align="end" sideOffset={10}>
            <ProductSelector
              taxonomy={taxonomy}
              selectedIds={selectedIds}
              nameMap={productNameMap}
              onToggle={(id) => handleToggle(id, 'facet')}
              onClear={handleClear}
              surface="popover"
            />
          </PopoverContent>
        </Popover>
        <button type="submit" className="mk-btn mk-btn-grad">
          Find experts
          <ArrowRight size={16} aria-hidden="true" />
        </button>
      </form>

      {chips.length > 0 && (
        <div className="mk-chips">
          <span className="mk-chips-label">Popular:</span>
          {chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={cn('mk-chip', selectedIds.has(chip.id) && 'on')}
              aria-pressed={selectedIds.has(chip.id)}
              onClick={() => handleToggle(chip.id, 'chip')}
            >
              {chip.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
