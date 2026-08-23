'use client';

import { forwardRef, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, FilePlus2, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelativeDate, pluralizeConsultations } from './format';
import type { OpenCaseForExpert } from './types';

const VISIBLE_CAP = 4;

interface CaseChoiceCardProps {
  selected: boolean;
  onSelect: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}

/**
 * UX-5 (BAL-400 round 2) — `forwardRef` + `tabIndex` are the roving-tabindex half of the
 * WAI-ARIA APG radiogroup pattern: exactly ONE card (the selected one) is ever in the Tab
 * order; every other card is reachable only by Left/Right/Up/Down, which is what a
 * `role="radiogroup"` announcement promises a keyboard/screen-reader user.
 */
const CaseChoiceCard = forwardRef<HTMLButtonElement, Readonly<CaseChoiceCardProps>>(
  function CaseChoiceCard({ selected, onSelect, onKeyDown, icon, title, subtitle }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        role="radio"
        aria-checked={selected}
        tabIndex={selected ? 0 : -1}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        className={cn(
          'focus-visible:ring-ring relative flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-all focus-visible:ring-2 focus-visible:outline-none',
          selected
            ? 'border-primary bg-primary/5'
            : 'border-border bg-card hover:border-primary/40 hover:bg-primary/[0.03] hover:-translate-y-0.5'
        )}
      >
        {icon}
        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-semibold">{title}</span>
          <span className="text-muted-foreground mt-0.5 block text-xs leading-snug">
            {subtitle}
          </span>
        </span>
        {selected && (
          <span className="bg-primary text-primary-foreground absolute top-2.5 right-2.5 flex h-4 w-4 items-center justify-center rounded-full">
            <Check className="h-2.5 w-2.5" aria-hidden="true" />
          </span>
        )}
      </button>
    );
  }
);

export interface CaseChoiceSectionProps {
  openCases: readonly OpenCaseForExpert[];
  /** `null` ⇒ "Start a new case" (the default). A `string` ⇒ that case's `engagementId`. */
  selectedEngagementId: string | null;
  onSelect: (engagementId: string | null) => void;
  expertFirstName: string | null;
}

/**
 * BAL-400 §2.5 — the case-choice segmented card list. Absent from the tree entirely when
 * `openCases` is empty (the caller decides that — see `step-confirm.tsx`), or when entry
 * point 3 already fixed the case.
 *
 * ⚠ UX-5 — arrow-key roving-tabindex navigation over the CURRENTLY VISIBLE cards only (the
 * "new case" card plus whichever existing cases are shown before "Show N more" is pressed);
 * expanding the list widens the array these handlers walk, nothing more.
 */
export function CaseChoiceSection({
  openCases,
  selectedEngagementId,
  onSelect,
  expertFirstName,
}: Readonly<CaseChoiceSectionProps>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? openCases : openCases.slice(0, VISIBLE_CAP);
  const hiddenCount = openCases.length - visible.length;

  // `null` (new case) is always slot 0; each visible existing case follows, in order.
  const keys = useMemo<Array<string | null>>(
    () => [null, ...visible.map((c) => c.engagementId)],
    [visible]
  );
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAndSelect(index: number): void {
    const wrapped = ((index % keys.length) + keys.length) % keys.length;
    const key = keys[wrapped];
    if (key === undefined) return; // unreachable — `wrapped` is always in range
    onSelect(key);
    cardRefs.current[wrapped]?.focus();
  }

  function handleKeyDown(index: number) {
    return (event: KeyboardEvent<HTMLButtonElement>): void => {
      switch (event.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          event.preventDefault();
          focusAndSelect(index + 1);
          break;
        case 'ArrowUp':
        case 'ArrowLeft':
          event.preventDefault();
          focusAndSelect(index - 1);
          break;
        case 'Home':
          event.preventDefault();
          focusAndSelect(0);
          break;
        case 'End':
          event.preventDefault();
          focusAndSelect(keys.length - 1);
          break;
        default:
          break;
      }
    };
  }

  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <p className="text-foreground text-sm font-semibold">Which case is this for?</p>
        <p className="text-muted-foreground text-xs leading-relaxed">
          A case can hold more than one consultation on the same issue.
        </p>
      </div>
      <div role="radiogroup" aria-label="Which case is this for?" className="flex flex-col gap-2">
        <CaseChoiceCard
          ref={(el) => {
            cardRefs.current[0] = el;
          }}
          selected={selectedEngagementId === null}
          onSelect={() => onSelect(null)}
          onKeyDown={handleKeyDown(0)}
          icon={
            <span className="border-primary/25 bg-primary/10 text-primary flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border">
              <FilePlus2 className="h-4 w-4" aria-hidden="true" />
            </span>
          }
          title="Start a new case"
          subtitle={`For a new issue with ${expertFirstName ?? 'them'}.`}
        />
        {visible.map((c, i) => (
          <CaseChoiceCard
            key={c.engagementId}
            ref={(el) => {
              cardRefs.current[i + 1] = el;
            }}
            selected={selectedEngagementId === c.engagementId}
            onSelect={() => onSelect(c.engagementId)}
            onKeyDown={handleKeyDown(i + 1)}
            icon={
              <span className="bg-muted text-muted-foreground flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]">
                <FolderOpen className="h-4 w-4" aria-hidden="true" />
              </span>
            }
            title={c.title}
            subtitle={`${pluralizeConsultations(c.consultationCount)} · last activity ${formatRelativeDate(c.lastActivityAt)}`}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setExpanded(true)} className="w-full">
          Show {hiddenCount} more
        </Button>
      )}
    </div>
  );
}
