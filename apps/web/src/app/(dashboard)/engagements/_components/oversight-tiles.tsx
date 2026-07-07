'use client';

import { motion } from 'motion/react';
import {
  AlertTriangle,
  Briefcase,
  CheckCircle2,
  Clock,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { STALLED_AFTER_DAYS } from '@/lib/engagements/oversight-constants';
import type { OversightCounts, OversightFilter } from '@/lib/engagements/oversight-row';

/**
 * OversightTiles — the five status counts that double as the filter control (the
 * design's `StatTiles`). Each tile is a `<button>`: clicking an inactive tile
 * selects its filter, clicking the selected tile returns to the `in_flight`
 * composite default. In the default, the Active + In review tiles carry a subtle
 * "included" tint (no single tile fully selected), so the composite reads at a
 * glance. Data-driven over a config array (never five copy-pasted blocks); tones
 * are CSS-variable tokens (never hex). 2-col on mobile → 5-col at `sm:`.
 */

/** The five status filter keys — excludes the `in_flight` composite default. */
type TileKey = Exclude<OversightFilter, 'in_flight'>;

interface TileConfig {
  key: TileKey;
  label: string;
  icon: LucideIcon;
  /** Which whole-set count feeds this tile. */
  countKey: keyof OversightCounts;
  /** Icon + emphasised-count tone. */
  tone: string;
  /** Full border/bg/ring classes when this tile is the selected filter. */
  selectedClass: string;
  /** Subtle border/bg when this tile is part of the `in_flight` default (or ''). */
  includedClass: string;
  sub: string;
}

const TILES: readonly TileConfig[] = [
  {
    key: 'active',
    label: 'Active',
    icon: Briefcase,
    countKey: 'active',
    tone: 'text-primary',
    selectedClass: 'border-primary bg-primary/10 ring-2 ring-primary/30',
    includedClass: 'border-primary/30 bg-primary/5',
    sub: 'Delivering',
  },
  {
    key: 'in_review',
    label: 'In review',
    icon: Clock,
    countKey: 'inReview',
    tone: 'text-warning',
    selectedClass: 'border-warning bg-warning/10 ring-2 ring-warning/30',
    includedClass: 'border-warning/30 bg-warning/5',
    sub: 'Auto-accept pending',
  },
  {
    key: 'stalled',
    label: 'Stalled',
    icon: AlertTriangle,
    countKey: 'stalled',
    tone: 'text-destructive',
    selectedClass: 'border-destructive bg-destructive/10 ring-2 ring-destructive/30',
    includedClass: '',
    sub: `Quiet ${STALLED_AFTER_DAYS}+ days`,
  },
  {
    key: 'completed',
    label: 'Completed',
    icon: CheckCircle2,
    countKey: 'completed',
    tone: 'text-success',
    selectedClass: 'border-success bg-success/10 ring-2 ring-success/30',
    includedClass: '',
    sub: 'Accepted',
  },
  {
    key: 'cancelled',
    label: 'Cancelled',
    icon: XCircle,
    countKey: 'cancelled',
    tone: 'text-muted-foreground',
    selectedClass: 'border-muted-foreground/40 bg-muted ring-2 ring-muted-foreground/20',
    includedClass: '',
    sub: 'Stopped',
  },
];

interface OversightTilesProps {
  counts: OversightCounts;
  filter: OversightFilter;
  onSelect: (key: OversightFilter) => void;
}

/** The tile's surface class for its current state (no nested ternary at the call site). */
function tileStateClass(tile: TileConfig, selected: boolean, included: boolean): string {
  if (selected) return tile.selectedClass;
  if (included) return tile.includedClass;
  return 'border-border bg-card hover:border-primary/40';
}

export function OversightTiles({
  counts,
  filter,
  onSelect,
}: Readonly<OversightTilesProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {TILES.map((tile, index) => {
        const Icon = tile.icon;
        const count = counts[tile.countKey];
        const selected = filter === tile.key;
        const included =
          filter === 'in_flight' && (tile.key === 'active' || tile.key === 'in_review');
        return (
          <motion.button
            key={tile.key}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.03 + index * 0.04 }}
            aria-pressed={selected}
            onClick={() => onSelect(selected ? 'in_flight' : tile.key)}
            className={cn(
              'focus-visible:ring-ring min-h-[44px] cursor-pointer rounded-2xl border p-4 text-left transition-all focus-visible:ring-2 focus-visible:outline-none',
              tileStateClass(tile, selected, included)
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
                count > 0 ? tile.tone : 'text-muted-foreground'
              )}
            >
              {count}
            </p>
            <p className="text-muted-foreground mt-1 text-xs">{tile.sub}</p>
          </motion.button>
        );
      })}
    </div>
  );
}
