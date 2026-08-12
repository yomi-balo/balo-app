'use client';

import { useCallback, useState } from 'react';
import { Loader2, Lock, MessageSquare } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { SectionHead } from '@/components/balo/section/section-states';
import { track, RECAP_EVENTS } from '@/lib/analytics';
import type { RecapArtifactView } from '@/lib/meetings/recap-view-types';

/**
 * BAL-388 §R7 — the TRANSCRIPT section.
 *
 * ⚠ THE EMPTY STATE HERE IS A BARE FACTUAL LINE, NOT AN INVITATION — and that is the
 * documented EXCEPTION to balo-ui's keep-with-an-invitation default. A transcript is purely
 * RETROSPECTIVE data the viewer cannot act on or populate from here; there is nothing to
 * invite them to do.
 *
 * ⚠ SPEAKER LABELS ARE FIRST NAMES ONLY, and the content is the CLEANED transcript. No email
 * address, and no verbatim record.
 *
 * ⚠ THE EXPANDED HEIGHT IS CAPPED WITH INTERNAL SCROLL ON `lg` AND UNCAPPED BELOW IT — on a
 * phone, page scroll beats a nested scroll region.
 */
export function TranscriptSection({
  meetingId,
  transcript,
}: Readonly<{ meetingId: string; transcript: RecapArtifactView }>): React.JSX.Element {
  const [open, setOpen] = useState(false);

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        track(RECAP_EVENTS.TRANSCRIPT_OPENED, { meeting_id: meetingId });
      }
    },
    [meetingId]
  );

  return (
    <section className="bg-card border-border rounded-2xl border p-6 shadow-sm">
      <SectionHead icon={MessageSquare} title="Transcript" meta="cleaned" />
      <TranscriptBody transcript={transcript} open={open} onOpenChange={onOpenChange} />
    </section>
  );
}

function TranscriptBody({
  transcript,
  open,
  onOpenChange,
}: Readonly<{
  transcript: RecapArtifactView;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}>): React.JSX.Element {
  if (transcript.state === 'processing') {
    return (
      <output className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        Transcript is being prepared…
      </output>
    );
  }

  if (transcript.content === null) {
    return <p className="text-muted-foreground text-sm">No transcript for this one.</p>;
  }

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      {!open && (
        <p className="text-muted-foreground line-clamp-3 text-sm leading-relaxed whitespace-pre-line">
          {transcript.content}
        </p>
      )}
      <CollapsibleContent>
        <div className="text-muted-foreground max-h-none overflow-y-auto text-sm leading-relaxed whitespace-pre-line lg:max-h-[420px]">
          {transcript.content}
        </div>
      </CollapsibleContent>
      <CollapsibleTrigger className="text-primary focus-visible:ring-ring mt-2 min-h-9 py-1.5 text-xs font-medium hover:underline focus-visible:ring-2 focus-visible:outline-none">
        {open ? 'Collapse' : 'View full transcript'}
      </CollapsibleTrigger>
      <p className="text-muted-foreground mt-3 flex items-start gap-1.5 text-xs leading-relaxed">
        <Lock size={12} className="mt-0.5 flex-none" aria-hidden="true" />
        Cleaned transcript. The verbatim record is retained but not shown.
      </p>
    </Collapsible>
  );
}
