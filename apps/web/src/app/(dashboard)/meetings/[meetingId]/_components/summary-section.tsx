'use client';

import { useCallback, useState } from 'react';
import { FileText, Sparkles } from 'lucide-react';
import { SectionEmpty, SectionHead } from '@/components/balo/section/section-states';
import { cn } from '@/lib/utils';
import type { RecapArtifactsView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R5 — the SUMMARY section, with all four async states.
 *
 * ⚠⚠ THE ARTEFACT-ABSENT RENDER IS THE **COMMON** CASE TODAY, NOT AN EDGE CASE. The transcript
 * pipeline has no production enqueuer, so a page that skeletons forever would skeleton for
 * essentially every meeting. Absence gets real copy, no blame, no retry button (there is no
 * endpoint to retry) and no roadmap promise.
 *
 * ⚠ WHEN THE SUMMARY **AND** THE TRANSCRIPT ARE BOTH NON-READY THEY COLLAPSE INTO ONE CARD,
 * not two sad stacked ones. That decision is made upstream in `resolveArtifacts`; this
 * component just honours `artifacts.collapsed`. Action items still render in full below it.
 */
export function SummarySection({
  artifacts,
}: Readonly<{ artifacts: RecapArtifactsView }>): React.JSX.Element {
  const { summary, transcript, collapsed } = artifacts;

  if (collapsed) {
    return (
      <section className="bg-card border-border rounded-2xl border p-6 shadow-sm">
        <SectionHead icon={FileText} title="Summary" />
        {summary.state === 'failed' ? (
          <SectionEmpty
            icon={FileText}
            title="We couldn't write this one up"
            body="Nothing else was affected — your action items and files are below."
          />
        ) : (
          <SectionEmpty
            icon={FileText}
            title="This call wasn't written up"
            body="No summary or transcript for this one — your action items and files are still here."
          />
        )}
      </section>
    );
  }

  return (
    <section className="bg-card border-border rounded-2xl border p-6 shadow-sm">
      <SectionHead
        icon={Sparkles}
        title="Summary"
        meta={summary.state === 'processing' ? 'Writing up the consultation…' : 'AI-generated'}
      />
      <SummaryBody summary={summary} transcriptState={transcript.state} />
    </section>
  );
}

function SummaryBody({
  summary,
  transcriptState,
}: Readonly<{
  summary: RecapArtifactsView['summary'];
  transcriptState: RecapArtifactsView['transcript']['state'];
}>): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  if (summary.state === 'processing') {
    return (
      <output aria-label="Writing up the consultation" className="block">
        <span className="bg-muted mb-2 block h-3 w-[95%] animate-pulse rounded" />
        <span className="bg-muted mb-2 block h-3 w-[88%] animate-pulse rounded" />
        <span className="bg-muted/60 mb-3 block h-3 w-[64%] animate-pulse rounded" />
        <span className="text-muted-foreground block text-xs leading-relaxed">
          This usually takes a few minutes. Everything else on this page is ready now.
        </span>
      </output>
    );
  }

  if (summary.content === null) {
    // Reached only when the transcript IS ready but the summary is not — otherwise the
    // collapsed card above owns this render.
    return (
      <SectionEmpty
        icon={FileText}
        title="This call wasn't written up"
        body={
          transcriptState === 'ready'
            ? 'There is no summary for this one — the transcript below has the detail.'
            : 'There is no summary for this one. Your action items and files are still here.'
        }
      />
    );
  }

  return (
    <div>
      <p
        className={cn(
          'text-foreground text-sm leading-relaxed whitespace-pre-line',
          !expanded && 'line-clamp-3'
        )}
      >
        {summary.content}
      </p>
      <button
        type="button"
        onClick={toggle}
        className="text-primary focus-visible:ring-ring mt-2 min-h-9 py-1.5 text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none"
      >
        {expanded ? 'Show less' : 'Read full summary'}
      </button>
    </div>
  );
}
