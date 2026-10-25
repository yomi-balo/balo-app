'use client';

import { useCallback, useState } from 'react';
import { Check, Eye, Loader2 } from 'lucide-react';

import { BaloCard } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { ChangeOrderItemView } from '@/lib/engagement/change-order-view';
import { approveChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/approve-change-order';
import { declineChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/decline-change-order';
import { useEngagementLifecycleAction } from '../use-engagement-lifecycle-action';
import { ChangeOrderLines } from './change-order-lines';
import { ChangeOrderPriceEffect } from './change-order-price-effect';

interface ChangeReviewCardProps {
  engagementId: string;
  order: ChangeOrderItemView;
  /** Whether the client may approve or decline now (the view's `decide` affordance). */
  canDecide: boolean;
  /** Fallback proposer when the order carries no sender label. */
  proposedBy: string;
  expertParty: string;
}

const REASON_MAX_LENGTH = 2000;

/** What approving updates, worded for the project's pricing method ("the plan and price are"). */
function approvedUpdateText(order: ChangeOrderItemView): string {
  if (order.pricingMethod === 'fixed') return 'the plan and price are';
  return order.priceEffect?.capText === undefined
    ? 'the plan and estimates are'
    : 'the plan, estimates and cap are';
}

/**
 * The client's review card for a sent change: the expert's summary, the milestone
 * difference, the client's own price effect, then Approve or Decline. Declining takes a
 * required reason inline. Nothing changes unless the client approves.
 */
export function ChangeReviewCard({
  engagementId,
  order,
  canDecide,
  proposedBy,
  expertParty,
}: Readonly<ChangeReviewCardProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');

  const approve = useCallback((): void => {
    run(
      approveChangeOrderAction({ engagementId, orderId: order.id }),
      `Change approved — ${approvedUpdateText(order)} updated.`
    );
  }, [engagementId, order, run]);
  const startDecline = useCallback((): void => setDeclining(true), []);
  const cancelDecline = useCallback((): void => {
    setDeclining(false);
    setReason('');
  }, []);
  const changeReason = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => setReason(event.target.value),
    []
  );
  const decline = useCallback((): void => {
    const trimmed = reason.trim();
    if (trimmed === '') return;
    run(
      declineChangeOrderAction({ engagementId, orderId: order.id, reason: trimmed }),
      'Change declined.',
      () => {
        setDeclining(false);
        setReason('');
      }
    );
  }, [engagementId, order.id, reason, run]);

  return (
    <BaloCard as="section" aria-label="Proposed change" emphasis="highlight" className="p-6">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary rounded-full p-2">
          <Eye className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground font-semibold">
            {order.sentByLabel ?? proposedBy} proposed a change
          </h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {order.sentOnLabel === null ? '' : `Sent ${order.sentOnLabel}. `}Nothing changes unless
            you approve it.
          </p>
          {order.requestNote !== null && (
            <p className="text-muted-foreground mt-3 text-sm">You asked: “{order.requestNote}”</p>
          )}
          {order.summary !== null && (
            <p className="text-foreground mt-3 leading-relaxed">{order.summary}</p>
          )}
          <ChangeOrderLines lines={order.lines} />
          {order.priceEffect !== null && <ChangeOrderPriceEffect effect={order.priceEffect} />}

          {canDecide && !declining && (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button type="button" disabled={isPending} onClick={approve}>
                {isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-4" aria-hidden />
                )}
                Approve change
              </Button>
              <Button type="button" variant="outline" disabled={isPending} onClick={startDecline}>
                Decline
              </Button>
            </div>
          )}
          {canDecide && declining && (
            <div className="mt-4 space-y-2">
              <Label htmlFor="change-decline-reason" className="text-sm font-medium">
                Why are you declining?
              </Label>
              <Textarea
                id="change-decline-reason"
                autoFocus
                rows={3}
                maxLength={REASON_MAX_LENGTH}
                value={reason}
                onChange={changeReason}
                placeholder={`${expertParty} sees this and can suggest something else.`}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={reason.trim() === '' || isPending}
                  onClick={decline}
                >
                  {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Decline change
                </Button>
                <Button type="button" variant="ghost" onClick={cancelDecline}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </BaloCard>
  );
}
