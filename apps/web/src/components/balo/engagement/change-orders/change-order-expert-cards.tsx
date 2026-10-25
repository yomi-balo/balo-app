'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Loader2, MessageSquare, Pencil, Send } from 'lucide-react';

import { BaloCard } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type {
  ChangeOrderAffordances,
  ChangeOrderItemView,
} from '@/lib/engagement/change-order-view';
import { answerChangeRequestAction } from '@/app/(dashboard)/engagements/[id]/_actions/answer-change-request';
import { discardChangeOrderDraftAction } from '@/app/(dashboard)/engagements/[id]/_actions/discard-change-order-draft';
import { withdrawChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/withdraw-change-order';
import { useEngagementLifecycleAction } from '../use-engagement-lifecycle-action';
import { ToneBanner } from './change-order-tone';

interface ExpertCardProps {
  engagementId: string;
  order: ChangeOrderItemView;
  affordances: ChangeOrderAffordances;
  composerHref: string;
  clientParty: string;
}

const ANSWER_MAX_LENGTH = 2000;

/**
 * The open client request, as the expert sees it: who asked and when, the quote, and the two
 * ways to reply. "Propose a change" opens the composer; "Answer without a change order" opens
 * an inline text box and sends the answer.
 */
export function ChangeRequestCard({
  engagementId,
  order,
  affordances,
  composerHref,
}: Readonly<Omit<ExpertCardProps, 'clientParty'>>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState('');

  const startAnswer = useCallback((): void => setAnswering(true), []);
  const cancelAnswer = useCallback((): void => {
    setAnswering(false);
    setAnswer('');
  }, []);
  const changeAnswer = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => setAnswer(event.target.value),
    []
  );
  const sendAnswer = useCallback((): void => {
    const trimmed = answer.trim();
    if (trimmed === '') return;
    run(
      answerChangeRequestAction({ engagementId, orderId: order.id, answer: trimmed }),
      'Answer sent.',
      () => {
        setAnswering(false);
        setAnswer('');
      }
    );
  }, [answer, engagementId, order.id, run]);

  return (
    <BaloCard as="section" aria-label="Change request" className="border-warning/30 p-5">
      <div className="flex items-start gap-3">
        <div className="bg-warning/10 text-warning rounded-full p-2">
          <MessageSquare className="size-[18px]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-foreground font-semibold">{order.requestedHeading}</h3>
          {order.requestNote !== null && (
            <p className="text-foreground mt-1 leading-relaxed">“{order.requestNote}”</p>
          )}
          {answering ? (
            <div className="mt-4 space-y-2">
              <Textarea
                autoFocus
                rows={3}
                maxLength={ANSWER_MAX_LENGTH}
                value={answer}
                onChange={changeAnswer}
                aria-label="Your answer"
                placeholder="e.g. That's already covered by Implementation, and I've updated its description to say so."
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  disabled={answer.trim() === '' || isPending}
                  onClick={sendAnswer}
                >
                  {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  Send answer
                </Button>
                <Button type="button" variant="ghost" onClick={cancelAnswer}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap gap-2">
                {affordances.propose && (
                  <Button asChild>
                    <Link href={composerHref}>
                      <Pencil className="size-4" aria-hidden />
                      Propose a change
                    </Link>
                  </Button>
                )}
                {affordances.answer && (
                  <Button type="button" variant="outline" onClick={startAnswer}>
                    Answer without a change order
                  </Button>
                )}
              </div>
              <p className="text-muted-foreground mt-2 text-xs">
                Propose a change if this affects scope or price. If it doesn&apos;t — say
                you&apos;ve only reworded something — answer here.
              </p>
            </>
          )}
        </div>
      </div>
    </BaloCard>
  );
}

interface DraftBannerProps {
  engagementId: string;
  /** The draft's order; null when the view does not carry it, which leaves Discard out. */
  order: ChangeOrderItemView | null;
  affordances: ChangeOrderAffordances;
  composerHref: string;
  clientParty: string;
}

/** The expert's unsent draft: a nudge to keep editing, or to discard it. */
export function DraftChangeBanner({
  engagementId,
  order,
  affordances,
  composerHref,
  clientParty,
}: Readonly<DraftBannerProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [confirming, setConfirming] = useState(false);
  const orderId = order?.id;
  const askToDiscard = useCallback((): void => setConfirming(true), []);
  const closeDialog = useCallback((): void => setConfirming(false), []);
  const handleOpenChange = useCallback((next: boolean): void => {
    if (!next) setConfirming(false);
  }, []);
  const discard = useCallback((): void => {
    if (orderId === undefined) return;
    setConfirming(false);
    run(discardChangeOrderDraftAction({ engagementId, orderId }), 'Draft discarded.');
  }, [engagementId, orderId, run]);

  const fromRequest = order !== null && order.requestNote !== null;
  return (
    <>
      <ToneBanner
        tone="muted"
        icon={Pencil}
        label="Draft change"
        action={
          <>
            <Button asChild size="sm">
              <Link href={composerHref}>Continue editing</Link>
            </Button>
            {affordances.discardDraft && orderId !== undefined && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isPending}
                onClick={askToDiscard}
              >
                Discard
              </Button>
            )}
          </>
        }
      >
        <span className="font-semibold">You have a draft change that hasn&apos;t been sent.</span>
        {fromRequest && ` ${clientParty} is still waiting for your answer.`}
      </ToneBanner>

      <Dialog open={confirming} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Discard this draft?</DialogTitle>
            <DialogDescription>
              {fromRequest
                ? `Your draft is discarded and ${clientParty}'s request stays open.`
                : 'Your draft is discarded.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog}>
              Keep editing
            </Button>
            <Button type="button" variant="destructive" onClick={discard}>
              Discard draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

interface SentBannerProps {
  engagementId: string;
  order: ChangeOrderItemView;
  affordances: ChangeOrderAffordances;
  clientParty: string;
}

/** The expert's sent change: what's locked, and the one way back out (withdraw, confirmed). */
export function SentChangeBanner({
  engagementId,
  order,
  affordances,
  clientParty,
}: Readonly<SentBannerProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [confirming, setConfirming] = useState(false);

  const askToWithdraw = useCallback((): void => setConfirming(true), []);
  const closeDialog = useCallback((): void => setConfirming(false), []);
  const handleOpenChange = useCallback((next: boolean): void => {
    if (!next) setConfirming(false);
  }, []);
  const withdraw = useCallback((): void => {
    setConfirming(false);
    run(withdrawChangeOrderAction({ engagementId, orderId: order.id }), 'Change withdrawn.');
  }, [engagementId, order.id, run]);

  return (
    <>
      <ToneBanner
        tone="primary"
        icon={Send}
        label="Change sent"
        action={
          affordances.withdraw ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isPending}
              onClick={askToWithdraw}
            >
              Withdraw
            </Button>
          ) : undefined
        }
      >
        <span className="font-semibold">Change sent to {clientParty}.</span> Nothing changes until
        they approve. The milestones it touches are locked until then.
        {order.sentOnLabel !== null && (
          <span className="text-muted-foreground mt-0.5 block text-xs">
            Sent {order.sentOnLabel}
          </span>
        )}
      </ToneBanner>

      <Dialog open={confirming} onOpenChange={handleOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Withdraw this change?</DialogTitle>
            <DialogDescription>
              {clientParty} won&apos;t be asked to approve it, and the milestones it touches unlock.
              Nothing changes in the project.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closeDialog}>
              Keep it sent
            </Button>
            <Button type="button" variant="destructive" onClick={withdraw}>
              Withdraw change
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
