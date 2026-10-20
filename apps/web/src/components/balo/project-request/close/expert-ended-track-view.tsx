import Link from 'next/link';
import { ChevronLeft, XCircle } from 'lucide-react';
import { RequestCard } from '../request-card';
import { formatLongUtc } from '@/lib/format/utc-date';
import type { EndedTrackView } from '@/lib/project-request/resolve-ended-track-view';

/**
 * ExpertEndedTrackView — BAL-540 deviation V1 (design ref `ExpertTrackView`, `:954-1030`, modes
 * `declined`/`closed`). The ONE surface a de-participated expert may still open: the title, the
 * ended state, and nothing else — no brief, no contact, no conversation, no action. Rendered by
 * `page.tsx`'s `!ctx` branch when `resolveEndedTrackView` resolves non-null, instead of a 404.
 */

interface ExpertEndedTrackViewProps {
  view: EndedTrackView;
}

const DATE_VERB: Record<EndedTrackView['mode'], string> = {
  declined: 'Declined',
  request_closed: 'Closed',
  passed: 'Passed',
}; // pending-MJ

function titleFor(view: EndedTrackView): string {
  // pending-MJ (all titles)
  if (view.mode === 'request_closed') return `${view.companyName} closed this request`;
  if (view.mode === 'passed') return 'You passed on this project';
  return view.hadProposal
    ? `${view.companyName} isn’t proceeding with your proposal`
    : `${view.companyName} isn’t proceeding with you`;
}

function bodyFor(view: EndedTrackView): string {
  // pending-MJ (all bodies and both proposal clauses). `passed` ignores `hadProposal`: the
  // withdrawn draft is the expert's own, so there is no review outcome to describe.
  if (view.mode === 'passed') {
    return 'Balo is looking for other experts. The files you had access to stay exactly as they were. There’s nothing further to do here.';
  }
  if (view.mode === 'request_closed') {
    const proposalClause = view.hadProposal
      ? ' Your proposal was withdrawn along with the request,'
      : '';
    return `They’ve stopped looking for an expert for this work.${proposalClause} The files you had access to stay exactly as they were. There’s nothing further to do here.`;
  }
  const proposalClause = view.hadProposal
    ? ' Your proposal is no longer under review, and'
    : ' The';
  return `They’ve chosen a different direction.${proposalClause} files you had access to stay exactly as they were. There’s nothing further to do here.`;
}

export function ExpertEndedTrackView({
  view,
}: Readonly<ExpertEndedTrackViewProps>): React.JSX.Element {
  const dateVerb = DATE_VERB[view.mode];
  return (
    <RequestCard className="p-6 sm:p-7">
      <span className="bg-muted flex h-10 w-10 items-center justify-center rounded-xl">
        <XCircle className="text-muted-foreground h-[18px] w-[18px]" aria-hidden="true" />
      </span>
      <h1 className="text-foreground mt-3 text-lg font-semibold">{titleFor(view)}</h1>
      <p className="text-muted-foreground mt-2 max-w-xl text-[13.5px] leading-relaxed">
        {bodyFor(view)}
      </p>
      <p className="text-muted-foreground mt-2.5 text-xs">
        {dateVerb} {formatLongUtc(new Date(view.endedAtIso))}
      </p>
      <div className="mt-4">
        <Link
          href="/projects"
          className="text-primary focus-visible:ring-ring inline-flex items-center gap-1 rounded text-[12.5px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
        >
          <ChevronLeft className="h-3 w-3" aria-hidden="true" />
          {/* pending-MJ */}
          Back to your projects
        </Link>
      </div>
    </RequestCard>
  );
}
