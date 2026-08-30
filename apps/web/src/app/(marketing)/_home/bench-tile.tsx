import Link from 'next/link';
import type { ResolvedBenchTile } from '@/lib/marketing/bench-tiles';
import { MARKETING_ICONS } from './icons';

interface BenchTileProps {
  readonly tile: ResolvedBenchTile;
  /** 0-based index within its own row (A or B) — carried in the delegation data-* contract. */
  readonly position: number;
}

/**
 * BAL-493 §3 / §4.4 — one bench tile. Server-rendered, no handlers: `<BenchRows>` (the client
 * island) attaches ONE delegated click listener per row and reads these `data-*` attributes
 * rather than each of the 18 tiles being its own client component (§3's event-delegation
 * rationale — 18 product names/hrefs never enter the client bundle, and the tile keeps working
 * as a plain `<Link>` with no JS: open-in-new-tab, middle-click, prefetch).
 */
export function BenchTile({ tile, position }: Readonly<BenchTileProps>): React.JSX.Element {
  const Icon = MARKETING_ICONS[tile.icon];
  return (
    <Link
      href={tile.href}
      className="mk-tile"
      aria-label={tile.ariaLabel}
      data-bench-tile={tile.product}
      data-bench-row={tile.row.toLowerCase()}
      data-bench-position={position}
      data-bench-count-shown={tile.showCount}
    >
      <span className={`mk-mark mk-mark-${tile.tint}`}>
        <Icon size={19} aria-hidden="true" />
      </span>
      <div>
        <div className="mk-tile-name">{tile.label}</div>
        {tile.showCount && <div className="mk-tile-count">{tile.displayCount}+ experts</div>}
      </div>
    </Link>
  );
}
