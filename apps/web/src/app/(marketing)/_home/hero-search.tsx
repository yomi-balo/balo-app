'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { Search, ArrowRight, Package, ChevronDown, Zap, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ProductSelector } from '@/components/search/composer/product-selector';
import { EMPTY_FILTERS, serializeSearchFilters } from '@/lib/search/filters';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { PopularChip } from '@/lib/marketing/popular-chips';
import type {
  MarketingHomeHeroMode,
  MarketingHomeHeroModeSource,
  MarketingHomeProductSource,
} from '@/lib/analytics';
import { useMarketingReducedMotion } from '@/components/marketing/motion/use-reduced-motion';
import { useTypewriter } from '@/components/marketing/motion/use-typewriter';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';
import { seedFromHeroQuery } from '@/lib/marketing/project-intent';
import { consumePendingHomeProject } from '@/lib/marketing/pending-home-project';
import type { ProjectRequestTaxonomies } from '@/lib/project-request/load-project-taxonomy';
import type { ProjectRequestSeed } from '@/components/balo/project-request/panel';
import { cn } from '@/lib/utils';
import { HERO_MODE_COPY } from './copy';
import { HeroModeToggle } from './hero-mode-toggle';
import { useProjectNudge } from './use-project-nudge';

/**
 * BAL-582 §1 — lazy, `ssr: false`: keeps Tiptap and the whole `ProjectRequestPanel` tree out of
 * the marketing home's initial bundle, and keeps `useAuthModal` out of every hero test that never
 * actually opens the panel. Mounted only while `panel !== null` below; renders no DOM of its own
 * until then.
 */
const HomeProjectPanel = dynamic(
  () => import('./home-project-panel').then((m) => m.HomeProjectPanel),
  { ssr: false }
);

interface HeroSearchProps {
  readonly taxonomy: ProductTaxonomy;
  readonly productNameMap: Record<string, string>;
  readonly chips: readonly PopularChip[];
  readonly phrases: readonly string[];
  /** BAL-582 — project-mode typewriter phrases (`VERTICAL.projectPhrases`). */
  readonly projectPhrases: readonly string[];
  readonly verticalName: string;
  /** Whether the visitor is signed in; drives the panel's auth gate (BAL-582). */
  readonly isLoggedIn: boolean;
  /** BAL-582 §3e — RSC-preloaded project taxonomies; omitted → the panel self-loads. */
  readonly projectTaxonomies?: ProjectRequestTaxonomies;
}

/** State for the (lazily mounted) home project panel. `null` = never opened. */
interface HomePanelState {
  open: boolean;
  seed?: ProjectRequestSeed;
  resume: boolean;
}

/** §5.4 — the ref's `ProductFacet` summary computation, ported as a pure helper. */
function facetSummary(names: readonly string[]): string {
  const [first, ...rest] = names;
  if (first === undefined) return 'Any';
  if (rest.length === 0) return first;
  return `${first} +${rest.length}`;
}

/**
 * BAL-493 §5 / BAL-582 §1-§4 — the hero search island. `SearchComposer` is deliberately NOT
 * mounted (§5.1); this wires the real `ProductSelector` (§5.2) into a real `<form>` (§5.3) with
 * one shared `selectedIds` state feeding both the popover facet and the "Popular:" chips (§5.4).
 *
 * BAL-582 adds a project mode, switched by `<HeroModeToggle>`'s one-line sentence, and an intent
 * nudge (`useProjectNudge`) that offers the switch when a consultation-mode query reads as a
 * project. Both project entry points seed and open the existing `ProjectRequestPanel` (via the
 * lazily mounted `./home-project-panel`) — the server always renders consultation mode, so with
 * JS off the page stays consultation-only and `<form action="/experts">` is untouched.
 *
 * Returns a fragment of (up to) three `.mk-hero-inner` children: the sentence toggle
 * (`<HeroModeToggle>`, `p.mk-sent`), `div.mk-search-zone` and `div.mk-chips`.
 */
export function HeroSearch({
  taxonomy,
  productNameMap,
  chips,
  phrases,
  projectPhrases,
  verticalName,
  isLoggedIn,
  projectTaxonomies,
}: Readonly<HeroSearchProps>): React.JSX.Element {
  const router = useRouter();
  const tracking = useMarketingHomeTracking();
  const reduced = useMarketingReducedMotion();

  const [mode, setMode] = useState<MarketingHomeHeroMode>('consultation');
  const [q, setQ] = useState('');
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [facetOpen, setFacetOpen] = useState(false);
  const [panel, setPanel] = useState<HomePanelState | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const intentAppliedRef = useRef(false);

  const typed = useTypewriter(mode === 'project' ? projectPhrases : phrases, reduced);

  /**
   * ⚠ See `handleToggle` below — the same StrictMode hazard applies here. `changeMode` reads
   * `mode` from render scope (not a functional `setMode` updater) and fires `heroModeChanged`
   * directly in the event-handler body, so a StrictMode double-invocation of the callback itself
   * (which React does NOT do — only the functional-updater FORM is double-invoked) never double
   * counts. A no-op (`next === mode`) is ignored entirely.
   */
  const changeMode = useCallback(
    (next: MarketingHomeHeroMode, source: MarketingHomeHeroModeSource) => {
      if (next === mode) return;
      setMode(next);
      tracking.heroModeChanged(next, source);
    },
    [mode, tracking]
  );

  /**
   * `?intent=project` preselects project mode on hydration, exactly once — even under
   * StrictMode's mount→cleanup→mount replay — via `intentAppliedRef`, not the effect's own
   * dependency array (which changes identity every time `changeMode` is recreated). No
   * `useSearchParams`: reading `location.search` directly keeps the `useRouter`-only mocks in
   * this file's, `rhythm.test.tsx`'s and `gradient-cta.test.tsx`'s tests valid.
   */
  useEffect(() => {
    if (intentAppliedRef.current) return;
    if (new URLSearchParams(globalThis.location.search).get('intent') !== 'project') return;
    intentAppliedRef.current = true;
    changeMode('project', 'url');
  }, [changeMode]);

  /**
   * A signed-in visitor whose sign-up/onboarding started from the home hero is sent back here
   * with the marker still set (BAL-582). Consuming it sets project mode (no analytics — this
   * isn't a user-driven mode change) and reopens the panel on the saved draft. After an in-place
   * sign-in the panel is already open, so this effect only consumes the marker.
   */
  useEffect(() => {
    if (!isLoggedIn) return;
    if (!consumePendingHomeProject()) return;
    setMode('project');
    setPanel({ open: true, seed: undefined, resume: true });
  }, [isLoggedIn]);

  const openProjectPanel = useCallback(() => {
    const { seed, seededInto } = seedFromHeroQuery(q, [...selectedIds]);
    tracking.heroProjectCtaClicked(q, selectedIds.size, isLoggedIn, seededInto);
    setPanel({ open: true, seed, resume: false });
  }, [q, selectedIds, tracking, isLoggedIn]);

  const handlePanelClose = useCallback(() => {
    setPanel((prev) => (prev === null ? prev : { ...prev, open: false, resume: false }));
  }, []);

  const {
    visible: nudgeVisible,
    score: nudgeScore,
    dismiss: dismissNudge,
  } = useProjectNudge({
    query: q,
    productCount: selectedIds.size,
    active: mode === 'consultation',
    onShown: tracking.projectNudgeShown,
  });

  const handleNudgeCta = useCallback(() => {
    tracking.projectNudgeClicked(nudgeScore);
    inputRef.current?.focus();
    changeMode('project', 'nudge');
    openProjectPanel();
  }, [tracking, nudgeScore, changeMode, openProjectPanel]);

  const handleNudgeDismiss = useCallback(() => {
    tracking.projectNudgeDismissed(nudgeScore);
    dismissNudge();
    inputRef.current?.focus();
  }, [tracking, nudgeScore, dismissNudge]);

  // Warm the panel chunk ahead of an actual click, once either surface signals real intent.
  useEffect(() => {
    if (mode === 'project' || nudgeVisible) {
      import('./home-project-panel').catch(() => {});
    }
  }, [mode, nudgeVisible]);

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
      if (mode === 'project') {
        openProjectPanel();
        return;
      }
      const productIds = [...selectedIds];
      tracking.heroSearchSubmitted(
        q,
        productIds.map((id) => productNameMap[id] ?? id)
      );
      const params = serializeSearchFilters({ ...EMPTY_FILTERS, q, products: productIds });
      router.push(`/experts?${params.toString()}`);
    },
    [mode, openProjectPanel, q, selectedIds, tracking, productNameMap, router]
  );

  const selectedNames = useMemo(
    () => [...selectedIds].map((id) => productNameMap[id] ?? id),
    [selectedIds, productNameMap]
  );
  const summary = facetSummary(selectedNames);

  return (
    <>
      <HeroModeToggle mode={mode} onChange={changeMode} />

      <div className="mk-search-zone">
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
              ref={inputRef}
              name="q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={
                mode === 'consultation'
                  ? `Describe what you need help with in ${verticalName}`
                  : HERO_MODE_COPY.projectInputLabel(verticalName)
              }
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
                  <span className={cn('mk-facet-val', selectedIds.size > 0 && 'has')}>
                    {summary}
                  </span>
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
            {HERO_MODE_COPY.submit[mode]}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </form>

        {/* BAL-582 §2/§4 — always mounted (not conditionally), so the pill's appearance is
            genuinely a LIVE update assistive tech can observe. `<output>` only allows phrasing
            content, so it holds `span.mk-nudge` alone; the hint and the panel host render as
            siblings after it. `<output>` carries the implicit `status` role (SonarCloud S6819
            forbids a literal `role="status"`), so no attribute is added here. */}
        <output>
          {nudgeVisible && (
            <span className="mk-nudge">
              <span className="mk-nudge-ic">
                <Zap size={14} aria-hidden="true" />
              </span>
              {HERO_MODE_COPY.nudge.label}
              <button type="button" className="mk-nudge-go" onClick={handleNudgeCta}>
                {HERO_MODE_COPY.nudge.cta}
                <ArrowRight size={13} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="mk-nudge-x"
                onClick={handleNudgeDismiss}
                aria-label={HERO_MODE_COPY.nudge.dismiss}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          )}
        </output>
        {mode === 'project' && <p className="mk-mode-hint">{HERO_MODE_COPY.projectHint}</p>}
        {panel !== null && (
          <HomeProjectPanel
            open={panel.open}
            onClose={handlePanelClose}
            seed={panel.seed}
            resumeDraft={panel.resume}
            isLoggedIn={isLoggedIn}
            projectTaxonomies={projectTaxonomies}
          />
        )}
      </div>

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
