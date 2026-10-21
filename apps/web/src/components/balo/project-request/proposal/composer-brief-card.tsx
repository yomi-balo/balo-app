'use client';

import { useId, useState } from 'react';
import { MessageSquare } from 'lucide-react';

interface ComposerBriefCardProps {
  clientFirstName: string;
  /** One-line plain-text summary of the request. */
  summary: string;
  /** The full brief, rendered on the server through the sanitised rich-text path. */
  body: React.ReactNode;
}

/**
 * The client's brief, one click away while writing: a one-line summary with a
 * Show/Hide toggle that reveals the full request body.
 */
export function ComposerBriefCard({
  clientFirstName,
  summary,
  body,
}: Readonly<ComposerBriefCardProps>): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const bodyId = useId();

  return (
    <div className="bg-muted/40 border-border rounded-2xl border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-muted-foreground mb-1 flex items-center gap-1.5 text-[13px]">
            <MessageSquare className="size-3.5" aria-hidden="true" />
            {clientFirstName}&apos;s request
          </p>
          <p className="text-foreground/80 line-clamp-1 text-[14.5px]">{summary}</p>
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((current) => !current)}
          className="text-primary focus-visible:ring-ring inline-flex min-h-11 shrink-0 items-center rounded text-[13.5px] font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
        >
          {open ? 'Hide brief' : 'Show brief'}
        </button>
      </div>
      <div id={bodyId} hidden={!open} className="border-border mt-3 border-t pt-3">
        {body}
      </div>
    </div>
  );
}
