'use client';

import { RotateCcw, X } from 'lucide-react';

/** The notice's copy — exported so tests pin the exact strings. */
export const NEW_REQUEST_NOTICE_COPY = {
  message: 'Started a new request from your search.',
  undo: 'Undo',
  undoLabel: 'Undo — bring back your earlier draft',
  dismissLabel: 'Dismiss',
} as const;

export interface NewRequestNoticeProps {
  onUndo: () => void;
  onDismiss: () => void;
}

/**
 * Shown at the top of the `manual` step when a new hero search started a fresh request over a
 * draft the visitor had added to (`useProjectSeed`). It lives INSIDE the drawer: the drawer is a
 * modal, so a toast's Undo behind it could be neither clicked nor reached by keyboard or screen
 * reader. Styled after `AiProvenanceBanner` — the panel's other in-flow notice.
 */
export function NewRequestNotice({
  onUndo,
  onDismiss,
}: Readonly<NewRequestNoticeProps>): React.JSX.Element {
  return (
    <div className="border-primary/30 bg-primary/[0.04] flex items-center gap-3 rounded-xl border py-1.5 pr-1.5 pl-4">
      <RotateCcw className="text-primary h-4 w-4 shrink-0" aria-hidden="true" />
      <p className="text-foreground min-w-0 flex-1 text-sm font-medium">
        {NEW_REQUEST_NOTICE_COPY.message}
      </p>
      <button
        type="button"
        onClick={onUndo}
        aria-label={NEW_REQUEST_NOTICE_COPY.undoLabel}
        className="border-border bg-card text-foreground hover:bg-muted focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded-lg border px-3 text-xs font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        {NEW_REQUEST_NOTICE_COPY.undo}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={NEW_REQUEST_NOTICE_COPY.dismissLabel}
        className="text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring inline-flex size-11 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
