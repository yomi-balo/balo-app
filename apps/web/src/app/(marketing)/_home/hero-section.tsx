import type { ProductTaxonomy } from '@/lib/search/taxonomy';
import type { PopularChip } from '@/lib/marketing/popular-chips';
import type { ResolvedBenchTile } from '@/lib/marketing/bench-tiles';
import { HeroSearch } from './hero-search';
import { BenchRows } from './bench-rows';
import { BenchTile } from './bench-tile';
import { VERTICAL, liveCountLabel } from './copy';

interface HeroSectionProps {
  readonly expertTotal: number | null;
  readonly wasAvailabilityGated: boolean;
  readonly taxonomy: ProductTaxonomy;
  readonly productNameMap: Record<string, string>;
  readonly chips: readonly PopularChip[];
  readonly benchTiles: readonly ResolvedBenchTile[];
}

/** The "timer bar" underline beneath "on demand" — ported from the design reference verbatim. */
function Underline(): React.JSX.Element {
  return (
    <svg
      className="mk-underline"
      viewBox="0 0 300 14"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="mkUnderline" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="var(--primary)" />
          <stop offset="1" stopColor="var(--violet)" />
        </linearGradient>
      </defs>
      <path
        d="M3 9 C 70 3, 150 3, 297 8"
        fill="none"
        stroke="url(#mkUnderline)"
        strokeWidth="5"
        strokeLinecap="round"
        pathLength="1"
        style={{ strokeDasharray: 1, strokeDashoffset: 1 }}
      />
    </svg>
  );
}

/**
 * BAL-493 §3 / §5 — the hero. Server component; owns the page's SINGLE `<h1>`. Renders the
 * `<HeroSearch>` and `<BenchRows>` client islands, passing them only plain, serialisable data.
 */
export function HeroSection({
  expertTotal,
  wasAvailabilityGated,
  taxonomy,
  productNameMap,
  chips,
  benchTiles,
}: Readonly<HeroSectionProps>): React.JSX.Element {
  const showLivePill = expertTotal !== null && expertTotal > 0;
  const rowA = benchTiles.filter((tile) => tile.row === 'A');
  const rowB = benchTiles.filter((tile) => tile.row === 'B');

  return (
    <section className="mk-hero" id="hero">
      <div className="mk-hero-bg" aria-hidden="true">
        <div className="mk-blob mk-blob-a" />
        <div className="mk-blob mk-blob-b" />
        <div className="mk-blob mk-blob-c" />
        <div className="mk-grid" />
        <div className="mk-hero-fade" />
      </div>

      <div className="mk-hero-inner">
        {showLivePill && (
          <div className="mk-live">
            <span className="mk-live-dot" />
            <span className="mk-mono mk-live-n">{expertTotal}</span>
            <span>{liveCountLabel(wasAvailabilityGated)}</span>
          </div>
        )}

        <h1 className="mk-h1">
          Top {VERTICAL.name} experts,
          <br />
          <span className="mk-h1-em">
            on demand
            <Underline />
          </span>
          .
        </h1>

        <p className="mk-lede">
          Only the top 1% of applicants make it onto Balo. Book one for a 20-minute fix or a
          six-week build, and pay by the minute. Nothing more.
        </p>

        <HeroSearch
          taxonomy={taxonomy}
          productNameMap={productNameMap}
          chips={chips}
          phrases={VERTICAL.phrases}
          verticalName={VERTICAL.name}
        />
      </div>

      {benchTiles.length > 0 && (
        <BenchRows
          ariaLabel={`${VERTICAL.name} products covered by Balo experts`}
          rowA={rowA.map((tile, index) => (
            <BenchTile key={tile.productId} tile={tile} position={index} />
          ))}
          rowB={rowB.map((tile, index) => (
            <BenchTile key={tile.productId} tile={tile} position={index} />
          ))}
        />
      )}
    </section>
  );
}
