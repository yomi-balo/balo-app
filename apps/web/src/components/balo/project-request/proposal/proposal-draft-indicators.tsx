import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export const SUGGESTED_LABEL = 'Suggested from the brief';
export const DRAFT_FAILED_LINE = "Couldn't draft this one. Start from scratch.";
export const MOBILE_DRAFTING = 'Drafting…';

/** "Drafting from Dana's request…", shown while the one automatic draft is generating. */
export function draftingLabel(clientFirstName: string): string {
  return `Drafting from ${clientFirstName}'s request…`;
}

/** "Drafted from Dana's request", the Overview badge once the draft has landed. */
export function draftedLabel(clientFirstName: string): string {
  return `Drafted from ${clientFirstName}'s request`;
}

const OVERVIEW_BARS = [
  { key: 'l1', width: 'w-full' },
  { key: 'l2', width: 'w-[96%]' },
  { key: 'l3', width: 'w-[88%]' },
  { key: 'l4', width: 'w-full' },
  { key: 'l5', width: 'w-[70%]' },
] as const;

const MILESTONE_BARS = [
  { key: 'm1', title: 'w-[62%]', line: 'w-[46%]' },
  { key: 'm2', title: 'w-[50%]', line: 'w-[38%]' },
  { key: 'm3', title: 'w-[56%]', line: 'w-[42%]' },
] as const;

const BAR = 'bg-muted animate-pulse rounded-md motion-reduce:animate-none';

interface DraftingLabelProps {
  label: string;
  className?: string;
  /** Visual only: hidden from assistive tech because another label already announces it. */
  decorative?: boolean;
}

/** The violet "Drafting…" line: a sparkle plus the label, announced politely unless decorative. */
export function DraftingLabel({
  label,
  className,
  decorative = false,
}: Readonly<DraftingLabelProps>): React.JSX.Element {
  return (
    <p
      role={decorative ? undefined : 'status'}
      aria-hidden={decorative || undefined}
      className={cn('text-violet flex items-center gap-2 text-[13px]', className)}
    >
      <Sparkles className="size-3.5 shrink-0" aria-hidden="true" />
      {label}
    </p>
  );
}

interface DraftingSkeletonProps {
  variant: 'overview' | 'milestones';
  /** The drafting line shown above the bars (Overview only; Milestones draws bars alone). */
  label?: string;
}

/** Placeholder bars for a section whose draft is still being written. Flat, no shadow. */
export function DraftingSkeleton({
  variant,
  label,
}: Readonly<DraftingSkeletonProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'border-border bg-card grid h-full content-start gap-2.5 rounded-[14px] border p-[18px]',
        variant === 'milestones' && 'gap-3'
      )}
      data-testid={`draft-skeleton-${variant}`}
    >
      {label !== undefined && <DraftingLabel label={label} className="mb-1" />}
      {variant === 'overview'
        ? OVERVIEW_BARS.map((bar) => (
            <div key={bar.key} aria-hidden="true" className={cn(BAR, 'h-3', bar.width)} />
          ))
        : MILESTONE_BARS.map((bar) => (
            <div key={bar.key} aria-hidden="true" className="grid gap-2 py-1.5">
              <div className={cn(BAR, 'h-3.5', bar.title)} />
              <div className={cn(BAR, 'h-3', bar.line)} />
            </div>
          ))}
    </div>
  );
}

interface ClearButtonProps {
  /** Accessible name; starts with the visible "Clear" and names the section it clears. */
  label: string;
  onClear: () => void;
}

function ClearButton({ label, onClear }: Readonly<ClearButtonProps>): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={label}
      className="text-primary focus-visible:ring-ring -my-2 inline-flex min-h-11 items-center rounded px-2 text-[13.5px] font-medium whitespace-nowrap hover:underline focus-visible:ring-2 focus-visible:outline-none"
    >
      Clear
    </button>
  );
}

interface DraftBadgeProps {
  label: string;
  onClear: () => void;
}

/** The violet "Drafted from…" pill with its Clear control. */
export function DraftBadge({ label, onClear }: Readonly<DraftBadgeProps>): React.JSX.Element {
  return (
    <>
      <span className="text-violet bg-violet/10 inline-flex items-center gap-1.5 rounded-full py-[3px] pr-2.5 pl-2 text-[12.5px] font-medium">
        <Sparkles className="size-[13px]" aria-hidden="true" />
        {label}
      </span>
      <ClearButton label="Clear drafted overview" onClear={onClear} />
    </>
  );
}

interface DraftSuggestionProps {
  onClear: () => void;
}

/** The "Suggested from the brief" marker on Milestones, with its Clear control. */
export function DraftSuggestion({ onClear }: Readonly<DraftSuggestionProps>): React.JSX.Element {
  return (
    <>
      <span className="text-violet inline-flex items-center gap-1.5 text-[13px]">
        <Sparkles className="size-[13px]" aria-hidden="true" />
        {SUGGESTED_LABEL}
      </span>
      <ClearButton label="Clear suggested milestones" onClear={onClear} />
    </>
  );
}

/** The quiet line shown when drafting failed or timed out; the composer is simply blank. */
export function DraftFailedNote(): React.JSX.Element {
  return (
    <p role="status" className="text-muted-foreground mb-3 text-[13px]">
      {DRAFT_FAILED_LINE}
    </p>
  );
}
