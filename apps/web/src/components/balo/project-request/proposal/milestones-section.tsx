'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, GripVertical, Plus, Trash2 } from 'lucide-react';
import { MotionConfig, Reorder, useDragControls } from 'motion/react';
import { sumEstimatedMinutes } from '@balo/shared/pricing';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { htmlToPlainText } from '@/components/balo/rich-text/plain-text';
import { centsToDollars, dollarsToCents, formatWholeCurrency } from '@/lib/utils/currency';
import { ComposerSection } from './composer-section';
import { formatProposalAmount, minutesToHoursLabel } from './proposal-format';
import {
  COMPOSER_TARGET,
  blankMilestone,
  milestoneAllocation,
  milestoneFieldId,
} from './proposal-composer-state';
import type { ProposalMilestoneDraft, ProposalPricingMethod } from './proposal-composer-state';
import { DraftSuggestion, DraftingSkeleton } from './proposal-draft-indicators';

interface MilestonesSectionProps {
  milestones: ProposalMilestoneDraft[];
  pricingMethod: ProposalPricingMethod;
  milestonePricingEnabled: boolean;
  fixedPriceCents: number | null;
  totalCents: number;
  currency: string;
  onChange: (next: ProposalMilestoneDraft[]) => void;
  onToggleMilestonePricing: (enabled: boolean) => void;
  onSetPrice: (cents: number) => void;
  /** An AI draft is being written: a skeleton replaces the rows and Add milestone is disabled. */
  drafting?: boolean;
  /** The milestones are an untouched AI suggestion: show the marker and Clear. */
  suggested?: boolean;
  onClear?: () => void;
}

/** Parse a dollar string to integer cents, or null when blank/invalid. */
export function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return dollarsToCents(parsed);
}

/** Parse an HOURS string (the effort input is hours-facing) to integer MINUTES, or
 *  null when blank/invalid/negative. E.g. "1.5" → 90, "" → null, "-1" → null. */
function parseHoursToMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 60);
}

function gripId(key: string): string {
  return `milestone-grip-${key}`;
}

const ICON_BUTTON =
  'text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none sm:size-8';

interface MilestoneRowProps {
  milestone: ProposalMilestoneDraft;
  index: number;
  count: number;
  isFixed: boolean;
  showAmount: boolean;
  expanded: boolean;
  onPatch: (index: number, partial: Partial<ProposalMilestoneDraft>) => void;
  onToggle: (key: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, direction: -1 | 1) => void;
  onTitleKeyDown: (index: number) => (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

function MilestoneRow({
  milestone,
  index,
  count,
  isFixed,
  showAmount,
  expanded,
  onPatch,
  onToggle,
  onRemove,
  onMove,
  onTitleKeyDown,
}: Readonly<MilestoneRowProps>): React.JSX.Element {
  const controls = useDragControls();
  const n = index + 1;
  const peek = htmlToPlainText(milestone.descriptionHtml);
  const acceptanceId = `milestone-acceptance-${milestone.key}`;

  const handleGripKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>): void => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        onMove(index, -1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        onMove(index, 1);
      }
    },
    [index, onMove]
  );

  const handleGripPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>): void => controls.start(event),
    [controls]
  );

  return (
    <Reorder.Item
      as="li"
      value={milestone}
      dragListener={false}
      dragControls={controls}
      data-flash=""
      className="group border-border bg-card border-b last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-1.5 py-2 pr-2.5 pl-2">
        <button
          type="button"
          id={gripId(milestone.key)}
          aria-label={`Reorder milestone ${n}`}
          onPointerDown={handleGripPointerDown}
          onKeyDown={handleGripKeyDown}
          className="text-muted-foreground/60 hover:text-muted-foreground focus-visible:ring-ring relative flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-md after:absolute after:-inset-x-3 after:-inset-y-1.5 after:content-[''] focus-visible:ring-2 focus-visible:outline-none active:cursor-grabbing"
        >
          <GripVertical className="size-4" aria-hidden="true" />
        </button>
        <span className="text-muted-foreground w-5 shrink-0 text-center text-[13px] tabular-nums">
          {n}
        </span>
        <Input
          id={milestoneFieldId('title', milestone.key)}
          value={milestone.title}
          placeholder="Milestone title"
          aria-label={`Milestone ${n} title`}
          onChange={(e) => onPatch(index, { title: e.target.value })}
          onKeyDown={onTitleKeyDown(index)}
          className="hover:bg-muted/60 focus-visible:bg-muted/60 min-w-40 flex-1 border-transparent bg-transparent text-[15px] font-medium shadow-none"
        />
        {isFixed && showAmount && (
          <div className="relative w-36 shrink-0">
            <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
              A$
            </span>
            <Input
              id={milestoneFieldId('amount', milestone.key)}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              aria-label={`Milestone ${n} amount`}
              className="pl-9 font-mono tabular-nums"
              value={milestone.valueCents === null ? '' : centsToDollars(milestone.valueCents)}
              onChange={(e) => onPatch(index, { valueCents: parseDollarsToCents(e.target.value) })}
              placeholder="0"
            />
          </div>
        )}
        {!isFixed && (
          <div className="relative w-28 shrink-0">
            <Input
              id={milestoneFieldId('hours', milestone.key)}
              type="number"
              inputMode="decimal"
              min={0}
              step="0.25"
              aria-label={`Milestone ${n} estimated hours`}
              className="pr-8 font-mono tabular-nums"
              value={
                milestone.estimatedMinutes === null
                  ? ''
                  : minutesToHoursLabel(milestone.estimatedMinutes)
              }
              onChange={(e) =>
                onPatch(index, { estimatedMinutes: parseHoursToMinutes(e.target.value) })
              }
              placeholder="0"
            />
            <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
              h
            </span>
          </div>
        )}
        <button
          type="button"
          aria-label={`${expanded ? 'Hide' : 'Show'} details for milestone ${n}`}
          aria-expanded={expanded}
          onClick={() => onToggle(milestone.key)}
          className={ICON_BUTTON}
        >
          <ChevronDown
            className={cn('size-4 transition-transform motion-reduce:transition-none', {
              'rotate-180': expanded,
            })}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-label={`Remove milestone ${n}`}
          onClick={() => onRemove(index)}
          disabled={count === 1}
          className={cn(
            ICON_BUTTON,
            'hover:text-destructive group-focus-within:opacity-100 disabled:opacity-30 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100'
          )}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>
      </div>
      {!expanded && peek.length > 0 && (
        <button
          type="button"
          onClick={() => onToggle(milestone.key)}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring -mt-1 mb-2.5 block w-full truncate pr-12 pl-14 text-left text-[13.5px] focus-visible:ring-2 focus-visible:outline-none"
        >
          {peek}
        </button>
      )}
      {expanded && (
        <div className="grid gap-3 pr-12 pb-4 pl-14">
          <div className="space-y-1">
            <span className="text-muted-foreground block text-[12.5px] font-medium">
              What it covers
            </span>
            <RichTextEditor
              variant="light"
              value={milestone.descriptionHtml}
              onChange={(html) => onPatch(index, { descriptionHtml: html })}
              ariaLabel={`What milestone ${n} covers`}
              placeholder="Workshops with sales ops to map your pricing rules"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={acceptanceId} className="text-muted-foreground text-[12.5px]">
              Done when
            </Label>
            <Textarea
              id={acceptanceId}
              value={milestone.acceptanceCriteria}
              onChange={(e) => onPatch(index, { acceptanceCriteria: e.target.value })}
              rows={2}
              placeholder="You've signed off the solution design"
            />
          </div>
        </div>
      )}
    </Reorder.Item>
  );
}

interface AllocationLineProps {
  milestones: ProposalMilestoneDraft[];
  fixedPriceCents: number | null;
  currency: string;
  onSetPrice: (cents: number) => void;
}

function AllocationLine({
  milestones,
  fixedPriceCents,
  currency,
  onSetPrice,
}: Readonly<AllocationLineProps>): React.JSX.Element {
  const allocation = milestoneAllocation({ milestones, fixedPriceCents });
  const fmt = (cents: number): string => formatProposalAmount(cents, currency);
  const base = 'flex flex-wrap items-center justify-end gap-2.5 px-1 pt-1.5 text-[13.5px]';

  if (allocation.kind === 'no_price') {
    return (
      <output className={cn(base, 'text-muted-foreground')}>
        Milestones add up to{' '}
        <strong className="font-semibold">{fmt(allocation.allocatedCents)}</strong>. Set your
        project price below.
      </output>
    );
  }
  if (allocation.kind === 'balanced') {
    return (
      <output className={cn(base, 'text-success-strong')}>
        <Check className="size-3.5" aria-hidden="true" />
        Adds up to your {fmt(allocation.priceCents)} price
      </output>
    );
  }
  const { diffCents, priceCents, allocatedCents, allPriced } = allocation;
  const message =
    diffCents > 0
      ? `${fmt(diffCents)} of your ${fmt(priceCents)} price left to assign`
      : `${fmt(-diffCents)} over your ${fmt(priceCents)} price`;
  return (
    <output className={cn(base, 'text-warning-strong')}>
      <span>{message}</span>
      {allPriced && (
        <button
          type="button"
          onClick={() => onSetPrice(allocatedCents)}
          className="text-primary focus-visible:ring-ring min-h-11 rounded-md text-[13.5px] font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          Set price to {fmt(allocatedCents)}
        </button>
      )}
    </output>
  );
}

/**
 * Milestones section: a drag-reorderable list of rows (grip, number, title, one
 * method-specific commercial field, expand, delete) with Enter/Backspace title
 * shortcuts and a footer that adds a row, toggles per-milestone pricing (Fixed) or
 * shows the effort estimate (T&M). Detail ("What it covers", "Done when") opens per
 * row; a collapsed row shows a one-line peek of its description.
 */
export function MilestonesSection({
  milestones,
  pricingMethod,
  milestonePricingEnabled,
  fixedPriceCents,
  totalCents,
  currency,
  onChange,
  onToggleMilestonePricing,
  onSetPrice,
  drafting = false,
  suggested = false,
  onClear,
}: Readonly<MilestonesSectionProps>): React.JSX.Element {
  const isFixed = pricingMethod === 'fixed';
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pendingFocusId, setPendingFocusId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  // Focus a field once the row that owns it has rendered (rows are inserted /
  // reordered by the parent, so the target may not exist on the same render).
  useEffect(() => {
    if (pendingFocusId === null) return;
    const target = document.getElementById(pendingFocusId);
    if (target === null) return;
    target.focus();
    setPendingFocusId(null);
  }, [pendingFocusId, milestones]);

  const patch = useCallback(
    (index: number, partial: Partial<ProposalMilestoneDraft>): void => {
      onChange(milestones.map((m, i) => (i === index ? { ...m, ...partial } : m)));
    },
    [milestones, onChange]
  );

  const insertAt = useCallback(
    (index: number): void => {
      const row = blankMilestone(pricingMethod);
      onChange([...milestones.slice(0, index), row, ...milestones.slice(index)]);
      setPendingFocusId(milestoneFieldId('title', row.key));
    },
    [milestones, onChange, pricingMethod]
  );

  const remove = useCallback(
    (index: number): void => {
      onChange(milestones.filter((_, i) => i !== index));
    },
    [milestones, onChange]
  );

  const move = useCallback(
    (index: number, direction: -1 | 1): void => {
      const target = index + direction;
      const a = milestones[index];
      const b = milestones[target];
      if (a === undefined || b === undefined) return;
      const next = [...milestones];
      next[index] = b;
      next[target] = a;
      onChange(next);
      setPendingFocusId(gripId(a.key));
      const name = a.title.trim() === '' ? `Milestone ${index + 1}` : a.title;
      setAnnouncement(`Moved ${name} to position ${target + 1} of ${milestones.length}`);
    },
    [milestones, onChange]
  );

  const toggle = useCallback((key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  const handleTitleKeyDown = useCallback(
    (index: number) =>
      (event: React.KeyboardEvent<HTMLInputElement>): void => {
        if (event.nativeEvent.isComposing) return;
        const hasModifier = event.metaKey || event.ctrlKey || event.altKey || event.shiftKey;
        if (event.key === 'Enter') {
          if (hasModifier) return;
          event.preventDefault();
          insertAt(index + 1);
          return;
        }
        const current = milestones[index];
        if (event.key === 'Backspace' && current?.title === '' && milestones.length > 1) {
          event.preventDefault();
          const neighbour = milestones[index === 0 ? 1 : index - 1];
          remove(index);
          if (neighbour !== undefined) {
            setPendingFocusId(milestoneFieldId('title', neighbour.key));
          }
        }
      },
    [insertAt, milestones, remove]
  );

  const handleAdd = useCallback((): void => insertAt(milestones.length), [insertAt, milestones]);
  const handleClear = useCallback((): void => onClear?.(), [onClear]);

  const totalHours = minutesToHoursLabel(sumEstimatedMinutes(milestones));
  const help = isFixed
    ? "What you'll deliver. Open one to add detail and how it's signed off."
    : "Estimated hours per deliverable. They guide the estimate but don't cap it.";

  return (
    <ComposerSection
      id="proposal-section-milestones"
      title="Milestones"
      help={help}
      busy={drafting}
      aside={suggested && !drafting ? <DraftSuggestion onClear={handleClear} /> : undefined}
    >
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {drafting ? (
        <DraftingSkeleton variant="milestones" />
      ) : (
        <MotionConfig reducedMotion="user">
          <Reorder.Group
            as="ol"
            axis="y"
            values={milestones}
            onReorder={onChange}
            className={cn(
              'border-border overflow-hidden rounded-[14px] border',
              suggested && 'animate-in fade-in duration-500 motion-reduce:animate-none'
            )}
          >
            {milestones.map((milestone, index) => (
              <MilestoneRow
                key={milestone.key}
                milestone={milestone}
                index={index}
                count={milestones.length}
                isFixed={isFixed}
                showAmount={milestonePricingEnabled}
                expanded={expanded.has(milestone.key)}
                onPatch={patch}
                onToggle={toggle}
                onRemove={remove}
                onMove={move}
                onTitleKeyDown={handleTitleKeyDown}
              />
            ))}
          </Reorder.Group>
        </MotionConfig>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pt-2.5">
        <button
          type="button"
          id={COMPOSER_TARGET.addMilestone}
          onClick={handleAdd}
          disabled={drafting}
          className="text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-4" aria-hidden="true" />
          Add milestone
        </button>
        {isFixed ? (
          <div className="flex min-h-11 items-center gap-2">
            <Switch
              id="proposal-milestone-pricing"
              checked={milestonePricingEnabled}
              onCheckedChange={onToggleMilestonePricing}
            />
            <Label htmlFor="proposal-milestone-pricing" className="text-sm font-normal">
              Price each milestone
            </Label>
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            About <strong className="text-foreground font-semibold">{totalHours} hours</strong>,
            estimated{' '}
            <strong className="text-foreground font-semibold tabular-nums">
              {formatWholeCurrency(totalCents, currency)}
            </strong>
          </p>
        )}
      </div>

      {isFixed && milestonePricingEnabled && milestones.length > 0 && !drafting && (
        <AllocationLine
          milestones={milestones}
          fixedPriceCents={fixedPriceCents}
          currency={currency}
          onSetPrice={onSetPrice}
        />
      )}
    </ComposerSection>
  );
}
