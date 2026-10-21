'use client';

import { FolderOpen } from 'lucide-react';
import { formatRelativeDate, pluralizeConsultations } from './format';

export interface CaseContextCardProps {
  title: string;
  consultationCount: number;
  openedAtIso: string;
}

/**
 * BAL-400 §2.5 (attach shape) — the read-only case-context card, replacing
 * title/description/products wherever there is no case dropdown to switch from: a case-page
 * booking before (or without) its open cases, and a pinned partial-failure recovery.
 */
export function CaseContextCard({
  title,
  consultationCount,
  openedAtIso,
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
    </div>
  );
}
