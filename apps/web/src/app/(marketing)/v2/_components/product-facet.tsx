'use client';

/**
 * BAL-510 — the /v2 hero's Product facet popover, ported from the design ref
 * (`ProductFacet`, ref :894-997). Renders `{id, name}` items from the `V2Taxonomy`
 * (live or fallback, see `_lib/product-facet-model.ts`) instead of the ref's bare
 * string items — everything else (mini search, grouped chips, dense-cap "+n more",
 * selected badge/summary, Esc/outside-click owned by the caller) is a faithful port.
 *
 * The facet summary and dense-cap logic are hoisted into `_lib/product-facet-model.ts`
 * (`facetSummary`, `filterGroups`, `visibleItems`) rather than left inline: the ref's
 * summary line (ref :898-899) is a nested ternary, which `sonarjs/no-nested-conditional`
 * (S3358) flags as an error in the diff-scoped sonar ruleset, and hoisting keeps this
 * component's render well under the diff-scoped `cognitive-complexity <= 15` limit.
 */

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  facetSummary,
  filterGroups,
  itemKey,
  visibleItems,
  type V2Taxonomy,
  type V2TaxonomyItem,
} from '../_lib/product-facet-model';
import { I } from './icons';

export interface ProductFacetProps {
  taxonomy: V2Taxonomy;
  /**
   * True when `taxonomy.source === 'fallback'` — the live product taxonomy was unavailable, so
   * every item's `id` is null and `selectedProductIds()` can emit nothing. The facet is then
   * INERT BY CONSTRUCTION: without this flag the popover would still open, chips would still
   * highlight and the badge would still count, while submit silently dropped every selection.
   * Showing selected-state theatre for a filter that cannot reach the URL is the one thing the
   * degraded path must not do, so the trigger is disabled and says so.
   */
  unavailable: boolean;
  selectedKeys: ReadonlySet<string>;
  toggle: (key: string) => void;
  clear: () => void;
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}

/**
 * Resolve the selected chip keys back to display names, in selection (insertion)
 * order — mirrors `selectedProductIds` in `product-facet-model.ts`, but for names
 * rather than ids, since the facet trigger's summary is name-based (ref :898-899).
 */
function selectedNames(taxonomy: V2Taxonomy, selectedKeys: ReadonlySet<string>): string[] {
  const namesByKey = new Map<string, string>();
  for (const group of taxonomy.groups) {
    for (const item of group.items) {
      namesByKey.set(itemKey(item), item.name);
    }
  }
  const names: string[] = [];
  for (const key of selectedKeys) {
    const name = namesByKey.get(key);
    if (name !== undefined) names.push(name);
  }
  return names;
}

interface ProductChipProps {
  item: V2TaxonomyItem;
  selected: boolean;
  onToggle: (key: string) => void;
}

function ProductChip({ item, selected, onToggle }: Readonly<ProductChipProps>): React.JSX.Element {
  const chipClassName = `mk2-pchip${selected ? ' on' : ''}`;
  return (
    <button
      type="button"
      className={chipClassName}
      onClick={() => onToggle(itemKey(item))}
      aria-pressed={selected}
    >
      {selected && <I.check size={12} />}
      {item.name}
    </button>
  );
}

export function ProductFacet({
  taxonomy,
  selectedKeys,
  toggle,
  clear,
  open,
  setOpen,
  unavailable,
}: Readonly<ProductFacetProps>): React.JSX.Element {
  const [pq, setPq] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const names = selectedNames(taxonomy, selectedKeys);
  const summary = facetSummary(names);
  const filtered = useMemo(() => filterGroups(taxonomy, pq), [taxonomy, pq]);

  // Computed outside the `className` JSX attribute, deliberately: `prettier-plugin-
  // tailwindcss` treats a template literal authored directly in `className={...}` as a
  // class list and re-serializes it, silently collapsing the significant leading space.
  const facetClassName = `mk2-facet${open ? ' is-open' : ''}`;
  const facetValueClassName = `mk2-facet-val${!unavailable && selectedKeys.size > 0 ? ' has' : ''}`;

  return (
    <>
      <button
        type="button"
        className={facetClassName}
        onClick={() => {
          if (unavailable) return;
          setOpen((o) => !o);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        // `aria-disabled`, NOT `disabled`: a truly disabled <button> fires no mouse events (so the
        // title tooltip never appears) and is skipped outright by some assistive tech. This keeps
        // the control announced, focusable and hoverable while the onClick guard above makes it
        // genuinely inert.
        aria-disabled={unavailable || undefined}
        title={unavailable ? 'Product filtering is unavailable right now' : undefined}
      >
        <I.box size={15} />
        <span className="mk2-facet-txt">
          <span className="mk2-facet-lab">Product</span>
          <span className={facetValueClassName}>{unavailable ? 'Unavailable' : summary}</span>
        </span>
        {!unavailable && selectedKeys.size > 0 && (
          <span className="mk2-facet-badge mk2-mono">{selectedKeys.size}</span>
        )}
        <I.chev size={14} className={open ? 'mk2-rot180' : undefined} />
      </button>
      {open && !unavailable && (
        <div className="mk2-facet-pop" role="dialog" aria-label="Filter by product">
          <div className="mk2-pop-search">
            <I.search size={14} />
            <input
              value={pq}
              onChange={(e) => setPq(e.target.value)}
              onKeyDown={(e) => {
                // Enter here must filter, never submit the outer `<form>` (the FTS bar).
                if (e.key === 'Enter') e.preventDefault();
              }}
              placeholder="Search products…"
              aria-label="Search products"
            />
            {pq && (
              <button
                type="button"
                className="mk2-pop-x"
                onClick={() => setPq('')}
                aria-label="Clear product search"
              >
                <I.x size={13} />
              </button>
            )}
          </div>
          {selectedKeys.size > 0 && (
            <div className="mk2-pop-sel">
              <span className="mk2-mono">{selectedKeys.size} selected</span>
              <button type="button" onClick={clear}>
                Clear all
              </button>
            </div>
          )}
          <div className="mk2-pop-scroll">
            {filtered.length === 0 && (
              <p className="mk2-pop-none">No products match &quot;{pq}&quot;</p>
            )}
            {filtered.map((g) => {
              const { show, hidden } = visibleItems(g, {
                expanded: expanded[g.group] ?? false,
                query: pq,
              });
              return (
                <div key={g.group} className="mk2-pop-group">
                  <div className="mk2-pop-glab">
                    {g.group}
                    {g.items.length > 1 && <em>{g.items.length}</em>}
                  </div>
                  <div className="mk2-pop-chips">
                    {show.map((it) => (
                      <ProductChip
                        key={itemKey(it)}
                        item={it}
                        selected={selectedKeys.has(itemKey(it))}
                        onToggle={toggle}
                      />
                    ))}
                    {hidden > 0 && (
                      <button
                        type="button"
                        className="mk2-pchip mk2-pchip-more"
                        onClick={() => setExpanded((x) => ({ ...x, [g.group]: true }))}
                      >
                        +{hidden} more
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
