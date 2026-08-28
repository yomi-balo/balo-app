import { FileText, Sparkles } from 'lucide-react';
import { SectionEmpty, SectionHead } from '@/components/balo/section/section-states';
import type { GuestRecapSummaryView } from '../_lib/guest-recap-view-types';

/**
 * BAL-439 §5.1 / §6.3 — the guest recap's summary card. RSC, no `'use client'`: a plain read
 * with no interactivity, which is also what keeps this route's client bundle to exactly one
 * island (`guest-recap-files.tsx`).
 *
 * ⚠ NO "Read full summary" EXPAND/COLLAPSE, unlike the member card. The member card clamps to 3
 * lines because it competes with five other regions on the page; the guest card has two. An
 * expand/collapse control would be this component's only reason to become a client component.
 *
 * ⚠ THE COPY IS DELIBERATELY DIFFERENT FROM THE MEMBER CARD'S — never "your action items", never
 * "the transcript below": a guest has neither surface. See the member `SummarySection`'s own
 * docblock, which names this exact copy as wrong for a guest audience.
 */
export function GuestRecapSummary({
  summary,
}: Readonly<{ summary: GuestRecapSummaryView }>): React.JSX.Element {
  return (
    <section className="bg-card border-border rounded-2xl border p-6 shadow-sm">
      <SectionHead
        icon={Sparkles}
        title="Summary"
        meta={summary.state === 'processing' ? 'Writing up the call…' : undefined}
      />
      <GuestRecapSummaryBody summary={summary} />
    </section>
  );
}

function GuestRecapSummaryBody({
  summary,
}: Readonly<{ summary: GuestRecapSummaryView }>): React.JSX.Element {
  if (summary.state === 'processing') {
    // ⚠ `<output>`, NEVER `role="status"` — SonarCloud S6819. Mirrors the member card's
    // `SummaryBody` pulse-bar shape, minus the expand affordance.
    return (
      <output aria-label="Writing up the call" className="block">
        <span className="bg-muted mb-2 block h-3 w-[95%] animate-pulse rounded" />
        <span className="bg-muted mb-2 block h-3 w-[88%] animate-pulse rounded" />
        <span className="bg-muted/60 mb-3 block h-3 w-[64%] animate-pulse rounded" />
        <span className="text-muted-foreground block text-xs leading-relaxed">
          This usually takes a few minutes.
        </span>
      </output>
    );
  }

  if (summary.state === 'failed') {
    return (
      <SectionEmpty
        icon={FileText}
        title="We couldn't write this one up"
        body="Nothing else was affected — anything that was shared is below."
      />
    );
  }

  if (summary.state === 'ready' && summary.content !== null) {
    return (
      <p className="text-foreground text-sm leading-relaxed whitespace-pre-line">
        {summary.content}
      </p>
    );
  }

  // The `absent` state, and the defensive fallback for an unreachable `ready` row with no
  // content (`resolveGuestSummary` never produces one, but the type does not encode that
  // correlation) — the same honest copy either way rather than an empty card.
  return (
    <SectionEmpty
      icon={FileText}
      title="This call wasn't written up"
      body="There's no summary for this one — anything that was shared is below."
    />
  );
}
