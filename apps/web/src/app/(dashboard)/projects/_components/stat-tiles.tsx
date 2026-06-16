'use client';

import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * StatTiles — the portfolio-at-a-glance tiles that double as filters (the design's
 * `StatTiles`). Each tile is a `<button>`; clicking an inactive tile selects its
 * key, clicking the active tile resets to `all`. Active = `ring-2` + tinted
 * surface. 2-col on mobile → 4-col at `sm:` (both lenses have 4 tiles; matches
 * the loading skeleton). 44px+ tap target,
 * `focus-visible:ring-2`. Reused by both participant (interactive) and admin
 * (read-only `onSelect` omitted) dashboards.
 */

export interface StatTileDescriptor {
  key: string;
  label: string;
  count: number;
  icon: LucideIcon;
  /** Token classes for the icon + accent (e.g. 'text-primary'). */
  tone: string;
  sub?: string;
  /** When true the count renders in the tone color (the design's `big`). */
  emphasize?: boolean;
}

interface StatTilesProps {
  tiles: StatTileDescriptor[];
  /** The currently active filter key, or null (admin = non-interactive). */
  active: string | null;
  /** Toggle handler; omit for a read-only tile row. */
  onSelect?: (key: string) => void;
}

export function StatTiles({
  tiles,
  active,
  onSelect,
}: Readonly<StatTilesProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile, index) => {
        const isActive = active === tile.key;
        const Icon = tile.icon;
        const interactive = onSelect !== undefined;
        return (
          <motion.button
            key={tile.key}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.03 + index * 0.04 }}
            disabled={!interactive}
            aria-pressed={interactive ? isActive : undefined}
            onClick={interactive ? () => onSelect(tile.key) : undefined}
            className={cn(
              'min-h-[44px] rounded-2xl border p-4 text-left transition-all',
              interactive &&
                'focus-visible:ring-ring cursor-pointer focus-visible:ring-2 focus-visible:outline-none',
              !interactive && 'cursor-default',
              isActive
                ? 'border-primary bg-primary/5 ring-primary/30 ring-2'
                : 'border-border bg-card hover:border-primary/40'
            )}
          >
            <div className="mb-1.5 flex items-center gap-1.5">
              <Icon className={cn('h-3.5 w-3.5', tile.tone)} aria-hidden="true" />
              <span className="text-muted-foreground text-[11px] font-bold tracking-wider uppercase">
                {tile.label}
              </span>
            </div>
            <p
              className={cn(
                'text-2xl leading-none font-bold tabular-nums',
                tile.emphasize ? tile.tone : 'text-foreground'
              )}
            >
              {tile.count}
            </p>
            {tile.sub && <p className="text-muted-foreground mt-1 text-xs">{tile.sub}</p>}
          </motion.button>
        );
      })}
    </div>
  );
}
