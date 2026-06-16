'use client';

import { useCallback } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { RichTextEditor } from '@/components/balo/rich-text-editor';
import { centsToDollars, dollarsToCents } from '@/lib/utils/currency';
import { minutesToHoursLabel } from './proposal-format';
import type { ProposalMilestoneDraft, ProposalPricingMethod } from './proposal-composer-state';

interface MilestonesTabProps {
  milestones: ProposalMilestoneDraft[];
  pricingMethod: ProposalPricingMethod;
  onChange: (next: ProposalMilestoneDraft[]) => void;
  onAdd: () => void;
}

/** Parse a dollar string to integer cents, or null when blank/invalid. */
function parseDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return dollarsToCents(parsed);
}

/** Parse an HOURS string (the effort input is hours-facing) to integer MINUTES, or
 *  null when blank/invalid/negative. Mirrors {@link parseDollarsToCents}. E.g.
 *  "1.5" → 90, "" → null, "-1" → null. */
function parseHoursToMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const parsed = Number.parseFloat(trimmed);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 60);
}

/**
 * Ordered milestone editor. Each row: number badge, title input, light-variant
 * TipTap description, acceptance "done when" input, and ONE method-specific
 * commercial field — under Fixed an `A$`-prefixed value input, under T&M an
 * hours-facing estimated-effort input (0.25 step; stored as integer minutes,
 * BAL-294). Add / remove / reorder. Switching method hides the off-method column
 * but KEEPS its entered values in state (the composer never clears them) — they
 * reappear on switching back.
 */
export function MilestonesTab({
  milestones,
  pricingMethod,
  onChange,
  onAdd,
}: Readonly<MilestonesTabProps>): React.JSX.Element {
  const isFixed = pricingMethod === 'fixed';

  const patch = useCallback(
    (index: number, partial: Partial<ProposalMilestoneDraft>): void => {
      onChange(milestones.map((m, i) => (i === index ? { ...m, ...partial } : m)));
    },
    [milestones, onChange]
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
      if (target < 0 || target >= milestones.length) return;
      const next = [...milestones];
      const a = next[index];
      const b = next[target];
      if (a === undefined || b === undefined) return;
      next[index] = b;
      next[target] = a;
      onChange(next);
    },
    [milestones, onChange]
  );

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-[13px]">
        Break the work into deliverables.{' '}
        {isFixed
          ? 'Each carries a value — set the fixed price in Payment & terms.'
          : 'Estimate the effort on each — the total derives from effort × your hourly rate.'}
      </p>

      <ol className="space-y-4">
        {milestones.map((milestone, index) => {
          const titleId = `milestone-title-${milestone.key}`;
          const acceptanceId = `milestone-acceptance-${milestone.key}`;
          const valueId = `milestone-value-${milestone.key}`;
          const effortId = `milestone-effort-${milestone.key}`;
          const descLabelId = `milestone-desc-label-${milestone.key}`;
          return (
            <li
              key={milestone.key}
              className="border-border bg-card relative rounded-[12px] border p-4"
            >
              <div className="flex items-start gap-3">
                <span className="bg-primary/10 text-primary mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold">
                  {index + 1}
                </span>
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={titleId}>Title</Label>
                    <Input
                      id={titleId}
                      value={milestone.title}
                      onChange={(e) => patch(index, { title: e.target.value })}
                      placeholder="e.g. Discovery & solution design"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={descLabelId} id={descLabelId}>
                      Description (optional)
                    </Label>
                    <RichTextEditor
                      variant="light"
                      value={milestone.descriptionHtml}
                      onChange={(html) => patch(index, { descriptionHtml: html })}
                      ariaLabel="Milestone description"
                      placeholder="What this milestone delivers…"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor={acceptanceId}>Done when (optional)</Label>
                    <Input
                      id={acceptanceId}
                      value={milestone.acceptanceCriteria}
                      onChange={(e) => patch(index, { acceptanceCriteria: e.target.value })}
                      placeholder="e.g. Signed-off design document"
                    />
                  </div>

                  {isFixed ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={valueId}>Value</Label>
                      <div className="relative w-44">
                        <span className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm">
                          A$
                        </span>
                        <Input
                          id={valueId}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          className="pl-9"
                          value={
                            milestone.valueCents === null
                              ? ''
                              : centsToDollars(milestone.valueCents)
                          }
                          onChange={(e) =>
                            patch(index, { valueCents: parseDollarsToCents(e.target.value) })
                          }
                          placeholder="0.00"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <Label htmlFor={effortId}>Estimated effort</Label>
                      <div className="relative w-44">
                        <Input
                          id={effortId}
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.25"
                          className="pr-12"
                          value={
                            milestone.estimatedMinutes === null
                              ? ''
                              : minutesToHoursLabel(milestone.estimatedMinutes)
                          }
                          onChange={(e) =>
                            patch(index, {
                              estimatedMinutes: parseHoursToMinutes(e.target.value),
                            })
                          }
                          placeholder="0"
                        />
                        <span className="text-muted-foreground pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm">
                          hrs
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label={`Move milestone ${index + 1} up`}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-30"
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === milestones.length - 1}
                    aria-label={`Move milestone ${index + 1} down`}
                    className="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-30"
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(index)}
                    disabled={milestones.length === 1}
                    aria-label={`Remove milestone ${index + 1}`}
                    className="text-muted-foreground hover:text-destructive focus-visible:ring-ring flex h-7 w-7 items-center justify-center rounded-md transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={onAdd}
        className="border-border text-foreground hover:bg-muted/50 focus-visible:ring-ring inline-flex min-h-11 items-center gap-2 rounded-[10px] border border-dashed px-4 text-[13px] font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add milestone
      </button>
    </div>
  );
}
