'use client';

import { useCallback, type MouseEvent, type ReactNode } from 'react';
import { Parallax } from '@/components/marketing/motion/parallax';
import { FX_BENCH_A, FX_BENCH_B } from '@/components/marketing/motion/fx';
import type { MarketingHomeBenchRow } from '@/lib/analytics';
import { useMarketingHomeTracking } from '@/components/marketing/use-marketing-home-tracking';

interface BenchRowsProps {
  readonly ariaLabel: string;
  readonly rowA: ReactNode;
  readonly rowB: ReactNode;
}

function isBenchRow(value: string): value is MarketingHomeBenchRow {
  return value === 'a' || value === 'b';
}

/**
 * BAL-493 §3 — the hero bench: two opposite-direction parallax rows, plus the ONE delegated
 * `product_tile_clicked` listener for all 18 server-rendered `<BenchTile>` links (§3's
 * event-delegation rationale). `rowA`/`rowB` arrive as already-rendered children — this
 * component never sees tile data, only DOM nodes and their `data-*` attributes.
 */
export function BenchRows({ ariaLabel, rowA, rowB }: Readonly<BenchRowsProps>): React.JSX.Element {
  const tracking = useMarketingHomeTracking();

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tileEl = target.closest<HTMLElement>('[data-bench-tile]');
      if (!tileEl) return;

      const product = tileEl.dataset.benchTile;
      const row = tileEl.dataset.benchRow;
      const position = tileEl.dataset.benchPosition;
      const countShown = tileEl.dataset.benchCountShown;
      if (
        product === undefined ||
        row === undefined ||
        !isBenchRow(row) ||
        position === undefined
      ) {
        return;
      }

      tracking.productTileClicked(product, row, Number(position), countShown === 'true');
    },
    [tracking]
  );

  return (
    <div className="mk-bench" aria-label={ariaLabel} onClick={handleClick}>
      <Parallax compute={FX_BENCH_A} className="mk-bench-row">
        {rowA}
      </Parallax>
      <Parallax compute={FX_BENCH_B} className="mk-bench-row mk-bench-row-b">
        {rowB}
      </Parallax>
    </div>
  );
}
