'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { toast } from 'sonner';
import type { ExpertCardData } from '@/components/expert';
import { BookingFlowDialog } from '@/components/booking';
import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import { SearchResultCard } from './search-result-card';
import { useSearchBooking } from './use-search-booking';

interface ResultsGridProps {
  experts: ExpertCardData[];
  layout: 'grid' | 'list';
  sort: string;
  page: number;
  /** The booking flow's new-case product picker. */
  productsTaxonomy: ProductTaxonomy;
}

interface BlockProps {
  experts: ExpertCardData[];
  sort: string;
  page: number;
  onBook: (username: string) => void;
  pendingUsername: string | null;
}

const GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
} as const;

function GridBlock({
  experts,
  sort,
  page,
  onBook,
  pendingUsername,
}: Readonly<BlockProps>): React.JSX.Element {
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
          onBook={onBook}
          bookPending={expert.username !== null && expert.username === pendingUsername}
        />
      ))}
    </div>
  );
}

function ListBlock({
  experts,
  sort,
  page,
  onBook,
  pendingUsername,
}: Readonly<BlockProps>): React.JSX.Element {
  // Single-column grid with `grid-auto-rows: 1fr` so every row equalises to the
  // TALLEST card's height (no clipping); the card's `min-h` sets a floor so rows
  // never get too short. Cards stretch to fill their row; CTAs bottom-align.
  return (
    <div className="grid [grid-auto-rows:1fr] grid-cols-1 gap-4">
      {experts.map((expert, i) => (
        <SearchResultCard
          key={expert.id}
          expert={expert}
          variant="list"
          position={i + 1}
          sort={sort}
          page={page}
          onBook={onBook}
          bookPending={expert.username !== null && expert.username === pendingUsername}
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
  layout,
  ...blockProps
}: Readonly<BlockProps & { layout: 'grid' | 'list' }>): React.JSX.Element {
  if (layout === 'list') {
    return (
      <>
        <div className="md:hidden">
          <GridBlock {...blockProps} />
        </div>
        <div className="hidden md:block">
          <ListBlock {...blockProps} />
        </div>
      </>
    );
  }

  return <GridBlock {...blockProps} />;
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
 * two separate components and we simply fade the whole region between them. *
 * Also owns the one booking dialog every card's "Book a call" opens in place
 * (`useSearchBooking`), mounted outside the cross-fade so a layout toggle never
 * remounts it.
 */
export function ResultsGrid({
  experts,
  layout,
  sort,
  page,
  productsTaxonomy,
}: Readonly<ResultsGridProps>): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const booking = useSearchBooking();

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={layout}
          initial={reduceMotion ? false : { opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
          transition={{ duration: reduceMotion ? 0.12 : 0.2, ease: 'easeOut' }}
        >
          <ResultsBlocks
            experts={experts}
            layout={layout}
            sort={sort}
            page={page}
            onBook={booking.book}
            pendingUsername={booking.pendingUsername}
          />
        </motion.div>
      </AnimatePresence>

      {booking.launch && (
        <BookingFlowDialog
          key={booking.launch.expert.expertProfileId}
          open={booking.open}
          onClose={booking.close}
          expert={booking.launch.expert}
          source="search"
          entry={{ mode: 'chooser', context: booking.launch.context }}
          viewerEmailDomain={booking.launch.viewerEmailDomain}
          onMessage={() => {
            booking.close();
            toast('Coming soon', { description: 'This flow is on its way.' });
          }}
          productsTaxonomy={productsTaxonomy}
        />
      )}
    </>
  );
}
