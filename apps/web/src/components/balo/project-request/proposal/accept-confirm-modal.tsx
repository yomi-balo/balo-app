'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import { formatWholeCurrency } from '@/lib/utils/currency';
import { PROPOSAL_CTA_GRADIENT_CLASS } from '@/lib/project-request/proposal-cta';
import { track, PROJECT_EVENTS } from '@/lib/analytics';
import { acceptProposalAction } from '@/app/(dashboard)/projects/[requestId]/_actions/accept-proposal';
import { firstName } from './proposal-name';
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
    const dueNowCents = doc.depositCents ?? 0;
    const thenSub =
      doc.rateCents === null
        ? 'billed against time'
        : `billed against time at ${formatWholeCurrency(doc.rateCents, doc.currency)}/hr`;
    return [
      { label: 'Total', value: total, sub: 'Time & Materials' },
      { label: 'Due now', value: formatWholeCurrency(dueNowCents, doc.currency), sub: 'deposit' },
      { label: 'Then', value: '—', sub: thenSub },
    ];
  }

  const [upfront] = doc.installments;
  if (upfront === undefined) {
    return [
      { label: 'Total', value: total, sub: 'Fixed price' },
      { label: 'Due now', value: total, sub: 'full amount' },
      { label: 'Then', value: '—', sub: 'nothing outstanding' },
    ];
  }

  const dueNowCents = Math.round((doc.priceCents * upfront.pct) / 100);
  const thenCents = doc.priceCents - dueNowCents;
  return [
    { label: 'Total', value: total, sub: 'Fixed price' },
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
 * flight. On confirm it calls `acceptProposalAction`, fires analytics on success
 * (plus the request transition when the aggregate advanced), toasts, then routes
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

  const expertFirst = firstName(doc.expert.name);
  const rows = moneyRows(doc);

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (pending && !next) return; // no Escape-away mid-accept
      if (!next) setAck(false); // reset the acknowledgement on close
      onOpenChange(next);
    },
    [pending, onOpenChange]
  );

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

        track(PROJECT_EVENTS.PROJECT_PROPOSAL_ACCEPTED, {
          request_id: requestId,
          relationship_id: doc.relationshipId,
          expert_id: result.expertProfileId,
          proposal_id: doc.id,
        });
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
    run();
  }, [pending, ack, requestId, doc.relationshipId, doc.id, onOpenChange, router]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent showCloseButton={!pending} className="gap-0 p-0 sm:max-w-[460px]">
        <DialogHeader className="from-primary/[0.07] to-primary/[0.02] border-border space-y-0 border-b bg-gradient-to-br p-6 text-left">
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

        <div className="p-6">
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
              I agree to <strong className="text-foreground">Balo&apos;s standard terms</strong> and{' '}
              {expertFirst}&apos;s additional terms, and understand accepting commits{' '}
              {clientCompanyName} to these terms. Balo will raise the upfront invoice and tell the
              other experts they weren&apos;t selected.
            </span>
          </label>
        </div>

        <DialogFooter className="border-border border-t p-6 pt-4">
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
