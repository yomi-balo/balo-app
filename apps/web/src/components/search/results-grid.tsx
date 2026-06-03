'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { ExpertCardData } from '@/components/expert';
import { SearchResultCard } from './search-result-card';

interface ResultsGridProps {
  experts: ExpertCardData[];
  layout: 'grid' | 'list';
  sort: string;
  page: number;
}

const GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
} as const;

function GridBlock({
  experts,
  sort,
  page,
}: Readonly<{ experts: ExpertCardData[]; sort: string; page: number }>): React.JSX.Element {
  return (
    <div className="grid items-stretch gap-4 md:gap-5" style={GRID_STYLE}>
      {experts.map((expert, i) => (
        <SearchResultCard
          key={expert.id}
          expert={expert}
          variant="grid"
          position={i + 1}
          sort={sort}
          page={page}
        />
      ))}
    </div>
  );
}

function ListBlock({
  experts,
  sort,
  page,
}: Readonly<{ experts: ExpertCardData[]; sort: string; page: number }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      {experts.map((expert, i) => (
        <SearchResultCard
          key={expert.id}
          expert={expert}
          variant="list"
          position={i + 1}
          sort={sort}
          page={page}
        />
      ))}
    </div>
  );
}

/**
 * Renders the results grid (default) or list. The list layout is desktop-only:
 * when `layout==='list'` we render BOTH a `md:hidden` grid block AND a
 * `hidden md:block` list block, so below `md` the grid shows and at/above `md` the
 * list shows — realising `effectiveLayout = isMobile ? 'grid' : userChoice` with
 * zero client breakpoint code (no `window`/resize, no hydration mismatch).
 */
function ResultsBlocks({
  experts,
  layout,
  sort,
  page,
}: Readonly<ResultsGridProps>): React.JSX.Element {
  if (layout === 'list') {
    return (
      <>
        <div className="md:hidden">
          <GridBlock experts={experts} sort={sort} page={page} />
        </div>
        <div className="hidden md:block">
          <ListBlock experts={experts} sort={sort} page={page} />
        </div>
      </>
    );
  }

  return <GridBlock experts={experts} sort={sort} page={page} />;
}

/**
 * Results region with a Tier-1 cross-fade between grid and list — Motion's
 * `AnimatePresence mode="wait"` (out then in, no overlap), keyed by the active
 * `layout`. Opacity + small y (~8px) over ~200ms easeOut; under
 * `prefers-reduced-motion` it drops to a quick opacity-only fade (~120ms).
 * `initial={false}` so the first server-rendered layout does NOT animate in on
 * page load — only subsequent grid↔list toggles cross-fade. Layout is URL-driven,
 * so a toggle is a soft navigation that re-renders this client component with a
 * new `layout`; AnimatePresence sees the key change and runs the transition.
 *
 * Deliberately a cross-fade, NOT a shared-element morph (the avatar-glide morph
 * was prototyped and rejected as too busy at full-grid scale): grid and list stay
 * two separate components and we simply fade the whole region between them.
 */
export function ResultsGrid({
  experts,
  layout,
  sort,
  page,
}: Readonly<ResultsGridProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={layout}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
        transition={{ duration: reduceMotion ? 0.12 : 0.2, ease: 'easeOut' }}
      >
        <ResultsBlocks experts={experts} layout={layout} sort={sort} page={page} />
      </motion.div>
    </AnimatePresence>
  );
}
