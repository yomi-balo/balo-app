'use client';

import { Clock, Hourglass } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ProposalDoc } from './proposal-doc';
import { BackChannel } from './back-channel';
import type { ProposalReviewDoc } from './proposal-review-types';

interface SubmittedViewProps {
  /** Whose waiting framing to show — the submitting expert, or an observing admin. */
  lens: 'expert' | 'admin';
  doc: ProposalReviewDoc;
  /** The client (display name) reviewing the proposal. */
  clientName: string;
  /** Other live proposals on this request besides `doc` (drives "alongside N others"). */
  otherProposalCount: number;
}

interface WaitingCopy {
  icon: LucideIcon;
  headline: string;
  sub: string;
}

/** Build the lens-specific waiting banner copy. */
function waitingCopy(props: Readonly<SubmittedViewProps>): WaitingCopy {
  const { lens, clientName, otherProposalCount } = props;
  if (lens === 'expert') {
    const alongside =
      otherProposalCount > 0
        ? ` alongside ${otherProposalCount} other${otherProposalCount > 1 ? 's' : ''}`
        : '';
    return {
      icon: Hourglass,
      headline: `Proposal sent to ${clientName}`,
      sub: `They're reviewing it${alongside}. You'll be notified the moment they respond.`,
    };
  }
  return {
    icon: Clock,
    headline: `${otherProposalCount + 1} proposals submitted — client reviewing`,
    sub: 'No action until the client accepts one or asks for changes.',
  };
}

/**
 * The read-only "submitted, awaiting the client" surface (A6.4 / BAL-289) for the
 * expert and admin lenses. A waiting banner (warning tone) frames the wait, then
 * the same {@link ProposalDoc} renders read-only (no `sectionIdPrefix` → no
 * anchors, no scroll-spy). The expert lens gets a demoted back-channel to nudge
 * the client; the admin lens does not (admins don't message on the expert's behalf).
 */
export function SubmittedView(props: Readonly<SubmittedViewProps>): React.JSX.Element {
  const { lens, doc, clientName } = props;
  const { icon: Icon, headline, sub } = waitingCopy(props);

  return (
    <div className="flex flex-col gap-4">
      <div className="border-warning/30 bg-warning/10 flex items-start gap-3 rounded-2xl border p-4">
        <span className="bg-warning/15 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
          <Icon className="text-warning h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-foreground text-sm font-semibold">{headline}</p>
          <p className="text-muted-foreground mt-0.5 text-[13px] leading-relaxed">{sub}</p>
        </div>
      </div>

      <div className="border-border bg-card rounded-2xl border p-5 sm:p-6">
        <ProposalDoc doc={doc} />
      </div>

      {lens === 'expert' && (
        <div className="flex justify-start px-0.5">
          <BackChannel name={clientName} />
        </div>
      )}
    </div>
  );
}
