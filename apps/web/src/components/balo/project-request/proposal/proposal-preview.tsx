'use client';

import { useEffect, useRef } from 'react';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { ProposalDoc } from './proposal-doc';
import type { ProposalReviewDoc } from './proposal-review-types';

interface ProposalPreviewProps {
  /** Built from the composer state by `draftToReviewDoc`, so it equals what Send submits. */
  doc: ProposalReviewDoc;
  requestTitle: string;
  /** The client company the proposal goes to. */
  companyName: string;
  /** Revise mode relabels Send to "Resend". */
  reviseMode: boolean;
  /** A send is in flight: both actions are disabled. */
  pending: boolean;
  onBack: () => void;
  onSend: () => void;
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The full-page preview before sending (BAL-610): the client's document layout with
 * the expert's own figures. A sticky banner carries the two commit actions, so the
 * send is always one deliberate click from the document it sends. The doc is at
 * identity money — the expert sees what they receive, never the marked-up price.
 */
export function ProposalPreview({
  doc,
  requestTitle,
  companyName,
  reviseMode,
  pending,
  onBack,
  onSend,
}: Readonly<ProposalPreviewProps>): React.JSX.Element {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <div>
      <div className="border-primary/30 bg-primary/5 sticky top-[4.5rem] z-10 mb-5 flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-4">
        <div className="min-w-0">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-foreground text-sm font-semibold outline-none"
          >
            Previewing as {companyName}
          </h2>
          <p className="text-muted-foreground text-[13px]">
            Amounts are what you receive. {upperFirst(companyName)} sees them with Balo&apos;s
            service margin added.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={pending}
            onClick={onBack}
          >
            Back to editing
          </Button>
          <button
            type="button"
            onClick={onSend}
            disabled={pending}
            className={cn(
              'focus-visible:ring-ring inline-flex h-11 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
            {reviseMode ? 'Resend' : 'Send'} to {companyName}
          </button>
        </div>
      </div>

      <article className="border-border bg-card rounded-2xl border p-6 sm:p-11">
        <h1 className="text-foreground mb-6 text-2xl font-semibold tracking-tight">
          {requestTitle}
        </h1>
        <ProposalDoc doc={doc} />
      </article>
    </div>
  );
}
