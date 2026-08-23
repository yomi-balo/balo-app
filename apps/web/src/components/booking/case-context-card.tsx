'use client';

import { FolderOpen } from 'lucide-react';
import { formatRelativeDate, pluralizeConsultations } from './format';

export interface CaseContextCardProps {
  title: string;
  consultationCount: number;
  openedAtIso: string;
  /**
   * Absent for entry point 3 (the case-surface quick-pick) — the client explicitly chose this
   * case by tapping its slot, so there is no "wrong case" to escape from (design §edge cases).
   */
  onSwitchToNew?: () => void;
}

/** BAL-400 §2.5 (attach shape) — the read-only case-context card, replacing title/description/products. */
export function CaseContextCard({
  title,
  consultationCount,
  openedAtIso,
  onSwitchToNew,
}: Readonly<CaseContextCardProps>): React.JSX.Element {
  return (
    <div className="border-border bg-muted/30 rounded-xl border p-4">
      <div className="flex items-start gap-3">
        <span className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <FolderOpen className="text-muted-foreground h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-foreground text-base font-semibold">{title}</p>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {pluralizeConsultations(consultationCount)} so far · opened{' '}
            {formatRelativeDate(openedAtIso)}
          </p>
        </div>
      </div>
      {onSwitchToNew !== undefined && (
        <button
          type="button"
          onClick={onSwitchToNew}
          className="text-primary focus-visible:ring-ring mt-3 inline-flex items-center rounded-md text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          Not the right case? Start a new one instead
        </button>
      )}
    </div>
  );
}
