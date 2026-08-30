import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@/test/utils';
import userEvent from '@testing-library/user-event';
import { track, MARKETING_HOME_EVENTS } from '@/lib/analytics';
import type { ResolvedBenchTile } from '@/lib/marketing/bench-tiles';
import { BenchRows } from './bench-rows';
import { BenchTile } from './bench-tile';

const mockTrack = vi.mocked(track);

/**
 * BAL-493 §3 — the bench's event-delegation contract. `BenchRows` never sees tile data, only
 * the `data-bench-*` attributes each server-rendered `<BenchTile>` carries — these fixtures are
 * real `ResolvedBenchTile`s rendered through the real `<BenchTile>`, matching how
 * `hero-section.tsx` composes them (never synthetic divs standing in for the real markup).
 */
function makeTile(overrides: Partial<ResolvedBenchTile> = {}): ResolvedBenchTile {
  return {
    productId: 'sales-cloud-id',
    product: 'Sales Cloud',
    label: 'Sales Cloud',
    icon: 'trending',
    tint: 'blue',
    row: 'A',
    href: '/experts?products=sales-cloud-id',
    displayCount: 30,
    showCount: true,
    ariaLabel: 'Sales Cloud — 30+ experts',
    ...overrides,
  };
}

const tileSalesCloud = makeTile();
const tileAgentforce = makeTile({
  productId: 'agentforce-id',
  product: 'Agentforce',
  label: 'Agentforce',
  href: '/experts?products=agentforce-id',
  displayCount: 20,
  showCount: true,
  ariaLabel: 'Agentforce — 20+ experts',
});
const tileMuleSoft = makeTile({
  productId: 'mulesoft-id',
  product: 'MuleSoft',
  label: 'MuleSoft',
  row: 'B',
  icon: 'gitMerge',
  tint: 'violet',
  href: '/experts?products=mulesoft-id',
  displayCount: 0,
  showCount: false,
  ariaLabel: 'MuleSoft',
});

function renderBench() {
  return render(
    <BenchRows
      ariaLabel="Salesforce products covered by Balo experts"
      rowA={
        <>
          <BenchTile tile={tileSalesCloud} position={0} />
          <BenchTile tile={tileAgentforce} position={1} />
        </>
      }
      rowB={<BenchTile tile={tileMuleSoft} position={0} />}
    />
  );
}

beforeEach(() => {
  mockTrack.mockClear();
});

describe('BenchRows — one delegated click listener (BAL-493 §3 / §4)', () => {
  it('fires product_tile_clicked exactly once, with the clicked tile’s row/position/count_shown', async () => {
    const user = userEvent.setup();
    renderBench();

    await user.click(screen.getByRole('link', { name: tileAgentforce.ariaLabel }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
      product: 'Agentforce',
      row: 'a',
      position: 1,
      count_shown: true,
    });
  });

  it('carries count_shown=false and the un-numbered aria-label for a sub-10 tile, from row B', async () => {
    const user = userEvent.setup();
    renderBench();

    await user.click(screen.getByRole('link', { name: tileMuleSoft.ariaLabel }));

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith(MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
      product: 'MuleSoft',
      row: 'b',
      position: 0,
      count_shown: false,
    });
  });

  it('fires once per click across multiple tiles — the ONE listener does not double-fire or leak', async () => {
    const user = userEvent.setup();
    renderBench();

    await user.click(screen.getByRole('link', { name: tileSalesCloud.ariaLabel }));
    await user.click(screen.getByRole('link', { name: tileAgentforce.ariaLabel }));

    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockTrack).toHaveBeenNthCalledWith(1, MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
      product: 'Sales Cloud',
      row: 'a',
      position: 0,
      count_shown: true,
    });
    expect(mockTrack).toHaveBeenNthCalledWith(2, MARKETING_HOME_EVENTS.PRODUCT_TILE_CLICKED, {
      product: 'Agentforce',
      row: 'a',
      position: 1,
      count_shown: true,
    });
  });

  it('does not fire for a click that lands outside any tile', async () => {
    const user = userEvent.setup();
    const { container } = renderBench();

    const bench = container.querySelector('.mk-bench');
    if (!bench) throw new Error('expected .mk-bench root to render');
    await user.click(bench);

    expect(mockTrack).not.toHaveBeenCalled();
  });
});
