'use client';

import { Wrench, Building2, Compass, GraduationCap, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { proficiencyScaleLevel } from '@balo/shared/experts';
import { SegmentedSlider } from '@/components/balo/segmented-slider';
import { cn } from '@/lib/utils';
import { ChangedDot } from './changed-dot';

/**
 * BAL-593 §[F] — one support-type rating row inside `ProductRatingCard`'s edit mode: Balo's
 * slider, the expert's self-rating marker, and the difference between them. Design ref 1154-1221
 * (the row) / 1027-1118 (the track) — reimplemented on the shared `SegmentedSlider`.
 *
 * Mirrors the `(apply)/expert/apply/_components/assessment-card.tsx` icon mapping (by support
 * type SLUG — the schema carries no icon column) and its title-plus-description convention. The row has a desktop and a mobile layout.
 */

const DIMENSION_ICONS: Record<string, typeof Wrench> = {
  'technical-fix': Wrench,
  architecture: Building2,
  strategy: Compass,
  training: GraduationCap,
};

function pct(value: number): string {
  return `${(value / 10) * 100}%`;
}

export interface RatingRowEditProps {
  readonly productName: string;
  readonly supportType: { id: string; name: string; slug: string };
  /** `missing: true` means no `expert_competency` row exists for this cell — read-only, never saved. */
  readonly rating: { self: number | null; balo: number; missing?: true };
  /** Balo's ORIGINAL value for this cell, or `null` for a product new to this edit (no original). */
  readonly original: number | null;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
}

function RatingTrack({
  balo,
  self,
  label,
  onChange,
  disabled,
}: Readonly<{
  balo: number;
  self: number | null;
  label: string;
  onChange: (value: number) => void;
  disabled: boolean;
}>): React.JSX.Element {
  const hasGap = self !== null && self !== balo;
  const lo = hasGap && self !== null ? Math.min(self, balo) : balo;
  const hi = hasGap && self !== null ? Math.max(self, balo) : balo;
  const valueText =
    `${balo}, ${proficiencyScaleLevel(balo).title}` +
    (self === null ? '' : `. Self-rating ${self}`);

  return (
    <SegmentedSlider
      value={balo}
      onValueChange={onChange}
      aria-label={label}
      aria-valuetext={valueText}
      disabled={disabled}
      trackOverlay={
        <>
          {hasGap && (
            <div
              aria-hidden="true"
              className="bg-warning/15 border-warning/40 pointer-events-none absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border"
              style={{ left: pct(lo), width: pct(hi - lo) }}
            />
          )}
          {self !== null && (
            <span
              aria-hidden="true"
              title={`Self-rating ${self}`}
              className="bg-foreground/55 pointer-events-none absolute top-1/2 h-[18px] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
              style={{ left: pct(self) }}
            />
          )}
        </>
      }
    />
  );
}

export function RatingRowEdit({
  productName,
  supportType,
  rating,
  original,
  onChange,
  disabled = false,
}: Readonly<RatingRowEditProps>): React.JSX.Element {
  const { self, balo, missing } = rating;
  const differs = self !== null && self !== balo;
  const changed = !missing && original !== null && original !== balo;
  const rowDisabled = disabled || missing === true;
  const Icon = DIMENSION_ICONS[supportType.slug] ?? Wrench;
  const { title: levelLabel, description } = proficiencyScaleLevel(balo);
  const trackLabel = `Balo’s ${supportType.name} rating for ${productName}`;

  return (
    <div className="bal-rating-row border-border/50 border-b py-3 last:border-b-0">
      {/* Desktop layout */}
      <div className="hidden items-center gap-4 sm:flex">
        <span className="flex w-[150px] shrink-0 items-center gap-2 text-sm font-medium">
          <Icon className="text-muted-foreground size-4" aria-hidden="true" />
          {supportType.name}
          {changed && <ChangedDot />}
        </span>
        <div className="flex-1">
          <RatingTrack
            balo={balo}
            self={self}
            label={trackLabel}
            onChange={onChange}
            disabled={rowDisabled}
          />
        </div>
        <span className="font-mono text-sm font-semibold tabular-nums">
          {missing ? (
            <span className="text-muted-foreground text-xs font-normal">Not rated</span>
          ) : (
            balo
          )}
        </span>
        <span className="text-muted-foreground w-[110px] text-xs">{missing ? '' : levelLabel}</span>
        <span
          title={
            self === null
              ? 'Added by Balo, so there’s no self-rating'
              : `The expert rated themselves ${self}`
          }
          className={cn(
            'w-[56px] text-right text-xs whitespace-nowrap',
            differs ? 'text-warning font-semibold' : 'text-muted-foreground'
          )}
        >
          {self === null ? '—' : `Self ${self}`}
        </span>
        <span className="w-7">
          {changed && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={`Undo change to ${supportType.name} for ${productName}`}
              onClick={() => onChange(original ?? 0)}
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </span>
      </div>
      {!missing && (
        <p className="text-muted-foreground mt-1 hidden text-xs sm:block">{description}</p>
      )}

      {/* Mobile layout */}
      <div className="space-y-2 sm:hidden">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon className="text-muted-foreground size-4" aria-hidden="true" />
            {supportType.name}
            {changed && <ChangedDot />}
          </span>
          {changed && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              aria-label={`Undo change to ${supportType.name} for ${productName}`}
              onClick={() => onChange(original ?? 0)}
            >
              <Undo2 className="size-3.5" aria-hidden="true" />
            </Button>
          )}
        </div>
        <RatingTrack
          balo={balo}
          self={self}
          label={trackLabel}
          onChange={onChange}
          disabled={rowDisabled}
        />
        <div className="flex items-center justify-between text-xs">
          <span
            title={
              self === null
                ? 'Added by Balo, so there’s no self-rating'
                : `The expert rated themselves ${self}`
            }
            className={cn(differs ? 'text-warning font-semibold' : 'text-muted-foreground')}
          >
            {self === null ? '—' : `Self ${self}`}
          </span>
          <span className="font-mono tabular-nums">
            {missing ? 'Not rated' : `${balo} · ${levelLabel}`}
          </span>
        </div>
        {!missing && <p className="text-muted-foreground text-xs">{description}</p>}
      </div>
    </div>
  );
}
