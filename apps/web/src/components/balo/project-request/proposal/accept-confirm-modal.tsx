'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import * as Sentry from '@sentry/nextjs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { upfrontDueCents } from '@balo/shared/project-requests';
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { acceptProposalAction } from '@/app/(dashboard)/projects/[requestId]/_actions/accept-proposal';
import { BaloTermsBlock } from './balo-terms-block';
import { NumberedList } from './numbered-list';
import { pricingMethodLabel } from './proposal-summary-cells';
import type { ProposalReviewDoc } from './proposal-review-types';

/** Copy the action returns when the proposal can no longer be accepted (stale UI). */
const STALE_PROPOSAL_COPY = 'This proposal can no longer be accepted.';

interface AcceptConfirmModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  requestId: string;
  doc: ProposalReviewDoc;
  /** The accepting client's company name — woven into the binding acknowledgement. */
  clientCompanyName: string;
}

/** The additional terms shown before "Show all". */
const COLLAPSED_TERM_COUNT = 3;

/** "3 assumptions", "1 exclusion". */
function countOf(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The line telling the client the proposal's assumptions and exclusions are part of what
 * they accept, or null when it has neither.
 */
function scopeCountLine(assumptions: number, exclusions: number): string | null {
  const parts = [
    assumptions > 0 ? countOf(assumptions, 'assumption', 'assumptions') : null,
    exclusions > 0 ? countOf(exclusions, 'exclusion', 'exclusions') : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return null;
  return `The proposal’s ${parts.join(' and ')} are part of what you’re accepting.`;
}

interface MoneyRow {
  label: string;
  value: string;
  sub: string;
}

/**
 * The three-row money summary — Total / Due now / Then — derived from the doc.
 * Fixed: the first installment is "due now" (its pct of the total); the remainder
 * is "on delivery". With no installments we fall back to charging the full total
 * up front. T&M: deposit now, the rest billed against time.
 */
function moneyRows(doc: ProposalReviewDoc): MoneyRow[] {
  const total = formatWholeCurrency(doc.priceCents, doc.currency);

  if (doc.pricingMethod === 'tm') {
    const dueNowCents = upfrontDueCents(doc);
    const thenSub =
      doc.rateCents === null
        ? 'billed against time'
        : `billed against time at ${formatWholeCurrency(doc.rateCents, doc.currency)}/hr`;
    return [
      // ⚠ The helper, NOT a hardcoded arm: this modal sits on the same accept surface as
      // the summary grid, and used to say capital-M `Time & Materials` next to the grid's
      // canonical lower-case cell (BAL-392 F2). Capital-M is retired on every client
      // surface — the proposal header pills read this same helper.
      { label: 'Total', value: total, sub: pricingMethodLabel(doc.pricingMethod) },
      { label: 'Due now', value: formatWholeCurrency(dueNowCents, doc.currency), sub: 'deposit' },
      { label: 'Then', value: '—', sub: thenSub },
    ];
  }

  const [upfront] = doc.installments;
  if (upfront === undefined) {
    return [
      { label: 'Total', value: total, sub: pricingMethodLabel(doc.pricingMethod) },
      { label: 'Due now', value: total, sub: 'full amount' },
      { label: 'Then', value: '—', sub: 'nothing outstanding' },
    ];
  }

  const dueNowCents = upfrontDueCents(doc);
  const thenCents = doc.priceCents - dueNowCents;
  return [
    { label: 'Total', value: total, sub: pricingMethodLabel(doc.pricingMethod) },
    {
      label: 'Due now',
      value: formatWholeCurrency(dueNowCents, doc.currency),
      sub: `${upfront.pct}% ${upfront.label.toLowerCase()}`,
    },
    { label: 'Then', value: formatWholeCurrency(thenCents, doc.currency), sub: 'on delivery' },
  ];
}

/**
 * The accept-confirm beat (A6.4 / BAL-289) — the CLIENT mirror of the expert's
 * submit dialog. Owns its pending + acknowledgement state, blocks Escape while in
 * flight. On confirm it calls `acceptProposalAction` (which emits
 * `PROJECT_PROPOSAL_ACCEPTED` server-side — BAL-357), fires the request-transition
 * analytics on success when the aggregate advanced, toasts, then routes
 * to the request detail and refreshes. Stays open on a generic failure so the
 * client can retry; closes on the stale-UI path (nothing to retry).
 */
export function AcceptConfirmModal({
  open,
  onOpenChange,
  requestId,
  doc,
  clientCompanyName,
}: Readonly<AcceptConfirmModalProps>): React.JSX.Element {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [ack, setAck] = useState(false);
  const [showAllTerms, setShowAllTerms] = useState(false);

  const rows = moneyRows(doc);
  const termCount = doc.additionalTerms.length;
  const hasTerms = termCount > 0;
  const canCollapseTerms = termCount > COLLAPSED_TERM_COUNT;
  const shownTerms =
    showAllTerms || !canCollapseTerms
      ? doc.additionalTerms
      : doc.additionalTerms.slice(0, COLLAPSED_TERM_COUNT);
  const scopeLine = scopeCountLine(doc.assumptions.length, doc.exclusions.length);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return; // no Escape-away mid-accept
      if (!next) {
        setAck(false); // reset the acknowledgement on close
        setShowAllTerms(false);
      }
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

  const toggleShowAllTerms = useCallback((): void => {
    setShowAllTerms((current) => !current);
  }, []);

  const handleConfirm = useCallback((): void => {
    if (pending || !ack) return;
    setPending(true);

    const run = async (): Promise<void> => {
      try {
        const result = await acceptProposalAction({
          requestId,
          relationshipId: doc.relationshipId,
          proposalId: doc.id,
        });

        if (!result.success) {
          // Coherence rejection (defence-in-depth behind the readiness check) →
          // fire analytics with the raw rule; the UI only ever shows generic copy.
          if (result.coherence) {
            track(PROJECT_EVENTS.PROPOSAL_COHERENCE_REJECTED, {
              rule: result.coherence.rule,
              pricing_method: result.coherence.pricingMethod,
              entry_point: 'web',
              proposal_id: result.coherence.proposalId,
              relationship_id: result.coherence.relationshipId,
            });
          }
          // Stale-UI copy → close (nothing to retry); otherwise stay open.
          if (result.error === STALE_PROPOSAL_COPY) {
            toast.error(result.error);
            onOpenChange(false);
            router.refresh();
            return;
          }
          toast.error(result.error);
          return;
        }

        // BAL-357: PROJECT_PROPOSAL_ACCEPTED is emitted SERVER-SIDE by the action so
        // the Balo fee + client-charged price never transit the browser (a client
        // could otherwise back out the expert's payout). The client only fires the
        // non-sensitive events below.
        if (result.transitioned) {
          track(PROJECT_EVENTS.PROJECT_REQUEST_STATUS_TRANSITIONED, {
            request_id: requestId,
            from: 'proposal_submitted',
            to: 'accepted',
            actor: 'client',
          });
        }

        toast.success('Proposal accepted');
        onOpenChange(false);
        router.push(`/projects/${requestId}`);
        router.refresh();
      } catch {
        toast.error('Could not accept this proposal. Please try again.');
      } finally {
        setPending(false);
      }
    };
    // `run` handles its own failures; this catches only what escapes its `finally`.
    run().catch((error: unknown) => Sentry.captureException(error));
  }, [pending, ack, requestId, doc.relationshipId, doc.id, onOpenChange, router]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={!pending}
        className="flex max-h-[90dvh] flex-col gap-0 p-0 sm:max-w-[460px]"
      >
        <DialogHeader className="from-primary/[0.07] to-primary/[0.02] border-border shrink-0 space-y-0 border-b bg-gradient-to-br p-6 text-left">
          <div className="flex items-center gap-3">
            <span className="bg-primary/10 text-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-semibold">
              {doc.expert.initials}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-base font-semibold">
                Accept {doc.expert.name}&apos;s proposal?
              </DialogTitle>
              <DialogDescription className="mt-0.5 text-xs">
                This starts the engagement and is binding.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-6">
          {/* Money summary */}
          <dl className="mb-4 flex flex-col gap-2.5">
            {rows.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-3 text-[13.5px]"
              >
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="text-foreground text-right font-semibold tabular-nums">
                  {row.value}
                  <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                    {row.sub}
                  </span>
                </dd>
              </div>
            ))}
          </dl>

          {/* What the client is agreeing to */}
          <div className="mb-4 flex flex-col gap-3">
            <h3 className="text-foreground text-[13.5px] font-semibold">What you’re agreeing to</h3>
            <BaloTermsBlock
              where="accept"
              pricingMethod={doc.pricingMethod}
              companyName={clientCompanyName}
            />
            {hasTerms && (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-foreground text-[13px] font-semibold">
                    {doc.expert.name}’s additional terms ({termCount})
                  </p>
                  {canCollapseTerms && (
                    <button
                      type="button"
                      onClick={toggleShowAllTerms}
                      aria-expanded={showAllTerms}
                      className="text-primary focus-visible:ring-ring inline-flex min-h-11 items-center rounded-md px-1 text-xs font-semibold focus-visible:ring-2 focus-visible:outline-none"
                    >
                      {showAllTerms ? 'Show fewer' : `Show all ${termCount}`}
                    </button>
                  )}
                </div>
                <NumberedList items={shownTerms} />
              </div>
            )}
            {scopeLine !== null && (
              <p className="text-muted-foreground text-[12.5px] leading-relaxed">{scopeLine}</p>
            )}
          </div>

          {/* Binding acknowledgement */}
          <label className="bg-muted/40 flex cursor-pointer items-start gap-2.5 rounded-xl p-3.5">
            <Checkbox
              checked={ack}
              onCheckedChange={(checked) => setAck(checked === true)}
              disabled={pending}
              className="mt-0.5"
              aria-labelledby="accept-ack-copy"
            />
            <span
              id="accept-ack-copy"
              className="text-muted-foreground text-[12.5px] leading-relaxed"
            >
              I agree to <strong className="text-foreground">Balo’s Project T&amp;Cs</strong>
              {hasTerms ? ` and ${doc.expert.name}’s additional terms above` : ''}, and understand
              accepting commits {clientCompanyName} to them.{' '}
              {upfrontDueCents(doc) > 0
                ? "Balo will raise the upfront invoice and tell the other experts they weren't selected."
                : "Balo will tell the other experts they weren't selected."}
            </span>
          </label>
        </div>

        <DialogFooter className="border-border shrink-0 border-t p-6 pt-4">
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            disabled={pending}
            type="button"
          >
            Cancel
          </Button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!ack || pending}
            className={cn(
              'focus-visible:ring-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
              PROPOSAL_CTA_GRADIENT_CLASS
            )}
          >
            {pending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Check className="h-4 w-4" aria-hidden="true" />
            )}
            Confirm acceptance
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
