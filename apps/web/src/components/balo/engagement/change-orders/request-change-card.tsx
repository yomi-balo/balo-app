'use client';

import { useCallback, useState } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';

import { BaloCard } from '@/components/balo/card/balo-card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { requestChangeOrderAction } from '@/app/(dashboard)/engagements/[id]/_actions/request-change-order';
import { useEngagementLifecycleAction } from '../use-engagement-lifecycle-action';

interface RequestChangeCardProps {
  engagementId: string;
  /** False while a change is open: the card then explains why it can't start another. */
  canRequest: boolean;
  /** The expert's prospective party label ("CloudPeak"), used in the toast and helper. */
  expertParty: string;
}

const NOTE_MAX_LENGTH = 2000;

/**
 * The client's "Need something different from the plan?" card. Collapsed it offers
 * "Request a change"; opened it takes a required note and sends it with
 * `requestChangeOrderAction`. While a change is already open it renders the plain
 * explanation instead. Dismissal is never gated on the pending state.
 */
export function RequestChangeCard({
  engagementId,
  canRequest,
  expertParty,
}: Readonly<RequestChangeCardProps>): React.JSX.Element {
  const { isPending, run } = useEngagementLifecycleAction();
  const [composing, setComposing] = useState(false);
  const [note, setNote] = useState('');

  const open = useCallback((): void => setComposing(true), []);
  const cancel = useCallback((): void => {
    setComposing(false);
    setNote('');
  }, []);
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => setNote(event.target.value),
    []
  );
  const send = useCallback((): void => {
    const trimmed = note.trim();
    if (trimmed === '') return;
    run(
      requestChangeOrderAction({ engagementId, note: trimmed }),
      `Request sent to ${expertParty}.`,
      () => {
        setComposing(false);
        setNote('');
      }
    );
  }, [engagementId, expertParty, note, run]);

  if (!canRequest) {
    return (
      <BaloCard className="p-5">
        <p className="text-muted-foreground text-sm">
          You have a change in progress. You can request another once it&apos;s decided.
        </p>
      </BaloCard>
    );
  }

  if (!composing) {
    return (
      <BaloCard className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-foreground text-sm">Need something different from the plan?</p>
          <Button type="button" variant="outline" size="sm" onClick={open}>
            <MessageSquare className="size-3.5" aria-hidden />
            Request a change
          </Button>
        </div>
      </BaloCard>
    );
  }

  return (
    <BaloCard className="p-5">
      <div className="space-y-2">
        <Label htmlFor="change-request-note" className="text-sm font-medium">
          What would you like to change?
        </Label>
        <Textarea
          id="change-request-note"
          autoFocus
          rows={3}
          maxLength={NOTE_MAX_LENGTH}
          value={note}
          onChange={handleChange}
        />
        <p className="text-muted-foreground text-xs">
          {expertParty} replies with a proposed change, including any change to the price or
          estimate, or an answer. Nothing changes until you approve.
        </p>
        <div className="flex gap-2">
          <Button type="button" disabled={note.trim() === '' || isPending} onClick={send}>
            {isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Send request
          </Button>
          <Button type="button" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        </div>
      </div>
    </BaloCard>
  );
}
