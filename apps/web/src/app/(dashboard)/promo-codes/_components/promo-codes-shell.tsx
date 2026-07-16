'use client';

import { useCallback, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import {
  Ban,
  CalendarClock,
  CalendarX,
  CheckCircle2,
  Filter,
  RotateCcw,
  Sparkles,
  Ticket,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  promoRowMatchesFilter,
  type PromoCodeAdminRow,
  type PromoCodesAdminDTO,
  type PromoCounts,
  type PromoDisplayStatus,
  type PromoStatusFilter,
} from '@/lib/promo-codes/promo-codes-view';
import { PromoCodeRow } from './promo-code-row';
import { PromoRedemptionsPanel } from './promo-redemptions-panel';
import { FilteredEmptyState, ZeroEmptyState } from './promo-codes-empty-states';
import { MintPromoDialog } from './mint-promo-dialog';
import { EditCapDialog } from './edit-cap-dialog';
import { DeactivateCodeDialog } from './deactivate-code-dialog';

/**
 * PromoCodesShell — the page root for the admin promo-code surface (BAL-384). Client
 * component (the tiles/filter and dialogs are interactive; the DTO arrives fully
 * serialised from the server loader). Owns the display-status filter (StatTiles-as-filter,
 * default "All"), the ONE emphasised "Mint a code" gradient action, the code list, the
 * selected-code redemptions panel, and the mint / edit-cap / deactivate dialogs. Toast
 * (Sonner) fires from each dialog on its mutation. A true-zero DTO renders the
 * `ZeroEmptyState` invitation instead of tiles + list.
 */

interface PromoCodesShellProps {
  dto: PromoCodesAdminDTO;
}

const FILTER_LABEL: Record<PromoStatusFilter, string> = {
  all: 'All codes',
  active: 'Active',
  scheduled: 'Scheduled',
  exhausted: 'Exhausted',
  expired: 'Expired',
  deactivated: 'Deactivated',
};

interface TileConfig {
  key: PromoDisplayStatus;
  label: string;
  icon: LucideIcon;
  tone: string;
  selectedClass: string;
  sub: string;
}

const TILES: readonly TileConfig[] = [
  {
    key: 'active',
    label: 'Active',
    icon: Ticket,
    tone: 'text-success',
    selectedClass: 'border-success bg-success/10 ring-2 ring-success/30',
    sub: 'Live now',
  },
  {
    key: 'scheduled',
    label: 'Scheduled',
    icon: CalendarClock,
    tone: 'text-info',
    selectedClass: 'border-info bg-info/10 ring-2 ring-info/30',
    sub: 'Not started',
  },
  {
    key: 'exhausted',
    label: 'Exhausted',
    icon: CheckCircle2,
    tone: 'text-warning',
    selectedClass: 'border-warning bg-warning/10 ring-2 ring-warning/30',
    sub: 'Cap reached',
  },
  {
    key: 'expired',
    label: 'Expired',
    icon: CalendarX,
    tone: 'text-muted-foreground',
    selectedClass: 'border-muted-foreground/40 bg-muted ring-2 ring-muted-foreground/20',
    sub: 'Window closed',
  },
  {
    key: 'deactivated',
    label: 'Deactivated',
    icon: Ban,
    tone: 'text-destructive',
    selectedClass: 'border-destructive bg-destructive/10 ring-2 ring-destructive/30',
    sub: 'Turned off',
  },
];

function PromoHeader({ onMint }: Readonly<{ onMint: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-foreground text-2xl font-semibold">Promo codes</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Mint credit codes, cap redemptions, and track who redeemed.
        </p>
      </div>
      <button
        type="button"
        onClick={onMint}
        className="from-primary text-primary-foreground focus-visible:ring-ring inline-flex items-center gap-2 rounded-lg bg-gradient-to-r to-violet-600 px-4 py-2 text-sm font-semibold shadow-sm transition-all hover:opacity-95 focus-visible:ring-2 focus-visible:outline-none"
      >
        <Sparkles className="h-4 w-4" aria-hidden="true" />
        Mint a code
      </button>
    </div>
  );
}

interface PromoTilesProps {
  counts: PromoCounts;
  filter: PromoStatusFilter;
  onSelect: (filter: PromoStatusFilter) => void;
}

function PromoTiles({ counts, filter, onSelect }: Readonly<PromoTilesProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {TILES.map((tile, index) => {
        const Icon = tile.icon;
        const count = counts[tile.key];
        const selected = filter === tile.key;
        return (
          <motion.button
            key={tile.key}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.03 + index * 0.04 }}
            aria-pressed={selected}
            onClick={() => onSelect(selected ? 'all' : tile.key)}
            className={cn(
              'focus-visible:ring-ring min-h-[44px] cursor-pointer rounded-2xl border p-4 text-left transition-all focus-visible:ring-2 focus-visible:outline-none',
              selected ? tile.selectedClass : 'border-border bg-card hover:border-primary/40'
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

export function PromoCodesShell({ dto }: Readonly<PromoCodesShellProps>): React.JSX.Element {
  const [filter, setFilter] = useState<PromoStatusFilter>('all');
  const [selectedCodeId, setSelectedCodeId] = useState<string | null>(null);
  const [mintOpen, setMintOpen] = useState(false);
  const [editCapRow, setEditCapRow] = useState<PromoCodeAdminRow | null>(null);
  const [deactivateRow, setDeactivateRow] = useState<PromoCodeAdminRow | null>(null);

  const handleSelectFilter = useCallback((next: PromoStatusFilter) => setFilter(next), []);
  const handleClearFilter = useCallback(() => setFilter('all'), []);
  const handleMint = useCallback(() => setMintOpen(true), []);
  const handleView = useCallback(
    (id: string) => setSelectedCodeId((current) => (current === id ? null : id)),
    []
  );
  const handleClosePanel = useCallback(() => setSelectedCodeId(null), []);
  const handleEditCap = useCallback((row: PromoCodeAdminRow) => setEditCapRow(row), []);
  const handleDeactivate = useCallback((row: PromoCodeAdminRow) => setDeactivateRow(row), []);
  const handleMintOpenChange = useCallback((open: boolean) => setMintOpen(open), []);
  const handleEditCapOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setEditCapRow(null);
    }
  }, []);
  const handleDeactivateOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setDeactivateRow(null);
    }
  }, []);

  const visibleRows = useMemo(
    () => dto.rows.filter((row) => promoRowMatchesFilter(row, filter)),
    [dto.rows, filter]
  );
  const selectedRow = useMemo(
    () => dto.rows.find((row) => row.id === selectedCodeId) ?? null,
    [dto.rows, selectedCodeId]
  );

  const dialogs = (
    <>
      <MintPromoDialog open={mintOpen} onOpenChange={handleMintOpenChange} />
      <EditCapDialog row={editCapRow} onOpenChange={handleEditCapOpenChange} />
      <DeactivateCodeDialog row={deactivateRow} onOpenChange={handleDeactivateOpenChange} />
    </>
  );

  if (dto.isEmpty) {
    return (
      <div className="flex flex-col gap-6">
        <PromoHeader onMint={handleMint} />
        <ZeroEmptyState onMint={handleMint} />
        {dialogs}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <PromoHeader onMint={handleMint} />
      </motion.div>

      <PromoTiles counts={dto.counts} filter={filter} onSelect={handleSelectFilter} />

      <div>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Filter className="text-muted-foreground h-4 w-4" aria-hidden="true" />
            <span className="text-muted-foreground text-xs font-bold tracking-wider uppercase">
              {FILTER_LABEL[filter]} · {visibleRows.length}
            </span>
          </div>
          {filter !== 'all' && (
            <button
              type="button"
              onClick={handleClearFilter}
              className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              Show all
            </button>
          )}
        </div>

        {visibleRows.length > 0 ? (
          <div className="border-border bg-card overflow-hidden rounded-2xl border">
            {visibleRows.map((row, index) => (
              <PromoCodeRow
                key={row.id}
                row={row}
                selected={row.id === selectedCodeId}
                last={index === visibleRows.length - 1}
                onView={handleView}
                onEditCap={handleEditCap}
                onDeactivate={handleDeactivate}
              />
            ))}
          </div>
        ) : (
          filter !== 'all' && <FilteredEmptyState filter={filter} onClear={handleClearFilter} />
        )}
      </div>

      {selectedRow !== null && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25 }}
        >
          <PromoRedemptionsPanel row={selectedRow} onClose={handleClosePanel} />
        </motion.div>
      )}

      {dialogs}
    </div>
  );
}
