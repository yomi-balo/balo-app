'use client';

import { Wrench, Building2, Compass, GraduationCap, Undo2 } from 'lucide-react';
import { Slider as SliderPrimitive } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { proficiencyToLevel } from '@/lib/expert-profile/proficiency';
import { cn } from '@/lib/utils';
import { ChangedDot } from './changed-dot';

/**
 * BAL-593 §[F] — one support-type rating row inside `ProductRatingCard`'s edit mode: Balo's
 * slider, the expert's self-rating marker, and the difference between them. Design ref 1154-1221
 * (the row) / 1027-1118 (the track) — reimplemented on the shadcn `Slider` rather than the
 * design's hand-rolled `<input type="range">`.
 *
 * Mirrors the `(apply)/expert/apply/_components/assessment-card.tsx` icon mapping (by support
 * type SLUG — the schema carries no icon column) and its desktop/mobile dual-layout convention.
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
    `${balo}, ${proficiencyToLevel(balo).label}` + (self === null ? '' : `. Self-rating ${self}`);

  return (
    <div className="relative flex h-7 items-center">
      {hasGap && (
        <div
          aria-hidden="true"
          className="bg-warning/15 border-warning/40 absolute top-1/2 h-2.5 -translate-y-1/2 rounded-sm border"
          style={{ left: pct(lo), width: pct(hi - lo) }}
        />
      )}
      <SliderPrimitive.Root
        min={0}
        max={10}
        step={1}
        value={[balo]}
        onValueChange={([v]) => onChange(v ?? 0)}
        disabled={disabled}
        className="relative z-10 flex w-full touch-none items-center select-none data-[disabled]:opacity-50"
      >
        <SliderPrimitive.Track className="bg-muted relative h-1.5 w-full grow overflow-hidden rounded-full">
          <SliderPrimitive.Range className="bg-primary absolute h-full" />
        </SliderPrimitive.Track>
        {/* ⚠ `aria-label` goes on the THUMB, not `Root` — `Root` renders a plain wrapper span, and
            an ancestor's `aria-label` is not an accessible name for the descendant `role="slider"`
            element (@radix-ui/react-slider only reads `props['aria-label']` off `Thumb` itself). */}
        <SliderPrimitive.Thumb
          aria-label={label}
          aria-valuetext={valueText}
          className="border-primary ring-ring/50 block size-4 shrink-0 rounded-full border bg-white shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
        />
      </SliderPrimitive.Root>
      {self !== null && (
        <span
          aria-hidden="true"
          title={`Self-rating ${self}`}
          className="bg-foreground/55 pointer-events-none absolute top-1/2 h-[18px] w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: pct(self) }}
        />
      )}
    </div>
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
  const { label: levelLabel } = proficiencyToLevel(balo);
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
        <span className="text-muted-foreground w-[90px] text-xs">{missing ? '' : levelLabel}</span>
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
      </div>
    </div>
  );
}
