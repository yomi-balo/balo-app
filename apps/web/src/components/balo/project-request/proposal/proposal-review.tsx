'use client';

import { useMemo, useState } from 'react';
import { Check, RotateCcw, Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { ProposalDoc } from './proposal-doc';
import { ProposalSectionNav, REVIEW_SECTIONS, type ReviewSection } from './proposal-section-nav';
import { ReviewSummaryCard } from './review-summary-card';
import { AcceptConfirmModal } from './accept-confirm-modal';
import { ChangesModal } from './changes-modal';
import { BackChannel } from './back-channel';
import { ProposalPdfDownloadLink } from './proposal-pdf-download-link';
import { firstName } from './proposal-name';
import type { ProposalReviewDoc } from './proposal-review-types';

interface ProposalReviewProps {
  requestId: string;
  /** Every live proposal on the request the client can review (1+). */
  proposals: ProposalReviewDoc[];
  /** Which proposal to open first (the active thread's relationship). */
  activeRelationshipId: string;
  /** The accepting client's company name — passed through to the accept modal. */
  clientCompanyName: string;
  /** The client's own first name (reserved for future framing; kept for parity). */
  clientFirstName: string;
}

/**
 * The nav sections actually present for a proposal: overview/milestones/payment/
 * terms always; attachments only when the proposal has a non-terms file (terms
 * docs fold into the Terms section, so a terms-only proposal has no Attachments).
 */
export function presentSections(doc: ProposalReviewDoc): ReviewSection[] {
  return REVIEW_SECTIONS.filter((section) => {
    if (section.key !== 'attachments') return true;
    return doc.attachments.some((attachment) => attachment.kind !== 'terms');
  });
}

/** Switcher sub-label: total · timeframe. */
function switcherSub(doc: ProposalReviewDoc): string {
  const total = formatWholeCurrency(doc.priceCents, doc.currency);
  const time = doc.timeframeWeeks === null ? '—' : `~${doc.timeframeWeeks}w`;
  return `${total} · ${time}`;
}

/**
 * The interactive CLIENT proposal-review surface (A6.4 / BAL-289). Composes the
 * read-only {@link ProposalDoc} with the section nav (scroll-spy) and the sticky
 * {@link ReviewSummaryCard}, and owns the {@link AcceptConfirmModal} open state.
 * Multiple proposals get a switcher; switching resets the modal. A
 * `changes_requested` proposal shows an "awaiting revision" empty state instead
 * of the doc — the other proposals stay reviewable.
 */
export function ProposalReview({
  requestId,
  proposals,
  activeRelationshipId,
  clientCompanyName,
}: Readonly<ProposalReviewProps>): React.JSX.Element {
  const initialId = useMemo(() => {
    const matched = proposals.find((proposal) => proposal.relationshipId === activeRelationshipId);
    return matched?.id ?? proposals[0]?.id ?? '';
  }, [proposals, activeRelationshipId]);

  const [activeId, setActiveId] = useState(initialId);
  const [modalOpen, setModalOpen] = useState(false);
  const [changesOpen, setChangesOpen] = useState(false);

  const active = proposals.find((proposal) => proposal.id === activeId) ?? proposals[0];

  if (active === undefined) {
    return (
      <div className="border-border bg-card text-muted-foreground rounded-2xl border p-8 text-center text-sm">
        No proposals to review yet.
      </div>
    );
  }

  const selectProposal = (id: string): void => {
    if (id === activeId) return;
    setActiveId(id);
    setModalOpen(false); // reset the decision modals when switching proposals
    setChangesOpen(false);
  };

  const isMulti = proposals.length > 1;
  const expertFirst = firstName(active.expert.name);
  const isSubmitted = active.status === 'submitted';
  const isAccepted = active.status === 'accepted';
  const isChangesRequested = active.status === 'changes_requested';

  const switcher = isMulti ? (
    <fieldset className="m-0 flex min-w-0 gap-2 overflow-x-auto border-0 p-0 pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <legend className="sr-only">Choose a proposal to review</legend>
      {proposals.map((proposal) => {
        const on = proposal.id === active.id;
        return (
          <button
            key={proposal.id}
            type="button"
            onClick={() => selectProposal(proposal.id)}
            aria-pressed={on}
            className={cn(
              'focus-visible:ring-ring flex shrink-0 items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none',
              on
                ? 'border-primary/40 bg-primary/[0.06]'
                : 'border-border bg-card hover:border-border/80'
            )}
          >
            <span className="bg-primary/10 text-primary flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg text-xs font-semibold">
              {proposal.expert.initials}
            </span>
            <div className="min-w-0">
              <p
                className={cn(
                  'text-[13.5px] font-semibold',
                  on ? 'text-foreground' : 'text-muted-foreground'
                )}
              >
                {firstName(proposal.expert.name)}
              </p>
              <p className="text-muted-foreground text-[11.5px] tabular-nums">
                {switcherSub(proposal)}
              </p>
            </div>
            {proposal.status === 'changes_requested' && (
              <span
                className="bg-warning ml-0.5 h-2 w-2 shrink-0 rounded-full"
                title="Changes requested"
                aria-label="Changes requested"
              />
            )}
          </button>
        );
      })}
    </fieldset>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* "You've received N proposals" nudge — shown at both breakpoints. */}
      {isMulti && (
        <div className="border-info/30 bg-info/10 rounded-2xl border p-4">
          <p className="text-foreground flex items-center gap-2 text-sm font-semibold">
            <Star className="text-info h-4 w-4 fill-current" aria-hidden="true" />
            You&apos;ve received {proposals.length} proposals
          </p>
          <p className="text-muted-foreground mt-1 text-[13px] leading-relaxed">
            Read each in full, then accept the expert you want — or ask for changes. Each is handled
            independently.
          </p>
        </div>
      )}

      {switcher}

      {isChangesRequested ? (
        <div className="border-border bg-card rounded-2xl border p-7 text-center">
          <span className="bg-warning/15 mx-auto mb-3.5 flex h-12 w-12 items-center justify-center rounded-2xl">
            <RotateCcw className="text-warning h-[22px] w-[22px]" aria-hidden="true" />
          </span>
          <h3 className="text-foreground text-base font-semibold">
            Changes requested from {expertFirst}
          </h3>
          <p className="text-muted-foreground mx-auto mt-2 max-w-[380px] text-[13.5px] leading-relaxed">
            They&apos;re revising and will resubmit. The other proposal is unaffected — you can
            still review or accept it.
          </p>
          <div className="mt-4 flex justify-center">
            <BackChannel name={expertFirst} />
          </div>
        </div>
      ) : (
        <>
          {/* Download stays with the visible doc — never offered while the doc is hidden
              behind the awaiting-revision state above. */}
          <div className="flex justify-end">
            <ProposalPdfDownloadLink requestId={requestId} relationshipId={active.relationshipId} />
          </div>

          {/* Desktop: 2-col doc + sticky summary card */}
          <div className="hidden items-start gap-5 lg:grid lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
            <div>
              <ProposalSectionNav proposalId={active.id} sections={presentSections(active)} />
              <div className="border-border bg-card mt-2 rounded-2xl border p-6 sm:p-7">
                <ProposalDoc doc={active} sectionIdPrefix={`sec-${active.id}-`} />
              </div>
            </div>
            <ReviewSummaryCard
              doc={active}
              onAccept={() => setModalOpen(true)}
              onRequestChanges={() => setChangesOpen(true)}
            />
          </div>

          {/* Mobile: nav + doc + bottom decision rail */}
          <div className="lg:hidden">
            <ProposalSectionNav proposalId={active.id} sections={presentSections(active)} />
            <div className="border-border bg-card mt-2 rounded-2xl border p-5">
              <ProposalDoc doc={active} sectionIdPrefix={`sec-${active.id}-`} />
            </div>
            {isAccepted && (
              <div className="border-success/30 bg-success/10 text-success mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-[10px] border px-4 text-sm font-semibold">
                <Check className="h-4 w-4" aria-hidden="true" />
                Accepted
              </div>
            )}
            {isSubmitted && (
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => setChangesOpen(true)}
                  className="border-warning/30 bg-warning/10 text-warning focus-visible:ring-ring hover:bg-warning/15 inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-[10px] border px-4 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:outline-none"
                >
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Changes
                </button>
                <button
                  type="button"
                  onClick={() => setModalOpen(true)}
                  className={cn(
                    'focus-visible:ring-ring inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-[10px] px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none',
                    PROPOSAL_CTA_GRADIENT_CLASS
                  )}
                >
                  <Check className="h-4 w-4" aria-hidden="true" />
                  Accept this proposal
                </button>
              </div>
            )}
          </div>
        </>
      )}

      <AcceptConfirmModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        requestId={requestId}
        doc={active}
        clientCompanyName={clientCompanyName}
      />

      <ChangesModal
        open={changesOpen}
        onOpenChange={setChangesOpen}
        requestId={requestId}
        relationshipId={active.relationshipId}
        proposalId={active.id}
        expertFirstName={expertFirst}
      />
    </div>
  );
}
