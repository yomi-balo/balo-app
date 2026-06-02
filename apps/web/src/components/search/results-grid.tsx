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
export function ResultsGrid({
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
